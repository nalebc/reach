// Windows for the agent helper's real-Windows tests
// (test/windows-agent-desktop-native.test.mjs, docs/parity/B-desktop-helper.md
// §13.4): each kind is one program run, compiled by the test with the PC's
// csc.exe. C# 5; System, System.Drawing, System.Windows.Forms.
//
//   window <dir> <name> <title> <rrggbb> <x> <y> <width> <height> [topmost] [tool] [popup]
//       A window of one colour with a text box, a password box, a button, a
//       menu and a long list. Writes <dir>\<name>.json once shown (its handle,
//       process, frame and its controls' centres) and appends what reaches it
//       to <dir>\<name>.log, one line each (click, double, right, up, wheel
//       <delta>, key <vk>, text <value>, secret <length>, button, menu). Its
//       background shows along its bottom edge.
//   sleeper <dir> <name> <console title>
//       Stays alive in its console (a stand-in for Reach), titled; writes
//       <dir>\<name>.json with its process and its console window.
//   pixels <jpeg> <x>,<y> ...
//       Prints each pixel of a JPEG as "r,g,b", one line each.
//   frame <window handle>
//       Prints the window's frame as "x,y,width,height".
//   medium <program> [arguments...] | medium-shown <program> [arguments...]
//       Runs a program unelevated at medium integrity (Windows' Basic User
//       token: no administrators' rights), with this process's standard
//       handles and environment, and exits with its code. A console program
//       runs without a console, as Reach starts its helpers; medium-shown
//       gives it a console window of its own. GitHub's runners run
//       everything elevated (their shell too); Reach on a PC doesn't.
//   integrity
//       Prints this process's integrity level and whether it's elevated.
//   click <x> <y>
//       A real left click there (brings that window to the front).
//   buttons
//       Prints "left down" or "left up": the left button's state now.
//   clipboard-watch <dir> <name>
//       Appends, on every clipboard change, "formats <names> | text <text>"
//       (or "| empty") to <dir>\<name>.log.
//   clipboard-set <text> | clipboard-get | clipboard-clear
//       Sets the clipboard's text, prints it (or "(none)"), or empties it.
//   env-report [anything...], or no kind at all (a file or an address first)
//       Writes its own PATH, ProgramFiles and ComSpec, and its arguments, to
//       <its own file>.env.json (a copy named chrome.exe writes chrome.exe.env.json):
//       how the agent's open, an association or a browser launch started it.
//   env-block
//       Prints PATH, ProgramFiles and ComSpec as Windows builds them for the
//       user (CreateEnvironmentBlock, not inheriting this process's).
//   find <text>
//       Prints "handle,x,y,width,height" of the first visible window whose
//       title holds the text (any case); exits 1 when there's none.
//   short <path>
//       Prints the path's 8.3 form (the same path when it has none).
using System;
using System.Drawing;
using System.IO;
using System.Reflection;
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
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint kind);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll", SetLastError = true)] static extern bool AddClipboardFormatListener(IntPtr window);
  delegate bool EnumWindowsProc(IntPtr window, IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc each, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr window, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder name, int max);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern int GetShortPathNameW(string path, StringBuilder shortPath, int size);
  [DllImport("user32.dll")] static extern uint EnumClipboardFormats(uint format);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClipboardFormatNameW(uint format, StringBuilder name, int max);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref int length);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableCount, SID_AND_ATTRIBUTES[] disable, uint deleteCount, IntPtr delete, uint restrictCount, IntPtr restrict, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int kind, IntPtr info, int size);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetKernelObjectSecurity(IntPtr handle, uint information, IntPtr descriptor);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr info, int size, out int needed);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthority(IntPtr sid, int index);
  [DllImport("advapi32.dll")] static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SaferCreateLevel(uint scope, uint level, uint flags, out IntPtr handle, IntPtr reserved);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SaferComputeTokenFromLevel(IntPtr level, IntPtr token, out IntPtr result, uint flags, IntPtr reserved);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool SaferCloseLevel(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
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
    if (args.Length == 2 && args[0] == "process-probe") return ProcessProbe(int.Parse(args[1]));
    if (args.Length == 4 && args[0] == "helper-probe") return HelperProbe(args[1], int.Parse(args[2]), args[3]);
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
    if (args.Length >= 2 && (args[0] == "medium" || args[0] == "medium-shown")) return Medium(args);
    if (args.Length == 3 && args[0] == "click") return Click(int.Parse(args[1]), int.Parse(args[2]), 0);
    if (args.Length == 4 && args[0] == "click") return Click(int.Parse(args[1]), int.Parse(args[2]), uint.Parse(args[3]));
    if (args.Length == 1 && args[0] == "buttons") { Console.WriteLine((GetAsyncKeyState(1) & 0x8000) != 0 ? "left down" : "left up"); return 0; }
    if (args.Length == 3 && args[0] == "clipboard-watch") return Watch(args[1], args[2]);
    if (args.Length == 2 && args[0] == "clipboard-set") { Clipboard.SetText(args[1]); return 0; }
    if (args.Length == 1 && args[0] == "clipboard-get") { Console.WriteLine(Clipboard.ContainsText() ? Clipboard.GetText() : "(none)"); return 0; }
    if (args.Length == 1 && args[0] == "clipboard-clear") { Clipboard.Clear(); return 0; }
    if (args.Length == 1 && args[0] == "env-block") return EnvironmentBlock();
    if (args.Length == 2 && args[0] == "find") return Find(args[1]);
    if (args.Length == 1 && args[0] == "integrity") return Integrity();
    if (args.Length == 2 && args[0] == "short") {
      var name = new StringBuilder(32768);
      int length = GetShortPathNameW(args[1], name, name.Capacity);
      if (length <= 0 || length >= name.Capacity) return Fail("short");
      Console.WriteLine(name.ToString(0, length));
      return 0;
    }
    // Started by name, with nothing (the agent's open) or with a file or an
    // address (an association's or a browser's launch): it reports.
    if (args.Length == 0 || args[0] == "env-report" || Array.IndexOf(Kinds, args[0]) < 0) return Report(args);
    Console.Error.WriteLine("usage: " + string.Join("|", Kinds) + "|env-report");
    return 2;
  }
  static readonly string[] Kinds = { "window", "sleeper", "pixels", "frame", "medium", "medium-shown", "click", "buttons",
    "clipboard-watch", "clipboard-set", "clipboard-get", "clipboard-clear", "env-block", "find", "short", "integrity", "process-probe", "helper-probe" };

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
    // A box can hold half a character for a moment (an emoji's first half):
    // written as U+FFFD then, never thrown over.
    static readonly Encoding Lenient = new UTF8Encoding(false, false);
    public void Note(string line) { lock (log) File.AppendAllText(log, line + "\n", Lenient); }
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
      var mark = new MenuItem("&Mark", (s, e) => form.Note("menu"), Shortcut.CtrlM);
      file.MenuItems.Add(mark);
      file.Popup += (s, e) => { if (File.Exists(Path.Combine(dir, name + ".menu-change"))) mark.Text = "&Changed command"; };
      form.Menu = menu;
    }
    button.Click += (s, e) => { form.Note("button"); button.Text = button.Text == "Mark" ? "Marked" : "Mark"; };
    text.TextChanged += (s, e) => form.Note("text " + text.Text);
    secret.TextChanged += (s, e) => form.Note("secret " + secret.TextLength);
    MouseEventHandler down = (s, e) => form.Note((e.Button == MouseButtons.Right ? "right" : e.Clicks >= 2 ? "double" : "click") + " " + e.X + "," + e.Y);
    form.MouseDown += down;
    text.MouseDown += down;
    list.MouseDown += down;
    MouseEventHandler up = (s, e) => form.Note("up " + e.X + "," + e.Y);
    form.MouseUp += up;
    text.MouseUp += up;
    list.MouseUp += up;
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
    IntPtr token = UnelevatedToken();
    if (token == IntPtr.Zero) return Fail("token");
    var command = new StringBuilder();
    for (int i = 1; i < args.Length; i++) {
      if (i > 1) command.Append(' ');
      command.Append(args[i].IndexOf(' ') >= 0 || args[i].Length == 0 ? "\"" + args[i] + "\"" : args[i]);
    }
    // A console program runs without a console, as Reach starts its helpers
    // (detached); medium-shown gives it a console window of its own.
    bool console = Subsystem(args[1]) == 3, shown = args[0] == "medium-shown";
    var startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)), dwFlags = shown ? 0 : 0x100,
      hStdInput = GetStdHandle(-10), hStdOutput = GetStdHandle(-11), hStdError = GetStdHandle(-12) };
    var started = new PROCESS_INFORMATION();
    uint flags = !console ? 0u : shown ? 0x10u : 0x8u;
    if (!CreateProcessAsUserW(token, null, command, IntPtr.Zero, IntPtr.Zero, !shown, flags, IntPtr.Zero, null, ref startup, out started)) return Fail("start");
    WaitForSingleObject(started.hProcess, 0xFFFFFFFF);
    uint code;
    GetExitCodeProcess(started.hProcess, out code);
    return (int)code;
  }
  // This user without administrators' rights, as User Account Control's
  // filtered token has them: Windows' Basic User level (runas
  // /trustlevel:0x20000), else a restricted copy of this process's token;
  // at medium integrity, and owning what it creates (an elevated token's
  // objects belong to Administrators, whom this one is denied as).
  static IntPtr UnelevatedToken() {
    IntPtr token = IntPtr.Zero, level, own, admins, medium;
    if (SaferCreateLevel(2, 0x20000, 1, out level, IntPtr.Zero)) {
      if (!SaferComputeTokenFromLevel(level, IntPtr.Zero, out token, 0, IntPtr.Zero)) token = IntPtr.Zero;
      SaferCloseLevel(level);
    }
    if (token == IntPtr.Zero) {
      if (!OpenProcessToken(GetCurrentProcess(), 0x0002 | 0x0008 | 0x0001 | 0x0080, out own) || !ConvertStringSidToSidW("S-1-5-32-544", out admins)) return IntPtr.Zero;
      var deny = new[] { new SID_AND_ATTRIBUTES { Sid = admins, Attributes = 0 } };
      if (!CreateRestrictedToken(own, 0x1, 1, deny, 0, IntPtr.Zero, 0, IntPtr.Zero, out token)) return IntPtr.Zero;
    }
    if (!ConvertStringSidToSidW("S-1-16-8192", out medium)) return IntPtr.Zero;
    var label = new TOKEN_MANDATORY_LABEL { Label = new SID_AND_ATTRIBUTES { Sid = medium, Attributes = 0x20 } };
    int size = Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)) + GetLengthSid(medium);
    IntPtr buffer = Marshal.AllocHGlobal(size);
    Marshal.StructureToPtr(label, buffer, false);
    if (!SetTokenInformation(token, 25, buffer, size)) return IntPtr.Zero;
    string user = UserSid(token);
    IntPtr descriptor, dacl;
    uint length;
    bool present, defaulted;
    if (user == null || !ConvertStringSecurityDescriptorToSecurityDescriptorW("D:(A;;GA;;;" + user + ")(A;;GA;;;SY)", 1, out descriptor, out length) ||
        !GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted)) return IntPtr.Zero;
    // TokenDefaultDacl governs objects created later, not the token itself.
    // Other fixture processes at this user's medium integrity must also be
    // able to query its token, as they can query an ordinary user's token.
    if (!SetKernelObjectSecurity(token, 4, descriptor)) return IntPtr.Zero;
    IntPtr holder = Marshal.AllocHGlobal(IntPtr.Size);
    Marshal.WriteIntPtr(holder, dacl);
    return SetTokenInformation(token, 6, holder, IntPtr.Size) ? token : IntPtr.Zero;
  }
  static string UserSid(IntPtr token) {
    int size;
    GetTokenInformation(token, 1, IntPtr.Zero, 0, out size);
    if (size <= 0) return null;
    IntPtr user = Marshal.AllocHGlobal(size);
    IntPtr text;
    if (!GetTokenInformation(token, 1, user, size, out size) || !ConvertSidToStringSidW(Marshal.ReadIntPtr(user), out text)) return null;
    return Marshal.PtrToStringUni(text);
  }
  // A program's subsystem from its PE header: 2 windows, 3 console.
  static int Subsystem(string file) {
    try {
      using (var stream = File.OpenRead(file)) {
        var reader = new BinaryReader(stream);
        stream.Position = 0x3C;
        stream.Position = reader.ReadInt32() + 4 + 20 + 68;
        return reader.ReadUInt16();
      }
    } catch (Exception) {
      return 0;
    }
  }
  static int Integrity() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0008, out token)) return Fail("token");
    int size;
    GetTokenInformation(token, 25, IntPtr.Zero, 0, out size);
    IntPtr label = Marshal.AllocHGlobal(size);
    IntPtr elevation = Marshal.AllocHGlobal(4);
    int ignored;
    if (!GetTokenInformation(token, 25, label, size, out size) || !GetTokenInformation(token, 20, elevation, 4, out ignored)) return Fail("information");
    IntPtr sid = Marshal.ReadIntPtr(label);
    int count = Marshal.ReadByte(GetSidSubAuthorityCount(sid));
    int level = Marshal.ReadInt32(GetSidSubAuthority(sid, count - 1));
    Console.WriteLine("integrity " + level.ToString("X") + " elevated " + (Marshal.ReadInt32(elevation) != 0 ? "yes" : "no"));
    return 0;
  }
  static int ProcessProbe(int pid) {
    IntPtr process = OpenProcess(0x1000, false, pid);
    if (process == IntPtr.Zero) { Console.WriteLine("{\"openError\":" + Marshal.GetLastWin32Error() + "}"); return 0; }
    try {
      long created, exited, kernel, user;
      bool times = GetProcessTimes(process, out created, out exited, out kernel, out user);
      int timeError = times ? 0 : Marshal.GetLastWin32Error();
      var image = new StringBuilder(32768); int size = image.Capacity;
      bool imageRead = QueryFullProcessImageNameW(process, 0, image, ref size);
      int imageError = imageRead ? 0 : Marshal.GetLastWin32Error();
      var package = new StringBuilder(1024); uint length = (uint)package.Capacity;
      int packageStatus = GetPackageFullName(process, ref length, package);
      IntPtr token;
      bool tokenRead = OpenProcessToken(process, 0x8, out token);
      int tokenError = tokenRead ? 0 : Marshal.GetLastWin32Error();
      if (tokenRead) CloseHandle(token);
      Console.WriteLine("{\"openError\":0,\"timeError\":" + timeError + ",\"imageError\":" + imageError +
        ",\"packageStatus\":" + packageStatus + ",\"tokenError\":" + tokenError + ",\"pointerBytes\":" + IntPtr.Size + "}");
      return 0;
    } finally { CloseHandle(process); }
  }
  // Invoke the built helper's own identity reader at this fixture's token.
  // Only booleans/numbers are recorded, never another program's path/title.
  static int HelperProbe(string helper, int pid, string expectedImage) {
    var assembly = Assembly.LoadFrom(helper);
    var desk = assembly.GetType("Desk", true);
    var flags = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
    object identity = desk.GetMethod("Identify", flags).Invoke(null, new object[] { pid });
    var ident = identity.GetType();
    Func<string, object> field = name => ident.GetField(name).GetValue(identity);
    uint frontPid;
    IntPtr front = GetAncestor(GetForegroundWindow(), 2);
    GetWindowThreadProcessId(front, out frontPid);
    object view = desk.GetField("View", flags).GetValue(null);
    int integrity = (int)view.GetType().GetMethod("ForegroundIntegrity").Invoke(view, null);
    Console.WriteLine("{\"known\":" + field("Known").ToString().ToLowerInvariant() +
      ",\"created\":" + (((long)field("Created")) != 0).ToString().ToLowerInvariant() +
      ",\"imageMatches\":" + string.Equals((string)field("Image"), expectedImage, StringComparison.OrdinalIgnoreCase).ToString().ToLowerInvariant() +
      ",\"integrity\":" + field("Integrity") + ",\"foregroundPid\":" + frontPid +
      ",\"foregroundIntegrity\":" + integrity + "}");
    return 0;
  }
  static int Fail(string step) { Console.Error.WriteLine("error " + step + " " + Marshal.GetLastWin32Error()); return 3; }

  static int Find(string text) {
    IntPtr found = IntPtr.Zero;
    EnumWindowsProc each = (window, data) => {
      var title = new StringBuilder(1024);
      GetWindowTextW(window, title, title.Capacity);
      if (!IsWindowVisible(window) || title.ToString().IndexOf(text, StringComparison.OrdinalIgnoreCase) < 0) return true;
      found = window;
      return false;
    };
    EnumWindows(each, IntPtr.Zero);
    GC.KeepAlive(each);
    RECT rect;
    if (found == IntPtr.Zero || !GetWindowRect(found, out rect)) return 1;
    Console.WriteLine(found.ToInt64() + "," + rect.Left + "," + rect.Top + "," + (rect.Right - rect.Left) + "," + (rect.Bottom - rect.Top));
    return 0;
  }

  static int Click(int x, int y, uint expectedPid) {
    IntPtr target = GetAncestor(WindowFromPoint(new POINT { X = x, Y = y }), 2);
    // A window left over on the desktop can cover the point; the click would
    // then raise it and still "succeed". Name its owner and class instead.
    uint owner;
    GetWindowThreadProcessId(target, out owner);
    if (expectedPid != 0 && owner != expectedPid) {
      var kind = new StringBuilder(256);
      GetClassNameW(target, kind, kind.Capacity);
      Console.Error.WriteLine("The fixture click point is covered by another window (pid " + owner + ", class " + kind +
        ", expected pid " + expectedPid + ").");
      return 2;
    }
    SetCursorPos(x, y);
    mouse_event(0x2, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x4, 0, 0, 0, UIntPtr.Zero);
    // Injection is asynchronous. Do not tell the test its owner click has
    // taken the foreground until Windows confirms that exact root window.
    for (int i = 0; i < 80; i++) {
      if (target != IntPtr.Zero && GetForegroundWindow() == target) return 0;
      Thread.Sleep(25);
    }
    Console.Error.WriteLine("The fixture click did not activate its root window (target " + target.ToInt64() +
      ", foreground " + GetForegroundWindow().ToInt64() + ").");
    return 1;
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


  // What this program was started with (any arguments: a file or an address
  // its association or a browser launch passes).
  static int Report(string[] args) {
    string self = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
    var b = new StringBuilder("{");
    foreach (string name in new[] { "PATH", "ProgramFiles", "ComSpec" }) b.Append(Quote(name)).Append(':').Append(Quote(Environment.GetEnvironmentVariable(name) ?? "")).Append(',');
    b.Append("\"args\":[");
    for (int i = 0; i < args.Length; i++) b.Append(i > 0 ? "," : "").Append(Quote(args[i]));
    b.Append("]}");
    File.WriteAllText(self + ".env.json", b.ToString());
    return 0;
  }
  [DllImport("userenv.dll", SetLastError = true)] static extern bool CreateEnvironmentBlock(out IntPtr block, IntPtr token, bool inherit);
  static int EnvironmentBlock() {
    IntPtr token, block;
    if (!OpenProcessToken(GetCurrentProcess(), 0x0008 | 0x0002, out token) || !CreateEnvironmentBlock(out block, token, false)) return Fail("block");
    var values = new System.Collections.Generic.Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    for (IntPtr at = block; ; ) {
      string entry = Marshal.PtrToStringUni(at);
      if (string.IsNullOrEmpty(entry)) break;
      int equals = entry.IndexOf('=', 1);
      if (equals > 0) values[entry.Substring(0, equals)] = entry.Substring(equals + 1);
      at = new IntPtr(at.ToInt64() + (entry.Length + 1) * 2);
    }
    var b = new StringBuilder("{");
    foreach (string name in new[] { "PATH", "ProgramFiles", "ComSpec" }) {
      string value;
      b.Append(Quote(name)).Append(':').Append(Quote(values.TryGetValue(name, out value) ? value : "")).Append(name == "ComSpec" ? "" : ",");
    }
    Console.WriteLine(b.Append('}').ToString());
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
