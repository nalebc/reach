// Fixed JXA transport for the two macOS browser scripting dictionaries.
// stdin carries data; never interpolate agent input into AppleScript or a shell.
ObjC.import("Foundation");
function run() {
  var request;
  try {
    var raw = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    request = JSON.parse(
      ObjC.unwrap(
        $.NSString.alloc.initWithDataEncoding(raw, $.NSUTF8StringEncoding),
      ),
    );
    return browserRequest(request);
  } catch (error) {
    // Never let osascript turn a bridge exception into a raw file-path error.
    if (error && error.publicMessage)
      return JSON.stringify({
        error: error.publicMessage,
        code: error.code,
        uncertain: error.uncertain === true,
      });
    var detail = String(error) + " " + String((error && error.message) || "");
    var browser = (request && request.browser) || "the browser";
    var denied = /-1743|-1744|not authorized|not permitted/i.test(detail);
    var scripting =
      /JavaScript.*(Apple Events|AppleScript|disabled|turned off|not allowed)|Allow JavaScript from Apple Events/i.test(
        detail,
      );
    var timedOut = /-1712|timed out/i.test(detail);
    return JSON.stringify({
      error: denied
        ? "The owner needs to allow Reach’s Terminal to control " +
          browser +
          " in System Settings → Privacy & Security → Automation."
        : scripting
          ? "The owner needs to enable Allow JavaScript from Apple Events in " +
            browser +
            "."
          : request && request.op === "preflight" && !timedOut
            ? "Browser scripting could not be verified. The owner should check the browser’s scripting setting and macOS Automation access, then try again."
            : "The browser command could not be verified. Inspect the browser before continuing.",
      code:
        denied ||
        scripting ||
        (request && request.op === "preflight" && !timedOut)
          ? "setup_required"
          : "browser_changed",
      uncertain:
        timedOut ||
        (!denied && !scripting && !(request && request.op === "preflight")),
    });
  }
}
function refuse(message, code, uncertain) {
  throw {
    publicMessage: message,
    code: code || "browser_changed",
    uncertain: uncertain === true,
  };
}
function browserRequest(request) {
  if (["Chrome", "Safari"].indexOf(request.browser) < 0)
    refuse("Choose Chrome or Safari.", "invalid");
  var chrome = request.browser === "Chrome";
  var app = Application(
    request.appPath || (chrome ? "Google Chrome" : "Safari"),
  );
  if (!app.running())
    return JSON.stringify({
      error: "The selected browser is not running.",
      code: "browser_closed",
    });
  function record(window, tab, index) {
    return {
      window: window.id(),
      tab: chrome ? tab.id() : index,
      index: index,
      url: tab.url() || "",
      title: (chrome ? tab.title() : tab.name()) || "",
    };
  }
  function tabs() {
    var result = [];
    app.windows().forEach(function (window) {
      window.tabs().forEach(function (tab, index) {
        result.push(record(window, tab, index + 1));
      });
    });
    return result;
  }
  if (request.op === "preflight") {
    if (!/^[0-9a-f-]{36}$/i.test(request.probeId || ""))
      refuse("The browser setup check is invalid.", "invalid");
    var windows = app.windows();
    if (request.window !== undefined) {
      windows = windows.filter(function (window) {
        return window.id() === request.window;
      });
      if (windows.length !== 1) refuse("The target browser window is gone.");
    }
    if (!windows.length || !windows[0].tabs().length)
      refuse(
        "The owner needs to open a " +
          request.browser +
          " window" +
          (chrome ? " and select a profile" : "") +
          " before using browser tools.",
        "browser_window_required",
      );
    var window = windows[0],
      windowId = window.id();
    var probeURL = "about:blank#reach-tool-check-" + request.probeId;
    var probe, failure;
    try {
      window.tabs.push(app.Tab({ url: probeURL }));
      var matches = window.tabs().filter(function (tab) {
        return tab.url() === probeURL;
      });
      if (matches.length !== 1)
        refuse(
          "The browser did not acknowledge its setup check. Inspect it before continuing.",
          "browser_changed",
          true,
        );
      probe = matches[0];
      var value;
      for (var attempt = 0; attempt < 40; attempt++) {
        if (probe.url() !== probeURL)
          refuse(
            "The browser setup tab changed. No task action was taken.",
            "browser_changed",
          );
        value = chrome
          ? probe.execute({ javascript: '"reach.browser.ready.v1"' })
          : app.doJavaScript('"reach.browser.ready.v1"', { in: probe });
        if (value === "reach.browser.ready.v1") break;
        $.NSThread.sleepForTimeInterval(0.05);
      }
      if (value !== "reach.browser.ready.v1")
        refuse(
          "The browser’s scripting setup could not be verified.",
          "setup_required",
        );
    } catch (error) {
      failure = error;
    }
    // Only close our nonce-addressed blank tab. If the owner navigated it or
    // changed the window, leave their page alone. Safari tab indexes can shift.
    try {
      var owners = app.windows().filter(function (candidate) {
        return candidate.id() === windowId;
      });
      if (owners.length === 1) {
        var remaining = owners[0].tabs().filter(function (tab) {
          return tab.url() === probeURL;
        });
        if (remaining.length === 1) remaining[0].close();
      }
    } catch (cleanupError) {
      refuse(
        "The browser setup check could not be closed. Inspect the browser before continuing.",
        "browser_changed",
        true,
      );
    }
    if (failure) throw failure;
    return JSON.stringify({ ok: true });
  }
  if (request.op === "tabs") return JSON.stringify(tabs());
  if (request.op === "create") {
    var windows = app.windows();
    if (!windows.length) {
      if (chrome) {
        app.windows.push(app.Window());
      } else {
        app.documents.push(app.Document({ url: request.url }));
      }
      for (var attempt = 0; attempt < 40; attempt++) {
        windows = app.windows();
        if (windows.length && windows[0].tabs().length) break;
        $.NSThread.sleepForTimeInterval(0.05);
      }
      if (!windows.length || !windows[0].tabs().length)
        refuse(
          "The new browser window has not acknowledged creation. Inspect it before continuing.",
          "browser_changed",
          true,
        );
      var first = windows[0].tabs()[0];
      if (chrome) first.url = request.url;
      return JSON.stringify(record(windows[0], first, 1));
    }
    var window = windows[0],
      tab = app.Tab({ url: request.url });
    window.tabs.push(tab);
    var all = window.tabs();
    return JSON.stringify(record(window, all[all.length - 1], all.length));
  }
  var matches = app.windows().filter(function (window) {
    return window.id() === request.target.window;
  });
  if (matches.length !== 1) refuse("The target browser window is gone.");
  var window = matches[0],
    list = window.tabs(),
    index;
  if (chrome) {
    index = list.findIndex(function (tab) {
      return tab.id() === request.target.tab;
    });
    if (index < 0) refuse("The target tab is gone.");
  } else {
    index = request.target.tab - 1;
    if (!list[index]) refuse("The target tab is gone.");
  }
  var tab = list[index];
  if (request.op === "info")
    return JSON.stringify(record(window, tab, index + 1));
  if (request.expectedURL !== undefined && tab.url() !== request.expectedURL)
    refuse("The target tab changed. No action was taken.");
  if (request.expectedDocument !== undefined) {
    var checkSource =
      "JSON.stringify(globalThis.__reach_tool_protocol_v1__ ? globalThis.__reach_tool_protocol_v1__.document : null)";
    var nonce = chrome
      ? tab.execute({ javascript: checkSource })
      : app.doJavaScript(checkSource, { in: tab });
    if (JSON.parse(nonce) !== request.expectedDocument)
      refuse("The target document changed. No action was taken.");
  }
  if (request.op === "navigate") {
    tab.url = request.url;
    return JSON.stringify(record(window, tab, index + 1));
  }
  if (request.op === "focus") {
    if (chrome) window.activeTabIndex = index + 1;
    else window.currentTab = tab;
    app.activate();
    return JSON.stringify(record(window, tab, index + 1));
  }
  if (request.op === "evaluate") {
    var value = chrome
      ? tab.execute({ javascript: request.source })
      : app.doJavaScript(request.source, { in: tab });
    if (typeof value !== "string")
      refuse(
        "The browser returned an unexpected result.",
        "browser_changed",
        true,
      );
    return value;
  }
  if (request.op === "close") {
    tab.close();
    return "{}";
  }
  refuse("Unknown browser transport operation.", "invalid");
}
