// The PC's own terminals for the phone (server/desktop-terminals.mjs), as
// scripts/native/mac-terminals.js is the Mac's Terminal and iTerm2 tabs:
// classic console windows and Windows Terminal's tabs. C# 5, the language of
// the .NET Framework 4.x compiler (docs/WINDOWS_AGENT_PARITY.md, rule 3).
// One JSON request on stdin, one JSON line on stdout (ASCII only), then exit:
//   {"action":"list","exclude":<Reach's pid>}
//     {"sessions":[{"provider","target":{"window","pid","start"},"name","tty"}],
//      "running":{…},"installed":{…},"administrator":{…}}
//   {"action":"read"|"send"|"focus"|"close","provider","target",…}
//   {"action":"create","provider","cwd","terminal":<wt.exe's arguments>,
//    "console":{"file","line"}}
//   {"error":"…","status":N} when it can't.
// With the argument `watch` it stays, and says when consoles open, close or
// print, as scripts/native/terminal-watch.swift does on a Mac.
//
// A console is found by its window: a classic one's ConsoleWindowClass
// window, or the hidden PseudoConsoleWindow Windows Terminal's tabs have,
// owned by its window. Windows reports either as belonging to the console's
// first program (its root), so a console is the window, its root and the
// root's start: a pid Windows gives to a new process never matches. Its text,
// its typing and its programs come from attaching to it (AttachConsole), which
// only this process does: Reach's own console is never touched.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using Microsoft.Win32.SafeHandles;

static class Terminals {
  const string CONSOLE = "ConsoleWindowClass", PSEUDO = "PseudoConsoleWindow";
  const string TERMINAL_EXE = "WindowsTerminal.exe";
  const uint GENERIC_READ = 0x80000000, GENERIC_WRITE = 0x40000000, SHARE = 3, OPEN_EXISTING = 3;
  const uint PROCESS_TERMINATE = 0x1, PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint GA_ROOT = 2, GA_ROOTOWNER = 3, WM_CLOSE = 0x10;
  const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10, SWP_ASYNCWINDOWPOS = 0x4000;
  const int SW_RESTORE = 9, ERROR_ACCESS_DENIED = 5;
  const ushort KEY_EVENT = 1, VK_TAB = 0x09, VK_RETURN = 0x0D, VK_PACKET = 0xE7;
  const uint SHIFT_PRESSED = 0x10, CREATE_NEW_CONSOLE = 0x10;
  // The same limits Reach checks first (desktop-terminals.mjs).
  const int MAX_TEXT = 16000, MAX_READ = 128000, MAX_ROWS = 3000;

  [StructLayout(LayoutKind.Sequential)]
  struct COORD { public short X; public short Y; }
  [StructLayout(LayoutKind.Sequential)]
  struct SMALL_RECT { public short Left; public short Top; public short Right; public short Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  struct CONSOLE_SCREEN_BUFFER_INFO {
    public COORD Size;
    public COORD Cursor;
    public ushort Attributes;
    public SMALL_RECT Window;
    public COORD MaximumWindowSize;
  }
  // INPUT_RECORD holding a KEY_EVENT_RECORD, as Windows lays it out.
  [StructLayout(LayoutKind.Explicit, Size = 20)]
  struct INPUT_RECORD {
    [FieldOffset(0)] public ushort EventType;
    [FieldOffset(4)] public int KeyDown;
    [FieldOffset(8)] public ushort RepeatCount;
    [FieldOffset(10)] public ushort VirtualKeyCode;
    [FieldOffset(12)] public ushort VirtualScanCode;
    [FieldOffset(14)] public ushort UnicodeChar;
    [FieldOffset(16)] public uint ControlKeyState;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
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

  delegate bool EnumWindowsProc(IntPtr window, IntPtr data);
  delegate bool CtrlHandler(uint type);

  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetConsoleProcessList([Out] uint[] list, uint count);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetConsoleTitleW(StringBuilder title, uint size);
  [DllImport("kernel32.dll")] static extern bool SetConsoleCtrlHandler(CtrlHandler handler, bool add);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(SafeFileHandle output, out CONSOLE_SCREEN_BUFFER_INFO info);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool ReadConsoleOutputCharacterW(SafeFileHandle output, [Out] char[] text, uint length, COORD at, out uint read);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool WriteConsoleInputW(SafeFileHandle input, INPUT_RECORD[] records, uint count, out uint written);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string application, StringBuilder line, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string folder, ref STARTUPINFO start, out PROCESS_INFORMATION started);
  [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr window, int show);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
  [DllImport("user32.dll")] static extern bool PostMessageW(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern short VkKeyScanW(char key);
  [DllImport("user32.dll")] static extern uint MapVirtualKeyW(uint code, uint kind);

  // Attached to the owner's console, this process would be ended by a Ctrl+C
  // or Ctrl+Break typed there. Its own handler, never the "ignore" flag that
  // the terminals it opens would inherit.
  static readonly CtrlHandler keep = delegate (uint type) { return type == 0 || type == 1; };
  static readonly uint self = GetCurrentProcessId();

  static int Main(string[] args) {
    // Both pipes are taken before any console call: attaching to another
    // console never redirects what Reach reads.
    Stream input = Console.OpenStandardInput(), output = Console.OpenStandardOutput();
    SetConsoleCtrlHandler(keep, true);
    if (args.Length == 1 && args[0] == "watch") return Watch.Run(input, output);
    string said;
    try {
      string text;
      using (StreamReader reader = new StreamReader(input, new UTF8Encoding(false))) text = reader.ReadToEnd();
      Dictionary<string, object> request = Json.Parse(text) as Dictionary<string, object>;
      said = request == null ? Fail(400, "Reach asked something this helper doesn't know.") : Handle(request);
    } catch (FormatException) {
      said = Fail(400, "Reach asked something this helper doesn't know.");
    } catch (Exception) {
      said = Fail(502, "Windows couldn't complete this terminal action. Try again in a moment.");
    } finally {
      FreeConsole();
    }
    Write(output, said);
    return 0;
  }

  public static void Write(Stream output, string line) {
    byte[] bytes = Encoding.ASCII.GetBytes(line + "\n");
    output.Write(bytes, 0, bytes.Length);
    output.Flush();
  }

  static string Fail(int status, string error) {
    return "{\"error\":" + Json.Quote(error) + ",\"status\":" + status + "}";
  }
  const string GONE = "This terminal has closed. Refresh the list.";

  static string Handle(Dictionary<string, object> request) {
    // This helper's own (hidden) console goes first: one process attaches to
    // one console at a time.
    FreeConsole();
    string action = Json.Text(request, "action");
    if (action == "list") return List(request);
    string provider = Json.Text(request, "provider");
    if (provider != "windows-terminal" && provider != "console") return Fail(400, "Unknown terminal app.");
    if (action == "create") return Create(provider, request);
    if (action != "read" && action != "send" && action != "focus" && action != "close") return Fail(400, "Unknown terminal action.");
    Dictionary<string, object> target = request.ContainsKey("target") ? request["target"] as Dictionary<string, object> : null;
    IntPtr window;
    uint pid;
    if (target == null || !Same(target, provider, out window, out pid)) return Fail(404, GONE);
    if (action == "focus") return Focus(provider, window, pid);
    if (action == "close" && provider == "console") {
      // As its close button does: every program in it is told to close.
      PostMessageW(window, WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
      return "{\"ok\":true}";
    }
    string refused = Attach(pid, window);
    if (refused != null) return refused;
    try {
      if (action == "read") return Read(request.ContainsKey("scrollback") && true.Equals(request["scrollback"]));
      if (action == "send") return Send(request.ContainsKey("text") ? request["text"] as string : null);
      return CloseTab();
    } finally {
      FreeConsole();
    }
  }

  // ---- Finding consoles ----

  class Proc { public uint Parent; public string Exe; }
  static Dictionary<uint, Proc> Processes() {
    Dictionary<uint, Proc> all = new Dictionary<uint, Proc>();
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1) || snapshot == IntPtr.Zero) return all;
    try {
      PROCESSENTRY32W entry = new PROCESSENTRY32W();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
      if (Process32FirstW(snapshot, ref entry))
        do {
          Proc p = new Proc();
          p.Parent = entry.th32ParentProcessID;
          p.Exe = entry.szExeFile ?? "";
          all[entry.th32ProcessID] = p;
        } while (Process32NextW(snapshot, ref entry));
    } finally {
      CloseHandle(snapshot);
    }
    return all;
  }
  // A process's program file, or "" when Windows won't say.
  static string ImageOf(uint pid) {
    IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (process == IntPtr.Zero) return "";
    try {
      StringBuilder name = new StringBuilder(1024);
      uint size = (uint)name.Capacity;
      return QueryFullProcessImageNameW(process, 0, name, ref size) ? name.ToString(0, (int)size) : "";
    } finally {
      CloseHandle(process);
    }
  }
  // When a process started (FILETIME), or 0 when Windows won't say.
  static long Started(uint pid) {
    IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
    if (process == IntPtr.Zero) return 0;
    try {
      long created, exited, kernel, user;
      return GetProcessTimes(process, out created, out exited, out kernel, out user) ? created : 0;
    } finally {
      CloseHandle(process);
    }
  }
  // A shell Reach itself started (one of Reach's own terminals, listed as
  // Reach's already): Reach is its parent, and started before it, so a pid
  // Windows gave Reach's after it ended isn't. A window opened from inside one
  // (start cmd) is the PC's, as on a Mac.
  static bool StartedBy(uint pid, uint parent, Dictionary<uint, Proc> all) {
    Proc p;
    if (parent == 0 || !all.TryGetValue(pid, out p) || p.Parent != parent) return false;
    long started = Started(pid), parentStarted = Started(parent);
    return parentStarted != 0 && (started == 0 || parentStarted <= started);
  }
  static string ClassOf(IntPtr window) {
    StringBuilder name = new StringBuilder(256);
    return GetClassNameW(window, name, name.Capacity) > 0 ? name.ToString() : "";
  }
  static uint OwnerOf(IntPtr window) {
    uint pid;
    GetWindowThreadProcessId(window, out pid);
    return pid;
  }
  static bool IsTerminal(uint pid, Dictionary<uint, Proc> all) {
    Proc p;
    return all.TryGetValue(pid, out p) && string.Equals(p.Exe, TERMINAL_EXE, StringComparison.OrdinalIgnoreCase);
  }
  // The Windows Terminal window a tab's pseudo console belongs to: the one
  // Windows Terminal gives it as its owner (every tab since Windows Terminal
  // 1.14, defaults handed over included), else, for a shell Windows Terminal
  // started, one of its windows. Zero: not Windows Terminal's (Reach's own
  // terminals, VS Code's, another app's).
  static IntPtr TerminalWindow(IntPtr pseudo, uint root, Dictionary<uint, Proc> all) {
    IntPtr owner = GetAncestor(pseudo, GA_ROOTOWNER);
    if (owner != IntPtr.Zero && owner != pseudo) return IsTerminal(OwnerOf(owner), all) ? owner : IntPtr.Zero;
    Proc p;
    if (!all.TryGetValue(root, out p) || !IsTerminal(p.Parent, all)) return IntPtr.Zero;
    IntPtr found = IntPtr.Zero;
    uint terminal = p.Parent;
    EnumWindows(delegate (IntPtr window, IntPtr data) {
      if (found == IntPtr.Zero && IsWindowVisible(window) && OwnerOf(window) == terminal && GetAncestor(window, GA_ROOTOWNER) == window) found = window;
      return true;
    }, IntPtr.Zero);
    return found == IntPtr.Zero ? pseudo : found;
  }
  static List<IntPtr> ConsoleWindows() {
    List<IntPtr> found = new List<IntPtr>();
    EnumWindows(delegate (IntPtr window, IntPtr data) {
      string name = ClassOf(window);
      if (name == CONSOLE || name == PSEUDO) found.Add(window);
      return true;
    }, IntPtr.Zero);
    return found;
  }
  // The programs in the console this process is attached to, itself left out.
  static List<uint> Clients() {
    uint[] list = new uint[64];
    uint count = GetConsoleProcessList(list, (uint)list.Length);
    if (count > list.Length) {
      list = new uint[count + 16];
      count = GetConsoleProcessList(list, (uint)list.Length);
    }
    List<uint> clients = new List<uint>();
    for (int i = 0; i < count && i < list.Length; i++)
      if (list[i] != self) clients.Add(list[i]);
    return clients;
  }
  static string Title() {
    StringBuilder title = new StringBuilder(4096);
    return GetConsoleTitleW(title, (uint)title.Capacity) > 0 ? title.ToString() : "";
  }
  // Attached to the console `window` belongs to, through its root; null when
  // it worked.
  static string Attach(uint pid, IntPtr window) {
    FreeConsole();
    if (!AttachConsole(pid)) {
      int error = Marshal.GetLastWin32Error();
      return error == ERROR_ACCESS_DENIED && IsWindow(window)
        ? Fail(403, "Windows keeps Reach out of this terminal: it runs as administrator.")
        : Fail(404, GONE);
    }
    if (GetConsoleWindow() != window) {
      FreeConsole();
      return Fail(404, GONE);
    }
    return null;
  }

  static string List(Dictionary<string, object> request) {
    uint exclude = (uint)Json.Number(request, "exclude");
    Dictionary<uint, Proc> all = Processes();
    bool terminalRunning = false;
    foreach (Proc p in all.Values)
      if (string.Equals(p.Exe, TERMINAL_EXE, StringComparison.OrdinalIgnoreCase)) terminalRunning = true;
    List<string> sessions = new List<string>();
    // Consoles running as administrator: Windows keeps a normal program out
    // of them, so they're counted for the phone to say so, never listed.
    int[] administrator = new int[2];
    foreach (IntPtr window in ConsoleWindows()) {
      string kind = ClassOf(window);
      uint root = OwnerOf(window);
      if (root == 0 || root == self) continue;
      string provider;
      if (kind == CONSOLE) {
        // Hidden ones are programs' own (started hidden), not the owner's.
        if (!IsWindowVisible(window)) continue;
        provider = "console";
      } else {
        if (TerminalWindow(window, root, all) == IntPtr.Zero) continue;
        provider = "windows-terminal";
      }
      long started = Started(root);
      if (started == 0) continue;
      if (StartedBy(root, exclude, all)) continue;
      string title;
      FreeConsole();
      if (!AttachConsole(root)) {
        if (Marshal.GetLastWin32Error() == ERROR_ACCESS_DENIED) administrator[provider == "console" ? 1 : 0]++;
        continue;
      }
      try {
        if (GetConsoleWindow() != window || Clients().Count == 0) continue;
        title = Title();
      } finally {
        FreeConsole();
      }
      if (title.Length > 160) title = title.Substring(0, 160);
      string key = window.ToInt64().ToString(CultureInfo.InvariantCulture);
      sessions.Add("{\"provider\":" + Json.Quote(provider) + ",\"target\":{\"window\":" + Json.Quote(key) + ",\"pid\":" + root
        + ",\"start\":" + Json.Quote(started.ToString(CultureInfo.InvariantCulture)) + "},\"name\":" + Json.Quote(title) + ",\"tty\":" + Json.Quote(key) + "}");
    }
    return "{\"sessions\":[" + string.Join(",", sessions.ToArray()) + "],\"running\":{\"windows-terminal\":" + (terminalRunning ? "true" : "false")
      + ",\"console\":true},\"installed\":{\"windows-terminal\":" + (TerminalPath() != null ? "true" : "false") + ",\"console\":true}"
      + ",\"administrator\":{\"windows-terminal\":" + administrator[0] + ",\"console\":" + administrator[1] + "}}";
  }

  // The console a target names, still the same one: its window, of the
  // provider's kind, still belonging to the same root, started when it was.
  static bool Same(Dictionary<string, object> target, string provider, out IntPtr window, out uint pid) {
    window = IntPtr.Zero;
    pid = 0;
    long handle, started;
    string text = target.ContainsKey("window") ? target["window"] as string : null;
    string start = target.ContainsKey("start") ? target["start"] as string : null;
    if (text == null || start == null || text.Length > 20 || !long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out handle)
        || !long.TryParse(start, NumberStyles.None, CultureInfo.InvariantCulture, out started)) return false;
    double number = Json.Number(target, "pid");
    if (number <= 0 || number > uint.MaxValue || number != Math.Floor(number)) return false;
    window = new IntPtr(handle);
    pid = (uint)number;
    if (!IsWindow(window) || ClassOf(window) != (provider == "console" ? CONSOLE : PSEUDO)) return false;
    return OwnerOf(window) == pid && Started(pid) == started;
  }

  // ---- Reading, typing, focusing, closing ----

  static SafeFileHandle Open(string name) {
    return CreateFileW(name, GENERIC_READ | GENERIC_WRITE, SHARE, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
  }
  // Its screen, or with `scrollback` what scrolled away above it too (a
  // Windows Terminal tab keeps that itself: its console holds the screen).
  // Rows read one at a time, so a wide character counts once.
  static string Read(bool scrollback) {
    using (SafeFileHandle screen = Open("CONOUT$")) {
      CONSOLE_SCREEN_BUFFER_INFO info;
      if (screen.IsInvalid || !GetConsoleScreenBufferInfo(screen, out info)) return Fail(502, "Windows couldn't read this terminal.");
      int width = Math.Max(1, (int)info.Size.X);
      int last = Math.Min(info.Size.Y - 1, Math.Max(info.Window.Bottom, info.Cursor.Y));
      int first = scrollback ? Math.Max(0, last - MAX_ROWS + 1) : Math.Max(0, (int)info.Window.Top);
      char[] row = new char[width];
      List<string> lines = new List<string>();
      for (int y = first; y <= last; y++) {
        COORD at;
        at.X = 0;
        at.Y = (short)y;
        uint read;
        if (!ReadConsoleOutputCharacterW(screen, row, (uint)width, at, out read)) break;
        lines.Add(new string(row, 0, (int)Math.Min(read, (uint)width)).TrimEnd(' ', '\0'));
      }
      while (lines.Count > 0 && lines[lines.Count - 1].Length == 0) lines.RemoveAt(lines.Count - 1);
      string text = string.Join("\n", lines.ToArray());
      if (text.Length > MAX_READ) text = text.Substring(text.Length - MAX_READ);
      return "{\"text\":" + Json.Quote(text) + "}";
    }
  }
  // Each character as a key press and release, then Enter: what typing it
  // there does, without the window coming forward.
  static void Key(List<INPUT_RECORD> keys, char c, ushort virtualKey, uint state) {
    INPUT_RECORD key = new INPUT_RECORD();
    key.EventType = KEY_EVENT;
    key.KeyDown = 1;
    key.RepeatCount = 1;
    key.VirtualKeyCode = virtualKey;
    key.VirtualScanCode = virtualKey == VK_PACKET ? (ushort)0 : (ushort)MapVirtualKeyW(virtualKey, 0);
    key.UnicodeChar = c;
    key.ControlKeyState = state;
    keys.Add(key);
    key.KeyDown = 0;
    keys.Add(key);
  }
  // The same text a Mac takes: no control codes but Tab and line ends, which
  // are their keys here as there (a line end is Enter).
  static string Send(string text) {
    if (text == null || text.Length > MAX_TEXT) return Fail(400, "Send up to 16,000 characters of text, without control codes.");
    foreach (char c in text)
      if ((c < 0x20 && c != '\t' && c != '\n' && c != '\r') || c == 0x7f) return Fail(400, "Send up to 16,000 characters of text, without control codes.");
    List<INPUT_RECORD> keys = new List<INPUT_RECORD>();
    for (int i = 0; i < text.Length; i++) {
      char c = text[i];
      if (c == '\r' || c == '\n') {
        if (c == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
        Key(keys, '\r', VK_RETURN, 0);
        continue;
      }
      if (c == '\t') {
        Key(keys, '\t', VK_TAB, 0);
        continue;
      }
      short scan = VkKeyScanW(c);
      // A character this keyboard has: its key, with Shift when it needs it
      // (never Ctrl or Alt, which programs read as shortcuts). Anything else
      // as Windows types Unicode.
      if (scan == -1 || (scan & 0xff) == 0xff) Key(keys, c, VK_PACKET, 0);
      else Key(keys, c, (ushort)(scan & 0xff), (scan & 0x100) != 0 ? SHIFT_PRESSED : 0);
    }
    Key(keys, '\r', VK_RETURN, 0);
    using (SafeFileHandle input = Open("CONIN$")) {
      if (input.IsInvalid) return Fail(502, "Windows couldn't type into this terminal.");
      INPUT_RECORD[] all = keys.ToArray();
      for (int at = 0; at < all.Length; at += 512) {
        INPUT_RECORD[] part = new INPUT_RECORD[Math.Min(512, all.Length - at)];
        Array.Copy(all, at, part, 0, part.Length);
        uint written;
        if (!WriteConsoleInputW(input, part, (uint)part.Length, out written) || written != part.Length)
          return Fail(502, "Windows couldn't type into this terminal.");
      }
    }
    return "{\"ok\":true}";
  }
  // A Windows Terminal tab: every program in it ends, as when they finish,
  // so Windows Terminal closes just that tab or pane, never its other tabs
  // and never with a question left on the PC. Programs it started that left
  // it (a window opened from it) go on, as when a tab is closed there.
  static string CloseTab() {
    List<uint> clients = Clients();
    FreeConsole();
    // Reach's watch (this same helper) may be looking at the tab just now.
    string helper = ImageOf(self);
    clients.RemoveAll(delegate (uint pid) { return helper.Length > 0 && string.Equals(ImageOf(pid), helper, StringComparison.OrdinalIgnoreCase); });
    int ended = 0;
    // Newest first, the root last: Windows Terminal reads how the tab ended
    // from the root.
    for (int i = 0; i < clients.Count; i++) {
      IntPtr process = OpenProcess(PROCESS_TERMINATE, false, clients[i]);
      if (process == IntPtr.Zero) continue;
      try {
        if (TerminateProcess(process, 0)) ended++;
      } finally {
        CloseHandle(process);
      }
    }
    return ended > 0 || clients.Count == 0 ? "{\"ok\":true}" : Fail(403, "Windows wouldn't end the programs in this tab.");
  }
  // Brought forward as docs/parity/B-desktop-helper.md §6 does: raised, then
  // asked once; `front` says whether Windows let it come forward (it often
  // keeps a background program from taking the foreground).
  static string Focus(string provider, IntPtr window, uint pid) {
    IntPtr frame = window;
    string chosen = "";
    if (provider == "windows-terminal") {
      frame = TerminalWindow(window, pid, Processes());
      if (frame == IntPtr.Zero || frame == window) return "{\"ok\":true,\"front\":false}";
      // Its tab chosen first, by its title, when only one tab has it.
      string title = null;
      if (Attach(pid, window) == null)
        try {
          title = Title();
        } finally {
          FreeConsole();
        }
      // `tab`: whether its tab was chosen (Windows Terminal shows one tab).
      chosen = ",\"tab\":" + (SelectTab(frame, title) ? "true" : "false");
    }
    if (IsIconic(frame)) ShowWindowAsync(frame, SW_RESTORE);
    SetWindowPos(frame, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
    SetForegroundWindow(frame);
    bool front = false;
    for (int i = 0; i < 15 && !front; i++) {
      front = GetAncestor(GetForegroundWindow(), GA_ROOT) == frame;
      if (!front) Thread.Sleep(100);
    }
    return "{\"ok\":true,\"front\":" + (front ? "true" : "false") + chosen + "}";
  }
  // Text with its spaces as one: titles differ in them ("Administrator:  ").
  static string Spaced(string text) {
    return string.Join(" ", (text ?? "").Split(new char[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries));
  }
  static bool SelectTab(IntPtr frame, string title) {
    if (string.IsNullOrEmpty(title)) return false;
    try {
      AutomationElementCollection tabs = AutomationElement.FromHandle(frame).FindAll(TreeScope.Descendants,
        new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem));
      // Its name is the tab's title: the console's, unless Windows Terminal
      // puts something before it ("Administrator: " for an elevated one, in
      // the PC's language). Exact first, else the one tab ending with it.
      string wanted = Spaced(title);
      AutomationElement match = null, ending = null;
      int matches = 0, endings = 0;
      foreach (AutomationElement tab in tabs) {
        string name = Spaced(tab.Current.Name);
        if (name.Length == 0) continue;
        if (name == wanted) {
          match = tab;
          matches++;
        } else if (name.EndsWith(" " + wanted, StringComparison.Ordinal) || wanted.EndsWith(" " + name, StringComparison.Ordinal)) {
          ending = tab;
          endings++;
        }
      }
      if (matches == 0 && endings == 1) {
        match = ending;
        matches = 1;
      }
      if (matches != 1) return false;
      object pattern;
      if (match.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern)) {
        ((SelectionItemPattern)pattern).Select();
        return true;
      }
      if (match.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) {
        ((InvokePattern)pattern).Invoke();
        return true;
      }
    } catch (Exception) {
      // Windows Terminal busy or changed: the window still comes forward.
    }
    return false;
  }

  // ---- Opening a new one ----

  // Windows Terminal's wt.exe: its App Execution Alias, else on PATH (an
  // install without the Store).
  public static string TerminalPath() {
    string local = Environment.GetEnvironmentVariable("LOCALAPPDATA");
    if (!string.IsNullOrEmpty(local)) {
      string alias = Path.Combine(local, "Microsoft", "WindowsApps", "wt.exe");
      if (File.Exists(alias)) return alias;
    }
    foreach (string entry in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
      string dir = entry.Trim().Trim('"');
      if (dir.Length == 0) continue;
      try {
        if (!Path.IsPathRooted(dir)) continue;
        string file = Path.Combine(dir, "wt.exe");
        if (File.Exists(file)) return file;
      } catch (ArgumentException) {
      }
    }
    return null;
  }
  // As a program's name begins a Windows command line.
  static string Program(string file) {
    return file.IndexOf(' ') >= 0 || file.IndexOf('\t') >= 0 ? "\"" + file + "\"" : file;
  }
  // Windows Terminal when it's installed (a new window, in the folder), else
  // a console window: the command lines are Reach's (desktop-terminals.mjs),
  // so this helper only starts them, with nothing of its own handed on.
  static string Create(string provider, Dictionary<string, object> request) {
    string folder = Json.Text(request, "cwd");
    if (folder == null || !Path.IsPathRooted(folder) || !Directory.Exists(folder)) return Fail(400, "Choose a folder on this PC.");
    string terminal = provider == "windows-terminal" ? TerminalPath() : null;
    string arguments = Json.Text(request, "terminal");
    Dictionary<string, object> console = request.ContainsKey("console") ? request["console"] as Dictionary<string, object> : null;
    string file, line;
    bool newConsole;
    if (terminal != null && arguments != null) {
      file = terminal;
      line = Program(terminal) + " " + arguments;
      newConsole = false;
    } else {
      file = console == null ? null : Json.Text(console, "file");
      line = console == null ? null : Json.Text(console, "line");
      if (file == null || line == null || !Path.IsPathRooted(file) || !File.Exists(file)) return Fail(503, "Reach couldn't find a shell to open on this PC.");
      newConsole = true;
      provider = "console";
    }
    STARTUPINFO start = new STARTUPINFO();
    start.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION started;
    if (!CreateProcessW(file, new StringBuilder(line, line.Length + 1), IntPtr.Zero, IntPtr.Zero, false, newConsole ? CREATE_NEW_CONSOLE : 0, IntPtr.Zero, folder, ref start, out started))
      return Fail(502, "Windows couldn't open a terminal (error " + Marshal.GetLastWin32Error() + ").");
    CloseHandle(started.hThread);
    CloseHandle(started.hProcess);
    return "{\"ok\":true,\"provider\":" + Json.Quote(provider) + "}";
  }

  // ---- Watching (`watch`) ----

  // Tells Reach when the PC's consoles change, as terminal-watch.swift does
  // on a Mac: a console window appearing ("opened") or going ("closed"), and
  // output ("output" with its tty, at most every 50 ms each). Classic windows
  // say when they print (console WinEvents); a Windows Terminal tab's console
  // doesn't, so a listed one is looked at once a second while Reach watches
  // (a phone is connected), and only a change is told. Reach sends
  // {"ttys":[…]} with the consoles it lists ("watching" confirms).
  static class Watch {
    const uint EVENT_OBJECT_CREATE = 0x8000, EVENT_OBJECT_DESTROY = 0x8001, EVENT_OBJECT_SHOW = 0x8002, EVENT_OBJECT_HIDE = 0x8003;
    const uint EVENT_OBJECT_NAMECHANGE = 0x800C, EVENT_CONSOLE_CARET = 0x4001, EVENT_CONSOLE_END_APPLICATION = 0x4007;
    const uint WINEVENT_SKIPOWNPROCESS = 2;
    const string TERMINAL_CLASS = "CASCADIA_HOSTING_WINDOW_CLASS";

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
    delegate void WinEventProc(IntPtr hook, uint type, IntPtr window, int item, int child, uint thread, uint time);
    [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc callback, uint pid, uint thread, uint flags);
    [DllImport("user32.dll")] static extern int GetMessageW(out MSG message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG message);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG message);

    static readonly object gate = new object();
    static Stream output;
    static readonly HashSet<long> watched = new HashSet<long>(), known = new HashSet<long>();
    static readonly Dictionary<long, int> lastOutput = new Dictionary<long, int>();
    static readonly HashSet<long> pending = new HashSet<long>();
    static readonly Dictionary<long, string> screens = new Dictionary<long, string>();
    static WinEventProc callback;
    static Timer flushing, looking;
    static int busy;

    public static int Run(Stream input, Stream stdout) {
      output = stdout;
      FreeConsole();
      foreach (IntPtr window in ConsoleWindows()) known.Add(window.ToInt64());
      callback = Event;
      SetWinEventHook(EVENT_OBJECT_CREATE, EVENT_OBJECT_HIDE, IntPtr.Zero, callback, 0, 0, WINEVENT_SKIPOWNPROCESS);
      SetWinEventHook(EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_NAMECHANGE, IntPtr.Zero, callback, 0, 0, WINEVENT_SKIPOWNPROCESS);
      SetWinEventHook(EVENT_CONSOLE_CARET, EVENT_CONSOLE_END_APPLICATION, IntPtr.Zero, callback, 0, 0, WINEVENT_SKIPOWNPROCESS);
      flushing = new Timer(Flush, null, 50, 50);
      looking = new Timer(Look, null, 1000, 1000);
      // Commands from Reach; it closing stdin means Reach is gone.
      Thread reader = new Thread(delegate () {
        try {
          using (StreamReader lines = new StreamReader(input, new UTF8Encoding(false))) {
            string line;
            while ((line = lines.ReadLine()) != null) Command(line);
          }
        } catch (Exception) {
        }
        Environment.Exit(0);
      });
      reader.IsBackground = true;
      reader.Start();
      Emit("{\"type\":\"ready\"}");
      MSG message;
      while (GetMessageW(out message, IntPtr.Zero, 0, 0) > 0) {
        TranslateMessage(ref message);
        DispatchMessageW(ref message);
      }
      return 0;
    }
    static void Emit(string line) {
      lock (gate) {
        try {
          Write(output, line);
        } catch (Exception) {
          Environment.Exit(0);
        }
      }
    }
    static void Command(string line) {
      Dictionary<string, object> command;
      try {
        command = Json.Parse(line) as Dictionary<string, object>;
      } catch (FormatException) {
        return;
      }
      List<object> ttys = command != null && command.ContainsKey("ttys") ? command["ttys"] as List<object> : null;
      if (ttys == null) return;
      int count;
      lock (gate) {
        watched.Clear();
        foreach (object tty in ttys) {
          long key;
          string text = tty as string;
          if (text != null && text.Length <= 20 && long.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out key)) {
            watched.Add(key);
            known.Add(key);
          }
        }
        foreach (long key in new List<long>(screens.Keys))
          if (!watched.Contains(key)) screens.Remove(key);
        count = watched.Count;
      }
      Emit("{\"type\":\"watching\",\"ttys\":" + count + "}");
    }
    static void Event(IntPtr hook, uint type, IntPtr window, int item, int child, uint thread, uint time) {
      if (window == IntPtr.Zero) return;
      long key = window.ToInt64();
      if (type >= EVENT_CONSOLE_CARET && type <= EVENT_CONSOLE_END_APPLICATION) {
        bool watching;
        lock (gate) watching = watched.Contains(key);
        if (watching) Output(key);
        return;
      }
      // The window itself, not something in it.
      if (item != 0 || child != 0) return;
      if (type == EVENT_OBJECT_CREATE || type == EVENT_OBJECT_SHOW) {
        string name = ClassOf(window);
        if (name != CONSOLE && name != PSEUDO) return;
        lock (gate) known.Add(key);
        Emit("{\"type\":\"opened\"}");
      } else if (type == EVENT_OBJECT_DESTROY || type == EVENT_OBJECT_HIDE) {
        bool ours;
        lock (gate) ours = type == EVENT_OBJECT_DESTROY ? known.Remove(key) : known.Contains(key);
        if (ours) Emit("{\"type\":\"closed\"}");
      } else if (type == EVENT_OBJECT_NAMECHANGE) {
        // A console's title, or Windows Terminal's (its tab's) changing.
        List<long> renamed = new List<long>();
        lock (gate) {
          if (watched.Contains(key)) renamed.Add(key);
          else if (ClassOf(window) == TERMINAL_CLASS)
            foreach (long tab in watched)
              if (GetAncestor(new IntPtr(tab), GA_ROOTOWNER) == window) renamed.Add(tab);
        }
        foreach (long tab in renamed) Output(tab);
      }
    }
    // At most one "output" per console every 50 ms, and one after a burst.
    static void Output(long key) {
      bool now = false;
      lock (gate) {
        int last;
        if (!lastOutput.TryGetValue(key, out last) || unchecked(Environment.TickCount - last) >= 50) {
          lastOutput[key] = Environment.TickCount;
          now = true;
        } else pending.Add(key);
      }
      if (now) Emit("{\"type\":\"output\",\"tty\":" + Json.Quote(key.ToString(CultureInfo.InvariantCulture)) + "}");
    }
    static void Flush(object state) {
      List<long> due = new List<long>();
      lock (gate) {
        foreach (long key in pending) {
          int last;
          if (!lastOutput.TryGetValue(key, out last) || unchecked(Environment.TickCount - last) >= 50) due.Add(key);
        }
        foreach (long key in due) pending.Remove(key);
      }
      foreach (long key in due) Output(key);
    }
    // Each listed Windows Terminal tab's title, cursor and screen, compared
    // with the last look.
    static void Look(object state) {
      if (Interlocked.Exchange(ref busy, 1) == 1) return;
      try {
        List<long> tabs = new List<long>();
        lock (gate) tabs.AddRange(watched);
        foreach (long key in tabs) {
          IntPtr window = new IntPtr(key);
          if (ClassOf(window) != PSEUDO) continue;
          string seen = Screen(window);
          if (seen == null) continue;
          bool changed;
          lock (gate) {
            string before;
            changed = screens.TryGetValue(key, out before) && before != seen;
            if (watched.Contains(key)) screens[key] = seen;
          }
          if (changed) Output(key);
        }
      } finally {
        Interlocked.Exchange(ref busy, 0);
      }
    }
    static string Screen(IntPtr window) {
      uint pid = OwnerOf(window);
      if (pid == 0 || pid == self) return null;
      FreeConsole();
      if (!AttachConsole(pid)) return null;
      try {
        if (GetConsoleWindow() != window) return null;
        using (SafeFileHandle screen = Open("CONOUT$")) {
          CONSOLE_SCREEN_BUFFER_INFO info;
          if (screen.IsInvalid || !GetConsoleScreenBufferInfo(screen, out info)) return null;
          int width = Math.Max(1, (int)info.Size.X);
          StringBuilder seen = new StringBuilder(Title()).Append('\n').Append(info.Cursor.X).Append(',').Append(info.Cursor.Y).Append('\n');
          char[] row = new char[width];
          for (int y = Math.Max(0, (int)info.Window.Top); y <= info.Window.Bottom && y < info.Size.Y; y++) {
            COORD at;
            at.X = 0;
            at.Y = (short)y;
            uint read;
            if (!ReadConsoleOutputCharacterW(screen, row, (uint)width, at, out read)) break;
            seen.Append(row, 0, (int)Math.Min(read, (uint)width)).Append('\n');
          }
          return seen.ToString();
        }
      } finally {
        FreeConsole();
      }
    }
  }
}

// Just enough JSON for Reach's requests: objects, arrays, strings, numbers,
// true, false and null. Answers are written in ASCII.
static class Json {
  public static object Parse(string text) {
    int at = 0;
    object value = Value(text, ref at);
    Space(text, ref at);
    if (at != text.Length) throw new FormatException();
    return value;
  }
  public static string Text(Dictionary<string, object> map, string key) {
    object value;
    return map.TryGetValue(key, out value) ? value as string : null;
  }
  public static double Number(Dictionary<string, object> map, string key) {
    object value;
    return map.TryGetValue(key, out value) && value is double ? (double)value : 0;
  }
  public static string Quote(string text) {
    if (text == null) return "null";
    StringBuilder b = new StringBuilder("\"");
    foreach (char c in text) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c == '\n') b.Append("\\n");
      else if (c < 0x20 || c > 0x7e) b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
  static void Space(string s, ref int at) {
    while (at < s.Length && (s[at] == ' ' || s[at] == '\t' || s[at] == '\n' || s[at] == '\r')) at++;
  }
  static void Expect(string s, ref int at, char c) {
    if (at >= s.Length || s[at] != c) throw new FormatException();
    at++;
  }
  static object Value(string s, ref int at) {
    Space(s, ref at);
    if (at >= s.Length) throw new FormatException();
    char c = s[at];
    if (c == '{') {
      at++;
      Dictionary<string, object> map = new Dictionary<string, object>();
      Space(s, ref at);
      if (at < s.Length && s[at] == '}') {
        at++;
        return map;
      }
      for (;;) {
        Space(s, ref at);
        string key = String(s, ref at);
        Space(s, ref at);
        Expect(s, ref at, ':');
        map[key] = Value(s, ref at);
        Space(s, ref at);
        if (at < s.Length && s[at] == ',') {
          at++;
          continue;
        }
        Expect(s, ref at, '}');
        return map;
      }
    }
    if (c == '[') {
      at++;
      List<object> list = new List<object>();
      Space(s, ref at);
      if (at < s.Length && s[at] == ']') {
        at++;
        return list;
      }
      for (;;) {
        list.Add(Value(s, ref at));
        Space(s, ref at);
        if (at < s.Length && s[at] == ',') {
          at++;
          continue;
        }
        Expect(s, ref at, ']');
        return list;
      }
    }
    if (c == '"') return String(s, ref at);
    if (Word(s, ref at, "true")) return true;
    if (Word(s, ref at, "false")) return false;
    if (Word(s, ref at, "null")) return null;
    int start = at;
    while (at < s.Length && "+-0123456789.eE".IndexOf(s[at]) >= 0) at++;
    double number;
    if (start == at || !double.TryParse(s.Substring(start, at - start), NumberStyles.Float, CultureInfo.InvariantCulture, out number))
      throw new FormatException();
    return number;
  }
  static bool Word(string s, ref int at, string word) {
    if (string.CompareOrdinal(s, at, word, 0, word.Length) != 0) return false;
    at += word.Length;
    return true;
  }
  static string String(string s, ref int at) {
    Expect(s, ref at, '"');
    StringBuilder b = new StringBuilder();
    while (at < s.Length) {
      char c = s[at++];
      if (c == '"') return b.ToString();
      if (c != '\\') {
        b.Append(c);
        continue;
      }
      if (at >= s.Length) break;
      char e = s[at++];
      switch (e) {
        case '"': b.Append('"'); break;
        case '\\': b.Append('\\'); break;
        case '/': b.Append('/'); break;
        case 'b': b.Append('\b'); break;
        case 'f': b.Append('\f'); break;
        case 'n': b.Append('\n'); break;
        case 'r': b.Append('\r'); break;
        case 't': b.Append('\t'); break;
        case 'u':
          int code;
          if (at + 4 > s.Length || !int.TryParse(s.Substring(at, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code))
            throw new FormatException();
          b.Append((char)code);
          at += 4;
          break;
        default: throw new FormatException();
      }
    }
    throw new FormatException();
  }
}
