import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BrowserAppNative } from "../server/browser-app-native.mjs";

const identity = "a".repeat(64), instance = "b".repeat(64);
const target = { appId: "/System/Applications/Notes.app", windowId: 42, pid: 123, instance, identity, width: 1200, height: 800 };

test("native app requests carry a signed process and exact window geometry", async () => {
  const calls = [];
  const native = new BrowserAppNative({}, { run: async request => {
    calls.push(request);
    if (request.op === "windows") return { windows: [{ id: 42, pid: 123, instance, identity, title: "A browser", width: 1200, height: 800 }] };
    if (request.op === "capture") return { jpeg: "/9j/", width: 1200, height: 800 };
    return { done: true };
  } });
  await native.windows(target.appId, () => {}, identity);
  await native.capture(target);
  await assert.rejects(native.input(target, { type: "click", x: 0.5, y: 0.25 }), { status: 403 });
  assert.deepEqual(calls[0], { op: "windows", appId: target.appId, identity, protectedHosts: [] });
  assert.deepEqual(calls[1], { op: "capture", ...target, protectedHosts: [] });
  assert.equal(calls.length, 2);
});

test("window input rejects missing identity, stale geometry, shortcuts and extra keys before native execution", async () => {
  let calls = 0;
  const native = new BrowserAppNative({}, { run: async () => { calls++; return { done: true }; } });
  for (const bad of [{ ...target, instance: undefined }, { ...target, identity: undefined }, { ...target, width: 0 },
    { ...target, height: Infinity }, { ...target, appId: "/Applications/../Safari.app" }, { ...target, pid: -1 }]) {
    await assert.rejects(native.input(bad, { type: "click", x: 0.5, y: 0.5 }), { status: 400 });
  }
  for (const bad of [{ type: "key", key: "cmd+space" }, { type: "key", key: "enter", modifiers: ["meta"] },
    { type: "click", x: -1, y: 0 }, { type: "click", x: 0, y: 0, button: "right" },
    { type: "text", text: "x\u0000y" }, { type: "scroll", direction: "down", amount: 100 },
    { type: "shell", command: "open -a Terminal" }]) {
    await assert.rejects(native.input(target, bad), { status: 400 });
  }
  await assert.rejects(native.windows(target.appId), { status: 400 });
  assert.equal(calls, 0);
});

test("authorization is checked before calling the helper and before exposing its result", async () => {
  let calls = 0, allowed = false;
  const native = new BrowserAppNative({}, { run: async () => { calls++; allowed = false; return { jpeg: "/9j/", width: 100, height: 100 }; } });
  await assert.rejects(native.capture(target, () => allowed), { status: 403 });
  assert.equal(calls, 0);
  allowed = true;
  await assert.rejects(native.capture(target, () => allowed), { status: 403 });
  assert.equal(calls, 1);
  const stop = new AbortController();
  stop.abort();
  await assert.rejects(native.input(target, { type: "key", key: "enter" }, () => true, stop.signal), { status: 403 });
  assert.equal(calls, 1);
});

test("unverified catalog entries and helper windows from a different signer fail closed", async () => {
  let answer = { apps: [{ id: target.appId, name: "Notes", bundleId: "com.apple.Notes", protected: false }] };
  const native = new BrowserAppNative({}, { run: async () => answer });
  await assert.rejects(native.catalog(), { status: 503 });
  answer.apps[0].protected = true;
  assert.deepEqual(await native.catalog(), answer);
  answer = { windows: [{ id: 42, pid: 123, instance, identity: "c".repeat(64), title: "Wrong signer", width: 1200, height: 800 }] };
  await assert.rejects(native.windows(target.appId, () => {}, identity), { status: 503 });
  answer = { jpeg: "<html>anything</html>", width: 1200, height: 800 };
  await assert.rejects(native.capture(target), { status: 503 });
});

test("catalog discovery is coalesced without caching access authorization", async () => {
  let release, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const native = new BrowserAppNative({}, { run: async () => { calls++; await pending; return { apps: [] }; } });
  const first = native.catalog(), second = native.catalog();
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  const changed = await native.catalog();
  changed.apps.push({ id: "injected" });
  assert.deepEqual(await native.catalog(), { apps: [] });
  await assert.rejects(native.catalog(() => false), { status: 403 });
  assert.equal(calls, 1);
});

test("native app boundary cannot silently regress to global capture or global input", async () => {
  const source = await fs.readFile(new URL("../scripts/native/browser-app.swift", import.meta.url), "utf8");
  const code = source.replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /CGEvent\s*\(|\.post\s*\(|CGDisplayCreateImage|CGWindowListCreateImage|AXUIElementCreateSystemWide\s*\(|NSAppleScript|NSPasteboard/);
  assert.doesNotMatch(code, /SCContentFilter\s*\(\s*display\s*:/);
  assert.match(code, /SCContentFilter\(desktopIndependentWindow:value\.window\)/);
  assert.match(code, /config\.includeChildWindows = false/);
  assert.match(code, /AXUIElementCopyElementAtPosition\(application,/);
  assert.match(code, /CFEqual\(current,leaf\)/);
  assert.match(code, /inWindow\(element, value\.ax, value\.running\.app\.processIdentifier\)/);
});

test("compiled native helper rejects malformed/stale targets before touching macOS windows", {
  skip: process.platform !== "darwin" || process.env.REACH_TEST_APP_NATIVE !== "1",
}, async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "reach-app-native-test-"));
  try {
    const binary = path.join(temporary, "browser-app");
    const source = fileURLToPath(new URL("../scripts/native/browser-app.swift", import.meta.url));
    const build = spawnSync("/usr/bin/xcrun", ["swiftc", "-module-cache-path", path.join(os.tmpdir(), "reach-browser-app-swift-cache"),
      "-parse-as-library", source, "-o", binary], { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 });
    assert.equal(build.status, 0, build.stderr);
    for (const request of [{ op: "capture" }, { op: "input", action: { type: "key", key: "cmd+space" } },
      { op: "capture", ...target, pid: -1 }, { op: "input", ...target, identity: undefined, action: { type: "click", x: 0.5, y: 0.5 } },
      { op: "input", ...target, action: { type: "click", x: 0.5, y: 0.5 } }]) {
      const result = spawnSync(binary, [], { input: JSON.stringify(request), encoding: "utf8", timeout: 3000 });
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).error, request.op === "input" ? "Controlling host apps requires an isolated workspace. Only viewing is available." : "Choose a current app window.");
      assert.equal(result.stdout.includes('"jpeg"'), false);
      assert.equal(result.stdout.includes('"done"'), false);
    }
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});


test("protected Reach hosts come only from server origins and accompany every native request", async () => {
  const calls = [];
  const config = { publicOrigin: "https://Owner.REACH.Example.:8443", allowedOrigins: ["https://pair.example", "http://localhost:5328"] };
  const native = new BrowserAppNative(config, { run: async request => {
    calls.push(structuredClone(request));
    request.protectedHosts.length = 0;
    return { done: true };
  } });
  config.publicOrigin = "https://attacker.example";
  native.protectedHosts = ["attacker.example"];
  await native.call({ op: "list", protectedHosts: ["attacker.example"] });
  await native.call({ op: "capture", ...target, protectedHosts: ["attacker.example"] });
  for (const request of calls) assert.deepEqual(request.protectedHosts, ["owner.reach.example", "pair.example", "localhost"]);
  assert.throws(() => new BrowserAppNative({ publicOrigin: "not a url" }), { status: 503 });
  assert.throws(() => new BrowserAppNative({ publicOrigin: "file:///tmp/reach" }), { status: 503 });
});

test("native protections reject browsers, embedded webviews, secure content and external link handoffs", async () => {
  const source = await fs.readFile(new URL("../scripts/native/browser-app.swift", import.meta.url), "utf8");
  assert.match(source, /validateBrowserPage\(running.signature.id,ax,controls,hosts\)/);
  assert.match(source, /validateBrowserPage\(id.signature.id,value.ax,controls,value.protectedHosts\)/);
  assert.match(source, /try fresh\(value\)\s+let image = try await SCScreenshotManager.captureImage[\s\S]*?try fresh\(value\)/);
  assert.match(source, /try navigationTarget\(leaf,value\)/);
  assert.match(source, /try validateBrowserText\(element,attribute,contents,value\)/);
  assert.match(source,/if role == "AXWebArea" \{ try reject\(isolatedBrowserReason\) \}/);
  assert.match(source,/if hasBrowserContent\(bundleId,controls\) \{ try reject\(isolatedBrowserReason\) \}/);
  assert.match(source,/if protectedControl\(role,subrole,attr\(value,"AXProtectedContent"\)/);
  assert.match(source,/if address != nil \{ try reject\("Opening links or other apps is unavailable in shared app control\."\) \}/);
  const navigation=source.split('func navigationTarget(')[1].split('func validateBrowserText(')[0];
  assert.doesNotMatch(navigation,/guard value\.webContent else/);
  assert.match(source,/childResult == \.success \|\| childResult == \.attributeUnsupported \|\| childResult == \.noValue/);
});

test("native wrapper blocks host browsers before helper work and protects mislabeled catalog identities",async()=>{
  let calls=0;
  const native=new BrowserAppNative({}, {run:async()=>{calls++;return {apps:[{id:'/Applications/Renamed.app',name:'Renamed',bundleId:'com.google.Chrome',identity,protected:false}]};}});
  await assert.rejects(native.input({...target,appId:'/Applications/Google Chrome.app'},{type:'click',x:.5,y:.5}),{status:403});
  await assert.rejects(native.capture({...target,appId:'/Applications/Safari.app'}),{status:403});
  await assert.rejects(native.call({op:'input',...target,action:{type:'click',x:.5,y:.5}}),{status:403});
  assert.equal(calls,0);
  const catalog=await native.catalog();assert.equal(catalog.apps[0].protected,true);assert.match(catalog.apps[0].reason,/isolated agent browser/);
});
