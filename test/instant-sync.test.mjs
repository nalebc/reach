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

test("a Claude Code chat written to on the Mac wakes the phone that has it open, Reach's own included; closed chats don't", async () => {
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
  // A chat Reach's process holds: its file still wakes the phone. The
  // process tells of a reply before the file has it (the phone read too
  // early), and the Claude app or a terminal can write while it idles.
  driving.add(C);
  const again = sessions.changes("claude", C, sessions.view("claude", C).version, 25000);
  tell({ agent: "claude", kind: "history", id: C });
  assert.equal(await settledWithin(again, 500), true);
  assert.equal(sessions.view("claude", C).items, 2);
  driving.delete(C);
  // Written in the instant between two polls (one answered, the next not yet
  // asked): still counted, so the next poll returns at once instead of the
  // phone showing Working until its 30 s look.
  const seen = sessions.view("claude", C).version;
  tell({ agent: "claude", kind: "history", id: C });
  tell({ agent: "claude", kind: "status" });
  assert.equal(await settledWithin(sessions.changes("claude", C, seen, 25000), 100), true);
  // The status news is checked against the registry first (a moment later).
  for (let i = 0; i < 20 && sessions.view("claude", C).items < 4; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(sessions.view("claude", C).items, 4);
  sessions.close?.();
});

test("a change in the Codex app's history reaches an open chat between two polls, not only one waiting that instant", async () => {
  let tell;
  const sessions = createAgentSessions({
    agentWatch: { onChange: (fn) => (tell = fn), close() {} },
    codexLive: { nudge() {}, view: () => ({ version: 0, prompts: [] }), changes: (id, version, ms) => new Promise((r) => setTimeout(r, ms)), drives: () => false, onChange() {} },
    claudeHost: {
      view: () => ({ version: 0, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 }),
      changes: (id, version, ms) => new Promise((r) => setTimeout(r, ms)),
      drives: () => false,
      onRelease() {},
    },
    claude: { list: async () => [], starts: async () => [], health: async () => ({ agent: "claude", signedIn: true }) },
    codex: { list: async () => [], health: async () => ({ agent: "codex", signedIn: true }) },
    live: async () => new Map(),
    detect: async () => [],
  });
  // The phone's poll answered; the next one isn't asked yet.
  const seen = sessions.view("codex", T).version;
  const controller = new AbortController();
  void sessions.changes("codex", T, seen, 25000, controller.signal);
  controller.abort();
  // The Codex app writes a reply to its history database meanwhile.
  tell({ agent: "codex", kind: "history" });
  assert.equal(await settledWithin(sessions.changes("codex", T, seen, 25000), 100), true, "the next poll returns at once");
  sessions.close?.();
});

test("a permission mode picked in the Claude app or the Codex app shows at once on the phone that has the chat open", async () => {
  let tell;
  const T2 = "0199cccc-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  const sessions = createAgentSessions({
    agentWatch: { onChange: (fn) => (tell = fn), close() {} },
    codexLive: { nudge() {}, view: () => ({ version: 0, prompts: [] }), changes: (id, version, ms) => new Promise((r) => setTimeout(r, ms)), drives: () => false, onChange() {} },
    claudeHost: {
      view: () => ({ version: 0, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 }),
      changes: (id, version, ms) => new Promise((r) => setTimeout(r, ms)),
      drives: () => false,
      onRelease() {},
    },
    claude: { list: async () => [], starts: async () => [], health: async () => ({ agent: "claude", signedIn: true }) },
    codex: { list: async () => [], health: async () => ({ agent: "codex", signedIn: true }) },
    live: async () => new Map(),
    detect: async () => [],
  });
  // The Claude app's records changed (a chat's mode, among others).
  const claudeOpen = sessions.changes("claude", C, sessions.view("claude", C).version, 25000);
  tell({ agent: "claude", kind: "app" });
  assert.equal(await settledWithin(claudeOpen, 500), true);
  // The Codex app's saved choices changed (the mode its composer is in).
  const codexOpen = sessions.changes("codex", T2, sessions.view("codex", T2).version, 25000);
  tell({ agent: "codex", kind: "settings" });
  assert.equal(await settledWithin(codexOpen, 500), true);
  assert.equal(sessions.view("codex", T2).items, 1, "the phone reads the chat (and its mode) again");
  sessions.close?.();
});
