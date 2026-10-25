import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createClaudeCompose } from "../server/agent-sessions/claude-compose.mjs";
import { createClaudeSessions } from "../server/agent-sessions/claude.mjs";
import { createOutbox } from "../server/agent-sessions/outbox.mjs";

// Four messages queued from the phone took 13 to 24 s each to go into the
// Claude app (2026-10-05): after one went in, the next still carried the
// reason from an earlier failed try and waited 5 s on it; and one with a
// picture waited the full 10 s for a confirmation that couldn't come (the
// app queues a picture message with no text).
const A = "11111111-2222-4333-8444-555555555555";
const line = (o) => JSON.stringify(o);

test("after a message goes in, the next one goes on the usual beat, not 5 s later", async () => {
  const { createAgentSessions } = await import("../server/agent-sessions/index.mjs");
  const outbox = createOutbox();
  outbox.add(A, { text: "first", via: "app", title: "Fix" });
  const second = outbox.add(A, { text: "second", via: "app", title: "Fix" });
  // It couldn't go before: another chat was on screen then.
  outbox.problem(A, second.id, "The Claude app is showing another chat.");
  const sent = [];
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: {},
    codexLive: { drives: () => false },
    claude: {},
    claudeHost: { onRelease() {} },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} },
    outbox,
    queueMs: 10,
    // The Claude app's window helper is the Mac's (no Windows twin yet): modeled on every host.
    platform: "darwin", typeIntoApp: true, claudeCompose: {
      deliver: async (_id, message) => {
        sent.push(message.text);
        return { delivered: true };
      },
    },
  });
  try {
    const start = Date.now();
    while (sent.length < 2 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(sent, ["first", "second"]);
    assert.ok(Date.now() - start < 1000, `the second went right after the first (${Date.now() - start} ms)`);
  } finally {
    sessions.close();
  }
});

test("a message with a picture counts as taken as soon as the Claude app queues it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claude-"));
  try {
    const dir = path.join(root, "projects", "-work-app");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${A}.jsonl`);
    const since = Date.now() - 1000;
    await fs.writeFile(
      file,
      line({ sessionId: A, type: "user", uuid: "u1", parentUuid: null, timestamp: new Date(since - 60000).toISOString(), entrypoint: "claude-desktop", message: { content: "Earlier" } }) + "\n",
    );
    const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records") });
    assert.equal(await claude.arrived(A, "Look at this", since, { images: 1 }), false);
    // The app's queue entry for a message with a picture has no text (verified).
    await fs.appendFile(file, line({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), sessionId: A, content: "" }) + "\n");
    assert.equal(await claude.arrived(A, "Look at this", since, { images: 1 }), true);
    // Words alone still need their own words.
    assert.equal(await claude.arrived(A, "Look at this", since), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("putting a message in, Reach tells the check how many pictures went with it", async () => {
  const seen = [];
  const compose = createClaudeCompose({
    type: async () => ({ sent: true }),
    open: async () => {},
    arrived: async (...args) => {
      seen.push(args);
      return true;
    },
    shown: () => [{ id: A, session: `local_${A}` }],
    idle: async () => 0,
    appRunning: async () => true,
    wait: async () => {},
    confirmMs: 20,
  });
  assert.deepEqual(await compose.deliver(A, { title: "Fix", text: "Look at this", images: ["/tmp/a.png"] }), { delivered: true });
  assert.deepEqual(seen[0].slice(1, 2), ["Look at this"]);
  assert.deepEqual(seen[0][3], { images: 1 });
});
