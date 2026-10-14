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
    Console.Error.WriteLine("usage: window|sleeper|pixels|frame");
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
    var text = new TextBox { Name = "Notes", Left = 10, Top = 10, Width = Math.Max(60, width / 2), AccessibleName = "Notes" };
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
