import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/agent-hook.mjs", import.meta.url));
const SESSION = "34ab778a-0bc2-4a3d-a86b-887f8209431d";

// Runs the hook as Claude Code does: its input on stdin, its decision on stdout.
const runHook = (args, input) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ["pipe", "pipe", "pipe"] });
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
    const { code, output } = await runHook(args, input);
    assert.equal(code, 0);
    assert.equal(output, "");
  }
});
