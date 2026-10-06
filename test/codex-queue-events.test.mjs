import test from "node:test";
import assert from "node:assert/strict";
import { createCodexLive } from "../server/agent-sessions/codex-live.mjs";

// "Don't pull" (2026-10-06): after a message went into the Codex app's queue,
// Reach asked Codex's queue every 500 ms to see whether the app took it. Now
// it waits on Codex's word (its queue notice, or its queue database
// changing), with a slow look as the safety net.
const T = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
function fakeDaemon(replies = {}) {
  const calls = [];
  let notify;
  return {
    calls,
    async rpc(method, params) {
      calls.push([method, params]);
      const reply = replies[method];
      const value = typeof reply === "function" ? reply(params) : reply;
      if (value instanceof Error) throw value;
      return value ?? {};
    },
    onNotification: (listener) => (notify = listener),
    onRequest() {},
    onClose() {},
    emit: (method, params) => notify({ method, params }),
  };
}

test("a message the Codex app takes from its queue is known at Codex's word, not on Reach's next look", async () => {
  let queue = [];
  const daemon = fakeDaemon({
    "thread/resume": new Error(`thread ${T} already has an active writer`),
    "thread/queue/add": () => ((queue = [{ id: "q1" }]), { queuedSubmission: { id: "q1" } }),
    "thread/queue/list": () => ({ data: queue }),
  });
  const live = createCodexLive({ daemon, wait: (ms) => new Promise((r) => setTimeout(r, ms)), deliverMs: 10000 });
  assert.deepEqual(await live.send(T, { text: "hi" }), { queued: true, delivered: false, messageId: "q1" });
  const looks = () => daemon.calls.filter(([m]) => m === "thread/queue/list").length;
  // Quiet: no looking on a beat while nothing changes.
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(looks(), 0, "no look every 500 ms");
  // The Codex app takes it, and Codex says its queue changed: looked at once.
  queue = [];
  daemon.emit("thread/queue/changed", { threadId: T });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(looks(), 1);
  // Taken: nothing more is asked, nothing taken back.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(looks(), 1);
  assert.ok(!daemon.calls.some(([m]) => m === "thread/queue/delete"));
});
