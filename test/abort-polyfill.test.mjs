import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { getEventListeners } from "node:events";
import { transpile } from "./helpers/transpile.mjs";

const source = transpile(await fs.readFile(new URL("../src/abort-polyfill.ts", import.meta.url), "utf8"));
function polyfill() {
  const Signal = {};
  vm.runInNewContext(source.replace(/export\s*\{\s*\};?/, ""), {
    AbortSignal: Signal, AbortController, DOMException, setTimeout,
  });
  return Signal;
}

test("the older-iOS abort combiner releases every source listener once any request ends", () => {
  const Signal = polyfill();
  const view = new AbortController();
  for (let i = 0; i < 25; i++) {
    const deadline = new AbortController();
    const signal = Signal.any([view.signal, deadline.signal]);
    const reason = new Error("deadline");
    deadline.abort(reason);
    assert.equal(signal.aborted, true);
    assert.equal(signal.reason, reason);
    assert.equal(getEventListeners(view.signal, "abort").length, 0,
      "completed requests must not accumulate on a long-lived view");
    assert.equal(getEventListeners(deadline.signal, "abort").length, 0);
  }
});

test("an already-aborted source leaves no listeners on preceding sources", () => {
  const Signal = polyfill();
  const view = new AbortController(), ended = new AbortController();
  ended.abort(new Error("already ended"));
  const signal = Signal.any([view.signal, ended.signal]);
  assert.equal(signal.reason, ended.signal.reason);
  assert.equal(getEventListeners(view.signal, "abort").length, 0);
});
