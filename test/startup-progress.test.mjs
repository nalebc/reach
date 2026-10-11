import test from "node:test";
import assert from "node:assert/strict";
import { withStartupProgress } from "../scripts/startup-progress.mjs";

function clock() {
  let at = 0,
    next = 0;
  const timers = new Map(),
    lines = [];
  return {
    lines,
    timers,
    tick(ms) {
      at += ms;
      for (const callback of timers.values()) callback();
    },
    options: {
      print: (line) => lines.push(line),
      now: () => at,
      log: "/tmp/reach/setup.log",
      every(callback, ms) {
        assert.equal(ms, 5000);
        timers.set(++next, callback);
        return next;
      },
      clear: (id) => timers.delete(id),
    },
  };
}

test("a quiet restart build reports elapsed time, moves to the next step, and stops reporting when done", async () => {
  const c = clock();
  const result = await withStartupProgress(async ({ step }) => {
    step("preparing the phone interface");
    c.tick(5000);
    c.tick(5000);
    step("preparing Reach for agents");
    assert.equal(c.timers.size, 1);
    c.tick(5000);
    return "ready";
  }, c.options);
  assert.equal(result, "ready");
  assert.deepEqual(c.lines, [
    "Reach: preparing the phone interface…",
    "Reach: still preparing the phone interface — 5 s elapsed. Details: /tmp/reach/setup.log",
    "Reach: still preparing the phone interface — 10 s elapsed. Details: /tmp/reach/setup.log",
    "Reach: preparing the phone interface — done in 10 s.",
    "Reach: preparing Reach for agents…",
    "Reach: still preparing Reach for agents — 5 s elapsed. Details: /tmp/reach/setup.log",
    "Reach: preparing Reach for agents — done in 5 s.",
  ]);
  assert.equal(c.timers.size, 0);
});

test("a failed build stops its progress timer and preserves the actual error", async () => {
  const c = clock();
  const failure = Error("typecheck failed");
  await assert.rejects(
    withStartupProgress(async ({ step }) => {
      step("preparing the phone interface");
      c.tick(5000);
      throw failure;
    }, c.options),
    (error) => error === failure,
  );
  assert.equal(c.timers.size, 0);
  assert.equal(
    c.lines.at(-1),
    "Reach: preparing the phone interface — failed after 5 s.",
  );
});

test("an unchanged checkout has no build progress to report", async () => {
  const c = clock();
  await withStartupProgress(async () => {}, c.options);
  assert.deepEqual(c.lines, []);
  assert.equal(c.timers.size, 0);
});
