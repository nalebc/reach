// The Windows agent helper's own decisions (scripts/native/agent-desktop.cs),
// checked against windows, inputs and lines these checks describe: nothing
// here calls Windows. Compiled together with the helper (csc /main:DesktopChecks)
// by test/agent-desktop-windows-policy.test.mjs on Windows. C# 5.
using System;
using System.Collections.Generic;
using System.Text;

static class DesktopChecks {
  static int failures;
  static void Check(bool ok, string label) { if (!ok) { failures++; Console.WriteLine("FAILED: " + label); } }
  static Ident Known(string bundle) {
    return new Ident { Pid = 100, Created = 1, Bundle = bundle, Path = bundle, Image = "C:\\Apps\\" + bundle + ".exe", Name = bundle, Known = true };
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
}
