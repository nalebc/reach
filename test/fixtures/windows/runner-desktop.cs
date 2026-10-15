using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// A GitHub runner's desktop, cleared before tests that put windows on it:
// a runner's own console (Windows Server 2022) is minimized, and a shell
// surface in front (Start, Search, a web-app panel on Windows 11 on Arm) is
// dismissed. Prints what it touched, by program file name only.
static class RunnerDesktop {
  delegate bool EnumWindowsProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc each, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder name, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref int length);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

  // Console windows already on the desktop before any test, minimized. Only
  // their programs' file names are printed, never a title or a path.
  static int Main() {
    var owners = new System.Collections.Generic.List<string>();
    EnumWindowsProc each = (window, data) => {
      var kind = new StringBuilder(256);
      GetClassNameW(window, kind, kind.Capacity);
      if (!IsWindowVisible(window) || kind.ToString() != "ConsoleWindowClass") return true;
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      string name = "?";
      IntPtr process = OpenProcess(0x1000, false, (int)pid);
      if (process != IntPtr.Zero) {
        var image = new StringBuilder(32768); int size = image.Capacity;
        if (QueryFullProcessImageNameW(process, 0, image, ref size)) name = System.IO.Path.GetFileName(image.ToString());
        CloseHandle(process);
      }
      ShowWindow(window, 6); // SW_MINIMIZE
      owners.Add("\"" + name.Replace("\\", "").Replace("\"", "") + "\"");
      return true;
    };
    EnumWindows(each, IntPtr.Zero);
    GC.KeepAlive(each);
    // A shell surface in front (Start, Search, a first-run panel on Windows
    // 11 client images) covers the screen; Escape dismisses it, as an owner would.
    var shell = new System.Collections.Generic.List<string>();
    uint escaped = 0;
    for (int i = 0; i < 8; i++) {
      IntPtr front = GetAncestor(GetForegroundWindow(), 2);
      var kind = new StringBuilder(256);
      GetClassNameW(front, kind, kind.Capacity);
      if (kind.ToString() != "Windows.UI.Core.CoreWindow") break;
      uint pid;
      GetWindowThreadProcessId(front, out pid);
      string name = "?";
      IntPtr process = OpenProcess(0x1000, false, (int)pid);
      if (process != IntPtr.Zero) {
        var image = new StringBuilder(32768); int size = image.Capacity;
        if (QueryFullProcessImageNameW(process, 0, image, ref size)) name = System.IO.Path.GetFileName(image.ToString());
        CloseHandle(process);
      }
      shell.Add("\"" + name.Replace("\\", "").Replace("\"", "") + "\"");
      if (escaped != pid) {
        // Each surface first gets an Escape, as an owner would press.
        escaped = pid;
        keybd_event(0x1B, 0, 0, UIntPtr.Zero);
        keybd_event(0x1B, 0, 2, UIntPtr.Zero); // KEYEVENTF_KEYUP
      } else if (string.Equals(name, "WWAHost.exe", StringComparison.OrdinalIgnoreCase)) {
        // A runner image's web-app panel (WWAHost) ignores Escape. It is no
        // owner's window on a disposable runner; end that one process.
        try { System.Diagnostics.Process.GetProcessById((int)pid).Kill(); } catch (Exception) { }
      } else break;
      Thread.Sleep(600);
    }
    IntPtr after = GetAncestor(GetForegroundWindow(), 2);
    var afterKind = new StringBuilder(256);
    GetClassNameW(after, afterKind, afterKind.Capacity);
    Console.WriteLine("{\"minimized\":[" + string.Join(",", owners.ToArray()) + "],\"dismissed\":[" + string.Join(",", shell.ToArray()) +
      "],\"frontClass\":\"" + afterKind.ToString().Replace("\"", "") + "\"}");
    return 0;
  }

}
