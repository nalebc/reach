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
