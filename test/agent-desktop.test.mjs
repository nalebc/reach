import test from "node:test";
import assert from "node:assert/strict";
import { createAgentDesktop, normalizeAction, reachAddresses } from "../server/agent-desktop.mjs";
import { presetScopes } from "../server/agent-presets.mjs";

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
      async send(request) {
        this.requests.push(request);
        if (request.op === "front") return front;
        if (request.op === "shot") return { ok: true, jpeg, width: 100, height: 60, hidden: 2 };
        if (request.op === "act") return actAnswer(request.action);
        if (request.op === "open") return { ok: true, app: "Google Chrome", bundle: "com.google.Chrome" };
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
    onActivity: (id, entry) => activity.push({ id, ...entry }), spawnHelper, now: () => clock, leaseMs,
  });
  return { desktop, make, helpers, activity, clients,
    setFront: (value) => { front = { ...front, ...value }; }, setAct: (fn) => { actAnswer = fn; },
    phone: (value) => { phone = value; }, pause: (value) => { pausedNow = value; }, tick: (ms) => { clock += ms; } };
}
const authorize = (client) => () => client;
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

test("a helper per session, started with the preset's rules; a changed policy restarts it", async () => {
  const w = world();
  const full = w.make("muse", "full", { hidden: [{ id: "/System/Applications/Messages.app", name: "Messages" }] });
  const shot = await w.desktop.screenshot(full, authorize(full));
  assert.equal(shot.jpeg[0], 0xff); assert.equal(shot.hidden, 2); assert.equal(shot.width, 100);
  assert.equal(w.helpers.length, 1);
  assert.equal(w.helpers[0].rules.mode, "full");
  assert.deepEqual(w.helpers[0].rules.hiddenApps, [{ id: "/System/Applications/Messages.app", bundleId: "", name: "Messages" }]);
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
  for (let i = 0; i < 4; i++) await w.desktop.screenshot(ro, authorize(ro));
  await rejects(() => w.desktop.screenshot(ro, authorize(ro)), 429);
  w.tick(1100);
  await w.desktop.screenshot(ro, authorize(ro));
  await rejects(() => w.desktop.act(ro, { type: "click", x: 0.5, y: 0.5 }, authorize(ro)), 403);
  await rejects(() => w.desktop.open(ro, chrome.id, authorize(ro)), 403);
});

test("typing asks what is in front first: terminals take the deny list, password fields take nothing", async () => {
  const w = world();
  const full = w.make("muse", "full");
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
    helper.send = async request => {
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
    helper.send = async request => {
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
  for (const [kind, status] of [["paused", 409], ["retry", 409], ["invalid", 400], ["unavailable", 503], ["blocked", 403], [undefined, 403]]) {
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
