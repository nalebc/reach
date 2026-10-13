import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

test("reply permission modes reject inherited provider names before a provider is called", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-reply-provider-"));
  const sent = [];
  const reach = await createReach({
    roots: [root], dataDir: path.join(root, "private"), screen: false,
    agentSessions: { send: async (...args) => { sent.push(args); return { queued: true }; } },
  });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { reach.server.closeAllConnections(); await reach.close(); await fs.rm(root, { recursive: true, force: true }); });
  const owner = reach.auth.issue("Owner", ALL_SCOPES);
  const post = agent => fetch(`http://127.0.0.1:${reach.server.address().port}/api/sessions/${agent}/synthetic/messages`, {
    method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Synthetic message", mode: "auto" }),
  });
  for (const agent of ["constructor", "__proto__", "toString", "hasOwnProperty", "unknown"]) {
    const response = await post(agent);
    assert.equal(response.status, 400, agent);
    assert.match((await response.json()).error, /permission mode/);
  }
  assert.deepEqual(sent, []);
  assert.equal((await post("codex")).status, 200);
  assert.equal((await post("claude")).status, 200);
  assert.deepEqual(sent.map(([agent]) => agent), ["codex", "claude"]);
});
