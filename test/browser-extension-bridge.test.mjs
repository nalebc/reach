// Reach's browser extension transport (docs/parity/G-browser-tools.md),
// mocked on every platform: the real bridge on a real local socket (a named
// pipe on Windows), the real extension in a VM against a fake chrome, the
// native host's relay in JS. Real Chrome and Edge: windows-browser-tools-native.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBrowserExtensionBridge, extensionPipe, outgoing } from "../server/browser-extension.mjs";
import { createToolBrowserDriver } from "../server/tool-browser-driver.mjs";
import { createAgentTools } from "../server/agent-tools.mjs";
import { extensionIds, REPO_EXTENSION_ID, EXTENSION_STORES } from "../server/browser-extension-ids.mjs";
import { fakeChrome, fakeHost, loadExtension, until } from "./helpers/fake-extension.mjs";
import { toolBrowserFixture, exampleTool } from "./helpers/tool-browser-fixture.mjs";

const marker = "SYNTHETIC_PRIVATE_CONTENT_42";
const safe = (error) => {
  assert.ok(error instanceof Error);
  assert.equal(JSON.stringify({ message: error.message, code: error.code }).includes(marker), false);
  return true;
};
// A socket path short enough for macOS's 104-byte limit; a pipe on Windows.
const pipeFor = (dataDir) => process.platform === "win32" ? extensionPipe(dataDir) : path.join(os.tmpdir().length < 60 ? os.tmpdir() : "/tmp", `rbt-${crypto.randomBytes(6).toString("hex")}.sock`);

async function world(t, { browser = "Edge", approve = true, dataDir, ...options } = {}) {
  dataDir ??= fs.mkdtempSync(path.join(os.tmpdir(), "reach-extension-"));
  const pipe = pipeFor(dataDir);
  const asked = [];
  const bridge = createBrowserExtensionBridge({ dataDir, pipe, onPairingRequest: (name) => asked.push(name), closedWaitMs: 50, reconnectMs: 3000, ids: [REPO_EXTENSION_ID], ...options });
  await bridge.start();
  const fixture = toolBrowserFixture();
  const host = fakeHost(pipe);
  const chrome = fakeChrome(fixture, { connectNative: host.connectNative });
  const extension = loadExtension(chrome, { browser });
  const driver = createToolBrowserDriver({ platform: "win32", extension: bridge });
  t.after(() => {
    bridge.close();
    host.close();
    fixture.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
    if (process.platform !== "win32") fs.rmSync(pipe, { force: true });
  });
  await extension.start();
  await until(() => bridge.status()[browser].asking || bridge.status()[browser].connected, "the extension says hello");
  if (approve && !bridge.status()[browser].connected) {
    assert.equal(bridge.approve(browser), 1);
    await until(() => bridge.status()[browser].connected && extension.state().trusted, "paired and proven");
  }
  return { dataDir, pipe, bridge, fixture, host, chrome, extension, driver, asked };
}

test("the extension asks to connect and nothing runs until the owner allows it in Reach", async (t) => {
  const w = await world(t, { approve: false });
  assert.deepEqual(w.asked, ["Edge"]);
  assert.deepEqual(w.bridge.status().Edge, { connected: false, asking: true, paired: false });
  // Before the owner's tap: setup, in the words the owner acts on.
  await assert.rejects(w.driver.transport("Edge", { op: "tabs" }), (e) => e.code === "setup_required" && e.status === 503 && /Reach's extension/.test(e.message));
  assert.equal(w.chrome.calls.length, 0, "no browser call before pairing");
  assert.equal(w.bridge.approve("Edge"), 1);
  await until(() => w.bridge.status().Edge.connected && w.extension.state().trusted);
  const stored = JSON.parse(fs.readFileSync(path.join(w.dataDir, "browser-extension.json"), "utf8"));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].browser, "Edge");
  assert.match(stored[0].secret, /^[0-9a-f]{64}$/);
  assert.equal(w.chrome.storage.store.get("secret"), stored[0].secret);
  // Chrome is another browser: still not set up.
  await assert.rejects(w.driver.transport("Chrome", { op: "tabs" }), (e) => e.code === "setup_required");
});

test("tabs, info, navigate and the page interpreter run through the extension like JXA", async (t) => {
  const w = await world(t);
  const created = await w.driver.transport("Edge", { op: "create", url: "https://example.com/" });
  assert.equal(created.url, "https://example.com/");
  const tabs = await w.driver.transport("Edge", { op: "tabs" });
  assert.equal(tabs.length, 1);
  assert.deepEqual(Object.keys(tabs[0]).sort(), ["index", "tab", "title", "url", "window"]);
  const info = await w.driver.transport("Edge", { op: "info", target: tabs[0] });
  assert.equal(info.url, "https://example.com/");
  const document = crypto.randomUUID();
  const bound = await w.driver.page("Edge", info, { op: "bind", origins: ["https://example.com"], document, expectedURL: info.url });
  assert.equal(bound.document, document);
  const read = await w.driver.page("Edge", info, { op: "read", origins: ["https://example.com"], document, target: { css: "#result" } });
  assert.equal(read.text, "Ready");
  // Only the isolated world, only the fixed interpreter.
  assert.ok(w.chrome.calls.filter((call) => call.startsWith("executeScript")).every((call) => call === "executeScript:ISOLATED"));
  // A navigation checks the document it was bound to first.
  await assert.rejects(w.driver.transport("Edge", { op: "navigate", target: info, expectedURL: info.url, expectedDocument: crypto.randomUUID(), url: "https://example.com/x" }), (e) => e.code === "browser_changed");
  const moved = await w.driver.transport("Edge", { op: "navigate", target: info, expectedURL: info.url, expectedDocument: document, url: "https://example.com/next" });
  assert.equal(moved.url, "https://example.com/next");
  // A tab gone, a window gone: the Mac's fixed words, never the browser's.
  await assert.rejects(w.driver.transport("Edge", { op: "info", target: { ...info, tab: 999 } }), (e) => e.code === "browser_changed");
  await assert.rejects(w.driver.transport("Edge", { op: "info", target: { ...info, window: 999 } }), (e) => e.code === "browser_changed");
});

test("a tab still opening is loading, never named by its pending address, so expectedURL checks stay exact", async (t) => {
  const w = await world(t);
  const tab = await w.driver.transport("Edge", { op: "create", url: "https://example.com/" });
  const page = w.fixture.browsers.get("Chrome").find((item) => item.tab === tab.tab);
  page.pending = true;
  await assert.rejects(w.driver.transport("Edge", { op: "info", target: tab }), (e) => e.code === "loading");
  await assert.rejects(w.driver.transport("Edge", { op: "focus", target: tab, expectedURL: "https://example.com/" }), (e) => e.code === "browser_changed");
  page.pending = false;
  const info = await w.driver.transport("Edge", { op: "info", target: tab });
  assert.equal(info.url, "https://example.com/");
  assert.equal((await w.driver.transport("Edge", { op: "focus", target: info, expectedURL: info.url })).url, info.url);
});

test("the owner's tab stays open and a batch tab closes", async (t) => {
  const w = await world(t);
  const mine = await w.driver.transport("Edge", { op: "create", url: "https://example.com/", background: true });
  w.chrome.show(mine.tab);
  await assert.rejects(w.driver.transport("Edge", { op: "close", target: mine, expectedURL: mine.url, behind: true }), (e) => e.code === "owner_tab");
  const behind = await w.driver.transport("Edge", { op: "create", url: "https://example.com/b", background: true });
  await w.driver.transport("Edge", { op: "close", target: behind, expectedURL: behind.url, behind: true });
  assert.equal((await w.driver.transport("Edge", { op: "tabs" })).length, 1);
});

test("no window: the same setup words as the Mac", async (t) => {
  const w = await world(t);
  await assert.rejects(w.driver.transport("Edge", { op: "preflight", probeId: crypto.randomUUID() }), (e) => e.code === "browser_window_required");
  w.chrome.openWindow(7);
  assert.deepEqual(await w.driver.transport("Edge", { op: "preflight", probeId: crypto.randomUUID() }), { ok: true });
});

test("messages over the browser's 1 MB limit arrive in pieces", async (t) => {
  const w = await world(t);
  const tab = await w.driver.transport("Edge", { op: "create", url: "https://example.com/" });
  const document = crypto.randomUUID();
  await w.driver.page("Edge", tab, { op: "bind", origins: ["https://example.com"], document, expectedURL: tab.url });
  const value = "x".repeat(3 * 1024 * 1024);
  const filled = await w.driver.page("Edge", tab, { op: "fill", command: "c1", origins: ["https://example.com"], document, value, target: { role: "textbox", name: "Note" } });
  assert.equal(filled.verified, true);
  assert.equal(w.host.tooBig, 0, "no frame over 1 MB went to the browser");
  assert.equal(outgoing({ type: "request", data: value }).length, Math.ceil(Buffer.from(JSON.stringify({ type: "request", data: value })).toString("base64").length / (512 * 1024)));
});

test("a later connection proves the kept secret without asking the owner again; Reach restarting is waited out", async (t) => {
  const w = await world(t);
  assert.deepEqual(w.asked, ["Edge"]);
  // Reach restarts: same data folder, same pipe.
  w.bridge.close();
  await until(() => !w.extension.state().trusted, "the extension stops trusting a gone Reach");
  await assert.rejects(w.driver.transport("Edge", { op: "tabs" }), (e) => e.code === "cancelled");
  let asked = 0;
  const again = createBrowserExtensionBridge({ dataDir: w.dataDir, pipe: w.pipe, ids: [REPO_EXTENSION_ID], onPairingRequest: () => asked++ });
  await again.start();
  t.after(() => again.close());
  // The host dials the pipe again on its own; the extension proves its secret.
  await until(() => again.status().Edge.connected && w.extension.state().trusted, "proven again after Reach's restart");
  assert.equal(asked, 0, "the owner isn't asked again");
  const driver = createToolBrowserDriver({ platform: "win32", extension: again });
  assert.deepEqual(await driver.transport("Edge", { op: "tabs" }), []);
});

test("a browser allowed before but closed now is browser_closed (the run opens it), then waited for", async (t) => {
  const w = await world(t);
  w.host.close();
  await until(() => !w.bridge.status().Edge.connected, "the browser closed");
  await assert.rejects(w.driver.transport("Edge", { op: "tabs" }), (e) => e.code === "browser_closed");
  // The run starts the browser; its extension connects within the wait.
  const host = fakeHost(w.pipe);
  t.after(() => host.close());
  const chrome = fakeChrome(toolBrowserFixture(), { connectNative: host.connectNative });
  for (const [key, value] of w.chrome.storage.store) chrome.storage.store.set(key, value);
  const pending = w.driver.transport("Edge", { op: "tabs" });
  await loadExtension(chrome).start();
  assert.deepEqual(await pending, []);
});

test("a browser Reach forgot asks the owner again, once, instead of proving a secret Reach no longer has", async (t) => {
  const w = await world(t);
  let hellos = 0;
  w.bridge.forget("Edge");
  assert.equal(w.bridge.status().Edge.paired, false);
  // The host dials again; the extension's kept secret is unknown now.
  await until(() => w.bridge.status().Edge.asking, "it asks again");
  assert.equal(w.chrome.storage.store.has("secret"), false, "the extension forgot the old secret");
  const before = w.asked.length;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(w.asked.length, before, "no loop of asks");
  hellos = w.bridge.connections();
  assert.equal(hellos, 1);
  await assert.rejects(w.driver.transport("Edge", { op: "tabs" }), (e) => e.code === "setup_required");
  assert.equal(w.bridge.approve("Edge"), 1);
  await until(() => w.bridge.status().Edge.connected && w.extension.state().trusted);
});

test("a wrong proof, an unknown extension or a stray client is dropped and never trusted", async (t) => {
  const w = await world(t);
  // Another extension id: Chrome would never start the host for it, and Reach refuses it.
  const stranger = fakeHost(w.pipe, { origin: `chrome-extension://${"a".repeat(32)}/`, retry: false });
  t.after(() => stranger.close());
  const port = stranger.connectNative();
  const seen = [];
  port.onMessage.addListener((message) => seen.push(message));
  await until(() => stranger.sockets[0].destroyed, "the stranger is dropped");
  assert.deepEqual(seen.filter((m) => m.type !== "waiting"), []);
  // The same install with a forged secret: the connection closes.
  const forged = fakeChrome(toolBrowserFixture(), { connectNative: fakeHost(w.pipe, { retry: false }).connectNative });
  await forged.storage.local.set({ installId: w.chrome.storage.store.get("installId"), secret: crypto.randomBytes(32).toString("hex") });
  const impostor = loadExtension(forged);
  const before = w.bridge.connections();
  await impostor.start();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(impostor.state().trusted, false);
  assert.ok(w.bridge.connections() <= before, "the forged connection is closed");
});

test("the extension trusts only a Reach that proves the secret, and takes a secret only when it asked", async () => {
  const sent = [];
  const chrome = fakeChrome(toolBrowserFixture(), {
    connectNative: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage: (m) => sent.push(m), disconnect() { sent.push("disconnected"); } }),
  });
  const secret = crypto.randomBytes(32).toString("hex");
  await chrome.storage.local.set({ secret });
  const extension = loadExtension(chrome);
  await extension.start();
  const nonce = crypto.randomBytes(32).toString("hex");
  await extension.receive({ type: "challenge", nonce });
  const hello = sent.at(-1);
  assert.equal(hello.type, "hello");
  assert.equal(hello.pair, undefined);
  // A squatter offering its own secret is ignored: this connection didn't ask.
  await extension.receive({ type: "paired", secret: crypto.randomBytes(32).toString("hex"), nonce });
  assert.equal(chrome.storage.store.get("secret"), secret);
  // Requests before Reach's proof are refused, not run.
  await extension.receive({ type: "request", id: "1", request: { op: "tabs" } });
  assert.equal(JSON.parse(sent.at(-1).raw).code, "setup_required");
  assert.equal(chrome.calls.length, 0);
  await extension.receive({ type: "ready", proof: "0".repeat(64) });
  assert.equal(extension.state().trusted, false);
  assert.equal(sent.at(-1), "disconnected");
});

test("a request with no answer is uncertain and cancelled; a cancelled run says so", async (t) => {
  const w = await world(t);
  let release;
  w.chrome.hang = new Promise((resolve) => { release = resolve; });
  await assert.rejects(w.driver.transport("Edge", { op: "tabs" }, { timeoutMs: 100 }), (e) => e.code === "uncertain" && e.uncertain === true && e.status === 504);
  const stop = new AbortController();
  const pending = w.driver.transport("Edge", { op: "tabs" }, { signal: stop.signal });
  stop.abort(Error(marker));
  await assert.rejects(pending, (e) => safe(e) && e.code === "cancelled" && e.uncertain === true);
  release();
});

test("browser and page failures carry only Reach's fixed words", async (t) => {
  const w = await world(t);
  w.chrome.tabs.query = async () => { throw Error(`Cannot access ${marker}`); };
  await assert.rejects(w.driver.transport("Edge", { op: "tabs" }), (e) => safe(e) && e.code === "browser_changed");
  const fake = { request: async () => JSON.stringify({ error: marker, code: marker, uncertain: true }) };
  const driver = createToolBrowserDriver({ platform: "win32", extension: fake });
  await assert.rejects(driver.transport("Edge", { op: "info" }), (e) => safe(e) && e.code === "unsupported" && e.uncertain === true);
  const failing = createToolBrowserDriver({ platform: "win32", extension: { request: async () => JSON.stringify({ state: "failed", failure: marker, length: 0 }) } });
  await assert.rejects(failing.page("Edge", { url: "https://example.com/", window: 1, tab: 1 }, { op: "download_status" }), (e) => safe(e) && e.code === "download_failed");
  const thrown = createToolBrowserDriver({ platform: "win32", extension: { request: async () => { throw Object.assign(Error(marker), { code: marker }); } } });
  await assert.rejects(thrown.transport("Edge", { op: "info" }), (e) => safe(e) && e.code === "uncertain" && e.uncertain === true);
  // No extension at all: setup, never a guess.
  await assert.rejects(createToolBrowserDriver({ platform: "win32" }).transport("Edge", { op: "tabs" }), (e) => e.code === "setup_required");
});

test("a saved tool replays in Edge on Windows through createAgentTools, with the Mac's refusals", async (t) => {
  const w = await world(t);
  const apps = [
    { id: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", name: "Google Chrome", bundleId: "exe:chrome.exe", running: true },
    { id: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", name: "Microsoft Edge", bundleId: "exe:msedge.exe", running: true },
  ];
  const client = {
    id: "agent", name: "Test agent", kind: "agent", status: "accepted", expiresAt: Date.now() + 600000,
    policy: { browser: true, preset: "apps", apps, roots: [] }, scopes: ["browser:read", "browser:open", "browser:control", "browser:screen"],
  };
  const authorize = () => client;
  const checked = [];
  const desktop = {
    catalog: async (auth) => { auth(); return apps; },
    withBrowser: async (_client, app, auth, work) => { checked.push(app); return work(async () => { auth(); }, async () => {}); },
  };
  const tools = createAgentTools({ dataDir: w.dataDir }, { desktop, platform: "win32", extension: w.bridge, waitMs: 250, runMs: 5000, pdf: async () => "" });
  t.after(() => tools.close());
  const catalog = await tools.catalog(authorize);
  assert.deepEqual(catalog.browsers, ["Chrome", "Edge"]);
  assert.match(catalog.hint, /each in its own Chrome or Edge tab/);
  await tools.define(authorize, exampleTool());
  // The owner's Edge window, as on a Mac a window must be open.
  w.chrome.openWindow(1);
  const result = await tools.run(authorize, { id: "example_task", browser: "Edge", requestId: crypto.randomUUID(), values: {} });
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.data.result, "Done");
  assert.deepEqual(checked, [apps[1].id]);
  // Safari isn't a Windows browser; the words name the PC's.
  await assert.rejects(tools.run(authorize, { id: "example_task", browser: "Safari", requestId: crypto.randomUUID(), values: {} }), /Chrome or Edge/);
  // A password field stays closed to an Apps agent, as on a Mac.
  const tab = (await w.driver.transport("Edge", { op: "tabs" }))[0];
  w.fixture.browsers.get("Chrome").find((item) => item.tab === tab.tab).dom.window.document.body.insertAdjacentHTML("beforeend", '<input type="password" aria-label="Password">');
  // The run bound this page already: its document is kept.
  const { document } = await w.driver.page("Edge", tab, { op: "bind", origins: ["https://example.com"], document: crypto.randomUUID(), expectedURL: tab.url });
  await assert.rejects(w.driver.page("Edge", tab, { op: "fill", command: "p1", origins: ["https://example.com"], document, value: "x", target: { css: "input[type=password]" } }),
    (e) => e.code === "missing", "a password field is invisible to an Apps agent's tool");
  await assert.rejects(w.driver.page("Edge", tab, { op: "read", origins: ["https://example.com"], document, target: { css: "input[type=password]" } }), (e) => e.code === "missing");
  // Another website is refused by the page interpreter too.
  await assert.rejects(w.driver.page("Edge", tab, { op: "read", origins: ["https://other.example"], document, target: { css: "#result" } }), (e) => e.code === "wrong_site");
  // Batches run in Edge (stable tab ids), never in Safari.
  await assert.rejects(tools.batch(authorize, { id: "example_task", browser: "Safari", requestId: crypto.randomUUID(), items: [{}] }), /Batches run in Chrome or Edge/);
});

test("Reach accepts only the stores' ids, once published; the repo build connects nowhere by default", async (t) => {
  // Production: the stores' ids only, none until published; never the repo build's.
  assert.deepEqual(extensionIds(), []);
  assert.deepEqual(extensionIds({ Chrome: { id: "b".repeat(32) }, Edge: { id: "not-an-id" } }), ["b".repeat(32)]);
  assert.deepEqual(Object.keys(EXTENSION_STORES), ["Chrome", "Edge"]);
  // A bridge with Reach's default list drops the repo build before any hello.
  const w = await world(t, { approve: false, ids: undefined }).catch((error) => error);
  assert.match(String(w?.message), /timed out waiting: the extension says hello/);
});
