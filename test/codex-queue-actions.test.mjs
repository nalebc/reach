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

test("your last message is edited and sent again, as the Codex app's Edit: pictures kept, never mid-turn, only the latest", async () => {
  const picture = { type: "localImage", path: "/tmp/p.png" };
  const items = { data: [
    { turnId: "turn-2", item: { type: "agentMessage", id: "a2", text: "done" } },
    { turnId: "turn-2", item: { type: "userMessage", id: "u2", content: [{ type: "text", text: "fix it", text_elements: [] }, picture] } },
    { turnId: "turn-1", item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "older" }] } },
  ] };
  const daemon = fakeDaemon({ "thread/turns/list": idle, "thread/items/list": items, "turn/start": { turn: { id: "turn-3", status: "inProgress" } } });
  const live = createCodexLive({ daemon, desktop: fakeDesktop() });
  assert.deepEqual(await live.editLast(T, { turnId: "turn-2", text: "fix it properly" }), { edited: true, turnId: "turn-3" });
  assert.deepEqual(daemon.calls.find(([m]) => m === "thread/revert")[1], { threadId: T, beforeTurnId: "turn-2" });
  assert.deepEqual(daemon.calls.find(([m]) => m === "turn/start")[1].input, [{ type: "text", text: "fix it properly", text_elements: [] }, picture]);
  await assert.rejects(live.editLast(T, { turnId: "turn-1", text: "x" }), /most recent/);
  // While Codex works: stop it first.
  const busy = createCodexLive({ daemon: fakeDaemon({ "thread/turns/list": running }), desktop: fakeDesktop() });
  await assert.rejects(busy.editLast(T, { turnId: "turn-2", text: "x" }), /Stop it first/);
  // Held by the Codex app: the app does it.
  const edits = [];
  const held = createCodexLive({
    daemon: fakeDaemon({ "thread/turns/list": idle, "thread/resume": HELD }),
    desktop: { editLast: async (id, o) => (edits.push([id, o]), { edited: true }) },
  });
  assert.deepEqual(await held.editLast(T, { turnId: "turn-2", text: "via app" }), { edited: true });
  assert.deepEqual(edits, [[T, { turnId: "turn-2", message: "via app" }]]);
});

test("Codex's queue takes a new order, and compacting a chat the app holds goes through the app", async () => {
  const daemon = fakeDaemon({ "thread/queue/list": { data: [] }, "thread/resume": HELD });
  const compacted = [];
  const live = createCodexLive({ daemon, desktop: { compact: async (id) => (compacted.push(id), { compacted: true }) } });
  assert.deepEqual(await live.reorderQueued(T, ["q2", "q1"]), { reordered: true });
  assert.deepEqual(daemon.calls.find(([m]) => m === "thread/queue/reorder")[1], { threadId: T, queuedSubmissionIds: ["q2", "q1"] });
  await assert.rejects(live.reorderQueued(T, "q1"), /Invalid order/);
  assert.deepEqual(await live.call(T, "thread/compact/start", {}), { compacted: true });
  assert.deepEqual(compacted, [T]);
  // Anything else stays the app's to run.
  await assert.rejects(live.call(T, "review/start", {}), /runs this there/);
});

test("Plan sends Codex's plan mode with the turn, with the chat's model; a chat the Codex app holds says to turn it on there", async () => {
  const daemon = fakeDaemon({
    "thread/read": { thread: { id: T, model: "gpt-5.5", cwd: "/w" } },
    "turn/start": { turn: { id: "turn-9", status: "inProgress" } },
  });
  const live = createCodexLive({ daemon, desktop: fakeDesktop() });
  await live.send(T, { text: "think first", collaboration: "plan" });
  assert.deepEqual(daemon.calls.find(([m]) => m === "turn/start")[1].collaborationMode, {
    mode: "plan",
    settings: { model: "gpt-5.5", reasoning_effort: null, developer_instructions: null },
  });
  const held = createCodexLive({ daemon: fakeDaemon({ "thread/resume": HELD }), desktop: fakeDesktop() });
  await assert.rejects(held.send(T, { text: "x", collaboration: "plan" }), /turn Plan on there/);
});

test("speed changes mid-chat, as in the Codex app: the thread's own setting, the app's when it holds the chat", async () => {
  const daemon = fakeDaemon({ "thread/settings/update": {} });
  const live = createCodexLive({ daemon, desktop: fakeDesktop() });
  assert.deepEqual(await live.model(T, { model: "gpt-5.5", speed: "fast" }), { model: "gpt-5.5", speed: "fast", applied: true });
  assert.deepEqual(daemon.calls.find(([m]) => m === "thread/settings/update")[1], { threadId: T, model: "gpt-5.5", serviceTier: "fast" });
  const settings = [];
  const held = createCodexLive({
    daemon: fakeDaemon({ "thread/settings/update": new Error("thread not found"), "thread/resume": HELD }),
    desktop: { model: async (id, s) => (settings.push(s), { applied: true }) },
  });
  await held.model(T, { model: "gpt-5.5", speed: "fast" });
  assert.deepEqual(JSON.parse(JSON.stringify(settings)), [{ model: "gpt-5.5", serviceTier: "fast" }]);
});
