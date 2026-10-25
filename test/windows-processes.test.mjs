import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { parseProcesses, stopProcessReadings, windowsProcesses } from "../server/windows-processes.mjs";

// Windows' process list, as `ps` gives a Mac's: one C# helper
// (scripts/native/processes.cs), built on first use, one JSON line. Here its
// answers are written out; on a real Windows runner the last test builds it
// with the PC's own csc.exe and finds itself and a child in what it says.
const windows = process.platform === "win32";
const folder = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach processes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const NODE = {
  pid: 4242, ppid: 1200, image: "node.exe", path: "C:\\Program Files\\nodejs\\node.exe",
  commandLine: "\"C:\\Program Files\\nodejs\\node.exe\" C:\\reach\\scripts\\bootstrap.mjs", startedAt: 1760000000000,
};

test("the helper's line, as rows: what Windows won't say stays null", () => {
  const hidden = { pid: 880, ppid: 4, image: "MsMpEng.exe", path: null, commandLine: null, startedAt: null };
  assert.deepEqual(parseProcesses(`${JSON.stringify({ processes: [NODE, hidden] })}\r\n`), [NODE, hidden]);
  assert.deepEqual(parseProcesses('{"processes":[]}\n'), []);
});

test("an answer Reach can't read is unknown, never an empty list", () => {
  assert.throws(() => parseProcesses('{"error":"unchecked","code":5}\n'), { code: "REACH_PROCESSES_UNCHECKED", message: "Windows wouldn't list its processes (5)." });
  for (const said of [
    "",
    "not json\n",
    '{"processes":{}}\n',
    `${JSON.stringify({ processes: [NODE] })}\n${JSON.stringify({ processes: [] })}\n`,
    JSON.stringify({ processes: [{ ...NODE, pid: -1 }] }),
    JSON.stringify({ processes: [{ ...NODE, pid: "4242" }] }),
    JSON.stringify({ processes: [{ ...NODE, image: null }] }),
    JSON.stringify({ processes: [{ ...NODE, commandLine: 42 }] }),
    JSON.stringify({ processes: [{ ...NODE, startedAt: "today" }] }),
    JSON.stringify({ processes: [{ ...NODE, startedAt: 0 }] }),
    JSON.stringify({ processes: [null] }),
  ])
    assert.throws(() => parseProcesses(said), { code: said.includes("error") ? "REACH_PROCESSES_UNCHECKED" : "REACH_PROCESSES_UNREADABLE" }, said);
});

test("built into the folder it's given, then run hidden; only on Windows", async (t) => {
  const nativeDir = path.join(folder(t), "native");
  const built = [];
  const ran = [];
  const rows = await windowsProcesses({
    nativeDir,
    platform: "win32",
    build: async (config, kind, options) => (built.push({ config, kind, options }), path.join(nativeDir, "reach-processes-0123456789ab.exe")),
    run: async (file, args, options) => (ran.push({ file, args, options }), { stdout: `${JSON.stringify({ processes: [NODE] })}\n` }),
  });
  assert.deepEqual(rows, [NODE]);
  assert.ok(fs.statSync(nativeDir).isDirectory(), "its folder is made first");
  assert.deepEqual(built.map(({ config, kind, options }) => [config.dataDir, kind, options.dir, options.platform]), [[nativeDir, "processes", nativeDir, "win32"]]);
  assert.deepEqual(ran.map(({ file, args, options }) => [path.basename(file), args, options.windowsHide]), [["reach-processes-0123456789ab.exe", [], true]]);
  await assert.rejects(windowsProcesses({ nativeDir, platform: "darwin" }), { status: 501 });
  await assert.rejects(windowsProcesses({ platform: "win32" }), /folder for its helpers/);
});

test("a Reach that quits stops its own readings and waits for their helpers; another folder's run on", async (t) => {
  const mine = path.join(folder(t), "mine"), other = path.join(folder(t), "other");
  const exited = [];
  // A helper that runs until it's stopped, then exits a moment later (as a
  // killed process does), and only then lets go of its program file.
  const helper = (name) => async (file, args, options) => {
    await new Promise((resolve) => options.signal.addEventListener("abort", resolve, { once: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    exited.push(name);
    throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  };
  const build = async (config) => path.join(config.dataDir, "reach-processes.exe");
  const quitting = windowsProcesses({ nativeDir: mine, platform: "win32", build, run: helper("mine") });
  let otherDone = false;
  const running = windowsProcesses({ nativeDir: other, platform: "win32", build, run: async (file, args, options) => {
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(options.signal.aborted, false, "another Reach's reading is left alone");
    otherDone = true;
    return { stdout: `${JSON.stringify({ processes: [NODE] })}\n` };
  } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await stopProcessReadings(mine);
  assert.deepEqual(exited, ["mine"], "stop returns only once its helper has exited");
  await assert.rejects(quitting, { name: "AbortError" });
  assert.deepEqual(await running, [NODE]);
  assert.equal(otherDone, true);
  await stopProcessReadings(mine); // nothing left: returns at once
});

test("on real Windows, the helper finds this test and the child it starts, each with its parent, program, command line and start", { skip: !windows, timeout: 240000 }, async (t) => {
  const nativeDir = path.join(folder(t), "native");
  const marker = `reach-processes-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", marker], { stdio: "ignore", windowsHide: true });
  t.after(() => child.kill());
  await once(child, "spawn");
  const rows = await windowsProcesses({ nativeDir });
  assert.ok(rows.length > 10, `a whole PC's processes (${rows.length})`);
  const self = rows.find((r) => r.pid === process.pid);
  assert.ok(self, "this test is listed");
  assert.equal(self.ppid, process.ppid);
  assert.equal(self.image.toLowerCase(), path.basename(process.execPath).toLowerCase());
  assert.equal(self.path.toLowerCase(), process.execPath.toLowerCase());
  assert.match(self.commandLine, /windows-processes\.test\.mjs/);
  const startedAbout = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(self.startedAt - startedAbout) < 10000, `started when Node says (${self.startedAt} vs ${startedAbout})`);
  const started = rows.find((r) => r.pid === child.pid);
  assert.ok(started, "the child is listed");
  assert.equal(started.ppid, process.pid);
  assert.ok(started.commandLine.includes(marker), started.commandLine);
  assert.ok(started.startedAt >= self.startedAt, "a child starts after its parent");
  // Windows' own idle and kernel processes have no program to read.
  const idle = rows.find((r) => r.pid === 0);
  if (idle) assert.deepEqual([idle.path, idle.commandLine], [null, null]);
});
