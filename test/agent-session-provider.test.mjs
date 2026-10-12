import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";

test("unknown and inherited provider names cannot read or send to a Claude chat", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-provider-"));
  const reads = [];
  const sessions = createAgentSessions({
    dataDir,
    daemon: { onNotification() {}, onRequest() {}, onClose() {} },
    codex: {},
    gemini: {},
    claude: { read: async (id) => { reads.push(id); throw Error("unexpected Claude read"); } },
    codexLive: { close() {} },
    claudeHost: { close() {} },
    signIn: {},
  });
  t.after(() => { sessions.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  for (const agent of ["constructor", "__proto__", "toString", "hasOwnProperty", "unknown"]) {
    await assert.rejects(() => sessions.send(agent, "existing-claude-chat", { text: "do not send" }), { status: 404 });
    await assert.rejects(() => sessions.read(agent, "existing-claude-chat"), { status: 404 });
  }
  assert.deepEqual(reads, [], "provider validation happens before touching another agent's session");
});
