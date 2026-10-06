import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  moveTurns,
  handoff,
  codexHistoryItems,
  batches,
  claudeLines,
  createMoves,
  clipMiddle,
} from "../server/agent-sessions/move.mjs";
import { parseClaudeTranscript } from "../server/agent-sessions/claude-transcript.mjs";

// Moving a chat to the other agent (move.mjs): the conversation in the new
// agent's own form, whatever its size.
const user = (text, extra = {}) => ({ id: `u${text}`, role: "user", kind: "text", text, ...extra });
const said = (text) => ({ id: `a${text}`, role: "assistant", kind: "text", text });
const tool = (kind, text, status = "completed") => ({ id: `t${text}`, role: "tool", kind, text, status, detail: "x".repeat(5000) });

test("a chat becomes turns: what each side said, tool use as one line each, pictures as placeholders", () => {
  const turns = moveTurns(
    [
      user("Fix the login bug", { images: 2 }),
      said("Looking at it."),
      tool("command", "npm test", "failed"),
      tool("file-change", "src/login.ts"),
      said("Fixed: the token expired early."),
      tool("command", "npm run build", "running"),
      user("Thanks"),
      { id: "e", role: "system", kind: "error", text: "You've hit your session limit" },
    ],
    { from: "Claude Code" },
  );
  assert.deepEqual(turns, [
    { role: "user", text: "Fix the login bug\n[2 images]" },
    {
      role: "assistant",
      text:
        "Looking at it.\n\n• Ran `npm test` (failed)\n• Changed src/login.ts\n\nFixed: the token expired early.\n\n" +
        "• Ran `npm run build` (still running when the chat moved)",
    },
    { role: "user", text: "Thanks" },
  ]);
  // Tool output stays in the original chat.
  assert.ok(!JSON.stringify(turns).includes("xxxxx"));
});

test("what the agent remembers comes first: its own summary from when it compacted", () => {
  const turns = moveTurns([user("Next step?"), said("Ship it.")], { summary: "We built the login flow.", from: "Claude Code" });
  assert.equal(turns[0].role, "user");
  assert.match(turns[0].text, /^Summary of the conversation before the messages below, written by Claude Code when it compacted:\n\nWe built the login flow\.\n\nNext step\?$/);
  assert.deepEqual(turns[1], { role: "assistant", text: "Ship it." });
});

test("no chat is too big: the newest verbatim, older ones shorter, the rest left out with a note, within the room", () => {
  const items = [];
  for (let n = 0; n < 400; n++) items.push(user(`question ${n} ${"q".repeat(900)}`), said(`answer ${n} ${"a".repeat(1900)}`));
  const budget = 100_000;
  const turns = moveTurns(items, { summary: "s".repeat(80_000), from: "Codex", budget });
  const total = turns.reduce((n, t) => n + t.text.length, 0);
  assert.ok(total <= budget * 1.05, `within the room: ${total}`);
  // The latest exchange word for word; the very first left out, said so.
  assert.ok(turns.at(-1).text.startsWith("answer 399 "));
  assert.equal(turns.at(-1).text.length, `answer 399 `.length + 1900);
  assert.match(turns[0].text, /written by Codex when it compacted/);
  assert.match(turns[0].text, /characters left out/);
  assert.match(turns[0].text, /earlier messages are in the original chat in Codex, not repeated here\./);
  assert.ok(!turns.some((t) => t.text.includes("question 0 ")));
  // Older ones kept are shorter than they were.
  const older = turns.find((t) => /^question \d+ /.test(t.text) && t.text.length < 700);
  assert.ok(older, "older questions shortened");
  // Still alternating.
  for (let i = 1; i < turns.length; i++) assert.notEqual(turns[i].role, turns[i - 1].role);
  // One message bigger than all the room still goes, as its start and end.
  const giant = moveTurns([user("x".repeat(500_000))], { budget: 10_000 });
  assert.equal(giant.length, 1);
  assert.ok(giant[0].text.length < 10_000);
  assert.match(clipMiddle("y".repeat(100), 70), /characters left out/);
});

test("Codex gets the turns as its own history messages, in batches it can take one at a time", () => {
  const items = codexHistoryItems([
    { role: "user", text: "hi" },
    { role: "assistant", text: "hello" },
  ]);
  assert.deepEqual(items, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] },
  ]);
  const many = codexHistoryItems(Array.from({ length: 10 }, (_, n) => ({ role: n % 2 ? "assistant" : "user", text: "z".repeat(50_000) })));
  const groups = batches(many, 120_000);
  assert.deepEqual(groups.map((g) => g.length), [2, 2, 2, 2, 2]);
  assert.deepEqual(groups.flat(), many);
  assert.match(handoff({ from: "Claude Code", title: "Fix login", cwd: "/work/app" }), /^This conversation was moved here from Claude Code \(“Fix login”, in \/work\/app\)\./);
});

test("Claude Code gets a transcript of its own: the note first, chained, alternating, read back as the same conversation", () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const lines = claudeLines({
    id,
    cwd: "/work/app",
    title: "Fix login",
    note: "(Moved from Codex.)",
    version: "2.1.289",
    model: "gpt-6-astra",
    turns: [
      { role: "assistant", text: "I looked at the code." },
      { role: "user", text: "Go on" },
      { role: "user", text: "and test it" },
      { role: "assistant", text: "Done." },
    ],
    now: Date.parse("2026-10-05T20:00:00Z"),
  });
  assert.deepEqual(lines[0], { type: "custom-title", customTitle: "Fix login", sessionId: id });
  const entries = lines.slice(1);
  assert.deepEqual(entries.map((e) => e.type), ["user", "assistant", "user", "assistant"]);
  assert.equal(entries[0].parentUuid, null);
  for (let i = 1; i < entries.length; i++) assert.equal(entries[i].parentUuid, entries[i - 1].uuid);
  assert.ok(entries.every((e) => e.sessionId === id && e.cwd === "/work/app" && e.version === "2.1.289" && e.entrypoint === "sdk-cli"));
  assert.ok(Date.parse(entries.at(-1).timestamp) <= Date.parse("2026-10-05T20:00:00Z"));
  const view = parseClaudeTranscript(lines.map((l) => JSON.stringify(l)).join("\n"));
  assert.equal(view.title, "Fix login");
  assert.deepEqual(
    view.items.map((i) => `${i.role}:${i.text}`),
    ["user:(Moved from Codex.)", "assistant:I looked at the code.", "user:Go on\n\nand test it", "assistant:Done."],
  );
});

test("moves are remembered both ways, across restarts; anything malformed is ignored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-moves-"));
  const file = path.join(dir, "agent-moves.json");
  const moves = createMoves({ file, now: () => 42 });
  moves.add({ from: { agent: "claude", id: "a", title: "Fix login", upTo: "u9" }, to: { agent: "codex", id: "b" } });
  moves.add({ from: { agent: "claude", id: "a" }, to: { agent: "codex", id: "c" } });
  // Yours only, like Reach's other records.
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = createMoves({ file });
  assert.equal(again.into("codex", "b").from.upTo, "u9");
  assert.equal(again.into("codex", "b").at, 42);
  assert.deepEqual(again.outOf("claude", "a").map((m) => m.to.id), ["b", "c"]);
  assert.equal(again.into("claude", "a"), null);
  fs.writeFileSync(file, JSON.stringify([{ from: { agent: "claude" } }, "x"]));
  assert.deepEqual(createMoves({ file }).outOf("claude", "a"), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
