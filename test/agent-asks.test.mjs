import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentAskSocket, createAgentAsks } from "../server/agent-sessions/agent-asks.mjs";

const hookScript = fileURLToPath(new URL("../scripts/agent-hook.mjs", import.meta.url));
const SESSION = "34ab778a-0bc2-4a3d-a86b-887f8209431d";
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw Error("timed out");
    await settle(10);
  }
};
const question = {
  question: "Which database?",
  header: "Database",
  multiSelect: false,
  options: [
    { label: "Postgres", description: "What the app uses" },
    { label: "SQLite", description: "One file" },
  ],
};
// Claude Code running the hook: its input on stdin, its decision on stdout.
function runHook(
  socketPath,
  { agent = "claude", tool_name = "AskUserQuestion", tool_input = { questions: [question] }, session_id = SESSION } = {},
) {
  const child = spawn(process.execPath, [hookScript, agent, socketPath], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve({ code, out })));
  child.stdin.end(
    JSON.stringify({
      session_id,
      transcript_path: "/x.jsonl",
      cwd: "/work",
      permission_mode: "default",
      hook_event_name: "PermissionRequest",
      tool_name,
      tool_input,
    }),
  );
  return { child, exited };
}
async function broker(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-asks-"));
  const mac = { idle: 600 };
  const asks = createAgentAsks({ socketPath: agentAskSocket(dir), idle: async () => mac.idle, everyMs: 15, ...options });
  await asks.listen();
  t.after(() => asks.close());
  return { asks, mac, socketPath: asks.socketPath };
}

test("away from the Mac, Claude's question waits for the phone and the phone's answer is Claude's answer", async (t) => {
  const { asks, socketPath } = await broker(t);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  const hook = runHook(socketPath);
  await waitFor(() => asks.has("claude", SESSION));
  const [prompt] = asks.prompts("claude", SESSION);
  assert.equal(prompt.kind, "question");
  assert.deepEqual(prompt.questions[0].options.map((o) => o.label), ["Postgres", "SQLite"]);
  assert.equal(prompt.input, undefined, "the phone gets the card, not the raw tool input");
  assert.deepEqual(asks.answer("claude", SESSION, prompt.id, { answers: { "Which database?": ["Postgres"] } }), { answered: true });
  const { code, out } = await hook.exited;
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(out), {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: { questions: [question], answers: { "Which database?": "Postgres" } } },
    },
  });
  assert.equal(asks.has("claude", SESSION), false);
  // Once only.
  assert.throws(() => asks.answer("claude", SESSION, prompt.id, { answers: { "Which database?": ["SQLite"] } }), (e) => e.status === 409);
});

test("a permission is allowed with Claude's own input, or denied, and nothing else is offered", async (t) => {
  const { asks, socketPath } = await broker(t);
  const allowed = runHook(socketPath, { tool_name: "Bash", tool_input: { command: "npm test", description: "Run tests" } });
  await waitFor(() => asks.has("claude", SESSION));
  let [prompt] = asks.prompts("claude", SESSION);
  assert.equal(prompt.kind, "tool");
  assert.equal(prompt.command, "npm test");
  assert.deepEqual(prompt.decisions, ["allow", "deny"]);
  assert.throws(() => asks.answer("claude", SESSION, prompt.id, { decision: "allowAlways" }), (e) => e.status === 400);
  asks.answer("claude", SESSION, prompt.id, { decision: "allow" });
  assert.deepEqual(JSON.parse((await allowed.exited).out).hookSpecificOutput.decision, {
    behavior: "allow",
    updatedInput: { command: "npm test", description: "Run tests" },
  });
  const denied = runHook(socketPath, { tool_name: "Bash", tool_input: { command: "rm -rf build" } });
  await waitFor(() => asks.has("claude", SESSION));
  [prompt] = asks.prompts("claude", SESSION);
  asks.answer("claude", SESSION, prompt.id, { decision: "deny" });
  assert.deepEqual(JSON.parse((await denied.exited).out).hookSpecificOutput.decision, {
    behavior: "deny",
    message: "The user declined this from Reach.",
  });
});

test("at the Mac, or the moment someone is back, Claude Code shows its own dialog there", async (t) => {
  const { asks, mac, socketPath } = await broker(t);
  mac.idle = 5;
  const atMac = runHook(socketPath);
  assert.deepEqual(await atMac.exited, { code: 0, out: "" });
  assert.equal(asks.has("claude", SESSION), false);
  // Away: held for the phone; then a key press on the Mac takes it back.
  mac.idle = 600;
  const held = runHook(socketPath, { tool_name: "Edit", tool_input: { file_path: "/work/a.ts" } });
  await waitFor(() => asks.has("claude", SESSION));
  const [prompt] = asks.prompts("claude", SESSION);
  mac.idle = 0;
  assert.deepEqual(await held.exited, { code: 0, out: "" });
  assert.equal(asks.has("claude", SESSION), false);
  assert.throws(() => asks.answer("claude", SESSION, prompt.id, { decision: "allow" }), (e) => e.status === 409 && /Mac/.test(e.message));
  // No reading of the Mac at all: never held.
  const unknown = await broker(t, { idle: async () => null });
  assert.deepEqual(await runHook(unknown.socketPath).exited, { code: 0, out: "" });
});

test("with the session open on the phone, the phone gets it even if the Mac was just used; using the Mac after takes it back", async (t) => {
  const watched = new Set();
  const { asks, mac, socketPath } = await broker(t, { watching: (agent, id) => watched.has(`${agent}:${id}`) });
  mac.idle = 2; // the Mac was used a moment ago
  assert.deepEqual(await runHook(socketPath).exited, { code: 0, out: "" }, "nobody watching: the Mac shows it");
  watched.add(`claude:${SESSION}`);
  const started = Date.now();
  const hook = runHook(socketPath);
  await waitFor(() => asks.has("claude", SESSION));
  // Untouched since: idle keeps growing, the phone keeps it.
  mac.idle = 2 + (Date.now() - started) / 1000 + 0.2;
  await settle(80);
  assert.equal(asks.has("claude", SESSION), true);
  mac.idle = 0.01; // a key press on the Mac
  assert.deepEqual(await hook.exited, { code: 0, out: "" });
  assert.equal(asks.has("claude", SESSION), false);
});

test("a hook that ends (Esc, its timeout, the session closing) takes its prompt off the phone", async (t) => {
  const { asks, socketPath } = await broker(t);
  const versionBefore = asks.version("claude", SESSION);
  const changes = [];
  asks.onChange((agent, id) => changes.push(`${agent}:${id}`));
  const hook = runHook(socketPath);
  await waitFor(() => asks.has("claude", SESSION));
  hook.child.kill("SIGTERM");
  await waitFor(() => !asks.has("claude", SESSION));
  assert.deepEqual(changes, [`claude:${SESSION}`, `claude:${SESSION}`]);
  assert.equal(asks.version("claude", SESSION), versionBefore + 2);
});

test("Reach's own sessions and anything malformed step aside; without Reach the hook steps aside at once", async (t) => {
  const { asks, socketPath } = await broker(t, { skip: (agent, id) => agent === "claude" && id === SESSION });
  assert.deepEqual(await runHook(socketPath).exited, { code: 0, out: "" });
  assert.deepEqual(await runHook(socketPath, { session_id: "../etc" }).exited, { code: 0, out: "" });
  assert.equal(asks.has("claude", SESSION), false);
  const started = Date.now();
  assert.deepEqual(await runHook(path.join(os.tmpdir(), "reach-no-such.sock")).exited, { code: 0, out: "" });
  assert.ok(Date.now() - started < 3000);
});

test("Reach quitting hands every waiting prompt back to the Mac", async (t) => {
  const { asks, socketPath } = await broker(t);
  const hook = runHook(socketPath);
  await waitFor(() => asks.has("claude", SESSION));
  asks.close();
  assert.deepEqual(await hook.exited, { code: 0, out: "" });
  assert.equal(fs.existsSync(socketPath), false);
});

test("Codex's approvals from its app wait for the phone the same way: Yes or No, as Codex asks", async (t) => {
  const { asks, socketPath } = await broker(t);
  const THREAD = "01a10895-1859-7022-8614-f5ef47ab1c66";
  const command = { command: ["npm", "test"], workdir: "/work/site", justification: "Run the tests" };
  const approved = runHook(socketPath, { agent: "codex", session_id: THREAD, tool_name: "shell", tool_input: command });
  await waitFor(() => asks.has("codex", THREAD));
  assert.equal(asks.has("claude", THREAD), false, "kept apart per agent");
  let [prompt] = asks.prompts("codex", THREAD);
  assert.deepEqual(
    { kind: prompt.kind, title: prompt.title, command: prompt.command, cwd: prompt.cwd, reason: prompt.reason, decisions: prompt.decisions },
    { kind: "command", title: "Run this command?", command: "npm test", cwd: "/work/site", reason: "Run the tests", decisions: ["accept", "decline"] },
  );
  assert.throws(() => asks.answer("claude", THREAD, prompt.id, { decision: "accept" }), (e) => e.status === 409);
  asks.answer("codex", THREAD, prompt.id, { decision: "accept" });
  assert.deepEqual(JSON.parse((await approved.exited).out), {
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
  });
  const declined = runHook(socketPath, { agent: "codex", session_id: THREAD, tool_name: "shell", tool_input: command });
  await waitFor(() => asks.has("codex", THREAD));
  [prompt] = asks.prompts("codex", THREAD);
  asks.answer("codex", THREAD, prompt.id, { decision: "decline" });
  assert.deepEqual(JSON.parse((await declined.exited).out).hookSpecificOutput.decision, {
    behavior: "deny",
    message: "The user declined this from Reach.",
  });
  // An agent Reach doesn't know steps aside.
  assert.deepEqual(await runHook(socketPath, { agent: "gemini" }).exited, { code: 0, out: "" });
});

test("prompts of sessions the phone can't show (headless runs, unknown ids) are never held", async (t) => {
  const HEADLESS = "11111111-2222-4333-8444-555555555555";
  const watched = new Set();
  const { asks, socketPath } = await broker(t, {
    shows: async (agent, id) => id !== HEADLESS,
    watching: (agent, id) => watched.has(id),
  });
  // Away from the Mac, yet nobody could answer this one: it goes on at once.
  assert.deepEqual(await runHook(socketPath, { session_id: HEADLESS, tool_name: "Bash", tool_input: { command: "ls" } }).exited, { code: 0, out: "" });
  assert.equal(asks.has("claude", HEADLESS), false);
  // A session open on the phone is shown, whatever else is known about it.
  watched.add(HEADLESS);
  const held = runHook(socketPath, { session_id: HEADLESS, tool_name: "Bash", tool_input: { command: "ls" } });
  await waitFor(() => asks.has("claude", HEADLESS));
  held.child.kill("SIGTERM");
  await held.exited;
  // A failing check counts as not shown.
  const broken = await broker(t, { shows: async () => { throw new Error("ps failed"); } });
  assert.deepEqual(await runHook(broken.socketPath).exited, { code: 0, out: "" });
});

test("a data folder too deep for a socket path gets a stable private one", () => {
  const deep = path.join("/Users/someone", "a".repeat(120));
  assert.equal(agentAskSocket(deep), agentAskSocket(deep));
  assert.ok(Buffer.byteLength(agentAskSocket(deep)) < 104);
  assert.equal(agentAskSocket("/r/.reach/quick"), "/r/.reach/quick/agent-hook.sock");
});
