import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runsReach, superviseReach } from "../scripts/supervise.mjs";
import { reachHosts } from "../scripts/instances.mjs";

// `reach` from an npm install and reach.cmd on Windows start Reach again when
// it stopped by itself, as ./reach does (reliability audit, Oct 10).
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

// A stand-in Reach: each run exits with the next code (or a signal), or waits
// to be stopped when the code is "hold".
function fakeSpawn(outcomes) {
  const runs = [];
  const spawn = (node, argv, options) => {
    const child = new EventEmitter();
    const outcome = outcomes[runs.length];
    runs.push({ argv: argv.slice(1), env: options.env, child });
    child.kill = (signal) => { child.killedWith = signal; queueMicrotask(() => child.emit("exit", null, signal)); };
    if (outcome !== "hold") queueMicrotask(() => typeof outcome === "string" ? child.emit("exit", null, outcome) : child.emit("exit", outcome ?? 0, null));
    return child;
  };
  return { spawn, runs };
}
const quiet = { log: () => {}, wait: async () => {} };

test("which commands run Reach itself", () => {
  for (const args of [[], ["--port", "4318"], ["restart"], ["restart", "--yes"]]) assert.equal(runsReach(args), true, args.join(" "));
  for (const args of [["status"], ["stop"], ["approve"], ["--service"], ["--background"], ["-v"], ["restart", "--help"]]) assert.equal(runsReach(args), false, args.join(" "));
});

test("a crash or running out of memory starts it again, waiting longer each time, without restart's stopping", async () => {
  const { spawn, runs } = fakeSpawn([70, "SIGABRT", 0]);
  const waits = [], said = [];
  const signals = new EventEmitter();
  const code = await superviseReach({ script: "/r/scripts/bootstrap.mjs", args: ["restart", "--yes", "--port", "4318"], spawn, signals,
    wait: async (ms) => { waits.push(ms); }, log: (line) => said.push(line) });
  assert.equal(code, 0);
  assert.deepEqual(runs.map((r) => r.argv), [["restart", "--yes", "--port", "4318"], ["--port", "4318"], ["--port", "4318"]]);
  assert.ok(runs.every((r) => r.env.REACH_SUPERVISED === "1"));
  assert.deepEqual(waits, [1000, 5000]);
  assert.match(said.join("\n"), /starting again in 1s/);
  assert.equal(signals.listenerCount("SIGINT"), 0, "lets go of its signal handlers");
});

test("Ctrl+C, a stop and an error Reach reported are not started again", async () => {
  for (const exit of [0, 1, 130, 143]) {
    const { spawn, runs } = fakeSpawn([exit]);
    assert.equal(await superviseReach({ script: "s", spawn, signals: new EventEmitter(), ...quiet }), exit);
    assert.equal(runs.length, 1);
  }
});

test("five unexpected stops in ten minutes: it stops trying and says where to look", async () => {
  const { spawn, runs } = fakeSpawn(Array(10).fill(70));
  const said = [];
  const code = await superviseReach({ script: "s", spawn, signals: new EventEmitter(), wait: async () => {}, log: (line) => said.push(line) });
  assert.equal(code, 70);
  assert.equal(runs.length, 6);
  assert.match(said.at(-1), /5 times in 10 minutes[\s\S]*crash\.log/);
});

test("a stop sent to it is handed to Reach, and a stop while it waits ends it", async () => {
  // Running: `reach stop` / a closed window reaches Reach and nothing starts again.
  const running = fakeSpawn(["hold"]);
  const signals = new EventEmitter();
  const ended = superviseReach({ script: "s", spawn: running.spawn, signals, ...quiet });
  await new Promise((r) => setImmediate(r));
  signals.emit("SIGTERM", "SIGTERM");
  assert.equal(await ended, 143);
  assert.equal(running.runs[0].child.killedWith, "SIGTERM");
  assert.equal(running.runs.length, 1);
  // Waiting to start again: a stop ends the wait and nothing starts.
  const waiting = fakeSpawn([70, 0]);
  const signals2 = new EventEmitter();
  const done = superviseReach({ script: "s", spawn: waiting.spawn, signals: signals2, log: () => {}, wait: () => new Promise(() => {}) });
  await new Promise((r) => setImmediate(r));
  signals2.emit("SIGINT", "SIGINT");
  assert.equal(await done, 70);
  assert.equal(waiting.runs.length, 1);
});

test("the npm `reach` command runs Reach under the supervisor; other commands run as before", { skip: process.platform === "win32" && "POSIX paths" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-supervise-"));
  fs.mkdirSync(path.join(dir, "bin"));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.copyFileSync(path.join(repo, "bin", "reach.mjs"), path.join(dir, "bin", "reach.mjs"));
  fs.copyFileSync(path.join(repo, "scripts", "supervise.mjs"), path.join(dir, "scripts", "supervise.mjs"));
  fs.writeFileSync(path.join(dir, "scripts", "bootstrap.mjs"), `
    import fs from "node:fs";
    const file = ${JSON.stringify(path.join(dir, "runs.json"))};
    const runs = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
    runs.push({ args: process.argv.slice(2), supervised: process.env.REACH_SUPERVISED || "", ppid: process.ppid });
    fs.writeFileSync(file, JSON.stringify(runs));
    process.exitCode = runs.length === 1 && process.argv.length > 1 ? 70 : 0;
  `);
  const run = (args) => {
    fs.rmSync(path.join(dir, "runs.json"), { force: true });
    const result = spawnSync(process.execPath, [path.join(dir, "bin", "reach.mjs"), ...args], { encoding: "utf8", timeout: 20000, env: { ...process.env, REACH_SUPERVISED: "" } });
    return { status: result.status, out: result.stderr, runs: JSON.parse(fs.readFileSync(path.join(dir, "runs.json"), "utf8")) };
  };
  // Started Reach that crashed once: started again in the same window.
  const started = run(["--port", "4318"]);
  assert.equal(started.status, 0);
  assert.equal(started.runs.length, 2);
  assert.ok(started.runs.every((r) => r.supervised === "1"));
  assert.match(started.out, /starting again in 1s/);
  // Any other command: imported in this process, once, as before.
  const status = run(["status"]);
  assert.equal(status.runs.length, 1);
  assert.equal(status.runs[0].supervised, "");
});

test("the supervisor and the Reach it started are one Reach, whoever asks", () => {
  const node = "/opt/homebrew/bin/node";
  const pkg = "/usr/local/lib/node_modules/@nalebc/reach";
  const exists = (p) => p.startsWith("/");
  const table = [
    { pid: 100, ppid: 5, tty: "ttys004", command: `${node} ${pkg}/bin/reach.mjs` },
    { pid: 101, ppid: 100, tty: "ttys004", command: `${node} ${pkg}/scripts/bootstrap.mjs` },
    { pid: 102, ppid: 101, tty: "ttys004", command: "tailscale serve" },
    { pid: 200, ppid: 7, tty: "ttys005", command: `${node} ${pkg}/bin/reach.mjs status` },
  ];
  // `reach status` elsewhere sees one Reach: the one doing the work.
  assert.deepEqual(reachHosts(table, { self: 200, exists }).map((h) => h.pid), [101]);
  // The Reach started under the supervisor doesn't take its supervisor for another copy.
  assert.deepEqual(reachHosts(table, { self: 101, exists }).map((h) => h.pid), []);
  // Waiting to start again (no Reach under it yet): the supervisor is what runs.
  assert.deepEqual(reachHosts(table.filter((p) => p.pid !== 101 && p.pid !== 102), { self: 200, exists }).map((h) => h.pid), [100]);
  // A Reach started from inside one of Reach's own terminals is a second copy.
  const nested = [
    { pid: 10, ppid: 5, tty: "ttys001", command: `${node} ${pkg}/bin/reach.mjs` },
    { pid: 11, ppid: 10, tty: "ttys001", command: `${node} ${pkg}/scripts/bootstrap.mjs` },
    { pid: 12, ppid: 11, tty: "ttys009", command: "/bin/zsh -l" },
    { pid: 13, ppid: 12, tty: "ttys009", command: `${node} ${pkg}/bin/reach.mjs` },
    { pid: 14, ppid: 13, tty: "ttys009", command: `${node} ${pkg}/scripts/bootstrap.mjs` },
  ];
  assert.deepEqual(reachHosts(nested, { self: 14, exists }).map((h) => h.pid), [11]);
});
