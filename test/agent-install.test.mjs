import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hasCommand, installLock, installPlan, installTerminalCommand } from "../server/agent-install.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// "Claude Code isn't installed" sent you to a web page to install it on the
// Mac yourself. Now the phone installs it: its maker's own command, shown
// first, run once you confirm, in a Reach terminal that ends with it.
test("each app's own installer, the one this Mac can run", async () => {
  const options = (tools) => ({ platform: "darwin", has: async (tool) => tools.includes(tool) });
  assert.deepEqual(await installPlan("claude", options([])), {
    agent: "claude",
    name: "Claude Code",
    command: "curl -fsSL --proto '=https' --tlsv1.2 https://claude.ai/install.sh | bash",
  });
  assert.equal((await installPlan("codex", options(["npm", "brew"]))).command, "npm install -g @openai/codex");
  assert.equal((await installPlan("codex", options(["brew"]))).command, "brew install --cask codex");
  await assert.rejects(installPlan("codex", options([])), (e) => e.status === 409 && /npm or Homebrew/.test(e.message));
  // Nothing else: no command from the phone, no other app.
  await assert.rejects(installPlan("rm -rf /", options(["npm"])), (e) => e.status === 400);
  await assert.rejects(installPlan("gemini", options(["npm"])), (e) => e.status === 400);
  await assert.rejects(installPlan("__proto__", options(["npm"])), (e) => e.status === 400);
});

test("Windows installers use PowerShell and Linux never offers a Homebrew cask", async () => {
  const available = async name => name === "npm";
  const claude = await installPlan("claude", { platform: "win32", has: available });
  assert.equal(claude.command, "irm https://claude.ai/install.ps1 | iex");
  const codex = await installPlan("codex", { platform: "win32", has: available });
  assert.equal(codex.command, "npm.cmd install -g @openai/codex");
  for (const plan of [claude, codex]) {
    const command = installTerminalCommand(plan, "win32");
    assert.match(command, /^\$ErrorActionPreference = 'Stop'; try \{/);
    assert.match(command, /catch \{.*exit 1/);
    assert.doesNotMatch(command, /pipefail|\| bash/);
  }
  assert.match(installTerminalCommand(codex, "win32"), /exit \$LASTEXITCODE/);
  await assert.rejects(installPlan("codex", { platform: "win32", has: async () => false }), error => error.status === 409 && /needs npm/.test(error.message));
  await assert.rejects(installPlan("codex", { platform: "linux", has: async name => name === "brew" }), error => error.status === 409 && !/Homebrew/.test(error.message));
});

test("installer prerequisites are queried using the selected platform's shell", async () => {
  const calls = [];
  const run = async (...args) => { calls.push(args); return { stdout: "C:\\Program Files\\nodejs\\npm.cmd\r\n" }; };
  assert.equal(await hasCommand("npm", run, { platform: "win32", env: {} }), true);
  assert.equal(calls[0][0], "powershell.exe");
  assert.match(calls[0][1].at(-1), /Get-Command -Name 'npm\.cmd'/);
  assert.equal(await hasCommand("npm; anything", run, { platform: "win32" }), false);
  assert.equal(calls.length, 1);
  assert.equal(await hasCommand("npm", async (command, args) => {
    assert.equal(command, "/bin/sh"); assert.deepEqual(args, ["-lc", "command -v npm"]);
    return { stdout: "/usr/bin/npm\n" };
  }, { platform: "linux", env: {} }), true);
});

test("PowerShell installer wrappers preserve success and failure without executing an installer", { skip: process.platform !== "win32" }, () => {
  const node = process.execPath.replaceAll("'", "''");
  // Windows PowerShell 5.1 can take well over ten seconds to start on a busy
  // hosted runner; a timeout here surfaced as a null status, not as a hang.
  for (const [plan, expected] of [
    [{ agent: "claude", command: "Write-Output 'synthetic success'" }, 0],
    [{ agent: "claude", command: "throw 'synthetic failure'" }, 1],
    [{ agent: "codex", command: `& '${node}' -e 'process.exit(23)'` }, 23],
  ]) {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", installTerminalCommand(plan, "win32")], { encoding: "utf8", timeout: 60_000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stderr);
  }
});

test("revocation during asynchronous installer lookup cannot start a terminal", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-install-revoked-"));
  let lookupStarted, finishLookup;
  const started = new Promise(resolve => { lookupStarted = resolve; });
  const release = new Promise(resolve => { finishLookup = resolve; });
  const created = [];
  const reach = await createReach({ roots: [root], dataDir: path.join(root, ".reach"), screen: false,
    agentInstallPlan: async agent => { lookupStarted(); await release; return { agent, name: "Codex", command: "synthetic-installer-never-run" }; },
    terminals: { create: options => { created.push(options); return { id: "forbidden" }; }, list: () => [], get: () => null, dispose: () => {} },
  });
  t.after(async () => { finishLookup(); await reach.close(); await fs.rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  const owner = reach.auth.issue("Owner", ALL_SCOPES);
  const result = fetch(`http://127.0.0.1:${reach.server.address().port}/api/sessions/agent-install/codex`, {
    method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
  });
  await started;
  reach.auth.revoke(owner.clientId);
  finishLookup();
  assert.equal((await result).status, 401);
  assert.deepEqual(created, []);
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
      dispose: () => {},
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
    const expectedPlan = { agent: "claude", name: "Claude Code", command: process.platform === "win32" ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL --proto '=https' --tlsv1.2 https://claude.ai/install.sh | bash" };
    assert.deepEqual(await plan.json(), expectedPlan);
    assert.deepEqual(created, []);
    // Confirmed: in a terminal of its own, which ends with the install.
    const started = await install(owner.token, { confirm: true });
    assert.equal(started.status, 200);
    assert.equal((await started.json()).terminal.id, "t1");
    assert.deepEqual(
      created.map(({ cwd, name, command }) => ({ cwd, name, command })),
      [{ cwd: os.homedir(), name: "Install Claude Code", command: installTerminalCommand(expectedPlan) }],
    );
    assert.equal((await install(owner.token, { confirm: true }, "anything")).status, 400);
  } finally {
    await reach.close();
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
      dispose: () => {},
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
    // The install lock let go: a retry isn't "already installing".
    assert.notEqual((await install({ confirm: true })).status, 409);
    // Still answering.
    assert.equal((await install({})).status, 200);
  } finally {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// OpenClaw 2026.9 refuses Node older than 24.16: its npm install runs with
// Homebrew's node@24 first on PATH, and the phone never sees that shell text.
test("OpenClaw installs under Homebrew's node@24 when the Mac has it", async () => {
  const runtime = "/opt/homebrew/opt/node@24/bin/node";
  const plan = await installPlan("openclaw", { platform: "darwin", has: async (tool) => tool === "npm", findRuntime: async () => runtime });
  assert.equal(plan.command, "npm install -g openclaw@latest");
  assert.equal(installTerminalCommand(plan, "darwin"),
    "set -o pipefail; export PATH='/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin':\"$PATH\"; npm install -g openclaw@latest; exit");
  // Without node@24, or for another app, nothing is added.
  const plain = await installPlan("openclaw", { platform: "darwin", has: async (tool) => tool === "npm", findRuntime: async () => null });
  assert.equal(plain.lead, undefined);
  assert.equal(installTerminalCommand(plain, "darwin"), "set -o pipefail; npm install -g openclaw@latest; exit");
  const codex = await installPlan("codex", { platform: "darwin", has: async () => true, findRuntime: async () => runtime });
  assert.equal(codex.lead, undefined);
});

test("one install per app at a time: planning or a running terminal holds it", () => {
  const status = new Map();
  const lock = installLock((id) => status.get(id) !== "exited");
  assert.equal(lock.take("openclaw"), true);
  assert.equal(lock.take("openclaw"), false); // still being planned
  assert.equal(lock.take("codex"), true); // another app is its own
  lock.release("codex");
  lock.started("openclaw", "t1");
  status.set("t1", "running");
  assert.equal(lock.take("openclaw"), false);
  status.set("t1", "exited");
  assert.equal(lock.take("openclaw"), true);
});

test("two phones confirming the same install at once: only one terminal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-install-lock-"));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const created = [];
  const reach = await createReach({
    roots: [root], dataDir: path.join(root, ".reach"), screen: false,
    agentSessions: { list: async () => ({ sessions: [], errors: {} }), health: async () => [] },
    agentInstallPlan: async (agent) => { await gate; return { agent, name: "OpenClaw", command: "synthetic-installer-never-run", lead: "export PATH='/x':\"$PATH\"" }; },
    terminals: {
      create: (options) => (created.push(options), { id: `t${created.length}`, status: "running" }),
      list: () => [], get: (id) => ({ id, status: "running" }), dispose: () => {},
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const install = (body) => fetch(`http://127.0.0.1:${reach.server.address().port}/api/sessions/agent-install/openclaw`, {
    method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const first = install({ confirm: true });
    const second = await install({ confirm: true });
    assert.equal(second.status, 409);
    release();
    const done = await first;
    assert.equal(done.status, 200);
    const body = await done.json();
    assert.equal(body.lead, undefined); // shell text stays on the Mac
    assert.equal(created.length, 1);
    assert.match(created[0].command, /^set -o pipefail; export PATH='\/x'/);
    // Its terminal still runs: a third confirm waits too; showing the plan doesn't.
    assert.equal((await install({ confirm: true })).status, 409);
    assert.equal((await install({})).status, 200);
  } finally {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
