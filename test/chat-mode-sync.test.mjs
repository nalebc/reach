import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";
import { createChatModes } from "../server/agent-sessions/chat-modes.mjs";
import { createClaudeSessions } from "../server/agent-sessions/claude.mjs";

// "I keep getting asked to approve even on Auto": a Claude chat Reach resumed
// (a message from the phone while the Claude app didn't have it) started
// Claude Code with no --permission-mode, so it fell back to Manual and asked
// about everything. A mode picked on the phone also only went with the next
// message from that phone.
const ID = "11111111-2222-4333-8444-555555555555";
const CODEX = "01a10895-1859-7022-8614-f5ef47ab1c66";
const at = new Date().toISOString();

test("a Claude chat's own mode is read from its latest message when the app doesn't have it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-mode-"));
  const projects = path.join(root, "projects", "-work-app");
  await fs.mkdir(projects, { recursive: true });
  const line = (o) => JSON.stringify({ cwd: "/work/app", sessionId: ID, timestamp: at, ...o });
  await fs.writeFile(
    path.join(projects, `${ID}.jsonl`),
    [
      line({ type: "user", uuid: "u1", permissionMode: "default", message: { role: "user", content: "first" } }),
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
      line({ type: "user", uuid: "u2", parentUuid: "a1", permissionMode: "auto", message: { role: "user", content: "second" } }),
    ].join("\n") + "\n",
  );
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records") });
  assert.equal((await claude.read(ID, { limit: 1 })).session.mode, "auto");
  await fs.rm(root, { recursive: true, force: true });
});

const claudeWith = (session, extra = {}) => {
  const sent = [];
  const modes = [];
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: {},
    codexLive: { drives: () => false },
    claude: { health: async () => ({ agent: "claude", installed: true, signedIn: true }), read: async () => ({ session, items: [] }), ...extra.claude },
    claudeHost: {
      onRelease() {},
      drives: () => !!extra.driving,
      send: async (id, body) => (sent.push(body.mode ?? null), { turnId: null }),
      mode: async (id, mode) => (modes.push(mode), !!extra.driving),
      ...extra.host,
    },
    ...(extra.live ? { live: extra.live, liveMs: -1 } : {}),
    signIn: {},
    ...(extra.claudeCompose ? { claudeCompose: extra.claudeCompose } : {}),
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: extra.agentAsks || { close() {} },
    processes: async () => [],
  });
  return { sessions, sent, modes };
};

test("a Claude chat Reach resumes keeps its own mode (Auto stays Auto); a pick still wins", async () => {
  const { sessions, sent } = claudeWith({ agent: "claude", id: ID, cwd: "/work/app", inApp: false, mode: "auto" });
  await sessions.send("claude", ID, { text: "go on" });
  await sessions.send("claude", ID, { text: "carefully", mode: "plan" });
  assert.deepEqual(sent, ["auto", "plan"]);
  sessions.close();
});

test("a mode picked on the phone for a chat Reach runs changes its Claude Code at once", async () => {
  const { sessions, modes } = claudeWith({ agent: "claude", id: ID, cwd: "/work/app", inApp: false, mode: "default" }, { driving: true });
  assert.deepEqual(await sessions.mode("claude", ID, { mode: "auto" }), { mode: "auto", applied: true });
  assert.deepEqual(modes, ["auto"]);
  sessions.close();
});

// "Changing permission no longer works in this chat": a chat in the Claude
// app but not on its screen refused the pick, so the phone dropped it.
// A Claude app chat's mode is never picked in the app's menu: Claude Code
// takes it with the next request the phone allows there (its hook's setMode).
test("a Claude app chat's mode goes with Claude Code's next request, never through the app's menu", async () => {
  const session = { agent: "claude", id: ID, cwd: "/work/app", inApp: true, appTitle: "Chat", mode: "default" };
  const queued = [];
  const clicked = [];
  const { sessions } = claudeWith(session, {
    claudeCompose: { mode: async (...a) => clicked.push(a) },
    agentAsks: { close() {}, queueMode: (...a) => queued.push(a) },
  });
  assert.deepEqual(await sessions.mode("claude", ID, { mode: "auto" }), { mode: "auto", applied: false, next: "request" });
  assert.deepEqual(await sessions.mode("claude", ID, { mode: "manual" }), { mode: "manual", applied: false, next: "request" });
  assert.deepEqual(queued, [["claude", ID, "auto"], ["claude", ID, "default"]]);
  assert.deepEqual(clicked, []);
  sessions.close();
});

test("a Codex mode picked on the phone is kept at once: the chat's next message from Reach goes in it", async () => {
  const sent = [];
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: { appMode: () => "auto", read: async (id) => ({ session: { agent: "codex", id, mode: "auto" }, items: [], before: null }) },
    codexLive: { mode: async (id, mode) => ({ mode, applied: true }), send: async (id, body) => (sent.push(body.mode), { turnId: "t" }), drives: () => false },
    claude: {},
    claudeHost: { onRelease() {} },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} },
    chatModes: createChatModes(),
  });
  assert.deepEqual(await sessions.mode("codex", CODEX, { mode: "guardian-approvals" }), { mode: "guardian-approvals", applied: true });
  await sessions.send("codex", CODEX, { text: "hi" });
  assert.deepEqual(sent, ["guardian-approvals"]);
  assert.equal((await sessions.read("codex", CODEX, { limit: 1 })).session.mode, "guardian-approvals");
  sessions.close();
});

test("rejected Codex settings and sends preserve the confirmed mode; native changes update it", async (t) => {
  const modes = createChatModes();
  modes.set(CODEX, "auto");
  let changed, nativeMode = "auto";
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: {}, claude: {}, claudeHost: { onRelease() {} }, signIn: {},
    claudeImports: { add: async () => {}, close() {} }, agentAsks: { close() {} },
    chatModes: modes,
    codexLive: {
      drives: () => false, onChange: (listener) => { changed = listener; }, currentMode: () => nativeMode,
      mode: async () => { throw Error("Setting rejected"); },
      send: async () => { throw Error("Send rejected"); },
    },
  });
  t.after(() => sessions.close());
  await assert.rejects(sessions.mode("codex", CODEX, { mode: "full-access" }), /Setting rejected/);
  assert.equal(modes.get(CODEX), "auto");
  await assert.rejects(sessions.send("codex", CODEX, { text: "hello", mode: "full-access" }), /Send rejected/);
  assert.equal(modes.get(CODEX), "auto");
  nativeMode = "guardian-approvals";
  changed(CODEX);
  assert.equal(modes.get(CODEX), "guardian-approvals");
});

// "Mode changes don't take effect": a pick queued for Claude Code's next
// request in another app stayed queued when Reach ran the next turn itself
// (the app closed, a terminal chat), which went in the old mode while the
// PreToolUse hook made each of its steps ask.
test("a turn Reach runs itself goes in a mode queued for the chat, and takes it", async () => {
  for (const session of [
    { agent: "claude", id: ID, cwd: "/work/app", inApp: false, mode: "plan" },
    { agent: "claude", id: ID, cwd: "/work/app", inApp: true, appTitle: "Chat", mode: "plan" },
  ]) {
    let queued = "acceptEdits";
    const { sessions, sent } = claudeWith(session, {
      agentAsks: { close() {}, queuedMode: () => queued, clearMode: () => (queued = null) },
    });
    await sessions.send("claude", ID, { text: "go on" });
    assert.deepEqual(sent, ["acceptEdits"]);
    assert.equal(queued, null);
    sessions.close();
  }
  // Manual waits as Claude Code's "default": it runs as Manual.
  let queued = "default";
  const { sessions, sent } = claudeWith({ agent: "claude", id: ID, cwd: "/work/app", inApp: false, mode: "auto" }, {
    agentAsks: { close() {}, queuedMode: () => queued, clearMode: () => (queued = null) },
  });
  await sessions.send("claude", ID, { text: "go on" });
  assert.deepEqual(sent, ["manual"]);
  sessions.close();
});

// Review (Oct 9): the queued pick was let go of as soon as Reach accepted a
// message, though it waited in the outbox (the app busy) or was taken back:
// the app's next request went without it. Kept until Reach's own Claude
// Code really runs it.
test("a mode queued for the chat stays queued while its message waits, until Reach runs it", async () => {
  let queued = "acceptEdits";
  let holders = new Map([[ID, { where: "claude-app", pid: 7, exact: true, busy: true, waiting: null }]]);
  const sent = [];
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: {},
    codexLive: { drives: () => false },
    claude: { starts: async () => [], health: async () => ({ agent: "claude", installed: true, signedIn: true }), read: async () => ({ session: { agent: "claude", id: ID, cwd: "/work/app", inApp: false, mode: "plan" }, items: [] }) },
    claudeHost: { onRelease() {}, drives: () => false, send: async (id, body) => (sent.push([body.mode, queued]), { turnId: null }) },
    live: async () => holders,
    liveMs: -1,
    queueMs: 20,
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {}, queuedMode: () => queued, clearMode: () => (queued = null) },
    processes: async () => [],
  });
  try {
    const first = await sessions.send("claude", ID, { text: "go on" });
    assert.equal(first.queued, true);
    assert.equal(queued, "acceptEdits");
    // Taken back: the pick still waits for the app's next request.
    await sessions.cancelQueued("claude", ID, first.messageId);
    assert.equal(queued, "acceptEdits");
    await sessions.send("claude", ID, { text: "go on" });
    assert.equal(queued, "acceptEdits");
    // The app let go: Reach runs it, in the pick, and takes it then.
    holders = new Map();
    for (let i = 0; i < 200 && !sent.length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(sent, [["acceptEdits", null]]);
    assert.equal(queued, null);
  } finally {
    sessions.close();
  }
});

// Review (Oct 9): already in the mode Reach's Claude Code would run it in,
// an older pick queued for the app's next request stayed and went in later.
test("a mode that's already in lets go of an older queued one", async () => {
  let queued = "plan";
  const { sessions } = claudeWith({ agent: "claude", id: ID, cwd: "/work/app", inApp: false, mode: "default" }, {
    host: { mode: async () => false, modeOf: () => "auto" },
    claude: { starts: async () => [] },
    live: async () => new Map(),
    agentAsks: { close() {}, queuedMode: () => queued, clearMode: () => (queued = null), queueMode: () => {} },
  });
  assert.deepEqual(await sessions.mode("claude", ID, { mode: "auto" }), { mode: "auto", applied: true });
  assert.equal(queued, null);
  sessions.close();
});

// A chat Reach ran and let go of between turns, nobody else holding it:
// Reach runs its next turn in the pick, so it's in now, not queued for a
// hook that would only make Reach's own run ask at every step.
test("a mode picked for a chat Reach runs next is in at once, not queued", async () => {
  const queued = [];
  let kept = null;
  const extra = {
    host: { mode: async (id, mode) => ((kept = mode), false), modeOf: () => kept },
    claude: { starts: async () => [] },
    agentAsks: { close() {}, queueMode: (...a) => queued.push(a) },
  };
  let { sessions } = claudeWith({ agent: "claude", id: ID, cwd: "/work/app", inApp: false, mode: "default" }, { ...extra, live: async () => new Map() });
  assert.deepEqual(await sessions.mode("claude", ID, { mode: "auto" }), { mode: "auto", applied: true });
  assert.deepEqual(queued, []);
  sessions.close();
  // Open in a terminal now: that Claude Code takes it with its next request.
  ({ sessions } = claudeWith({ agent: "claude", id: ID, cwd: "/work/app", inApp: false, mode: "default" }, {
    ...extra,
    live: async () => new Map([[ID, { where: "terminal", pid: 7, exact: true }]]),
  }));
  assert.deepEqual(await sessions.mode("claude", ID, { mode: "plan" }), { mode: "plan", applied: false, next: "request" });
  assert.deepEqual(queued, [["claude", ID, "plan"]]);
  sessions.close();
});

// "Mode changes don't stick": a plan approved into Manual on the phone went
// back to Plan once the Claude app took the chat (it adopts the transcript's
// mode, and the switch is in no line of it). Released, the mode Reach's
// Claude Code was in goes with Claude Code's next request there.
test("a mode Reach's Claude Code switched to goes with the chat into the Claude app", async () => {
  for (const [shown, expected] of [["plan", [["claude", ID, "default"]]], ["default", []]]) {
    let release;
    const queued = [];
    const { sessions } = claudeWith({ agent: "claude", id: ID, cwd: "/work/app", inApp: true, appTitle: "Chat", mode: shown }, {
      host: { onRelease: (listener) => (release = listener), modeOf: () => "default" },
      agentAsks: { close() {}, queueMode: (...a) => queued.push(a) },
    });
    release(ID, { wrote: false });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(queued, expected, shown);
    sessions.close();
  }
});
