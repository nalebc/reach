import test from "node:test";
import assert from "node:assert/strict";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";

// New Claude chats failed with "Claude Code is signed out" while it was signed
// in: on a busy Mac `claude auth status` passed its 10 s limit, and "couldn't
// read the status" counted as signed out. Only a definite signed out stops it.
const sessionsWith = (health) => {
  const started = [];
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: {},
    codexLive: { drives: () => false },
    claude: { health: async () => health },
    claudeHost: { onRelease() {}, start: async (body) => (started.push(body.text), { threadId: "t", turnId: null }), drives: () => false },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} },
  });
  return { sessions, started };
};

test("a slow sign-in check doesn't stop a new Claude chat", async () => {
  const { sessions, started } = sessionsWith({ agent: "claude", installed: true, signedIn: false, error: "Could not read Claude Code's sign-in status." });
  await sessions.start("claude", { cwd: "/work", text: "hi" });
  assert.deepEqual(started, ["hi"]);
  sessions.close();
});

test("a definite signed out still says so before starting", async () => {
  const { sessions, started } = sessionsWith({ agent: "claude", installed: true, signedIn: false, usable: false });
  await assert.rejects(sessions.start("claude", { cwd: "/work", text: "hi" }), /signed out on your Mac/);
  assert.deepEqual(started, []);
  sessions.close();
});

test("signed in is asked once, not before every message (Claude Code takes ~6 s to answer); signed out is asked again", async () => {
  let asked = 0;
  let health = { agent: "claude", installed: true, signedIn: true };
  const started = [];
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: {},
    codexLive: { drives: () => false },
    claude: { health: async () => (asked++, health) },
    claudeHost: { onRelease() {}, start: async (body) => (started.push(body.text), { threadId: "t", turnId: null }), drives: () => false },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} },
  });
  await sessions.start("claude", { cwd: "/work", text: "one" });
  await sessions.start("claude", { cwd: "/work", text: "two" });
  assert.equal(asked, 1);
  assert.deepEqual(started, ["one", "two"]);
  sessions.close();
  // Signed out isn't kept: the next try asks again.
  asked = 0;
  health = { agent: "claude", installed: true, signedIn: false };
  const out = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: {},
    codexLive: { drives: () => false },
    claude: { health: async () => (asked++, health) },
    claudeHost: { onRelease() {}, start: async () => ({ threadId: "t", turnId: null }), drives: () => false },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} },
  });
  await assert.rejects(out.start("claude", { cwd: "/work", text: "a" }));
  await assert.rejects(out.start("claude", { cwd: "/work", text: "b" }));
  assert.equal(asked, 2);
  out.close();
});
