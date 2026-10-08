import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJournal, turnEvent, KEEP_MS } from "../server/agent-sessions/journal.mjs";
import { createOverlaps, findOverlaps, recentChanges } from "../server/agent-sessions/overlaps.mjs";
import { createSearch, markedLines } from "../server/agent-sessions/search.mjs";

// The All page's server side (docs/ACROSS_AGENTS.md): what happened while
// you were away, the files two chats changed at once, and one search across
// every agent's history files.
const user = (id, text) => ({ id, role: "user", kind: "text", text });
const reply = (id, text) => ({ id, role: "assistant", kind: "text", text });
const edit = (id, text, at) => ({ id, role: "tool", kind: "file-change", text, at });

test("each ended turn becomes one line of the journal, kept a week", () => {
  const s = { agent: "claude", id: "k1", title: "Refactor auth", cwd: "/work/app" };
  const finished = turnEvent({ session: s, outcome: { kind: "reply", turn: [edit("e1", "a.ts"), edit("e2", "b.ts, a.ts"), reply("a1", "Done")] } }, 10);
  assert.deepEqual(finished, { kind: "finished", agent: "claude", chat: "k1", title: "Refactor auth", cwd: "/work/app", files: 2, at: 10 });
  const usage = turnEvent({ session: { ...s, agent: "codex" }, outcome: { kind: "error", item: { text: "You’ve hit your usage limit." }, turn: [] } });
  assert.equal(usage.kind, "usage");
  assert.equal(turnEvent({ session: s, outcome: { kind: "error", item: { text: "boom" }, turn: [] } }).kind, "failed");
  assert.equal(turnEvent({ session: s, outcome: { kind: "open", turn: [] } }), null, "not ended");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-journal-"));
  const file = path.join(dir, "agent-journal.json");
  let clock = 1_000_000_000;
  const journal = createJournal({ file, now: () => clock });
  journal.add({ ...finished, at: clock - KEEP_MS - 1 });
  journal.add({ ...finished, at: clock - 100 });
  journal.add({ ...usage, at: clock - 50 });
  assert.deepEqual(journal.since(clock - 200).map((e) => e.kind), ["usage", "finished"], "newest first, the week-old one gone");
  assert.deepEqual(journal.since(clock - 60).map((e) => e.kind), ["usage"]);
  journal.flush();
  assert.equal(createJournal({ file, now: () => clock }).since(0).length, 2, "kept across a restart");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("files two chats changed in the last half hour are found, worktrees apart", async () => {
  const now = 10 * 60 * 60 * 1000;
  // Claude Code writes paths in its folder; Codex, full paths (several in one change).
  assert.deepEqual(recentChanges([edit("e1", "src/a.ts", now - 1000), edit("e2", "old.ts", now - 3_600_000)], "/work/app", now - 1_800_000), [
    { file: "/work/app/src/a.ts", at: now - 1000 },
  ]);
  const chats = [
    { agent: "codex", id: "c1", title: "Fix login", files: recentChanges([edit("x", "/work/app/src/a.ts, /work/app/src/b.ts", now)], "/work/app") },
    { agent: "claude", id: "k1", title: "Refactor", files: recentChanges([edit("y", "src/a.ts", now - 10)], "/work/app") },
    { agent: "claude", id: "k2", title: "In a worktree", files: recentChanges([edit("z", "src/a.ts", now)], "/work/app/.claude/worktrees/fox") },
  ];
  const found = findOverlaps(chats);
  assert.equal(found.length, 1);
  assert.equal(found[0].file, "/work/app/src/a.ts");
  assert.deepEqual(found[0].chats.map((c) => c.id), ["c1", "k1"]);

  // Only chats at work or written lately are read, and read again only when they change.
  const sessions = [
    { agent: "codex", id: "c1", title: "Fix login", cwd: "/work/app", status: "idle", updatedAt: now - 1000 },
    { agent: "claude", id: "k1", title: "Refactor", cwd: "/work/app", status: "running", updatedAt: now - 3_600_000 },
    { agent: "claude", id: "k9", title: "Old", cwd: "/work/app", status: "idle", updatedAt: now - 3_600_000 },
  ];
  const reads = [];
  const overlaps = createOverlaps({
    now: () => now,
    list: async () => ({ sessions }),
    read: async (agent, id) => (
      reads.push(id),
      { session: { cwd: "/work/app" }, items: [user("u", "go"), edit(`${id}-e`, "src/a.ts", now - 100), reply("a", "ok")] }
    ),
  });
  const first = await overlaps.scan();
  assert.deepEqual(reads, ["c1", "k1"]);
  assert.equal(first.overlaps.length, 1);
  await overlaps.scan();
  assert.deepEqual(reads, ["c1", "k1", "k1"], "the idle one is kept; the working one read again");
});

// A Claude Code transcript and Codex rollouts in both of Codex's shapes.
function histories(root) {
  const line = (o) => JSON.stringify(o);
  const claudeDir = path.join(root, "claude", "-work-app");
  fs.mkdirSync(claudeDir, { recursive: true });
  const K = "11111111-2222-4333-8444-555555555555";
  const at = (s) => new Date(Date.UTC(2026, 9, 7, 10, 0, s)).toISOString();
  fs.writeFileSync(
    path.join(claudeDir, `${K}.jsonl`),
    [
      line({ type: "user", timestamp: at(1), message: { role: "user", content: "Why does the login token fail?" } }),
      line({ type: "assistant", timestamp: at(2), message: { content: [{ type: "thinking", thinking: "token secret" }, { type: "text", text: "The token is compared as a number." }] } }),
      line({ type: "user", timestamp: at(3), message: { content: [{ type: "tool_result", content: "token in a tool's output" }] } }),
      line({ type: "user", timestamp: at(4), isMeta: true, message: { content: "token in Claude Code's own note" } }),
      line({ type: "assistant", timestamp: at(5), isSidechain: true, message: { content: [{ type: "text", text: "token in a sub-agent" }] } }),
    ].join("\n") + "\n",
  );
  const codexDir = path.join(root, "codex", "2026", "10", "07");
  fs.mkdirSync(codexDir, { recursive: true });
  const C = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  const C2 = "0199ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  // The older shape writes each message twice: as an event and as an item.
  fs.writeFileSync(
    path.join(codexDir, `rollout-2026-10-07T10-00-00-${C}.jsonl`),
    [
      line({ timestamp: at(10), type: "session_meta", payload: { id: C, cwd: "/work/app" } }),
      line({ timestamp: at(11), type: "event_msg", payload: { type: "user_message", message: "Rotate the login token" } }),
      line({ timestamp: at(11), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Rotate the login token" }] } }),
      line({ timestamp: at(12), type: "event_msg", payload: { type: "agent_message", message: "Rotated the token weekly." } }),
    ].join("\n") + "\n",
  );
  // The newer one, items only, with Codex's own context as a message.
  const newer = path.join(codexDir, `rollout-2026-10-07T11-00-00-${C2}.jsonl`);
  fs.writeFileSync(
    newer,
    [
      line({ timestamp: at(20), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>token</environment_context>" }] } }),
      line({ timestamp: at(21), type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "token rules" }] } }),
      line({ timestamp: at(22), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Nothing yet." }] } }),
    ].join("\n") + "\n",
  );
  return { K, C, C2, newer, at, line };
}

test("search finds what was said in every agent's chats, newest first, and nothing from tools or notes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-search-"));
  const { K, C, C2, newer, at, line } = histories(root);
  const search = createSearch({ claudeProjects: path.join(root, "claude"), codexSessions: path.join(root, "codex"), setEvery: () => 0, clearEvery: () => {} });
  const { results, partial } = await search.search("TOKEN");
  assert.equal(partial, false);
  assert.deepEqual(
    results.map((r) => [r.agent, r.id, r.role]),
    [
      ["codex", C.toLowerCase(), "assistant"],
      ["codex", C.toLowerCase(), "user"],
      ["claude", K, "assistant"],
      ["claude", K, "user"],
    ],
    "newest first; once each; no tool output, notes, sub-agents, thinking or Codex's own context",
  );
  assert.match(results[0].snippet, /Rotated the token weekly/);
  assert.equal((await search.search("token compared")).results.length, 1, "every word, anywhere in the message");
  assert.equal((await search.search("token", { perChat: 1 })).results.length, 2);

  // Added to: only what's new is read, and found.
  fs.appendFileSync(newer, line({ timestamp: at(30), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Now the token expires." }] } }) + "\n");
  const later = await search.search("token expires");
  assert.deepEqual(later.results.map((r) => r.id), [C2.toLowerCase()]);
  // A half-written last line waits for the rest.
  fs.appendFileSync(newer, '{"timestamp":"' + at(40) + '","type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Halfway');
  assert.equal((await search.search("halfway")).results.length, 0);
  fs.appendFileSync(newer, ' token done"}]}}\n');
  assert.equal((await search.search("halfway")).results.length, 1);
  // A file that shrank (rewritten) is read again from its start.
  fs.writeFileSync(newer, line({ timestamp: at(50), type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fresh start" }] } }) + "\n");
  assert.equal((await search.search("halfway")).results.length, 0);
  assert.equal((await search.search("fresh")).results.length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("lines are found by their markers alone, whole lines only", () => {
  const buf = Buffer.from('{"a":1}\n{"type":"user","x":1}\n{"b":2}\n{"role":"assistant"}\n{"type":"user","cut');
  const lines = [...markedLines(buf, ['"type":"user"', '"role":"assistant"'].map((m) => Buffer.from(m)))].map(([s, e]) => buf.toString("utf8", s, e));
  assert.deepEqual(lines, ['{"type":"user","x":1}', '{"role":"assistant"}']);
});
