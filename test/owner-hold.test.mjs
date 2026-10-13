import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { OwnerHold, OWNER_IDLE_MS, ownerHoldRefusal } from "../server/screen.mjs";
import { createAgentDesktop } from "../server/agent-desktop.mjs";
import { createAgentPauses } from "../server/agent-pauses.mjs";
import { presetScopes } from "../server/agent-presets.mjs";
import { desktopConnection } from "../server/desktop-connection.mjs";
import { createBrowserAppAccess } from "../server/browser-app-access.mjs";
import { presetFixture, privateIngressTest } from "./helpers/preset-fixture.mjs";

// "Was it because an agent was using it also? Then it should stop him and
// stop him the screen share while im using it, once i stop and idle for
// sometime they can get it back" (Oct 12). Input through Reach's screen from
// you (or a full-access person) holds every agent off the screen, looks
// included, until 2 minutes without input through Reach, or "Let them back".
const owner = { id: "phone", kind: "device", name: "Sam's iPhone", scopes: ["admin", "screen"] };
const person = { id: "sam", kind: "guest", name: "Sam", fullControlVersion: 1, scopes: ["admin", "screen"] };
const limited = { id: "lee", kind: "guest", name: "Lee", scopes: ["screen", "screen:control"] };
const agent = { id: "muse", kind: "agent", name: "Muse", scopes: ["browser:screen"] };

test("the hold: started by you or a full-access person, 2 idle minutes, ended at once by Let them back", () => {
  let clock = 1_000_000;
  const hold = new OwnerHold(() => clock);
  assert.equal(OWNER_IDLE_MS, 120000);
  assert.equal(hold.active(), null);
  // Agents and people without full access never hold anyone off.
  assert.equal(hold.note(agent), false);
  assert.equal(hold.note(limited), false);
  assert.equal(hold.active(), null);
  assert.equal(hold.note(owner), true, "the first input starts it");
  assert.deepEqual(hold.active(), { name: "", retryInMs: 120000 });
  clock += 90_000;
  assert.equal(hold.note(owner), false, "more input only extends it");
  clock += 119_999;
  assert.deepEqual(hold.active(), { name: "", retryInMs: 1 });
  clock += 1;
  assert.equal(hold.active(), null, "2 minutes after the last input, agents are back");
  // A full-access person is named; Let them back ends it now.
  hold.note(person);
  assert.equal(hold.active().name, "Sam");
  assert.equal(hold.release(), true);
  assert.equal(hold.active(), null);
  assert.equal(hold.release(), false);
  // What the agent is told: who, that it waits, and when to look again.
  const told = ownerHoldRefusal({ name: "", retryInMs: 4200.2 }, "darwin");
  assert.equal(told.status, 409);
  assert.equal(told.message, "The owner is using the Mac. The agent waits until they're done.");
  assert.deepEqual([told.kind, told.holder, told.retryInMs], ["paused", "The owner", 4201]);
  assert.equal(ownerHoldRefusal({ name: "Sam", retryInMs: 10 }, "win32").message, "Sam is using the Windows PC. The agent waits until they're done.");
  assert.equal(ownerHoldRefusal({ name: "", retryInMs: 10 }).retryInMs, 1000, "never told to hammer");
});

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]).toString("base64");
function desktopWorld() {
  let clock = 5_000_000;
  const hold = new OwnerHold(() => clock);
  const policy = { invite: true, browser: true, preset: "full", roots: ["/Users/me"] };
  const client = { id: "muse", kind: "agent", name: "Muse", expiresAt: Date.now() + 600000, policy, scopes: presetScopes(policy) };
  const helpers = [];
  let gate = null;
  const desktop = createAgentDesktop({ screen: true }, {
    available: () => true, home: "/Users/me", verifyClient: () => client, pauses: createAgentPauses(),
    ownerUsing: () => hold.active(), now: () => clock,
    spawnHelper: async () => {
      const helper = { requests: [], stopped: false,
        async send(request, beforeSend) {
          beforeSend?.();
          this.requests.push(request.op);
          if (request.op === "shot") { await gate; return { ok: true, jpeg, width: 10, height: 6 }; }
          if (request.op === "elements") return { ok: true, snapshot: "s1", app: "Safari", items: [], texts: [] };
          if (request.op === "read") return { ok: true, app: "Safari", text: "page" };
          if (request.op === "windows") return { ok: true, windows: [] };
          return { ok: true, app: "Safari", bundle: "com.apple.Safari", title: "", terminalLike: false, secure: false, blocked: "" };
        },
        stop() { this.stopped = true; } };
      helpers.push(helper);
      return helper;
    },
  });
  return { desktop, hold, client, helpers, auth: () => client, tick: (ms) => { clock += ms; }, gate: (promise) => { gate = promise; } };
}
const refusedPaused = async (work, who = "The owner") => {
  await assert.rejects(work, (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.kind, "paused");
    assert.equal(error.holder, who);
    assert.ok(error.retryInMs >= 1000 && error.retryInMs <= 120000, String(error.retryInMs));
    // The computer's own word: "Mac" here, "Windows PC" or "computer" on CI.
    assert.match(error.message, new RegExp(`^${who} is using the (Mac|Windows PC|computer)\\. The agent waits until they're done\\.$`));
    return true;
  });
};

test("while you use the screen, an agent's looks and actions all wait; 2 idle minutes give them back", async (t) => {
  const w = desktopWorld();
  t.after(() => w.desktop.close());
  assert.equal((await w.desktop.screenshot(w.client, w.auth)).jpeg[0], 0xff, "looks before you start");
  w.hold.note(owner);
  const looks = [
    () => w.desktop.screenshot(w.client, w.auth),
    () => w.desktop.front(w.client, w.auth),
    () => w.desktop.elements(w.client, w.auth),
    () => w.desktop.readPage(w.client, w.auth),
    () => w.desktop.windows(w.client, w.auth),
    () => w.desktop.menus(w.client, undefined, w.auth),
    () => w.desktop.waitForChange(w.client, 1, 100, w.auth),
  ];
  const actions = [
    () => w.desktop.act(w.client, { type: "click", x: 0.5, y: 0.5 }, w.auth),
    () => w.desktop.open(w.client, "/Applications/Safari.app", w.auth),
    () => w.desktop.find(w.client, { text: "Buy" }, w.auth),
  ];
  const before = w.helpers[0].requests.length;
  for (const step of [...looks, ...actions]) await refusedPaused(step);
  assert.equal(w.helpers[0].requests.length, before, "nothing reached the Mac while you used it");
  assert.equal(w.helpers[0].stopped, false, "a wait, not a changed grant: the helper stays");
  w.tick(OWNER_IDLE_MS - 1);
  await refusedPaused(looks[0]);
  w.tick(1);
  assert.equal((await w.desktop.screenshot(w.client, w.auth)).jpeg[0], 0xff, "back 2 minutes after your last input");
  assert.equal((await w.desktop.act(w.client, { type: "click", x: 0.5, y: 0.5 }, w.auth)).ok, true);
  // Let them back: at once.
  w.hold.note(owner);
  await refusedPaused(looks[1]);
  w.hold.release();
  assert.equal((await w.desktop.front(w.client, w.auth)).app, "Safari");
});

test("a full-access person using the screen holds agents the same way, by their name", async (t) => {
  const w = desktopWorld();
  t.after(() => w.desktop.close());
  w.hold.note(person);
  await refusedPaused(() => w.desktop.screenshot(w.client, w.auth), "Sam");
  await refusedPaused(() => w.desktop.act(w.client, { type: "key", key: "a" }, w.auth), "Sam");
  // Someone you gave only limited control doesn't blind your agents.
  w.hold.release();
  w.hold.note(limited);
  assert.equal(w.hold.active(), null);
  assert.equal((await w.desktop.screenshot(w.client, w.auth)).jpeg[0], 0xff);
});

test("a picture taken as you start is dropped, not handed to the agent", async (t) => {
  const w = desktopWorld();
  t.after(() => w.desktop.close());
  let finish;
  w.gate(new Promise((resolve) => { finish = resolve; }));
  const shot = w.desktop.screenshot(w.client, w.auth);
  await new Promise((resolve) => setTimeout(resolve, 10));
  w.hold.note(owner);
  finish();
  await refusedPaused(() => shot);
});

test("app-window agents don't look either while you use the screen", async () => {
  let clock = 1000;
  const hold = new OwnerHold(() => clock);
  let captures = 0;
  const access = createBrowserAppAccess({
    native: { catalog: async () => ({ apps: [] }), windows: async () => ({ windows: [] }), capture: async () => (captures++, { jpeg }) },
    verifyClient: () => undefined, screenAvailable: () => true, ownerUsing: () => hold.active(), platform: "darwin",
  });
  hold.note(owner);
  await assert.rejects(access.windows({ id: "a" }, "app", () => {}), (e) => e.kind === "paused" && e.status === 409 && /The owner is using the Mac/.test(e.message));
  await assert.rejects(access.capture({ id: "a" }, "window", () => {}), (e) => e.kind === "paused");
  assert.equal(captures, 0);
});

test("the screen's input channel says which inputs reached the Mac; looks and let-gos don't count", async () => {
  const ws = Object.assign(new EventEmitter(), {
    readyState: 1, sent: [],
    send(m) { this.sent.push(JSON.parse(m)); },
    close() { this.closed = true; },
  });
  const used = [];
  desktopConnection(ws, {
    config: { screen: true },
    auth: { verify: () => owner },
    control: { check() {}, acquire() {}, revoke() {} },
    create: async () => ({ send: async () => ({ ok: true }), stop() {} }),
    used: (client, display) => used.push([client.id, display]),
  });
  const send = (m) => ws.emit("message", Buffer.from(JSON.stringify(m)), false);
  send({ type: "auth", token: "T", display: "2" });
  for (const end = Date.now() + 1000; !ws.sent.some((m) => m.type === "ready") && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5));
  const actions = [
    { type: "probe", x: 0.5, y: 0.5 },
    { type: "focus", x: 0.5, y: 0.5 },
    { type: "release" },
    { type: "click", x: 0.5, y: 0.5 },
    { type: "scroll", dx: 3, dy: -4 },
    { type: "move", x: 0.2, y: 0.2 },
    { type: "key", key: "a" },
  ];
  actions.forEach((action, i) => send({ type: "input", id: i + 1, action }));
  for (const end = Date.now() + 2000; !ws.sent.some((m) => m.id === actions.length) && Date.now() < end; ) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(used, [["phone", "2"], ["phone", "2"], ["phone", "2"], ["phone", "2"]], "click, scroll, move and key");
  ws.emit("close");
});

// Reach's own routes and live connection, with its real desktop service and a
// stand-in for the native helper.
test("end to end: refusals carry who and when, the pill's flag, and Let them back is yours", privateIngressTest, async (t) => {
  let clock = Date.now();
  const hold = new OwnerHold(() => clock);
  const helper = { async send(request, beforeSend) { beforeSend?.(); return request.op === "shot" ? { ok: true, jpeg, width: 10, height: 6 } : { ok: true, app: "Safari", bundle: "com.apple.Safari", title: "", terminalLike: false, secure: false, blocked: "" }; }, stop() {} };
  let options = null;
  const f = await presetFixture(t, { ownerHold: hold, desktopFactory: (config, given) => createAgentDesktop(config, { ...(options = given), spawnHelper: async () => helper }) });
  const muse = await f.join({ name: "Muse", preset: "full" });
  const shot = () => muse.as("/api/browser/desktop/screen");
  assert.equal((await shot()).status, 200);
  hold.note(owner);
  for (const refused of [await shot(), await muse.as("/api/browser/desktop/describe"),
    await muse.as("/api/browser/desktop/input", { method: "POST", body: { action: { type: "click", x: 0.5, y: 0.5 } } })]) {
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.kind, "paused");
    assert.equal(refused.body.holder, "The owner");
    assert.ok(refused.body.retryInMs > 100000 && refused.body.retryInMs <= 120000, String(refused.body.retryInMs));
    assert.match(refused.body.error, /^The owner is using the (Mac|Windows PC|computer)\. The agent waits until they're done\.$/);
  }
  // The owner's live connection carries the pill's flag; a flag, not a countdown.
  const ws = new WebSocket(`ws+unix:${f.socketPath}:/ws/presence`, { headers: { Host: "localhost", "X-Forwarded-For": f.addresses.nPhone, "Tailscale-User-Login": f.ownerAccount.login } });
  t.after(() => ws.terminate());
  const snapshots = [];
  ws.on("message", (data) => snapshots.push(JSON.parse(data)));
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  ws.send(JSON.stringify({ type: "auth", token: f.owners.nPhone.token, kind: "phone" }));
  const until = async (check) => { for (const end = Date.now() + 5000; !check(); ) { if (Date.now() > end) throw Error("no such snapshot"); await new Promise((r) => setTimeout(r, 10)); } };
  await until(() => snapshots.at(-1)?.changes?.agentsWait === true);
  // Agents can't let themselves back; you can, at once.
  assert.equal((await muse.as("/api/screen/agents-back", { method: "POST", body: {} })).status, 403);
  assert.ok(hold.active());
  const back = await f.call("/api/screen/agents-back", { method: "POST", body: {} });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(hold.active(), null);
  assert.equal((await shot()).status, 200);
  await until(() => snapshots.at(-1)?.changes && !("agentsWait" in snapshots.at(-1).changes));
  // The idle return, on Reach's clock.
  hold.note(owner);
  assert.equal((await shot()).status, 409);
  clock += OWNER_IDLE_MS;
  assert.equal((await shot()).status, 200);
  assert.equal(typeof options.ownerUsing, "function");
});

// "Chats always in sync": the hold is the agents' alone. Chats' Claude app
// messages wait only while a phone holds control, never for the 2 minutes.
test("chats' desktop work never waits on the hold, only on control itself", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createReach } = await import("../server/index.mjs");
  const { ALL_SCOPES } = await import("../server/core.mjs");
  const { createDesktopAutomation } = await import("../server/desktop-automation.mjs");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-owner-hold-"));
  const hold = new OwnerHold();
  let blocked = null, desktopOptions = null;
  const reach = await createReach({
    roots: [root], dataDir: path.join(root, "private"), screen: true, ownerHold: hold,
    agentSessionsFactory: () => ({ list: async () => ({ sessions: [], errors: {}, projects: { codex: [] }, macPrompts: [] }), listRevision: () => 0, onListChange: () => () => {} }),
    agentDesktopFactory: (_config, options) => {
      desktopOptions = options;
      return { automationBusy: () => false, yieldForOwner: () => null, close() {}, cancelClient() {} };
    },
    desktopAutomationFactory: (options) => ((blocked = options.blocked), createDesktopAutomation(options)),
  });
  try {
    await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${reach.server.address().port}`;
    const as = (token) => (route, body) => fetch(url + route, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const you = as(reach.auth.issue("Your phone", ALL_SCOPES).token);
    hold.note(owner);
    assert.ok(desktopOptions.ownerUsing(), "Reach's desktop service reads the hold");
    assert.equal(blocked(), false, "no control lease: chats go on while agents wait");
    assert.equal((await you("/api/screen/control", { enabled: true })).status, 200);
    assert.match(String(blocked()), /controlling the Mac/, "control itself still comes first");
    assert.equal((await you("/api/screen/control", { enabled: false })).status, 200);
    assert.equal(blocked(), false);
    assert.ok(hold.active());
    assert.equal((await you("/api/screen/agents-back", {})).status, 200);
    assert.equal(hold.active(), null);
  } finally {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
