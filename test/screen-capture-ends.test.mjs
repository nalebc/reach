import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { NativeScreenSource, sweepScreenHelpers } from "../server/screen-stream.mjs";

// Oct 12: a screen capture left running kept the Mac's screen-sharing mark on
// for hours, even with Reach paused, and Netflix wouldn't play. No capture
// may outlive what it was for.

// Only where a helper can ignore SIGTERM: on Windows, Node's kill() ends a
// process outright at once (TerminateProcess), so NativeScreenSource.stop's
// SIGKILL fallback (server/screen-stream.mjs) never has to come. The test
// below covers a helper stopping there.
test("a screen helper that ignores being stopped is ended outright", { skip: process.platform === "win32" ? "Windows' kill() ends a helper outright; no SIGTERM to ignore (NativeScreenSource.stop, server/screen-stream.mjs)" : false }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // A helper stuck on SIGTERM; it says when it's ready to be stopped.
  const source = new NativeScreenSource(process.execPath, [
    "-e",
    "process.on('SIGTERM', () => {}); process.stdout.write(''); setInterval(() => {}, 1000); console.error('up');",
  ]);
  await once(source.child.stderr, "data");
  const exited = once(source.child, "exit");
  source.stop();
  t.mock.timers.tick(4999);
  assert.equal(source.child.exitCode, null);
  assert.equal(source.child.signalCode, null, "given time to stop its capture");
  t.mock.timers.tick(1);
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL");
});

test("a helper that stops in time is never forced", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const source = new NativeScreenSource(process.execPath, ["-e", "setInterval(() => {}, 1000); console.error('up');"]);
  await once(source.child.stderr, "data");
  source.stop();
  const [, signal] = await once(source.child, "exit");
  assert.equal(signal, "SIGTERM");
  t.mock.timers.tick(10000);
});

test("Reach ends only screen helpers its own data folder built that aren't its own children", () => {
  const dataDir = "/Users/sam/reach/.reach/quick";
  const killed = [];
  const table = () => [
    { pid: 10, ppid: 1, command: `${dataDir}/reach-screen-stream-abc123 1 h264 30 1920` },
    { pid: 11, ppid: 500, command: `${dataDir}/reach-screen-stream-abc123 1 jpeg 15 1600` },
    { pid: 12, ppid: 1, command: `${dataDir}/reach-mac-prompts-abc123` },
    { pid: 13, ppid: 1, command: "/Users/other/reach/.reach/quick/reach-screen-stream-abc123 1" },
    { pid: 14, ppid: 77, command: "/Applications/Screen Studio.app/Contents/MacOS/Screen Studio" },
    { pid: 500, ppid: 1, command: "node scripts/bootstrap.mjs" },
  ];
  const ended = sweepScreenHelpers({ dataDir, self: 500, table, kill: (pid, signal) => killed.push([pid, signal]), platform: "darwin" });
  assert.deepEqual(ended, [10]);
  assert.deepEqual(killed, [[10, "SIGTERM"]], "its own running stream (pid 11) and anything else stay");
  // No process list (ps refused) or not a Mac: nothing happens.
  assert.deepEqual(sweepScreenHelpers({ dataDir, table: () => { throw Error("ps"); }, kill: () => assert.fail(), platform: "darwin" }), []);
  assert.deepEqual(sweepScreenHelpers({ dataDir, table, kill: () => assert.fail(), platform: "win32" }), []);
});
