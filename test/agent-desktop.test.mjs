import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AgentDesktopHelper, createAgentDesktop, describeScreen, normalizeAction, reachAddresses } from "../server/agent-desktop.mjs";
import { presetScopes } from "../server/agent-presets.mjs";
import { createAgentPauses } from "../server/agent-pauses.mjs";

// The server side of an agent's screen and input, against a stand-in for the
// native helper. Nothing here touches this computer.
const chrome = { id: "/Applications/Google Chrome.app", name: "Google Chrome", bundleId: "com.google.Chrome" };
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
function world({ leaseMs = 2500, onSpawn } = {}) {
  const clients = new Map();
  const make = (id, preset, extra = {}) => {
    const policy = { invite: true, browser: true, preset, roots: preset === "apps" ? [] : ["/Users/me"], ...(preset === "apps" ? { apps: [chrome] } : {}), ...extra };
    const client = { id, kind: "agent", name: id, expiresAt: Date.now() + 600000, policy, scopes: presetScopes(policy) };
    clients.set(id, client);
    return client;
  };
  const helpers = [];
  let front = { ok: true, app: "Google Chrome", bundle: "com.google.Chrome", title: "Amazon", terminalLike: false, secure: false, blocked: "" };
  let actAnswer = (action) => ({ ok: true, app: "Google Chrome", bundle: "com.google.Chrome" });
  let clock = 1_000_000;
  const spawnHelper = async (rules) => {
    const helper = { rules, requests: [], stopped: false,
      async send(request, beforeSend) {
        beforeSend?.();
        this.requests.push(request);
        if (request.op === "front") return front;
        if (request.op === "elements") return { ok: true, snapshot: "ab12cd34", app: "Google Chrome", truncated: false,
          items: [{ n: 1, role: "Button", name: "Add to cart", secure: false, x: 0.5, y: 0.25, w: 0.1, h: 0.04 }, { n: 2, role: "Link", name: "x".repeat(90), x: 2, y: -1, w: 0.1, h: 0.1 }, { role: "junk" }] };
        if (request.op === "shot") return { ok: true, jpeg, width: 100, height: 60, hidden: 2 };
        if (request.op === "act") return actAnswer(request.action);
        if (request.op === "open") return { ok: true, app: "Google Chrome", bundle: "com.google.Chrome" };
        if (request.op === "open-url") return { ok: true, app: "Google Chrome", bundle: "com.google.Chrome" };
        if (request.op === "browser-check") return { ok: true, app: "Google Chrome", bundle: "com.google.Chrome" };
        if (request.op === "catalog") return { ok: true, apps: [{ ...chrome, running: true }, { id: "/Applications/1Password.app", name: "1Password", bundleId: "com.1password.1password", running: false }] };
        return { error: "unknown", kind: "invalid" };
      },
      stop() { this.stopped = true; } };
    helpers.push(helper);
    await onSpawn?.(helper);
    return helper;
  };
  const activity = [];
  let phone = false, pausedNow = false;
  const desktop = createAgentDesktop({ screen: true }, {
    available: () => true, hosts: () => ["mac.tail1.ts.net"], titles: () => ["reach"], protectedPaths: () => ["/Users/me/.reach"], home: "/Users/me",
    verifyClient: (id) => clients.get(id), phoneControls: () => phone, paused: () => pausedNow,
    onActivity: (id, entry) => activity.push({ id, ...entry }), spawnHelper, now: () => clock, leaseMs, pauses: createAgentPauses(),
  });
  return { desktop, make, helpers, activity, clients,
    setFront: (value) => { front = { ...front, ...value }; }, setAct: (fn) => { actAnswer = fn; },
    phone: (value) => { phone = value; }, pause: (value) => { pausedNow = value; }, tick: (ms) => { clock += ms; } };
}
const authorize = (client) => () => client;
test("Full control ignores hidden apps and content filters while protecting typed credentials in logs", async t => {
  const w = world();
  t.after(() => w.desktop.close());
  const client = w.make("trusted", "full", { hidden: [chrome] }), auth = authorize(client);
  w.setFront({ title: "GitHub - nalebc/reach", path: chrome.id });
  assert.equal((await w.desktop.front(client, auth)).title, "GitHub - nalebc/reach");
  await w.desktop.openUrl(client, "https://mac.tail1.ts.net/", chrome.id, auth);
  await w.desktop.act(client, { type: "type", text: "chrome://password-manager/passwords" }, auth);
  w.setFront({ terminalLike: true, app: "Terminal" });
  await w.desktop.act(client, { type: "type", text: "sudo echo fixture" }, auth);
  w.setFront({ terminalLike: false, secure: true });
  await w.desktop.act(client, { type: "type", text: "fixture-password", paste: true }, auth);
  const last = w.helpers[0].requests.filter(r => r.op === "act").at(-1).action;
  assert.equal(last.secret, true);
  assert.equal(last.paste, undefined);
  assert.doesNotMatch(JSON.stringify(w.activity), /fixture-password/);
  assert.deepEqual(w.helpers[0].rules.hiddenApps, []);
  w.pause(true);
  await rejects(() => w.desktop.act(client, { type: "key", key: "enter" }, auth), 409, /paused/);
});
test("display-specific captures coalesce only for the same display and input keeps its display", async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const w = world({ onSpawn(helper) {
    const send = helper.send.bind(helper);
    helper.send = async (request, beforeSend) => {
      if (request.op === "shot") { entered(); await gate; }
      return send(request, beforeSend);
    };
  } });
  t.after(() => { release(); w.desktop.close(); });
  const client = w.make("displays", "full"), auth = authorize(client);
  const first = w.desktop.screenshot(client, auth, { displayId: 2 });
  await started;
  const second = w.desktop.screenshot(client, auth, { displayId: 3 });
  const shared = w.desktop.screenshot(client, auth, { displayId: 3 });
  release(); await Promise.all([first, second, shared]);
  assert.deepEqual(w.helpers[0].requests.filter(r => r.op === "shot").map(r => r.displayId), [2, 3]);
  await w.desktop.elements(client, auth, { displayId: 3 });
  assert.equal(w.helpers[0].requests.at(-1).displayId, 3);
  await w.desktop.act(client, { type: "click", x: .2, y: .5, displayId: 3 }, auth);
  assert.equal(w.helpers[0].requests.at(-1).action.displayId, 3);
});
const rejects = async (work, status, pattern, kind) => {
  await assert.rejects(work, (error) => { assert.equal(error.status, status, error.message); if (pattern) assert.match(error.message, pattern); if (kind) assert.equal(error.kind, kind); return true; });
};

test("action shapes are exact", () => {
  assert.deepEqual(normalizeAction({ type: "click", x: 0.5, y: 0.25 }), { type: "click", x: 0.5, y: 0.25, button: "left", count: 1, modifiers: [] });
  assert.deepEqual(normalizeAction({ type: "key", key: "Enter", modifiers: ["cmd", "cmd"] }), { type: "key", key: "enter", modifiers: ["cmd"] });
  assert.deepEqual(normalizeAction({ type: "scroll", x: 0.1, y: 0.1, dy: 300 }), { type: "scroll", x: 0.1, y: 0.1, dx: 0, dy: 300 });
  for (const bad of [null, {}, { type: "click", x: 2, y: 0 }, { type: "click", x: 0.5, y: 0.5, extra: 1 }, { type: "type", text: "" }, { type: "type", text: "a‮b" },
    { type: "key", key: "F13" }, { type: "key", key: "a", modifiers: ["fn"] }, { type: "drag", x: 0, y: 0 }, { type: "scroll", x: 0, y: 0, dy: 9000 }, { type: "launch" }])
    assert.throws(() => normalizeAction(bad), (error) => error.status === 400, JSON.stringify(bad));
});

test("long presses and slow drags: holdMs and durationMs, within limits", () => {
  assert.deepEqual(normalizeAction({ type: "click", x: 0.5, y: 0.5, holdMs: 3000 }), { type: "click", x: 0.5, y: 0.5, button: "left", count: 1, modifiers: [], holdMs: 3000 });
  assert.deepEqual(normalizeAction({ type: "element", snapshot: "ab12", n: 4, holdMs: 10000 }), { type: "element", snapshot: "ab12", n: 4, holdMs: 10000 });
  assert.deepEqual(normalizeAction({ type: "press", name: "Press & Hold", holdMs: 8000 }), { type: "press", name: "Press & Hold", holdMs: 8000 });
  assert.deepEqual(normalizeAction({ type: "drag", x: 0.1, y: 0.1, toX: 0.9, toY: 0.1, holdMs: 600, durationMs: 1200 }), { type: "drag", x: 0.1, y: 0.1, toX: 0.9, toY: 0.1, holdMs: 600, durationMs: 1200 });
  assert.deepEqual(normalizeAction({ type: "drag", x: 0.1, y: 0.1, toX: 0.9, toY: 0.1 }), { type: "drag", x: 0.1, y: 0.1, toX: 0.9, toY: 0.1 });
  // Normalized twice (shortcuts, then the desktop): the same.
  const held = normalizeAction({ type: "click", x: 0.5, y: 0.5, holdMs: 500 });
  assert.deepEqual(normalizeAction(held), held);
  for (const bad of [{ type: "click", x: 0.5, y: 0.5, holdMs: 50 }, { type: "click", x: 0.5, y: 0.5, holdMs: 10001 }, { type: "click", x: 0.5, y: 0.5, holdMs: 1.5 },
    { type: "click", x: 0.5, y: 0.5, count: 2, holdMs: 500 }, { type: "press", name: "Go", count: 3, holdMs: 500 }, { type: "move", x: 0.5, y: 0.5, holdMs: 500 },
    { type: "drag", x: 0, y: 0, toX: 1, toY: 1, holdMs: 6000 }, { type: "drag", x: 0, y: 0, toX: 1, toY: 1, durationMs: 10 }, { type: "drag", x: 0, y: 0, toX: 1, toY: 1, durationMs: 9000 }])
    assert.throws(() => normalizeAction(bad), (error) => error.status === 400, JSON.stringify(bad));
});

test("the owner's pause stops a hold in flight: the helper lets go at once", async () => {
  const w = world(), client = w.make("Muse", "apps");
  let started;
  const holding = new Promise((resolve) => { started = resolve; });
  w.setAct(() => { started(); return new Promise(() => {}); });
  const pending = w.desktop.act(client, { type: "click", x: 0.5, y: 0.5, holdMs: 10000 }, authorize(client)).catch(() => {});
  await holding;
  assert.equal(w.helpers[0].stopped, false);
  w.desktop.setPaused(client.id, true);
  assert.equal(w.helpers[0].stopped, true, "pausing stops the helper holding the button");
  void pending;
  w.desktop.close();
});

test("saved actions carry their window expectation to the native dispatch", async () => {
  const w = world(), client = w.make("muse", "apps");
  const expected = { bundle: chrome.bundleId, title: "Amazon", layout: "100,60|0,0,100,60" };
  w.setFront({ path: chrome.id, layout: expected.layout });
  const front = await w.desktop.front(client, authorize(client));
  assert.equal(front.path, chrome.id); assert.equal(front.layout, expected.layout);
  await w.desktop.act(client, { type: "click", x: 0.5, y: 0.5 }, authorize(client), { expected });
  assert.deepEqual(w.helpers[0].requests.find(request => request.op === "act").expected, expected);
  w.desktop.close();
});

test("a browser protocol run holds the input lease across phases and checks the owner before each phase", async () => {
  const w = world(), client = w.make("muse", "apps"), other = w.make("other", "apps");
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const run = w.desktop.withBrowser(client, chrome.id, authorize(client), async guard => {
    await guard(); entered(); await blocked;
    await guard(); return { ok: true };
  });
  await ready; w.tick(10000);
  await rejects(() => w.desktop.act(other, { type: "click", x: 0.1, y: 0.1 }, authorize(other)), 409, /using the Mac/, "busy");
  await rejects(() => w.desktop.act(client, { type: "click", x: 0.1, y: 0.1 }, authorize(client)), 409, /using the Mac/, "busy");
  w.phone(true); release(); await rejects(() => run, 409, /phone/, "paused");
  w.phone(false); w.tick(10000); await w.desktop.act(other, { type: "click", x: 0.1, y: 0.1 }, authorize(other));
  assert.equal(w.helpers[0].requests.filter(r => r.op === "browser-check").length, 2);
  w.desktop.close();
});

test("revoking a browser run stops its native helper before a later phase", async () => {
  const w = world(), client = w.make("muse", "apps"); let effects = 0;
  await rejects(() => w.desktop.withBrowser(client, chrome.id, authorize(client), async guard => {
    effects++;
    w.clients.set(client.id, { ...client, policy: { ...client.policy, hidden: [chrome] } });
    await guard(); effects++;
  }), 403, /changed/);
  assert.equal(effects, 1); assert.equal(w.helpers[0].stopped, true);
  w.desktop.close();
});

test("missing native Automation permission refuses a tool before its work or launch callback", async () => {
  const w = world({onSpawn: helper => {
    const send = helper.send.bind(helper);
    helper.send = async (request, beforeSend) => request.op === "browser-check"
      ? {error: "The owner needs to enable macOS Automation for Reach’s Terminal.", kind: "setup_required"}
      : send(request, beforeSend);
  }});
  const client = w.make("muse", "apps");
  let entered = false;
  await rejects(() => w.desktop.withBrowser(client, chrome.id, authorize(client), async () => {entered = true;}), 503, /owner needs/, "setup_required");
  assert.equal(entered, false);
  assert.equal(w.helpers[0].requests.filter(request => request.op === "open").length, 0);
  w.desktop.close();
});

test("a helper per session, started with the preset's rules; a changed policy restarts it", async () => {
  const w = world();
  const full = w.make("muse", "full", { hidden: [{ id: "/System/Applications/Messages.app", name: "Messages" }] });
  const shot = await w.desktop.screenshot(full, authorize(full));
  assert.equal(shot.jpeg[0], 0xff); assert.equal(shot.hidden, 2); assert.equal(shot.width, 100);
  assert.equal(w.helpers.length, 1);
  assert.equal(w.helpers[0].rules.mode, "full");
  assert.deepEqual(w.helpers[0].rules.hiddenApps, []);
  assert.deepEqual(w.helpers[0].rules.hosts, ["mac.tail1.ts.net"]);
  assert.ok(w.helpers[0].rules.protectedAppIds.includes("com.apple.keychainaccess"));
  await w.desktop.screenshot(full, authorize(full));
  assert.equal(w.helpers.length, 1, "the same session reuses its helper");
  // The owner lowers the preset: scopes and rules follow on the next call.
  const lowered = { ...full, policy: { ...full.policy, preset: "readonly" }, scopes: presetScopes({ preset: "readonly" }) };
  w.clients.set("muse", lowered);
  await w.desktop.screenshot(lowered, authorize(lowered));
  assert.equal(w.helpers.length, 2);
  assert.ok(w.helpers[0].stopped);
  assert.equal(w.helpers[1].rules.mode, "view");
  await rejects(() => w.desktop.act(lowered, { type: "click", x: 0.5, y: 0.5 }, authorize(lowered)), 403, /changed or ended/);
  const apps = w.make("grok", "apps");
  await w.desktop.screenshot(apps, authorize(apps));
  assert.equal(w.helpers[2].rules.mode, "apps");
  assert.deepEqual(w.helpers[2].rules.allowedApps, [{ id: chrome.id, bundleId: chrome.bundleId, identity: "" }]);
});

test("screenshots are rate limited and need the live scope", async () => {
  const w = world();
  const files = w.make("files", "files");
  await rejects(() => w.desktop.screenshot(files, authorize(files)), 403);
  const ro = w.make("ro", "readonly");
  for (let i = 0; i < 10; i++) await w.desktop.screenshot(ro, authorize(ro));
  await rejects(() => w.desktop.screenshot(ro, authorize(ro)), 429);
  w.tick(1100);
  await w.desktop.screenshot(ro, authorize(ro));
  await rejects(() => w.desktop.act(ro, { type: "click", x: 0.5, y: 0.5 }, authorize(ro)), 403);
  await rejects(() => w.desktop.open(ro, chrome.id, authorize(ro)), 403);
});

test("typing asks what is in front first: terminals take the deny list, password fields take nothing", async () => {
  const w = world();
  const full = w.make("muse", "apps");
  const typed = await w.desktop.act(full, { type: "type", text: "hello" }, authorize(full));
  assert.deepEqual(typed, { ok: true, app: "Google Chrome", bundle: "com.google.Chrome" });
  const sent = w.helpers[0].requests.filter((request) => request.op === "act");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action.terminalLikeChecked, false);
  w.setFront({ app: "Terminal", bundle: "com.apple.Terminal", terminalLike: true });
  await rejects(() => w.desktop.act(full, { type: "type", text: "sudo rm -rf /\n" }, authorize(full)), 403, /needs your password/, "blocked");
  await rejects(() => w.desktop.act(full, { type: "type", text: "cat ~/.ssh/id_rsa" }, authorize(full)), 403, /passwords, keys/, "blocked");
  assert.equal(w.helpers[0].requests.filter((request) => request.op === "act").length, 1, "refused text never reaches the Mac");
  await w.desktop.act(full, { type: "type", text: "ls -la\n" }, authorize(full));
  w.setFront({ app: "Safari", bundle: "com.apple.Safari", terminalLike: false, secure: true });
  await rejects(() => w.desktop.act(full, { type: "type", text: "hunter2" }, authorize(full)), 403, /password field/, "blocked");
  w.setFront({ secure: false, blocked: "That's Reach. The agent can't use Reach." });
  await rejects(() => w.desktop.act(full, { type: "type", text: "x" }, authorize(full)), 403, /That's Reach/, "blocked");
  w.setFront({ blocked: "" });
  await rejects(() => w.desktop.act(full, { type: "type", text: "chrome://password-manager/passwords" }, authorize(full)), 403, /saved passwords/, "blocked");
  // Clicks and keys go straight to the checker.
  await w.desktop.act(full, { type: "key", key: "enter" }, authorize(full));
  assert.equal(w.helpers[0].requests.filter((request) => request.op === "front").length, 7, "every typed text asked what was in front first");
});

// Press by name and fill a form: found on the Mac, checked like a click and
// like typing; a form's vault values never go to a terminal.
test("press and fill: named controls and a form's fields, checked like a click and typing", async () => {
  const w = world();
  const full = w.make("muse", "apps");
  await w.desktop.act(full, { type: "press", name: "  Add to cart ", role: "Button" }, authorize(full));
  assert.deepEqual(w.helpers.at(-1).requests.filter((r) => r.op === "act").at(-1).action, { type: "press", name: "Add to cart", role: "Button" });
  for (const bad of [{ type: "press" }, { type: "press", name: "" }, { type: "press", name: "x", role: "not a role" }, { type: "press", name: "x", x: 0.5 },
    { type: "fill", fields: [] }, { type: "fill", fields: [{ label: "Email" }] }, { type: "fill", fields: [{ label: "Email", text: "a", secret: false }] },
    { type: "fill", fields: [{ label: "Email", text: "a", extra: 1 }] }, { type: "fill", fields: [{ label: "Email", text: "x".repeat(1500) }, { label: "Name", text: "y".repeat(600) }] },
    { type: "fill", fields: [{ label: "Email", text: "a" }], submit: false }, { type: "fill", fields: Array.from({ length: 13 }, () => ({ label: "a", text: "b" })) }])
    await rejects(() => w.desktop.act(full, bad, authorize(full)), 400);
  const filled = await w.desktop.act(full, { type: "fill", fields: [{ label: "Email", text: "me@example.com", secret: true }, { label: "Password", text: "hunter2", secret: true }], submit: true }, authorize(full));
  assert.deepEqual(filled, { ok: true, app: "Google Chrome", bundle: "com.google.Chrome" }, "what was typed never comes back");
  const sent = w.helpers.at(-1).requests.filter((r) => r.op === "act").at(-1).action;
  assert.deepEqual([sent.type, sent.submit, sent.terminalLikeChecked, sent.fields.length], ["fill", true, false, 2]);
  w.setFront({ app: "Terminal", bundle: "com.apple.Terminal", terminalLike: true });
  await rejects(() => w.desktop.act(full, { type: "fill", fields: [{ label: "Email", text: "me@example.com", secret: true }] }, authorize(full)), 403, /don't go into a terminal/, "blocked");
  await rejects(() => w.desktop.act(full, { type: "fill", fields: [{ label: "Command", text: "sudo rm -rf /" }] }, authorize(full)), 403, /needs your password/, "blocked");
  w.setFront({ app: "Google Chrome", bundle: "com.google.Chrome", terminalLike: false });
  await rejects(() => w.desktop.act(full, { type: "fill", fields: [{ label: "Address", text: "chrome://password-manager/passwords" }] }, authorize(full)), 403, /saved passwords/, "blocked");
  // A press goes straight to the Mac, which finds the control and judges the
  // click there, as for any click.
  w.setFront({ blocked: "" });
  await w.desktop.act(full, { type: "press", name: "Allow" }, authorize(full));
  assert.deepEqual(w.helpers.at(-1).requests.filter((r) => r.op === "act").at(-1).action, { type: "press", name: "Allow" });
});

test("the screen as text lists a form's fields, for one fill", () => {
  const text = describeScreen({ app: "Safari", title: "Sign in", snapshot: "s1", texts: [], items: [
    { n: 1, role: "TextField", name: "Email", x: 0.1, y: 0.1, w: 0.2, h: 0.02 },
    { n: 2, role: "SecureTextField", name: "Password", secure: true, x: 0.1, y: 0.2, w: 0.2, h: 0.02 },
    { n: 3, role: "Button", name: "Sign in", x: 0.1, y: 0.3, w: 0.1, h: 0.02 }] });
  assert.match(text, /\[2\] SecureTextField "Password" \(password field: click it for the browser's saved password, else your vault\)/);
  assert.match(text, /Fields: "Email", "Password" \(password\)\. Fill them in one call: reach_fill/);
  // Oct 13: the browser's own sign-in and saved passwords come before a vault.
  assert.match(text, /To sign in, the browser's own first: "Sign in with Google", or the saved password it lists when you click the field \(Down, then Return, takes the first; reach_screenshot shows the list\); else a value from your vault with "secret":true\./);
  assert.doesNotMatch(describeScreen({ app: "Calculator", items: [{ n: 1, role: "Button", name: "7", x: 0, y: 0, w: 0.1, h: 0.1 }], texts: [] }), /Fields:/);
});

// Security audit L6: an app the owner hid is never named to the agent.
test("an app the owner hid is in front: the agent hears only that", async () => {
  const w = world();
  const full = w.make("muse", "readonly", { hidden: [{ id: "/Applications/Signal.app", name: "Signal" }] });
  w.setFront({ app: "Signal", bundle: "org.whispersystems.signal-desktop", title: "Chats", path: "/Applications/Signal.app", blocked: "" });
  const front = await w.desktop.front(full, authorize(full));
  assert.deepEqual([front.app, front.bundle, front.title, front.path, front.layout], ["", "", "", "", ""]);
  assert.match(front.blocked, /hid this app/);
  // As the helper itself answers it.
  w.setFront({ app: "Notes", bundle: "com.apple.Notes", title: "", path: "/System/Applications/Notes.app", blocked: "The owner hid this app from the agent." });
  assert.equal((await w.desktop.front(full, authorize(full))).app, "");
  w.setFront({ app: "Google Chrome", bundle: "com.google.Chrome", title: "Amazon", path: "/Applications/Google Chrome.app", blocked: "" });
  assert.equal((await w.desktop.front(full, authorize(full))).app, "Google Chrome");
});

test("numbered elements need control, come back clean, and a label click goes to the helper as one action", async () => {
  const w = world();
  const ro = w.make("ro", "readonly");
  await rejects(() => w.desktop.elements(ro, authorize(ro)), 403);
  const full = w.make("muse", "full");
  const found = await w.desktop.elements(full, authorize(full));
  assert.equal(found.snapshot, "ab12cd34");
  assert.deepEqual(found.items.map((item) => item.n), [1, 2], "malformed entries are dropped");
  assert.equal(found.items[1].name.length, 90);
  assert.deepEqual([found.items[1].x, found.items[1].y], [1, 0], "positions stay on the screen");
  await w.desktop.act(full, { type: "element", snapshot: "ab12cd34", n: 1 }, authorize(full));
  assert.deepEqual(w.helpers.at(-1).requests.find((request) => request.op === "act").action, { type: "element", snapshot: "ab12cd34", n: 1 });
  for (const bad of [{ type: "element", snapshot: "../x", n: 1 }, { type: "element", snapshot: "ab", n: 0 }, { type: "element", snapshot: "ab", n: 1, x: 0.5 }])
    await rejects(() => w.desktop.act(full, bad, authorize(full)), 400);
});

test("region observations reach the native helper with bounded scope and loading metadata", async t => {
  const w = world({ onSpawn(helper) {
    const send = helper.send.bind(helper);
    helper.send = async (request, beforeSend) => {
      const result = await send(request, beforeSend);
      return request.op === "elements" && request.within ? { ...result, within: request.within, loading: true } : result;
    };
  } });
  t.after(() => w.desktop.close());
  const client = w.make("reader", "full");
  const result = await w.desktop.elements(client, authorize(client), { within: "Invoice A", query: "Balance", displayId: 2 });
  assert.deepEqual(w.helpers[0].requests.at(-1), { op: "elements", displayId: 2, within: "Invoice A" });
  assert.deepEqual(result.scope, { within: "Invoice A" });
  assert.equal(result.loading, true);
  const full = await w.desktop.elements(client, authorize(client));
  assert.equal(full.scope, undefined, "older helpers and whole reads retain their existing shape");
  assert.equal(full.loading, undefined);
  const count = w.helpers[0].requests.length;
  for (const within of ["", " ", "x".repeat(201), 42, "hidden\u0000scope"]) await rejects(() => w.desktop.elements(client, authorize(client), { within }), 400);
  assert.equal(w.helpers[0].requests.length, count);
});

test("websites open in the owner's browser; Reach's own pages and non-web addresses never reach the Mac", async () => {
  const w = world();
  const full = w.make("muse", "apps");
  const opened = await w.desktop.openUrl(full, "https://www.ubereats.com/", undefined, authorize(full));
  assert.deepEqual(opened, { ok: true, app: "Google Chrome", bundle: "com.google.Chrome" });
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "chrome://password-manager/passwords", "https://x.test/\nmore", "not a url"])
    await rejects(() => w.desktop.openUrl(full, bad, undefined, authorize(full)), 400);
  await rejects(() => w.desktop.openUrl(full, "https://mac.tail1.ts.net/", undefined, authorize(full)), 403, /Reach|closed/i, "blocked");
  const sent = w.helpers[0].requests.filter((request) => request.op === "open-url");
  assert.deepEqual(sent.map((request) => request.url), ["https://www.ubereats.com/"], "refused addresses never reach the Mac");
  const ro = w.make("ro", "readonly");
  await rejects(() => w.desktop.openUrl(ro, "https://x.test", undefined, authorize(ro)), 403);
});

test("requests arriving during a capture share it instead of queueing more", async () => {
  const w = world();
  const ro = w.make("ro", "readonly");
  const shots = await Promise.all([1, 2, 3].map(() => w.desktop.screenshot(ro, authorize(ro), { maxWidth: 1280 })));
  assert.equal(shots.length, 3);
  assert.ok(shots.every((shot) => shot.jpeg[0] === 0xff));
  assert.equal(w.helpers[0].requests.filter((request) => request.op === "shot").length, 1, "one capture served all three");
  await w.desktop.screenshot(ro, authorize(ro), { maxWidth: 1280 });
  assert.equal(w.helpers[0].requests.filter((request) => request.op === "shot").length, 2, "the next one captures again");
});

test("vault values reach sign-in fields hidden, never a terminal, and plain text never a password field", async () => {
  const w = world();
  const full = w.make("muse", "apps");
  w.setFront({ app: "Google Chrome", bundle: "com.google.Chrome", terminalLike: false, secure: true });
  await rejects(() => w.desktop.act(full, { type: "type", text: "hunter2" }, authorize(full)), 403, /Password box/, "blocked");
  const done = await w.desktop.act(full, { type: "type", text: "hunter2", secret: true }, authorize(full));
  assert.deepEqual(done, { ok: true, app: "Google Chrome", bundle: "com.google.Chrome" }, "the reply never carries the value");
  w.setFront({ secure: false });
  await w.desktop.act(full, { type: "type", text: "me@example.com", secret: true }, authorize(full));
  const sent = w.helpers[0].requests.filter((request) => request.op === "act").map((request) => request.action);
  assert.deepEqual(sent.map((action) => action.secret), [true, true]);
  w.setFront({ app: "Terminal", bundle: "com.apple.Terminal", terminalLike: true });
  await rejects(() => w.desktop.act(full, { type: "type", text: "hunter2", secret: true }, authorize(full)), 403, /terminal/, "blocked");
  await rejects(() => w.desktop.act(full, { type: "type", text: "x", secret: "yes" }, authorize(full)), 400);
  assert.equal(w.helpers[0].requests.filter((request) => request.op === "act").length, 2, "refused values never reach the Mac");
});

test("typing into a browser does not certify a later terminal focus for command execution", async () => {
  const w = world();
  const full = w.make("muse", "full");
  // Native focus changed to Terminal after the server's browser inspection.
  // The native helper refuses text unless its command check actually ran.
  w.setAct(action => action.terminalLikeChecked
    ? { ok: true, app: "Terminal", bundle: "com.apple.Terminal" }
    : { error: "A terminal is in front now. Try again.", kind: "retry" });
  await rejects(() => w.desktop.act(full, { type: "type", text: "sudo whoami\n" }, authorize(full)), 409, /terminal is in front/, "retry");
});

test("a policy change while the helper starts cannot reveal a screenshot under the old rules", async () => {
  const w = world({ onSpawn: () => {
    const original = w.clients.get("watcher");
    w.clients.set("watcher", { ...original, policy: { ...original.policy, hidden: [{ id: chrome.id, bundleId: chrome.bundleId }] } });
  } });
  const watcher = w.make("watcher", "readonly");
  await rejects(() => w.desktop.screenshot(watcher, () => w.clients.get("watcher")), 403, /changed/);
  assert.equal(w.helpers[0].requests.some(request => request.op === "shot"), false);
  assert.equal(w.helpers[0].stopped, true);
});

test("revocation during helper startup prevents opening an app", async () => {
  let allowed = true;
  const w = world({ onSpawn: () => { allowed = false; } });
  const full = w.make("muse", "full");
  const check = () => { if (!allowed) throw Object.assign(Error("Access ended."), { status: 401 }); return full; };
  await rejects(() => w.desktop.open(full, chrome.id, check), 401, /ended/);
  assert.equal(w.helpers[0].requests.some(request => request.op === "open"), false);
});

test("a screenshot completed under an obsolete grant is discarded", async () => {
  const w = world({ onSpawn: helper => {
    const send = helper.send.bind(helper);
    helper.send = async (request, beforeSend) => {
      const result = await send(request);
      if (request.op === "shot") {
        const current = w.clients.get("watcher");
        w.clients.set("watcher", { ...current, policy: { ...current.policy, hidden: [{ id: chrome.id }] } });
      }
      return result;
    };
  } });
  const watcher = w.make("watcher", "readonly");
  await rejects(() => w.desktop.screenshot(watcher, () => w.clients.get("watcher")), 403, /changed/);
  assert.equal(w.helpers[0].stopped, true);
});

test("the owner's phone taking control during focus inspection prevents the queued typing", async () => {
  const w = world({ onSpawn: helper => {
    const send = helper.send.bind(helper);
    helper.send = async (request, beforeSend) => {
      const result = await send(request);
      if (request.op === "front") w.phone(true);
      return result;
    };
  } });
  const full = w.make("muse", "full");
  await rejects(() => w.desktop.act(full, { type: "type", text: "hello" }, authorize(full)), 409, /from your phone/, "paused");
  assert.equal(w.helpers[0].requests.some(request => request.op === "act"), false);
});

test("one agent at a time on the Mac: a short lease, the owner's phone first, helper refusals keep their kind", async () => {
  const w = world({ leaseMs: 2500 });
  const muse = w.make("Muse", "full"), grok = w.make("Grok", "apps");
  await w.desktop.act(muse, { type: "click", x: 0.5, y: 0.5 }, authorize(muse));
  const busy = await w.desktop.act(grok, { type: "click", x: 0.5, y: 0.5 }, authorize(grok)).then(() => null, (error) => error);
  assert.equal(busy.status, 409); assert.equal(busy.kind, "busy"); assert.equal(busy.holder, "Muse"); assert.ok(busy.retryInMs > 0 && busy.retryInMs <= 2500);
  assert.match(busy.message, /Muse is using the Mac/);
  assert.equal((await w.desktop.front(grok, authorize(grok))).holder, "Muse");
  w.tick(2000);
  await w.desktop.act(muse, { type: "click", x: 0.5, y: 0.5 }, authorize(muse));
  w.tick(2000);
  await rejects(() => w.desktop.act(grok, { type: "click", x: 0.5, y: 0.5 }, authorize(grok)), 409, /Muse/, "busy");
  w.tick(600);
  await w.desktop.act(grok, { type: "click", x: 0.5, y: 0.5 }, authorize(grok));
  assert.equal(w.desktop.activity().holder.name, "Grok");
  // Screenshots never wait for the lease; reading is concurrent.
  await w.desktop.screenshot(muse, authorize(muse));
  // Ending the holder frees the Mac at once.
  w.desktop.cancelClient("Grok");
  await w.desktop.act(muse, { type: "click", x: 0.5, y: 0.5 }, authorize(muse));
  assert.equal(w.desktop.setPaused("Muse", true), true);
  await rejects(() => w.desktop.act(muse, { type: "click", x: 0.5, y: 0.5 }, authorize(muse)), 409, /owner paused/, "paused");
  await rejects(() => w.desktop.open(muse, chrome.id, authorize(muse)), 409, /owner paused/, "paused");
  await w.desktop.screenshot(muse, authorize(muse));
  assert.deepEqual(w.desktop.activity().paused, ["Muse"]);
  assert.equal(w.desktop.setPaused("Muse", false), false);
  await w.desktop.act(muse, { type: "click", x: 0.5, y: 0.5 }, authorize(muse));
  w.phone(true);
  await rejects(() => w.desktop.act(muse, { type: "click", x: 0.5, y: 0.5 }, authorize(muse)), 409, /from your phone/, "paused");
  w.phone(false);
  w.pause(true);
  await rejects(() => w.desktop.act(muse, { type: "click", x: 0.5, y: 0.5 }, authorize(muse)), 409, /paused/);
  w.pause(false);
  for (const [kind, status] of [["paused", 409], ["retry", 409], ["invalid", 400], ["unavailable", 503], ["setup_required", 503], ["blocked", 403], [undefined, 403]]) {
    w.setAct(() => ({ error: `helper said ${kind}`, kind }));
    await rejects(() => w.desktop.act(muse, { type: "click", x: 0.5, y: 0.5 }, authorize(muse)), status, /helper said/, kind || "blocked");
  }
  w.setAct(() => ({ ok: true, app: "Notes", bundle: "com.apple.Notes" }));
  await w.desktop.act(muse, { type: "click", x: 0.5, y: 0.5 }, authorize(muse));
  const last = w.activity.at(-1);
  assert.equal(last.id, "Muse"); assert.equal(last.app, "Notes"); assert.equal(last.kind, "click");
  assert.equal(w.desktop.activity().agents.Muse.app, "Notes");
});

test("opening apps, the catalog and Reach's addresses", async () => {
  const w = world();
  const muse = w.make("Muse", "full");
  await rejects(() => w.desktop.open(muse, "Safari", authorize(muse)), 400);
  await rejects(() => w.desktop.open(muse, "/Applications/Safari.app\u0000", authorize(muse)), 400);
  const opened = await w.desktop.open(muse, chrome.id, authorize(muse));
  assert.equal(opened.app, "Google Chrome");
  assert.equal(w.desktop.activity().agents.Muse.kind, "open");
  const catalog = await w.desktop.catalog(() => {});
  assert.deepEqual(catalog.map((app) => app.name), ["Google Chrome", "1Password"]);
  assert.equal((await w.desktop.catalog(() => {})).length, 2, "cached");
  assert.deepEqual(reachAddresses({ port: 8443, publicOrigin: "https://mac.tail1.ts.net" }, { hostname: "Mac.local" }),
    ["localhost:8443", "127.0.0.1:8443", "[::1]:8443", "0.0.0.0:8443", "mac:8443", "mac.tail1.ts.net"]);
  w.desktop.close();
  await rejects(() => w.desktop.screenshot(muse, authorize(muse)), 503);
});

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test("native input retains the agent lease until completion, beyond its idle timeout", async () => {
  for (const op of ["act", "open"]) {
    const entered = deferred(), finish = deferred();
    let spawned = 0;
    const w = world({ onSpawn(helper) {
      if (++spawned !== 1) return;
      const send = helper.send.bind(helper);
      helper.send = async (request, beforeSend) => {
        if (request.op === op) { entered.resolve(); await finish.promise; }
        return send(request, beforeSend);
      };
    } });
    const first = w.make("First", "full"), second = w.make("Second", "full");
    try {
      const action = () => op === "act"
        ? w.desktop.act(first, { type: "click", x: 0.5, y: 0.5 }, authorize(first))
        : w.desktop.open(first, chrome.id, authorize(first));
      const pending = action();
      await entered.promise;
      w.tick(3000);
      assert.equal(w.desktop.activity().holder.clientId, first.id, "the running operation remains visible");
      assert.equal((await w.desktop.front(second, authorize(second))).holder, first.name);
      await rejects(() => w.desktop.act(second, { type: "click", x: 0.5, y: 0.5 }, authorize(second)), 409, /First/, "busy");
      await w.desktop.screenshot(second, authorize(second));
      w.tick(10000);
      await rejects(() => w.desktop.open(second, chrome.id, authorize(second)), 409, /First/, "busy");
      finish.resolve();
      await pending;
      w.tick(2499);
      await rejects(() => w.desktop.open(second, chrome.id, authorize(second)), 409, /First/, "busy");
      w.tick(2);
      await w.desktop.open(second, chrome.id, authorize(second));
    } finally { finish.resolve(); w.desktop.close(); }
  }
});

test("the same agent cannot queue another input, and owner pause prevents its later retry", async () => {
  const entered = deferred(), finish = deferred();
  let inputSends = 0;
  const w = world({ onSpawn(helper) {
    const send = helper.send.bind(helper);
    helper.send = async (request, beforeSend) => {
      if (["act", "open"].includes(request.op)) {
        inputSends++;
        if (inputSends === 1) {
          beforeSend?.(); beforeSend = undefined; // already dispatched; only its reply is held
          entered.resolve(); await finish.promise;
        }
      }
      return send(request, beforeSend);
    };
  } });
  const first = w.make("First", "full");
  try {
    const pending = w.desktop.act(first, { type: "click", x: 0.5, y: 0.5 }, authorize(first));
    await entered.promise;
    w.tick(3000);
    await rejects(() => w.desktop.act(first, { type: "key", key: "enter" }, authorize(first)), 409, /First/, "busy");
    await rejects(() => w.desktop.open(first, chrome.id, authorize(first)), 409, /First/, "busy");
    assert.equal(inputSends, 1, "another input never enters the helper queue, even after the idle lease expires");
    w.desktop.setPaused(first.id, true);
    finish.resolve(); await pending;
    await rejects(() => w.desktop.act(first, { type: "key", key: "enter" }, authorize(first)), 409, /owner paused/, "paused");
    await rejects(() => w.desktop.open(first, chrome.id, authorize(first)), 409, /owner paused/, "paused");
    assert.equal(inputSends, 1, "the completed first input cannot authorize a retry after owner pause");
    w.desktop.setPaused(first.id, false);
    await w.desktop.act(first, { type: "key", key: "enter" }, authorize(first));
    await w.desktop.open(first, chrome.id, authorize(first));
    assert.equal(inputSends, 3, "serialized actions can retry after completion and resume");
  } finally { finish.resolve(); w.desktop.close(); }
});

test("failed native input releases its operation while preserving the normal idle lease", async () => {
  const w = world();
  const first = w.make("First", "full"), second = w.make("Second", "full");
  try {
    w.setAct(() => ({ error: "Protected target", kind: "blocked" }));
    await rejects(() => w.desktop.act(first, { type: "click", x: 0.5, y: 0.5 }, authorize(first)), 403, /Protected target/);
    await rejects(() => w.desktop.open(second, chrome.id, authorize(second)), 409, /First/, "busy");
    w.tick(2501);
    await w.desktop.open(second, chrome.id, authorize(second));
  } finally { w.desktop.close(); }
});

test("revoking a running helper holds input until native termination, then frees it", async () => {
  const entered = deferred(), reply = deferred(), terminated = deferred();
  let spawned = 0;
  const w = world({ onSpawn(helper) {
    if (++spawned !== 1) return;
    const send = helper.send.bind(helper), stop = helper.stop.bind(helper);
    helper.terminated = terminated.promise;
    helper.send = (request, beforeSend) => {
      if (request.op === "act") { entered.resolve(); return reply.promise; }
      return send(request, beforeSend);
    };
    helper.stop = () => { stop(); reply.reject(Object.assign(new Error("Helper stopped"), { status: 503 })); };
  } });
  const first = w.make("First", "full"), second = w.make("Second", "full");
  try {
    const pending = w.desktop.act(first, { type: "click", x: 0.5, y: 0.5 }, authorize(first));
    const stopped = rejects(pending, 503, /Helper stopped/);
    await entered.promise;
    w.desktop.cancelClient(first.id);
    w.tick(30000);
    // A fresh helper for the same credential must not race its dying helper.
    await rejects(() => w.desktop.open(first, chrome.id, authorize(first)), 409, /First/, "busy");
    await rejects(() => w.desktop.open(second, chrome.id, authorize(second)), 409, /First/, "busy");
    await w.desktop.screenshot(second, authorize(second));
    terminated.resolve(); await stopped;
    await w.desktop.open(second, chrome.id, authorize(second));
  } finally { terminated.resolve(); w.desktop.close(); }
});

// Exercise the real serial protocol queue without a native process or OS input.
function inertQueueWorld() {
  const child = new EventEmitter(), writes = [];
  child.pid = 123456789; child.exitCode = null; child.signalCode = null;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.write = line => { writes.push(JSON.parse(line)); return true; };
  child.stdin.end = () => { child.exitCode = 0; child.emit("exit", 0); };
  child.kill = () => { child.signalCode = "SIGTERM"; child.emit("exit", null, "SIGTERM"); return true; };
  const helper = new AgentDesktopHelper(child);
  const policy = { invite: true, browser: true, preset: "full", roots: ["/tmp/synthetic"] };
  const client = { id: "synthetic", kind: "agent", name: "Synthetic Agent", policy, scopes: presetScopes(policy), expiresAt: Date.now() + 60000 };
  let current = client, permitted = true, phone = false;
  const authorize = () => { if (!permitted) throw Object.assign(Error("Access ended."), { status: 401 }); return current; };
  const desktop = createAgentDesktop({ screen: true }, {
    available: () => true, spawnHelper: async () => helper, verifyClient: () => current, phoneControls: () => phone, pauses: createAgentPauses(),
  });
  return { desktop, helper, writes, client, authorize,
    reply: () => child.stdout.emit("data", Buffer.from('{"ok":true,"app":"Synthetic App","title":"Synthetic"}\n')),
    change: name => {
      if (name === "owner pause") desktop.setPaused(client.id, true);
      else if (name === "phone control") phone = true;
      else if (name === "revocation") permitted = false;
      else if (name === "changed policy") current = { ...client, policy: { ...policy, hidden: [{ id: chrome.id, bundleId: chrome.bundleId }] } };
    },
  };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
const outcome = promise => promise.then(value => ({ value }), error => ({ error }));

for (const op of ["act", "open"]) {
  for (const change of ["owner pause", "phone control", "revocation", "changed policy"]) {
    test(`queued native ${op} rechecks ${change} after a read and never writes refused input`, async () => {
      const w = inertQueueWorld();
      try {
        const read = outcome(w.desktop.front(w.client, w.authorize));
        await turn();
        assert.deepEqual(w.writes.map(item => item.op), ["front"]);
        const input = outcome(op === "act"
          ? w.desktop.act(w.client, { type: "key", key: "enter" }, w.authorize)
          : w.desktop.open(w.client, chrome.id, w.authorize));
        await turn();
        const laterRead = outcome(w.desktop.front(w.client, w.authorize));
        await turn();
        assert.deepEqual(w.helper.queue.map(item => item.request.op), [op, "front"]);
        w.change(change);
        w.reply();
        const result = await input;
        assert.equal(result.error?.status, change === "revocation" ? 401 : change === "changed policy" ? 403 : 409);
        assert.equal(w.writes.some(item => ["act", "open"].includes(item.op)), false, "no refused input bytes reach native stdin");
        if (["owner pause", "phone control"].includes(change)) {
          assert.equal(result.error.kind, "paused");
          assert.equal(w.helper.stopped, false, "an input pause does not kill unrelated reads");
          assert.deepEqual(w.writes.map(item => item.op), ["front", "front"]);
          w.reply();
          assert.equal((await read).value.app, "Synthetic App");
          assert.equal((await laterRead).value.app, "Synthetic App");
        } else {
          assert.equal(w.helper.stopped, true, "revoked or obsolete rules stop this helper");
          assert.ok((await read).error);
          assert.ok((await laterRead).error);
        }
      } finally { w.desktop.close(); }
    });
  }
  test(`queued native ${op} proceeds normally after a read without rejecting automatic refresh`, async () => {
    const w = inertQueueWorld();
    try {
      const read = w.desktop.front(w.client, w.authorize);
      await turn();
      const input = op === "act"
        ? w.desktop.act(w.client, { type: "key", key: "enter" }, w.authorize)
        : w.desktop.open(w.client, chrome.id, w.authorize);
      await turn();
      assert.deepEqual(w.writes.map(item => item.op), ["front"]);
      assert.deepEqual(w.helper.queue.map(item => item.request.op), [op]);
      w.reply();
      assert.deepEqual(w.writes.map(item => item.op), ["front", op]);
      w.reply();
      assert.equal((await read).app, "Synthetic App");
      assert.equal((await input).ok, true);
      assert.equal(w.helper.current, null);
      assert.equal(w.helper.queue.length, 0);
      assert.equal(w.helper.stopped, false);
    } finally { w.desktop.close(); }
  });
}


test("helper timeout drains queued work and retains termination until a forced native exit", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // No child process is launched: an inert process ignores graceful shutdown.
  const child = new EventEmitter(), events = [];
  child.pid = 123456789; child.exitCode = null; child.signalCode = null;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.write = line => { events.push(`write:${JSON.parse(line).op}`); return true; };
  child.stdin.end = () => { events.push("stdin-end"); };
  child.kill = signal => {
    events.push(signal);
    if (signal === "SIGKILL") { child.signalCode = signal; child.emit("exit", null, signal); }
    return true;
  };
  const helper = new AgentDesktopHelper(child);
  let terminated = false;
  helper.terminated.then(() => { terminated = true; });
  const active = outcome(helper.send({ op: "act" }));
  const queued = outcome(helper.send({ op: "front" }, () => assert.fail("timed-out queue must never dispatch")));
  t.mock.timers.tick(14999);
  assert.equal(helper.stopped, false);
  assert.deepEqual(events, ["write:act"]);
  t.mock.timers.tick(1);
  assert.equal((await active).error.status, 503);
  assert.equal((await queued).error.status, 503);
  assert.equal(helper.stopped, true);
  assert.equal(helper.current, null);
  assert.equal(helper.queue.length, 0);
  assert.equal(terminated, false, "rejecting send is not proof the native process stopped");
  await assert.rejects(helper.send({ op: "act" }), { status: 503 });
  t.mock.timers.tick(299);
  assert.deepEqual(events, ["write:act", "stdin-end"]);
  t.mock.timers.tick(1);
  assert.deepEqual(events, ["write:act", "stdin-end", "SIGTERM"]);
  assert.equal(terminated, false);
  t.mock.timers.tick(999);
  assert.equal(terminated, false);
  t.mock.timers.tick(1);
  await helper.terminated;
  assert.equal(terminated, true);
  assert.deepEqual(events, ["write:act", "stdin-end", "SIGTERM", "SIGKILL"]);
  helper.stop();
  t.mock.timers.tick(60000);
  assert.equal(events.length, 4, "stopping again cannot send more signals");
});

// Faster ways around the Mac (reach_windows, reach_focus_window, reach_menus,
// reach_find, reach_read_page, reach_open_file, menu and paste actions):
// each shaped exactly, each through the same lease and rules as a click.
test("menu and paste actions are exact shapes", () => {
  assert.deepEqual(normalizeAction({ type: "menu", path: ["File", " Export As… "] }), { type: "menu", path: ["File", "Export As…"] });
  assert.deepEqual(normalizeAction({ type: "type", text: "long text", paste: true }), { type: "type", text: "long text", paste: true });
  assert.deepEqual(normalizeAction({ type: "fill", fields: [{ label: "Notes", text: "a" }], paste: true }), { type: "fill", fields: [{ label: "Notes", text: "a" }], paste: true });
  for (const bad of [{ type: "menu", path: [] }, { type: "menu", path: ["a", "b", "c", "d", "e", "f", "g"] }, { type: "menu", path: ["File"], x: 1 }, { type: "menu", path: [""] },
    { type: "type", text: "secret", secret: true, paste: true }, { type: "type", text: "x", paste: false }, { type: "fill", fields: [{ label: "a", text: "b" }], paste: "yes" }])
    assert.throws(() => normalizeAction(bad), (error) => error.status === 400, JSON.stringify(bad));
});

test("windows, focus, menus, find, read and open-file go through the helper under the preset's rules", async () => {
  const w = world();
  const full = w.make("muse", "apps", { hidden: [{ id: "/Applications/Messages.app", name: "Messages", bundleId: "com.apple.MobileSMS" }] });
  const extra = {
    windows: { ok: true, windows: [
      { id: "42:0", app: "Google Chrome", bundle: "com.google.Chrome", title: "Inbox", minimized: false, front: true, url: "https://mail.google.com/", tabs: [{ title: "Inbox", selected: true }, { title: "Amazon", selected: false }, { junk: 1 }] },
      { id: "43:0", app: "Messages", bundle: "com.apple.MobileSMS", title: "Mom", minimized: false, front: false },
      { id: "bad", app: "X" }, { id: "44:1", app: "Notes", bundle: "com.apple.Notes", title: "x".repeat(300), minimized: true, front: false, dialog: true }] },
    focus: { ok: true, app: "Google Chrome", bundle: "com.google.Chrome", title: "Amazon", tab: "Amazon", front: true },
    menus: { ok: true, app: "Google Chrome", title: "Inbox", truncated: false, menus: [{ title: "File", items: [{ title: "New Tab", key: "⌘T" }, { title: "Share", submenu: true }, { title: "Print…", key: "⌘P", enabled: false }, { junk: true }] }] },
    find: { ok: true, found: true, snapshot: "f1f1f1f1", app: "Google Chrome", title: "Inbox", n: 2, role: "Button", name: "Add to cart", matches: 1, inView: true, scrolled: true, truncated: false,
      items: [{ n: 1, role: "Link", name: "Home", x: 0.1, y: 0.1, w: 0.1, h: 0.02 }, { n: 2, role: "Button", name: "Add to cart", x: 0.5, y: 0.9, w: 0.1, h: 0.02 }], texts: [{ text: "$12", x: 0.5, y: 0.85, w: 0.05, h: 0.02 }] },
    read: { ok: true, app: "Google Chrome", title: "Inbox", url: "https://mail.google.com/", text: "Hello\nWorld", truncated: false },
    "open-file": { ok: true, app: "Preview", bundle: "com.apple.Preview", front: true },
  };
  w.helpers.length = 0;
  const original = w.desktop;
  // The stand-in helper answers the new operations too.
  const state = await (async () => { await original.front(full, authorize(full)); return w.helpers[0]; })();
  const send = state.send.bind(state);
  state.send = async (request, before) => Object.hasOwn(extra, request.op) ? (before?.(), state.requests.push(request), extra[request.op]) : send(request, before);

  const windows = await original.windows(full, authorize(full));
  assert.deepEqual(windows.windows.map((item) => item.id), ["42:0", "44:1"], "hidden apps and malformed ids are left out");
  assert.deepEqual(windows.windows[0].tabs, [{ title: "Inbox", selected: true }, { title: "Amazon", selected: false }]);
  assert.equal(windows.windows[0].url, "https://mail.google.com/");
  assert.equal(windows.windows[1].title.length, 200);
  assert.equal(windows.windows[1].dialog, true);

  const focused = await original.focusWindow(full, { id: "42:0", title: "Inbox", tab: "Amazon" }, authorize(full));
  assert.deepEqual(focused, { ok: true, app: "Google Chrome", bundle: "com.google.Chrome", title: "Amazon", tab: "Amazon" });
  assert.deepEqual(state.requests.at(-1), { op: "focus", id: "42:0", title: "Inbox", tab: "Amazon" });
  await rejects(() => original.focusWindow(full, { id: "nope" }, authorize(full)), 400);
  await rejects(() => original.focusWindow(full, { id: "42:0", tab: "" }, authorize(full)), 400);

  const menus = await original.menus(full, "File", authorize(full));
  assert.deepEqual(menus.menus, [{ title: "File", items: [{ title: "New Tab", key: "⌘T" }, { title: "Share", submenu: true }, { title: "Print…", enabled: false, key: "⌘P" }] }]);
  assert.deepEqual(state.requests.at(-1), { op: "menus", menu: "File" });
  await rejects(() => original.menus(full, "x".repeat(81), authorize(full)), 400);

  const found = await original.find(full, { name: "Add to cart", role: "Button" }, authorize(full));
  assert.equal(found.found, true);
  assert.equal(found.n, 2);
  assert.equal(found.snapshot, "f1f1f1f1");
  assert.equal(found.scrolled, true);
  assert.equal(found.items.length, 2);
  assert.deepEqual(state.requests.at(-1), { op: "find", name: "Add to cart", role: "Button" });
  await rejects(() => original.find(full, { text: "a", name: "b" }, authorize(full)), 400);
  await rejects(() => original.find(full, { text: "a", role: "Button" }, authorize(full)), 400);
  await rejects(() => original.find(full, {}, authorize(full)), 400);

  const page = await original.readPage(full, authorize(full));
  assert.deepEqual(page, { app: "Google Chrome", bundle: "", title: "Inbox", url: "https://mail.google.com/", text: "Hello\nWorld", truncated: false });

  const opened = await original.openFile(full, "/Users/me/Documents/a.pdf", {}, authorize(full));
  assert.deepEqual(opened, { ok: true, app: "Preview", bundle: "com.apple.Preview" });
  assert.deepEqual(state.requests.at(-1), { op: "open-file", path: "/Users/me/Documents/a.pdf" });
  await original.openFile(full, "/Users/me/Documents", { reveal: true }, authorize(full));
  assert.deepEqual(state.requests.at(-1), { op: "open-file", path: "/Users/me/Documents", reveal: true });
  // Reach's own files, keychains and browser profiles never open, whatever the folder.
  await rejects(() => original.openFile(full, "/Users/me/.reach/data.json", {}, authorize(full)), 403, /Reach's own files/, "blocked");
  await rejects(() => original.openFile(full, "/Users/me/Library/Keychains/login.keychain-db", {}, authorize(full)), 403, undefined, "blocked");
  await rejects(() => original.openFile(full, "relative.pdf", {}, authorize(full)), 400);

  // Read only looks: windows yes, the rest no.
  const reader = w.make("reader", "readonly");
  await original.front(reader, authorize(reader));
  const readerHelper = w.helpers.at(-1);
  readerHelper.send = async (request, before) => { before?.(); if (request.op === "windows") return extra.windows; return { ok: true }; };
  assert.equal((await original.windows(reader, authorize(reader))).windows.length, 3);
  await rejects(() => original.menus(reader, undefined, authorize(reader)), 403);
  await rejects(() => original.find(reader, { text: "a" }, authorize(reader)), 403);
  await rejects(() => original.readPage(reader, authorize(reader)), 403);
  await rejects(() => original.focusWindow(reader, { id: "42:0" }, authorize(reader)), 403);
  await rejects(() => original.openFile(reader, "/Users/me/a.pdf", {}, authorize(reader)), 403);
});

test("the front answer carries a browser's page and tabs", async () => {
  const w = world();
  const full = w.make("muse", "full");
  w.setFront({ url: "https://www.amazon.ca/", tabs: [{ title: "Amazon", selected: true }, { junk: 1 }, { title: "x".repeat(200), selected: "yes" }] });
  const front = await w.desktop.front(full, authorize(full));
  assert.equal(front.url, "https://www.amazon.ca/");
  assert.deepEqual(front.tabs, [{ title: "Amazon", selected: true }, { title: "x".repeat(120), selected: false }]);
  assert.deepEqual(w.helpers[0].requests[0], { op: "front", detail: true });
});

test("every action the Mac does or refuses is logged for the owner, in words", async () => {
  const logged = [];
  const w = world();
  const full = w.make("muse", "apps");
  // The log is a dependency; the world builds its desktop without one, so build another here.
  const desktop = createAgentDesktop({ screen: true }, {
    available: () => true, hosts: () => ["mac.tail1.ts.net"], titles: () => ["reach"], protectedPaths: () => ["/Users/me/.reach"], home: "/Users/me",
    verifyClient: (id) => w.clients.get(id), pauses: createAgentPauses(), spawnHelper: async (rules) => ({ rules, stopped: false,
      async send(request, before) { before?.();
        if (request.op === "front") return { ok: true, app: "Google Chrome", bundle: "com.google.Chrome", title: "Amazon", terminalLike: false, secure: false, blocked: "" };
        if (request.op === "act") return request.action.type === "press" ? { ok: true, app: "Google Chrome", pressed: "Add to cart" } : { ok: true, app: "Google Chrome" };
        if (request.op === "open") return { ok: true, app: "Numbers", bundle: "com.apple.Numbers" };
        if (request.op === "open-file") return { ok: true, app: "Preview", bundle: "com.apple.Preview" };
        return { ok: true }; }, stop() { this.stopped = true; } }),
    actions: (client, entry) => logged.push([client.id, entry]), now: () => 1_000_000,
  });
  await desktop.act(full, { type: "type", text: "diapers" }, authorize(full));
  await desktop.act(full, { type: "press", name: "Add to cart" }, authorize(full));
  await desktop.act(full, { type: "type", text: "secret", secret: true }, authorize(full));
  await desktop.open(full, "/Applications/Numbers.app", authorize(full));
  await desktop.openFile(full, "/Users/me/Documents/a.pdf", {}, authorize(full));
  await rejects(() => desktop.openFile(full, "/Users/me/.reach/x.json", {}, authorize(full)), 403, undefined, "blocked");
  assert.deepEqual(logged.map(([id, entry]) => [id, entry.kind, entry.text, entry.app, entry.ok]), [
    ["muse", "type", "Typed “diapers”", "Google Chrome", undefined],
    ["muse", "press", "Pressed “Add to cart”", "Google Chrome", undefined],
    ["muse", "type", "Typed a value from its vault", "Google Chrome", undefined],
    ["muse", "open", "Opened Numbers", "Numbers", undefined],
    ["muse", "open-file", "Opened “a.pdf” in Preview", "Preview", undefined],
    ["muse", "open-file", "Opened “x.json”", undefined, false],
  ]);
  assert.match(logged.at(-1)[1].reason, /Reach's own files/);
  assert.ok(!JSON.stringify(logged).includes("secret"), "the vault value never reaches the log");
});
