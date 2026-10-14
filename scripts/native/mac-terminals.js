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
          // A Terminal tab whose command has finished stays open on
          // "[Process completed]" with nothing running in it.
          var ended = false;
          if (payload.action === "list" && payload.provider === "terminal") {
            try {
              ended = pane.processes().length === 0;
            } catch (e) {}
          }
          sessions.push({
            target: target,
            name: String(name).slice(0, 160),
            tty: tty,
            ended: ended,
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
    if (payload.action === "read") {
      // A Terminal tab's `contents` is only what fits on screen; `history`
      // is its whole scrollback, asked for only by a phone viewing the tab
      // (it can be large). iTerm2 offers only the visible text.
      var text;
      if (payload.scrollback && payload.provider === "terminal")
        try {
          text = found.pane.history();
        } catch (e) {}
      if (text === undefined || text === null) text = found.pane.contents();
      return JSON.stringify({ text: String(text).slice(-128000) });
    }
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
      if (payload.provider === "terminal") {
        var left = closeTerminalTab(app, found);
        if (left) return JSON.stringify(left);
      } else found.pane.close();
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

// Terminal closes windows, not tabs (a tab doesn't understand close), and
// asks on the Mac before it ends what runs in one. The phone has asked
// already ("Anything running in it will stop"), so what runs in the tab ends
// first, as Terminal's own Terminate ends it: a hangup to each of the
// owner's programs on the tab's terminal. With nothing left running in it,
// its window then closes if the tab was its only one; one tab among others
// stays, ended, and leaves the list. Nothing is ever left asking on the Mac:
// if something keeps running, the tab stays as it is and the phone is told.
function closeTerminalTab(app, found) {
  var tty = String(found.pane.tty());
  if (!/^\/dev\/ttys\d+$/.test(tty))
    return { error: "This terminal could not be closed. Refresh the list.", status: 502 };
  var running = function () {
    try {
      return found.pane.processes().length > 0;
    } catch (e) {
      return false;
    }
  };
  if (running()) {
    var shell = Application.currentApplication();
    shell.includeStandardAdditions = true;
    shell.doShellScript(
      "/bin/ps -t " + tty.slice(5) + " -o pid= -o uid= | /usr/bin/awk -v me=\"$(/usr/bin/id -u)\" '$2 == me { print $1 }' | /usr/bin/xargs /bin/kill -HUP 2>/dev/null; exit 0",
    );
    for (var i = 0; i < 50 && running(); i++) delay(0.1);
  }
  if (running())
    return { error: "Something in this terminal is still running. Close it on the Mac.", status: 409 };
  // Its window may have closed with it already (as the owner's profile says).
  var alone = false;
  try {
    alone = found.win.tabs().length === 1;
  } catch (e) {}
  if (alone) app.close(found.win);
  return null;
}
