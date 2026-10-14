import test from "node:test";
import assert from "node:assert/strict";
import { codexArchive, claudeArchive, portableMessages } from "../server/agent-sessions/portable-history.mjs";
import { transferContext, TRANSFER_CONTEXT_BUDGET } from "../server/agent-sessions/transfer-context.mjs";
import { parseClaudeTranscript } from "../server/agent-sessions/claude-transcript.mjs";

const id = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const user = text => ({ role: "user", kind: "text", text });
const reply = text => ({ role: "assistant", kind: "text", text });
const options = { id, cwd: "/work", from: "Claude Code", name: "Fix login", title: "Fix login", version: "2.1.289", now: 4000 };
const large = () => [user("Fix login and keep the offline behavior"), reply("x".repeat(600_000)), { role: "tool", kind: "command", text: "npm test", detail: "log".repeat(200_000), status: "completed" }, user("The next step is to check Windows"), reply("I will check the Windows path next.")];
const textOf = turns => turns.map(t => t.text).join("\n");
const bounded = turns => assert.ok(turns.reduce((n, t) => n + Buffer.byteLength(t.text) + 256, 0) <= TRANSFER_CONTEXT_BUDGET);

test("large Codex imports keep complete history and replace only the active model context", () => {
  const items = large();
  const archive = codexArchive({ ...options, items, archivePath: "/tmp/history.jsonl" });
  const messages = archive.lines.filter(l => l.type === "response_item");
  assert.equal(messages[1].payload.content[0].text, items[1].text);
  assert.ok(messages[2].payload.content[0].text.endsWith(items[2].detail));
  const compact = archive.lines.at(-1);
  assert.equal(compact.type, "compacted");
  const working = compact.payload.replacement_history.map(t => ({ role: t.role, text: t.content[0].text }));
  bounded(working);
  assert.match(textOf(working), /Original request:\nFix login and keep the offline behavior/);
  assert.match(textOf(working), /check Windows/);
  assert.match(textOf(working), /Full history file: \/tmp\/history.jsonl/);
  assert.doesNotMatch(textOf(working), /logloglog/);
  assert.ok(archive.lines.some(l => l.type === "event_msg" && l.payload.type === "task_complete"));
});

test("Claude imports keep the visible archive across their new compaction boundary and later replies", () => {
  const items = large();
  const rows = claudeArchive({ ...options, from: "Codex", items });
  const boundary = rows.at(-2);
  assert.equal(boundary.subtype, "compact_boundary");
  assert.equal(boundary.parentUuid, null);
  assert.equal(boundary.logicalParentUuid, rows.at(-3).uuid);
  const summary = rows.at(-1);
  assert.equal(summary.isCompactSummary, true);
  assert.ok(Buffer.byteLength(summary.message.content) <= TRANSFER_CONTEXT_BUDGET);
  rows.push({ type: "user", uuid: "next", parentUuid: summary.uuid, sessionId: id, message: { role: "user", content: "Keep going" } });
  const parsed = parseClaudeTranscript(rows.map(JSON.stringify).join("\n"), { maxOutput: Infinity });
  assert.equal(parsed.items[1].text, items[1].text);
  assert.ok(parsed.items[2].text.endsWith(items[2].detail));
  assert.equal(parsed.items.at(-1).text, "Keep going");
  assert.match(parsed.memory.summary, /check Windows/);
  assert.deepEqual(parsed.items.slice(parsed.memory.from).map(i => i.text), ["Keep going"]);
});

test("the source's existing summary and current work seed the context without resurrecting old output", () => {
  const items = large();
  const archive = codexArchive({ ...options, items, context: { items: items.slice(-2), summary: "The login fix is done. Windows still needs verification." } });
  const working = archive.lines.at(-1).payload.replacement_history;
  const text = working.map(t => t.content[0].text).join("\n");
  assert.match(text, /The login fix is done\. Windows still needs verification\./);
  assert.match(text, /written by Claude Code when it compacted/);
  assert.doesNotMatch(text, /xxxx/);
});

test("UTF-8 text and thousands of short exchanges fit the same context bound", () => {
  for (const items of [
    [user("Original task"), reply("你好世界🧑🏽‍💻".repeat(50_000)), user("Latest request"), reply("Latest answer")],
    Array.from({ length: 12_000 }, (_, n) => n % 2 ? reply(`a${n}`) : user(`u${n}`)),
  ]) {
    const working = transferContext({ ...options, items, messages: portableMessages(items) });
    bounded(working);
    assert.match(textOf(working), new RegExp(items.at(-1).text));
  }
});

test("image-heavy history keeps every attachment in the archive while bounding the continuation", () => {
  const png = "data:image/png;base64,YQ==";
  const items = Array.from({ length: 30 }, (_, n) => ({ ...user(`Screenshot ${n}`), imageData: [png], images: 1 }));
  const archive = codexArchive({ ...options, items });
  const original = archive.lines.filter(l => l.type === "response_item");
  assert.equal(original.filter(l => l.payload.content.some(c => c.image_url === png)).length, 30);
  const context = archive.lines.at(-1).payload.replacement_history;
  assert.ok(context.every(m => m.content.every(c => c.type !== "input_image")));
  assert.match(context.map(m => m.content[0].text).join("\n"), /Screenshot 29\n\[1 image\]/);
});

test("small transfers retain their complete active context without adding a compaction", () => {
  const items = [user("Please fix login"), reply("Fixed login")];
  assert.ok(codexArchive({ ...options, items }).lines.every(l => l.type !== "compacted"));
  assert.ok(claudeArchive({ ...options, items }).every(l => !l.isCompactSummary && l.subtype !== "compact_boundary"));
});
