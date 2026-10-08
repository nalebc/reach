// Fixed JXA transport for the two macOS browser scripting dictionaries.
// stdin carries data; never interpolate agent input into AppleScript or a shell.
ObjC.import("Foundation");
function run() {
  var raw = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var request = JSON.parse(
    ObjC.unwrap(
      $.NSString.alloc.initWithDataEncoding(raw, $.NSUTF8StringEncoding),
    ),
  );
  if (["Chrome", "Safari"].indexOf(request.browser) < 0)
    throw Error("Unsupported browser");
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
        throw Error(
          "The new browser window has not acknowledged creation. Inspect it before continuing.",
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
  if (matches.length !== 1) throw Error("The target browser window is gone.");
  var window = matches[0],
    list = window.tabs(),
    index;
  if (chrome) {
    index = list.findIndex(function (tab) {
      return tab.id() === request.target.tab;
    });
    if (index < 0) throw Error("The target tab is gone.");
  } else {
    index = request.target.tab - 1;
    if (!list[index]) throw Error("The target tab is gone.");
  }
  var tab = list[index];
  if (request.op === "info")
    return JSON.stringify(record(window, tab, index + 1));
  if (request.expectedURL !== undefined && tab.url() !== request.expectedURL)
    throw Error("The target tab changed. No action was taken.");
  if (request.expectedDocument !== undefined) {
    var checkSource =
      "JSON.stringify(globalThis.__reach_tool_protocol_v1__ ? globalThis.__reach_tool_protocol_v1__.document : null)";
    var nonce = chrome
      ? tab.execute({ javascript: checkSource })
      : app.doJavaScript(checkSource, { in: tab });
    if (JSON.parse(nonce) !== request.expectedDocument)
      throw Error("The target document changed. No action was taken.");
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
      throw Error("The browser returned an unexpected result.");
    return value;
  }
  if (request.op === "close") {
    tab.close();
    return "{}";
  }
  throw Error("Unknown browser transport operation.");
}
