// Windows for the agent helper's real-Windows tests
// (test/windows-agent-desktop-native.test.mjs, docs/parity/B-desktop-helper.md
// §13.4): each kind is one program run, compiled by the test with the PC's
// csc.exe. C# 5; System, System.Drawing, System.Windows.Forms.
//
//   window <dir> <name> <title> <rrggbb> <x> <y> <width> <height> [topmost] [tool] [popup]
//       A window of one colour with a text box, a password box, a button, a
//       menu and a long list. Writes <dir>\<name>.json once shown (its handle,
//       process, frame and its controls' centres) and appends what reaches it
//       to <dir>\<name>.log, one line each (click, double, right, key <vk>,
//       text <value>, menu).
//   sleeper <dir> <name> <console title>
//       Stays alive in its console (a stand-in for Reach), titled; writes
//       <dir>\<name>.json with its process and its console window.
//   pixels <jpeg> <x>,<y> ...
//       Prints each pixel of a JPEG as "r,g,b", one line each.
//   frame <window handle>
//       Prints the window's frame as "x,y,width,height".
//   medium <program> [arguments...]
//       Runs a program at medium integrity (a restricted copy of this
//       process's token: no administrators' rights) with this process's
//       standard handles, and exits with its code. GitHub's runners run
//       everything elevated; Reach on a PC doesn't.
//   click <x> <y>
//       A real left click there (brings that window to the front).
//   buttons
//       Prints "left down" or "left up": the left button's state now.
//   clipboard-watch <dir> <name>
//       Appends, on every clipboard change, "formats <names> | text <text>"
//       (or "| empty") to <dir>\<name>.log.
//   clipboard-set <text> | clipboard-get | clipboard-clear
//       Sets the clipboard's text, prints it (or "(none)"), or empties it.
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class DesktopFixture {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll", SetLastError = true)] static extern bool AddClipboardFormatListener(IntPtr window);
  [DllImport("user32.dll")] static extern uint EnumClipboardFormats(uint format);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClipboardFormatNameW(uint format, StringBuilder name, int max);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableCount, SID_AND_ATTRIBUTES[] disable, uint deleteCount, IntPtr delete, uint restrictCount, IntPtr restrict, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int kind, IntPtr info, int size);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSidW(string sid, out IntPtr result);
  [DllImport("advapi32.dll")] static extern int GetLengthSid(IntPtr sid);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags,
    IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION information);
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [STAThread]
  static int Main(string[] args) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
    if (args.Length >= 9 && args[0] == "window") return Window(args);
    if (args.Length == 4 && args[0] == "sleeper") return Sleeper(args[1], args[2], args[3]);
    if (args.Length >= 3 && args[0] == "pixels") return Pixels(args);
    if (args.Length == 2 && args[0] == "frame") {
      RECT rect;
      if (!GetWindowRect(new IntPtr(long.Parse(args[1])), out rect)) return 1;
      Console.WriteLine(rect.Left + "," + rect.Top + "," + (rect.Right - rect.Left) + "," + (rect.Bottom - rect.Top));
      return 0;
    }
    if (args.Length >= 2 && args[0] == "medium") return Medium(args);
    if (args.Length == 3 && args[0] == "click") return Click(int.Parse(args[1]), int.Parse(args[2]));
    if (args.Length == 1 && args[0] == "buttons") { Console.WriteLine((GetAsyncKeyState(1) & 0x8000) != 0 ? "left down" : "left up"); return 0; }
    if (args.Length == 3 && args[0] == "clipboard-watch") return Watch(args[1], args[2]);
    if (args.Length == 2 && args[0] == "clipboard-set") { Clipboard.SetText(args[1]); return 0; }
    if (args.Length == 1 && args[0] == "clipboard-get") { Console.WriteLine(Clipboard.ContainsText() ? Clipboard.GetText() : "(none)"); return 0; }
    if (args.Length == 1 && args[0] == "clipboard-clear") { Clipboard.Clear(); return 0; }
    Console.Error.WriteLine("usage: window|sleeper|pixels|frame|medium|click|buttons|clipboard-watch|clipboard-set|clipboard-get|clipboard-clear");
    return 2;
  }

  static string Quote(string text) {
    var b = new StringBuilder("\"");
    foreach (char c in text) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  sealed class Target : Form {
    readonly string log;
    readonly bool tool, popup;
    public Target(string log, bool tool, bool popup) { this.log = log; this.tool = tool; this.popup = popup; }
    protected override CreateParams CreateParams {
      get {
        var parameters = base.CreateParams;
        if (tool) parameters.ExStyle |= 0x80; // WS_EX_TOOLWINDOW
        return parameters;
      }
    }
    public void Note(string line) { lock (log) File.AppendAllText(log, line + "\n"); }
  }

  static int Window(string[] args) {
    string dir = args[1], name = args[2], title = args[3];
    int color = Convert.ToInt32(args[4], 16);
    int x = int.Parse(args[5]), y = int.Parse(args[6]), width = int.Parse(args[7]), height = int.Parse(args[8]);
    bool topmost = Array.IndexOf(args, "topmost") > 8, tool = Array.IndexOf(args, "tool") > 8, popup = Array.IndexOf(args, "popup") > 8;
    var form = new Target(Path.Combine(dir, name + ".log"), tool, popup);
    form.Text = title;
    form.StartPosition = FormStartPosition.Manual;
    form.Bounds = new Rectangle(x, y, width, height);
    form.BackColor = Color.FromArgb((color >> 16) & 255, (color >> 8) & 255, color & 255);
    form.TopMost = topmost;
    form.ShowInTaskbar = !tool;
    if (popup) form.FormBorderStyle = FormBorderStyle.None;
    var text = new TextBox { Name = "Notes", Left = 10, Top = 10, Width = Math.Max(60, width / 2), Height = 24, Multiline = true, AcceptsReturn = true, AccessibleName = "Notes" };
    var secret = new TextBox { Name = "Password", Left = 10, Top = 40, Width = Math.Max(60, width / 2), UseSystemPasswordChar = true, AccessibleName = "Password" };
    var button = new Button { Name = "Mark", Text = "Mark", Left = 10, Top = 70, Width = 80 };
    var list = new ListBox { Name = "Rows", Left = Math.Max(100, width / 2 + 20), Top = 10, Width = Math.Max(60, width / 2 - 40), Height = Math.Max(40, height - 100) };
    for (int i = 1; i <= 200; i++) list.Items.Add("Row " + i);
    form.Controls.Add(text);
    form.Controls.Add(secret);
    form.Controls.Add(button);
    form.Controls.Add(list);
    if (!popup) {
      var menu = new MainMenu();
      var file = menu.MenuItems.Add("&File");
      file.MenuItems.Add(new MenuItem("&Mark", (s, e) => form.Note("menu"), Shortcut.CtrlM));
      form.Menu = menu;
    }
    button.Click += (s, e) => form.Note("button");
    text.TextChanged += (s, e) => form.Note("text " + text.Text);
    secret.TextChanged += (s, e) => form.Note("secret " + secret.TextLength);
    MouseEventHandler down = (s, e) => form.Note((e.Button == MouseButtons.Right ? "right" : e.Clicks >= 2 ? "double" : "click") + " " + e.X + "," + e.Y);
    form.MouseDown += down;
    text.MouseDown += down;
    MouseEventHandler up = (s, e) => form.Note("up " + e.X + "," + e.Y);
    form.MouseUp += up;
    text.MouseUp += up;
    list.MouseWheel += (s, e) => form.Note("wheel " + e.Delta);
    form.KeyPreview = true;
    form.KeyDown += (s, e) => form.Note("key " + (int)e.KeyCode);
    form.Shown += (s, e) => {
      Func<Control, string> centre = control => {
        var point = control.PointToScreen(new Point(control.Width / 2, control.Height / 2));
        return "[" + point.X + "," + point.Y + "]";
      };
      var frame = form.Bounds;
      File.WriteAllText(Path.Combine(dir, name + ".json"), "{\"hwnd\":" + form.Handle.ToInt64() + ",\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id +
        ",\"x\":" + frame.X + ",\"y\":" + frame.Y + ",\"width\":" + frame.Width + ",\"height\":" + frame.Height +
        ",\"title\":" + Quote(title) + ",\"notes\":" + centre(text) + ",\"password\":" + centre(secret) + ",\"button\":" + centre(button) + ",\"list\":" + centre(list) + "}");
    };
    Application.Run(form);
    return 0;
  }


  // A restricted copy of this process's token: administrators deny-only, no
  // privileges, medium integrity.
  static int Medium(string[] args) {
    IntPtr token, restricted, admins, medium;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0002 | 0x0008 | 0x0001 | 0x0080, out token)) return Fail("token");
    if (!ConvertStringSidToSidW("S-1-5-32-544", out admins) || !ConvertStringSidToSidW("S-1-16-8192", out medium)) return Fail("sid");
    var deny = new[] { new SID_AND_ATTRIBUTES { Sid = admins, Attributes = 0 } };
    if (!CreateRestrictedToken(token, 0x1, 1, deny, 0, IntPtr.Zero, 0, IntPtr.Zero, out restricted)) return Fail("restricted");
    var label = new TOKEN_MANDATORY_LABEL { Label = new SID_AND_ATTRIBUTES { Sid = medium, Attributes = 0x20 } };
    int size = Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)) + GetLengthSid(medium);
    IntPtr buffer = Marshal.AllocHGlobal(size);
    Marshal.StructureToPtr(label, buffer, false);
    if (!SetTokenInformation(restricted, 25, buffer, size)) return Fail("integrity");
    var command = new StringBuilder();
    for (int i = 1; i < args.Length; i++) {
      if (i > 1) command.Append(' ');
      command.Append(args[i].IndexOf(' ') >= 0 || args[i].Length == 0 ? "\"" + args[i] + "\"" : args[i]);
    }
    var startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), dwFlags = 0x100, hStdInput = GetStdHandle(-10), hStdOutput = GetStdHandle(-11), hStdError = GetStdHandle(-12) };
    PROCESS_INFORMATION started;
    if (!CreateProcessAsUserW(restricted, null, command, IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null, ref startup, out started)) return Fail("start");
    WaitForSingleObject(started.hProcess, 0xFFFFFFFF);
    uint code;
    GetExitCodeProcess(started.hProcess, out code);
    return (int)code;
  }
  static int Fail(string step) { Console.Error.WriteLine("error " + step + " " + Marshal.GetLastWin32Error()); return 3; }

  static int Click(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(0x2, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x4, 0, 0, 0, UIntPtr.Zero);
    return 0;
  }

  sealed class Watcher : Form {
    readonly string log;
    public Watcher(string log) { this.log = log; }
    protected override void WndProc(ref Message message) {
      if (message.Msg == 0x031D) { // WM_CLIPBOARDUPDATE
        var names = new StringBuilder();
        try {
          if (OpenClipboard(Handle)) {
            try {
              for (uint format = EnumClipboardFormats(0); format != 0; format = EnumClipboardFormats(format)) {
                var name = new StringBuilder(256);
                names.Append(GetClipboardFormatNameW(format, name, name.Capacity) > 0 ? name.ToString() : format.ToString()).Append(',');
              }
            } finally { CloseClipboard(); }
          }
        } catch (Exception) { }
        string text = "empty";
        try { if (Clipboard.ContainsText()) text = "text " + Clipboard.GetText(); } catch (Exception) { text = "busy"; }
        File.AppendAllText(log, "formats " + names + " | " + text + "\n");
      }
      base.WndProc(ref message);
    }
  }
  [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
  [DllImport("user32.dll")] static extern bool CloseClipboard();
  static int Watch(string dir, string name) {
    var watcher = new Watcher(Path.Combine(dir, name + ".log")) { ShowInTaskbar = false, WindowState = FormWindowState.Minimized, Text = "Reach clipboard watch" };
    watcher.Load += (s, e) => {
      AddClipboardFormatListener(watcher.Handle);
      File.WriteAllText(Path.Combine(dir, name + ".json"), "{\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + "}");
    };
    Application.Run(watcher);
    return 0;
  }

  static int Sleeper(string dir, string name, string title) {
    Console.Title = title;
    File.WriteAllText(Path.Combine(dir, name + ".json"), "{\"pid\":" + System.Diagnostics.Process.GetCurrentProcess().Id + ",\"console\":" + GetConsoleWindow().ToInt64() + "}");
    Thread.Sleep(Timeout.Infinite);
    return 0;
  }

  static int Pixels(string[] args) {
    using (var image = new Bitmap(args[1])) {
      for (int i = 2; i < args.Length; i++) {
        string[] point = args[i].Split(',');
        var pixel = image.GetPixel(Math.Min(image.Width - 1, int.Parse(point[0])), Math.Min(image.Height - 1, int.Parse(point[1])));
        Console.WriteLine(pixel.R + "," + pixel.G + "," + pixel.B);
      }
    }
    return 0;
  }
}
