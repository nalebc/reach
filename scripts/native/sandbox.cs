// Reach's sandbox host on Windows (server/windows-sandbox.mjs,
// docs/parity/C-sandbox.md): one short-lived process per operation that runs
// an agent's or invited person's command, the Full-control shell, an approved
// script, or one protected file operation, inside the confinement its mode
// asks for. The Mac does this with sandbox-exec and a descriptor-confined
// Swift helper (scripts/native/browser-files.swift); Windows has no
// allow-default file sandbox, so each surface gets the mechanism that matches
// its Mac policy: a Job Object on the owner's token for the Full-control shell;
// a regular AppContainer plus a Job Object for jobs; an LPAC AppContainer plus
// a one-process Job Object for scripts; and, for the Files helper, this process
// on the owner's token doing NT handle-relative I/O that follows no reparse
// point (no AppContainer, matching the Mac's descriptor discipline).
//
// Built and launched through workstream A's windowsBinary/spawnVerified into a
// folder Reach made private this launch, its SHA-256 re-checked before every
// spawn. Compiled with the in-box .NET Framework 4.x csc.exe, so C# 5 only (no
// string interpolation, no null-conditional operator, no expression-bodied
// members, no inline out variables); mscorlib and System alone (the shared
// REFERENCES list has no JSON library, so the protocol is hand-framed).
//
//   sandbox.exe selftest     answer whether the OS lets the helper run, then exit
//   sandbox.exe run          read one framed request on stdin and carry it out
//
// Protocol (server/windows-sandbox.mjs is the other end):
//   Request  (stdin):  [uint32 BE length][payload]; payload is a list of
//                      entries, each [uint32 BE keyLen][key][uint32 BE valLen]
//                      [value] (UTF-8). A repeated key is a list. stdin then
//                      stays open as the end-of-input lifeline: its EOF aborts.
//   Response (stdout): a stream of frames, each [1 type byte][uint32 BE length]
//                      [payload]. The child the helper launches inherits only
//                      pipe handles the helper owns (never this stdout), so a
//                      child's bytes can only ever become 'O'/'E' data frames;
//                      it can't forge an 'X'/'R'/'F' control frame.
//     'S' started    (payload: the child's pid, 4 bytes BE, when there is one)
//     'O' / 'E'      child stdout / stderr bytes, relayed verbatim
//     'X' exit       (payload: the main process's exit code, 4 bytes BE signed)
//     'R' result     (payload: a UTF-8 JSON object, for file operations)
//     'F' refused    (payload: [uint32 BE status][UTF-8 message])
using System;
using System.IO;
using System.Collections.Generic;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;

static class Sandbox {
  // Frame types on the wire to Node. One byte each.
  const byte FrameStarted = (byte)'S';
  const byte FrameStdout = (byte)'O';
  const byte FrameStderr = (byte)'E';
  const byte FrameExit = (byte)'X';
  const byte FrameResult = (byte)'R';
  const byte FrameRefused = (byte)'F';

  // A refusal that carries an HTTP-shaped status, so the Node side can keep the
  // same wording and codes the Mac helper returns. The message never contains a
  // secret value (vault fills are blacked out well before they reach here).
  class Refused : Exception {
    public readonly int Status;
    public Refused(int status, string message) : base(message) { Status = status; }
  }

  static readonly object WriteLock = new object();
  static Stream Out;

  static int Main(string[] args) {
    // One byte at a time would be slow; frames are written whole under a lock.
    Out = Console.OpenStandardOutput();
    try {
      if (args.Length == 1 && args[0] == "selftest") {
        // The no-op launch self-test (docs/parity/C-sandbox.md §2.2): simply
        // starting and answering proves the operating system lets Reach's
        // already-hash-verified helper run here. Whether a sandboxed child can
        // then start is the runtime probe's job, not this one's.
        WriteControl(FrameStarted, new byte[0]);
        return 0;
      }
      if (args.Length == 1 && args[0] == "run") {
        Request request = ReadRequest(Console.OpenStandardInput());
        return Run(request);
      }
      if (args.Length >= 2 && args[0] == "netprobe") {
        // The §5 self-test, run inside the jobs AppContainer: for each local
        // address it reports whether Reach's listener answered. Any "open" line
        // refuses the launch (fail closed). No framing: this child's stdout goes
        // to a pipe the jobs launcher reads, not to Node.
        for (int i = 1; i < args.Length; i++) Console.Out.WriteLine(Jobs.Probe(args[i]));
        Console.Out.Flush();
        return 0;
      }
      // Unknown invocation: say so in the same framed channel and stop. Never
      // fall back to running anything (plan rule 2, fail closed).
      Refuse(new Refused(400, "Unknown sandbox request."));
      return 2;
    } catch (Refused refused) {
      Refuse(refused);
      return 1;
    } catch (Exception error) {
      Refuse(new Refused(503, "The sandbox helper could not complete the request: " + Short(error.Message)));
      return 1;
    }
  }

  // The request the Node side framed on stdin, parsed into single values and
  // lists. Keeping both lets a value appear once (mode, command) or many times
  // (grants, denies, argv) with no ambiguity.
  public class Request {
    readonly Dictionary<string, List<string>> fields = new Dictionary<string, List<string>>(StringComparer.Ordinal);
    public void Add(string key, string value) {
      List<string> list;
      if (!fields.TryGetValue(key, out list)) { list = new List<string>(); fields[key] = list; }
      list.Add(value);
    }
    public string Get(string key) {
      List<string> list;
      if (fields.TryGetValue(key, out list) && list.Count > 0) return list[list.Count - 1];
      return null;
    }
    public string Get(string key, string fallback) {
      string value = Get(key);
      return value == null ? fallback : value;
    }
    public List<string> List(string key) {
      List<string> list;
      if (fields.TryGetValue(key, out list)) return list;
      return new List<string>();
    }
    public int Int(string key, int fallback) {
      string value = Get(key);
      int parsed;
      if (value != null && int.TryParse(value, out parsed)) return parsed;
      return fallback;
    }
  }

  static int Run(Request request) {
    string mode = request.Get("mode", "");
    // Each mode is built in its own slice (docs/parity/C-sandbox.md §3). Until a
    // mode is wired on both sides it refuses rather than running anything.
    switch (mode) {
      case "jobs":
        return Jobs.Run(request, Emit);
      case "shell":
        return Shell.Run(request, Emit);
      default:
        throw new Refused(400, "This sandbox mode is not available on this computer.");
    }
  }

  // Relay one frame to Node. Exposed to the mode handlers so child output and
  // the started/exit/result frames all go through the one locked writer.
  public static void Emit(byte type, byte[] payload) { WriteControl(type, payload); }
  public static byte TypeStarted { get { return FrameStarted; } }
  public static byte TypeStdout { get { return FrameStdout; } }
  public static byte TypeStderr { get { return FrameStderr; } }
  public static byte TypeExit { get { return FrameExit; } }
  public static byte TypeResult { get { return FrameResult; } }
  // A refusal raised from a mode handler: same framed channel as Main's.
  public static Exception Refusal(int status, string message) { return new Refused(status, message); }

  // Read exactly `count` bytes or throw: a short read means the pipe closed
  // mid-frame, which is never a valid request.
  static byte[] ReadExactly(Stream stream, int count) {
    byte[] buffer = new byte[count];
    int read = 0;
    while (read < count) {
      int got = stream.Read(buffer, read, count - read);
      if (got <= 0) throw new Refused(400, "The sandbox request ended early.");
      read += got;
    }
    return buffer;
  }

  static int ReadUInt32(Stream stream) {
    byte[] four = ReadExactly(stream, 4);
    return BeInt(four, 0);
  }

  static int BeInt(byte[] bytes, int offset) {
    return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
  }

  // The one length-prefixed request frame, parsed into entries. A length is
  // bounded so a wrong prefix can't ask the helper to allocate the world.
  static Request ReadRequest(Stream stdin) {
    int total = ReadUInt32(stdin);
    if (total < 0 || total > 8 * 1024 * 1024) throw new Refused(400, "The sandbox request is too large.");
    byte[] payload = ReadExactly(stdin, total);
    Request request = new Request();
    int at = 0;
    while (at < payload.Length) {
      if (at + 4 > payload.Length) throw new Refused(400, "The sandbox request is malformed.");
      int keyLen = BeInt(payload, at); at += 4;
      if (keyLen < 0 || at + keyLen > payload.Length) throw new Refused(400, "The sandbox request is malformed.");
      string key = Encoding.UTF8.GetString(payload, at, keyLen); at += keyLen;
      if (at + 4 > payload.Length) throw new Refused(400, "The sandbox request is malformed.");
      int valLen = BeInt(payload, at); at += 4;
      if (valLen < 0 || at + valLen > payload.Length) throw new Refused(400, "The sandbox request is malformed.");
      string value = Encoding.UTF8.GetString(payload, at, valLen); at += valLen;
      request.Add(key, value);
    }
    return request;
  }

  // A frame on stdout. Child output is wrapped the same way, so a child cannot
  // write a byte the Node side will read as a control frame.
  static void WriteControl(byte type, byte[] payload) {
    lock (WriteLock) {
      byte[] header = new byte[5];
      header[0] = type;
      int length = payload.Length;
      header[1] = (byte)((length >> 24) & 0xff);
      header[2] = (byte)((length >> 16) & 0xff);
      header[3] = (byte)((length >> 8) & 0xff);
      header[4] = (byte)(length & 0xff);
      Out.Write(header, 0, header.Length);
      if (length > 0) Out.Write(payload, 0, length);
      Out.Flush();
    }
  }

  static void Refuse(Refused refused) {
    byte[] message = Encoding.UTF8.GetBytes(refused.Message ?? "Refused.");
    byte[] payload = new byte[4 + message.Length];
    int status = refused.Status;
    payload[0] = (byte)((status >> 24) & 0xff);
    payload[1] = (byte)((status >> 16) & 0xff);
    payload[2] = (byte)((status >> 8) & 0xff);
    payload[3] = (byte)(status & 0xff);
    Array.Copy(message, 0, payload, 4, message.Length);
    WriteControl(FrameRefused, payload);
  }

  static string Short(string text) {
    if (text == null) return "";
    text = text.Replace("\r", " ").Replace("\n", " ");
    return text.Length > 300 ? text.Substring(0, 300) : text;
  }
}

// ---------------------------------------------------------------------------
// §4 Capability granting. Confinement for jobs and scripts is a custom
// capability SID per shared root (DeriveCapabilitySidsFromName, the precedent
// is Chromium's lpacChromeInstallFiles), ACE'd onto that root's tree once at
// grant time. The AppContainer launch is handed only the capabilities for the
// client's current roots (slice 3), so removing or changing a root takes effect
// on the next launch with no new walk (finding 3). Secrets inside a granted
// root additionally carry a DENY for a fixed Reach-wide capability SID every
// Reach-launched token holds, placed before the ALLOWs in canonical order.
static class Grants {
  // FileSystemRights built to match finding 6's masks. Read is
  // FILE_GENERIC_READ|FILE_GENERIC_EXECUTE; write adds FILE_GENERIC_WRITE and
  // DELETE but never FILE_DELETE_CHILD (DeleteSubdirectoriesAndFiles), so a
  // script can't delete or rename a private-named child it was never granted
  // (finding 5): rename/delete of an allowed child goes through that child's own
  // DELETE right, which private names never receive.
  const FileSystemRights Read = FileSystemRights.ReadAndExecute;
  const FileSystemRights Write = FileSystemRights.ReadAndExecute | FileSystemRights.Write | FileSystemRights.Delete;

  public static SecurityIdentifier CapabilitySid(string name) {
    IntPtr groups = IntPtr.Zero, sids = IntPtr.Zero;
    int groupCount = 0, sidCount = 0;
    if (!NativeSec.DeriveCapabilitySidsFromName(name, out groups, out groupCount, out sids, out sidCount) || sidCount < 1 || sids == IntPtr.Zero)
      throw new Exception("DeriveCapabilitySidsFromName failed for " + name);
    try {
      IntPtr first = Marshal.ReadIntPtr(sids);
      int length = NativeSec.GetLengthSid(first);
      byte[] raw = new byte[length];
      Marshal.Copy(first, raw, 0, length);
      return new SecurityIdentifier(raw, 0);
    } finally {
      FreeSidArray(groups, groupCount);
      FreeSidArray(sids, sidCount);
    }
  }

  static void FreeSidArray(IntPtr array, int count) {
    if (array == IntPtr.Zero) return;
    for (int i = 0; i < count; i++) {
      IntPtr sid = Marshal.ReadIntPtr(array, i * IntPtr.Size);
      if (sid != IntPtr.Zero) NativeSec.LocalFree(sid);
    }
    NativeSec.LocalFree(array);
  }

  // The per-root capability, named from the root's canonical path so the same
  // root always derives the same SID and a changed root derives a different one.
  public static SecurityIdentifier RootCapability(string canonicalRoot) {
    using (SHA256 sha = SHA256.Create()) {
      byte[] digest = sha.ComputeHash(Encoding.Unicode.GetBytes(canonicalRoot.ToLowerInvariant()));
      StringBuilder hex = new StringBuilder(32);
      for (int i = 0; i < 16; i++) hex.Append(digest[i].ToString("x2"));
      return CapabilitySid("reach.root." + hex.ToString());
    }
  }

  // The fixed Reach-wide capability every Reach-launched token carries; secrets
  // deny it, so no sandboxed token can reach them whatever ALLOW a root carried.
  public static SecurityIdentifier DenyCapability() {
    return CapabilitySid("reach.sandbox.deny");
  }

  static bool IsPrivateName(string name, ICollection<string> denyNames) {
    foreach (string deny in denyNames) if (string.Equals(name, deny, StringComparison.OrdinalIgnoreCase)) return true;
    return false;
  }

  // One handle walk at grant time (§4.4). An OI|CI ACE does not reach existing
  // descendants, so each existing object is ACE'd by name; a hard-linked file or
  // a name-surrogate reparse point is skipped (not ACE'd, not recursed) and the
  // walk carries on, refusing only on a scan error or above a bound (finding
  // 11). No ALLOW is ever written inside a private-named subtree (findings 1, 5).
  const int MaxEntries = 200000;

  public static void ApplyGrant(string root, bool writable, ICollection<string> denyNames, ICollection<string> denyPaths) {
    SecurityIdentifier allow = RootCapability(root);
    SecurityIdentifier deny = DenyCapability();
    // DENY carve-outs first: the known secret paths that fall inside the root.
    foreach (string path in denyPaths) {
      if (!Within(root, path)) continue;
      DenyEverywhere(path, deny);
    }
    // The root itself: an inheritable ALLOW for new descendants, plus this walk
    // for the ones already there.
    AllowObject(root, true, writable, allow, true);
    int seen = 0;
    Walk(root, writable, allow, denyNames, ref seen);
  }

  static void Walk(string dir, bool writable, SecurityIdentifier allow, ICollection<string> denyNames, ref int seen) {
    IEnumerable<string> entries;
    try { entries = Directory.EnumerateFileSystemEntries(dir); }
    catch (Exception) { throw new Exception("The shared folder could not be read while granting access."); }
    foreach (string entry in entries) {
      if (++seen > MaxEntries) throw new Exception("This folder has too many entries to grant access safely. Share a smaller project folder.");
      string name = Path.GetFileName(entry);
      if (IsPrivateName(name, denyNames)) continue; // never ACE a private-named object or its subtree
      FileAttributes attributes;
      try { attributes = File.GetAttributes(entry); }
      catch (Exception) { continue; }
      bool directory = (attributes & FileAttributes.Directory) != 0;
      if ((attributes & FileAttributes.ReparsePoint) != 0) {
        // A name-surrogate reparse point (a junction or symlink) is skipped so a
        // link can't drag an ACE onto, or the walk into, somewhere outside the
        // root. Cloud/WOF/dedup tags are data: ACE the placeholder, don't follow.
        if (NativeSec.IsNameSurrogate(entry)) continue;
      }
      if (!directory && NativeSec.HardLinked(entry)) continue; // an alias to an outside inode: never ACE'd
      AllowObject(entry, directory, writable, allow, false);
      if (directory && (attributes & FileAttributes.ReparsePoint) == 0) Walk(entry, writable, allow, denyNames, ref seen);
    }
  }

  static void AllowObject(string path, bool directory, bool writable, SecurityIdentifier cap, bool inheritable) {
    FileSystemRights rights = writable ? Write : Read;
    InheritanceFlags inheritance = directory && inheritable ? (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit) : InheritanceFlags.None;
    var rule = new FileSystemAccessRule(cap, rights, inheritance, PropagationFlags.None, AccessControlType.Allow);
    if (directory) { DirectorySecurity security = Directory.GetAccessControl(path); security.AddAccessRule(rule); Directory.SetAccessControl(path, security); }
    else { FileSecurity security = File.GetAccessControl(path); security.AddAccessRule(rule); File.SetAccessControl(path, security); }
  }

  static void DenyEverywhere(string path, SecurityIdentifier cap) {
    bool directory = Directory.Exists(path);
    if (!directory && !File.Exists(path)) return;
    InheritanceFlags inheritance = directory ? (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit) : InheritanceFlags.None;
    // FullControl denied: no access of any kind for a token carrying the cap.
    var rule = new FileSystemAccessRule(cap, FileSystemRights.FullControl, inheritance, PropagationFlags.None, AccessControlType.Deny);
    if (directory) { DirectorySecurity security = Directory.GetAccessControl(path); security.AddAccessRule(rule); Directory.SetAccessControl(path, security); }
    else { FileSecurity security = File.GetAccessControl(path); security.AddAccessRule(rule); File.SetAccessControl(path, security); }
  }

  // Revocation (§4.6): the ACEs for a root's capability are removed in a walk
  // that continues past reparse points, never aborting, so a planted junction
  // can't preserve an ACE. The job is killed first by the caller.
  public static void Revoke(string root, ICollection<string> denyNames) {
    SecurityIdentifier allow;
    try { allow = RootCapability(root); } catch (Exception) { return; }
    RemoveObject(root, true, allow);
    int seen = 0;
    RevokeWalk(root, allow, ref seen);
  }

  static void RevokeWalk(string dir, SecurityIdentifier allow, ref int seen) {
    IEnumerable<string> entries;
    try { entries = Directory.EnumerateFileSystemEntries(dir); } catch (Exception) { return; }
    foreach (string entry in entries) {
      if (++seen > MaxEntries) return;
      FileAttributes attributes;
      try { attributes = File.GetAttributes(entry); } catch (Exception) { continue; }
      bool directory = (attributes & FileAttributes.Directory) != 0;
      RemoveObject(entry, directory, allow);
      if (directory && (attributes & FileAttributes.ReparsePoint) == 0) RevokeWalk(entry, allow, ref seen);
    }
  }

  static void RemoveObject(string path, bool directory, SecurityIdentifier cap) {
    try {
      if (directory) { DirectorySecurity security = Directory.GetAccessControl(path); security.PurgeAccessRules(cap); Directory.SetAccessControl(path, security); }
      else { FileSecurity security = File.GetAccessControl(path); security.PurgeAccessRules(cap); File.SetAccessControl(path, security); }
    } catch (Exception) { /* a reparse point or a locked file: carry on */ }
  }

  public static bool Within(string root, string path) {
    string r = root.TrimEnd('\\').ToLowerInvariant();
    string p = path.TrimEnd('\\').ToLowerInvariant();
    return p == r || p.StartsWith(r + "\\", StringComparison.Ordinal);
  }
}

// P/Invoke that the managed security classes don't cover: deriving a capability
// SID, and reading a reparse tag or a file's link count so the grant walk can
// skip name-surrogate links and hard links (finding 11).
static class NativeSec {
  [DllImport("kernelbase.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool DeriveCapabilitySidsFromName(string capName, out IntPtr capabilityGroupSids, out int capabilityGroupSidCount, out IntPtr capabilitySids, out int capabilitySidCount);
  [DllImport("advapi32.dll")]
  public static extern int GetLengthSid(IntPtr sid);
  [DllImport("kernel32.dll")]
  public static extern IntPtr LocalFree(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetFileInformationByHandleEx(IntPtr file, int infoClass, IntPtr info, int size);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetFileInformationByHandle(IntPtr file, out BY_HANDLE_FILE_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  public const uint FILE_READ_ATTRIBUTES = 0x80;
  public const uint FILE_SHARE_ALL = 0x7;
  public const uint OPEN_EXISTING = 3;
  public const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
  public const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const int FileAttributeTagInfo = 9;
  static readonly IntPtr InvalidHandle = new IntPtr(-1);

  [StructLayout(LayoutKind.Sequential)]
  public struct BY_HANDLE_FILE_INFORMATION {
    public uint FileAttributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
  }

  // A reparse tag is a name surrogate (a junction or symbolic link) when its
  // high bit group is set; cloud, WOF and dedup tags are not, and are data.
  public static bool IsNameSurrogate(string path) {
    IntPtr handle = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (handle == InvalidHandle) return true; // can't inspect it: treat as a surrogate and skip
    try {
      IntPtr buffer = Marshal.AllocHGlobal(8);
      try {
        if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, buffer, 8)) return true;
        uint tag = (uint)Marshal.ReadInt32(buffer, 4);
        return (tag & 0x20000000) != 0; // IsReparseTagNameSurrogate
      } finally { Marshal.FreeHGlobal(buffer); }
    } finally { CloseHandle(handle); }
  }

  public static bool HardLinked(string path) {
    IntPtr handle = CreateFileW(path, FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);
    if (handle == InvalidHandle) return false;
    try {
      BY_HANDLE_FILE_INFORMATION info;
      if (!GetFileInformationByHandle(handle, out info)) return false;
      return info.NumberOfLinks > 1;
    } finally { CloseHandle(handle); }
  }
}

// ---------------------------------------------------------------------------
// §3.1, §5, §6 Jobs. An agent's or invited person's command runs as
// cmd.exe /d /s /c inside a regular AppContainer (per-root capability grant,
// internet) and a Job Object (kill-on-close, die-on-exception, UI restrictions,
// a fork-bomb process cap, no CPU-time cap). Before the command runs, the launch
// token is AccessChecked against every deny path (§4.5) and a probe inside the
// same AppContainer confirms Reach's own listener is unreachable (§5); either
// failing refuses the launch.
static class Jobs {
  public static string Probe(string target) {
    int idx = target.LastIndexOf(':');
    if (idx <= 0) return "shut " + target;
    string host = target.Substring(0, idx);
    int port;
    if (!int.TryParse(target.Substring(idx + 1), out port)) return "shut " + target;
    try {
      using (TcpClient client = new TcpClient()) {
        IAsyncResult pending = client.BeginConnect(host, port, null, null);
        if (pending.AsyncWaitHandle.WaitOne(1500) && client.Connected) { client.EndConnect(pending); return "open " + target; }
      }
    } catch (Exception) { }
    return "shut " + target;
  }

  public static int Run(Sandbox.Request request, Action<byte, byte[]> emit) {
    string interpreter = request.Get("interpreter", "cmd.exe");
    if (interpreter != "cmd.exe") throw Sandbox.Refusal(400, "Jobs run through cmd.exe on Windows.");
    string command = request.Get("command", "");
    string cwd = request.Get("cwd", null);
    int timeoutMs = request.Int("timeoutMs", 60000);
    int activeProcesses = request.Int("activeProcesses", 512);
    List<string> grants = request.List("grant");
    List<string> grantAccess = request.List("grantAccess");
    List<string> denies = request.List("deny");
    List<string> capabilityNames = request.List("capability");
    List<string> loopback = request.List("loopback");
    string containerName = "reach.jobs." + Hash(request.Get("client", "jobs"));

    // The grant walk (§4.4), once, before the launch. Jobs never deny the in-root
    // private names, so git and npm work (finding 5): denyNames is empty here.
    var noNames = new List<string>();
    for (int i = 0; i < grants.Count; i++) {
      bool writable = i >= grantAccess.Count || grantAccess[i] != "ro";
      Grants.ApplyGrant(grants[i], writable, noNames, denies);
    }

    // The AppContainer and its capabilities: the package SID is stable per
    // client; the launch carries only this client's per-root capabilities, the
    // Reach-wide deny capability, and internetClient (§4.1, §5).
    IntPtr containerSid = NativeProc.EnsureAppContainer(containerName);
    var caps = new List<SecurityIdentifier>();
    foreach (string root in grants) caps.Add(Grants.RootCapability(root));
    caps.Add(Grants.DenyCapability());
    foreach (string name in capabilityNames) if (name == "internetClient") caps.Add(new SecurityIdentifier("S-1-15-3-1"));

    using (var container = new NativeProc.Container(containerSid, caps)) {
      using (var job = NativeProc.JobObject.CreateForJobs(activeProcesses)) {
        // §5 self-test: inside this AppContainer, Reach's listener must be
        // unreachable on every local address. Any "open" refuses the launch.
        if (loopback.Count > 0) {
          string probeLine = "\"" + NativeProc.SelfPath() + "\" netprobe";
          foreach (string target in loopback) probeLine += " " + target;
          string probeOut = NativeProc.RunContainedCaptured(probeLine, cwd, container, job, timeoutMs < 10000 ? timeoutMs : 10000);
          if (probeOut.IndexOf("open ", StringComparison.Ordinal) >= 0)
            throw Sandbox.Refusal(403, "This PC let a sandboxed command reach Reach itself, so the command was refused.");
        }

        string commandLine = "\"" + NativeProc.ComSpec() + "\" /d /s /c " + command;
        NativeProc.Launched launched = NativeProc.LaunchContained(commandLine, cwd, container, job, true);
        try {
          // §4.5 preflight: the real launch token, AccessChecked against every
          // deny path under the ACL lock, immediately after creation and before
          // the suspended process runs. Any reachable secret refuses the launch.
          lock (NativeProc.AclLock) {
            string reachable = NativeProc.FirstReachableSecret(launched.Process, denies);
            if (reachable != null) { launched.Kill(); throw Sandbox.Refusal(403, "A command grant would have exposed Reach's own files, so it was refused."); }
          }
          emit(Sandbox.TypeStarted, BeBytes(launched.ProcessId));
          launched.Resume();
          return Relay(launched, job, emit, timeoutMs);
        } finally {
          launched.Dispose();
        }
      }
    }
  }

  // Relay the child's output as frames, report its exit, then stay only long
  // enough to reap survivors — until the job drains or the deadline (finding 13).
  static int Relay(NativeProc.Launched launched, NativeProc.JobObject job, Action<byte, byte[]> emit, int timeoutMs) {
    var pump = new List<Thread>();
    pump.Add(NativeProc.Pump(launched.StdoutRead, Sandbox.TypeStdout, emit));
    pump.Add(NativeProc.Pump(launched.StderrRead, Sandbox.TypeStderr, emit));
    // The lifeline: Node's EOF on our own stdin aborts the whole job.
    Thread lifeline = new Thread(delegate () {
      try { Stream stdin = Console.OpenStandardInput(); byte[] one = new byte[1]; while (stdin.Read(one, 0, 1) > 0) { } } catch (Exception) { }
      try { job.Terminate(); } catch (Exception) { }
    });
    lifeline.IsBackground = true;
    lifeline.Start();

    int code = launched.WaitForExit(timeoutMs);
    emit(Sandbox.TypeExit, BeBytes(code));
    // Drain: wait for any backgrounded survivors to finish, up to the deadline,
    // then close the job (kill-on-close reaps whatever is left).
    long deadline = Environment.TickCount + Math.Max(0, timeoutMs);
    while (Environment.TickCount < deadline && job.ActiveProcesses() > 0) Thread.Sleep(200);
    job.Terminate();
    foreach (Thread t in pump) { try { t.Join(1000); } catch (Exception) { } }
    return 0;
  }

  static byte[] BeBytes(int value) {
    return new byte[] { (byte)((value >> 24) & 0xff), (byte)((value >> 16) & 0xff), (byte)((value >> 8) & 0xff), (byte)(value & 0xff) };
  }

  static string Hash(string value) {
    using (SHA256 sha = SHA256.Create()) {
      byte[] digest = sha.ComputeHash(Encoding.Unicode.GetBytes(value));
      StringBuilder hex = new StringBuilder(24);
      for (int i = 0; i < 12; i++) hex.Append(digest[i].ToString("x2"));
      return hex.ToString();
    }
  }
}

// P/Invoke for the AppContainer + Job Object launch, the preflight AccessCheck,
// and the framed relay. Kept together so the mode handlers stay readable.
static class NativeProc {
  public static readonly object AclLock = new object();
  static readonly IntPtr Invalid = new IntPtr(-1);

  // ---- constants ----
  const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000;
  const uint FILE_SHARE_ALL = 0x7, OPEN_EXISTING = 3;
  const uint HANDLE_FLAG_INHERIT = 0x1;
  const uint STARTF_USESTDHANDLES = 0x100;
  const uint CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400, CREATE_NO_WINDOW = 0x08000000, EXTENDED_STARTUPINFO_PRESENT = 0x80000;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002);
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = new IntPtr(0x00020009);
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_JOB_LIST = new IntPtr(0x0002000D);
  const uint SE_GROUP_ENABLED = 0x4;
  const uint TOKEN_QUERY = 0x8, TOKEN_DUPLICATE = 0x2;
  const int JobObjectBasicUIRestrictions = 4, JobObjectBasicAccountingInformation = 1, JobObjectExtendedLimitInformation = 9;
  const uint JOB_LIMIT_ACTIVE_PROCESS = 0x8, JOB_LIMIT_KILL_ON_JOB_CLOSE = 0x2000, JOB_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x400;
  const uint UILIMIT_ALL = 0x1 | 0x2 | 0x4 | 0x8 | 0x10 | 0x20 | 0x40; // handles, readclipboard, writeclipboard, systemparameters, displaysettings, globalatoms, desktop, exitwindows
  const uint FILE_GENERIC_READ = 0x120089;

  // ---- structs ----
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public int CapabilityCount; public int Reserved; }
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] internal struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved, lpDesktop, lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute; public uint dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_UI_RESTRICTIONS { public uint UIRestrictionsClass; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
  [StructLayout(LayoutKind.Sequential)] struct GENERIC_MAPPING { public uint GenericRead, GenericWrite, GenericExecute, GenericAll; }
  [StructLayout(LayoutKind.Sequential)] struct PRIVILEGE_SET { public uint PrivilegeCount, Control; public long Luid; public uint Attributes; }

  // ---- P/Invoke ----
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES sa, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr sa, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_BASIC_UI_RESTRICTIONS info, int length);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info, int length, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr prev, IntPtr returnSize);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string app, string commandLine, IntPtr processAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateToken(IntPtr token, int level, out IntPtr duplicate);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool GetFileSecurityW(string file, int information, byte[] descriptor, int length, out int needed);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool AccessCheck(byte[] descriptor, IntPtr token, uint desired, ref GENERIC_MAPPING mapping, ref PRIVILEGE_SET privileges, ref int privilegeLength, out uint granted, out bool status);
  [DllImport("advapi32.dll")] static extern void MapGenericMask(ref uint access, ref GENERIC_MAPPING mapping);
  [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr str);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string displayName, string description, SID_AND_ATTRIBUTES[] capabilities, int capabilityCount, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] static extern int GetAppContainerFolderPath(string sid, out IntPtr path);
  [DllImport("ole32.dll")] static extern void CoTaskMemFree(IntPtr ptr);

  public static string ComSpec() {
    string root = Environment.GetEnvironmentVariable("SystemRoot");
    if (string.IsNullOrEmpty(root)) root = "C:\\Windows";
    return root + "\\System32\\cmd.exe";
  }
  public static string SelfPath() { return System.Reflection.Assembly.GetExecutingAssembly().Location; }

  // Create the per-client AppContainer profile if it isn't there, and return its
  // SID (freed with the Container). The profile makes GetAppContainerFolderPath
  // resolvable so TEMP/TMP can point at the container's own folder (finding 10).
  public static IntPtr EnsureAppContainer(string name) {
    IntPtr sid;
    int created = CreateAppContainerProfile(name, name, "Reach sandboxed job", null, 0, out sid);
    if (created == 0) return sid;
    int derived = DeriveAppContainerSidFromAppContainerName(name, out sid);
    if (derived != 0) throw Sandbox.Refusal(503, "Windows wouldn't create a sandbox container for this command.");
    return sid;
  }

  // Holds the SECURITY_CAPABILITIES (AppContainer SID + capability SIDs) in
  // unmanaged memory for the lifetime of a launch, and the container's own TEMP
  // folder. Frees everything on dispose.
  public class Container : IDisposable {
    public IntPtr CapabilitiesPtr;
    public string TempFolder;
    IntPtr sid; readonly List<IntPtr> allocations = new List<IntPtr>();
    public Container(IntPtr appContainerSid, List<SecurityIdentifier> capabilities) {
      sid = appContainerSid;
      TempFolder = FolderFor(appContainerSid);
      IntPtr array = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES)) * Math.Max(1, capabilities.Count));
      allocations.Add(array);
      for (int i = 0; i < capabilities.Count; i++) {
        byte[] raw = new byte[capabilities[i].BinaryLength];
        capabilities[i].GetBinaryForm(raw, 0);
        IntPtr sidMem = Marshal.AllocHGlobal(raw.Length);
        allocations.Add(sidMem);
        Marshal.Copy(raw, 0, sidMem, raw.Length);
        var entry = new SID_AND_ATTRIBUTES(); entry.Sid = sidMem; entry.Attributes = SE_GROUP_ENABLED;
        Marshal.StructureToPtr(entry, new IntPtr(array.ToInt64() + i * Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES))), false);
      }
      var caps = new SECURITY_CAPABILITIES(); caps.AppContainerSid = appContainerSid; caps.Capabilities = array; caps.CapabilityCount = capabilities.Count; caps.Reserved = 0;
      CapabilitiesPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)));
      allocations.Add(CapabilitiesPtr);
      Marshal.StructureToPtr(caps, CapabilitiesPtr, false);
    }
    static string FolderFor(IntPtr appContainerSid) {
      IntPtr str; if (!ConvertSidToStringSidW(appContainerSid, out str)) return null;
      try {
        string s = Marshal.PtrToStringUni(str);
        IntPtr folder; if (GetAppContainerFolderPath(s, out folder) != 0) return null;
        try { return Marshal.PtrToStringUni(folder); } finally { CoTaskMemFree(folder); }
      } finally { NativeSec.LocalFree(str); }
    }
    public void Dispose() {
      foreach (IntPtr p in allocations) { try { Marshal.FreeHGlobal(p); } catch (Exception) { } }
      if (sid != IntPtr.Zero) { FreeSid(sid); sid = IntPtr.Zero; }
    }
  }

  public class JobObject : IDisposable {
    public IntPtr Handle;
    JobObject(IntPtr handle) { Handle = handle; }
    public static JobObject CreateForJobs(int activeProcesses) {
      IntPtr handle = CreateJobObjectW(IntPtr.Zero, null);
      if (handle == IntPtr.Zero) throw Sandbox.Refusal(503, "Windows wouldn't create the sandbox's job object.");
      var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      ext.BasicLimitInformation.LimitFlags = JOB_LIMIT_KILL_ON_JOB_CLOSE | JOB_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | (activeProcesses > 0 ? JOB_LIMIT_ACTIVE_PROCESS : 0);
      ext.BasicLimitInformation.ActiveProcessLimit = (uint)(activeProcesses > 0 ? activeProcesses : 0);
      SetInformationJobObject(handle, JobObjectExtendedLimitInformation, ref ext, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
      var ui = new JOBOBJECT_BASIC_UI_RESTRICTIONS(); ui.UIRestrictionsClass = UILIMIT_ALL;
      SetInformationJobObject(handle, JobObjectBasicUIRestrictions, ref ui, Marshal.SizeOf(typeof(JOBOBJECT_BASIC_UI_RESTRICTIONS)));
      return new JobObject(handle);
    }
    // The Full-control shell's job (§3.2, §6): die-on-exception and the UI
    // restrictions, but no caps and NOT kill-on-close, so a normal completion
    // leaves `start`-ed background apps running (the Mac's process-group kill
    // leaves them too); the helper terminates the job only on abort or timeout.
    public static JobObject CreateForShell() {
      IntPtr handle = CreateJobObjectW(IntPtr.Zero, null);
      if (handle == IntPtr.Zero) throw Sandbox.Refusal(503, "Windows wouldn't create the shell's job object.");
      var ext = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      ext.BasicLimitInformation.LimitFlags = JOB_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
      SetInformationJobObject(handle, JobObjectExtendedLimitInformation, ref ext, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
      var ui = new JOBOBJECT_BASIC_UI_RESTRICTIONS(); ui.UIRestrictionsClass = UILIMIT_ALL;
      SetInformationJobObject(handle, JobObjectBasicUIRestrictions, ref ui, Marshal.SizeOf(typeof(JOBOBJECT_BASIC_UI_RESTRICTIONS)));
      return new JobObject(handle);
    }
    public int ActiveProcesses() {
      var acct = new JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
      if (!QueryInformationJobObject(Handle, JobObjectBasicAccountingInformation, ref acct, Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)), IntPtr.Zero)) return 0;
      return (int)acct.ActiveProcesses;
    }
    public void Terminate() { try { TerminateJobObject(Handle, 1); } catch (Exception) { } }
    public void Dispose() { if (Handle != IntPtr.Zero) { CloseHandle(Handle); Handle = IntPtr.Zero; } }
  }

  // A launched, Job-assigned, AppContainer process, with the parent ends of its
  // output pipes. Its only inherited handles are the three std pipes (HANDLE_LIST).
  public class Launched : IDisposable {
    public IntPtr Process, Thread; public int ProcessId; public bool TimedOut;
    public Stream StdoutRead, StderrRead;
    IntPtr stdinNul, stdoutWrite, stderrWrite, stdoutReadH, stderrReadH, attributeList;
    public void Resume() { ResumeThread(Thread); }
    public void Kill() { try { TerminateProcess(Process, 1); } catch (Exception) { } }
    public int WaitForExit(int ms) {
      uint waited = WaitForSingleObject(Process, ms < 0 ? 0xFFFFFFFF : (uint)ms);
      if (waited == 0x102) { TimedOut = true; Kill(); WaitForSingleObject(Process, 2000); } // WAIT_TIMEOUT
      uint code; if (!GetExitCodeProcess(Process, out code)) return -1;
      if (code == 259) return -1; // STILL_ACTIVE
      return unchecked((int)code);
    }
    internal void Adopt(PROCESS_INFORMATION pi, IntPtr nul, IntPtr outW, IntPtr errW, IntPtr outR, IntPtr errR, IntPtr attrs) {
      Process = pi.hProcess; Thread = pi.hThread; ProcessId = pi.dwProcessId;
      stdinNul = nul; stdoutWrite = outW; stderrWrite = errW; stdoutReadH = outR; stderrReadH = errR; attributeList = attrs;
      StdoutRead = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(outR, false), FileAccess.Read);
      StderrRead = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(errR, false), FileAccess.Read);
    }
    public void Dispose() {
      // The child owns its ends; close ours so the reads see EOF.
      foreach (IntPtr h in new IntPtr[] { stdinNul, stdoutWrite, stderrWrite }) if (h != IntPtr.Zero && h != Invalid) CloseHandle(h);
      if (attributeList != IntPtr.Zero) { DeleteProcThreadAttributeList(attributeList); Marshal.FreeHGlobal(attributeList); }
      if (Thread != IntPtr.Zero) CloseHandle(Thread);
      if (Process != IntPtr.Zero) CloseHandle(Process);
    }
  }

  public static Launched LaunchContained(string commandLine, string cwd, Container container, JobObject job, bool suspended) {
    var sa = new SECURITY_ATTRIBUTES(); sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); sa.bInheritHandle = 1; sa.lpSecurityDescriptor = IntPtr.Zero;
    IntPtr outRead, outWrite, errRead, errWrite;
    if (!CreatePipe(out outRead, out outWrite, ref sa, 0) || !CreatePipe(out errRead, out errWrite, ref sa, 0))
      throw Sandbox.Refusal(503, "Windows wouldn't open the sandbox's pipes.");
    SetHandleInformation(outRead, HANDLE_FLAG_INHERIT, 0);
    SetHandleInformation(errRead, HANDLE_FLAG_INHERIT, 0);
    IntPtr nul = CreateFileW("NUL", GENERIC_READ, FILE_SHARE_ALL, ref sa, OPEN_EXISTING, 0, IntPtr.Zero);

    // The attribute list: the child is in the job at creation (no unassigned
    // window), inherits only these three handles, and — for jobs and scripts —
    // is placed in the AppContainer. The Full-control shell has no container, so
    // it runs on the owner's token with no SECURITY_CAPABILITIES attribute.
    int attrCount = (container != null ? 1 : 0) + 2;
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, attrCount, 0, ref size);
    IntPtr attrs = Marshal.AllocHGlobal(size.ToInt32());
    if (!InitializeProcThreadAttributeList(attrs, attrCount, 0, ref size)) throw Sandbox.Refusal(503, "Windows wouldn't prepare the sandbox launch.");
    IntPtr handleArray = Marshal.AllocHGlobal(IntPtr.Size * 3);
    Marshal.WriteIntPtr(handleArray, 0, nul); Marshal.WriteIntPtr(handleArray, IntPtr.Size, outWrite); Marshal.WriteIntPtr(handleArray, IntPtr.Size * 2, errWrite);
    IntPtr jobHandlePtr = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobHandlePtr, job.Handle);
    if (container != null) UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, container.CapabilitiesPtr, (IntPtr)Marshal.SizeOf(typeof(SECURITY_CAPABILITIES)), IntPtr.Zero, IntPtr.Zero);
    UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobHandlePtr, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero);
    UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handleArray, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero);

    var startup = new STARTUPINFOEX();
    startup.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = nul; startup.StartupInfo.hStdOutput = outWrite; startup.StartupInfo.hStdError = errWrite;
    startup.lpAttributeList = attrs;
    IntPtr env = BuildEnvironment(container != null ? container.TempFolder : null);
    uint flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | (suspended ? CREATE_SUSPENDED : 0);
    PROCESS_INFORMATION pi;
    bool ok = CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, true, flags, env, cwd, ref startup, out pi);
    int error = Marshal.GetLastWin32Error();
    Marshal.FreeHGlobal(env); Marshal.FreeHGlobal(handleArray); Marshal.FreeHGlobal(jobHandlePtr);
    if (!ok) {
      DeleteProcThreadAttributeList(attrs); Marshal.FreeHGlobal(attrs);
      foreach (IntPtr h in new IntPtr[] { nul, outWrite, errWrite, outRead, errRead }) if (h != IntPtr.Zero && h != Invalid) CloseHandle(h);
      throw Sandbox.Refusal(503, "Windows wouldn't start the sandboxed command (" + error + ").");
    }
    var launched = new Launched();
    launched.Adopt(pi, nul, outWrite, errWrite, outRead, errRead, attrs);
    return launched;
  }

  public static string RunContainedCaptured(string commandLine, string cwd, Container container, JobObject job, int timeoutMs) {
    Launched launched = LaunchContained(commandLine, cwd, container, job, false);
    try {
      var sb = new StringBuilder();
      Thread reader = new Thread(delegate () { try { using (StreamReader r = new StreamReader(launched.StdoutRead)) sb.Append(r.ReadToEnd()); } catch (Exception) { } });
      reader.IsBackground = true; reader.Start();
      launched.WaitForExit(timeoutMs);
      reader.Join(1000);
      return sb.ToString();
    } finally { launched.Dispose(); }
  }

  // §4.5 preflight: the first deny path the launch token can still read, or null.
  public static string FirstReachableSecret(IntPtr process, List<string> denies) {
    IntPtr primary, impersonation;
    if (!OpenProcessToken(process, TOKEN_QUERY | TOKEN_DUPLICATE, out primary)) return null;
    try {
      if (!DuplicateToken(primary, 2, out impersonation)) return null;
      try {
        var mapping = new GENERIC_MAPPING(); mapping.GenericRead = 0x120089; mapping.GenericWrite = 0x120116; mapping.GenericExecute = 0x1200a0; mapping.GenericAll = 0x1f01ff;
        foreach (string path in denies) {
          byte[] sd = ReadSecurity(path);
          if (sd == null) continue;
          uint desired = FILE_GENERIC_READ; MapGenericMask(ref desired, ref mapping);
          var priv = new PRIVILEGE_SET(); int privLen = Marshal.SizeOf(typeof(PRIVILEGE_SET)); uint granted; bool status;
          if (AccessCheck(sd, impersonation, desired, ref mapping, ref priv, ref privLen, out granted, out status) && status && granted != 0) return path;
        }
        return null;
      } finally { CloseHandle(impersonation); }
    } finally { CloseHandle(primary); }
  }

  static byte[] ReadSecurity(string path) {
    int needed;
    const int OWNER_GROUP_DACL = 0x7;
    if (GetFileSecurityW(path, OWNER_GROUP_DACL, null, 0, out needed) || needed <= 0) {
      if (needed <= 0) return null;
    }
    byte[] buffer = new byte[needed];
    return GetFileSecurityW(path, OWNER_GROUP_DACL, buffer, buffer.Length, out needed) ? buffer : null;
  }

  // One reader thread per output pipe, wrapping each read into a data frame.
  public static Thread Pump(Stream stream, byte type, Action<byte, byte[]> emit) {
    Thread thread = new Thread(delegate () {
      byte[] buffer = new byte[16384];
      try {
        int got;
        while ((got = stream.Read(buffer, 0, buffer.Length)) > 0) {
          byte[] chunk = new byte[got]; Array.Copy(buffer, chunk, got); emit(type, chunk);
        }
      } catch (Exception) { }
    });
    thread.IsBackground = true; thread.Start();
    return thread;
  }

  static IntPtr BuildEnvironment(string tempFolder) {
    // The owner's own environment (the helper runs as the owner), minus Reach's
    // own REACH_* variables, plus REACH_AGENT=1 — the shell's CreateEnvironmentBlock
    // equivalent (§3.2). For an AppContainer job, TEMP/TMP point at the
    // container's own folder, which is all it can write (finding 10); the shell
    // keeps the owner's TEMP.
    var sb = new StringBuilder();
    bool overrideTemp = !string.IsNullOrEmpty(tempFolder);
    foreach (System.Collections.DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
      string key = (string)entry.Key;
      if (key.StartsWith("REACH_", StringComparison.OrdinalIgnoreCase)) continue;
      if (overrideTemp && (string.Equals(key, "TEMP", StringComparison.OrdinalIgnoreCase) || string.Equals(key, "TMP", StringComparison.OrdinalIgnoreCase))) continue;
      sb.Append(key).Append('=').Append((string)entry.Value).Append('\0');
    }
    if (overrideTemp) { sb.Append("TEMP=").Append(tempFolder).Append('\0'); sb.Append("TMP=").Append(tempFolder).Append('\0'); }
    sb.Append("REACH_AGENT=1\0\0");
    byte[] bytes = Encoding.Unicode.GetBytes(sb.ToString());
    IntPtr ptr = Marshal.AllocHGlobal(bytes.Length); Marshal.Copy(bytes, 0, ptr, bytes.Length); return ptr;
  }
}

// ---------------------------------------------------------------------------
// §3.2 Full-control shell. The Mac runs /bin/zsh unsandboxed as the owner;
// Windows matches that with a Job Object on the owner's token — no AppContainer,
// no caps — running cmd.exe /d /s /c. Output is relayed as frames; the main
// process's exit is reported and then the helper leaves the job (so background
// apps survive), terminating it only on abort (Node's stdin EOF) or timeout.
static class Shell {
  public static int Run(Sandbox.Request request, Action<byte, byte[]> emit) {
    string command = request.Get("command", "");
    string cwd = request.Get("cwd", "");
    if (string.IsNullOrEmpty(cwd)) cwd = null;
    int timeoutMs = request.Int("timeoutMs", 60000);
    using (NativeProc.JobObject job = NativeProc.JobObject.CreateForShell()) {
      string commandLine = "\"" + NativeProc.ComSpec() + "\" /d /s /c " + command;
      NativeProc.Launched launched = NativeProc.LaunchContained(commandLine, cwd, null, job, false);
      try {
        emit(Sandbox.TypeStarted, BeBytes(launched.ProcessId));
        var pump = new List<Thread>();
        pump.Add(NativeProc.Pump(launched.StdoutRead, Sandbox.TypeStdout, emit));
        pump.Add(NativeProc.Pump(launched.StderrRead, Sandbox.TypeStderr, emit));
        // The lifeline: Node's EOF on our stdin is an abort — reap the tree.
        Thread lifeline = new Thread(delegate () {
          try { Stream stdin = Console.OpenStandardInput(); byte[] one = new byte[1]; while (stdin.Read(one, 0, 1) > 0) { } } catch (Exception) { }
          try { job.Terminate(); } catch (Exception) { }
        });
        lifeline.IsBackground = true; lifeline.Start();
        int code = launched.WaitForExit(timeoutMs);
        emit(Sandbox.TypeExit, BeBytes(code));
        // On a timeout the whole tree is reaped; on a normal completion the job
        // is left open so backgrounded apps keep running (parity with the Mac).
        if (launched.TimedOut) job.Terminate();
        foreach (Thread t in pump) { try { t.Join(1000); } catch (Exception) { } }
        return 0;
      } finally { launched.Dispose(); }
    }
  }
  static byte[] BeBytes(int value) {
    return new byte[] { (byte)((value >> 24) & 0xff), (byte)((value >> 16) & 0xff), (byte)((value >> 8) & 0xff), (byte)(value & 0xff) };
  }
}
