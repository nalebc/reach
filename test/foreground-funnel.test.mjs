import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ForegroundFunnel } from "../scripts/foreground-funnel.mjs";
import { CONFLICT } from "../scripts/ephemeral-funnel.mjs";
import { exactForegroundFunnel } from "../scripts/public-link.mjs";
import { keyRedactor } from "../server/tailscale-auth.mjs";

// Windows' public route with browser sign-in (REACH_WINDOWS_ACCOUNT=1;
// docs/parity/D-public-door.md §4.9): a foreground `tailscale funnel` held as
// Reach's own child, never --bg, never a janitor or a record file. Its three
// ways of saying Funnel isn't allowed yet (Tailscale 1.104's cli/funnel.go).
const KEY = "Zyxwvutsrqponmlkjihgfedcba9876543210-_ZYXWV";
const target = `http://127.0.0.1:4317/r-${KEY}`;
const origin = "https://pc.example.ts.net";
const host = "pc.example.ts.net:443";
const redact = keyRedactor(KEY);
const ENABLE = "https://login.tailscale.com/f/funnel?node=nPC";
const leaks = (text) => {
  for (let i = 0; i + 12 <= KEY.length; i++) if (text.includes(KEY.slice(i, i + 12))) return true;
  return false;
};
const ours = (to = target) => ({ TCP: { 443: { HTTPS: true } }, Web: { [host]: { Handlers: { "/": { Proxy: to } } } }, AllowFunnel: { [host]: true } });
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, what, ms = 3000) => {
  for (const end = Date.now() + ms; !check(); ) {
    if (Date.now() > end) throw Error(`timed out: ${what}`);
    await tick(5);
  }
};

// A stand-in tailscaled: each `funnel` child is a session once `show()`n.
function scene({ background = {}, open = true } = {}) {
  const children = [];
  const reports = [];
  const logged = [];
  const changes = [];
  let clock = 1_000_000;
  const shown = new Set();
  const config = () => {
    const live = children.filter((c) => shown.has(c) && !c.ended);
    return live.length ? { ...background, Foreground: Object.fromEntries(live.map((c, i) => [`s${i}`, ours()])) } : background;
  };
  const spawnServe = (args) => {
    const child = Object.assign(new EventEmitter(), { args, stdout: new EventEmitter(), stderr: new EventEmitter(), killed: [], ended: false });
    child.kill = (signal = "SIGTERM") => {
      child.killed.push(signal);
      if (child.ended) return;
      child.ended = true;
      setImmediate(() => child.emit("exit", null, signal));
    };
    child.exit = (code) => {
      child.ended = true;
      child.emit("exit", code, null);
    };
    child.show = () => shown.add(child);
    children.push(child);
    return child;
  };
  const funnel = new ForegroundFunnel({
    origin,
    target,
    window: () => (open ? { open: true, until: clock + 60000 } : { open: false, until: 0 }),
    redact,
    inspect: async () => config(),
    spawnServe,
    report: (message) => reports.push(message),
    log: { write: (text) => logged.push(String(text)) },
    changed: (value) => changes.push(value),
    now: () => clock,
    every: () => ({}),
    clearEvery: () => {},
    delay: tick,
    ensureMs: 300,
    pollMs: 5,
    awaitPollMs: 5,
    waitMs: 100,
  });
  return {
    funnel, children, reports, logged, changes,
    advance: (ms) => (clock += ms),
    setOpen: (value) => (open = value),
  };
}

test("held in the foreground: funnel --https=443 <target>, no --bg; live only on exactly its session", async (t) => {
  const s = scene();
  t.after(() => s.funnel.stop());
  const started = s.funnel.start();
  await until(() => s.children.length === 1, "spawned");
  assert.deepEqual(s.children[0].args, ["funnel", "--https=443", target]);
  assert.equal(s.funnel.live, false);
  s.children[0].show();
  assert.equal(await started, true);
  assert.equal(s.funnel.live, true);
  assert.deepEqual(s.changes, [true]);
  assert.deepEqual(s.reports, ["Public link on: the internet gets nothing until an invitation or agent session is live."]);
  assert.equal(await s.funnel.ensure(), true);
  assert.ok(!s.children.some((c) => c.args.includes("--bg")));
});

test("anything else on port 443: never replaced, nothing started, ensure says why", async (t) => {
  const s = scene({ background: { TCP: { 443: { HTTPS: true } }, Web: { [host]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } } });
  t.after(() => s.funnel.stop());
  assert.equal(await s.funnel.start(), false);
  assert.equal(s.children.length, 0);
  assert.deepEqual(s.reports, [CONFLICT]);
  await assert.rejects(s.funnel.ensure(), { message: CONFLICT });
  assert.equal(s.children.length, 0);
});

test("its session ends: off at once, started again with a growing pause", async (t) => {
  const s = scene();
  t.after(() => s.funnel.stop());
  const started = s.funnel.start();
  await until(() => s.children.length === 1, "spawned");
  s.children[0].show();
  await started;
  s.children[0].exit(1);
  await tick(5);
  assert.equal(s.funnel.live, false);
  assert.deepEqual(s.changes, [true, false]);
  // Within the pause: nothing new.
  assert.equal(await s.funnel.sync(), false);
  assert.equal(s.children.length, 1);
  s.advance(1600);
  const again = s.funnel.sync();
  await until(() => s.children.length === 2, "started again");
  s.children[1].show();
  assert.equal(await again, true);
  assert.equal(s.funnel.live, true);
});

test("Funnel not allowed yet, said and exited: reported once with the page, tried again only after the pause", async (t) => {
  const s = scene();
  t.after(() => s.funnel.stop());
  const said = `Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         ${ENABLE}\n`;
  const exitAfterSaying = (child) =>
    setImmediate(() => {
      child.stdout.emit("data", said);
      child.exit(0);
    });
  s.funnel.start();
  await until(() => s.children.length === 1, "spawned");
  exitAfterSaying(s.children[0]);
  await until(() => s.reports.length >= 1, "reported");
  await tick(20);
  assert.equal(s.reports.filter((r) => r.includes(ENABLE)).length, 1, JSON.stringify(s.reports));
  // Tried again only after the pause; the page isn't reported again.
  for (let i = 0; i < 5; i++) await s.funnel.sync();
  assert.equal(s.children.length, 1, "no faster than the pause");
  s.advance(1600);
  const retry = s.funnel.sync();
  await until(() => s.children.length === 2, "tried again");
  exitAfterSaying(s.children[1]);
  await retry;
  await tick(20);
  assert.equal(s.reports.filter((r) => r.includes(ENABLE)).length, 1);
  assert.ok(!s.reports.some(leaks) && !s.logged.some(leaks));
});

test("Funnel not allowed yet, waiting until it is: the same child is kept, and comes up once allowed", async (t) => {
  const s = scene();
  t.after(() => s.funnel.stop());
  const started = s.funnel.start();
  await until(() => s.children.length === 1, "spawned");
  const [child] = s.children;
  child.stdout.emit("data", `Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         ${ENABLE}\n`);
  assert.equal(await started, false);
  assert.deepEqual(s.reports, [`Allow Tailscale Funnel for this computer: ${ENABLE}`]);
  // Past waitMs and every pause: never killed, never a second one.
  await tick(150);
  for (let i = 0; i < 3; i++) {
    s.advance(120000);
    assert.equal(await s.funnel.sync(), false);
  }
  assert.equal(s.children.length, 1);
  assert.deepEqual(child.killed, []);
  await assert.rejects(s.funnel.ensure(), { message: `Tailscale Funnel isn't allowed for this computer yet: ${ENABLE}` });
  // Allowed: the same child's session appears.
  child.show();
  await until(() => !s.funnel.holder.starting, "its start finished");
  assert.equal(await s.funnel.sync(), true);
  assert.equal(s.funnel.live, true);
  assert.equal(s.funnel.enableUrl, "");
  assert.equal(s.children.length, 1);
  assert.ok(!s.reports.some(leaks) && !s.logged.some(leaks));
});

test("Funnel refused by the tailnet's policy (stderr, exit 1): reported, then the pause", async (t) => {
  const s = scene();
  t.after(() => s.funnel.stop());
  s.funnel.start();
  await until(() => s.children.length === 1, "spawned");
  s.children[0].stderr.emit("data", `Funnel not available; "funnel" node attribute not set. See https://tailscale.com/s/no-funnel. ${target}\n`);
  s.children[0].exit(1);
  await until(() => s.reports.length === 1, "reported");
  assert.match(s.reports[0], /Funnel not available/);
  assert.ok(!leaks(s.reports[0]));
  for (let i = 0; i < 3; i++) await s.funnel.sync();
  assert.equal(s.children.length, 1);
});

test("ensure with no invitation or session open: refused, nothing started", async (t) => {
  const s = scene({ open: false });
  t.after(() => s.funnel.stop());
  await assert.rejects(s.funnel.ensure(), { message: "This agent invitation or session has ended." });
});

test("stop ends its child; nothing is written anywhere", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-ffunnel-"));
  const cwd = process.cwd();
  try {
    process.chdir(dir);
    const s = scene();
    const started = s.funnel.start();
    await until(() => s.children.length === 1, "spawned");
    s.children[0].show();
    await started;
    await s.funnel.stop();
    assert.deepEqual(s.children[0].killed, ["SIGTERM"]);
    assert.equal(s.funnel.live, false);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("exactForegroundFunnel: one foreground session, exactly the route, nothing else on 443", () => {
  const session = { Foreground: { a: ours() } };
  assert.equal(exactForegroundFunnel(session, origin, target), true);
  assert.equal(exactForegroundFunnel(ours(), origin, target), false, "a background route isn't the session");
  assert.equal(exactForegroundFunnel({ Foreground: { a: ours(), b: ours() } }, origin, target), false, "two on 443");
  assert.equal(exactForegroundFunnel({ ...ours("http://127.0.0.1:1"), Foreground: { a: ours() } }, origin, target), false, "a background one beside it");
  const extraHandler = ours();
  extraHandler.Web[host].Handlers["/x"] = { Proxy: target };
  assert.equal(exactForegroundFunnel({ Foreground: { a: extraHandler } }, origin, target), false);
  const extraField = ours();
  extraField.Web[host].Handlers["/"].Text = "hi";
  assert.equal(exactForegroundFunnel({ Foreground: { a: extraField } }, origin, target), false);
  const extraTcp = ours();
  extraTcp.TCP[443].TerminateTLS = "x";
  assert.equal(exactForegroundFunnel({ Foreground: { a: extraTcp } }, origin, target), false);
  assert.equal(exactForegroundFunnel({ Foreground: { a: { ...ours(), AllowFunnel: { [host]: false } } } }, origin, target), false);
  assert.equal(exactForegroundFunnel({ Foreground: { a: ours("http://127.0.0.1:9") } }, origin, target), false);
  // Reach's private route beside it is fine.
  const privateRoute = { TCP: { 8443: { HTTPS: true } }, Web: { "pc.example.ts.net:8443": { Handlers: { "/": { Proxy: target } } } } };
  assert.equal(exactForegroundFunnel({ Foreground: { a: privateRoute, b: ours() } }, origin, target), true);
  assert.equal(exactForegroundFunnel({}, origin, target), false);
});
