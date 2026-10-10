import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseClaudeTranscript } from "../server/agent-sessions/claude-transcript.mjs";
import { createClaudeSessions } from "../server/agent-sessions/claude.mjs";

// Transcripts are read in pieces and unopened chats keep only their summary,
// so a Mac with gigabytes of Claude history doesn't run out of memory. What
// a phone sees must stay exactly the same as reading the whole file at once.
const ID = "11111111-2222-4333-8444-555555555555";
const OTHER = "22222222-3333-4444-8555-666666666666";
const line = (o) => JSON.stringify(o);
const at = (s) => new Date(Date.UTC(2026, 9, 4, 10, 0, s)).toISOString();
function conversation(id, turns, { picture = 0 } = {}) {
  const base = { sessionId: id, cwd: "/work/app", gitBranch: "main", entrypoint: "cli" };
  const lines = [];
  let parent = null;
  for (let n = 0; n < turns; n++) {
    const u = `u${n}`, a = `a${n}`;
    const content = n === 1 && picture
      ? [{ type: "text", text: `question ${n}` }, { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(picture) } }]
      : `question ${n} ${"é".repeat(n % 7)}`;
    lines.push(line({ ...base, type: "user", uuid: u, parentUuid: parent, timestamp: at(n * 2), message: { role: "user", content } }));
    lines.push(line({ ...base, type: "assistant", uuid: a, parentUuid: u, timestamp: at(n * 2 + 1), message: { content: [{ type: "text", text: `answer ${n} ✓ ${"x".repeat(n * 3)}` }] } }));
    parent = a;
  }
  lines.push(line({ type: "custom-title", customTitle: "Memory test", sessionId: id }));
  return lines.join("\n") + "\n";
}
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claude-mem-"));
  const folder = path.join(root, "projects", "-work-app");
  await fs.mkdir(folder, { recursive: true });
  return { root, folder };
}

test("reading in small pieces gives exactly the whole-file conversation, a picture line longer than a piece included", async () => {
  const { root, folder } = await setup();
  const text = conversation(ID, 40, { picture: 5000 });
  await fs.writeFile(path.join(folder, `${ID}.jsonl`), text);
  const whole = parseClaudeTranscript(text);
  // 97 bytes: smaller than most lines and far smaller than the picture.
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records"), chunkBytes: 97 });
  const { items } = await claude.read(ID, { limit: 500 });
  assert.deepEqual(items, whole.items);
  const [listed] = await claude.list();
  assert.equal(listed.title, "Memory test");
  assert.equal(listed.preview, "answer 39 ✓ " + "x".repeat(117));
  // The picture is still found where it sits in the file.
  const image = await claude.image(ID, "u1", 0);
  assert.equal(image.data.length, Buffer.from("A".repeat(5000), "base64").length);
});

test("a transcript still being written: a torn last line is read once it ends, nothing doubled or lost", async () => {
  const { root, folder } = await setup();
  const file = path.join(folder, `${ID}.jsonl`);
  const text = conversation(ID, 6);
  const cut = text.length - 30; // inside the custom-title line
  await fs.writeFile(file, text.slice(0, cut));
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records"), chunkBytes: 64 });
  const first = await claude.read(ID, { limit: 500 });
  await fs.appendFile(file, text.slice(cut) + conversation(ID, 8).split("\n").slice(12, 16).join("\n") + "\n");
  const later = await claude.read(ID, { limit: 500 });
  const whole = parseClaudeTranscript(text + conversation(ID, 8).split("\n").slice(12, 16).join("\n") + "\n");
  assert.ok(first.items.length < later.items.length);
  assert.deepEqual(later.items, whole.items);
  assert.equal(later.session.title, "Memory test");
});

test("past the memory budget, the least recently used chat keeps only its summary: the list is unchanged, opening reads it whole", async () => {
  const { root, folder } = await setup();
  await fs.writeFile(path.join(folder, `${ID}.jsonl`), conversation(ID, 30));
  await fs.writeFile(path.join(folder, `${OTHER}.jsonl`), conversation(OTHER, 3));
  let clock = 1_000_000;
  const size = (await fs.stat(path.join(folder, `${ID}.jsonl`))).size;
  // Room for the big chat, not for both.
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records"), budgetBytes: size + 10, now: () => clock++ });
  const before = await claude.read(ID, { limit: 500 });
  const listed = await claude.list();
  const starts = await claude.starts();
  // The other chat is written to: the big one, used less recently, is reduced.
  await fs.appendFile(path.join(folder, `${OTHER}.jsonl`), conversation(OTHER, 4).split("\n").slice(6, 8).join("\n") + "\n");
  const after = await claude.list();
  assert.deepEqual(after.find((s) => s.id === ID), listed.find((s) => s.id === ID), "the list shows the same chat");
  assert.deepEqual((await claude.starts()).find((s) => s.id === ID), starts.find((s) => s.id === ID));
  const again = await claude.read(ID, { limit: 500 });
  assert.equal(again.items.length, 60);
  assert.deepEqual(again.items, before.items);
  assert.deepEqual(again.items, parseClaudeTranscript(conversation(ID, 30)).items);
});

test("within the budget nothing is reduced: an old chat opens from memory", async () => {
  const { root, folder } = await setup();
  await fs.writeFile(path.join(folder, `${ID}.jsonl`), conversation(ID, 10));
  await fs.writeFile(path.join(folder, `${OTHER}.jsonl`), conversation(OTHER, 3));
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records") });
  await claude.list();
  await fs.appendFile(path.join(folder, `${OTHER}.jsonl`), conversation(OTHER, 4).split("\n").slice(6, 8).join("\n") + "\n");
  await claude.list();
  // Opening it is a cache hit: the file isn't read again.
  const open = fs.open;
  let opened = 0;
  fs.open = async (...args) => { opened++; return open(...args); };
  try { await claude.read(ID, { limit: 5 }); } finally { fs.open = open; }
  assert.equal(opened, 0);
});

test("a chat idle for ten minutes keeps only its summary, within the budget too; opening reads it whole", async () => {
  const { root, folder } = await setup();
  await fs.writeFile(path.join(folder, `${ID}.jsonl`), conversation(ID, 10));
  await fs.writeFile(path.join(folder, `${OTHER}.jsonl`), conversation(OTHER, 3));
  let clock = 1_000_000;
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records"), now: () => clock });
  const before = await claude.read(ID, { limit: 500 });
  await claude.list();
  clock += 11 * 60 * 1000;
  // Another chat is written to; this one was idle all along.
  await fs.appendFile(path.join(folder, `${OTHER}.jsonl`), conversation(OTHER, 4).split("\n").slice(6, 8).join("\n") + "\n");
  await claude.list();
  const open = fs.open;
  let opened = 0;
  fs.open = async (...args) => { opened++; return open(...args); };
  let again;
  try { again = await claude.read(ID, { limit: 500 }); } finally { fs.open = open; }
  assert.ok(opened > 0, "read again from its file");
  assert.deepEqual(again.items, before.items);
});

test("the default budget is a 64th of the Mac's memory, 64 to 256 MB", async () => {
  const source = await fs.readFile(new URL("../server/agent-sessions/claude.mjs", import.meta.url), "utf8");
  assert.match(source, /budgetBytes = Math\.max\(64 \* 1024 \* 1024, Math\.min\(256 \* 1024 \* 1024, Math\.floor\(os\.totalmem\(\) \/ 64\)\)\)/);
});

test("a deleted transcript leaves the list and the cache", async () => {
  const { root, folder } = await setup();
  await fs.writeFile(path.join(folder, `${ID}.jsonl`), conversation(ID, 2));
  await fs.writeFile(path.join(folder, `${OTHER}.jsonl`), conversation(OTHER, 2));
  const claude = createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records") });
  assert.equal((await claude.list()).length, 2);
  await fs.rm(path.join(folder, `${OTHER}.jsonl`));
  assert.deepEqual((await claude.list()).map((s) => s.id), [ID]);
});
