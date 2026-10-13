import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

test("new Codex chats and permission changes accept read-only and named profiles from the model menu", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-chat-permissions-"));
  const starts = [], changes = [];
  const reach = await createReach({
    roots: [root], dataDir: path.join(root, "private"),
    agentSessions: {
      list: async () => ({ sessions: [], errors: {} }), health: async () => [],
      start: async (agent, body) => { starts.push({ agent, ...body }); return { threadId: "fixture" }; },
      mode: async (agent, id, body) => { changes.push({ agent, id, ...body }); return { ...body, applied: true }; },
    },
  });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await reach.close(); await fs.rm(root, { recursive: true, force: true }); });
  const owner = reach.auth.issue("Owner", ALL_SCOPES);
  const post = (route, body) => fetch(`http://127.0.0.1:${reach.server.address().port}${route}`, {
    method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  for (const mode of ["read-only", "profile:network-only", "profile::restricted"]) {
    const response = await post("/api/sessions", { agent: "codex", cwd: os.homedir(), text: "hello", mode });
    assert.equal(response.status, 200, `${mode}: ${await response.text()}`);
    assert.equal(starts.at(-1).modeName, mode);
    const changed = await post("/api/sessions/codex/fixture/mode", { mode });
    assert.equal(changed.status, 200, mode);
    assert.equal(changes.at(-1).mode, mode);
  }
  assert.equal(starts[0].sandbox, "read-only");
  for (const mode of ["__proto__", "profile:", "profile:bad/name", "profile:" + "x".repeat(81), ["read-only"]]) {
    assert.equal((await post("/api/sessions", { agent: "codex", cwd: os.homedir(), text: "hello", mode })).status, 400);
    assert.equal((await post("/api/sessions/codex/fixture/mode", { mode })).status, 400);
  }
  assert.equal(starts.length, 3);
  assert.equal(changes.length, 3);
});
