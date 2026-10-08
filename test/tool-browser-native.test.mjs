import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import { nativeToolProcess } from "../server/tool-browser-driver.mjs";

const script = new URL("../scripts/native/tool-browser.js", import.meta.url);
const source = fs.readFileSync(script, "utf8");

// Run the fixed native program against the browser scripting dictionary's
// object shapes. Existing private pages must never receive probe JavaScript.
function browser(browser, options = {}) {
  const calls = [],
    tabs = [];
  const tab = (url) => {
    const id = crypto.randomUUID();
    return {
      id: () => id,
      url: () => url,
      title: () => "Private page",
      name: () => "Private page",
      execute: ({ javascript }) => {
        calls.push({ op: "evaluate", url, source: javascript });
        assert.ok(url.startsWith("about:blank#reach-tool-check-"));
        if (options.evaluateError) throw options.evaluateError;
        if (options.navigateProbe) url = "https://example.com/owner-page";
        return "reach.browser.ready.v1";
      },
    };
  };
  function makeTab(url) {
    const result = tab(url);
    result.close = () => {
      calls.push({ op: "close", url: result.url() });
      tabs.splice(tabs.indexOf(result), 1);
    };
    return result;
  }
  tabs.push(makeTab("https://example.com/private-account"));
  const window = { id: () => 1, tabs: () => tabs };
  window.tabs.push = (value) => {
    calls.push({ op: "create", url: value.url() });
    tabs.push(value);
  };
  const app = {
    running: () => options.running !== false,
    windows: () => {
      if (options.windowsError) throw options.windowsError;
      return options.noWindow ? [] : [window];
    },
    Tab: ({ url }) => makeTab(url),
    doJavaScript: (source, { in: target }) =>
      target.execute({ javascript: source }),
  };
  return {
    calls,
    tabs,
    run(request = { op: "preflight", probeId: crypto.randomUUID() }) {
      const input = JSON.stringify({ browser, ...request });
      const context = vm.createContext({
        ObjC: { import() {}, unwrap: (value) => value },
        $: {
          NSFileHandle: {
            fileHandleWithStandardInput: { readDataToEndOfFile: input },
          },
          NSString: { alloc: { initWithDataEncoding: (value) => value } },
          NSUTF8StringEncoding: 4,
          NSThread: { sleepForTimeInterval() {} },
        },
        Application: () => app,
      });
      return JSON.parse(
        vm.runInContext(`${source}\nrun()`, context, { timeout: 2000 }),
      );
    },
  };
}

for (const name of ["Chrome", "Safari"]) {
  test(`${name} preflight scripts only its nonce-addressed blank tab and closes it`, () => {
    const f = browser(name);
    assert.deepEqual(f.run(), { ok: true });
    assert.deepEqual(
      f.calls.map((call) => call.op),
      ["create", "evaluate", "close"],
    );
    assert.equal(f.calls[1].source, '"reach.browser.ready.v1"');
    assert.equal(f.tabs.length, 1);
    assert.equal(f.tabs[0].url(), "https://example.com/private-account");
  });

  test(`${name} scripting disabled gives a typed owner error and removes the probe`, () => {
    const f = browser(name, {
      evaluateError: Error(
        "Executing JavaScript through AppleScript is turned off. Allow JavaScript from Apple Events (-10000)",
      ),
    });
    const result = f.run();
    assert.equal(result.code, "setup_required");
    assert.equal(result.uncertain, false);
    assert.match(
      result.error,
      /owner needs to enable Allow JavaScript from Apple Events/,
    );
    assert.equal(f.tabs.length, 1);
  });

  test(`${name} missing Automation or a usable window fails before creating a tab`, () => {
    const denied = browser(name, {
      windowsError: Error("Not authorized to send Apple events (-1743)"),
    });
    const result = denied.run();
    assert.equal(result.code, "setup_required");
    assert.equal(result.uncertain, false);
    assert.match(result.error, /Privacy & Security → Automation/);
    assert.equal(denied.calls.length, 0);
    const empty = browser(name, { noWindow: true });
    assert.equal(empty.run().code, "browser_window_required");
    assert.equal(empty.calls.length, 0);
    const closed = browser(name, { running: false });
    assert.equal(closed.run().code, "browser_closed");
    assert.equal(closed.calls.length, 0);
    const changed = browser(name);
    assert.equal(
      changed.run({ op: "preflight", probeId: crypto.randomUUID(), window: 77 })
        .error,
      "The target browser window is gone.",
    );
    assert.equal(changed.calls.length, 0);
  });

  test(`${name} preflight never closes a page the owner navigated`, () => {
    const f = browser(name, { navigateProbe: true });
    assert.deepEqual(f.run(), { ok: true });
    assert.equal(f.tabs.length, 2);
    assert.equal(f.tabs[1].url(), "https://example.com/owner-page");
    assert.equal(f.calls.filter((call) => call.op === "close").length, 0);
  });
}

test("native bridge failures are public JSON, and genuine timeouts remain uncertain", () => {
  const f = browser("Chrome", {
    evaluateError: Error(
      "/Users/private/Reach/tool-browser.js: execution error: Error: Error: (-2700)",
    ),
  });
  const result = f.run();
  assert.equal(result.code, "setup_required");
  assert.doesNotMatch(
    result.error,
    /\/Users\/|tool-browser\.js|execution error/,
  );
  assert.equal(f.tabs.length, 1);
  const timedOut = browser("Safari", {
    evaluateError: Error("AppleEvent timed out (-1712)"),
  }).run();
  assert.equal(timedOut.uncertain, true);
  assert.equal(timedOut.code, "browser_changed");
});

test(
  "the actual macOS JXA helper returns structured errors without touching a browser",
  { skip: process.platform !== "darwin" },
  async () => {
    const result = JSON.parse(
      await nativeToolProcess(
        "/usr/bin/osascript",
        ["-l", "JavaScript", script.pathname],
        JSON.stringify({ browser: "Unsupported", op: "preflight" }),
      ),
    );
    assert.deepEqual(result, {
      error: "Choose Chrome or Safari.",
      code: "invalid",
      uncertain: false,
    });
  },
);
