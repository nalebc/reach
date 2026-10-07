import test from "node:test";
import assert from "node:assert/strict";
import { createCodexLive } from "../server/agent-sessions/codex-live.mjs";

// A message waiting in the Codex app's own queue left its "Queued" card up
// after it ran (it was already in the chat): the Codex app takes queued
// messages without telling Reach, and Reach looked again only every ~25 s.
// While something waits, the phone's view is refreshed within seconds.
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

test("a queued Codex message that ran leaves the phone's queue within seconds, with no word from Codex", async () => {
  let queue = [{ id: "q1", input: [{ type: "text", text: "Why am I asked to approve?" }] }];
  let clock = 1_000_000;
  const daemon = fakeDaemon({ "thread/queue/list": () => ({ data: queue }) });
  const live = createCodexLive({ daemon, queues: true, now: () => clock });
  live.view(T);
  await settle();
  assert.equal(live.view(T).outbox.length, 1);
  // The phone's long poll comes back quickly while something waits, so it looks again.
  const version = live.view(T).version;
  const started = Date.now();
  await live.changes(T, version, 25_000);
  assert.ok(Date.now() - started < 3500, "the phone looks again within 3 s");
  // The Codex app ran it (no queue notification): two seconds on, the view reads again.
  queue = [];
  clock += 2000;
  live.view(T);
  await settle();
  assert.equal(live.view(T).outbox, undefined, "the card is gone");
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
