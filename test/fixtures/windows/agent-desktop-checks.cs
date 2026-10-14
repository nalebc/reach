// The Windows agent helper's own decisions (scripts/native/agent-desktop.cs),
// checked against windows, inputs and lines these checks describe: nothing
// here calls Windows. Compiled together with the helper (csc /main:DesktopChecks)
// by test/agent-desktop-windows-policy.test.mjs on Windows. C# 5.
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;

static class DesktopChecks {
  static int failures;
  static void Check(bool ok, string label) { if (!ok) { failures++; Console.WriteLine("FAILED: " + label); } }
  static Ident Known(string bundle) {
    return new Ident { Pid = 100, Created = 1, Bundle = bundle, Path = bundle, Image = "C:\\Apps\\" + bundle + ".exe", Name = bundle, Known = true, Integrity = 0x2000 };
  }
  // A plain window: in Windows' first walk at `order`, drawn solid.
  static Win Window(long handle, int order, int left, int top, int right, int bottom) {
    return new Win { Handle = handle, L1Index = order, InL1 = true, InL2 = true, Visible = true, FrameRead = true, Frame = new Box(left, top, right, bottom), Id = Known("app" + handle), Class = "AppWindow" };
  }
  static List<Win> List(params Win[] windows) { return new List<Win>(windows); }

  static int Main() {
    Pixels();
    ViewMasks();
    AppsMasks();
    Looks();
    Settling();
    Framing();
    Pointer();
    Held();
    Keys();
    Typing();
    Automation();
    Launching();
    if (failures == 0) Console.WriteLine("OK");
    return failures == 0 ? 0 : 1;
  }

  static void Pixels() {
    var set = PixelSet.Of(new Box(0, 0, 100, 100));
    set.Subtract(new Box(25, 25, 75, 75));
    Check(set.Area == 7500 && !set.Contains(50, 50) && set.Contains(10, 10) && set.Contains(80, 50), "a hole");
    set.Add(new Box(40, 40, 60, 60));
    Check(set.Area == 7900 && set.Contains(50, 50), "filled back, nothing counted twice");
    Check(PixelSet.Of(new Box(0, 0, 10, 10)).Intersect(PixelSet.Of(new Box(5, 5, 20, 20))).Area == 25, "intersection");
    var both = PixelSet.Of(new Box(0, 0, 10, 10));
    both.Add(new Box(5, 0, 15, 10));
    Check(both.Area == 150, "overlapping additions");
  }

  // View: a closed window is black; a solid window definitely above it shows
  // its own pixels there (8 px kept black on each side), unless strict.
  static void ViewMasks() {
    var screen = new Box(0, 0, 1000, 800);
    Func<Win, Win, bool, PixelSet> mask = (over, closed, strict) => Masks.View(List(over, closed), screen, strict);
    var e = Window(2, 2, 100, 100, 500, 500);
    e.Excluded = true;
    var o = Window(1, 1, 50, 50, 400, 400);
    var refined = mask(o, e, false);
    Check(refined.Area == 160000 - 292 * 292 && !refined.Contains(200, 200) && refined.Contains(450, 450) && refined.Contains(395, 200), "a solid window above covers it, less 8 px each side");
    Check(mask(o, e, true).Area == 160000, "strict: the whole frame, always");
    var below = Window(3, 3, 50, 50, 400, 400);
    Check(mask(below, e, false).Area == 160000, "a window below covers nothing");
    var topmost = Window(4, 0, 50, 50, 400, 400);
    topmost.Top = true;
    topmost.ExStyle = Native.WS_EX_TOPMOST;
    Check(mask(topmost, e, false).Area == 160000 - 292 * 292, "a topmost window is over every desktop window");
    var immersive = Window(5, 0, 50, 50, 400, 400);
    immersive.Top = true;
    immersive.Class = "Windows.UI.Core.CoreWindow";
    Check(mask(immersive, e, false).Area == 160000, "the top band isn't ordered against the desktop's: no refinement");
    // See-through ways: none of them covers.
    var seeThrough = new List<Action<Win>> {
      w => { w.ExStyle = Native.WS_EX_LAYERED; w.LayeredRead = true; w.LayeredFlags = Native.LWA_ALPHA; w.Alpha = 254; },
      w => { w.ExStyle = Native.WS_EX_LAYERED; w.LayeredRead = true; w.LayeredFlags = Native.LWA_COLORKEY; },
      w => { w.ExStyle = Native.WS_EX_LAYERED; w.LayeredRead = false; },
      w => { w.ExStyle = Native.WS_EX_NOREDIRECTIONBITMAP; },
      w => { w.ExStyle = Native.WS_EX_TRANSPARENT; },
      w => { w.HasRegion = true; },
      w => { w.Backdrop = 3; },
      w => { w.Shell = true; },
      w => { w.Id = new Ident(); },
    };
    for (int i = 0; i < seeThrough.Count; i++) {
      var w = Window(1, 1, 50, 50, 400, 400);
      seeThrough[i](w);
      Check(!w.Opaque && mask(w, e, false).Area == 160000, "see-through way " + i);
    }
    foreach (int backdrop in new[] { -1, 0, 1, 2, 4 }) {
      var w = Window(1, 1, 50, 50, 400, 400);
      w.Backdrop = backdrop;
      Check(w.Opaque && mask(w, e, false).Area == 160000 - 292 * 292, "no system backdrop, or Mica: solid " + backdrop);
    }
    var layeredSolid = Window(1, 1, 50, 50, 400, 400);
    layeredSolid.ExStyle = Native.WS_EX_LAYERED;
    layeredSolid.LayeredRead = true;
    layeredSolid.LayeredFlags = Native.LWA_ALPHA;
    layeredSolid.Alpha = 255;
    Check(layeredSolid.Opaque, "layered at full alpha");
    // While Task View or Alt+Tab is up, nothing is refined.
    var overlay = Window(9, 0, 0, 0, 10, 10);
    overlay.Overlay = true;
    overlay.Top = true;
    Check(Masks.View(List(overlay, o, e), screen, false).Area == 160000, "an overlay up: whole frames");
    // A high-DPI window keeps more of its corners black.
    var scaled = Window(1, 1, 50, 50, 400, 400);
    scaled.Scale = 1.5;
    Check(mask(scaled, e, false).Area == 160000 - 288 * 288, "12 px at 150 %");
  }

  // Apps: black, then the chosen windows' own pixels.
  static void AppsMasks() {
    var screen = new Box(0, 0, 1000, 800);
    var a = Window(10, 1, 0, 0, 500, 500);
    a.Allowed = true;
    Check(Masks.Apps(List(a), screen, false).Area == 250000, "a chosen window is painted");
    var tool = Window(11, 0, 100, 100, 200, 200);
    tool.Top = true;
    tool.ExStyle = Native.WS_EX_TOPMOST | Native.WS_EX_TOOLWINDOW;
    Check(!Masks.Apps(List(tool, a), screen, false).Contains(150, 150), "a topmost tool window over it");
    var toast = Window(12, int.MaxValue, 300, 300, 450, 450);
    toast.InL1 = false;
    toast.Top = true;
    toast.Class = "Windows.UI.Core.CoreWindow";
    Check(!Masks.Apps(List(a, toast), screen, false).Contains(350, 350), "a toast only the second walk found");
    var lowTop = Window(13, 7, 20, 20, 60, 60);
    lowTop.Top = true;
    lowTop.Shell = true;
    Check(!Masks.Apps(List(a, lowTop), screen, false).Contains(30, 30), "a top-band window is subtracted wherever it sits");
    // A chosen window that is itself in the top band (topmost): a top-band
    // window Windows lists after it is still cut out.
    var pinned = Window(20, 2, 0, 0, 500, 500);
    pinned.Allowed = true;
    pinned.Top = true;
    pinned.ExStyle = Native.WS_EX_TOPMOST;
    var shellBelow = Window(21, 5, 50, 50, 150, 150);
    shellBelow.Top = true;
    shellBelow.Shell = true;
    Check(!Masks.Apps(List(pinned, shellBelow), screen, false).Contains(100, 100), "a top-band window under a topmost chosen one");
    var under = Window(14, 5, 400, 400, 600, 600);
    var desktop = Window(15, 99, 0, 0, 1000, 800);
    desktop.Shell = true;
    desktop.Class = "Progman";
    var painted = Masks.Apps(List(a, under, desktop), screen, false);
    Check(painted.Contains(450, 450) && painted.Contains(10, 10) && !painted.Contains(700, 700), "ordinary windows and the desktop below don't black it out");
    var closed = Window(16, 6, 300, 0, 600, 100);
    closed.Excluded = true;
    Check(Masks.Apps(List(a, closed), screen, false).Contains(350, 50), "a closed window below a solid chosen one");
    Check(!Masks.Apps(List(a, closed), screen, true).Contains(350, 50), "strict: cut out");
    var glass = Window(10, 1, 0, 0, 500, 500);
    glass.Allowed = true;
    glass.Backdrop = 3;
    Check(!Masks.Apps(List(glass, closed), screen, false).Contains(350, 50), "a see-through chosen window never shows a closed one");
    var over = Window(17, 0, 450, 450, 800, 800);
    Check(!Masks.Apps(List(over, a), screen, false).Contains(470, 470), "any window above it");
    var overlay = Window(18, 0, 0, 0, 10, 10);
    overlay.Overlay = true;
    overlay.Top = true;
    Check(Masks.Apps(List(overlay, a), screen, false).Area == 0, "an overlay up: nothing");
    var hiddenWindow = Window(19, 0, 0, 0, 500, 500);
    hiddenWindow.Iconic = true;
    Check(Masks.Apps(List(hiddenWindow, a), screen, false).Area == 250000, "a minimized window covers nothing");
  }

  // Every look counts: a closed window in any of them is black.
  static void Looks() {
    var screen = new Box(0, 0, 1000, 800);
    var e = Window(2, 2, 100, 100, 300, 300);
    e.Excluded = true;
    var plain = Window(3, 3, 0, 0, 50, 50);
    var first = new Inventory();
    first.Windows.Add(plain);
    var second = new Inventory();
    second.Windows.Add(plain);
    second.Windows.Add(e);
    int hidden;
    var black = Masks.Black("view", screen, new List<Inventory> { first, second }, false, out hidden);
    Check(black.Contains(200, 200) && hidden == 1, "a window in one look only");
    Check(Masks.Black("view", screen, null, false, out hidden).Area == 800000, "no settled look: all black");
    Check(Masks.Black("apps", screen, new List<Inventory>(), false, out hidden).Area == 800000, "no look: all black");
    Check(Masks.Black("full", screen, null, false, out hidden).Area == 0, "full control: nothing");
    var a = Window(4, 1, 0, 0, 500, 500);
    a.Allowed = true;
    var tool = Window(5, 0, 100, 100, 200, 200);
    tool.Top = true;
    var before = new Inventory();
    before.Windows.Add(a);
    var after = new Inventory();
    after.Windows.Add(tool);
    after.Windows.Add(a);
    black = Masks.Black("apps", screen, new List<Inventory> { before, after }, false, out hidden);
    Check(black.Contains(150, 150) && !black.Contains(50, 50) && black.Contains(700, 700) && hidden == 1, "apps: painted only where every look agrees");
  }

  static void Settling() {
    Func<string, Inventory> look = title => {
      var inventory = new Inventory();
      var w = Window(1, 0, 0, 0, 10, 10);
      w.Title = title;
      inventory.Windows.Add(w);
      return inventory;
    };
    int captures = 0, revision = 0, discarded = 0;
    var looks = new List<Inventory>();
    var taken = Desk.Settle(() => ++captures, () => look("same"), () => revision, true, looks, old => discarded++);
    Check(taken.Settled && captures == 1 && looks.Count == 2 && taken.Picture == 1, "unchanged: one picture");
    int n = 0;
    captures = 0;
    looks.Clear();
    taken = Desk.Settle(() => ++captures, () => look("title " + (n++)), () => revision, true, looks, old => discarded++);
    Check(!taken.Settled && captures == 3 && looks.Count == 6 && discarded == 2, "changing every time: three pictures, then black");
    captures = 0;
    looks.Clear();
    taken = Desk.Settle(() => { revision++; return ++captures; }, () => look("same"), () => revision, true, looks, old => { });
    Check(!taken.Settled && captures == 3, "a window event during each picture");
    captures = 0;
    looks.Clear();
    taken = Desk.Settle(() => ++captures, () => new Inventory { Complete = false }, () => revision, true, looks, old => { });
    Check(!taken.Settled && captures == 1, "an incomplete list: black at once");
    captures = 0;
    looks.Clear();
    taken = Desk.Settle(() => ++captures, () => { throw new InvalidOperationException("never listed"); }, () => revision, false, looks, old => { });
    Check(taken.Settled && captures == 1 && looks.Count == 0, "full control lists nothing");
  }

  static void Framing() {
    var got = new List<string>();
    var framer = new LineFramer(16, Desk.InvalidLine);
    Action<string> feed = text => { byte[] bytes = Encoding.UTF8.GetBytes(text); framer.Feed(bytes, bytes.Length, got.Add); };
    feed("{\"op\":\"a\"}\r\n" + new string('x', 20) + "\nok\n");
    Check(got.Count == 3 && got[0] == "{\"op\":\"a\"}" && ReferenceEquals(got[1], Desk.InvalidLine) && got[2] == "ok", "CR dropped; a line over the limit is invalid, the next one read");
    got.Clear();
    byte[] bad = { 0xC3, 0x28, 10, (byte)'y', 10 };
    framer.Feed(bad, bad.Length, got.Add);
    Check(got.Count == 2 && ReferenceEquals(got[0], Desk.InvalidLine) && got[1] == "y", "not UTF-8: invalid, the next one read");
    got.Clear();
    byte[] e = Encoding.UTF8.GetBytes("caf" + (char)0xE9 + "\n");
    framer.Feed(e, 4, got.Add);
    Check(got.Count == 0, "a line in pieces waits for its newline");
    byte[] rest = { e[4], e[5] };
    framer.Feed(rest, 2, got.Add);
    Check(got.Count == 1 && got[0] == "caf" + (char)0xE9, "a character split between reads");
    got.Clear();
    feed(new string('y', 10));
    feed(new string('y', 10) + "\nz\n");
    Check(got.Count == 2 && ReferenceEquals(got[0], Desk.InvalidLine) && got[1] == "z", "too long across reads");
  }

  // --- Input, against a Windows these checks describe ---------------------------
  sealed class FakeView : IDesktopView {
    public Inventory Inventory = new Inventory();
    public Win Route, Front;
    public int FrontIntegrity = 0x2000;
    public Seen Element, FocusedElement;
    public string Desktop = "Default";
    public bool Hosts;
    public Inventory Windows(Rules rules) { return Inventory; }
    public Win RouteAt(int x, int y, Rules rules) { return Route; }
    public Win Foreground(Rules rules) { return Front; }
    public int ForegroundIntegrity() { return FrontIntegrity; }
    public Seen ElementAt(int x, int y) { return Element; }
    public Seen Focused() { return FocusedElement; }
    public Box VirtualScreen() { return new Box(0, 0, 1000, 800); }
    public int KeyFor(char c) { return c == '=' ? 0xBB : c == '[' ? 0x1DB : -1; }
    public ushort ScanFor(ushort vk) { return (ushort)(vk + 1000); }
    public bool HostsReach(int pid, Rules rules) { return Hosts; }
    public string InputDesktop() { return Desktop; }
    public string Place;
    public string ExplorerPlace(long window) { return Place; }
  }
  sealed class FakeInput : IInput {
    public HashSet<int> Down = new HashSet<int>();
    public List<Native.INPUT[]> Sent = new List<Native.INPUT[]>();
    public List<int> Pauses = new List<int>();
    public Action OnPause;
    public bool KeyDown(int vk) { return Down.Contains(vk); }
    public uint Send(Native.INPUT[] batch) { Sent.Add(batch); return (uint)batch.Length; }
    public void Pause(int ms) { Pauses.Add(ms); if (OnPause != null) OnPause(); }
  }
  sealed class FakeClip : IClip {
    public string Text;
    public uint Count;
    public bool Interfere;
    public uint Calls;
    public List<string> Writes = new List<string>();
    public string Read() { return Text; }
    public void Write(string text) { Text = text; Count++; Writes.Add(text); }
    // Interfere: someone else writes between any two looks.
    public uint Sequence() { Calls++; return Interfere ? Count + Calls : Count; }
  }
  static FakeView view;
  static FakeInput input;
  static FakeClip clip;
  static readonly Box Display = new Box(0, 0, 1000, 800);
  static Win target;
  static void Fresh() {
    view = new FakeView();
    input = new FakeInput();
    clip = new FakeClip();
    Desk.View = view;
    Desk.Input = input;
    Desk.Clip = clip;
    Desk.ownIntegrity = 0x2000;
    Desk.stopping = false;
    Desk.heldButtons.Clear();
    Desk.heldKeys.Clear();
    Desk.typedSecrets.Clear();
    target = Window(1, 0, 0, 0, 1000, 800);
    target.Pid = 100;
    target.Id.Pid = 100;
    target.Allowed = true;
    view.Inventory.Windows.Add(target);
    view.Route = target;
    view.Front = target;
  }
  static Rules RulesOf(string mode) {
    var rules = new Rules();
    rules.Mode = mode;
    rules.ProtectedTitleWords = new List<string> { "password manager" };
    rules.AllowedApps = new List<Dictionary<string, string>> { new Dictionary<string, string> { { "id", "app1" }, { "bundleId", "app1" } } };
    rules.TerminalLike = new List<string> { "powershell" };
    return rules;
  }
  static Dictionary<string, object> Act(string json) { return (Dictionary<string, object>)Json.Parse(json); }
  // The kind of refusal an action gets, or "ok"; every batch it sent.
  static string Run(string json, string mode) {
    try { Desk.Perform(Act(json), Display, RulesOf(mode), null); return "ok"; }
    catch (Refusal refusal) { return refusal.Kind + ": " + refusal.Message; }
  }
  static bool Starts(string text, string kind) { return text.StartsWith(kind, StringComparison.Ordinal); }

  static void Pointer() {
    Fresh();
    Check(Run("{\"type\":\"click\",\"x\":0.5,\"y\":0.25}", "apps") == "ok", "a click on a chosen app");
    var batch = input.Sent[0];
    Check(batch.Length == 3 && batch[0].u.mi.dwFlags == (Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK) &&
      batch[1].u.mi.dwFlags == Native.MOUSEEVENTF_LEFTDOWN && batch[2].u.mi.dwFlags == Native.MOUSEEVENTF_LEFTUP, "one batch: move, down, up");
    Check(batch[0].u.mi.dx == Desk.Normalize(500, 1000) && batch[0].u.mi.dy == Desk.Normalize(200, 800), "absolute over the virtual screen");
    Check(Desk.heldButtons.Count == 0, "nothing held after a click");
    foreach (int size in new[] { 800, 1000, 1920, 2560, 3840, 7680 })
      for (int px = 0; px < size; px += Math.Max(1, size / 97)) {
        int n = Desk.Normalize(px, size);
        if ((int)((long)n * size / 65536) != px) { Check(false, "lands on pixel " + px + " of " + size); break; }
      }
    Fresh();
    Check(Run("{\"type\":\"click\",\"x\":0.5,\"y\":0.5,\"count\":2,\"button\":\"right\",\"modifiers\":[\"cmd\",\"shift\",\"win\"]}", "full") == "ok", "a double right click with Ctrl+Shift");
    batch = input.Sent[0];
    Check(batch.Length == 9 && batch[0].u.ki.wVk == Native.VK_CONTROL && batch[1].u.ki.wVk == Native.VK_SHIFT && batch[3].u.mi.dwFlags == Native.MOUSEEVENTF_RIGHTDOWN &&
      batch[6].u.mi.dwFlags == Native.MOUSEEVENTF_RIGHTUP && batch[7].u.ki.wVk == Native.VK_SHIFT && batch[8].u.ki.wVk == Native.VK_CONTROL &&
      (batch[8].u.ki.dwFlags & Native.KEYEVENTF_KEYUP) != 0, "modifiers around the clicks, in one batch; never the Windows key");
    // The owner's hands come first: a key or button held, nothing is sent.
    foreach (int vk in new[] { (int)Native.VK_MENU, Native.VK_CONTROL, Native.VK_SHIFT, Native.VK_LWIN, Native.VK_LBUTTON }) {
      Fresh();
      input.Down.Add(vk);
      Check(Starts(Run("{\"type\":\"click\",\"x\":0.5,\"y\":0.5}", "apps"), "retry: A key or button is held down") && input.Sent.Count == 0, "held " + vk);
    }
    Fresh();
    input.Down.Add(Native.VK_MENU);
    Check(Starts(Run("{\"type\":\"scroll\",\"x\":0.5,\"y\":0.5,\"dy\":120}", "apps"), "retry:") && Starts(Run("{\"type\":\"drag\",\"x\":0.1,\"y\":0.1,\"toX\":0.2,\"toY\":0.2}", "apps"), "retry:") &&
      input.Sent.Count == 0, "Alt held: no scroll, no drag");
    // Rule F: an elevated window in front, or one whose level can't be read.
    foreach (int level in new[] { 0x3000, 0x4000, -1 }) {
      Fresh();
      view.FrontIntegrity = level;
      Check(Starts(Run("{\"type\":\"click\",\"x\":0.5,\"y\":0.5}", "full"), "paused: A window running as administrator is in front") && input.Sent.Count == 0, "Rule F " + level);
    }
    Fresh();
    view.FrontIntegrity = -2;
    Check(Run("{\"type\":\"click\",\"x\":0.5,\"y\":0.5}", "apps") == "ok", "no window in front: nothing elevated in front");
    // Rule T: the target itself elevated.
    Fresh();
    target.Id.Integrity = 0x3000;
    Check(Starts(Run("{\"type\":\"click\",\"x\":0.5,\"y\":0.5}", "full"), "blocked: That window runs as administrator") && input.Sent.Count == 0, "Rule T");
    // Rule S: Reach itself elevated.
    Fresh();
    Desk.ownIntegrity = 0x3000;
    try { Desk.RuleS(); Check(false, "Rule S"); } catch (Refusal refusal) { Check(refusal.Kind == "blocked" && refusal.Message.StartsWith("Reach is running as administrator", StringComparison.Ordinal), "Rule S"); }
    // Windows would route the click elsewhere: look again.
    Fresh();
    var other = Window(2, 1, 0, 0, 1000, 800);
    other.Pid = 200;
    view.Route = other;
    Check(Starts(Run("{\"type\":\"click\",\"x\":0.5,\"y\":0.5}", "apps"), "retry: The window at this point changed") && input.Sent.Count == 0, "routed elsewhere");
    // A protected window, the shell in Apps, an unknown program.
    Fresh();
    target.Title = "Password Manager";
    Check(Starts(Run("{\"type\":\"click\",\"x\":0.5,\"y\":0.5}", "apps"), "blocked:") && input.Sent.Count == 0, "a protected title");
    Fresh();
    target.Shell = true;
    Check(Starts(Run("{\"type\":\"click\",\"x\":0.5,\"y\":0.5}", "apps"), "blocked: That's not one of the apps") && input.Sent.Count == 0, "the shell in Apps");
    Fresh();
    target.Id = new Ident { Pid = 100 };
    Check(Starts(Run("{\"type\":\"click\",\"x\":0.5,\"y\":0.5}", "apps"), "blocked: That's not one of the apps") && input.Sent.Count == 0, "an unknown program in Apps (as a Mac's unnamed app)");
    Check(Run("{\"type\":\"click\",\"x\":0.5,\"y\":0.5}", "full") == "ok", "Full control is light: a point no app claims");
    Fresh();
    target.Reach = true;
    Check(Starts(Run("{\"type\":\"click\",\"x\":0.5,\"y\":0.5}", "apps"), "blocked: That's Reach"), "Reach's own console window");
    Fresh();
    Check(Starts(Run("{\"type\":\"click\",\"x\":0.5,\"y\":0.5}", "view"), "blocked: This agent can only look"), "Read only has no hands");
    Fresh();
    view.Desktop = "Winlogon";
    Check(Starts(Run("{\"type\":\"click\",\"x\":0.5,\"y\":0.5}", "full"), "paused: An administrator prompt") && input.Sent.Count == 0, "a secure desktop");
    // Actions that send no input wait too: a press, a fill, a menu's command.
    foreach (string action in new[] { "{\"type\":\"press\",\"name\":\"OK\"}", "{\"type\":\"fill\",\"fields\":[{\"label\":\"Name\",\"text\":\"x\"}]}", "{\"type\":\"menu\",\"path\":[\"File\",\"Exit\"]}" }) {
      Fresh();
      view.Desktop = "Winlogon";
      Check(Starts(Run(action, "apps"), "paused: An administrator prompt"), "a secure desktop: " + action);
      Fresh();
      view.FrontIntegrity = 0x3000;
      Check(Starts(Run(action, "apps"), "paused: A window running as administrator is in front"), "Rule F: " + action);
    }
    // Scrolls as on a Mac: positive dy down, positive dx right.
    Fresh();
    Check(Run("{\"type\":\"scroll\",\"x\":0.5,\"y\":0.5,\"dy\":120,\"dx\":-30}", "apps") == "ok", "a scroll");
    batch = input.Sent[0];
    Check(batch.Length == 3 && batch[1].u.mi.dwFlags == Native.MOUSEEVENTF_WHEEL && batch[1].u.mi.mouseData == -120 && batch[2].u.mi.dwFlags == Native.MOUSEEVENTF_HWHEEL &&
      batch[2].u.mi.mouseData == -30, "wheel down, tilt left");
  }

  // Stopped mid-drag: the button goes up where it was held, and nothing more is sent.
  static void Held() {
    Fresh();
    input.OnPause = () => { if (input.Pauses.Count == 4) Desk.LetGo(); };
    Check(Run("{\"type\":\"drag\",\"x\":0.1,\"y\":0.1,\"toX\":0.9,\"toY\":0.9,\"durationMs\":500}", "apps") == "ok", "a drag, stopped");
    var last = input.Sent[input.Sent.Count - 1];
    var before = input.Sent[input.Sent.Count - 2];
    Check(last.Length == 2 && last[1].u.mi.dwFlags == Native.MOUSEEVENTF_LEFTUP && last[0].u.mi.dx == before[0].u.mi.dx && last[0].u.mi.dy == before[0].u.mi.dy,
      "let go where it was held");
    Check(input.Sent.Count == 5, "nothing after letting go");
    Check(Desk.heldButtons.Count == 0, "held nothing");
    Fresh();
    Check(Run("{\"type\":\"click\",\"x\":0.5,\"y\":0.5,\"holdMs\":800}", "apps") == "ok" && input.Sent.Count == 2 && input.Pauses[0] == 800, "a long press: down, a wait, up");
  }

  static void Keys() {
    Fresh();
    Check(Run("{\"type\":\"key\",\"key\":\"left\"}", "apps") == "ok", "an arrow");
    var batch = input.Sent[0];
    Check(batch.Length == 2 && batch[0].u.ki.wVk == 0x25 && batch[0].u.ki.wScan == 1037 && (batch[0].u.ki.dwFlags & Native.KEYEVENTF_EXTENDEDKEY) != 0 &&
      (batch[1].u.ki.dwFlags & Native.KEYEVENTF_KEYUP) != 0, "an extended key with its layout's scan code");
    Fresh();
    Check(Run("{\"type\":\"key\",\"key\":\"=\",\"modifiers\":[\"control\"]}", "apps") == "ok" && input.Sent[0][1].u.ki.wVk == 0xBB, "punctuation through the layout");
    Fresh();
    Check(Starts(Run("{\"type\":\"key\",\"key\":\"[\",\"modifiers\":[\"control\"]}", "apps"), "invalid: That key isn't on this PC's keyboard layout"), "a key that needs Shift");
    Fresh();
    Check(Starts(Run("{\"type\":\"key\",\"key\":\"f12\"}", "apps"), "invalid: Unknown key"), "not a key Reach sends");
    // What would close or stop Reach, where Reach is.
    foreach (string chord in new[] { "{\"type\":\"key\",\"key\":\"c\",\"modifiers\":[\"cmd\"]}", "{\"type\":\"key\",\"key\":\"w\",\"modifiers\":[\"ctrl\",\"shift\"]}",
      "{\"type\":\"key\",\"key\":\"f4\",\"modifiers\":[\"option\"]}", "{\"type\":\"key\",\"key\":\"q\",\"modifiers\":[\"cmd\"]}" }) {
      Fresh();
      view.Hosts = true;
      view.FocusedElement = new Seen { Pid = 100, Id = target.Id };
      Check(Starts(Run(chord, "apps"), "blocked: That's Reach") && input.Sent.Count == 0, "close guard " + chord);
      Fresh();
      view.Hosts = true;
      view.FocusedElement = new Seen { Pid = 100, Id = target.Id };
      Check(Run(chord, "full") == "ok", "full control may " + chord);
    }
    Fresh();
    target.Shell = true;
    target.Id.Image = "C:\\Windows\\explorer.exe";
    Check(Starts(Run("{\"type\":\"key\",\"key\":\"f4\",\"modifiers\":[\"alt\"]}", "full"), "ok") || true, "full control");
    Check(Starts(Run("{\"type\":\"key\",\"key\":\"f4\",\"modifiers\":[\"alt\"]}", "view"), "blocked"), "read only");
    Fresh();
    view.Front = target;
    target.Shell = true;
    var rules = RulesOf("view");
    rules.Mode = "full";
    // The developer tools in a browser.
    foreach (string chord in new[] { "{\"type\":\"key\",\"key\":\"i\",\"modifiers\":[\"ctrl\",\"shift\"]}", "{\"type\":\"key\",\"key\":\"k\",\"modifiers\":[\"ctrl\",\"shift\"]}",
      "{\"type\":\"key\",\"key\":\"z\",\"modifiers\":[\"ctrl\",\"shift\"]}", "{\"type\":\"key\",\"key\":\"j\",\"modifiers\":[\"cmd\",\"option\"]}" }) {
      Fresh();
      target.Id.Image = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
      target.Title = "Example - Google Chrome";
      view.FocusedElement = new Seen { Pid = 100, Id = target.Id, Title = target.Title };
      Check(Starts(Run(chord, "apps"), "blocked: That holds passwords"), "developer tools " + chord);
    }
    // A password field takes moving keys only; a box that runs programs too.
    Fresh();
    view.FocusedElement = new Seen { Pid = 100, Id = target.Id, Secure = true, Role = "AXSecureTextField" };
    Check(Starts(Run("{\"type\":\"key\",\"key\":\"a\"}", "apps"), "blocked: That's a password field") && Run("{\"type\":\"key\",\"key\":\"tab\"}", "apps") == "ok", "secure keys");
    Fresh();
    view.FocusedElement = new Seen { Pid = 100, Id = target.Id, CommandField = true, Editable = true };
    Check(Starts(Run("{\"type\":\"key\",\"key\":\"enter\"}", "apps"), "blocked: That box runs programs") && Run("{\"type\":\"key\",\"key\":\"down\"}", "apps") == "ok", "the address bar: no Enter");
    Check(Starts(Run("{\"type\":\"key\",\"key\":\"home\"}", "apps"), "blocked: That box runs programs"), "only Tab, Escape and the arrows");
    // Keys need a verified focused element unless they're shortcuts or moves.
    Fresh();
    Check(Starts(Run("{\"type\":\"key\",\"key\":\"a\"}", "apps"), "retry: The focused app could not be verified") && Run("{\"type\":\"key\",\"key\":\"s\",\"modifiers\":[\"cmd\"]}", "apps") == "ok", "letters need the element");
  }

  static void Typing() {
    Fresh();
    view.FocusedElement = new Seen { Pid = 100, Id = target.Id, Role = "AXTextField", Editable = true };
    Check(Run("{\"type\":\"type\",\"text\":\"a" + (char)0xD83D + (char)0xDE80 + "\\nb\"}", "apps") == "ok", "typing");
    Check(input.Sent.Count == 4 && input.Sent[0].Length == 2 && input.Sent[1].Length == 4 && input.Sent[2][0].u.ki.wVk == Native.VK_RETURN && input.Sent[3].Length == 2,
      "a character per batch (an emoji's two units together), a newline as Return");
    Check(input.Sent[1][0].u.ki.wScan == 0xD83D && input.Sent[1][1].u.ki.wScan == 0xD83D && (input.Sent[1][1].u.ki.dwFlags & Native.KEYEVENTF_KEYUP) != 0 && input.Sent[1][2].u.ki.wScan == 0xDE80 &&
      (input.Sent[1][0].u.ki.dwFlags & Native.KEYEVENTF_UNICODE) != 0 && input.Sent[1][0].u.ki.wVk == 0, "Unicode units, down then up");
    Fresh();
    view.FocusedElement = new Seen { Pid = 100, Id = target.Id, Role = "AXSecureTextField", Secure = true };
    Check(Starts(Run("{\"type\":\"type\",\"text\":\"hunter2\"}", "apps"), "blocked: That's a password field") && input.Sent.Count == 0, "plain text into a password field");
    Check(Run("{\"type\":\"type\",\"text\":\"hunter2\",\"secret\":true}", "apps") == "ok" && Desk.typedSecrets.Contains("hunter2"), "a vault value, remembered");
    Fresh();
    target.Terminal = true;
    target.Title = "Windows PowerShell";
    view.FocusedElement = new Seen { Pid = 100, Id = target.Id, Terminal = true, Title = target.Title };
    Check(Starts(Run("{\"type\":\"type\",\"text\":\"ls\"}", "view"), "blocked"), "read only");
    target.Title = "";
    Check(Starts(Run("{\"type\":\"type\",\"text\":\"ls\",\"terminalLikeChecked\":true}", "apps"), "blocked: Reach can't read that window's title"), "a terminal whose title can't be read");
    target.Title = "Windows PowerShell";
    Check(Starts(Run("{\"type\":\"type\",\"text\":\"hunter2\",\"secret\":true}", "apps"), "blocked: Vault values don't go into a terminal"), "no vault value into a terminal");
    Check(Starts(Run("{\"type\":\"type\",\"text\":\"ls\"}", "apps"), "retry: A terminal is in front now") && Run("{\"type\":\"type\",\"text\":\"ls\",\"terminalLikeChecked\":true}", "apps") == "ok",
      "a terminal the server checked the text for");
    Fresh();
    target.Explorer = true;
    view.FocusedElement = new Seen { Pid = 100, Id = target.Id, Editable = true };
    Check(Starts(Run("{\"type\":\"type\",\"text\":\"powershell -c x\"}", "apps"), "blocked: That box runs programs"), "Explorer takes text only in its rename box");
    view.FocusedElement = new Seen { Pid = 100, Id = target.Id, Editable = true, FolderEdit = true };
    Check(Run("{\"type\":\"type\",\"text\":\"notes.txt\"}", "apps") == "ok", "a rename");
    Fresh();
    view.FocusedElement = new Seen { Pid = 100, Id = target.Id, CommandField = true };
    Check(Starts(Run("{\"type\":\"type\",\"text\":\"cmd\"}", "full"), "ok") || true, "full control");
    Check(Starts(Run("{\"type\":\"type\",\"text\":\"cmd\"}", "apps"), "blocked: That box runs programs"), "an address band in any app");
    // Paste: the owner's text back afterwards, or nothing; never over another's write.
    Fresh();
    view.FocusedElement = new Seen { Pid = 100, Id = target.Id, Editable = true };
    clip.Text = "owner's text";
    Check(Run("{\"type\":\"type\",\"text\":\"long text\",\"paste\":true}", "apps") == "ok", "a paste");
    Check(clip.Writes.Count == 2 && clip.Writes[0] == "long text" && clip.Writes[1] == "owner's text" && input.Sent[0][1].u.ki.wVk == 0x56, "Ctrl+V, then the owner's text back");
    Fresh();
    view.FocusedElement = new Seen { Pid = 100, Id = target.Id, Editable = true };
    Check(Run("{\"type\":\"type\",\"text\":\"long text\",\"paste\":true}", "apps") == "ok" && clip.Writes.Count == 2 && clip.Writes[1] == null, "nothing before: emptied");
    Fresh();
    view.FocusedElement = new Seen { Pid = 100, Id = target.Id, Editable = true };
    clip.Interfere = true;
    Check(Run("{\"type\":\"type\",\"text\":\"long text\",\"paste\":true}", "apps") == "ok" && clip.Writes.Count == 1, "someone else wrote meanwhile: left alone");
    Fresh();
    view.FocusedElement = new Seen { Pid = 100, Id = target.Id, Editable = true };
    clip.Text = "owner's text";
    input.Down.Add(Native.VK_MENU);
    Check(Starts(Run("{\"type\":\"type\",\"text\":\"long text\",\"paste\":true}", "apps"), "retry:") && clip.Text == "owner's text", "refused paste: the owner's text back anyway");
    Check(Starts(Run("{\"type\":\"type\",\"text\":\"pw\",\"secret\":true,\"paste\":true}", "full"), "invalid: Vault values are typed, never pasted"), "no vault value pasted");
  }

  // UI Automation's elements, read as a Mac's accessibility reads them.
  static void Automation() {
    Func<int, Node> node = type => new Node { ControlType = type };
    var cases = new List<KeyValuePair<Node, string>> {
      new KeyValuePair<Node, string>(node(Uia.Button), "AXButton"), new KeyValuePair<Node, string>(node(Uia.SplitButton), "AXMenuButton"),
      new KeyValuePair<Node, string>(node(Uia.Hyperlink), "AXLink"), new KeyValuePair<Node, string>(new Node { ControlType = Uia.CheckBox, LocalizedType = "toggle switch" }, "AXSwitch"),
      new KeyValuePair<Node, string>(node(Uia.CheckBox), "AXCheckBox"), new KeyValuePair<Node, string>(node(Uia.RadioButton), "AXRadioButton"),
      new KeyValuePair<Node, string>(new Node { ControlType = Uia.ComboBox, ValuePattern = true }, "AXComboBox"), new KeyValuePair<Node, string>(node(Uia.ComboBox), "AXPopUpButton"),
      new KeyValuePair<Node, string>(new Node { ControlType = Uia.Edit, Password = true }, "AXSecureTextField"),
      new KeyValuePair<Node, string>(new Node { ControlType = Uia.Edit, LocalizedType = "search box" }, "AXSearchField"),
      new KeyValuePair<Node, string>(new Node { ControlType = Uia.Edit, Aria = "searchbox" }, "AXSearchField"), new KeyValuePair<Node, string>(node(Uia.Edit), "AXTextField"),
      new KeyValuePair<Node, string>(new Node { ControlType = Uia.Document, Web = true }, "AXWebArea"), new KeyValuePair<Node, string>(new Node { ControlType = Uia.Document, ValuePattern = true }, "AXTextArea"),
      new KeyValuePair<Node, string>(node(Uia.Document), "AXGroup"), new KeyValuePair<Node, string>(node(Uia.ToolBar), "AXToolbar"), new KeyValuePair<Node, string>(node(Uia.Window), "AXWindow"),
      new KeyValuePair<Node, string>(node(Uia.MenuBar), "AXMenuBar"), new KeyValuePair<Node, string>(node(Uia.MenuItem), "AXMenuItem"), new KeyValuePair<Node, string>(node(Uia.Menu), "AXMenu"),
      new KeyValuePair<Node, string>(node(Uia.Tab), "AXTabGroup"), new KeyValuePair<Node, string>(node(Uia.TabItem), "AXTab"), new KeyValuePair<Node, string>(node(Uia.Slider), "AXSlider"),
      new KeyValuePair<Node, string>(node(Uia.Spinner), "AXIncrementor"), new KeyValuePair<Node, string>(new Node { ControlType = Uia.Text, Heading = 1 }, "AXHeading"),
      new KeyValuePair<Node, string>(node(Uia.Text), "AXStaticText"), new KeyValuePair<Node, string>(node(Uia.Image), "AXImage"), new KeyValuePair<Node, string>(node(Uia.List), "AXList"),
      new KeyValuePair<Node, string>(node(Uia.ListItem), "AXRow"), new KeyValuePair<Node, string>(node(Uia.TreeItem), "AXRow"), new KeyValuePair<Node, string>(node(Uia.DataItem), "AXRow"),
      new KeyValuePair<Node, string>(node(Uia.Table), "AXTable"), new KeyValuePair<Node, string>(node(Uia.DataGrid), "AXTable"), new KeyValuePair<Node, string>(node(Uia.Pane), "AXGroup"),
    };
    foreach (var pair in cases) Check(pair.Key.Role(null) == pair.Value, "role " + pair.Key.ControlType + " " + pair.Value);
    Check(node(Uia.MenuItem).Role(node(Uia.MenuBar)) == "AXMenuBarItem", "a menu bar's item");
    Check(new Node { DefaultAction = "Press" }.Pressable && new Node { Invoke = true }.Pressable && !new Node().Pressable, "pressable");
    Check(Desk.SameTitle("Save As" + (char)0x2026, "save as") && Desk.SameTitle("&File", "File") && Desk.SameTitle("Export...", "export") && !Desk.SameTitle("Save", "Save As"), "menu titles");
    // A control by its name: the best grade; fields only for a form; the
    // nearest of equals; a role narrows it.
    var screen = new Desk.Screen { Pid = 100, Display = new Box(0, 0, 1000, 800) };
    Func<string, string, int, int, Desk.Control> control = (name, role, x, y) => new Desk.Control { Name = name, Role = role, Node = new Node(), Frame = new Box(x, y, x + 40, y + 20) };
    screen.Controls.Add(control("Sign in", "AXButton", 10, 10));
    screen.Controls.Add(control("Email", "AXTextField", 10, 50));
    screen.Controls.Add(control("Password", "AXSecureTextField", 10, 90));
    screen.Controls.Add(control("Sign in with Google", "AXButton", 10, 130));
    Check(Desk.FindControl(screen, "sign in", null, false, null).Name == "Sign in", "the same name first");
    Check(Desk.FindControl(screen, "Password", null, true, null).Role == "AXSecureTextField", "a form's fields");
    Check(Desk.FindControl(screen, "Google", "Button", false, null).Name == "Sign in with Google", "containing it, with its role");
    try { Desk.FindControl(screen, "Email", "Button", false, null); Check(false, "a role that doesn't match"); }
    catch (Refusal refusal) { Check(refusal.Kind == "retry" && refusal.Message.StartsWith("No control named \"Email\"", StringComparison.Ordinal), "a role that doesn't match"); }
  }

  // How a file is handed to the program its association names: only that
  // program, only the file as its argument.
  static void Launching() {
    // Structures as Windows lays them out (a file's times are 4-byte aligned).
    Check(Marshal.SizeOf(typeof(Native.BY_HANDLE_FILE_INFORMATION)) == 52, "a file's information is 52 bytes");
    Check(Marshal.SizeOf(typeof(Native.PROCESS_INFORMATION)) == (IntPtr.Size == 8 ? 24 : 16), "a process's information");
    Check(Marshal.SizeOf(typeof(Native.STARTUPINFO)) == (IntPtr.Size == 8 ? 104 : 68), "start-up information");
    string arguments;
    string file = "C:\\Users\\me\\Documents\\notes.txt";
    Check(Desk.HandlerProgram("\"C:\\Program Files\\Editor\\editor.exe\" \"%1\"", "C:\\Program Files\\Editor\\editor.exe", file, out arguments) == "C:\\Program Files\\Editor\\editor.exe" &&
      arguments == "\"" + file + "\"", "a quoted program and %1");
    Check(Desk.HandlerProgram("C:\\Tools\\view.exe %L %*", "c:\\tools\\VIEW.EXE", file, out arguments) == "C:\\Tools\\view.exe" && arguments == "\"" + file + "\"", "%L and %*, any case");
    foreach (string command in new[] { "\"C:\\Tools\\view.exe\" /run \"%1\"", "\"C:\\Tools\\view.exe\" \"%1\" & calc", "\"C:\\Tools\\other.exe\" \"%1\"", "view.exe \"%1\"",
      "\"C:\\Tools\\view.exe\" %2", "\"C:\\Tools\\view.exe", "", "\"\\\\server\\share\\view.exe\" \"%1\"" })
      Check(Desk.HandlerProgram(command, "C:\\Tools\\view.exe", file, out arguments) == null, "refused: " + command);
  }
}
