import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installPlan } from "../server/agent-install.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// "Claude Code isn't installed" sent you to a web page to install it on the
// Mac yourself. Now the phone installs it: its maker's own command, shown
// first, run once you confirm, in a Reach terminal that ends with it.
test("each app's own installer, the one this Mac can run", async () => {
  const has = (tools) => async (tool) => tools.includes(tool);
  assert.deepEqual(await installPlan("claude", { has: has([]) }), {
    agent: "claude",
    name: "Claude Code",
    command: "curl -fsSL https://claude.ai/install.sh | bash",
  });
  assert.equal((await installPlan("codex", { has: has(["npm", "brew"]) })).command, "npm install -g @openai/codex");
  assert.equal((await installPlan("codex", { has: has(["brew"]) })).command, "brew install --cask codex");
  await assert.rejects(installPlan("codex", { has: has([]) }), (e) => e.status === 409 && /npm or Homebrew/.test(e.message));
  // Nothing else: no command from the phone, no other app.
  await assert.rejects(installPlan("rm -rf /", { has: has(["npm"]) }), (e) => e.status === 400);
  await assert.rejects(installPlan("gemini", { has: has(["npm"]) }), (e) => e.status === 400);
});

test("installing from the phone: shown first, run once confirmed, the owner's own devices only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-install-"));
  const created = [];
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: { list: async () => ({ sessions: [], errors: {} }), health: async () => [] },
    terminals: {
      create: (options) => (created.push(options), { id: "t1", name: options.name, status: "running" }),
      list: () => [],
      get: () => null,
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["terminal", "files"], "agent");
  const other = reach.auth.issue("linked", ALL_SCOPES, "linked-mac");
  const install = (token, body = {}, app = "claude") =>
    fetch(`${url}/api/sessions/agent-install/${app}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await install(agent.token, { confirm: true })).status, 403);
    assert.equal((await install(other.token, { confirm: true })).status, 403);
    assert.deepEqual(created, []);
    // Shown first: nothing runs.
    const plan = await install(owner.token);
    assert.equal(plan.status, 200);
    assert.deepEqual(await plan.json(), { agent: "claude", name: "Claude Code", command: "curl -fsSL https://claude.ai/install.sh | bash" });
    assert.deepEqual(created, []);
    // Confirmed: in a terminal of its own, which ends with the install.
    const started = await install(owner.token, { confirm: true });
    assert.equal(started.status, 200);
    assert.equal((await started.json()).terminal.id, "t1");
    assert.deepEqual(
      created.map(({ cwd, name, command }) => ({ cwd, name, command })),
      [{ cwd: os.homedir(), name: "Install Claude Code", command: "set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash; exit" }],
    );
    assert.equal((await install(owner.token, { confirm: true }, "anything")).status, 400);
  } finally {
    await new Promise((r) => reach.server.close(r));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an install that can't start answers with why, and Reach keeps running", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-install-fail-"));
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: { list: async () => ({ sessions: [], errors: {} }), health: async () => [] },
    terminals: {
      // The Mac couldn't open a terminal (a shell that won't start, say).
      create: () => {
        throw new Error("posix_spawnp failed.");
      },
      list: () => [],
      get: () => null,
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const install = (body, app = "claude") =>
    fetch(`${url}/api/sessions/agent-install/${app}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const failed = await install({ confirm: true });
    assert.ok(failed.status >= 400);
    assert.equal(typeof (await failed.json()).error, "string");
    // Still answering.
    assert.equal((await install({})).status, 200);
  } finally {
    await new Promise((r) => reach.server.close(r));
    await fs.rm(root, { recursive: true, force: true });
  }
});
