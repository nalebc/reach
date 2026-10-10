import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agentAskSocket, createAgentAsks } from "../server/agent-sessions/agent-asks.mjs";
import { askKey } from "../server/agent-sessions/claude-transcript.mjs";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";

const script = fileURLToPath(new URL("../scripts/agent-hook.mjs", import.meta.url));
const SESSION = "34ab778a-0bc2-4a3d-a86b-887f8209431d";

// Runs the hook as Claude Code does: its input on stdin, its decision on stdout.
const runHook = (args, input, env = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) => resolve({ code, output }));
    child.stdin.end(input == null ? "" : JSON.stringify(input));
  });
const request = { hook_event_name: "PermissionRequest", session_id: SESSION, tool_name: "Bash", tool_input: { command: "npm test" } };

test("Reach's hook prints the phone's answer as Claude Code's decision", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-hook-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, "s.sock");
  let asked;
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      asked = JSON.parse(chunk.split("\n")[0]);
      socket.end(`${JSON.stringify({ decision: { behavior: "allow", updatedInput: asked.tool_input } })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => server.close());
  const { code, output } = await runHook(["claude", socketPath], {
    ...request,
    permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  });
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(output), {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { command: "npm test" } } },
  });
  assert.equal(asked.agent, "claude");
  assert.equal(asked.session_id, SESSION);
  assert.deepEqual(asked.permission_suggestions, [{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
});

// Whenever Reach has no answer, Claude Code's own dialog decides: the hook
// prints nothing and exits cleanly.
test("Reach's hook steps aside without Reach, for other agents and other events", async () => {
  for (const [args, input] of [
    [["claude", "/not-a-real-socket"], request],
    [["codex", "/not-a-real-socket"], request],
    [["claude", "/not-a-real-socket"], { ...request, hook_event_name: "PreToolUse" }],
    [["claude", "/not-a-real-socket"], null],
  ]) {
    const { code, output } = await runHook(args, input, { REACH_HOOK_RETRY_MS: "0" });
    assert.equal(code, 0);
    assert.equal(output, "");
  }
});

// "Some permissions not received in Reach": a restart closed the held ask
// with the same empty answer as the Mac's, so the hook stepped aside and the
// new Reach never saw it. Now the hook asks the next Reach again (Claude
// Code's dialog still open), and also waits for a Reach not up yet.
test("a request held for the phone reaches the next Reach after a restart", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-hook-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, "s.sock");
  const until = async (check, ms = 8000) => {
    const end = Date.now() + ms;
    while (!check() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    return check();
  };
  const reach = () => createAgentAsks({ socketPath, everyMs: 20, waiting: async () => true, asking: async () => true });
  const first = reach();
  await first.listen();
  // Reach was there once: a restart's few minutes, not the short wait for a Reach never seen.
  const hook = runHook(["claude", socketPath], request, { REACH_HOOK_RETRY_MS: "20000", REACH_HOOK_AWAY_MS: "500" });
  assert.ok(await until(() => first.has("claude", SESSION)));
  first.close();
  // Down a moment, as during a restart.
  await new Promise((r) => setTimeout(r, 1500));
  const second = reach();
  await second.listen();
  t.after(() => second.close());
  assert.ok(await until(() => second.has("claude", SESSION)), "the new Reach has the request");
  const [prompt] = second.prompts("claude", SESSION);
  second.answer("claude", SESSION, prompt.id, { decision: "allow" });
  const { code, output } = await hook;
  assert.equal(code, 0);
  assert.equal(JSON.parse(output).hookSpecificOutput.decision.behavior, "allow");
});

// Asked again only while Claude Code still waits there: one the Mac answered
// meanwhile isn't shown, and the hook steps aside at once.
test("a request asked again after the Mac answered it steps aside", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-hook-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const socketPath = path.join(dir, "s.sock");
  const hook = runHook(["claude", socketPath], request, { REACH_HOOK_RETRY_MS: "20000" });
  await new Promise((r) => setTimeout(r, 1200));
  const asks = createAgentAsks({ socketPath, everyMs: 20, waiting: async () => true, asking: async () => false });
  await asks.listen();
  t.after(() => asks.close());
  const started = Date.now();
  const { code, output } = await hook;
  assert.equal(code, 0);
  assert.equal(output, "");
  assert.ok(Date.now() - started < 5000);
  assert.equal(asks.has("claude", SESSION), false);
});

// Review (Oct 9): with no Reach at all, every request's hook waited the
// whole three minutes. Never reached: it gives up within moments.
test("a hook that never reached Reach gives up quickly", async () => {
  const started = Date.now();
  const { code, output } = await runHook(["claude", "/not-a-real-socket"], request, { REACH_HOOK_RETRY_MS: "20000", REACH_HOOK_AWAY_MS: "1500" });
  assert.equal(code, 0);
  assert.equal(output, "");
  assert.ok(Date.now() - started < 6000, `took ${Date.now() - started} ms`);
});

// Review (Oct 9): a request asked again after a restart was shown whenever
// Claude Code waited on anything (a dialog of its own, another request).
test("Reach shows a re-asked request only while Claude Code waits on that very permission", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-reask-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let waitingFor = "dialog open";
  let items = [{ id: "toolu_1", role: "tool", status: "running", kind: "command", text: "npm test", key: askKey("Bash", { command: "npm test" }) }];
  const sessions = createAgentSessions({
    dataDir, listenForAsks: true,
    daemon: { close() {}, rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: { list: async () => [], health: async () => ({}) },
    claude: { list: async () => [], starts: async () => [], health: async () => ({}), read: async () => ({ session: { agent: "claude", id: SESSION, cwd: "/p" }, items, before: null }) },
    registry: () => new Map([[SESSION, { where: "claude-app", busy: false, waiting: waitingFor }]]),
    live: async () => new Map([[SESSION, { where: "claude-app", pid: 7, exact: true }]]),
    liveMs: -1,
    claudeHost: { onRelease() {}, drives: () => false, running: () => false, view: () => ({ status: null, version: 0, prompts: [], items: 0 }) },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    macPrompts: { start() {}, close() {}, current: () => ({ prompts: [] }) },
  });
  t.after(() => sessions.close());
  const sock = agentAskSocket(dataDir);
  for (let i = 0; i < 200 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 10));
  const ask = () =>
    new Promise((resolve) => {
      const socket = net.createConnection(sock);
      let reply = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => (reply += chunk));
      socket.on("close", () => resolve(reply));
      socket.on("connect", () => socket.write(`${JSON.stringify({ agent: "claude", session_id: SESSION, tool_name: "Bash", tool_input: { command: "npm test" }, again: true })}\n`));
      setTimeout(() => (socket.destroy(), resolve(null)), 1500);
    });
  // Something else of Claude Code's own open: not this request.
  assert.equal(await ask(), "{}\n");
  // Waiting on a permission, but the running call is another one.
  waitingFor = "permission prompt";
  items = [{ ...items[0], key: askKey("Bash", { command: "rm -rf build" }) }];
  assert.equal(await ask(), "{}\n");
  // That very request: held for the phone.
  items = [{ ...items[0], key: askKey("Bash", { command: "npm test" }) }];
  const held = ask();
  for (let i = 0; i < 100 && !sessions.view("claude", SESSION).prompts.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(sessions.view("claude", SESSION).prompts.length, 1);
  assert.equal(await held, null);
});

// The mode check is a few shell lines: "ask" only for a session with a mode
// waiting (a file named after it), nothing otherwise.
test("Reach's mode hook asks only for a session with a mode waiting", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-modes-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const modeScript = fileURLToPath(new URL("../scripts/agent-mode-hook.sh", import.meta.url));
  const run = (input) =>
    new Promise((resolve) => {
      const child = spawn("/bin/sh", [modeScript, dir], { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (chunk) => (output += chunk));
      child.on("exit", (code) => resolve({ code, output }));
      child.stdin.end(input);
    });
  const call = JSON.stringify({ session_id: SESSION, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.deepEqual(await run(call), { code: 0, output: "" });
  fs.writeFileSync(path.join(dir, SESSION), "default\n");
  const { code, output } = await run(call);
  assert.equal(code, 0);
  assert.equal(JSON.parse(output).hookSpecificOutput.permissionDecision, "ask");
  // Spaced JSON is read too; another session or no input gets nothing.
  assert.equal(JSON.parse((await run(JSON.stringify({ session_id: SESSION }, null, 2))).output).hookSpecificOutput.hookEventName, "PreToolUse");
  assert.deepEqual(await run(call.replace(SESSION, "11111111-2222-4333-8444-555555555555")), { code: 0, output: "" });
  assert.deepEqual(await run(""), { code: 0, output: "" });
});
