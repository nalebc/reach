import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

test("new terminals start only server-known agents, never client commands", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-agents-test-"));
  const asked = [];
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentCommand: async (name) => {
      asked.push(name);
      return name === "codex" ? "echo codex-started" : null;
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const call = async (route, body, method = body ? "POST" : "GET") => {
    const r = await fetch(url + route, {
      method,
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    assert.deepEqual((await call("/api/terminals/agents")).body, {
      agents: ["codex"],
    });
    for (const run of ["rm -rf ~", "toString", "__proto__", 1, { codex: 1 }])
      assert.equal(
        (await call("/api/terminals", { root: 0, run })).status,
        400,
        `run ${JSON.stringify(run)} must be rejected`,
      );
    const missing = await call("/api/terminals", { root: 0, run: "claude" });
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /Claude Code isn't installed/);
    const started = await call("/api/terminals", { root: 0, run: "codex" });
    assert.equal(started.status, 200);
    assert.equal(started.body.name, "Codex");
    await call(`/api/terminals/${started.body.id}`, undefined, "DELETE");
    const plain = await call("/api/terminals", { root: 0 });
    assert.equal(plain.status, 200);
    await call(`/api/terminals/${plain.body.id}`, undefined, "DELETE");
  } finally {
    reach.server.close();
    await reach.close?.();
    // ConPTY may release its final directory handles just after shell exit.
    // Retry only transient filesystem errors, and still fail on a leaked handle.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
