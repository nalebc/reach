import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createClaudeHost } from "../server/agent-sessions/claude-host.mjs";
import { locateClaude } from "../server/agent-sessions/index.mjs";

// The installed Claude Code, asked as Reach asks it: a file write must come to
// Reach as a permission question (can_use_tool), never be denied on its own.
// Claude Code 2.1.291 denied it silently when Reach left out
// --permission-prompt-tool stdio, so the phone was never asked. Uses the real
// CLI and one short model turn: run with `npm run test:claude-native`.
const run = process.env.REACH_TEST_CLAUDE_NATIVE === "1";

test("a file write in a chat Reach runs comes to Reach as a question", { skip: !run && "set REACH_TEST_CLAUDE_NATIVE=1", timeout: 120000 }, async () => {
  const cli = await locateClaude();
  assert.ok(cli, "Claude Code is installed");
  const dir = fs.mkdtempSync(path.join(os.homedir(), ".reach-permission-test-"));
  let args;
  // Reach's own flags, as claude-host.mjs builds them.
  const host = createClaudeHost({
    locate: async () => cli,
    spawn: (file, a, options) => {
      args = a;
      return spawn(file, a, options);
    },
  });
  try {
    const { threadId } = await host.start({ cwd: dir, text: "Create a file named probe.txt containing the letter a. Do nothing else.", mode: "manual", model: "haiku" });
    let view = host.view(threadId);
    for (const until = Date.now() + 90000; Date.now() < until && !view.prompts.length && view.status !== "idle"; await new Promise((r) => setTimeout(r, 300)))
      view = host.view(threadId);
    assert.ok(args.includes("--permission-prompt-tool"), "Reach asks Claude Code for its questions");
    assert.equal(view.status, "waiting", "Claude Code waits for the phone");
    assert.match(JSON.stringify(view.prompts), /probe\.txt/);
    assert.equal(fs.existsSync(path.join(dir, "probe.txt")), false, "nothing written before an answer");
  } finally {
    host.close?.();
    fs.rmSync(dir, { recursive: true, force: true });
    // Its chat too: it would show as a folder to start new chats in.
    const chats = path.join(os.homedir(), ".claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-"));
    fs.rmSync(chats, { recursive: true, force: true });
  }
});
