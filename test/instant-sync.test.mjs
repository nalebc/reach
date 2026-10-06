import test from "node:test";
import assert from "node:assert/strict";
import { createCodexLive } from "../server/agent-sessions/codex-live.mjs";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";

// Everything the Mac's apps do shows on the phone at once: a message queued
// in the Codex app, a reply written in the Claude app. Reach hears of it from
// the apps' own files (agent-watch.mjs) and wakes the phone's long poll,
// instead of the phone finding out on its next look (it used to need leaving
// the chat and coming back).
const T = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const C = "11111111-2222-4333-8444-555555555555";
const fakeDaemon = (queue) => ({
  async rpc(method) {
    if (method === "thread/queue/list") return { data: queue };
    return {};
  },
  onNotification() {},
  onRequest() {},
  onClose() {},
  close() {},
});
const settledWithin = async (promise, ms) => Promise.race([promise.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

test("a message queued in the Codex app shows on the phone at once, not on its next look", async () => {
  const queue = [];
  const live = createCodexLive({ daemon: fakeDaemon(queue), queues: true });
  // The phone has the chat open: its long poll waits.
  const version = live.view(T).version;
  await new Promise((r) => setTimeout(r, 20));
  const waiting = live.changes(T, live.view(T).version, 25000);
  // The Codex app queues a message (its queue database is written).
  queue.push({ id: "q1", input: [{ type: "text", text: "Also run the linter" }] });
  live.nudge("queue");
  assert.equal(await settledWithin(waiting, 500), true, "the long poll woke at once");
  assert.deepEqual(live.view(T).outbox?.map((q) => q.text), ["Also run the linter"]);
  assert.ok(live.view(T).version > version);
});

test("a change in the Codex app's history makes the open chat read again at once; chats nobody has open aren't touched", async () => {
  const live = createCodexLive({ daemon: fakeDaemon([]), queues: false });
  live.view(T);
  const before = live.view(T).items;
  const waiting = live.changes(T, live.view(T).version, 25000);
  live.nudge("history");
  assert.equal(await settledWithin(waiting, 500), true);
  assert.equal(live.view(T).items, before + 1, "the phone reads the chat again");
  const other = "0199bbbb-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  live.view(other);
  const quiet = live.view(other).items;
  live.nudge("history");
  assert.equal(live.view(other).items, quiet);
});

test("a Claude Code chat written to on the Mac wakes the phone that has it open; Reach's own writes and closed chats don't", async () => {
  let tell;
  const nudged = [];
  const driving = new Set();
  const sessions = createAgentSessions({
    agentWatch: { onChange: (fn) => (tell = fn), close() {} },
    codexLive: { nudge: (kind) => nudged.push(kind), view: () => ({ version: 0, prompts: [] }), changes: () => new Promise(() => {}), drives: () => false, onChange() {} },
    claudeHost: {
      view: () => ({ version: 0, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 }),
      changes: (id, version, ms) => new Promise((r) => setTimeout(r, ms)),
      drives: (id) => driving.has(id),
      onRelease() {},
    },
    claude: { list: async () => [], starts: async () => [], health: async () => ({ agent: "claude", signedIn: true }) },
    codex: { list: async () => [], health: async () => ({ agent: "codex", signedIn: true }) },
    live: async () => new Map(),
    detect: async () => [],
  });
  // Codex news goes to Codex's live state.
  tell({ agent: "codex", kind: "queue" });
  assert.deepEqual(nudged, ["queue"]);
  // Nobody has the chat open: nothing counted.
  tell({ agent: "claude", kind: "history", id: C });
  assert.equal(sessions.view("claude", C).items, 0);
  // Open on the phone: woken at once, and something new to read.
  const waiting = sessions.changes("claude", C, sessions.view("claude", C).version, 25000);
  tell({ agent: "claude", kind: "history", id: C });
  assert.equal(await settledWithin(waiting, 500), true);
  assert.equal(sessions.view("claude", C).items, 1);
  // Reach writing it itself (its own reply) is told by its own events instead.
  driving.add(C);
  const again = sessions.changes("claude", C, sessions.view("claude", C).version, 300);
  tell({ agent: "claude", kind: "history", id: C });
  assert.equal(await settledWithin(again, 100), false);
  sessions.close?.();
});
