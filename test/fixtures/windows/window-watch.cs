// Every window Windows shows on this desktop, as it shows it, for the
// real-Windows test only (test/windows-quiet-background.test.mjs): whether
// anything a background Reach runs flashes a window up.
//
//   window-watch.exe <log> <stop file> [<pid>...]
//
// Writes one JSON line per event to <log>: first {"session":n} for itself
// and {"pid":p,"session":n} for each <pid> named, then for every top-level
// window that becomes visible {"shown":hwnd,"pid":p,"class":"…","title":"…",
// "at":ms}. A WinEvent hook (EVENT_OBJECT_SHOW, out of context) sees even a
// window that shows for a moment. Ends once <stop file> exists. C# 5;
// mscorlib only.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class WindowWatch {
  const uint EVENT_OBJECT_SHOW = 0x8002;
  const uint WINEVENT_OUTOFCONTEXT = 0;
  const int OBJID_WINDOW = 0;
  const uint GA_ROOT = 2;

  delegate void WinEventProc(IntPtr hook, uint kind, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

  [StructLayout(LayoutKind.Sequential)]
  struct MSG {
    public IntPtr hwnd;
    public uint message;
    public IntPtr wParam, lParam;
    public uint time;
    public int x, y;
  }

  [DllImport("user32.dll")]
  static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint process, uint thread, uint flags);
  [DllImport("user32.dll")]
  static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")]
  static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")]
  static extern UIntPtr SetTimer(IntPtr hwnd, UIntPtr id, uint ms, IntPtr proc);
  [DllImport("user32.dll")]
  static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")]
  static extern bool TranslateMessage(ref MSG msg);
  [DllImport("user32.dll")]
  static extern IntPtr DispatchMessage(ref MSG msg);
  [DllImport("kernel32.dll")]
  static extern bool ProcessIdToSessionId(uint pid, out uint session);
  [DllImport("kernel32.dll")]
  static extern uint GetCurrentProcessId();

  static string log;
  static readonly DateTime epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
  // Kept alive for as long as Windows may call it.
  static readonly WinEventProc proc = Shown;

  static string Quote(string text) {
    var quoted = new StringBuilder("\"");
    foreach (char c in text) {
      if (c == '"' || c == '\\') quoted.Append('\\').Append(c);
      else if (c < ' ') quoted.Append("\\u").Append(((int)c).ToString("x4"));
      else quoted.Append(c);
    }
    return quoted.Append('"').ToString();
  }

  static void Note(string line) {
    File.AppendAllText(log, line + "\n");
  }

  static string SessionOf(uint pid) {
    uint session;
    return ProcessIdToSessionId(pid, out session) ? session.ToString() : "null";
  }

  static void Shown(IntPtr hook, uint kind, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
    if (idObject != OBJID_WINDOW || idChild != 0 || hwnd == IntPtr.Zero) return;
    if (GetAncestor(hwnd, GA_ROOT) != hwnd || !IsWindowVisible(hwnd)) return;
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    var name = new StringBuilder(256);
    GetClassName(hwnd, name, name.Capacity);
    var title = new StringBuilder(512);
    GetWindowText(hwnd, title, title.Capacity);
    long at = (long)(DateTime.UtcNow - epoch).TotalMilliseconds;
    Note("{\"shown\":" + hwnd.ToInt64() + ",\"pid\":" + pid + ",\"class\":" + Quote(name.ToString()) + ",\"title\":" + Quote(title.ToString()) + ",\"at\":" + at + "}");
  }

  static int Main(string[] args) {
    if (args.Length < 2) return 2;
    log = args[0];
    string stop = args[1];
    Note("{\"session\":" + SessionOf(GetCurrentProcessId()) + "}");
    for (int i = 2; i < args.Length; i++) {
      uint pid;
      if (uint.TryParse(args[i], out pid)) Note("{\"pid\":" + pid + ",\"session\":" + SessionOf(pid) + "}");
    }
    IntPtr hook = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, IntPtr.Zero, proc, 0, 0, WINEVENT_OUTOFCONTEXT);
    if (hook == IntPtr.Zero) {
      Note("{\"error\":\"SetWinEventHook\"}");
      return 3;
    }
    Note("{\"watching\":true}");
    SetTimer(IntPtr.Zero, UIntPtr.Zero, 100, IntPtr.Zero);
    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
      if (File.Exists(stop)) break;
      TranslateMessage(ref msg);
      DispatchMessage(ref msg);
    }
    UnhookWinEvent(hook);
    return 0;
  }
}
