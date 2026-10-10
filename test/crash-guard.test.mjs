import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CRASH_EXIT, installCrashGuard, markRunning, markStopped, previousRun, restartReason } from "../server/crash-guard.mjs";
import { createReach } from "../server/index.mjs";

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

test("after an unexpected end, agents that can use the Mac start paused", async () => {
  const root = dir();
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const agent = (id, extra) => ({ id, kind: "agent", name: id, scopes: ["screen"], createdAt: Date.now(), expiresAt: Date.now() + 864e5, hash: "x".repeat(64), ...extra });
  fs.writeFileSync(path.join(dataDir, "clients.json"), JSON.stringify([
    agent("muse", { policy: { invite: true, browser: true, preset: "full", roots: [] } }),
    agent("files-only", { policy: { invite: true, roots: [] } }),
  ]), { mode: 0o600 });
  const start = async (previous) => {
    const paused = [];
    const reach = await createReach({ roots: [root], dataDir, port: 0, publicOrigin: "", previousRun: previous,
      agentDesktop: { available: () => true, cancelClient() {}, pauseAll: (ids) => { paused.push(...ids); return ids; }, forgetPauses: () => [], pausesUnreadable: () => false } });
    await reach.close();
    return paused;
  };
  assert.deepEqual(await start({ unclean: true, at: 1, reason: "boom" }), ["muse"]);
  assert.deepEqual(await start(null), []);
});
