import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createTailscaledPeerCheck } from "../server/tailscaled-peer.mjs";

// The peer check's Node half (docs/parity/D-public-door.md §4.3, §6): one
// helper, one line per batch, every doubt a no. The helper is a stand-in
// here; scripts/native/tailscaled-peer.cs runs for real against a LocalSystem
// service in test/windows-tailscaled-peer.test.mjs.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The check's own timers never hold Reach open (unref'd). These tests wait on
// them, and on Windows nothing else keeps Node's loop alive meanwhile: the
// test runner saw it empty and failed them (Oct 12, the windows-2025 lane).
const keepAlive = setInterval(() => {}, 1000);
after(() => clearInterval(keepAlive));
// A helper process: what it was asked, and lines it says.
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.asked = [];
  let pending = "";
  child.stdin.on("data", (data) => {
    pending += data;
    let at;
    while ((at = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, at);
      pending = pending.slice(at + 1);
      child.asked.push(line);
      child.emit("asked", line);
    }
  });
  child.kill = () => {
    child.killed = true;
    if (child.exitCode !== null) return;
    child.exitCode = 1;
    setImmediate(() => child.emit("exit", 1, null));
  };
  child.say = (line) => child.stdout.write(`${line}\n`);
  return child;
}
// A peer check on Windows with stand-in helpers: `first` is what each new
// helper says first (default ready).
function windowsCheck({ first = "ready 1", ...options } = {}) {
  const children = [];
  const problems = [];
  const check = createTailscaledPeerCheck({
    platform: "win32",
    helper: async () => ({ file: "C:\\state\\native\\reach-tailscaled-peer-0123456789ab.exe", sha256: "f".repeat(64) }),
    spawnHelper: () => {
      const child = fakeChild();
      children.push(child);
      if (first !== null) setImmediate(() => child.say(first));
      return child;
    },
    onProblem: (reason) => problems.push(reason),
    ...options,
  });
  return { check, children, problems };
}
const socket = (port, { ingress = 9000, remote = "127.0.0.1", local = "127.0.0.1" } = {}) => ({
  remoteAddress: remote,
  localAddress: local,
  remotePort: port,
  localPort: ingress,
});
const asked = (child, count = 1) =>
  new Promise((resolve) => {
    const done = () => child.asked.length >= count && (child.off("asked", done), resolve(child.asked.slice(-count)));
    child.on("asked", done);
    done();
  });
const parse = (line) => {
  const [, id, ingress, ports] = /^q (\d+) (\d+) ([\d,]+)$/.exec(line);
  return { id, ingress: Number(ingress), ports: ports.split(",").map(Number) };
};

test("starting: ready, each refusal in words, and every way it can't start", async () => {
  const { check } = windowsCheck();
  assert.deepEqual(await check.ready(), { ok: true });
  await check.close();
  const words = {
    "no-service": "Tailscale isn't installed as a Windows service here.",
    "not-running": "Tailscale's Windows service isn't running.",
    "not-own-process": "Tailscale's Windows service isn't set up the usual way (not-own-process).",
    "not-localsystem": "Tailscale's Windows service isn't set up the usual way (not-localsystem).",
    "not-tailscaled": "Tailscale's Windows service isn't set up the usual way (not-tailscaled).",
    access: /^Windows didn't let Reach read Tailscale's service settings\. This happens when Reach runs outside a signed-in Windows session \(over SSH, or as a scheduled task\); start it from a Terminal window on the PC\.$/,
    arch: "This Windows isn't 64-bit.",
    arch32: "Reach's Tailscale check was built as 32-bit (arch32).",
    scm: "Reach's Tailscale check couldn't start (scm).",
  };
  for (const [code, said] of Object.entries(words)) {
    const { check: refused } = windowsCheck({ first: `error ${code}` });
    const result = await refused.ready();
    assert.equal(result.ok, false);
    if (said instanceof RegExp) assert.match(result.reason, said);
    else assert.equal(result.reason, said);
    // Asked again: the same answer, nothing new started.
    assert.deepEqual(await refused.ready(), result);
    assert.equal(await refused.check(socket(50001), Date.now()), false);
  }
  for (const garbage of ["ready", "ready 2", "OK", "error", "error Not A Code", "x".repeat(5000)]) {
    const { check: odd } = windowsCheck({ first: garbage });
    assert.deepEqual(await odd.ready(), { ok: false, reason: "Reach's Tailscale check couldn't start (unexpected answer)." }, garbage.slice(0, 20));
  }
  // Windows refused to run it (Smart App Control, App Control): its code.
  const blocked = createTailscaledPeerCheck({ platform: "win32", helper: async () => ({}), spawnHelper: () => { throw Object.assign(Error("spawn EACCES"), { code: "EACCES" }); } });
  assert.deepEqual(await blocked.ready(), { ok: false, reason: "Reach's Tailscale check couldn't start (EACCES)." });
  const later = createTailscaledPeerCheck({
    platform: "win32",
    helper: async () => ({}),
    spawnHelper: () => {
      const child = fakeChild();
      setImmediate(() => child.emit("error", Object.assign(Error("spawn UNKNOWN"), { code: "UNKNOWN" })));
      return child;
    },
  });
  assert.deepEqual(await later.ready(), { ok: false, reason: "Reach's Tailscale check couldn't start (UNKNOWN)." });
  const unbuilt = createTailscaledPeerCheck({ platform: "win32", helper: async () => { throw Error("This needs Windows' C# compiler"); } });
  assert.match((await unbuilt.ready()).reason, /^Reach's Tailscale check couldn't start \(This needs Windows' C# compiler\)\.$/);
  // Its file changed since it was built: the real spawnVerified refuses it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-peer-"));
  try {
    const file = path.join(dir, "reach-tailscaled-peer-0123456789ab.exe");
    fs.writeFileSync(file, "MZ swapped");
    const swapped = createTailscaledPeerCheck({ platform: "win32", helper: async () => ({ file, sha256: "0".repeat(64) }) });
    assert.deepEqual(await swapped.ready(), { ok: false, reason: "Reach's Tailscale check couldn't start (it changed on disk)." });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // No answer at all.
  const { check: silent } = windowsCheck({ first: null, readyMs: 50 });
  assert.deepEqual(await silent.ready(), { ok: false, reason: "Reach's Tailscale check didn't answer." });
});

test("off Windows: never ready, always no, nothing started", async () => {
  let started = 0;
  const check = createTailscaledPeerCheck({ platform: "darwin", helper: async () => ({}), spawnHelper: () => started++ });
  assert.deepEqual(await check.ready(), { ok: false, reason: "Windows only." });
  assert.equal(await check.check(socket(50001), Date.now()), false);
  assert.equal(started, 0);
  await check.close();
});

test("connections checked in the same moment go in one line per Reach port, 64 at most", async (t) => {
  const { check, children } = windowsCheck();
  t.after(() => check.close());
  await check.ready();
  const [helper] = children;
  const now = Date.now();
  const two = [check.check(socket(50001), now), check.check(socket(50002), now)];
  const [line] = await asked(helper);
  const q = parse(line);
  assert.equal(q.ingress, 9000);
  assert.deepEqual(q.ports, [50001, 50002]);
  helper.say(`a ${q.id} 50001:t:${now - 5} 50002:t:${now}`);
  assert.deepEqual(await Promise.all(two), [true, true]);
  // Seventy at once: two lines; another Reach port gets its own.
  const many = Array.from({ length: 70 }, (_, i) => check.check(socket(51000 + i), now));
  const other = check.check(socket(52000, { ingress: 9001 }), now);
  const lines = (await asked(helper, 4)).slice(1).map(parse);
  assert.deepEqual(lines.map((l) => [l.ingress, l.ports.length]), [[9000, 64], [9000, 6], [9001, 1]]);
  assert.ok(lines.every((l) => /^\d{1,9}$/.test(l.id)) && new Set(lines.map((l) => l.id)).size === 3);
  for (const l of lines) helper.say(`a ${l.id} ${l.ports.map((p) => `${p}:t:${now}`).join(" ")}`);
  assert.deepEqual(new Set(await Promise.all([...many, other])), new Set([true]));
});

test("only Tailscale's own connection, made no later than Reach accepted it, counts", async (t) => {
  const { check, children } = windowsCheck();
  t.after(() => check.close());
  await check.ready();
  const [helper] = children;
  const acceptedAt = Date.now();
  const answers = {
    50001: `t:${acceptedAt - 1000}`,
    50002: `t:${acceptedAt + 20}`, // within the clock's slack
    50003: `t:${acceptedAt + 21}`, // made after Reach accepted: another connection
    50004: "t:0",
    50005: "o",
    50006: "g",
    50007: "n",
    50008: "e",
    // 50009: asked, not answered
  };
  const results = Array.from({ length: 9 }, (_, i) => check.check(socket(50001 + i), acceptedAt));
  const q = parse((await asked(helper))[0]);
  helper.say(`a 999999 50001:t:${acceptedAt}`); // an id never asked: ignored
  helper.say(`a ${q.id} ${Object.entries(answers).map(([p, v]) => `${p}:${v}`).join(" ")} 60000:t:${acceptedAt}`);
  assert.deepEqual(await Promise.all(results), [true, true, false, false, false, false, false, false, false]);
  // Without when it was accepted, or from or to anything but 127.0.0.1:
  // no, and the helper isn't even asked.
  for (const [s, at] of [
    [socket(50010), undefined],
    [socket(50011), 0],
    [socket(50012), NaN],
    [socket(50013, { remote: "::ffff:127.0.0.1" }), acceptedAt],
    [socket(50014, { remote: "100.64.0.10" }), acceptedAt],
    [socket(50015, { local: "0.0.0.0" }), acceptedAt],
    [socket(0), acceptedAt],
    [{}, acceptedAt],
    [null, acceptedAt],
  ])
    assert.equal(await check.check(s, at), false);
  await sleep(20);
  assert.equal(helper.asked.length, 1);
});

test("an answer that comes too late is a no; the helper is replaced after a pause, and says no meanwhile", async (t) => {
  const { check, children, problems } = windowsCheck({ answerMs: 50, restartMs: 150 });
  t.after(() => check.close());
  await check.ready();
  const late = check.check(socket(50001), Date.now());
  await asked(children[0]);
  assert.equal(await late, false);
  assert.equal(children[0].killed, true);
  assert.deepEqual(problems, ["timeout"]);
  // During the pause: no, and nothing asked.
  assert.equal(await check.check(socket(50002), Date.now()), false);
  assert.equal(children.length, 1);
  await sleep(250);
  assert.equal(children.length, 2, "a new helper, started (and hashed) again");
  const again = check.check(socket(50003), Date.now() + 1000);
  const q = parse((await asked(children[1]))[0]);
  children[1].say(`a ${q.id} 50003:t:${Date.now()}`);
  assert.equal(await again, true);
});

test("a helper that stops, garbles, or says too much: everything waiting is a no", async (t) => {
  for (const [what, act] of [
    ["stopped", (child) => child.kill()],
    ["garbled", (child) => child.say("a x")],
    ["garbled", (child) => child.say("ready 1")],
    ["garbled", (child) => child.say("a 1 " + "5".repeat(5000))],
    ["garbled", (child) => child.stdout.write("a".repeat(70000))],
  ]) {
    const { check, children, problems } = windowsCheck({ restartMs: 60000 });
    t.after(() => check.close());
    await check.ready();
    const waiting = [check.check(socket(50001), Date.now()), check.check(socket(50002, { ingress: 9001 }), Date.now())];
    await asked(children[0], 2);
    act(children[0]);
    assert.deepEqual(await Promise.all(waiting), [false, false], what);
    assert.equal(children[0].killed, true);
    assert.deepEqual(problems, [what]);
    assert.equal(await check.check(socket(50003), Date.now()), false);
  }
});

test("close ends the helper; nothing is checked after", async () => {
  const { check, children } = windowsCheck();
  await check.ready();
  const waiting = check.check(socket(50001), Date.now());
  await asked(children[0]);
  await check.close();
  assert.equal(await waiting, false);
  assert.equal(children[0].killed, true);
  assert.equal(await check.check(socket(50002), Date.now()), false);
});

test("tailscaled-peer.cs: its service and program are fixed, it reads only, in C# 5", () => {
  const source = fs.readFileSync(new URL("../scripts/native/tailscaled-peer.cs", import.meta.url), "utf8");
  const code = source.replace(/\/\/[^\n]*/g, "");
  assert.match(code, /const string ServiceName = "Tailscale";/);
  assert.match(code, /const string ImageName = "tailscaled\.exe";/);
  assert.match(code, /const int TCP_TABLE_OWNER_MODULE_ALL = 8;/);
  assert.match(code, /GetExtendedTcpTable/);
  assert.match(code, /NtQuerySystemInformation/);
  assert.match(code, /QueryServiceStatusEx/);
  assert.match(code, /"LocalSystem"/);
  for (const word of ["GetEnvironmentVariable", "Environment.GetCommandLineArgs", "File.", "Directory.", "FileStream", "StreamWriter",
    "Process.Start", "System.Diagnostics", "Socket", "WebClient", "Registry", "args["])
    assert.ok(!code.includes(word), word);
  assert.match(code, /static int Main\(\)/, "takes no arguments");
  for (const later of [/[\s=(,]\$"/, /\?\./, /\?\[/, /\bnameof\(/, /=>/]) assert.doesNotMatch(code, later);
});
