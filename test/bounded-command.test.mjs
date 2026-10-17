import test from "node:test";
import assert from "node:assert/strict";
import { boundedCommand } from "./helpers/bounded-command.mjs";

test("a command's successful exit is enough without independent progress", async () => {
  const answer = await boundedCommand(process.execPath, ["-e", "process.stdout.write('done')"], 5000);
  assert.equal(answer.stdout, "done");
  assert.equal(answer.observed, undefined);
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
