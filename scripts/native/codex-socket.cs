// Codex's shared Windows daemon uses Winsock AF_UNIX, not a named pipe.
// Authenticate the very connection relayed below before accepting any bytes
// from Reach. This follows OpenAI's rust-v0.163.0 uds/windows_socket_validation
// and windows_peer policy; it never creates or repairs a Codex directory.
// https://github.com/openai/codex/tree/rust-v0.163.0/codex-rs/uds/src
// SDK: afunix.h (sockaddr_un, UTF-8 pathname, SIO_AF_UNIX_GETPEERPID).
// C# 5 / the Windows .NET Framework compiler. stdout is binary socket data;
// stderr has one allowlisted readiness/error line, never a path or payload.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class CodexSocket {
  const uint READ_CONTROL = 0x20000, FILE_READ_ATTRIBUTES = 0x80, FILE_LIST_DIRECTORY = 1;
  const uint FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, FILE_SHARE_DELETE = 4;
  const uint OPEN_EXISTING = 3, FILE_FLAG_BACKUP_SEMANTICS = 0x02000000, FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const uint FILE_ATTRIBUTE_DIRECTORY = 0x10, FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
  const uint OWNER_SECURITY_INFORMATION = 1, DACL_SECURITY_INFORMATION = 4, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint TOKEN_QUERY = 8, SYNCHRONIZE = 0x100000, INFINITE = 0xffffffff;
  const int FILE_ALL_ACCESS = 0x1f01ff, TOKEN_USER = 1, TOKEN_ELEVATION = 20;
  const uint SIO_AF_UNIX_GETPEERPID = 0x58000100;
  const int AF_UNIX = 1, SOCK_STREAM = 1, SOCKET_ERROR = -1;
  static readonly IntPtr InvalidSocket = new IntPtr(-1);
  static IntPtr liveSocket = InvalidSocket;

  [StructLayout(LayoutKind.Sequential)]
  struct FileInformation {
    public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInformation info);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, StringBuilder path, uint size, uint flags);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern uint GetSecurityInfo(SafeFileHandle file, int type, uint wanted, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")]
  static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  static extern uint WaitForMultipleObjects(uint count, [In, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] IntPtr[] handles, bool all, uint milliseconds);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern IntPtr CreateEventW(IntPtr security, bool manualReset, bool initialState, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetEvent(IntPtr handle);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr buffer, int length, out int needed);
  [DllImport("ws2_32.dll")]
  static extern int WSAStartup(ushort version, byte[] data);
  [DllImport("ws2_32.dll")]
  static extern int WSACleanup();
  [DllImport("ws2_32.dll")]
  static extern IntPtr socket(int family, int type, int protocol);
  [DllImport("ws2_32.dll")]
  static extern int connect(IntPtr socket, byte[] address, int length);
  [DllImport("ws2_32.dll")]
  static extern int WSAIoctl(IntPtr socket, uint code, IntPtr input, uint inputSize, out uint output, uint outputSize, out uint returned, IntPtr overlapped, IntPtr completion);
  [DllImport("ws2_32.dll")]
  static extern int recv(IntPtr socket, byte[] buffer, int length, int flags);
  [DllImport("ws2_32.dll")]
  static extern int send(IntPtr socket, IntPtr buffer, int length, int flags);
  [DllImport("ws2_32.dll")]
  static extern int shutdown(IntPtr socket, int how);
  [DllImport("ws2_32.dll")]
  static extern int closesocket(IntPtr socket);

  sealed class Refused : Exception {
    public readonly string Reason;
    public Refused(string reason) { Reason = reason; }
  }
  sealed class Token : IDisposable {
    public IntPtr Handle;
    public readonly SecurityIdentifier User;
    public Token(IntPtr process) {
      if (!OpenProcessToken(process, TOKEN_QUERY, out Handle)) throw new Refused("identity");
      try {
        int needed;
        GetTokenInformation(Handle, TOKEN_USER, IntPtr.Zero, 0, out needed);
        if (needed <= 0 || needed > 65536) throw new Refused("identity");
        IntPtr value = Marshal.AllocHGlobal(needed);
        try {
          if (!GetTokenInformation(Handle, TOKEN_USER, value, needed, out needed)) throw new Refused("identity");
          User = new SecurityIdentifier(Marshal.ReadIntPtr(value));
        } finally { Marshal.FreeHGlobal(value); }
      } catch { Dispose(); throw; }
    }
    public void RequireNonElevated() {
      IntPtr value = Marshal.AllocHGlobal(4);
      try {
        int needed;
        if (!GetTokenInformation(Handle, TOKEN_ELEVATION, value, 4, out needed) || needed != 4) throw new Refused("identity");
        if (Marshal.ReadInt32(value) != 0) throw new Refused("elevation");
      } finally { Marshal.FreeHGlobal(value); }
    }
    public void Dispose() { if (Handle != IntPtr.Zero) { CloseHandle(Handle); Handle = IntPtr.Zero; } }
  }

  static void Control(string text) { Console.Error.Write(text + "\n"); Console.Error.Flush(); }
  static bool LocalPath(string value) {
    if (value.StartsWith(@"\\?\", StringComparison.Ordinal)) value = value.Substring(4);
    if (value.Length < 4 || !char.IsLetter(value[0]) || value[1] != ':' || value[2] != '\\') return false;
    for (int i = 3; i < value.Length; i++) if (value[i] < 32 || value[i] == ':' || value[i] == '*' || value[i] == '?' || value[i] == '\0') return false;
    return true;
  }
  // GetFullPath on .NET Framework uses ordinary drive paths. Only the input
  // spelling is converted; the validated canonical path below retains its
  // extended prefix, just as Codex's std::fs::canonicalize does.
  static string DosPath(string value) {
    if (!LocalPath(value)) throw new Refused("endpoint");
    return value.StartsWith(@"\\?\", StringComparison.Ordinal) ? value.Substring(4) : value;
  }
  static string FinalPath(SafeFileHandle file) {
    StringBuilder value = new StringBuilder(32768);
    uint size = GetFinalPathNameByHandleW(file, value, (uint)value.Capacity, 0);
    if (size == 0 || size >= value.Capacity) throw new Refused("directory");
    string path = value.ToString();
    if (!LocalPath(path)) throw new Refused("endpoint");
    return path;
  }
  static SafeFileHandle PinDirectory(string endpoint, SecurityIdentifier user, out string resolvedEndpoint) {
    resolvedEndpoint = null;
    if (!LocalPath(endpoint)) throw new Refused("endpoint");
    string absolute = Path.GetFullPath(DosPath(endpoint));
    string directory = Path.GetDirectoryName(absolute), name = Path.GetFileName(absolute);
    if (string.IsNullOrEmpty(directory) || string.IsNullOrEmpty(name)) throw new Refused("endpoint");
    string parent = Path.GetDirectoryName(directory), leaf = Path.GetFileName(directory);
    if (string.IsNullOrEmpty(parent) || string.IsNullOrEmpty(leaf)) throw new Refused("directory");
    // Resolve ancestor junctions, but open the final directory itself without
    // following a reparse point, as the vendor's validator does.
    using (SafeFileHandle ancestor = CreateFileW(parent, FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero)) {
      if (ancestor.IsInvalid) throw new Refused("directory");
      directory = Path.Combine(FinalPath(ancestor), leaf);
    }
    SafeFileHandle guard = CreateFileW(directory, READ_CONTROL | FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY,
      FILE_SHARE_READ | FILE_SHARE_WRITE, IntPtr.Zero, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    try {
      FileInformation info;
      if (guard.IsInvalid || !GetFileInformationByHandle(guard, out info)) throw new Refused("directory");
      if ((info.Attributes & FILE_ATTRIBUTE_DIRECTORY) == 0 || (info.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) throw new Refused("reparse");
      RequirePrivateAcl(guard, user);
      // The pathname used for connect comes from the validated, pinned handle,
      // never from an unresolved alias checked before opening that handle.
      resolvedEndpoint = Path.Combine(FinalPath(guard), name);
      return guard;
    } catch { guard.Dispose(); throw; }
  }
  static void RequirePrivateAcl(SafeFileHandle directory, SecurityIdentifier user) {
    IntPtr owner, group, dacl, sacl, descriptor;
    if (GetSecurityInfo(directory, 1, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
        out owner, out group, out dacl, out sacl, out descriptor) != 0) throw new Refused("directory");
    try {
      uint length = GetSecurityDescriptorLength(descriptor);
      if (length == 0 || length > 65536) throw new Refused("directory");
      byte[] bytes = new byte[(int)length];
      Marshal.Copy(descriptor, bytes, 0, bytes.Length);
      RawSecurityDescriptor sd = new RawSecurityDescriptor(bytes, 0);
      if (sd.Owner == null || !sd.Owner.Equals(user) ||
          (sd.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0 ||
          sd.DiscretionaryAcl == null || sd.DiscretionaryAcl.Count != 1) throw new Refused("acl");
      CommonAce ace = sd.DiscretionaryAcl[0] as CommonAce;
      if (ace == null || ace.AceType != AceType.AccessAllowed ||
          ace.AceFlags != (AceFlags.ContainerInherit | AceFlags.ObjectInherit) ||
          ace.AccessMask != FILE_ALL_ACCESS || !ace.SecurityIdentifier.Equals(user)) throw new Refused("acl");
    } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
  }
  static void RequirePeer(IntPtr connection, Token current) {
    uint pid, returned;
    // Some Windows builds return a valid PID and zero returned bytes. The PID
    // itself must be nonzero; a PID file is never accepted as this evidence.
    if (WSAIoctl(connection, SIO_AF_UNIX_GETPEERPID, IntPtr.Zero, 0, out pid, 4, out returned, IntPtr.Zero, IntPtr.Zero) == SOCKET_ERROR || pid == 0)
      throw new Refused("peer");
    IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (process == IntPtr.Zero) throw new Refused("identity");
    try {
      using (Token peer = new Token(process)) {
        if (!current.User.Equals(peer.User)) throw new Refused("identity");
        current.RequireNonElevated();
        peer.RequireNonElevated();
      }
    } finally { CloseHandle(process); }
  }
  static void CloseSocket() {
    IntPtr connection = Interlocked.Exchange(ref liveSocket, InvalidSocket);
    if (connection != InvalidSocket) { shutdown(connection, 2); closesocket(connection); }
  }
  static int Relay(IntPtr connection) {
    var inputDone = new ManualResetEvent(false);
    var outputDone = new ManualResetEvent(false);
    int failed = 0;
    Thread input = new Thread(delegate() {
      byte[] buffer = new byte[65536];
      GCHandle pinned = GCHandle.Alloc(buffer, GCHandleType.Pinned);
      try {
        Stream stream = Console.OpenStandardInput();
        for (int count; (count = stream.Read(buffer, 0, buffer.Length)) > 0; ) {
          int offset = 0;
          while (offset < count) {
            int written = send(connection, IntPtr.Add(pinned.AddrOfPinnedObject(), offset), count - offset, 0);
            if (written <= 0) throw new IOException();
            offset += written;
          }
        }
        shutdown(connection, 1); // EOF: preserve the peer's final reply.
      } catch { Interlocked.Exchange(ref failed, 1); }
      finally { pinned.Free(); inputDone.Set(); }
    });
    Thread output = new Thread(delegate() {
      byte[] buffer = new byte[65536];
      try {
        Stream stream = Console.OpenStandardOutput();
        int count;
        while ((count = recv(connection, buffer, buffer.Length, 0)) > 0) stream.Write(buffer, 0, count);
        if (count < 0) Interlocked.Exchange(ref failed, 1);
        stream.Flush();
      } catch { Interlocked.Exchange(ref failed, 1); }
      finally { outputDone.Set(); }
    });
    input.IsBackground = true; output.IsBackground = true;
    input.Start(); output.Start();
    int done = WaitHandle.WaitAny(new WaitHandle[] { outputDone, inputDone });
    // A parent that closed stdin cannot strand a process on a peer that never
    // closes. Both directions use fixed buffers and blocking IO backpressure.
    if (done == 1 && Interlocked.CompareExchange(ref failed, 0, 0) == 0) outputDone.WaitOne(2000);
    CloseSocket();
    return Interlocked.CompareExchange(ref failed, 0, 0);
  }
  static int Main(string[] args) {
    bool winsock = false;
    IntPtr parent = IntPtr.Zero, stopWatcher = IntPtr.Zero;
    Thread watcher = null;
    bool watcherStarted = false;
    try {
      uint parentPid;
      if (args.Length != 2 || !uint.TryParse(args[1], out parentPid) || parentPid == 0) throw new Refused("endpoint");
      parent = OpenProcess(SYNCHRONIZE, false, parentPid);
      if (parent == IntPtr.Zero) throw new Refused("parent");
      stopWatcher = CreateEventW(IntPtr.Zero, true, false, null);
      if (stopWatcher == IntPtr.Zero) throw new Refused("parent");
      IntPtr watched = parent, stop = stopWatcher;
      watcher = new Thread(delegate() {
        // Stop wins simultaneous signals during normal shutdown. Neither
        // wait handle is closed until this watcher has returned and joined.
        uint outcome = WaitForMultipleObjects(2, new IntPtr[] { stop, watched }, false, INFINITE);
        if (outcome == 1) {
          CloseSocket();
          // This also ends a blocked stdio writer; Windows closes all pinned
          // handles. No child or daemon is started by this helper.
          Environment.Exit(0);
        }
        // A failed/unexpected wait cannot leave an unmonitored relay alive.
        if (outcome != 0) Environment.Exit(1);
      });
      watcher.IsBackground = true; watcher.Start(); watcherStarted = true;
      using (Token current = new Token(GetCurrentProcess())) {
        string endpoint;
        using (SafeFileHandle directory = PinDirectory(args[0], current.User, out endpoint)) {
          byte[] path = new UTF8Encoding(false, true).GetBytes(endpoint);
          if (path.Length == 0 || path.Length >= 108) throw new Refused("length");
          byte[] address = new byte[110];
          address[0] = AF_UNIX;
          Buffer.BlockCopy(path, 0, address, 2, path.Length);
          if (WSAStartup(0x0202, new byte[512]) != 0) throw new Refused("connection");
          winsock = true;
          liveSocket = socket(AF_UNIX, SOCK_STREAM, 0);
          if (liveSocket == InvalidSocket || connect(liveSocket, address, address.Length) == SOCKET_ERROR) throw new Refused("connection");
          RequirePeer(liveSocket, current);
          // Catch path substitution as well as authenticating the connection.
          if (!string.Equals(Path.Combine(FinalPath(directory), Path.GetFileName(endpoint)), endpoint, StringComparison.OrdinalIgnoreCase)) throw new Refused("directory");
          Control("ready 1");
          return Relay(liveSocket);
        }
      }
    } catch (Refused refusal) { Control("error " + refusal.Reason); return 1; }
    catch { Control("error check"); return 1; }
    finally {
      CloseSocket();
      // Closing a handle during a pending Windows wait is undefined. End the
      // wait and join first; on failure, process exit lets Windows end every
      // thread before reclaiming its handles rather than racing their reuse.
      if (watcherStarted) {
        bool joined = false;
        try { joined = SetEvent(stopWatcher) && watcher.Join(2000); } catch { }
        if (!joined) Environment.Exit(1);
      }
      if (winsock) WSACleanup();
      if (parent != IntPtr.Zero) CloseHandle(parent);
      if (stopWatcher != IntPtr.Zero) CloseHandle(stopWatcher);
    }
  }
}
