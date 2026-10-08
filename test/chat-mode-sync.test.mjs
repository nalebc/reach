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
    claude: { health: async () => ({ agent: "claude", installed: true, signedIn: true }), read: async () => ({ session, items: [] }) },
    claudeHost: {
      onRelease() {},
      drives: () => !!extra.driving,
      send: async (id, body) => (sent.push(body.mode ?? null), { turnId: null }),
      mode: async (id, mode) => (modes.push(mode), !!extra.driving),
    },
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
