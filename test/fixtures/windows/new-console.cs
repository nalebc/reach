// A live child of the Reach stand-in which creates a desktop console with
// the same CREATE_NEW_CONSOLE flag as Reach's native terminal launcher.
// Node's spawn does not guarantee a new visible console on a reused desktop.
// Name the Node stand-in as the direct parent, as its own spawn would do.
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

static class NewConsole {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string reserved, desktop, title;
    public int x, y, width, height, columns, rows, fill, flags;
    public short show, reservedSize;
    public IntPtr reservedBytes, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr process, thread;
    public int pid, threadId;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFOEX { public STARTUPINFO startup; public IntPtr attributes; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string file, StringBuilder line,
    IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags,
    IntPtr environment, string folder, ref STARTUPINFOEX start, out PROCESS_INFORMATION child);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr kind,
    IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")]
  static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll")]
  static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")]
  static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassNameW(IntPtr window, StringBuilder name, int length);
  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")]
  static extern IntPtr GetAncestor(IntPtr window, uint flags);
  static int Probe(string pid) {
    var output = Console.Out;
    uint value;
    if (!uint.TryParse(pid, out value)) return 2;
    FreeConsole();
    if (!AttachConsole(value)) {
      output.WriteLine("{\"attachError\":" + Marshal.GetLastWin32Error() + "}");
      return 0;
    }
    var window = GetConsoleWindow();
    var owner = GetAncestor(window, 3);
    var name = new StringBuilder(256);
    GetClassNameW(window, name, name.Capacity);
    uint rootPid, ownerPid;
    GetWindowThreadProcessId(window, out rootPid);
    GetWindowThreadProcessId(owner, out ownerPid);
    FreeConsole();
    output.WriteLine("{\"window\":\"" + window.ToInt64() + "\",\"class\":\"" + name +
      "\",\"visible\":" + (IsWindowVisible(window) ? "true" : "false") +
      ",\"rootPid\":" + rootPid + ",\"ownerPid\":" + ownerPid + "}");
    return 0;
  }

  static int Main(string[] args) {
    if (args.Length == 2 && args[0] == "--probe") return Probe(args[1]);
    uint parentPid;
    if (args.Length != 3 || args[0].Contains("\"") || !uint.TryParse(args[2], out parentPid) ||
        !Regex.IsMatch(args[1], "^reach-shell-[a-f0-9]{8}$")) return 2;
    var output = Console.Out; // Retain the output pipe before FreeConsole.
    var start = new STARTUPINFOEX();
    start.startup.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
    start.startup.flags = 1; start.startup.show = 1; // STARTF_USESHOWWINDOW, SW_SHOWNORMAL
    PROCESS_INFORMATION child;
    var line = new StringBuilder("\"" + args[0] + "\" /d /c title " + args[1] +
      "& ping -n 300 127.0.0.1 >nul");
    IntPtr parent = OpenProcess(0x80, false, parentPid); // PROCESS_CREATE_PROCESS
    if (parent == IntPtr.Zero) return 3;
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr attributes = Marshal.AllocHGlobal(size), value = Marshal.AllocHGlobal(IntPtr.Size);
    bool initialized = false;
    try {
      initialized = InitializeProcThreadAttributeList(attributes, 1, 0, ref size);
      if (!initialized) return 3;
      Marshal.WriteIntPtr(value, parent);
      if (!UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20000), value,
          new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) return 3;
      start.attributes = attributes;
      FreeConsole();
      if (!CreateProcessW(args[0], line, IntPtr.Zero, IntPtr.Zero, false, 0x80010,
          IntPtr.Zero, null, ref start, out child)) return 3;
    } finally {
      if (initialized) DeleteProcThreadAttributeList(attributes);
      Marshal.FreeHGlobal(attributes); Marshal.FreeHGlobal(value); CloseHandle(parent);
    }
    CloseHandle(child.thread);
    try {
      output.WriteLine(child.pid);
      output.Flush();
      return WaitForSingleObject(child.process, 360000) == 0 ? 0 : 4;
    } finally { CloseHandle(child.process); }
  }
}
