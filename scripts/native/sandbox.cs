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
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

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
  class Request {
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
      default:
        throw new Refused(400, "This sandbox mode is not available on this computer.");
    }
  }

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
