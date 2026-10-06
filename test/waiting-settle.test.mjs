import test from "node:test";
import assert from "node:assert/strict";

// "Codex needs your answer" reached the phone, with the Needs you sheet, and
// was gone at once (2026-10-06): agents mark a chat waiting for a moment
// while they decide by themselves (Codex's "Approve for me" reviewer, a
// command a saved rule allows). Only a chat that stays waiting is waiting on
// you; prompts in chats Reach drives are real requests and count at once.
const HELD = "01a10f85-c2e3-7f51-a438-9827fd38e5d9";
const DRIVEN = "01a10f86-c2e3-7f51-a438-9827fd38e5d9";
const chat = (id, extra = {}) => ({
  agent: "codex",
  id,
  title: "Redesign invite someone UI",
  cwd: "/work",
  branch: "",
  origin: "app",
  inApp: true,
  updatedAt: Date.now(),
  createdAt: Date.now(),
  status: "waiting",
  preview: "",
  archived: false,
  ...extra,
});
const asking = { kind: "permission", text: "Finish plain-language permission labels" };

const sessionsWith = async (settleMs) => {
  const { createAgentSessions } = await import("../server/agent-sessions/index.mjs");
  return createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: {
      list: async () => [chat(HELD), chat(DRIVEN)],
      projects: async () => [],
      read: async (id) => ({ session: chat(id, { asking }), items: [], before: null }),
    },
    codexLive: {
      drives: (id) => id === DRIVEN,
      view: () => ({ status: "waiting", prompts: [{ id: "p1", kind: "command", title: "Run it?" }] }),
    },
    claude: { list: async () => [] },
    gemini: { list: async () => [] },
    live: async () => new Map(),
    claudeHost: { onRelease() {}, running: () => false, drives: () => false },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} },
    settleMs,
  });
};
const status = async (sessions) =>
  Object.fromEntries((await sessions.list()).sessions.map((s) => [s.id === HELD ? "held" : "driven", s.status]));

test("a chat flagged waiting for a moment isn't waiting on you; one that stays is", async () => {
  const sessions = await sessionsWith(120);
  try {
    // Just flagged: shown as working, and nothing asks you yet.
    assert.deepEqual(await status(sessions), { held: "running", driven: "waiting" });
    const first = await sessions.read("codex", HELD);
    assert.equal(first.session.status, "running");
    assert.equal(first.session.asking, undefined);
    // Still waiting a while later: waiting on you, with what it asks.
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(await status(sessions), { held: "waiting", driven: "waiting" });
    assert.deepEqual((await sessions.read("codex", HELD)).session.asking, asking);
  } finally {
    sessions.close();
  }
});

// A Codex request read from its chat's file has already waited out a longer
// settle there (codex-asks.mjs): held back a second time, a real approval
// reached the phone about 16 s after it was asked instead of 10 s.
test("a chat that says since when it waits is counted from then, not held back again", async () => {
  const { createAgentSessions } = await import("../server/agent-sessions/index.mjs");
  const NEW = "01a10f87-c2e3-7f51-a438-9827fd38e5d9";
  const asked = { [HELD]: Date.now() - 10000, [NEW]: Date.now() - 1000 };
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: {
      list: async () => [chat(HELD, { waitingSince: asked[HELD] }), chat(NEW, { waitingSince: asked[NEW] })],
      projects: async () => [],
      read: async (id) => ({ session: chat(id, { asking, waitingSince: asked[id] }), items: [], before: null }),
    },
    codexLive: { drives: () => false, view: () => ({ status: "idle", prompts: [] }) },
    claude: { list: async () => [] },
    gemini: { list: async () => [] },
    live: async () => new Map(),
    claudeHost: { onRelease() {}, running: () => false, drives: () => false },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} },
    settleMs: 6000,
  });
  try {
    const listed = Object.fromEntries((await sessions.list()).sessions.map((s) => [s.id, s.status]));
    // Asked 10 s ago: waiting on you now. Asked a second ago: not yet.
    assert.deepEqual(listed, { [HELD]: "waiting", [NEW]: "running" });
    assert.deepEqual((await sessions.read("codex", HELD)).session.asking, asking);
    assert.equal((await sessions.read("codex", NEW)).session.asking, undefined);
  } finally {
    sessions.close();
  }
});
