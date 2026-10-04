// Run only through osascript -l JavaScript. Payload travels over stdin, not code.
ObjC.import("Foundation");
ObjC.import("AppKit");
function run() {
  try {
    var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    var payload = JSON.parse(
      ObjC.unwrap(
        $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding),
      ),
    );
    var bundle =
      payload.provider === "terminal"
        ? "com.apple.Terminal"
        : "com.googlecode.iterm2";
    var instances =
      $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundle);
    if (Number(instances.count) === 0 && payload.action !== "create")
      return JSON.stringify(
        payload.action === "list"
          ? { sessions: [], running: false }
          : { error: "This terminal app is no longer running.", status: 404 },
      );
    var app = Application(bundle);
    if (payload.action === "create") {
      // An explicit user action is the only operation allowed to launch an app.
      // A shortcut may run one command in the new window (e.g. `cd … && codex`).
      var command = typeof payload.command === "string" ? payload.command : "";
      if (payload.provider === "terminal") app.doScript(command);
      else {
        var created = app.createWindowWithDefaultProfile();
        if (command) created.currentSession().write({ text: command });
      }
      if (command) app.activate();
      return JSON.stringify({ ok: true });
    }
    var instance = instances.objectAtIndex(0);
    var epoch =
      String(instance.processIdentifier) +
      ":" +
      String(instance.launchDate.timeIntervalSince1970);
    var found = null,
      sessions = [];
    var windows = app.windows();
    for (var wi = 0; wi < windows.length; wi++) {
      var win = windows[wi],
        tabs = win.tabs();
      for (var ti = 0; ti < tabs.length; ti++) {
        var tab = tabs[ti];
        var panes = payload.provider === "terminal" ? [tab] : tab.sessions();
        for (var si = 0; si < panes.length; si++) {
          var pane = panes[si];
          var tty = pane.tty();
          var nativeId =
            payload.provider === "terminal" ? tty : pane.uniqueId();
          var target = {
            epoch: epoch,
            window: String(win.id()),
            session: nativeId,
          };
          var name =
            payload.provider === "terminal"
              ? pane.customTitle() || win.name()
              : pane.name();
          sessions.push({
            target: target,
            name: String(name).slice(0, 160),
            tty: tty,
          });
          if (
            payload.target &&
            JSON.stringify(target) === JSON.stringify(payload.target)
          )
            found = { pane: pane, tab: tab, win: win };
        }
      }
    }
    if (payload.action === "list")
      return JSON.stringify({ sessions: sessions, running: true });
    if (!found)
      return JSON.stringify({
        error: "This terminal has closed. Refresh the list.",
        status: 404,
      });
    if (payload.action === "read")
      return JSON.stringify({
        text: String(found.pane.contents()).slice(-128000),
      });
    if (payload.action === "send") {
      if (payload.provider === "terminal")
        app.doScript(payload.text, { in: found.pane });
      else found.pane.write({ text: payload.text, newline: true });
    } else if (payload.action === "focus") {
      if (payload.provider === "terminal") {
        found.pane.selected = true;
        found.win.index = 1;
      } else {
        found.tab.select();
        found.pane.select();
        found.win.select();
      }
      app.activate();
    } else if (payload.action === "close") {
      if (payload.provider === "terminal") app.close(found.pane);
      else found.pane.close();
    } else throw Error("Unknown terminal operation.");
    return JSON.stringify({ ok: true });
  } catch (e) {
    var denied =
      String(e).indexOf("-1743") >= 0 ||
      /not authorized|not permitted/i.test(String(e));
    return JSON.stringify({
      error: denied
        ? "Allow Automation access to this terminal app in macOS System Settings → Privacy & Security → Automation, then try again."
        : "The terminal app could not complete this action. Check the Mac for a permission or close-confirmation dialog.",
      status: denied ? 403 : 502,
    });
  }
}
