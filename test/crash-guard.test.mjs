import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CRASH_EXIT, installCrashGuard, markRunning, markStopped, previousRun, restartReason } from "../server/crash-guard.mjs";
import { createReach } from "../server/index.mjs";
import { keyRedactor } from "../server/tailscale-auth.mjs";

// An error nothing caught ends Reach visibly and on purpose (so ./reach starts
// it again), and the next start knows it ended unexpectedly (reliability
// audit, Oct 10).
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "reach-crash-"));

test("an uncaught error or rejection is written down, kept for the next start, and exits 70", () => {
  for (const [event, origin] of [["uncaughtException", "uncaught exception"], ["unhandledRejection", "unhandled rejection"]]) {
    const dataDir = dir();
    const target = new EventEmitter();
    const exits = [], written = [];
    const stop = installCrashGuard({ dataDir, supervised: true, target, exit: (code) => exits.push(code), write: (text) => written.push(text), now: () => 1000 });
    target.emit(event, new Error("boom\nsecond line"));
    // A second error while stopping doesn't stop twice.
    target.emit(event, new Error("again"));
    assert.deepEqual(exits, [CRASH_EXIT]);
    assert.match(written.join(""), new RegExp(`stopped unexpectedly \\(${origin}\\)[\\s\\S]*boom[\\s\\S]*starts again by itself`));
    assert.match(fs.readFileSync(path.join(dataDir, "crash.log"), "utf8"), /boom/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dataDir, "last-crash.json"), "utf8")), { at: 1000, pid: process.pid, origin, reason: "boom" });
    stop();
    assert.equal(target.listenerCount(event), 0);
  }
});

test("Windows' keyed route: the key is taken out of what a crash says and keeps, before any cut; otherwise nothing changes", () => {
  const key = "Qwertyuiopasdfghjklzxcvbnm0123456789-_QWERT";
  const redact = keyRedactor(key);
  const leaks = (text) => {
    for (let i = 0; i + 12 <= key.length; i++) if (text.includes(key.slice(i, i + 12))) return true;
    return false;
  };
  const target = `http://127.0.0.1:51234/r-${key}`;
  // The key across the 300-character cut of the reason and the 8000 of the stack.
  for (const [lead, stackLead] of [[280, 7980], [295, 7990], [299, 7999], [300, 8000], [270, 7960]]) {
    const dataDir = dir();
    const events = new EventEmitter();
    const written = [];
    installCrashGuard({ dataDir, target: events, exit: () => {}, write: (text) => written.push(text), redact });
    const error = new Error(`${"m".repeat(lead)}${target} failed`);
    error.stack = `Error: ${"s".repeat(stackLead)}${target}\n    at x (${target})`;
    events.emit("uncaughtException", error);
    for (const text of [written.join(""), fs.readFileSync(path.join(dataDir, "crash.log"), "utf8"), fs.readFileSync(path.join(dataDir, "last-crash.json"), "utf8")])
      assert.ok(!leaks(text), `${lead}/${stackLead}`);
  }
  // Without a redactor (a Mac, Windows without the flag): byte for byte as before.
  const plain = dir(), redacted = dir();
  const said = { plain: [], redacted: [] };
  const error = () => Object.assign(new Error("boom: /tmp/r-abcdef012345/s"), { stack: "Error: boom: /tmp/r-abcdef012345/s\n    at y" });
  for (const [dataDir, out, options] of [[plain, said.plain, {}], [redacted, said.redacted, { redact: (text) => text }]]) {
    const events = new EventEmitter();
    installCrashGuard({ dataDir, target: events, exit: () => {}, write: (text) => out.push(text), now: () => 1000, ...options });
    events.emit("uncaughtException", error());
  }
  assert.deepEqual(said.plain, said.redacted);
  assert.match(said.plain.join(""), /boom: \/tmp\/r-abcdef012345\/s/);
  assert.equal(fs.readFileSync(path.join(plain, "last-crash.json"), "utf8"), fs.readFileSync(path.join(redacted, "last-crash.json"), "utf8"));
});

test("a write to a terminal or pipe that went away isn't a crash", () => {
  const target = new EventEmitter();
  const exits = [];
  installCrashGuard({ dataDir: dir(), target, exit: (code) => exits.push(code), write: () => {} });
  target.emit("uncaughtException", Object.assign(new Error("write EIO"), { code: "EIO", syscall: "write" }));
  target.emit("uncaughtException", Object.assign(new Error("write EPIPE"), { code: "EPIPE", syscall: "write" }));
  assert.deepEqual(exits, []);
  target.emit("uncaughtException", Object.assign(new Error("read EIO"), { code: "EIO", syscall: "read" }));
  assert.deepEqual(exits, [CRASH_EXIT]);
});

test("crash.log stays small", () => {
  const dataDir = dir();
  fs.writeFileSync(path.join(dataDir, "crash.log"), "x".repeat(300 * 1024));
  const target = new EventEmitter();
  installCrashGuard({ dataDir, target, exit: () => {}, write: () => {} });
  target.emit("uncaughtException", new Error("boom"));
  assert.ok(fs.statSync(path.join(dataDir, "crash.log")).size <= 70 * 1024);
});

test("how the last Reach ended: stopped, crashed, killed, still running, or the Mac restarted", () => {
  const dataDir = dir();
  const dead = () => false;
  assert.equal(previousRun(dataDir), null, "never ran");
  markRunning(dataDir, { now: () => 5000 });
  markStopped(dataDir);
  assert.equal(previousRun(dataDir, { isAlive: dead, self: 1 }), null, "stopped as asked");
  const ran = (pid, at) => fs.writeFileSync(path.join(dataDir, "run.json"), JSON.stringify({ pid, at }));
  ran(4242, 5000);
  fs.writeFileSync(path.join(dataDir, "last-crash.json"), JSON.stringify({ at: 6000, pid: 4242, origin: "uncaught exception", reason: "boom" }));
  const crashed = previousRun(dataDir, { isAlive: dead, self: 1, bootedAt: 0 });
  assert.deepEqual(crashed, { unclean: true, at: 5000, reason: "boom" });
  assert.match(restartReason(crashed), /stopped unexpectedly \(boom\)/);
  assert.equal(fs.existsSync(path.join(dataDir, "last-crash.json")), false, "a crash is reported once");
  ran(4242, 5000);
  const killed = previousRun(dataDir, { isAlive: dead, self: 1, bootedAt: 0 });
  assert.deepEqual(killed, { unclean: true, at: 5000, reason: "" });
  assert.match(restartReason(killed), /stopped from outside or ran out of memory/);
  ran(4242, 5000);
  assert.equal(previousRun(dataDir, { isAlive: () => true, self: 1, bootedAt: 0 }), null, "still running");
  assert.equal(previousRun(dataDir, { isAlive: dead, self: 1, bootedAt: 9000 }), null, "the Mac restarted since");
  // Another process's crash record never names this run's end.
  ran(4242, 5000);
  fs.writeFileSync(path.join(dataDir, "last-crash.json"), JSON.stringify({ at: 6000, pid: 1111, reason: "other" }));
  assert.equal(previousRun(dataDir, { isAlive: dead, self: 1, bootedAt: 0 }).reason, "");
});

test("after an unexpected end, agents that can use the Mac start paused, with or without the desktop service", async () => {
  const root = dir();
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const agent = (id, extra) => ({ id, kind: "agent", name: id, scopes: ["screen"], createdAt: Date.now(), expiresAt: Date.now() + 864e5, hash: "x".repeat(64), ...extra });
  fs.writeFileSync(path.join(dataDir, "clients.json"), JSON.stringify([
    agent("muse", { policy: { invite: true, browser: true, preset: "full", roots: [] } }),
    agent("files-only", { policy: { invite: true, roots: [] } }),
  ]), { mode: 0o600 });
  // The pauses are Reach's own (agent-pauses.mjs), kept on disk for the next
  // start; the desktop service, where there is one (a Mac), lets go first.
  const pausesFile = path.join(dataDir, "agent-pauses.json");
  const start = async (previous, withDesktop) => {
    fs.rmSync(pausesFile, { force: true });
    const letGo = [];
    const reach = await createReach({ roots: [root], dataDir, port: 0, publicOrigin: "", previousRun: previous,
      agentDesktop: withDesktop ? { available: () => true, cancelClient() {}, letGo: (id) => letGo.push(id) } : null });
    await reach.close();
    const paused = fs.existsSync(pausesFile) ? JSON.parse(fs.readFileSync(pausesFile, "utf8")).paused : [];
    assert.deepEqual(letGo, withDesktop ? paused : []);
    return paused;
  };
  for (const withDesktop of [true, false]) {
    assert.deepEqual(await start({ unclean: true, at: 1, reason: "boom" }, withDesktop), ["muse"]);
    assert.deepEqual(await start(null, withDesktop), []);
  }
});
