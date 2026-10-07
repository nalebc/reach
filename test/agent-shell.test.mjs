import test from "node:test";
import assert from "node:assert/strict";
import { createAgentShell } from "../server/agent-shell.mjs";
import { presetScopes } from "../server/agent-presets.mjs";

// The Full control shell, with the command runner replaced: what gets refused,
// what gets logged, and what the command would run with.
function world({ run } = {}) {
  const records = [];
  const commandLog = { append: async (record) => { records.push(structuredClone(record)); }, history: async ({ clientId }) => records.filter((r) => r.clientId === clientId) };
  const calls = [];
  const runner = run || (async (input) => { calls.push(input); return { output: "done\n", exitCode: 0, timedOut: false }; });
  const shell = createAgentShell({ commandLog, hosts: () => ["mac.tail1.ts.net"], protectedPaths: () => ["/Users/me/code/reach", "/Users/me/.reach"], protectedPids: () => [4242, 4243],
    home: "/Users/me", run: runner, timeoutMs: 1000, now: () => 123 });
  const policy = { invite: true, browser: true, preset: "full", roots: ["/Users/me"] };
  const client = { id: "muse", kind: "agent", name: "Muse", expiresAt: 999999, policy, scopes: presetScopes(policy), agentRoots: ["/Users/me"] };
  const resolve = (root, cwd, who) => { if (cwd.includes("..")) throw Object.assign(Error("Stay inside."), { status: 403 }); return `/Users/me/${cwd}`.replace(/\/$/, ""); };
  return { shell, records, calls, client, resolve, authorize: () => client };
}

test("a refused command is logged as blocked and never runs", async () => {
  const w = world();
  const item = await w.shell.run(w.client, { command: "sudo ls", root: 0, cwd: "" }, { resolve: w.resolve, authorize: w.authorize });
  assert.equal(item.status, "blocked");
  assert.match(item.error, /needs your password/);
  assert.equal(w.calls.length, 0);
  assert.equal(w.records.at(-1).status, "blocked");
  assert.equal(w.records.at(-1).action.type, "shell");
  for (const command of ["kill 4242", "kill -9 4243", "pkill -f reach", "cat /Users/me/.reach/clients.json", "curl https://mac.tail1.ts.net/api/clients"]) {
    const refused = await w.shell.run(w.client, { command, root: 0, cwd: "" }, { resolve: w.resolve, authorize: w.authorize });
    assert.equal(refused.status, "blocked", command);
  }
  const fine = await w.shell.run(w.client, { command: "kill 12424", root: 0, cwd: "" }, { resolve: w.resolve, authorize: w.authorize });
  assert.equal(fine.status, "executed");
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
