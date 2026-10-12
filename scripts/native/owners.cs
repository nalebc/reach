// Reach's owner checks on Windows (server/windows-owners.mjs), where a Mac
// reads a socket's owner and folder and asks lsof: who serves a named pipe,
// and which processes hold a file open. C# 5, the language of the .NET
// Framework 4.x compiler (docs/WINDOWS_AGENT_PARITY.md, rule 3). One JSON
// line, ASCII only, then exit 0:
//   owners pipe \\.\pipe\<name>
//     {"self":"S-…","logon":["S-…"],"owner":"S-…","serves":["S-…"],"pid":1,"user":"S-…","image":"C:\\…"}
//     self and logon: this process's account and logon session; owner: the
//     pipe's; serves: every account the pipe lets serve it too (a new
//     instance) or change who may; user: the account of the process serving
//     the instance this check reached.
//   owners holders <file>
//     {"holders":[{"pid":1,"image":"C:\\…","command":"…","parents":["node.exe","pwsh.exe"]}]}
//   {"error":"missing","code":2} when there's no such pipe or file,
//   {"error":"unchecked","code":N} when Windows wouldn't say.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using Microsoft.Win32.SafeHandles;

static class Owners {
  const uint GENERIC_READ = 0x80000000, OPEN_EXISTING = 3;
  // The server may only identify this process, never act as it.
  const uint SECURITY_SQOS_PRESENT = 0x00100000, SECURITY_IDENTIFICATION = 0x00010000;
  const uint OWNER_SECURITY_INFORMATION = 1, DACL_SECURITY_INFORMATION = 4;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000, TOKEN_QUERY = 0x8;
  const int TOKEN_USER = 1, TOKEN_LOGON_SID = 28, PROCESS_COMMAND_LINE = 60;
  const int ERROR_FILE_NOT_FOUND = 2, ERROR_PATH_NOT_FOUND = 3, ERROR_PIPE_BUSY = 231, ERROR_MORE_DATA = 234;
  // What lets an account serve a pipe too, or change who may:
  // FILE_CREATE_PIPE_INSTANCE, WRITE_DAC, WRITE_OWNER, GENERIC_WRITE, GENERIC_ALL.
  const int SERVES = 0x4 | 0x40000 | 0x80000 | 0x40000000 | 0x10000000;

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool WaitNamedPipeW(string name, uint timeout);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetNamedPipeServerProcessId(SafeFileHandle pipe, out uint pid);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetKernelObjectSecurity(SafeFileHandle handle, uint wanted, byte[] descriptor, uint length, out uint needed);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr info, int length, out int needed);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr process, int kind, IntPtr info, int length, out int returned);

  [StructLayout(LayoutKind.Sequential)]
  struct RM_UNIQUE_PROCESS {
    public uint dwProcessId;
    public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType;
    public uint AppStatus;
    public uint TSSessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint session, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint session, uint files, string[] names, uint apps, RM_UNIQUE_PROCESS[] processes, uint services, string[] serviceNames);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] found, ref uint reasons);
  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint session);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32W {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);

  static int Main(string[] args) {
    string said;
    try {
      if (args.Length == 2 && args[0] == "pipe") said = Pipe(args[1]);
      else if (args.Length == 2 && args[0] == "holders") said = Holders(args[1]);
      else said = Error("unchecked", 0);
    } catch (Exception) {
      said = Error("unchecked", -1);
    }
    Console.Out.Write(said + "\n");
    Console.Out.Flush();
    return 0;
  }

  static string Error(string kind, int code) {
    return "{\"error\":\"" + kind + "\",\"code\":" + code + "}";
  }

  // As JSON, in ASCII: the console's code page can't spoil a path.
  static string Quote(string text) {
    if (text == null) return "null";
    StringBuilder b = new StringBuilder("\"");
    foreach (char c in text) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < 0x20 || c > 0x7e) b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
  static string Strings(List<string> items) {
    List<string> quoted = new List<string>();
    foreach (string item in items) quoted.Add(Quote(item));
    return "[" + string.Join(",", quoted.ToArray()) + "]";
  }

  static string Pipe(string name) {
    SafeFileHandle pipe = null;
    for (int tries = 0; ; tries++) {
      pipe = CreateFileW(name, GENERIC_READ, 0, IntPtr.Zero, OPEN_EXISTING, SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, IntPtr.Zero);
      if (!pipe.IsInvalid) break;
      int error = Marshal.GetLastWin32Error();
      if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return Error("missing", error);
      // Every instance taken: wait once for one.
      if (error != ERROR_PIPE_BUSY || tries > 0) return Error("unchecked", error);
      WaitNamedPipeW(name, 2000);
    }
    using (pipe) {
      byte[] descriptor = SecurityOf(pipe);
      uint pid;
      if (descriptor == null || !GetNamedPipeServerProcessId(pipe, out pid)) return Error("unchecked", Marshal.GetLastWin32Error());
      RawSecurityDescriptor security = new RawSecurityDescriptor(descriptor, 0);
      List<string> serves = new List<string>();
      // No list at all lets everyone do anything.
      if ((security.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0 || security.DiscretionaryAcl == null) serves.Add("S-1-1-0");
      else foreach (GenericAce ace in security.DiscretionaryAcl) {
        if ((ace.AceFlags & AceFlags.InheritOnly) != 0) continue;
        if (ace.AceType != AceType.AccessAllowed && ace.AceType != AceType.AccessAllowedCompound && ace.AceType != AceType.AccessAllowedObject
            && ace.AceType != AceType.AccessAllowedCallback && ace.AceType != AceType.AccessAllowedCallbackObject) continue;
        KnownAce known = ace as KnownAce;
        if (known == null) serves.Add("unknown");
        else if ((known.AccessMask & SERVES) != 0) serves.Add(known.SecurityIdentifier.Value);
      }
      string image;
      string user = UserOf(pid, out image);
      IntPtr self = IntPtr.Zero;
      List<string> logon = new List<string>();
      if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out self)) {
        try { logon = LogonOf(self); } finally { CloseHandle(self); }
      }
      return "{\"self\":" + Quote(WindowsIdentity.GetCurrent().User.Value) + ",\"logon\":" + Strings(logon)
        + ",\"owner\":" + Quote(security.Owner == null ? null : security.Owner.Value) + ",\"serves\":" + Strings(serves)
        + ",\"pid\":" + pid + ",\"user\":" + Quote(user) + ",\"image\":" + Quote(image) + "}";
    }
  }

  static byte[] SecurityOf(SafeFileHandle handle) {
    uint needed;
    GetKernelObjectSecurity(handle, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, null, 0, out needed);
    if (needed == 0 || needed > 65536) return null;
    byte[] descriptor = new byte[needed];
    return GetKernelObjectSecurity(handle, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, descriptor, needed, out needed) ? descriptor : null;
  }

  // A token's answer, in a buffer of the size it asks for.
  static IntPtr TokenInfo(IntPtr token, int kind) {
    int needed;
    GetTokenInformation(token, kind, IntPtr.Zero, 0, out needed);
    if (needed <= 0 || needed > 65536) return IntPtr.Zero;
    IntPtr buffer = Marshal.AllocHGlobal(needed);
    if (GetTokenInformation(token, kind, buffer, needed, out needed)) return buffer;
    Marshal.FreeHGlobal(buffer);
    return IntPtr.Zero;
  }
  static List<string> LogonOf(IntPtr token) {
    List<string> found = new List<string>();
    IntPtr groups = TokenInfo(token, TOKEN_LOGON_SID);
    if (groups == IntPtr.Zero) return found;
    try {
      // TOKEN_GROUPS: a count, then (SID, attributes) pairs, pointer-aligned.
      int count = Marshal.ReadInt32(groups);
      for (int i = 0; i < count && i < 16; i++)
        found.Add(new SecurityIdentifier(Marshal.ReadIntPtr(groups, IntPtr.Size + i * 2 * IntPtr.Size)).Value);
    } finally { Marshal.FreeHGlobal(groups); }
    return found;
  }

  static string UserOf(uint pid, out string image) {
    image = null;
    IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (process == IntPtr.Zero) return null;
    try {
      image = ImageOf(process);
      IntPtr token;
      if (!OpenProcessToken(process, TOKEN_QUERY, out token)) return null;
      try {
        IntPtr user = TokenInfo(token, TOKEN_USER);
        if (user == IntPtr.Zero) return null;
        try { return new SecurityIdentifier(Marshal.ReadIntPtr(user)).Value; } finally { Marshal.FreeHGlobal(user); }
      } finally { CloseHandle(token); }
    } finally { CloseHandle(process); }
  }

  static string ImageOf(IntPtr process) {
    StringBuilder name = new StringBuilder(32768);
    uint size = (uint)name.Capacity;
    return QueryFullProcessImageNameW(process, 0, name, ref size) ? name.ToString(0, (int)size) : null;
  }

  static string CommandOf(IntPtr process) {
    int needed;
    NtQueryInformationProcess(process, PROCESS_COMMAND_LINE, IntPtr.Zero, 0, out needed);
    if (needed <= 0 || needed > 1 << 20) return null;
    IntPtr buffer = Marshal.AllocHGlobal(needed);
    try {
      if (NtQueryInformationProcess(process, PROCESS_COMMAND_LINE, buffer, needed, out needed) != 0) return null;
      // A UNICODE_STRING: its length in bytes, then (pointer-aligned) where it is.
      int length = (ushort)Marshal.ReadInt16(buffer);
      IntPtr text = Marshal.ReadIntPtr(buffer, IntPtr.Size);
      return text == IntPtr.Zero ? null : Marshal.PtrToStringUni(text, length / 2);
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  // Every process's parent and program name, at one moment.
  static Dictionary<uint, KeyValuePair<uint, string>> Processes() {
    Dictionary<uint, KeyValuePair<uint, string>> table = new Dictionary<uint, KeyValuePair<uint, string>>();
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) return table;
    try {
      PROCESSENTRY32W entry = new PROCESSENTRY32W();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
      if (Process32FirstW(snapshot, ref entry))
        do table[entry.th32ProcessID] = new KeyValuePair<uint, string>(entry.th32ParentProcessID, entry.szExeFile);
        while (Process32NextW(snapshot, ref entry));
    } finally { CloseHandle(snapshot); }
    return table;
  }

  static string Holders(string file) {
    if (!File.Exists(file)) return Error("missing", ERROR_FILE_NOT_FOUND);
    uint session;
    int status = RmStartSession(out session, 0, new StringBuilder(64));
    if (status != 0) return Error("unchecked", status);
    try {
      status = RmRegisterResources(session, 1, new string[] { file }, 0, null, 0, null);
      if (status != 0) return Error("unchecked", status);
      uint needed, count = 0, reasons = 0;
      RM_PROCESS_INFO[] found = new RM_PROCESS_INFO[0];
      status = RmGetList(session, out needed, ref count, null, ref reasons);
      if (status == ERROR_MORE_DATA) {
        found = new RM_PROCESS_INFO[needed];
        count = needed;
        status = RmGetList(session, out needed, ref count, found, ref reasons);
      }
      // Still more: it changed meanwhile; no answer rather than half of one.
      if (status != 0) return Error("unchecked", status);
      Dictionary<uint, KeyValuePair<uint, string>> table = Processes();
      List<string> holders = new List<string>();
      for (int i = 0; i < count; i++) {
        uint pid = found[i].Process.dwProcessId;
        string image = null, command = null;
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (process != IntPtr.Zero) {
          try { image = ImageOf(process); command = CommandOf(process); } finally { CloseHandle(process); }
        }
        // Its parents' program names, nearest first.
        List<string> parents = new List<string>();
        HashSet<uint> seen = new HashSet<uint> { pid };
        KeyValuePair<uint, string> at;
        uint next = table.TryGetValue(pid, out at) ? at.Key : 0;
        while (next > 4 && parents.Count < 8 && seen.Add(next) && table.TryGetValue(next, out at)) {
          parents.Add(at.Value);
          next = at.Key;
        }
        holders.Add("{\"pid\":" + pid + ",\"image\":" + Quote(image) + ",\"command\":" + Quote(command) + ",\"parents\":" + Strings(parents) + "}");
      }
      return "{\"holders\":[" + string.Join(",", holders.ToArray()) + "]}";
    } finally { RmEndSession(session); }
  }
}
