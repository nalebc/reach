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
    async transport(name, request) {
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
    lastSeen: (id) => seen.get(id) ?? 0, holder: () => holder, ownerUsing: () => owner, idle: async () => idle });
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
  assert.ok(w.b.urls().includes("https://www.wikipedia.org/"));
});

test("pages the agent went on to are still its own: its activity says where its tabs are", async (t) => {
  const w = world();
  t.after(() => w.tabs.stop());
  const tab = await w.opens("grok", "https://www.google.com/");
  tab.url = "https://en.wikipedia.org/wiki/Tab";
  // The agent's own click took it there; a moment later Reach looks.
  const result = await w.tabs.closeOwn("grok");
  assert.deepEqual(result, { closed: 1, open: 0 });
  assert.ok(!w.b.urls().includes("https://en.wikipedia.org/wiki/Tab"));
});

test("an agent closes its own tabs when it's done: all, or one site's", async (t) => {
  const w = world();
  t.after(() => w.tabs.stop());
  await w.opens("grok", "https://www.ubereats.com/");
  await w.opens("grok", "https://www.doordash.com/");
  await w.opens("muse", "https://www.amazon.com/");
  assert.deepEqual(await w.tabs.closeOwn("grok", { url: "https://ubereats.com" }), { closed: 1, open: 1 });
  assert.deepEqual(await w.tabs.closeOwn("grok"), { closed: 1, open: 0 });
  assert.ok(w.b.urls().includes("https://www.amazon.com/"), "another agent's tab stays");
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
  assert.ok(!w.b.urls().includes("https://site0.example.com/"));
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
