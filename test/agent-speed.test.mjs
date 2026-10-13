import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { CHANGES_MS, createObservations, screenChanges, SETTLE, settleScreen } from "../server/desktop-observation.mjs";
import { describeScreen } from "../server/agent-desktop.mjs";
import { ACT_AND_SEE, GO_FAST, browserToolsFor } from "../server/browser-tools.mjs";
import { serveMcp, toolsFor, serverInstructions, withGuide } from "../scripts/mcp-server.mjs";
import { agentGuide } from "../server/agent-guide.mjs";
import { presetScopes } from "../server/agent-presets.mjs";
import { presetFixture, privateIngressTest, apps } from "./helpers/preset-fixture.mjs";

// Oct 12: "Agents using MCP to control the Mac are very slow today. How can
// we make navigation super fast and smooth". A step was act, then look, then
// act: two of the agent's turns (~30 s each) where one does. Acting now
// answers with the screen, once it has settled.

const screenOf = (title, items = [], texts = []) => ({ snapshot: `s-${title}`, app: "Browser", title, items, texts, truncated: false });

test("the screen settles after one still window, bounded, read once", async () => {
  let clock = 0, reads = 0, authorized = 0;
  const now = () => clock;
  const read = async () => { reads++; return screenOf(`read ${reads}`); };
  // Two changes, then still: one read, after the still window.
  let changes = 2;
  const changed = async (revision, ms) => { clock += changes > 0 ? 50 : ms; return { revision: (revision ?? 0) + 1, changed: changes-- > 0 }; };
  const settled = await settleScreen({ read, changed, authorize: () => { authorized++; }, capMs: SETTLE.actMs, now });
  assert.equal(reads, 1);
  assert.equal(settled.screen.title, "read 1");
  assert.equal(settled.settledMs, 100 + SETTLE.quietMs);
  assert.ok(authorized >= 4, "authorized on every round");
  // Never still: stops at the cap, without a read (the caller reads once).
  clock = 0; reads = 0;
  const busy = await settleScreen({ read, changed: async (revision, ms) => { clock += ms; return { revision: 1, changed: true }; }, authorize() {}, capMs: SETTLE.openMs, now });
  assert.equal(busy.screen, null);
  assert.equal(reads, 0);
  assert.ok(busy.settledMs <= SETTLE.openMs, `${busy.settledMs} ms`);
  // An open waits at least openMinMs for something to happen.
  clock = 0; reads = 0;
  const quiet = await settleScreen({ read, changed: async (revision, ms) => { clock += ms; return { revision: 1, changed: false }; }, authorize() {}, capMs: SETTLE.openMs, minMs: SETTLE.openMinMs, now });
  assert.ok(quiet.settledMs >= SETTLE.openMinMs && quiet.settledMs < SETTLE.openMs, `${quiet.settledMs} ms`);
  assert.equal(reads, 1);
  // A helper that can't wait: the screen as it is (the caller reads it).
  const unable = await settleScreen({ read, changed: async () => { throw Error("unknown op"); }, authorize() {}, capMs: SETTLE.openMs, now });
  assert.equal(unable.screen, null);
  // Access gone mid-wait: no more waiting, no read.
  reads = 0;
  await assert.rejects(settleScreen({ read, changed: async () => ({ changed: true }), authorize: () => { throw Object.assign(Error("Access expired or was revoked."), { status: 401 }); }, capMs: 1000, now }), /revoked/);
  assert.equal(reads, 0);
});

test("a page still loading (its Stop button showing) is waited for, within the cap", async () => {
  let clock = 0, reads = 0;
  const now = () => clock;
  const stop = { n: 1, role: "Button", name: "Stop loading this page", x: 0, y: 0, w: 0, h: 0 };
  const reload = { ...stop, name: "Reload this page" };
  const read = async () => { reads++; return screenOf(reads < 3 ? "Loading" : "Uber Eats", [reads < 3 ? stop : reload]); };
  // Still windows between reads; a change before each of the later reads.
  let round = 0;
  const changed = async (revision, ms) => { round++; clock += ms; return { revision: round, changed: round % 2 === 0 }; };
  const settled = await settleScreen({ read, changed, authorize() {}, capMs: SETTLE.openMs, minMs: 0, now });
  assert.equal(settled.screen.title, "Uber Eats");
  assert.equal(reads, 3, "read again only after the page changed");
  assert.ok(settled.settledMs <= SETTLE.openMs);
  // Loading the whole time: the last read, at the cap.
  clock = 0; reads = 0; round = 0;
  const slow = await settleScreen({ read: async () => { reads++; return screenOf("Loading", [stop]); }, changed, authorize() {}, capMs: SETTLE.openMs, now });
  assert.equal(slow.screen.title, "Loading");
  assert.ok(slow.settledMs <= SETTLE.openMs && reads <= 6, `${reads} reads in ${slow.settledMs} ms`);
});

test("without a change signal, reads compared by what they show, the same rules and bounds", async () => {
  let clock = 0, reads = 0;
  const now = () => clock, sleep = async (ms) => { clock += ms; };
  const read = async () => { reads++; return screenOf(reads < 3 ? `frame ${reads}` : "done"); };
  const settled = await settleScreen({ read, changed: null, authorize() {}, capMs: SETTLE.openMs, minMs: SETTLE.openMinMs, now, sleep });
  assert.equal(settled.screen.title, "done");
  assert.equal(reads, 4, "two the same in a row");
  clock = 0; reads = 0;
  const flicker = await settleScreen({ read: async () => screenOf(`frame ${++reads}`), changed: null, authorize() {}, capMs: SETTLE.actMs, now, sleep });
  assert.ok(flicker.settledMs <= SETTLE.actMs && reads <= 5, `${reads} reads`);
});

// The stand-in Mac behind the routes: its screen as the accessibility tree
// reads it, a change signal, and the native helper's own check of a
// snapshot and number (it keeps 16 snapshots; an older one is refused).
// Enter moves to the next of `pages`.
function standIn({ pages = [] } = {}) {
  const log = [];
  let page = 0, revision = 10, snapshotCount = 0, holder = null;
  const snapshots = [];
  const screens = pages.length ? pages : [
    screenOf("Uber Eats", [{ n: 1, role: "TextField", name: "Search", value: "", x: 0.3, y: 0.1, w: 0.2, h: 0.02 }, { n: 2, role: "Button", name: "Search", x: 0.5, y: 0.1, w: 0.05, h: 0.02 }],
      [{ text: "Deals near you", heading: true, x: 0.1, y: 0.3, w: 0.2, h: 0.02 }]),
  ];
  const extras = {
    act: async (client, action, authorize) => {
      authorize(); log.push(["act", action]);
      if (holder && holder !== client.id) throw Object.assign(Error("Muse is using the Mac right now."), { status: 409, kind: "busy", holder: "Muse", retryInMs: 900 });
      if (action.type === "element" && !snapshots.slice(-16).includes(action.snapshot)) throw Object.assign(Error("That label is from an older look. Look at the labels again."), { status: 409, kind: "retry" });
      if (action.type === "key" && action.key === "enter") { page = Math.min(page + 1, screens.length - 1); revision++; }
      return { ok: true, app: "Browser", bundle: "com.browser" };
    },
    openUrl: async (client, url, browser, authorize) => { authorize(); log.push(["open-url", url]); revision++; return { ok: true, app: "Browser", bundle: "com.browser" }; },
    open: async (client, app, authorize) => { authorize(); log.push(["open", app]); revision++; return { ok: true, app: "Browser", bundle: "com.browser" }; },
    elements: async (client, authorize) => {
      authorize(); log.push(["read"]);
      const id = `snap${++snapshotCount}`;
      snapshots.push(id);
      return { ...structuredClone(screens[page]), snapshot: id, revision };
    },
    waitForChange: async (client, since, ms, authorize) => {
      authorize(); log.push(["wait-change"]);
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20)));
      return { revision, changed: since !== undefined && since !== revision };
    },
  };
  return { extras, log, hold: (id) => { holder = id; }, reads: () => log.filter(([op]) => op === "read").length };
}
const call = (agent, name, args) => agent.as("/api/browser/mcp/call", { method: "POST", body: { name, arguments: args } });

test("acting answers with the screen; describe: false opts out; a refused action is refused as before", privateIngressTest, async (t) => {
  const mac = standIn();
  const f = await presetFixture(t, { desktopExtras: mac.extras });
  const agent = await f.join({ preset: "full" });
  // One call: the action, then the screen once still.
  const typed = await call(agent, "reach_act", { action: { type: "type", text: "diapers" } });
  assert.equal(typed.status, 200, JSON.stringify(typed.body));
  assert.equal(typed.body.result.ok, true);
  assert.equal(typed.body.result.done, 1);
  assert.match(typed.body.result.screen.text, /^Browser — Uber Eats/);
  assert.match(typed.body.result.screen.text, /\[1\] .*TextField "Search"/);
  assert.ok(mac.log.findIndex(([op]) => op === "wait-change") > mac.log.findIndex(([op]) => op === "act"), "settled after acting");
  assert.equal(mac.reads(), 1, "read once");
  // Pressed by name and filled the same way.
  assert.match((await call(agent, "reach_press", { name: "Search" })).body.result.screen.text, /Uber Eats/);
  // describe: false: the action alone, as before.
  const before = mac.reads();
  const plain = await call(agent, "reach_act", { action: { type: "key", key: "tab" }, describe: false });
  assert.deepEqual(plain.body.result, { ok: true, app: "Browser", bundle: "com.browser" });
  assert.equal(mac.reads(), before);
  // Refused: its status and kind, as an action alone always was; nothing read.
  mac.hold("someone-else");
  const refused = await call(agent, "reach_act", { action: { type: "key", key: "tab" } });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.body, { error: "Muse is using the Mac right now.", kind: "busy", holder: "Muse", retryInMs: 900 });
  // A batch still stops at the refused one and says why, with the screen.
  const batch = await call(agent, "reach_act", { actions: [{ type: "key", key: "tab" }, { type: "type", text: "never" }] });
  assert.equal(batch.status, 200);
  assert.deepEqual([batch.body.result.ok, batch.body.result.stopped.kind], [false, "busy"]);
  assert.ok(!mac.log.some(([op, action]) => op === "act" && action.text === "never"));
  mac.hold(null);
});

test("opening a page waits for it to settle, bounded, and answers with its screen", privateIngressTest, async (t) => {
  const mac = standIn();
  const f = await presetFixture(t, { desktopExtras: mac.extras });
  const agent = await f.join({ preset: "apps", apps: [{ id: apps.chrome.id }] });
  const started = Date.now();
  const opened = await call(agent, "reach_open_url", { url: "https://www.ubereats.com", browser: apps.chrome.id });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.equal(opened.body.result.ok, true);
  assert.match(opened.body.result.screen.text, /Uber Eats/);
  assert.ok(Date.now() - started < SETTLE.openMs + 2000, "bounded");
  assert.ok(mac.log.filter(([op]) => op === "wait-change").length >= 1);
  assert.equal(mac.reads(), 1);
  // Opening an app: the same.
  assert.match((await call(agent, "reach_open_app", { app: "Google Chrome" })).body.result.screen.text, /Uber Eats/);
  // Told not to: answers once it is in front, as before.
  const quick = await call(agent, "reach_open_url", { url: "https://www.ubereats.com", describe: false });
  assert.deepEqual(quick.body.result, { ok: true, app: "Browser", bundle: "com.browser" });
  // Asked directly, the routes answer as they always did.
  assert.deepEqual((await agent.as("/api/browser/desktop/open-url", { method: "POST", body: { url: "https://www.ubereats.com" } })).body, { ok: true, app: "Browser", bundle: "com.browser" });
  assert.equal((await agent.as("/api/browser/desktop/open-url", { method: "POST", body: { url: "https://www.ubereats.com", describe: false } })).status, 400);
});

test("where the screen can't be read as text, acting answers as it always did", privateIngressTest, async (t) => {
  const f = await presetFixture(t, { desktopExtras: {
    act: async (client, action, authorize) => { authorize(); return { ok: true, app: "Notes", bundle: "com.apple.Notes" }; },
  } });
  const agent = await f.join({ preset: "full" });
  const result = await call(agent, "reach_act", { action: { type: "key", key: "tab" } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual(result.body.result, { ok: true, done: 1, results: [{ ok: true, app: "Notes", bundle: "com.apple.Notes" }] });
});

// Agents find tools from their descriptions (Oct 10: Grok missed a listed
// batch tool), so every connection says it in the same words: the tools an
// MCP client lists over stdio and at /mcp (toolsFor), Reach's own list for an
// agent's copy (/api/browser/mcp/tools), and the agent page's (browserToolsFor).
test("every connection says it the same way: act and see, up to 10 at once, wait_for instead of looks", privateIngressTest, async (t) => {
  const acting = ["reach_act", "reach_press", "reach_fill", "reach_open_app", "reach_open_url", "reach_open_bank", "reach_open_file", "reach_focus_window"];
  for (const preset of ["full", "apps"]) {
    const access = { preset, screen: true, control: true, open: true, shell: preset === "full", roots: preset === "full" ? [{ index: 0, name: "Home", path: "/Users/me" }] : [], terminals: [], apps: [] };
    const mcp = new Map(toolsFor(presetScopes({ preset }), access).map((tool) => [tool.name, tool]));
    const page = new Map(browserToolsFor(access).map((tool) => [tool.name, tool]));
    for (const name of acting) {
      if (!page.has(name)) { assert.equal(mcp.has(name), false, name); continue; }
      assert.equal(mcp.get(name).description, page.get(name).description, `${preset} ${name}`);
      assert.ok(mcp.get(name).description.includes(ACT_AND_SEE), `${preset} ${name} says it`);
      assert.deepEqual(mcp.get(name).inputSchema.properties.describe.enum, [true, false], name);
    }
    assert.match(mcp.get("reach_act").description, /^Act on the Mac and get the screen back: one action, or actions: up to 10/);
    assert.match(mcp.get("reach_describe_screen").description, /every action then answers with the screen/);
    assert.match(mcp.get("reach_wait_for").description, /instead of describing again and again/);
    // What it reads on connecting: the task map, then its guide.
    const told = withGuide(serverInstructions(presetScopes({ preset })), agentGuide({ kind: "agent", scopes: presetScopes({ preset }), policy: { browser: true, preset, apps: [] } }, { word: "Mac" })).instructions;
    assert.equal(told.split(GO_FAST).length, 2, "once");
    assert.match(GO_FAST, /get the screen back/);
    assert.match(GO_FAST, /up to 10 actions in one reach_act/);
    assert.match(GO_FAST, /reach_wait_for instead of looking again/);
  }
  // Agents that can't act aren't told to.
  for (const preset of ["readonly", "files"])
    assert.doesNotMatch(agentGuide({ kind: "agent", scopes: presetScopes({ preset }), policy: { browser: true, preset } }, { word: "Mac" }), /reach_act/);
  // Reach's own list, as the agent's copy (stdio, `join`, `call`) reads it, is the same list.
  const f = await presetFixture(t, { desktopExtras: standIn().extras });
  const agent = await f.join({ preset: "full" });
  const served = (await agent.as("/api/browser/mcp/tools")).body.tools;
  const view = (await agent.as("/api/browser")).body;
  assert.deepEqual(served.map((tool) => [tool.name, tool.description]), toolsFor(presetScopes({ preset: "full" }), view).map((tool) => [tool.name, tool.description]));
  assert.ok(served.find((tool) => tool.name === "reach_act").description.includes(ACT_AND_SEE));
  // Over stdio, the copy lists exactly those, and is told at initialize.
  const input = new PassThrough(), output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk; });
  const run = serveMcp({ input, output, scopes: presetScopes({ preset: "full" }), api: async (route, method = "GET", body) => (await agent.as(route, { method, body })).body });
  input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
  input.end(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  await run;
  const [init, list] = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(init.result.instructions.includes(GO_FAST), init.result.instructions);
  assert.deepEqual(list.result.tools.map((tool) => tool.description), served.map((tool) => tool.description));
});

// Only what changed since the agent's last whole look (Oct 12: "send only
// what changed").
const agentClient = { id: "agent", expiresAt: 100, scopes: ["browser:control"], policy: { preset: "full" } };
const control = (n, role, name, extra = {}) => ({ n, ref: `e-${role.toLowerCase()}-${name.toLowerCase().replace(/\W+/g, "-")}${extra.key || ""}`, role, name, x: 0.1, y: n / 200, w: 0.1, h: 0.004,
  ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "key")) });
// A store's results page at a real size: a toolbar, a search field, 40
// results with a link, a price, stars, delivery and an Add to cart each.
function storePage({ search = "", cart = 0, prefix = [], title = "Amazon.com : diapers", added = null } = {}) {
  const items = [...prefix.map((name) => ({ role: "Button", name })),
    { role: "Button", name: "Back" }, { role: "Button", name: "Reload this page" }, { role: "TextField", name: "Address and search bar", value: "https://www.amazon.com/s?k=diapers" },
    { role: "SearchField", name: "Search Amazon", value: search }, { role: "Button", name: "Go" }, { role: "Link", name: `Cart, ${cart} items` }];
  const texts = [{ text: "Results", heading: true }, { text: "Check each product page for other buying options." }];
  for (let i = 1; i <= 40; i++) {
    items.push({ role: "Link", name: `Pampers Swaddlers Diapers, Size ${i % 7}, ${80 + i} Count, item ${i}`, context: `Result ${i}` },
      { role: "Button", name: "Add to cart", context: `Result ${i}`, key: `-${i}` });
    texts.push({ text: `$${(30 + i * 0.37).toFixed(2)} ($0.${30 + i}/Count)`, context: `Result ${i}` }, { text: `${(4 + (i % 10) / 10).toFixed(1)} out of 5 stars, ${1000 + i * 17} ratings`, context: `Result ${i}` },
      { text: "FREE delivery Tue, Oct 14 on $35 of items shipped by Amazon", context: `Result ${i}` });
  }
  if (added) texts.push({ text: `Added to cart: ${added}`, heading: true });
  texts.push({ text: "Back to top" }, { text: "© 1996-2026, Amazon.com, Inc. or its affiliates" });
  return { snapshot: `snap-${search.replace(/\W+/g, "-")}-${cart}-${prefix.length}`, app: "Google Chrome", title, windowRef: "w-1", displayId: 1, truncated: false,
    items: items.map((item, index) => control(index + 1, item.role, item.name, item)), texts: texts.map((line, index) => ({ ...line, x: 0.1, y: index / 300, w: 0.3, h: 0.003 })) };
}

test("after acting, only what changed since the last whole look; the whole text on the first look, a new page, a big change, or when asked", () => {
  let clock = 1_000;
  const observe = createObservations({ now: () => clock });
  const first = observe(agentClient, storePage(), {}, { changes: true });
  assert.equal(first.diff, undefined, "the first look is whole");
  assert.equal(first.text, describeScreen(first));
  // Typed into the search field: one line, the field with its new value.
  const typed = storePage({ search: "diapers size 1" });
  const after = observe(agentClient, typed, {}, { changes: true });
  assert.equal(after.diff, true);
  assert.equal(after.text, [
    "Google Chrome — Amazon.com : diapers",
    `Changed since your last look; the rest is as it was, numbers included. Click a [number] with reach_act {"action":{"type":"element","snapshot":"${typed.snapshot}","n":NUMBER}}.`,
    `~ [4] {e-searchfield-search-amazon} SearchField "Search Amazon" = "diapers size 1"`,
  ].join("\n"));
  assert.ok(after.saved > 1000, `${after.saved} tokens spared`);
  // Added to cart: the cart link renamed (another control), a line of text.
  const added = storePage({ search: "diapers size 1", cart: 1, added: "Pampers Swaddlers" });
  const cart = observe(agentClient, added, {}, { changes: true });
  assert.deepEqual(cart.text.split("\n").slice(2), ["+ [6] {e-link-cart-1-items} Link \"Cart, 1 items\"", "- [6] {e-link-cart-0-items} Link \"Cart, 0 items\"", "+ # Added to cart: Pampers Swaddlers"]);
  // Asked for all of it: the whole text, and that is the last look now.
  const whole = observe(agentClient, added, {}, { changes: true, full: true });
  assert.equal(whole.diff, undefined);
  assert.match(whole.text, /Pampers Swaddlers Diapers, Size 1, 81 Count/);
  assert.match(observe(agentClient, added, {}, { changes: true }).text, /^Google Chrome — Amazon\.com : diapers\nNothing changed since your last look\./);
  // A banner on top moves every number down: each one moved is listed, so
  // that's most of the page, and the whole text comes instead.
  const shifted = observe(agentClient, storePage({ search: "diapers size 1", cart: 1, added: "Pampers Swaddlers", prefix: ["Accept cookies"] }), {}, { changes: true });
  assert.equal(shifted.diff, undefined, "too big a change: the whole text");
  // Another page (its title), a long pause, a narrowed look: the whole text.
  assert.equal(observe(agentClient, storePage({ title: "Your cart" }), {}, { changes: true }).diff, undefined);
  observe(agentClient, storePage(), {}, {});
  clock += CHANGES_MS + 1;
  assert.equal(observe(agentClient, storePage({ search: "x" }), {}, { changes: true }).diff, undefined, "a look over five minutes old");
  observe(agentClient, storePage(), { query: "Size 1" }, {});
  assert.equal(observe(agentClient, storePage({ search: "y" }), {}, { changes: true }).diff, undefined, "the agent last saw only part of it");
  observe(agentClient, storePage(), { maxChars: 500 }, {});
  assert.equal(observe(agentClient, storePage({ search: "z" }), {}, { changes: true }).diff, undefined, "cut short: not seen whole");
  // Another agent, or this one after its access changed, starts whole.
  observe(agentClient, storePage(), {}, {});
  assert.equal(observe({ ...agentClient, id: "other" }, storePage({ search: "a" }), {}, { changes: true }).diff, undefined);
  assert.equal(observe({ ...agentClient, policy: { preset: "apps" } }, storePage({ search: "a" }), {}, { changes: true }).diff, undefined);
});

test("every control not listed keeps its number in the new snapshot; secrets stay hidden in the list", () => {
  const before = storePage();
  // Two results swap places (re-sorted), one control goes, a password field comes.
  const after = structuredClone(before);
  after.snapshot = "snap-after";
  const [a, b] = [after.items.findIndex((item) => item.context === "Result 3" && item.role === "Link"), after.items.findIndex((item) => item.context === "Result 4" && item.role === "Link")];
  [after.items[a], after.items[b]] = [after.items[b], after.items[a]];
  after.items.splice(after.items.findIndex((item) => item.context === "Result 9" && item.role === "Button"), 1);
  after.items.push(control(0, "SecureTextField", "Password", { secure: true, value: "hunter2" }));
  after.items = after.items.map((item, index) => ({ ...item, n: index + 1 }));
  const text = screenChanges(before, after);
  const listed = new Set([...text.matchAll(/^[+~] \[(\d+)\]/gm)].map((match) => Number(match[1])));
  const old = new Map(before.items.map((item) => [item.ref, item.n]));
  for (const item of after.items) if (!listed.has(item.n)) assert.equal(old.get(item.ref), item.n, `${item.name} kept its number`);
  assert.match(text, /\(password field: sign in from your vault\)/);
  assert.doesNotMatch(text, /hunter2/);
  assert.match(text, /^- \[\d+\] \{e-button-add-to-cart-9\} Button "Add to cart" in "Result 9"$/m);
});

test("through the routes: whole first, then what changed, a stale snapshot refused, the saving recorded", privateIngressTest, async (t) => {
  // Enter: the search field holds "diapers size 1", then the cart page.
  const mac = standIn({ pages: [storePage(), storePage({ search: "diapers size 1" }), storePage({ title: "Amazon.com Shopping Cart", added: "Pampers Swaddlers" })] });
  const f = await presetFixture(t, { desktopExtras: mac.extras });
  const agent = await f.join({ preset: "full" });
  const look = await call(agent, "reach_describe_screen", {});
  assert.match(look.body.result.screenText, /^Google Chrome — Amazon\.com : diapers/);
  const first = look.body.result.snapshot;
  // The same page after acting: only what changed.
  const searched = await call(agent, "reach_act", { actions: [{ type: "type", text: "diapers size 1" }, { type: "key", key: "enter" }] });
  assert.equal(searched.status, 200, JSON.stringify(searched.body));
  const screen = searched.body.result.screen;
  assert.equal(screen.diff, true, screen.text);
  assert.notEqual(screen.snapshot, first);
  assert.equal(screen.text, [
    "Google Chrome — Amazon.com : diapers",
    `Changed since your last look; the rest is as it was, numbers included. Click a [number] with reach_act {"action":{"type":"element","snapshot":"${screen.snapshot}","n":NUMBER}}.`,
    `~ [4] {e-searchfield-search-amazon} SearchField "Search Amazon" = "diapers size 1"`,
  ].join("\n"));
  // Another page: the whole of it.
  const paged = (await call(agent, "reach_act", { action: { type: "key", key: "enter" } })).body.result.screen;
  assert.equal(paged.diff, undefined);
  assert.match(paged.text, /^Google Chrome — Amazon\.com Shopping Cart\n/);
  assert.match(paged.text, /Pampers Swaddlers Diapers, Size 1, 81 Count/);
  // A number from that list, with its snapshot: clicked as ever.
  const clicked = await call(agent, "reach_act", { action: { type: "element", snapshot: screen.snapshot, n: 3 }, describe: false });
  assert.equal(clicked.status, 200, JSON.stringify(clicked.body));
  assert.deepEqual(mac.log.filter(([op]) => op === "act").at(-1)[1], { type: "element", snapshot: screen.snapshot, n: 3 });
  // A snapshot from long ago (the Mac keeps 16): refused as before, retry.
  for (let i = 0; i < 16; i++) await agent.as("/api/browser/desktop/elements");
  const stale = await call(agent, "reach_act", { action: { type: "element", snapshot: first, n: 1 } });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.kind, "retry");
  // What the list spared the agent is in Reach's savings ledger, in tokens.
  const ledger = path.join(f.reach.config.dataDir, "savings.json");
  for (let i = 0; i < 50 && !fs.existsSync(ledger); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  const saved = JSON.parse(fs.readFileSync(ledger, "utf8"));
  assert.ok(saved.totals.browser["screen-diff"].tokens > 100, JSON.stringify(saved.totals));
  assert.equal(saved.totals.browser["screen-diff"].count, 1);
  assert.deepEqual(Object.keys(saved.events[0]).sort(), ["agent", "at", "count", "kind", "tokens"], "tokens, never text");
});
