import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { keepAwake, keepAwakeWindows } from "../scripts/stay-awake.mjs";
import { windowsBinary } from "../server/desktop-native.mjs";

// Windows keeps the PC awake while Reach runs, in the Mac's three modes
// (audit #3): its own helper (scripts/native/stay-awake.cs) holds
// SetThreadExecutionState for as long as it runs, says what it holds, and
// lets go when Reach ends (its input closes). Here the helper is a stand-in;
// on a real Windows runner the last test builds it and asks powercfg.
const windows = process.platform === "win32";
const helperProcess = (pid = 4321) => {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { ended: false, end() { this.ended = true; } });
  child.killed = 0;
  child.kill = () => child.killed++;
  child.say = (value) => child.stdout.emit("data", `${JSON.stringify(value)}\n`);
  return child;
};
const world = ({ build = async () => "C:\\Reach\\quick\\reach-stay-awake-0123456789ab.exe" } = {}) => {
  const started = [], saved = [], said = [], timers = [];
  const deps = {
    helper: build,
    start: (file, args) => {
      const child = helperProcess(4321 + started.length);
      started.push({ file, args, child });
      return child;
    },
    changed: (awake) => saved.push(awake),
    report: (line) => said.push(line),
    setTimer: (fn, ms) => (timers.push({ fn, ms }), { unref() {} }),
    clearTimer: () => {},
  };
  return { deps, started, saved, said, timers };
};
const settle = () => new Promise((r) => setImmediate(r));

test("always: the helper holds the PC awake from the start; status is the Mac's", async () => {
  const w = world();
  const power = keepAwakeWindows({ mode: "always", ...w.deps });
  await settle();
  assert.deepEqual(w.started.map((s) => [s.file, s.args]), [["C:\\Reach\\quick\\reach-stay-awake-0123456789ab.exe", ["always"]]]);
  assert.deepEqual(power.status(), { mode: "always", active: false, pid: null, error: "" }, "not until it says so");
  w.started[0].child.say({ active: true, ac: false });
  assert.deepEqual(power.status(), { mode: "always", active: true, pid: 4321, error: "" });
  assert.deepEqual(w.saved.at(-1), { mode: "always", active: true, pid: 4321, error: "" }, "written to host-status, for reach status");
  // Said again unchanged: not saved again.
  const saves = w.saved.length;
  w.started[0].child.say({ active: true, ac: false });
  assert.equal(w.saved.length, saves);
  // Stopped with Reach: its input closes, it's ended, never started again.
  power.stop();
  assert.equal(w.started[0].child.stdin.ended, true);
  assert.equal(w.started[0].child.killed, 1);
  w.started[0].child.emit("exit", 0);
  assert.deepEqual(power.status(), { mode: "always", active: false, pid: null, error: "" });
  assert.equal(w.timers.length, 0);
  assert.equal(w.started.length, 1);
});

test("plugged in only: what the helper holds follows the power source it reads", async () => {
  const w = world();
  const power = keepAwake({ platform: "win32", mode: "ac", ...w.deps });
  await settle();
  assert.deepEqual(w.started[0].args, ["ac"]);
  const child = w.started[0].child;
  child.say({ active: false, ac: false });
  assert.equal(power.status().active, false);
  child.say({ active: true, ac: true });
  assert.equal(power.status().active, true);
  child.stdout.emit("data", "garbled\n{\"ac\":true}\n");
  assert.equal(power.status().active, true, "what it can't read changes nothing");
  power.stop();
});

test("a helper that stops is said and started again 5 s later; one this PC can't build, ten minutes later", async () => {
  const w = world();
  const power = keepAwakeWindows({ mode: "always", ...w.deps });
  await settle();
  w.started[0].child.say({ active: true });
  w.started[0].child.emit("exit", 1);
  assert.deepEqual(power.status(), { mode: "always", active: false, pid: null, error: "Sleep prevention stopped. Reach will retry within 5 seconds." });
  assert.deepEqual(w.said, ["Reach: Sleep prevention stopped. Reach will retry within 5 seconds."]);
  assert.equal(w.timers.at(-1).ms, 5000);
  await w.timers.at(-1).fn();
  assert.equal(w.started.length, 2, "started again");
  w.started[1].child.say({ active: true });
  assert.deepEqual(power.status(), { mode: "always", active: true, pid: 4322, error: "" });
  power.stop();

  let builds = 0;
  const unbuilt = world({ build: async () => { builds++; throw Object.assign(Error("This needs Windows' C# compiler"), { status: 503, compiler: false }); } });
  const none = keepAwakeWindows({ mode: "always", ...unbuilt.deps });
  await settle();
  assert.equal(none.status().error, "Could not enable sleep prevention. Reach will retry in 10 minutes.");
  assert.equal(unbuilt.timers.at(-1).ms, 10 * 60 * 1000);
  assert.equal(unbuilt.started.length, 0);
  await unbuilt.timers.at(-1).fn();
  assert.equal(builds, 2);
  none.stop();
});

test("off: nothing is started, as on a Mac", async () => {
  const w = world();
  const power = keepAwakeWindows({ mode: "off", ...w.deps });
  await settle();
  assert.deepEqual(w.started, []);
  power.stop();
  assert.deepEqual(w.saved, [{ mode: "off", active: false, pid: null, error: "" }]);
  assert.throws(() => keepAwakeWindows({ mode: "sometimes" }), /Invalid stay-awake mode/);
});

test("on real Windows, the helper holds the PC awake: powercfg lists it until Reach's side closes", { skip: !windows, timeout: 240000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach stay-awake-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = await windowsBinary({ dataDir }, "stay-awake");
  const requests = async () => {
    try {
      return (await promisify(execFile)("powercfg", ["/requests"], { windowsHide: true, timeout: 30000 })).stdout.toLowerCase();
    } catch (error) {
      if (/administrator|elevat|access is denied/i.test(`${error.stdout}${error.stderr}`)) return null;
      throw error;
    }
  };
  // Through keepAwake, as launch.mjs starts it.
  const saved = [];
  const power = keepAwake({ platform: "win32", mode: "always", helper: async () => file, changed: (awake) => saved.push(awake) });
  for (const until = Date.now() + 30000; !power.status().active; ) {
    if (Date.now() > until) assert.fail(`It never held the PC awake: ${JSON.stringify(saved)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const held = await requests();
  if (held === null) {
    power.stop();
    return t.skip("powercfg /requests needs an administrator.");
  }
  assert.ok(held.includes(path.basename(file).toLowerCase()), `powercfg lists the helper:\n${held}`);
  power.stop();
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(!(await requests()).includes(path.basename(file).toLowerCase()), "and lets go once stopped");
  // Reach gone without a word (its side of the pipe closed): the helper lets go and ends.
  const child = spawn(file, ["ac"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const [line] = await once(child.stdout, "data");
  const said = JSON.parse(String(line).split("\n")[0]);
  assert.equal(typeof said.active, "boolean");
  assert.ok(said.ac === null || typeof said.ac === "boolean");
  child.stdin.end();
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  assert.ok(!(await requests()).includes(path.basename(file).toLowerCase()));
});
