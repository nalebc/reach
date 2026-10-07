import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serviceBackoff } from "../scripts/service-backoff.mjs";

// The background service never loops every 5 s on a start that can't
// succeed: after 3 failed starts in a row each waits longer, up to 5 minutes;
// one that runs well for a minute clears the count.
const setup = () => fs.mkdtemp(path.join(os.tmpdir(), "reach-backoff-"));
const quiet = { log() {}, setTimer: () => ({ unref() {} }) };

test("the first starts don't wait; failing ones then wait 5 s, 10 s, 20 s … at most 5 minutes", async () => {
  const state = await setup();
  const waits = [];
  for (let n = 0; n < 12; n++) {
    const { waited } = await serviceBackoff(state, { ...quiet, sleep: async (ms) => waits.push(ms) });
    assert.equal(waited, waits.at(-1) ?? 0);
  }
  assert.deepEqual(waits, [5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 300000]);
});

test("a start that stays up for a minute counts as healthy: the next start doesn't wait", async () => {
  const state = await setup();
  let healthy;
  const options = { log() {}, sleep: async () => {}, setTimer: (fn) => ((healthy = fn), { unref() {} }) };
  for (let n = 0; n < 5; n++) await serviceBackoff(state, options);
  healthy();
  const { failures, waited } = await serviceBackoff(state, options);
  assert.equal(failures, 0);
  assert.equal(waited, 0);
});

test("an unreadable count never blocks a start", async () => {
  const state = await setup();
  await fs.writeFile(path.join(state, "service-starts.json"), "{not json");
  const { waited } = await serviceBackoff(state, { ...quiet, sleep: async () => assert.fail("no wait") });
  assert.equal(waited, 0);
});
