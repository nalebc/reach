import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";

for (const guardian of [true, false]) {
  test(`new Codex sessions default to ${guardian ? "automatic review" : "the supported workspace mode"} and preserve explicit choices`, async (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-auto-default-"));
    const started = [];
    const sessions = createAgentSessions({
      dataDir,
      daemon: { onNotification() {}, onRequest() {}, onClose() {} },
      codex: { models: async () => ({ modes: [{ id: "auto" }, ...(guardian ? [{ id: "guardian-approvals" }] : [])] }) },
      codexLive: { start: async (body) => { started.push(body); return { threadId: `thread-${started.length}` }; }, close() {} },
      claudeHost: { close() {} },
      signIn: {},
    });
    t.after(() => { sessions.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
    await sessions.start("codex", { cwd: "/work/app", text: "go" });
    assert.equal(started[0].modeName, guardian ? "guardian-approvals" : "auto");
    assert.equal(started[0].sandbox, "workspace-write");
    assert.equal(started[0].approvalsReviewer, guardian ? "auto_review" : "user");
    for (const settings of [{ modeName: "custom" }, { sandbox: "read-only", approvalPolicy: "on-request" }, { modeName: "full-access" }]) {
      const body = { cwd: "/work/app", text: "go", ...settings };
      await sessions.start("codex", body);
      assert.deepEqual(started.at(-1), body);
    }
  });
}
