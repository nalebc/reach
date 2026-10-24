import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_TAB_IDLE_MS, AGENT_TABS_EACH, createAgentTabs, siteOf, tabBrowserOf } from "../server/agent-tabs.mjs";
import { createAgentDesktop } from "../server/agent-desktop.mjs";
import { presetScopes } from "../server/agent-presets.mjs";
import { createAgentPauses } from "../server/agent-pauses.mjs";

// Tabs agents open with reach_open_url close once they're done, against a
// stand-in browser: the same tabs/close answers the Mac's Apple Events worker
// and Windows' extension give. Nothing here touches a real browser.
function browser() {
  let nextTab = 100;
  const windows = [{ id: 1, active: 0, tabs: [{ id: 1, url: "https://mail.google.com/mail/u/0/" }, { id: 2, url: "https://news.ycombinator.com/" }] }];
  const requests = [];
  const find = (target) => {
    const window = windows.find((item) => item.id === target.window);
    const index = window ? window.tabs.findIndex((tab) => tab.id === target.tab) : -1;
    return { window, index };
  };
  const driver = {
    off: false,
    async transport(name, request, options = {}) {
      if (options.signal?.aborted) throw Object.assign(Error("cancelled before send"), { code: "cancelled", uncertain: false });
      options.beforeSend?.();
      requests.push({ browser: name, ...request });
      if (this.off) throw Object.assign(Error("The selected browser is not running."), { code: "browser_closed" });
      if (request.op === "tabs") return windows.flatMap((window) => window.tabs.map((tab, i) => ({ window: window.id, tab: tab.id, index: i + 1, url: tab.url, title: "" })));
      if (request.op === "close") {
        const { window, index } = find(request.target);
        if (index < 0) throw Object.assign(Error("The target tab is gone."), { code: "browser_changed" });
        if (request.expectedURL !== undefined && window.tabs[index].url !== request.expectedURL) throw Object.assign(Error("The target tab changed."), { code: "browser_changed" });
        if (request.behind === true && window.active === index) throw Object.assign(Error("The owner is looking at this tab."), { code: "owner_tab" });
        window.tabs.splice(index, 1);
        if (window.active >= window.tabs.length) window.active = Math.max(0, window.tabs.length - 1);
        return {};
      }
      throw Object.assign(Error("unknown"), { code: "invalid" });
    },
  };
  return {
    driver, windows, requests,
    // The browser opening a page in a new tab, in front.
    open(url, window = windows[0]) {
      const tab = { id: nextTab++, url };
      window.tabs.push(tab);
      window.active = window.tabs.length - 1;
      return tab;
    },
    urls: () => windows.flatMap((window) => window.tabs.map((tab) => tab.url)),
    closes: () => requests.filter((request) => request.op === "close"),
  };
}
function world({ dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-tabs-")), allowed = true, ...options } = {}) {
  const b = options.browser || browser();
  let clock = 1_000_000, owner = false, holder = null, idle = 10_000;
  const seen = new Map();
  const tabs = createAgentTabs({ dataDir, driver: b.driver, platform: "darwin", now: () => clock,
    allowed: async (name) => allowed === true || allowed === name,
    lastSeen: (id) => seen.get(id) ?? 0, holder: () => holder, ownerUsing: () => owner, idle: async () => idle, ...options });
  const opens = async (clientId, url, { bundle = "com.google.Chrome", browserPath } = {}) => {
    const token = await tabs.before(clientId, browserPath);
    const tab = b.open(url);
    seen.set(clientId, clock);
    tabs.after(token, url, { ok: true, app: "Google Chrome", bundle });
    await tabs.closeOwn("nobody");
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    return tab;
  };
  return { tabs, b, dataDir, opens,
    tick: (ms) => { clock += ms; }, act: (id) => seen.set(id, clock),
    owner: (value) => { owner = value; }, hold: (value) => { holder = value; }, idleFor: (seconds) => { idle = seconds; } };
}
const settle = async (w) => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve)); };

test("an address's site and the browsers whose tabs Reach can close", () => {
  assert.equal(siteOf("https://www.ubereats.com/us/store"), "ubereats.com");
  assert.equal(siteOf("https://secure.chase.com/web/auth"), "chase.com");
  assert.equal(siteOf("https://www.bbc.co.uk/news"), "bbc.co.uk");
  assert.equal(siteOf("not a url"), "");
  assert.equal(tabBrowserOf("com.google.Chrome", "darwin"), "Chrome");
  assert.equal(tabBrowserOf("/Applications/Google Chrome.app", "darwin"), "Chrome");
  assert.equal(tabBrowserOf("com.apple.Safari", "darwin"), null, "Safari names tabs by position: not closed by Reach");
  assert.equal(tabBrowserOf("exe:msedge.exe", "win32"), "Edge");
  assert.equal(tabBrowserOf("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "win32"), "Chrome");
  assert.equal(tabBrowserOf("exe:firefox.exe", "win32"), null);
});

test("only the one new tab on the site asked for becomes the agent's", async (t) => {
  const w = world();
  t.after(() => w.tabs.stop());
  await w.opens("grok", "https://www.ubereats.com/");
  assert.deepEqual(w.tabs.list().map((tab) => [tab.clientId, tab.url]), [["grok", "https://www.ubereats.com/"]]);
  // Two new tabs on the same site (the owner opened one too): neither is proven the agent's.
  const token = await w.tabs.before("grok");
  w.b.open("https://www.amazon.com/a");
  w.b.open("https://www.amazon.com/b");
  w.tabs.after(token, "https://www.amazon.com/", { bundle: "com.google.Chrome" });
  await w.tabs.closeOwn("nobody");
  assert.equal(w.tabs.list().length, 1);
  // Another browser opened it (Safari, the default): nothing kept.
  await w.opens("grok", "https://example.com/", { bundle: "com.apple.Safari" });
  assert.equal(w.tabs.list().length, 1);
  // Reach may not control Chrome: no tabs listed, nothing kept, and the page still opens.
  const off = world({ allowed: false });
  t.after(() => off.tabs.stop());
  await off.opens("grok", "https://www.ubereats.com/");
  assert.deepEqual(off.tabs.list(), []);
  assert.equal(off.b.requests.length, 0, "never asks a browser it may not control");
});

test("Windows: Chrome and Edge through Reach's extension, each only while it's connected", async (t) => {
  const b = browser();
  const tabs = createAgentTabs({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "reach-tabs-")), driver: b.driver, platform: "win32", allowed: async (name) => name === "Edge" });
  t.after(() => tabs.stop());
  const token = await tabs.before("grok");
  assert.deepEqual(b.requests.map((request) => request.browser), ["Edge"], "Chrome's extension isn't connected: never asked");
  b.open("https://www.ubereats.com/");
  tabs.after(token, "https://www.ubereats.com/", { bundle: "exe:msedge.exe" });
  assert.deepEqual(await tabs.closeOwn("grok"), { closed: 1, open: 0 });
  // The page opened in Chrome instead: not one Reach saw appear.
  const again = await tabs.before("grok", "exe:chrome.exe");
  assert.equal(again, null);
});

test("a slow permission check never holds up the website", async (t) => {
  const b = browser();
  let answer;
  const tabs = createAgentTabs({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "reach-tabs-")), driver: b.driver, platform: "darwin", askMs: 20,
    allowed: () => new Promise((resolve) => { answer = resolve; }) });
  t.after(() => tabs.stop());
  const started = Date.now();
  assert.equal(await tabs.before("grok"), null, "not known yet: this open isn't tracked");
  assert.ok(Date.now() - started < 1000);
  assert.equal(b.requests.length, 0);
  answer(true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(await tabs.before("grok"), "the answer came meanwhile: the next open is");
});

test("a done agent's tabs close on their own; the owner's tabs never do", async (t) => {
  const w = world();
  t.after(() => w.tabs.stop());
  await w.opens("grok", "https://www.ubereats.com/");
  await w.opens("grok", "https://www.doordash.com/");
  w.tick(AGENT_TAB_IDLE_MS - 1000);
  await w.tabs.sweep();
  assert.equal(w.b.closes().length, 0, "still using the computer");
  w.tick(2000);
  w.owner(true);
  await w.tabs.sweep();
  assert.equal(w.b.closes().length, 0, "someone is using the computer through Reach: later");
  w.owner(false);
  await w.tabs.sweep();
  assert.deepEqual(w.b.urls(), ["https://mail.google.com/mail/u/0/", "https://news.ycombinator.com/"], "both agent tabs closed, the owner's stay");
  assert.ok(w.b.closes().every((request) => request.behind === undefined), "nobody touched the computer since: the tab in front closes too");
  assert.deepEqual(w.tabs.list(), []);
});

test("in front while the owner is at the computer, an agent's tab is theirs", async (t) => {
  const w = world();
  t.after(() => w.tabs.stop());
  await w.opens("grok", "https://www.ubereats.com/");
  await w.opens("grok", "https://www.doordash.com/");
  w.tick(AGENT_TAB_IDLE_MS + 1000);
  w.idleFor(3);
  await w.tabs.sweep();
  assert.ok(w.b.closes().every((request) => request.behind === true));
  assert.deepEqual(w.b.urls(), ["https://mail.google.com/mail/u/0/", "https://news.ycombinator.com/", "https://www.doordash.com/"], "the one behind closed, the one they're looking at stays");
  assert.deepEqual(w.tabs.list(), [], "and is no longer the agent's");
});

test("another agent at work keeps the tab in front open", async (t) => {
  const w = world();
  t.after(() => w.tabs.stop());
  await w.opens("grok", "https://www.ubereats.com/");
  w.tick(AGENT_TAB_IDLE_MS + 1000);
  w.hold({ clientId: "muse" });
  await w.tabs.sweep();
  assert.equal(w.b.closes()[0].behind, true);
  assert.equal(w.b.urls().length, 3);
});

test("a tab taken to another site, or closed already, is left alone", async (t) => {
  const w = world();
  t.after(() => w.tabs.stop());
  const tab = await w.opens("grok", "https://www.ubereats.com/");
  const other = await w.opens("grok", "https://www.doordash.com/");
  tab.url = "https://www.wikipedia.org/";
  w.b.windows[0].tabs.splice(w.b.windows[0].tabs.indexOf(other), 1);
  w.tick(AGENT_TAB_IDLE_MS + 1000);
  await w.tabs.sweep();
  assert.equal(w.b.closes().length, 0);
  assert.deepEqual(w.tabs.list(), []);
  assert.ok(w.b.urls().some(url => url === "https://www.wikipedia.org/"));
});

test("an owner-navigated tab is relinquished before explicit cleanup can relabel it", async (t) => {
  const w = world();
  t.after(() => w.tabs.stop());
  const tab = await w.opens("grok", "https://www.google.com/");
  tab.url = "https://en.wikipedia.org/wiki/Tab";
  // There is no proof this navigation was the agent's. A refresh cannot
  // adopt the owner's new page merely because the old tab id is the same.
  const result = await w.tabs.closeOwn("grok");
  assert.equal(result.closed, 0);
  assert.equal(w.tabs.list().length, 0);
  assert.ok(w.b.urls().some(url => url === "https://en.wikipedia.org/wiki/Tab"));
});

test("an agent closes its own tabs when it's done: all, or one site's", async (t) => {
  const w = world();
  t.after(() => w.tabs.stop());
  await w.opens("grok", "https://www.ubereats.com/");
  await w.opens("grok", "https://www.doordash.com/");
  await w.opens("muse", "https://www.amazon.com/");
  assert.deepEqual(await w.tabs.closeOwn("grok", { url: "https://ubereats.com" }), { closed: 1, open: 1 });
  assert.deepEqual(await w.tabs.closeOwn("grok"), { closed: 1, open: 0 });
  assert.ok(w.b.urls().some(url => url === "https://www.amazon.com/"), "another agent's tab stays");
  const none = await w.tabs.closeOwn("grok");
  assert.equal(none.closed, 0);
  assert.match(none.note, /close them yourself/);
});

test("past its own limit, an agent's oldest tab closes behind", async (t) => {
  const w = world();
  t.after(() => w.tabs.stop());
  for (let i = 0; i <= AGENT_TABS_EACH; i++) await w.opens("grok", `https://site${i}.example.com/`);
  await settle(w);
  assert.equal(w.tabs.list().length, AGENT_TABS_EACH);
  assert.ok(!w.b.urls().some(url => url === "https://site0.example.com/"));
  assert.ok(w.b.closes().every((request) => request.behind === true));
});

test("an agent's access ending closes its tabs at once", async (t) => {
  const w = world();
  t.after(() => w.tabs.stop());
  await w.opens("grok", "https://www.ubereats.com/");
  w.tabs.endClient("grok");
  await w.tabs.sweep();
  assert.deepEqual(w.tabs.list(), []);
  assert.equal(w.b.urls().length, 2);
});

test("after a restart, only the exact page a tab was left on closes, once the agent stays away", async (t) => {
  const b = browser();
  const first = world({ browser: b });
  await first.opens("grok", "https://www.ubereats.com/");
  const moved = await first.opens("grok", "https://www.doordash.com/");
  first.tabs.stop();
  // The browser restarted too and gave that id to a page of the owner's.
  moved.url = "https://www.doordash.com/orders";
  const again = world({ browser: b, dataDir: first.dataDir });
  t.after(() => again.tabs.stop());
  assert.equal(again.tabs.list().length, 2);
  await again.tabs.sweep();
  assert.equal(b.closes().length, 0, "not right after the start");
  again.tick(AGENT_TAB_IDLE_MS + 1000);
  await again.tabs.sweep();
  assert.deepEqual(b.urls(), ["https://mail.google.com/mail/u/0/", "https://news.ycombinator.com/", "https://www.doordash.com/orders"]);
});

test("reach_open_url lists the tabs first, keeps the new one, and the agent's close holds the computer", async (t) => {
  const b = browser();
  const tabs = createAgentTabs({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "reach-tabs-")), driver: b.driver, platform: "darwin", allowed: async () => true });
  t.after(() => tabs.stop());
  const client = { id: "grok", kind: "agent", name: "Grok", expiresAt: Date.now() + 600000 };
  client.policy = { invite: true, browser: true, preset: "apps", roots: [], apps: [{ id: "/Applications/Google Chrome.app", name: "Google Chrome", bundleId: "com.google.Chrome" }] };
  client.scopes = presetScopes(client.policy);
  const order = [];
  const helper = { requests: [], stopped: false,
    async send(request, beforeSend) {
      beforeSend?.();
      order.push(request.op);
      if (request.op === "open-url") { b.open(request.url); return { ok: true, app: "Google Chrome", bundle: "com.google.Chrome" }; }
      return { ok: true, app: "Google Chrome", bundle: "com.google.Chrome" };
    },
    stop() { this.stopped = true; } };
  const desktop = createAgentDesktop({ screen: true }, { available: () => true, hosts: () => [], titles: () => [], protectedPaths: () => [], home: "/Users/me",
    verifyClient: () => client, spawnHelper: async () => helper, pauses: createAgentPauses(),
    tabs: () => ({ ...tabs, before: async (...args) => { order.push("tabs"); return tabs.before(...args); } }) });
  t.after(() => desktop.close());
  await desktop.openUrl(client, "https://www.ubereats.com/", undefined, () => client);
  assert.deepEqual(order, ["tabs", "open-url"], "the tabs before the page opens");
  const result = await desktop.closeTabs(client, undefined, () => client);
  assert.deepEqual(result, { closed: 1, open: 0 });
  assert.equal(b.urls().length, 2);
  assert.ok(desktop.lastSeen("grok") > 0);
  await assert.rejects(() => desktop.closeTabs(client, "not a url", () => client), /web address/);
});

test("owner control beginning during an awaited cleanup read prevents the close", async t => {
  for (const automatic of [false, true]) {
    const w = world();
    let release, entered = false;
    const held = new Promise(resolve => { release = resolve; });
    const original = w.b.driver.transport;
    try {
      await w.opens("grok", "https://www.ubereats.com/");
      // A different front tab means a stale behind-only close is unsafe too.
      w.b.open("https://owner.example/");
      w.b.driver.transport = async function (name, request, options) {
        if (request.op === "tabs" && !entered) { entered = true; await held; }
        return original.call(this, name, request, options);
      };
      w.tick(AGENT_TAB_IDLE_MS + 1);
      const pending = automatic ? w.tabs.sweep() : w.tabs.closeOwn("grok");
      const result = pending.then(value => ({ value }), error => ({ error }));
      await settle(w);
      assert.equal(entered, true);
      w.owner(true); release();
      await result;
      assert.equal(w.b.closes().length, 0, automatic ? "sweep" : "explicit close");
      assert.ok(w.b.urls().some(url => url === "https://www.ubereats.com/"));
    } finally { release?.(); w.tabs.stop(); fs.rmSync(w.dataDir, { recursive: true, force: true }); }
  }
});

test("an uncertain close is visible and is never replayed by later cleanup", async t => {
  const w = world();
  t.after(() => { w.tabs.stop(); fs.rmSync(w.dataDir, { recursive: true, force: true }); });
  await w.opens("grok", "https://www.ubereats.com/");
  const original = w.b.driver.transport;
  let attempts = 0;
  w.b.driver.transport = async function (name, request, options) {
    if (request.op === "close") { attempts++; throw Object.assign(Error("lost close acknowledgement"), { code: "uncertain", uncertain: true }); }
    return original.call(this, name, request, options);
  };
  await assert.rejects(w.tabs.closeOwn("grok"), error => error.code === "uncertain" && error.uncertain === true);
  w.tick(AGENT_TAB_IDLE_MS + 1);
  await w.tabs.sweep(); await w.tabs.closeOwn("grok");
  assert.equal(attempts, 1, "a lost close answer cannot be treated as proof the close was unsent");
  assert.deepEqual(w.tabs.list(), []);
});

test("a known unsent close failure stays visible and can be retried safely", async t => {
  const w = world();
  t.after(() => { w.tabs.stop(); fs.rmSync(w.dataDir, { recursive: true, force: true }); });
  await w.opens("grok", "https://www.ubereats.com/");
  const original = w.b.driver.transport;
  let refused = false;
  w.b.driver.transport = async function (name, request, options) {
    if (request.op === "close" && !refused) { refused = true; throw Object.assign(Error("not sent"), { code: "unavailable", uncertain: false }); }
    return original.call(this, name, request, options);
  };
  await assert.rejects(w.tabs.closeOwn("grok"), error => error.code === "unavailable" && error.uncertain === false);
  assert.equal(w.tabs.list().length, 1);
  assert.equal((await w.tabs.closeOwn("grok")).closed, 1);
});

test("state loading cannot read a different leaf swapped after inspection", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-tabs-race-"));
  const file = path.join(dir, "agent-tabs.json"), outside = path.join(dir, "untrusted.json");
  fs.writeFileSync(file, "[]");
  fs.writeFileSync(outside, JSON.stringify([{ clientId: "other", browser: "Chrome", window: 1, tab: 2, url: "https://owner.example/" }]));
  const lstat = fs.lstatSync;
  let swapped = false, tabs;
  t.mock.method(fs, "lstatSync", function (name, ...args) {
    const value = lstat.call(this, name, ...args);
    if (name === file && !swapped) {
      swapped = true; fs.renameSync(file, file + ".original");
      // Symlink creation needs an extra Windows privilege. A regular-file
      // replacement there exercises the same descriptor identity boundary.
      if (process.platform === "win32") fs.renameSync(outside, file);
      else fs.symlinkSync(outside, file);
    }
    return value;
  });
  try {
    tabs = createAgentTabs({ dataDir: dir, driver: browser().driver });
    assert.deepEqual(tabs.list(), [], "only bytes from the checked regular descriptor may become saved ownership");
  } finally { tabs?.stop(); t.mock.restoreAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a state pathname removed after opening cannot leak its read descriptor", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-tabs-unlinked-")), file = path.join(dir, "agent-tabs.json");
  fs.writeFileSync(file, "[]");
  const open = fs.openSync, close = fs.closeSync;
  let descriptor, closed = 0, tabs;
  t.mock.method(fs, "openSync", function (name, ...args) {
    const fd = open.call(this, name, ...args);
    if (name === file) { descriptor = fd; fs.unlinkSync(file); }
    return fd;
  });
  t.mock.method(fs, "closeSync", function (fd, ...args) {
    if (fd === descriptor) closed++;
    return close.call(this, fd, ...args);
  });
  try {
    tabs = createAgentTabs({ dataDir: dir, driver: browser().driver });
    assert.deepEqual(tabs.list(), []);
    assert.ok(Number.isInteger(descriptor));
    assert.equal(closed, 1, "an opened state descriptor closes even if its pathname disappears");
    assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
  } finally { tabs?.stop(); t.mock.restoreAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("independently numbered Chrome and Edge tabs retain separate ownership", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-tabs-browsers-"));
  const live = { Chrome: [], Edge: [] }, closed = [];
  const driver = { async transport(name, request, options = {}) {
    options.beforeSend?.();
    if (request.op === "tabs") return live[name].map(value => ({ ...value }));
    if (request.op === "close") { closed.push(name); live[name] = []; return {}; }
    assert.fail("unexpected operation");
  } };
  const tabs = createAgentTabs({ dataDir: dir, driver, platform: "win32", allowed: async () => true });
  t.after(() => { tabs.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (const name of ["Chrome", "Edge"]) {
    const before = await tabs.before("grok", name === "Chrome" ? "exe:chrome.exe" : "exe:msedge.exe");
    live[name] = [{ window: 1, tab: 100, url: "https://example.com/" }];
    tabs.after(before, "https://example.com/", { bundle: name === "Chrome" ? "exe:chrome.exe" : "exe:msedge.exe" });
    await settle();
  }
  assert.deepEqual(tabs.list().map(entry => entry.browser).sort(), ["Chrome", "Edge"]);
  assert.equal((await tabs.closeOwn("grok")).closed, 2);
  assert.deepEqual(closed.sort(), ["Chrome", "Edge"]);
});

for (const platform of ["darwin", "win32"]) for (const url of ["mailto:help@example.com", "data:text/plain,all", "javascript:alert(1)", "file:///tmp/a", "ftp://example.com/"]) test(`${platform} invalid tab cleanup selector ${url} cannot become close-all`, async t => {
  const w = world();
  const client = { id: "grok", kind: "agent", name: "Grok", expiresAt: Date.now() + 600000,
    policy: { invite: true, browser: true, preset: "apps", roots: [], apps: [] } };
  client.scopes = presetScopes(client.policy);
  const desktop = createAgentDesktop({ screen: true }, { platform, available: () => true,
    pauses: createAgentPauses(), verifyClient: () => client, tabs: () => w.tabs });
  t.after(() => { desktop.close(); w.tabs.stop(); fs.rmSync(w.dataDir, { recursive: true, force: true }); });
  await w.opens(client.id, "https://example.com/keep");
  const original = w.b.urls();
  await assert.rejects(desktop.closeTabs(client, url, () => client), error => error.status === 400);
  assert.deepEqual(w.b.urls(), original, "invalid selection preserves every tracked and preexisting tab");
  assert.equal(w.b.closes().length, 0, "invalid selection dispatches no close");
  assert.equal(desktop.activity().holder, null, "invalid selection does not take the computer");
});

for (const change of ["revoked", "paused", "owner-takeover"]) test(`explicit cleanup holds queued work and refuses a late ${change}`, async t => {
  const w = world();
  const client = { id: "grok", kind: "agent", name: "Grok", expiresAt: Date.now() + 600000,
    policy: { invite: true, browser: true, preset: "apps", roots: [], apps: [] } };
  client.scopes = presetScopes(client.policy);
  let authorized = true, owner = false, release, entered = false, barrier;
  const held = new Promise(resolve => { release = resolve; });
  const desktop = createAgentDesktop({ screen: true }, {
    pauses: createAgentPauses(), verifyClient: () => authorized ? client : null, ownerUsing: () => owner,
    tabs: () => w.tabs,
  });
  t.after(() => { release(); desktop.close(); w.tabs.stop(); fs.rmSync(w.dataDir, { recursive: true, force: true }); });
  await w.opens("grok", "https://www.ubereats.com/");
  const original = w.b.driver.transport;
  w.b.driver.transport = async function (name, request, options) {
    if (request.op === "close") { entered = true; await held; }
    return original.call(this, name, request, options);
  };
  const pending = desktop.closeTabs(client, undefined, () => authorized ? client : null);
  const result = pending.then(value => ({ value }), error => ({ error }));
  await settle(); assert.equal(entered, true);
  if (change === "revoked") { authorized = false; desktop.cancelClient(client.id); }
  if (change === "paused") desktop.setPaused(client.id, true);
  if (change === "owner-takeover") {
    owner = true; w.owner(true);
    barrier = desktop.yieldForOwner();
    assert.ok(barrier, "queued cleanup is part of the owner's input-retirement barrier");
    let retired = false; barrier.then(() => { retired = true; });
    await settle(); assert.equal(retired, false, "an awaited dispatch cannot be forgotten before it settles");
  }
  release(); const outcome = await result;
  assert.ok(outcome.error);
  await barrier;
  assert.equal(w.b.closes().length, 0);
  assert.equal(desktop.activity().holder, null, "the cancelled cleanup retires before a replacement writer");
});

test("an unconfirmed dispatched cleanup keeps owner takeover blocked until a late completion", async t => {
  const client = { id: "grok", kind: "agent", name: "Grok", expiresAt: Date.now() + 600000,
    policy: { invite: true, browser: true, preset: "apps", roots: [], apps: [] } };
  client.scopes = presetScopes(client.policy);
  let fence;
  const desktop = createAgentDesktop({ screen: true }, { pauses: createAgentPauses(), verifyClient: () => client,
    tabs: () => ({ async closeOwn(_id, options) {
      fence = options.retirement.hold();
      fence.fail();
      throw Object.assign(Error("close result unknown"), { code: "uncertain", uncertain: true });
    } }) });
  t.after(() => { fence?.done(); desktop.close(); });
  await assert.rejects(desktop.closeTabs(client, undefined, () => client), error => error.uncertain === true);
  assert.equal(desktop.activity().holder.clientId, client.id, "request rejection is not proof its effect ended");
  await assert.rejects(desktop.yieldForOwner(), error => error.status === 503 && /could not confirm/.test(error.message));
  fence.done(); await settle();
  assert.equal(desktop.activity().holder, null);
});

test("automatic cleanup is included in owner takeover's dispatched-effect barrier", async t => {
  let desktop, release, entered = false;
  const w = world({ track: (id, work) => desktop.trackTabCleanup(id, work) });
  const held = new Promise(resolve => { release = resolve; });
  desktop = createAgentDesktop({ screen: true }, { pauses: createAgentPauses() });
  t.after(() => { release(); w.tabs.stop(); desktop.close(); fs.rmSync(w.dataDir, { recursive: true, force: true }); });
  await w.opens("grok", "https://www.ubereats.com/");
  const original = w.b.driver.transport;
  w.b.driver.transport = async function (name, request, options) {
    if (request.op !== "close") return original.call(this, name, request, options);
    options.beforeSend();
    const fence = options.retirement.hold();
    entered = true; await held;
    // Already sent: cancellation cannot undo this simulated browser effect.
    const value = await original.call(this, name, request);
    fence.done();
    return value;
  };
  w.tick(AGENT_TAB_IDLE_MS + 1);
  const cleanup = w.tabs.sweep();
  await settle(); assert.equal(entered, true);
  const barrier = desktop.yieldForOwner();
  assert.ok(barrier);
  let retired = false; barrier.then(() => { retired = true; });
  await settle(); assert.equal(retired, false);
  release(); await cleanup; await barrier;
  assert.equal(retired, true);
  assert.equal(w.b.closes().length, 1);
  assert.equal(desktop.activity().holder, null);
});

test("automatic cleanup rechecks a global pause immediately before its queued send", async t => {
  let desktop, release, entered = false, paused = false;
  const w = world({ track: (id, work) => desktop.trackTabCleanup(id, work) });
  const held = new Promise(resolve => { release = resolve; });
  desktop = createAgentDesktop({ screen: true }, { pauses: createAgentPauses(), paused: () => paused });
  t.after(() => { release(); w.tabs.stop(); desktop.close(); fs.rmSync(w.dataDir, { recursive: true, force: true }); });
  await w.opens("grok", "https://www.ubereats.com/");
  const original = w.b.driver.transport;
  w.b.driver.transport = async function (name, request, options) {
    if (request.op === "close") { entered = true; await held; }
    return original.call(this, name, request, options);
  };
  w.tick(AGENT_TAB_IDLE_MS + 1);
  const cleanup = w.tabs.sweep();
  await settle(); assert.equal(entered, true);
  paused = true; release(); await cleanup;
  assert.equal(w.b.closes().length, 0);
  assert.equal(w.tabs.list().length, 1, "the unsent paused close remains eligible only after control resumes");
});

test("a state file growing after descriptor inspection is read only within the existing cap", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-tabs-growth-"));
  const file = path.join(dir, "agent-tabs.json");
  fs.writeFileSync(file, "[]");
  const payload = JSON.stringify([{ clientId: "other", browser: "Chrome", window: 1, tab: 2,
    url: "https://owner.example/" + "x".repeat(260 * 1024) }]);
  let changed = false, tabs;
  const grow = value => { if (!changed) { changed = true; fs.writeFileSync(file, payload); } return value; };
  const stat = fs.statSync, fstat = fs.fstatSync;
  t.mock.method(fs, "statSync", function (name, ...args) { const value = stat.call(this, name, ...args); return name === file ? grow(value) : value; });
  t.mock.method(fs, "fstatSync", function (...args) { return grow(fstat.apply(this, args)); });
  try {
    tabs = createAgentTabs({ dataDir: dir, driver: browser().driver });
    assert.equal(changed, true);
    assert.deepEqual(tabs.list(), []);
  } finally { tabs?.stop(); t.mock.restoreAll(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("activity relinquishes another origin and keeps an unchanged owned page eligible", async t => {
  const w = world();
  try {
    const owner = await w.opens("grok", "https://agent.github.io/");
    owner.url = "https://owner.github.io/";
    t.mock.timers.enable({ apis: ["setTimeout"] });
    w.tabs.activity("grok", { bundle: "com.google.Chrome" });
    t.mock.timers.tick(2000); await settle();
    assert.deepEqual(w.tabs.list(), [], "different tenants sharing a public suffix are still different origins");
    assert.ok(w.b.urls().some(url => url === "https://owner.github.io/"));
    t.mock.timers.reset();
    await w.opens("grok", "https://www.ubereats.com/");
    assert.equal((await w.tabs.closeOwn("grok")).closed, 1);
    assert.ok(w.b.urls().some(url => url === "https://owner.github.io/"));
  } finally { t.mock.timers.reset(); w.tabs.stop(); fs.rmSync(w.dataDir, { recursive: true, force: true }); }
});

for (const [change, nextURL] of [
  ["path", "https://www.ubereats.com/orders"],
  ["query", "https://www.ubereats.com/?owner=taken"],
  ["fragment", "https://www.ubereats.com/#owner-taken"],
]) for (const cleanup of ["explicit", "activity", "automatic"]) test(`same-origin owner ${change} navigation is relinquished before ${cleanup} cleanup`, async t => {
  const w = world();
  try {
    const tab = await w.opens("grok", "https://www.ubereats.com/");
    tab.url = nextURL;
    if (cleanup === "activity") {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      w.tabs.activity("grok", { bundle: "com.google.Chrome" });
      t.mock.timers.tick(2000); await settle();
      assert.deepEqual(w.tabs.list(), [], "later agent activity cannot adopt the owner's changed page");
    } else if (cleanup === "automatic") {
      w.tick(AGENT_TAB_IDLE_MS + 1);
      await w.tabs.sweep();
    } else assert.equal((await w.tabs.closeOwn("grok")).closed, 0);
    assert.deepEqual(w.tabs.list(), []);
    assert.equal(w.b.closes().length, 0, "a changed same-origin page has no close authority");
    assert.ok(w.b.urls().some(url => url === nextURL));
  } finally { t.mock.timers.reset(); w.tabs.stop(); fs.rmSync(w.dataDir, { recursive: true, force: true }); }
});

for (const discovery of ["redirect", "concurrent open"]) test(`tab discovery does not claim an ambiguous ${discovery}`, async t => {
  const w = world();
  t.after(() => { w.tabs.stop(); fs.rmSync(w.dataDir, { recursive: true, force: true }); });
  const token = await w.tabs.before("grok");
  w.b.open(discovery === "redirect" ? "https://example.com/owner-page" : "https://example.com/");
  if (discovery === "concurrent open") w.b.open("https://owner.example/");
  w.tabs.after(token, "https://example.com/", { bundle: "com.google.Chrome" });
  assert.equal((await w.tabs.closeOwn("grok")).closed, 0);
  assert.deepEqual(w.tabs.list(), []);
  assert.equal(w.b.closes().length, 0);
});

test("tab discovery matches the canonical requested URL without adopting navigation", async t => {
  const w = world();
  t.after(() => { w.tabs.stop(); fs.rmSync(w.dataDir, { recursive: true, force: true }); });
  const token = await w.tabs.before("grok");
  w.b.open("https://example.com/");
  w.tabs.after(token, "https://EXAMPLE.com:443", { bundle: "com.google.Chrome" });
  assert.equal((await w.tabs.closeOwn("grok")).closed, 1);
  assert.deepEqual(w.tabs.list(), []);
});

for (const change of ["revoked", "stopped"]) test(`a pending tab-discovery response cannot claim ownership after cleanup is ${change}`, async t => {
  const w = world();
  let release, entered = false;
  const held = new Promise(resolve => { release = resolve; });
  try {
    const before = await w.tabs.before("grok");
    w.b.open("https://www.ubereats.com/");
    const original = w.b.driver.transport;
    w.b.driver.transport = async function (name, request, options) {
      if (request.op === "tabs" && !entered) { entered = true; await held; }
      return original.call(this, name, request, options);
    };
    w.tabs.after(before, "https://www.ubereats.com/", { bundle: "com.google.Chrome" });
    await settle(); assert.equal(entered, true);
    if (change === "revoked") w.tabs.endClient("grok"); else w.tabs.stop();
    release(); await settle();
    assert.deepEqual(w.tabs.list(), []);
    assert.equal(w.b.closes().length, 0);
  } finally { release(); w.tabs.stop(); fs.rmSync(w.dataDir, { recursive: true, force: true }); }
});
