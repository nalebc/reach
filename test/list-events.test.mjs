import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentWatch } from "../server/agent-sessions/agent-watch.mjs";
import { codexWaitingApproval } from "../server/agent-sessions/codex-asks.mjs";
import { createNotifications } from "../server/notifications.mjs";

// "Don't pull, make everything evented" (2026-10-06): phones asked for the
// whole chat list every 4 s and notifications looked every 5 s. Now the Mac
// keeps one list, rebuilds it when an agent writes, says so, and looks again
// by itself only when a chat's settle time is up (a request waiting on you
// writes nothing).
const HELD = "01a10f85-c2e3-7f51-a438-9827fd38e5d9";
const chat = (extra = {}) => ({
  agent: "codex",
  id: HELD,
  title: "Redesign invite someone UI",
  cwd: "/work",
  branch: "",
  origin: "app",
  inApp: true,
  updatedAt: 1,
  createdAt: 1,
  status: "idle",
  preview: "",
  archived: false,
  ...extra,
});
const until = async (check, ms = 2000) => {
  for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) return false;
  return true;
};

async function sessionsWith({ codexList, ...extra }) {
  const { createAgentSessions } = await import("../server/agent-sessions/index.mjs");
  const watchers = new Set();
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: { list: codexList, projects: async () => [] },
    codexLive: { drives: () => false },
    claude: { list: async () => [] },
    gemini: { list: async () => [] },
    live: async () => new Map(),
    claudeHost: {
      onRelease() {},
      running: () => false,
      drives: () => false,
      view: () => ({ version: 0, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 }),
      changes: (id, version, ms) => new Promise((r) => setTimeout(r, ms)),
    },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} },
    agentWatch: {
      onChange(listener) {
        watchers.add(listener);
        return () => watchers.delete(listener);
      },
    },
    listMaxAgeMs: 60000,
    listGapMs: 20,
    proactive: true,
    ...extra,
  });
  return { sessions, write: (news) => watchers.forEach((w) => w(news)) };
}

test("the chat list is kept between looks and rebuilt when an agent writes; listeners hear of each new one", async () => {
  let reads = 0;
  let status = "idle";
  const { sessions, write } = await sessionsWith({ codexList: async () => (reads++, [chat({ status })]) });
  try {
    await sessions.list();
    await sessions.list();
    assert.equal(reads, 1, "kept, not read again");
    const heard = [];
    sessions.onListChange((revision) => heard.push(revision));
    // Codex writes: rebuilt by itself, and told.
    status = "running";
    write({ agent: "codex", kind: "history" });
    assert.ok(await until(() => heard.length === 1), "told of the new list");
    assert.equal((await sessions.list()).sessions[0].status, "running");
    // Nothing changed in what it read: no news.
    write({ agent: "codex", kind: "history" });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(heard.length, 1);
  } finally {
    sessions.close();
  }
});

test("a chat waiting on you is told when its settle time is up, with nothing else happening", async () => {
  const { sessions } = await sessionsWith({ codexList: async () => [chat({ status: "waiting" })], settleMs: 120 });
  try {
    const heard = [];
    sessions.onListChange((revision) => heard.push(revision));
    await until(() => heard.length === 1);
    assert.equal((await sessions.list()).sessions[0].status, "running", "just flagged: not yet");
    // No write, no notice: the Mac looks again by itself when it's time.
    assert.ok(await until(() => heard.length === 2, 1000), "told once it counts");
    assert.equal((await sessions.list()).sessions[0].status, "waiting");
  } finally {
    sessions.close();
  }
});

test("a Codex request too new to count says when to look at it again", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-later-"));
  try {
    const file = path.join(dir, `rollout-${HELD}.jsonl`);
    const at = Date.now() - 3000;
    const line = (type, payload) => JSON.stringify({ timestamp: new Date(at).toISOString(), type, payload });
    fs.writeFileSync(
      file,
      [
        line("event_msg", { type: "task_started" }),
        line("turn_context", { approvals_reviewer: "user" }),
        line("response_item", { type: "function_call", call_id: "c1", arguments: JSON.stringify({ cmd: "ls", sandbox_permissions: "require_escalated" }) }),
      ].join("\n") + "\n",
    );
    let later;
    assert.equal(await codexWaitingApproval(file, { settleMs: 10000, onLater: (ms) => (later = ms) }), null);
    assert.ok(later > 6000 && later <= 7000, `looked at again in ${later} ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the agents' files that say a chat changed are all watched: Codex's chats, Claude Code's status, the Claude app's records", async () => {
  const handlers = new Map();
  const watch = createAgentWatch({
    codexHome: "/codex",
    claudeProjects: "/claude/projects",
    claudeSessions: "/claude/sessions",
    claudeAppRecords: "/app/records",
    debounceMs: 5,
    watch: (dir, options, listener) => (handlers.set(dir, listener), { on() {}, unref() {}, close() {} }),
  });
  const news = [];
  watch.onChange((n) => news.push(n));
  handlers.get("/codex/sessions")("change", `2026/10/06/rollout-2026-10-06T07-21-22-${HELD}.jsonl`);
  handlers.get("/claude/sessions")("change", "2018.json");
  handlers.get("/app/records")("change", "acct/org/local_c7a1f0e7-e040-4d99-a9ad-78a80b447310.json");
  await until(() => news.length === 3);
  assert.deepEqual(
    news.map((n) => [n.agent, n.kind, n.id]),
    [
      ["codex", "rollout", HELD],
      ["claude", "status", undefined],
      ["claude", "app", undefined],
    ],
  );
  watch.close();
});

test("notifications look when told something changed, not on a 5 s beat", async () => {
  let reads = 0;
  const notifications = createNotifications({
    read: async () => (reads++, { items: [], unavailable: [] }),
    notify: async () => ({ sent: 1 }),
    enabled: () => true,
    file: null,
    wakeMs: 10,
  });
  try {
    notifications.start();
    await until(() => reads === 1);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(reads, 1, "no look on a beat");
    notifications.wake();
    notifications.wake(); // a burst is one look
    assert.ok(await until(() => reads === 2));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(reads, 2);
  } finally {
    notifications.close();
  }
});

test("Claude Code's status changing (a question, a turn ending) wakes the Claude chats a phone has open", async () => {
  const C = "11111111-2222-4333-8444-555555555555";
  const { sessions, write } = await sessionsWith({ codexList: async () => [] });
  try {
    const waiting = sessions.changes("claude", C, sessions.view("claude", C).version, 25000);
    write({ agent: "claude", kind: "status" });
    const woke = await Promise.race([waiting.then(() => true), new Promise((r) => setTimeout(() => r(false), 500))]);
    assert.equal(woke, true);
  } finally {
    sessions.close();
  }
});

test("a registry write wakes only the open Claude chats whose own status changed, not every open chat each time", async () => {
  const C = "11111111-2222-4333-8444-555555555555";
  const D = "22222222-2222-4333-8444-555555555555";
  let running = new Map([[C, { where: "claude-app", busy: false, waiting: null }], [D, { where: "claude-app", busy: false, waiting: null }]]);
  const { sessions, write } = await sessionsWith({
    codexList: async () => [],
    claude: { list: async () => [], starts: async () => [] },
    live: async () => running,
  });
  const wakes = (ms) =>
    Promise.all(
      [C, D].map((id) =>
        Promise.race([sessions.changes("claude", id, sessions.view("claude", id).version, 25000).then(() => id), new Promise((r) => setTimeout(() => r(null), ms))]),
      ),
    ).then((ids) => ids.filter(Boolean));
  try {
    // First look: both learn where they stand.
    let woke = wakes(300);
    write({ agent: "claude", kind: "status" });
    assert.deepEqual(await woke, [C, D]);
    // Another session on the Mac working: neither open chat changed.
    woke = wakes(300);
    write({ agent: "claude", kind: "status" });
    assert.deepEqual(await woke, []);
    // C turns busy: only C reads again.
    running = new Map([[C, { where: "claude-app", busy: true, waiting: null }], [D, { where: "claude-app", busy: false, waiting: null }]]);
    woke = wakes(300);
    write({ agent: "claude", kind: "status" });
    assert.deepEqual(await woke, [C]);
  } finally {
    sessions.close();
  }
});

test("a question in a chat Reach drives reaches the list with no file written: its host says so", async () => {
  const told = new Set();
  let prompts = [];
  const { sessions } = await sessionsWith({
    codexList: async () => [chat({ status: "running" })],
    codexLive: {
      drives: (id) => id === HELD,
      view: () => ({ status: prompts.length ? "waiting" : "running", prompts }),
      onChange(listener) {
        told.add(listener);
        return () => told.delete(listener);
      },
    },
  });
  try {
    const heard = [];
    sessions.onListChange((revision) => heard.push(revision));
    await until(() => heard.length === 1);
    assert.equal((await sessions.list()).sessions[0].status, "running");
    // Codex asks to run a command: a request on the live protocol, no file.
    prompts = [{ id: "p1", kind: "command", title: "Run it?" }];
    told.forEach((tell) => tell(HELD));
    assert.ok(await until(() => heard.length === 2), "told of the new list");
    const [s] = (await sessions.list()).sessions;
    assert.equal(s.status, "waiting");
    assert.deepEqual(s.prompts, prompts);
  } finally {
    sessions.close();
  }
});

test("everyone asking while a rebuild is on its way gets the kept list: one build per gap; Refresh builds anew", async () => {
  let reads = 0;
  const { sessions, write } = await sessionsWith({ codexList: async () => (reads++, [chat()]), listGapMs: 300 });
  try {
    const heard = [];
    sessions.onListChange((revision) => heard.push(revision));
    await until(() => heard.length === 1);
    const first = reads;
    // Codex writes; phones and notifications ask at once.
    write({ agent: "codex", kind: "history" });
    await Promise.all([sessions.list(), sessions.list(), sessions.list()]);
    assert.equal(reads, first, "no build ahead of the one on its way");
    assert.ok(await until(() => reads === first + 1, 1000), "built once the gap was up");
    // Refresh on the phone: read anew, though nothing said it changed.
    await sessions.list({ fresh: true });
    assert.equal(reads, first + 2);
  } finally {
    sessions.close();
  }
});

test("Claude Code's status changing is read afresh for the list, not from a look a moment old", async () => {
  const C = "11111111-2222-4333-8444-555555555555";
  let busy = true;
  const { sessions, write } = await sessionsWith({
    codexList: async () => [],
    claude: {
      list: async () => [{ agent: "claude", id: C, title: "Fix", cwd: "/work", updatedAt: 1, createdAt: 1, status: "idle", preview: "", archived: false }],
      starts: async () => new Map(),
    },
    live: async () => new Map([[C, { where: "terminal", busy, waiting: false }]]),
    liveMs: 60000,
  });
  try {
    const heard = [];
    sessions.onListChange((revision) => heard.push(revision));
    await until(() => heard.length === 1);
    assert.equal((await sessions.list()).sessions[0].status, "running");
    // Its turn ends: Claude Code's registry says so.
    busy = false;
    write({ agent: "claude", kind: "status" });
    assert.ok(await until(() => heard.length === 2), "told of the new list");
    assert.equal((await sessions.list()).sessions[0].status, "idle");
  } finally {
    sessions.close();
  }
});
