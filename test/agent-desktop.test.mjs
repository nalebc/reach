import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AgentDesktopHelper, createAgentDesktop, normalizeAction, reachAddresses } from "../server/agent-desktop.mjs";
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
  for (let i = 0; i < 10; i++) await w.desktop.screenshot(ro, authorize(ro));
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

test("numbered elements need control, come back clean, and a label click goes to the helper as one action", async () => {
  const w = world();
  const ro = w.make("ro", "readonly");
  await rejects(() => w.desktop.elements(ro, authorize(ro)), 403);
  const full = w.make("muse", "full");
  const found = await w.desktop.elements(full, authorize(full));
  assert.equal(found.snapshot, "ab12cd34");
  assert.deepEqual(found.items.map((item) => item.n), [1, 2], "malformed entries are dropped");
  assert.equal(found.items[1].name.length, 60);
  assert.deepEqual([found.items[1].x, found.items[1].y], [1, 0], "positions stay on the screen");
  await w.desktop.act(full, { type: "element", snapshot: "ab12cd34", n: 1 }, authorize(full));
  assert.deepEqual(w.helpers.at(-1).requests.find((request) => request.op === "act").action, { type: "element", snapshot: "ab12cd34", n: 1 });
  for (const bad of [{ type: "element", snapshot: "../x", n: 1 }, { type: "element", snapshot: "ab", n: 0 }, { type: "element", snapshot: "ab", n: 1, x: 0.5 }])
    await rejects(() => w.desktop.act(full, bad, authorize(full)), 400);
});

test("websites open in the owner's browser; Reach's own pages and non-web addresses never reach the Mac", async () => {
  const w = world();
  const full = w.make("muse", "full");
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
  const full = w.make("muse", "full");
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
    available: () => true, spawnHelper: async () => helper, verifyClient: () => current, phoneControls: () => phone,
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
