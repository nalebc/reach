import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";
import { createChatModes } from "../server/agent-sessions/chat-modes.mjs";

// A Codex chat started from the phone in "Ask for approval" went on, at its
// next message, in the Codex app's current mode ("Approve for me"): Codex's
// reviewer then approved network access without asking. A chat keeps the
// mode it was given from Reach; one Reach never set follows the Codex app.
const A = "01a10895-1859-7022-8614-f5ef47ab1c66";
const B = "01a10895-1859-7022-8614-f5ef47ab1c99";
const sessionsWith = (chatModes) => {
  const sent = [];
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: {
      appMode: () => "guardian-approvals",
      read: async (id) => ({ session: { agent: "codex", id, mode: "guardian-approvals" }, items: [], before: null }),
    },
    codexLive: {
      start: async () => ({ threadId: A, turnId: "t0" }),
      send: async (id, body) => (sent.push([id, body.mode]), { turnId: "t1" }),
      drives: () => false,
    },
    claude: {},
    claudeHost: { onRelease() {} },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} },
    chatModes,
  });
  return { sessions, sent };
};

test("a Codex chat keeps the mode it started in, shows it, and keeps it after a restart", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-modes-"));
  const file = path.join(dir, "codex-modes.json");
  try {
    let { sessions, sent } = sessionsWith(createChatModes({ file }));
    await sessions.start("codex", { cwd: "/work", text: "hi", approvalPolicy: "on-request", approvalsReviewer: "user", modeName: "auto" });
    await sessions.send("codex", A, { text: "run curl" });
    assert.deepEqual(sent, [[A, "auto"]]);
    assert.equal((await sessions.read("codex", A, { limit: 1 })).session.mode, "auto");
    // Picked another from its settings: that one from now on.
    await sessions.send("codex", A, { text: "go", mode: "full-access" });
    await sessions.send("codex", A, { text: "and again" });
    assert.deepEqual(sent.slice(1), [[A, "full-access"], [A, "full-access"]]);
    sessions.close();
    // Reach restarts: the chat still has its own.
    ({ sessions, sent } = sessionsWith(createChatModes({ file })));
    await sessions.send("codex", A, { text: "after restart" });
    assert.deepEqual(sent, [[A, "full-access"]]);
    sessions.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a Codex chat Reach never set follows the Codex app's current mode, as from the app", async () => {
  const { sessions, sent } = sessionsWith(createChatModes());
  await sessions.send("codex", B, { text: "hi" });
  assert.deepEqual(sent, [[B, "guardian-approvals"]]);
  assert.equal((await sessions.read("codex", B, { limit: 1 })).session.mode, "guardian-approvals");
  sessions.close();
});
