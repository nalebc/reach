import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOutbox } from "../server/agent-sessions/outbox.mjs";

const A = "11111111-2222-4333-8444-555555555555";
const B = "22222222-2222-4333-8444-555555555555";
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "reach-outbox-")), "agent-outbox.json");

test("messages waiting for their session are kept on disk, in order, until each is handed over", () => {
  const file = tmp();
  const outbox = createOutbox({ file });
  const changes = [];
  outbox.onChange((id) => changes.push(id));
  const first = outbox.add(A, { text: "first", images: ["img-1"], cwd: "/work", model: "opus" });
  const second = outbox.add(A, { text: "second" });
  outbox.add(B, { text: "elsewhere" });
  assert.deepEqual(outbox.list(A).map((m) => m.text), ["first", "second"]);
  assert.deepEqual(outbox.list(A)[0], { cwd: "/work", model: "opus", id: first.id, text: "first", images: ["img-1"], at: first.at });
  assert.deepEqual(changes, [A, A, B]);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  // Reach restarts: all still there, in order.
  const again = createOutbox({ file });
  assert.deepEqual(again.list(A).map((m) => m.text), ["first", "second"]);
  assert.deepEqual(again.sessions().sort(), [A, B]);
  // One that can't go yet says why, until it goes.
  again.problem(A, first.id, "Claude Code is signed out on your Mac.");
  assert.equal(createOutbox({ file }).list(A)[0].error, "Claude Code is signed out on your Mac.");
  again.problem(A, first.id, null);
  assert.equal(again.list(A)[0].error, undefined);
  // Handed over: gone, the rest stay.
  again.remove(A, first.id);
  assert.deepEqual(createOutbox({ file }).list(A).map((m) => m.id), [second.id]);
  again.remove(A, second.id);
  assert.deepEqual(createOutbox({ file }).sessions(), [B]);
});

test("a damaged outbox file loses nothing it can still read, and keeps only real sessions", () => {
  const file = tmp();
  fs.writeFileSync(
    file,
    JSON.stringify({
      [A]: [{ id: "m1", text: "kept", images: [], at: 1 }, { id: 5, text: "broken" }, null],
      "../etc": [{ id: "m2", text: "not a session", images: [], at: 1 }],
    }),
  );
  const outbox = createOutbox({ file });
  assert.deepEqual(outbox.sessions(), [A]);
  assert.deepEqual(outbox.list(A).map((m) => m.text), ["kept"]);
  fs.writeFileSync(file, "{ half written");
  assert.deepEqual(createOutbox({ file }).sessions(), []);
  // Without a file (tests): in memory.
  const memory = createOutbox();
  memory.add(A, { text: "hi" });
  assert.equal(memory.list(A).length, 1);
});

test("a restart during delivery pauses the message instead of sending it twice", () => {
  const file = tmp(); const outbox = createOutbox({ file });
  const message = outbox.add(A, { text: "once" });
  assert.equal(outbox.begin(A, message.id), true);
  const restored = createOutbox({ file });
  assert.equal(restored.list(A)[0].delivery, "paused");
  assert.equal(restored.begin(A, message.id), false);
});

test("a failed durable enqueue rolls back and a failed send marker cannot send", () => {
  const file = tmp(); const outbox = createOutbox({ file });
  const first = outbox.add(A, { text: "one" });
  fs.rmSync(file); fs.mkdirSync(file);
  assert.throws(() => outbox.add(A, { text: "two" }), /Could not save/);
  assert.equal(outbox.list(A).length, 1);
  assert.throws(() => outbox.begin(A, first.id), /Could not save/);
  assert.equal(outbox.begin(A, first.id), false);
});
