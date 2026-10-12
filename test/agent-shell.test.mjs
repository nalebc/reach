import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentShell } from "../server/agent-shell.mjs";
import { presetScopes } from "../server/agent-presets.mjs";

// The Full control shell, with the command runner replaced: what gets refused,
// what gets logged, and what the command would run with.
function world({ run, append } = {}) {
  const records = [];
  const commandLog = { append: async (record) => { records.push(structuredClone(record)); await append?.(record); }, history: async ({ clientId }) => records.filter((r) => r.clientId === clientId) };
  const calls = [];
  const runner = run || (async (input) => { calls.push(input); return { output: "done\n", exitCode: 0, timedOut: false }; });
  const shell = createAgentShell({ commandLog, hosts: () => ["mac.tail1.ts.net"], protectedPaths: () => ["/Users/me/code/reach", "/Users/me/.reach"], protectedPids: () => [4242, 4243],
    home: "/Users/me", run: runner, timeoutMs: 1000, now: () => 123 });
  const policy = { invite: true, browser: true, preset: "full", roots: ["/Users/me"] };
  const client = { id: "muse", kind: "agent", name: "Muse", expiresAt: 999999, policy, scopes: presetScopes(policy), agentRoots: ["/Users/me"] };
  const resolve = (root, cwd, who) => { if (cwd.includes("..")) throw Object.assign(Error("Stay inside."), { status: 403 }); return `/Users/me/${cwd}`.replace(/\/$/, ""); };
  return { shell, records, calls, client, resolve, authorize: () => client };
}

test("Full control commands bypass the old deny list and remain logged", async () => {
  const w = world(); // inert runner: none of these commands are executed
  for (const command of ["sudo ls", "kill 4242", "pkill -f reach", "cat /Users/me/.ssh/id_rsa", "cat /Users/me/.reach/clients.json", "curl https://mac.tail1.ts.net/api/clients"]) {
    const item = await w.shell.run(w.client, { command, root: 0, cwd: "" }, { resolve: w.resolve, authorize: w.authorize });
    assert.equal(item.status, "executed", command);
    assert.equal(w.calls.at(-1).command, command);
    assert.equal(w.records.at(-1).status, "executed");
  }
  assert.equal(w.calls.length, 6);
});

test("revocation while the execution log is saving prevents dispatch", async () => {
  let allowed = true;
  const w = world({ append: async (record) => { if (record.status === "executing") allowed = false; } });
  const authorize = () => { if (!allowed) throw Object.assign(Error("Access ended."), { status: 401 }); return w.client; };
  await assert.rejects(w.shell.run(w.client, { command: "echo should-not-run" }, { resolve: w.resolve, authorize }), { status: 401 });
  assert.equal(w.calls.length, 0, "revoked credentials must not start a shell after asynchronous logging");
});

test("revocation aborts a command already in flight and closes its log record", async () => {
  let allowed = true, started;
  const running = new Promise(resolve => { started = resolve; });
  const w = world({ run: ({ signal }) => new Promise(resolve => {
    started();
    // The timeout lets this regression fail cleanly on the old implementation.
    const fallback = setTimeout(() => resolve({ output: "finished without cancellation", exitCode: 0 }), 500);
    signal?.addEventListener("abort", () => { clearTimeout(fallback); resolve({ output: "stopped", exitCode: null }); }, { once: true });
  }) });
  const authorize = () => { if (!allowed) throw Object.assign(Error("Access ended."), { status: 401 }); return w.client; };
  const pending = w.shell.run(w.client, { command: "sleep 5" }, { resolve: w.resolve, authorize });
  const refused = assert.rejects(pending, { status: 401 });
  await running;
  allowed = false;
  await refused;
  assert.equal(w.records.at(-1).status, "revoked");
});

test("a native shell that cannot start fails its log record and releases capacity", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reach-shell-start-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const missing = path.join(directory, "removed-before-spawn");
  const records = [], actions = [];
  const shell = createAgentShell({ home: directory, timeoutMs: 1000,
    commandLog: { append: async item => records.push(item) },
    actions: (...args) => actions.push(args) });
  const policy = { preset: "full", roots: [directory] };
  const client = { id: "native-agent", name: "Native agent", policy,
    expiresAt: Date.now() + 10000, scopes: presetScopes(policy), agentRoots: [directory] };
  // A folder can disappear after path validation. This uses the real OS
  // spawn error; no command can run in the missing working directory.
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(shell.run(client, { command: "echo never-started" },
      { resolve: () => missing, authorize: () => client }), { status: 503 });
  assert.deepEqual(records.map(record => record.status), ["executing", "failed", "executing", "failed"]);
  assert.match(records.at(-1).error, /could not start/);
  assert.equal(actions.length, 0, "no successful action is announced for an unstarted process");
});

test("native shell revocation stops its process group before a later file write", { skip: process.platform !== "darwin", timeout: 10000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "reach-shell-revoke-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const records = [];
  const shell = createAgentShell({ home: directory, timeoutMs: 5000,
    commandLog: { append: async item => records.push(item) } });
  const policy = { preset: "full", roots: [directory] };
  const client = { id: "native-agent", name: "Native agent", policy,
    expiresAt: Date.now() + 10000, scopes: presetScopes(policy), agentRoots: [directory] };
  let allowed = true;
  const authorize = () => { if (!allowed) throw Object.assign(Error("Access ended."), { status: 401 }); return client; };
  const result = shell.run(client, { command: "printf ready > started.txt; /bin/sleep 1; printf forbidden > after.txt" },
    { resolve: () => directory, authorize });
  const refused = assert.rejects(result, { status: 401 });
  const deadline = Date.now() + 3000;
  while (!(await fs.access(path.join(directory, "started.txt")).then(() => true, () => false))) {
    assert.ok(Date.now() < deadline, "the disposable test shell started");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  allowed = false;
  await refused;
  await new Promise(resolve => setTimeout(resolve, 1100));
  await assert.rejects(fs.access(path.join(directory, "after.txt")), { code: "ENOENT" });
  assert.equal(records.at(-1).status, "revoked");
});

test("an allowed command runs in the chosen folder with a clean environment and is logged twice", async () => {
  const w = world();
  const item = await w.shell.run(w.client, { command: "ls -la", root: 0, cwd: "Desktop" }, { resolve: w.resolve, authorize: w.authorize });
  assert.equal(item.status, "executed");
  assert.equal(item.output, "done\n");
  assert.equal(item.exitCode, 0);
  assert.equal(item.directory, "/Users/me/Desktop");
  assert.equal(item.approval, "automatic");
  assert.deepEqual(w.records.map((r) => r.status), ["executing", "executed"]);
  assert.equal(w.calls[0].cwd, "/Users/me/Desktop");
  assert.equal(w.calls[0].command, "ls -la");
  assert.equal(w.calls[0].env.HOME, "/Users/me");
  assert.ok(!Object.keys(w.calls[0].env).some((key) => key.startsWith("REACH_") && key !== "REACH_AGENT"), "none of Reach's own variables");
  assert.ok(!("NODE_OPTIONS" in w.calls[0].env) && !("SSH_AUTH_SOCK" in w.calls[0].env));
  assert.equal(w.calls[0].timeoutMs, 1000);
  const history = await w.shell.history(w.client);
  assert.equal(history.length, 2);
});

test("time limits, bad input, other presets and concurrency", async () => {
  let release;
  const w = world({ run: () => new Promise((resolve) => { release = resolve; }) });
  const first = w.shell.run(w.client, { command: "sleep 5", root: 0, cwd: "" }, { resolve: w.resolve, authorize: w.authorize });
  await new Promise((r) => setTimeout(r, 10));
  await assert.rejects(w.shell.run(w.client, { command: "ls", root: 0, cwd: "" }, { resolve: w.resolve, authorize: w.authorize }), (error) => error.status === 429);
  release({ output: "", exitCode: null, timedOut: true });
  const timed = await first;
  assert.equal(timed.status, "failed");
  assert.match(timed.error, /Stopped after 1 seconds/);
  const bad = (body) => assert.rejects(w.shell.run(w.client, body, { resolve: w.resolve, authorize: w.authorize }), (error) => error.status === 400);
  await bad({ command: "", root: 0 }); await bad({ command: "ls", root: 0, cwd: "", extra: 1 }); await bad({ command: "ls‮", root: 0 }); await bad({ command: "x".repeat(4001), root: 0 });
  await assert.rejects(w.shell.run(w.client, { command: "ls", root: 0, cwd: "../x" }, { resolve: w.resolve, authorize: w.authorize }), (error) => error.status === 403);
  await assert.rejects(w.shell.run(w.client, { command: "ls", root: 3, cwd: "" }, { resolve: w.resolve, authorize: w.authorize }), (error) => error.status === 403);
  const readonly = { ...w.client, policy: { ...w.client.policy, preset: "readonly" }, scopes: presetScopes({ preset: "readonly" }) };
  await assert.rejects(w.shell.run(readonly, { command: "ls", root: 0, cwd: "" }, { resolve: w.resolve, authorize: () => readonly }), (error) => error.status === 403);
});
