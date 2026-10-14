// Every process on this Windows PC, as `ps` lists them on a Mac: Reach's one
// Reach per computer (scripts/instances.mjs) and anything else that finds a
// program by what it runs read it through server/windows-processes.mjs. C# 5,
// the language of the .NET Framework 4.x compiler (docs/WINDOWS_AGENT_PARITY.md,
// rule 3). No arguments. One JSON line, ASCII only, then exit 0:
//   {"processes":[{"pid":4242,"ppid":1200,"image":"node.exe",
//     "path":"C:\\Program Files\\nodejs\\node.exe",
//     "commandLine":"\"C:\\Program Files\\nodejs\\node.exe\" C:\\reach\\scripts\\bootstrap.mjs",
//     "startedAt":1760000000000}, …]}
//   pid, ppid: one Toolhelp snapshot. ppid is the id the parent had when this
//     process started: Windows never gives a process a new parent, and hands
//     ids out again, so a parent is one only if it started before its child.
//   image: the program's file name, as the snapshot gives it.
//   path: its full path (QueryFullProcessImageNameW).
//   commandLine: as it was started (NtQueryInformationProcess,
//     ProcessCommandLineInformation, Windows 8.1 and newer).
//   startedAt: when it started (GetProcessTimes), in ms since 1970 (UTC).
//   path, commandLine and startedAt are null when Windows won't say: another
//   account's process, a protected one, or one that ended meanwhile. Nothing
//   is guessed.
//   {"error":"unchecked","code":N} when there's no snapshot to read.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

static class Processes {
  const uint TH32CS_SNAPPROCESS = 2, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const int PROCESS_COMMAND_LINE = 60;
  // 1601 to 1970, in 100-ns ticks.
  const long EPOCH = 116444736000000000L;

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
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr process, int kind, IntPtr info, int length, out int returned);

  static int Main() {
    string said;
    try {
      said = List();
    } catch (Exception) {
      said = "{\"error\":\"unchecked\",\"code\":-1}";
    }
    Console.Out.Write(said + "\n");
    Console.Out.Flush();
    return 0;
  }

  static string List() {
    IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == new IntPtr(-1)) return "{\"error\":\"unchecked\",\"code\":" + Marshal.GetLastWin32Error() + "}";
    List<string> rows = new List<string>();
    try {
      PROCESSENTRY32W entry = new PROCESSENTRY32W();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
      if (Process32FirstW(snapshot, ref entry))
        do rows.Add(Row(entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile));
        while (Process32NextW(snapshot, ref entry));
    } finally { CloseHandle(snapshot); }
    return "{\"processes\":[" + string.Join(",", rows.ToArray()) + "]}";
  }

  static string Row(uint pid, uint ppid, string image) {
    string path = null, command = null, started = "null";
    // The idle process and the kernel's own can't be opened; neither runs a program.
    IntPtr process = pid > 4 ? OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) : IntPtr.Zero;
    if (process != IntPtr.Zero) {
      try {
        path = PathOf(process);
        command = CommandOf(process);
        long created, exited, kernel, user;
        if (GetProcessTimes(process, out created, out exited, out kernel, out user) && created > EPOCH)
          started = ((created - EPOCH) / 10000).ToString();
      } finally { CloseHandle(process); }
    }
    return "{\"pid\":" + pid + ",\"ppid\":" + ppid + ",\"image\":" + Quote(image) + ",\"path\":" + Quote(path)
      + ",\"commandLine\":" + Quote(command) + ",\"startedAt\":" + started + "}";
  }

  static string PathOf(IntPtr process) {
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
}
