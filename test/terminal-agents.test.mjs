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

test("a chat's play button: its command is typed into a new terminal in the chat's folder, which must be shared", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-run-test-"));
  const project = path.join(root, "project");
  await fs.mkdir(project);
  const reach = await createReach({ roots: [root], dataDir: path.join(root, ".reach") });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const call = async (route, body, method = body ? "POST" : "GET") => {
    const r = await fetch(url + route, {
      method,
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  try {
    // Text only, one at a time with an agent never, and only shared folders.
    for (const input of ["", "   ", 5, "echo hi\u0007", "x".repeat(8001)])
      assert.equal((await call("/api/terminals", { cwd: project, input })).status, 400, JSON.stringify(input).slice(0, 20));
    assert.equal((await call("/api/terminals", { cwd: project, input: "ls", run: "codex" })).status, 400);
    assert.equal((await call("/api/terminals", { cwd: os.homedir() === root ? "/" : path.dirname(root), input: "ls" })).status, 403);
    assert.equal((await call("/api/terminals", { cwd: "project", input: "ls" })).status, 403, "a full path only");
    // The shell prints what the command computes, not the typed text.
    const started = await call("/api/terminals", { cwd: project, input: "pwd; echo ran-$((40+2))" });
    assert.equal(started.status, 200);
    let preview = "";
    for (let i = 0; i < 100 && !/ran-42/.test(preview); i++) {
      await new Promise((r) => setTimeout(r, 100));
      const list = (await call("/api/terminals")).body;
      preview = String(list.find((t) => t.id === started.body.id)?.preview ?? "");
    }
    assert.match(preview, /ran-42/);
    await call(`/api/terminals/${started.body.id}`, undefined, "DELETE");
  } finally {
    reach.server.close();
    await reach.close?.();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
