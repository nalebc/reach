using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// A GitHub runner's desktop, cleared before tests that put windows on it:
// a runner's own console (Windows Server 2022) is minimized, and a shell
// surface in front (Start, Search, a web-app panel on Windows 11 on Arm) is
// dismissed. Prints what it touched, by program file name only.
// `runner-desktop look [x y]` touches nothing: it lists the windows showing
// on the desktop (class, program file name, place; never a title), the one
// in front, and the one at a point.
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
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr window, uint message, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);

  // Dialogs a runner image opens by itself, at any time while tests run
  // (seen on validation runs, Oct 15): Windows' Performance Options
  // (SystemPropertiesPerformance.exe, Windows Server 2022 and Windows 11 on
  // Arm) and its "select an app" picker over a dimmed screen (PickerHost.exe,
  // Windows 11 on Arm). They came with and without any test before them, so
  // no test opens them. Each is closed as its own Close button would, which
  // changes no setting.
  static readonly string[] Foreign = { "SystemPropertiesPerformance.exe", "PickerHost.exe" };
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }

  static string Program(uint pid) {
    string name = "?";
    IntPtr process = OpenProcess(0x1000, false, (int)pid);
    if (process != IntPtr.Zero) {
      var image = new StringBuilder(32768); int size = image.Capacity;
      if (QueryFullProcessImageNameW(process, 0, image, ref size)) name = System.IO.Path.GetFileName(image.ToString());
      CloseHandle(process);
    }
    return name.Replace("\\", "").Replace("\"", "");
  }

  // One window as JSON: its class, program, pid and place. Never its title.
  static string Describe(IntPtr window) {
    if (window == IntPtr.Zero) return "null";
    var kind = new StringBuilder(256);
    GetClassNameW(window, kind, kind.Capacity);
    uint pid;
    GetWindowThreadProcessId(window, out pid);
    RECT r;
    GetWindowRect(window, out r);
    return "{\"class\":\"" + kind.ToString().Replace("\\", "").Replace("\"", "") + "\",\"program\":\"" + Program(pid) + "\",\"pid\":" + pid +
      ",\"rect\":[" + r.Left + "," + r.Top + "," + (r.Right - r.Left) + "," + (r.Bottom - r.Top) + "]}";
  }

  // What shows on the desktop now, front to back, and what is at a point.
  static int Look(string[] args) {
    var shown = new System.Collections.Generic.List<string>();
    EnumWindowsProc each = (window, data) => {
      int cloaked;
      if (!IsWindowVisible(window) || IsIconic(window)) return true;
      if (DwmGetWindowAttribute(window, 14, out cloaked, 4) == 0 && cloaked != 0) return true; // DWMWA_CLOAKED
      RECT r;
      if (!GetWindowRect(window, out r) || r.Right <= r.Left || r.Bottom <= r.Top) return true;
      shown.Add(Describe(window));
      return true;
    };
    EnumWindows(each, IntPtr.Zero);
    GC.KeepAlive(each);
    string at = "null";
    if (args.Length >= 3) {
      POINT p = new POINT { X = int.Parse(args[1]), Y = int.Parse(args[2]) };
      at = Describe(GetAncestor(WindowFromPoint(p), 2));
    }
    Console.WriteLine("{\"front\":" + Describe(GetAncestor(GetForegroundWindow(), 2)) + ",\"at\":" + at + ",\"shown\":[" + string.Join(",", shown.ToArray()) + "]}");
    return 0;
  }

  // Console windows already on the desktop before any test, minimized. Only
  // their programs' file names are printed, never a title or a path.
  static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "look") return Look(args);
    var owners = new System.Collections.Generic.List<string>();
    EnumWindowsProc each = (window, data) => {
      var kind = new StringBuilder(256);
      GetClassNameW(window, kind, kind.Capacity);
      // Classic consoles, and Windows Terminal's windows (the default terminal
      // on Windows 11): minimized, never closed (the runner may live in one).
      if (!IsWindowVisible(window) || (kind.ToString() != "ConsoleWindowClass" && kind.ToString() != "CASCADIA_HOSTING_WINDOW_CLASS")) return true;
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
    var closed = new System.Collections.Generic.List<string>();
    var closing = new System.Collections.Generic.List<IntPtr>();
    EnumWindowsProc foreign = (window, data) => {
      if (!IsWindowVisible(window)) return true;
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      string name = Program(pid);
      foreach (string known in Foreign)
        if (string.Equals(name, known, StringComparison.OrdinalIgnoreCase)) {
          PostMessageW(window, 0x0010, IntPtr.Zero, IntPtr.Zero); // WM_CLOSE
          closing.Add(window);
          closed.Add("\"" + name + "\"");
        }
      return true;
    };
    EnumWindows(foreign, IntPtr.Zero);
    GC.KeepAlive(foreign);
    for (int i = 0; i < 40 && closing.Exists(w => IsWindow(w) && IsWindowVisible(w)); i++) Thread.Sleep(50);
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
    Console.WriteLine("{\"minimized\":[" + string.Join(",", owners.ToArray()) + "],\"closed\":[" + string.Join(",", closed.ToArray()) + "],\"dismissed\":[" + string.Join(",", shell.ToArray()) +
      "],\"frontClass\":\"" + afterKind.ToString().Replace("\"", "") + "\"}");
    return 0;
  }

}
