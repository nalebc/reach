import test from "node:test";
import assert from "node:assert/strict";
import { createCodexLive } from "../server/agent-sessions/codex-live.mjs";
import { createOutbox } from "../server/agent-sessions/outbox.mjs";

// Queued messages as the Codex app handles them (2026-10-07: they couldn't be
// edited or sent now from Reach, and an answer to Codex's question waited in
// the queue): Send now is its Steer, into the turn it runs (through the Codex
// app when it holds the chat); Edit changes one where it waits, pictures
// kept; an answer goes into the running turn at once.
const T = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const HELD = new Error(`thread ${T} already has an active writer`);
const running = { data: [{ id: "turn-1", status: "inProgress" }] };
const idle = { data: [{ id: "turn-1", status: "completed", completedAt: 1 }] };
function fakeDaemon(replies = {}) {
  const calls = [];
  return {
    calls,
    async rpc(method, params) {
      calls.push([method, params]);
      const reply = replies[method];
      const value = typeof reply === "function" ? reply(params) : reply;
      if (value instanceof Error) throw value;
      return value ?? {};
    },
    onNotification() {},
    onRequest() {},
    onClose() {},
  };
}
function fakeDesktop(outcome = "ok") {
  const steered = [];
  return {
    steered,
    async steer(conversationId, options) {
      steered.push([conversationId, options]);
      if (outcome === "refused") throw Object.assign(new Error("The Codex app couldn't take it now. It stays queued."), { status: 409 });
      if (outcome === "uncertain") throw Object.assign(new Error("The Codex app didn't confirm it."), { status: 409, uncertain: true });
      return { steered: true };
    },
  };
}
const picture = { type: "localImage", path: "/tmp/p.png" };
const queued = [{ id: "q1", input: [{ type: "text", text: "home screen app should update also", text_elements: [] }, picture] }];

test("Send now steers a queued message into the turn the Codex app runs, through the app", async () => {
  const daemon = fakeDaemon({
    "thread/queue/list": { data: queued },
    "thread/turns/list": running,
    "thread/read": { thread: { id: T, cwd: "/Users/me/reach" } },
    "thread/queue/delete": { deleted: true },
  });
  const desktop = fakeDesktop();
  const live = createCodexLive({ daemon, desktop });
  assert.deepEqual(await live.sendQueuedNow(T, "q1"), { sent: true });
  assert.equal(desktop.steered.length, 1);
  const [id, options] = desktop.steered[0];
  assert.equal(id, T);
  assert.deepEqual(options.input, queued[0].input, "its pictures too");
  assert.equal(options.queued, "q1");
  assert.equal(options.cwd, "/Users/me/reach");
  await assert.rejects(live.sendQueuedNow(T, "gone"), /already left the queue/);
});

test("Send now starts a queued message when nothing runs", async () => {
  const daemon = fakeDaemon({ "thread/queue/list": { data: queued }, "thread/turns/list": idle });
  const desktop = fakeDesktop();
  const live = createCodexLive({ daemon, desktop });
  await live.sendQueuedNow(T, "q1");
  assert.deepEqual(daemon.calls.find(([m]) => m === "thread/queue/start"), ["thread/queue/start", { threadId: T, queuedSubmissionId: "q1" }]);
  assert.equal(desktop.steered.length, 0);
});

test("the Codex app refusing a Send now leaves it queued, nothing lost", async () => {
  const daemon = fakeDaemon({ "thread/queue/list": { data: queued }, "thread/turns/list": running, "thread/read": { thread: { cwd: "/w" } } });
  const live = createCodexLive({ daemon, desktop: fakeDesktop("refused") });
  await assert.rejects(live.sendQueuedNow(T, "q1"), /stays queued/);
  assert.equal(daemon.calls.some(([m]) => m === "thread/queue/delete"), false);
});

test("Edit changes a queued message where it waits, its pictures kept", async () => {
  const daemon = fakeDaemon({ "thread/queue/list": { data: queued } });
  const live = createCodexLive({ daemon, desktop: fakeDesktop() });
  assert.deepEqual(await live.editQueued(T, "q1", "home screen app should update"), { edited: true });
  assert.deepEqual(daemon.calls.find(([m]) => m === "thread/queue/update")[1], {
    threadId: T,
    queuedSubmissionId: "q1",
    input: [{ type: "text", text: "home screen app should update", text_elements: [] }, picture],
  });
  // Words cleared: the pictures alone go.
  await live.editQueued(T, "q1", "");
  assert.deepEqual(daemon.calls.filter(([m]) => m === "thread/queue/update")[1][1].input, [picture]);
  await assert.rejects(live.editQueued(T, "q1", "x".repeat(50001)), /50,000/);
});

test("an answer to Codex's question goes into its running turn at once, not the queue", async () => {
  const daemon = fakeDaemon({
    "thread/resume": HELD,
    "thread/turns/list": running,
    "thread/read": { thread: { cwd: "/w" } },
    "thread/queue/add": { queuedSubmission: { id: "q9" } },
    "thread/queue/list": { data: [] },
  });
  const desktop = fakeDesktop();
  const live = createCodexLive({ daemon, desktop, deliverMs: 1 });
  const r = await live.send(T, { text: "Which file?\nApp.tsx", steer: true });
  assert.deepEqual(r, { steered: true, delivered: true });
  assert.equal(daemon.calls.some(([m]) => m === "thread/queue/add"), false);
  assert.equal(desktop.steered[0][1].text, "Which file?\nApp.tsx");
  // The app can't take it now: it waits its turn, as before.
  const refusing = createCodexLive({ daemon, desktop: fakeDesktop("refused"), deliverMs: 1 });
  assert.equal((await refusing.send(T, { text: "x", steer: true })).queued, true);
  // Uncertain: never sent twice.
  const unsure = createCodexLive({ daemon, desktop: fakeDesktop("uncertain"), deliverMs: 1 });
  await assert.rejects(unsure.send(T, { text: "x", steer: true }), /didn't confirm/);
  // A plain message still waits its turn while the Codex app works.
  const plain = createCodexLive({ daemon, desktop, deliverMs: 1 });
  assert.equal((await plain.send(T, { text: "later" })).queued, true);
});

test("Claude's queue: a waiting message edited where it waits, never one on its way", () => {
  const outbox = createOutbox();
  const m = outbox.add("s1", { text: "first", images: ["/tmp/a.png"] });
  assert.equal(outbox.edit("s1", m.id, "changed"), true);
  assert.equal(outbox.list("s1")[0].text, "changed");
  // Its picture alone is still a message.
  assert.equal(outbox.edit("s1", m.id, ""), true);
  const words = outbox.add("s1", { text: "words only" });
  assert.equal(outbox.edit("s1", words.id, "  "), false);
  outbox.begin("s1", m.id);
  assert.equal(outbox.edit("s1", m.id, "too late"), false);
  assert.equal(outbox.edit("s1", "nope", "x"), false);
});
