import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { SETTLE, settleScreen } from "../server/desktop-observation.mjs";
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
function standIn({ pages = [] } = {}) {
  const log = [];
  let page = 0, revision = 10, snapshotCount = 0, holder = null;
  const snapshots = [];
  const screens = [
    screenOf("Uber Eats", [{ n: 1, role: "TextField", name: "Search", value: "", x: 0.3, y: 0.1, w: 0.2, h: 0.02 }, { n: 2, role: "Button", name: "Search", x: 0.5, y: 0.1, w: 0.05, h: 0.02 }],
      [{ text: "Deals near you", heading: true, x: 0.1, y: 0.3, w: 0.2, h: 0.02 }]),
    ...pages,
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
