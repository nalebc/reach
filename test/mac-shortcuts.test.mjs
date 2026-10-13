import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMacShortcuts } from "../server/mac-shortcuts.mjs";

// The Mac's own Shortcuts an agent may run: only the owner's allowed names,
// kept across restarts; an agent asking for another tells the owner once.
const muse = { id: "c1", name: "Muse" };
function world({ file } = {}) {
  const notes = [], records = [], runs = [];
  let clock = 1_000_000;
  const store = createMacShortcuts({ file, list: async () => ["Today's events", "Shazam shortcut"], run: async (input) => { runs.push(input); return { exitCode: 0, timedOut: false, output: "9:00 Standup" }; },
    notify: (message) => { notes.push(message); return Promise.resolve({ sent: 1 }); }, record: (kind, text) => records.push(text), now: () => clock, available: () => true });
  return { store, notes, records, runs, tick: (ms) => { clock += ms; } };
}
const rejects = async (work, status, pattern, kind) => {
  await assert.rejects(work, (error) => { assert.equal(error.status, status, error.message); if (pattern) assert.match(error.message, pattern); if (kind) assert.equal(error.kind, kind); return true; });
};

test("Full control lists and runs every shortcut; current authorization still applies", async () => {
  const w = world(), full = { ...muse, policy: { browser: true, preset: "full" } };
  assert.deepEqual(await w.store.agentList(full), { shortcuts: [{ name: "Shazam shortcut" }, { name: "Today's events" }] });
  assert.equal((await w.store.run(full, { name: "Today's events" })).ok, true);
  assert.equal(w.notes.length, 0);
  await rejects(() => w.store.run(full, { name: "Shazam shortcut" }, () => muse), 403);
  await assert.rejects(w.store.run(full, { name: "Today's events" }, () => { throw Error("revoked"); }), /revoked/);
  assert.equal(w.runs.length, 1);
});

test("nothing runs until the owner allows it by name; the owner hears once", async () => {
  const w = world();
  assert.deepEqual(await w.store.agentList(muse), { shortcuts: [] });
  await rejects(() => w.store.run(muse, { name: "Today's events" }), 403, /hasn't allowed/, "blocked");
  await rejects(() => w.store.run(muse, { name: "Today's events" }), 403);
  assert.equal(w.notes.length, 1, "told once in five minutes");
  assert.match(w.notes[0].body, /Today's events/);
  w.tick(300001);
  await rejects(() => w.store.run(muse, { name: "Today's events" }), 403);
  assert.equal(w.notes.length, 2);
  assert.deepEqual(w.runs, [], "nothing ran");
  await rejects(() => w.store.allow("Nope", true), 404);
  await rejects(() => w.store.allow("", true), 400);
  await rejects(() => w.store.allow("Today's events", "yes"), 400);
  assert.deepEqual(await w.store.allow("Today's events", true), { name: "Today's events", allowed: true });
  assert.deepEqual(await w.store.agentList(muse), { shortcuts: [{ name: "Today's events" }] });
  assert.deepEqual(await w.store.owner(), { shortcuts: [{ name: "Today's events", allowed: true }, { name: "Shazam shortcut", allowed: false }], missing: [] });
  const result = await w.store.run(muse, { name: "Today's events", input: "tomorrow" });
  assert.deepEqual(result, { ok: true, name: "Today's events", output: "9:00 Standup" });
  assert.deepEqual(w.runs, [{ name: "Today's events", input: "tomorrow" }]);
  await rejects(() => w.store.run(muse, { name: "Today's events", input: "a\u0000b" }), 400);
  await rejects(() => w.store.run(muse, { name: "Today's events", input: "x".repeat(20001) }), 400);
  await rejects(() => w.store.run(muse, {}), 400);
  assert.deepEqual(await w.store.allow("Today's events", false), { name: "Today's events", allowed: false });
  await rejects(() => w.store.run(muse, { name: "Today's events" }), 403);
});

test("the allowed names survive a restart; an unreadable file allows nothing", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reach-mac-shortcuts-"));
  const file = path.join(directory, "mac-shortcuts.json");
  try {
    const first = world({ file });
    await first.store.allow("Shazam shortcut", true);
    const second = world({ file });
    assert.deepEqual(await second.store.agentList(muse), { shortcuts: [{ name: "Shazam shortcut" }] });
    assert.equal(second.store.unreadable, false);
    fs.writeFileSync(file, "{not json");
    const third = world({ file });
    assert.equal(third.store.unreadable, true);
    assert.deepEqual(await third.store.agentList(muse), { shortcuts: [] });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("one shortcut at a time, and a failed or slow one says so", async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  const store = createMacShortcuts({ list: async () => ["A", "B"], run: async ({ name }) => name === "A" ? slow.then(() => ({ exitCode: 0, timedOut: true, output: "" })) : { exitCode: 1, timedOut: false, output: "Error: no input" }, available: () => true });
  await store.allow("A", true); await store.allow("B", true);
  const first = store.run(muse, { name: "A" });
  await rejects(() => store.run({ id: "c2", name: "Codex" }, { name: "B" }), 409, /Muse is running/, "busy");
  release();
  assert.deepEqual(await first, { ok: false, name: "A", output: "", timedOut: true });
  assert.deepEqual(await store.run(muse, { name: "B" }), { ok: false, name: "B", output: "Error: no input", exitCode: 1 });
});
