import test from "node:test";
import assert from "node:assert/strict";
import { createCodexLive } from "../server/agent-sessions/codex-live.mjs";

// A message waiting in the Codex app's own queue left its "Queued" card up
// after it ran (it was already in the chat): the Codex app takes queued
// messages without a notice to Reach. Its queue database changes, though
// (agent-watch.mjs): that word reads the queue again at once and wakes the
// phone (2026-10-06: "don't pull"), with a slow re-read as the safety net.
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
const settle = () => new Promise((r) => setTimeout(r, 5));

test("a queued Codex message that ran leaves the phone's queue the moment Codex's queue changes, with no notice", async () => {
  let queue = [{ id: "q1", input: [{ type: "text", text: "Why am I asked to approve?" }] }];
  let clock = 1_000_000;
  const daemon = fakeDaemon({ "thread/queue/list": () => ({ data: queue }) });
  const live = createCodexLive({ daemon, queues: true, now: () => clock });
  live.view(T);
  await settle();
  assert.equal(live.view(T).outbox.length, 1);
  // The phone waits on the Mac (its long poll)…
  const version = live.view(T).version;
  const started = Date.now();
  const woke = live.changes(T, version, 25_000);
  // …the Codex app runs it: no notice, but its queue database changes.
  queue = [];
  live.nudge("queue");
  await woke;
  assert.ok(Date.now() - started < 500, "woken at once, not on a beat");
  assert.equal(live.view(T).outbox, undefined, "the card is gone");
});

test("with no word at all, the queue is still read again after a while (the safety net)", async () => {
  let queue = [{ id: "q1", input: [{ type: "text", text: "next" }] }];
  let clock = 1_000_000;
  const daemon = fakeDaemon({ "thread/queue/list": () => ({ data: queue }) });
  const live = createCodexLive({ daemon, queues: true, now: () => clock });
  live.view(T);
  await settle();
  queue = [];
  // Not on a seconds beat anymore…
  clock += 3000;
  live.view(T);
  await settle();
  assert.equal(live.view(T).outbox.length, 1);
  // …but after the safety net's time, it is.
  clock += 15000;
  live.view(T);
  await settle();
  assert.equal(live.view(T).outbox, undefined);
});

test("a turn starting or ending re-reads what waits (a queued message may have become that turn)", async () => {
  let queue = [{ id: "q1", input: [{ type: "text", text: "next" }] }];
  const daemon = fakeDaemon({ "thread/queue/list": () => ({ data: queue }) });
  const live = createCodexLive({ daemon, queues: true, now: () => 1_000_000 });
  live.view(T);
  await settle();
  assert.equal(live.view(T).outbox.length, 1);
  queue = [];
  daemon.emit("turn/started", { threadId: T, turn: { id: "turn-2" } });
  await settle();
  assert.equal(live.view(T).outbox, undefined);
});

test("with nothing waiting, the long poll still waits its full time", async () => {
  const daemon = fakeDaemon({ "thread/queue/list": () => ({ data: [] }) });
  const live = createCodexLive({ daemon, queues: true, now: () => 1_000_000 });
  live.view(T);
  await settle();
  const version = live.view(T).version;
  const result = await Promise.race([
    live.changes(T, version, 400).then(() => "woke"),
    new Promise((r) => setTimeout(() => r("still waiting"), 300)),
  ]);
  assert.equal(result, "still waiting");
});
