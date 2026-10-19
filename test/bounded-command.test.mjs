import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { boundedCommand } from "./helpers/bounded-command.mjs";

test("a command's successful exit is enough without independent progress", async () => {
  const answer = await boundedCommand(process.execPath, ["-e", "process.stdout.write('done')"], 5000);
  assert.equal(answer.stdout, "done");
  assert.equal(answer.observed, undefined);
});

test("a successful launcher cannot certify a required native transition without its evidence", async () => {
  await assert.rejects(boundedCommand(process.execPath, ["-e", "process.stdout.write('launch requested')"], 500, {
    progress: new Promise(() => {}), requireProgress: true,
  }), /did not finish within 0.5 s/);
});

test("a launcher that already exited still waits for the required native evidence within its deadline", async () => {
  let observe, settled = false;
  const progress = new Promise(resolve => { observe = resolve; });
  const answer = boundedCommand(process.execPath, ["-e", "process.stdout.write('launch requested')"], 5000, {
    progress, requireProgress: true,
  }).then(result => { settled = true; return result; });
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(settled, false, "command exit alone cannot report a native background or resume");
  observe();
  const result = await answer;
  assert.equal(result.observed, true);
});

test("an observed operation releases a stuck launcher and still reports how it completed", async () => {
  let observe;
  const progress = new Promise(resolve => { observe = resolve; });
  const answer = boundedCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 5000, { progress });
  observe();
  assert.equal((await answer).observed, true);
});

test("a launcher without progress fails at its deadline, and a failed operation stays failed", async () => {
  await assert.rejects(boundedCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 100), /did not finish/);
  await assert.rejects(boundedCommand(process.execPath, ["-e", "process.stderr.write('failed'); process.exit(7)"], 5000), /exited with 7: failed/);
});

test("a timed-out launcher retains its output without waiting for its pipes to close", async () => {
  await assert.rejects(boundedCommand(process.execPath, ["-e", "process.stdout.write('launch requested'); process.stderr.write('launch service waiting'); setInterval(() => {}, 1000)"], 2000), error => {
    assert.match(error.message, /did not finish within 2 s/);
    assert.equal(error.stdout, "launch requested");
    assert.equal(error.stderr, "launch service waiting");
    return true;
  });
});

test("failed command output has strict caps even when a final chunk crosses the limit", async () => {
  const source = "process.stdout.write('o'.repeat((2 << 20) + 1000), () => process.stderr.write('e'.repeat((1 << 16) + 1000), () => { process.exitCode = 7; }))";
  await assert.rejects(boundedCommand(process.execPath, ["-e", source], 5000), error => {
    assert.match(error.message, /exited with 7/);
    assert.equal(error.stdout.length, 2 << 20);
    assert.equal(error.stderr.length, 1 << 16);
    return true;
  });
});

test("optional lifecycle evidence distinguishes exited launchers from a required progress deadline", async () => {
  let evidence;
  await assert.rejects(boundedCommand(process.execPath, ["-e", "process.stdout.write('requested')"], 700, {
    captureLifecycle: true, requireProgress: true, progress: new Promise(() => {}),
  }), error => {
    evidence = error.commandEvidence;
    assert.match(error.message, /did not finish within 0.7 s/);
    assert.equal(error.stdout, "requested");
    return true;
  });
  assert.equal(evidence.command, process.execPath);
  assert.deepEqual(evidence.args, ["-e", "process.stdout.write('requested')"]);
  assert.deepEqual(evidence.options, { stdio: ["ignore", "pipe", "pipe"], limitMs: 700, requireProgress: true, hasProgress: true });
  assert.ok(evidence.events.some(event => event.event === "exit" && event.code === 0));
  assert.ok(evidence.events.some(event => event.event === "close" && event.code === 0));
  assert.ok(evidence.events.some(event => event.event === "deadline" && event.exitCode === 0));
  assert.ok(!evidence.events.some(event => event.event === "kill-request"));
  assert.equal(evidence.stdoutDecodedUtf8Bytes, 9);
  assert.equal(evidence.outputRetention.units, "UTF-16 code units");
});

test("lifecycle evidence records child exit before inherited stdout pipes close", async t => {
  // Real local child/pipe behavior only; no simulator. The grandchild inherits
  // the launcher's pipes, as a service may. It has a finite natural lifetime
  // and writes an owned completion marker; no PID is used for later control.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-command-pipes-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const marker = path.join(dir, "natural-completion");
  const grandchild = `setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'done')},2200)`;
  const source = `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore',process.stdout,process.stderr]}); console.log(c.pid); c.unref();`;
  let problem, pid;
  try {
    await boundedCommand(process.execPath, ["-e", source], 1200, { captureLifecycle: true });
    assert.fail("inherited pipes must hold close past the deadline");
  } catch (error) { problem = error; pid = Number(error.stdout?.trim()); }
  assert.match(problem.message, /did not finish within 1.2 s/);
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const events = problem.commandEvidence.events;
  const exit = events.find(event => event.event === "exit");
  const deadline = events.find(event => event.event === "deadline");
  assert.equal(exit.code, 0);
  assert.equal(deadline.exitCode, 0);
  assert.ok(exit.elapsedMs < deadline.elapsedMs);
  assert.ok(!events.some(event => event.event === "close" && event.elapsedMs < deadline.elapsedMs));
  const until = Date.now() + 5000;
  let completed = false;
  while (Date.now() < until) {
    if (await fs.readFile(marker, "utf8").catch(() => "") === "done") { completed = true; break; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(completed, true, "the fixture grandchild completes naturally without PID-based teardown");
});

test("failed process creation is retained as lifecycle evidence rather than an unhandled error", async () => {
  await assert.rejects(boundedCommand(`${process.execPath}.reach-does-not-exist`, [], 1000, { captureLifecycle: true }), error => {
    assert.equal(error.code, "ENOENT");
    assert.ok(error.commandEvidence.events.some(event => event.event === "error"));
    return true;
  });
});
