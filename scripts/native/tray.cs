// Reach's icon in the Windows notification area, the twin of its item in a
// Mac's menu bar (scripts/native/app-displays.m updateMenu): whether Reach is
// on or paused, messages from the phone waiting for their Claude app chat (a
// click opens the chat), and Pause or Resume. Run by server/windows-tray.mjs.
//
//   tray.exe [icon.png]
// stdin, a line at a time, from Reach:
//   paused 0|1
//   waiting [<count>:<base64 link>:<base64 title> ...]
//   click toggle | click open <n>      (what a click does, for its tests)
// stdout, a line each: ready, pause, resume
// It ends when stdin closes (Reach gone), and its icon goes with it.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

static class Tray {
  static NotifyIcon icon;
  static Icon on, off;
  static Control ui;
  static bool paused;
  // { count, link, title } for each waiting chat.
  static List<string[]> waiting = new List<string[]>();
  static readonly object outLock = new object();
  static Stream stdout;

  static void Say(string line) {
    lock (outLock) {
      try {
        byte[] bytes = Encoding.UTF8.GetBytes(line + "\n");
        stdout.Write(bytes, 0, bytes.Length);
        stdout.Flush();
      } catch (IOException) {}
    }
  }
  static string Text(string value) {
    try { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }
    catch (FormatException) { return ""; }
  }
  // Reach's mark from its icon file, and a grey one for Paused; Windows' own
  // when the file can't be read.
  static Icon Mark(string file, bool grey) {
    try {
      using (var source = new Bitmap(file))
      using (var small = new Bitmap(32, 32)) {
        using (var g = Graphics.FromImage(small)) {
          g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
          var attributes = new ImageAttributes();
          if (grey)
            attributes.SetColorMatrix(new ColorMatrix(new float[][] {
              new float[] { 0.3f, 0.3f, 0.3f, 0, 0 }, new float[] { 0.59f, 0.59f, 0.59f, 0, 0 },
              new float[] { 0.11f, 0.11f, 0.11f, 0, 0 }, new float[] { 0, 0, 0, 0.6f, 0 }, new float[] { 0, 0, 0, 0, 1 } }));
          g.DrawImage(source, new Rectangle(0, 0, 32, 32), 0, 0, source.Width, source.Height, GraphicsUnit.Pixel, attributes);
        }
        return Icon.FromHandle(small.GetHicon());
      }
    } catch (Exception) {
      return SystemIcons.Application;
    }
  }
  static void Toggle() { Say(paused ? "resume" : "pause"); }
  // Only the Claude app's own links (claude://), as a Mac's menu opens them.
  static void Open(int index) {
    if (index < 0 || index >= waiting.Count) return;
    string link = waiting[index][1];
    if (!link.StartsWith("claude://", StringComparison.Ordinal)) return;
    try { Process.Start(new ProcessStartInfo(link) { UseShellExecute = true }); } catch (Exception) {}
  }
  static string Count(int count) { return count == 1 ? "A message from your phone is waiting for its chat" : count + " messages from your phone are waiting for their chats"; }
  static void Rebuild() {
    int total = 0;
    foreach (var chat in waiting) total += Math.Max(1, int.Parse(chat[0]));
    icon.Icon = paused ? off : on;
    string tip = paused ? "Reach is paused" : total > 0 ? Count(total) : "Reach is on";
    icon.Text = tip.Length > 63 ? tip.Substring(0, 63) : tip;
    var menu = new ContextMenuStrip();
    var heading = new ToolStripMenuItem(paused ? "Paused · your phone can't see or use this PC" : "Reach is on");
    heading.Enabled = false;
    menu.Items.Add(heading);
    if (waiting.Count > 0) {
      menu.Items.Add(new ToolStripSeparator());
      var about = new ToolStripMenuItem("From your phone, waiting in the Claude app");
      about.Enabled = false;
      menu.Items.Add(about);
      for (int i = 0; i < waiting.Count; i++) {
        int count = Math.Max(1, int.Parse(waiting[i][0]));
        string line = count == 1 ? "Open “" + waiting[i][2] + "”" : "Open “" + waiting[i][2] + "” · " + count + " messages";
        int index = i;
        menu.Items.Add(new ToolStripMenuItem(line, null, delegate { Open(index); }));
      }
    }
    menu.Items.Add(new ToolStripSeparator());
    menu.Items.Add(new ToolStripMenuItem(paused ? "Resume Reach" : "Pause Reach", null, delegate { Toggle(); }));
    var old = icon.ContextMenuStrip;
    icon.ContextMenuStrip = menu;
    if (old != null) old.Dispose();
  }
  static void Apply(string line) {
    if (line == "paused 0" || line == "paused 1") {
      paused = line == "paused 1";
    } else if (line == "waiting" || line.StartsWith("waiting ", StringComparison.Ordinal)) {
      var next = new List<string[]>();
      foreach (string item in line.Substring(7).Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries)) {
        string[] parts = item.Split(':');
        int count;
        if (parts.Length != 3 || !int.TryParse(parts[0], out count) || count < 0 || next.Count >= 20) continue;
        string title = Text(parts[2]).Replace('\r', ' ').Replace('\n', ' ');
        if (title.Length > 60) title = title.Substring(0, 59) + "…";
        next.Add(new[] { count.ToString(), Text(parts[1]), title });
      }
      waiting = next;
    } else if (line == "click toggle") {
      Toggle();
      return;
    } else if (line.StartsWith("click open ", StringComparison.Ordinal)) {
      int index;
      if (int.TryParse(line.Substring(11), out index)) Open(index);
      return;
    } else return;
    Rebuild();
  }
  static void Read() {
    var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    string line;
    while ((line = input.ReadLine()) != null) {
      string got = line.TrimEnd('\r');
      if (got.Length > 65536) continue;
      ui.BeginInvoke((MethodInvoker)delegate { Apply(got); });
    }
    ui.BeginInvoke((MethodInvoker)delegate { icon.Visible = false; Application.ExitThread(); });
  }
  [STAThread]
  static int Main(string[] args) {
    stdout = Console.OpenStandardOutput();
    Application.EnableVisualStyles();
    ui = new Control();
    IntPtr handle = ui.Handle;
    string file = args.Length > 0 ? args[0] : "";
    on = Mark(file, false);
    off = Mark(file, true);
    icon = new NotifyIcon();
    icon.Visible = true;
    Rebuild();
    // A left click shows the same menu, as a Mac's menu bar item does.
    icon.MouseUp += delegate(object sender, MouseEventArgs e) {
      if (e.Button != MouseButtons.Left) return;
      MethodInfo show = typeof(NotifyIcon).GetMethod("ShowContextMenu", BindingFlags.Instance | BindingFlags.NonPublic);
      if (show != null) show.Invoke(icon, null);
    };
    var reader = new Thread(Read);
    reader.IsBackground = true;
    reader.Start();
    Say("ready");
    Application.Run();
    icon.Visible = false;
    icon.Dispose();
    return 0;
  }
}
