// A live child of the Reach stand-in which creates a desktop console with
// the same CREATE_NEW_CONSOLE flag as Reach's native terminal launcher.
// Node's spawn does not guarantee a new visible console on a reused desktop.
// Keep this parent alive so the helper can verify the whole ancestor chain.
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
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string file, StringBuilder line,
    IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags,
    IntPtr environment, string folder, ref STARTUPINFO start, out PROCESS_INFORMATION child);
  [DllImport("kernel32.dll")]
  static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  static int Main(string[] args) {
    if (args.Length != 2 || args[0].Contains("\"") ||
        !Regex.IsMatch(args[1], "^reach-shell-[a-f0-9]{8}$")) return 2;
    var start = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)) };
    PROCESS_INFORMATION child;
    var line = new StringBuilder("\"" + args[0] + "\" /d /c title " + args[1] +
      "& ping -n 300 127.0.0.1 >nul");
    if (!CreateProcessW(args[0], line, IntPtr.Zero, IntPtr.Zero, false, 0x10,
        IntPtr.Zero, null, ref start, out child)) return 3;
    CloseHandle(child.thread);
    try {
      Console.WriteLine(child.pid);
      Console.Out.Flush();
      return WaitForSingleObject(child.process, 360000) == 0 ? 0 : 4;
    } finally { CloseHandle(child.process); }
  }
}
