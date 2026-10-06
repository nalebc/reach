import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClaudeCompose, draftFile } from "../server/agent-sessions/claude-compose.mjs";
import { createOutbox } from "../server/agent-sessions/outbox.mjs";

// Messages to a chat the Claude app shows stayed "Queued" for good: the box
// held the draft Reach had synced from the phone, but after a Reach restart
// Reach no longer knew it put it there, so every try was refused as "the
// draft changed on your Mac". And nothing let the phone push one in now, or
// put them in another order, as the Claude and Codex apps do.
const A = "11111111-2222-4333-8444-555555555555";
const B = "22222222-2222-4333-8444-555555555555";

// The Claude app's message box, as scripts/native/claude-compose.swift
// treats it: it never overwrites text Reach didn't put there.
function claudeApp({ onScreen = A, idle = 0 } = {}) {
  const app = { box: "", sent: [], onScreen, idle, opened: [] };
  app.type = async ({ text = "", draft, expected }) => {
    const current = app.box;
    if (!(current === (expected ?? "") || (text && current === text)))
      throw Object.assign(new Error("This chat's box in the Claude app has text typed on your Mac."), { waiting: true });
    if (draft) {
      app.box = text;
      return { drafted: true };
    }
    app.sent.push(text);
    app.box = "";
    return { sent: true };
  };
  app.shown = () => [app.onScreen, ...[A, B].filter((id) => id !== app.onScreen)].map((id) => ({ id, session: `local_${id}` }));
  app.open = async (url) => {
    app.opened.push(url);
    app.onScreen = url.split("local_")[1];
  };
  return app;
}
const compose = (app, extra = {}) =>
  createClaudeCompose({
    type: app.type,
    open: app.open,
    arrived: async () => true,
    shown: app.shown,
    idle: async () => app.idle,
    appRunning: async () => true,
    wait: async () => {},
    switchMs: 50,
    confirmMs: 20,
    ...extra,
  });

test("a message whose draft Reach synced before a restart still goes in after it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-drafts-"));
  try {
    const store = draftFile(path.join(dir, "agent-drafts.json"));
    const app = claudeApp();
    // Typing on the phone: the draft lands in the Claude app's box as it's typed.
    await compose(app, { store }).draft(A, { title: "Fix", text: "Messages stay queu", owner: "phone" });
    assert.equal(app.box, "Messages stay queu");
    // Reach restarts; the phone sends the finished message.
    const restarted = compose(app, { store });
    assert.deepEqual(await restarted.deliver(A, { title: "Fix", text: "Messages stay queued even after being sent", owner: "phone" }), {
      delivered: true,
    });
    assert.deepEqual(app.sent, ["Messages stay queued even after being sent"]);
    assert.equal(app.box, "");
    // And the file no longer holds a draft for it.
    assert.deepEqual(store.load(), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("text typed on the Mac is never overwritten: the message waits and says why", async () => {
  const app = claudeApp();
  app.box = "my own half-written note";
  await assert.rejects(compose(app).deliver(A, { title: "Fix", text: "from the phone" }), /typed on your Mac/);
  assert.equal(app.box, "my own half-written note");
  assert.deepEqual(app.sent, []);
});

test("Send now puts a message in while someone uses the Mac; otherwise it waits for that chat", async () => {
  const app = claudeApp({ onScreen: B, idle: 0 });
  await assert.rejects(compose(app).deliver(A, { title: "Fix", text: "hi" }), /Send now puts it in at once/);
  assert.deepEqual(app.sent, []);
  assert.deepEqual(await compose(app).deliver(A, { title: "Fix", text: "hi", now: true }), { delivered: true });
  assert.deepEqual(app.sent, ["hi"]);
  // The window goes back to the chat that was on screen.
  assert.equal(app.opened.at(-1), `claude://code/continue?session=local_${B}`);
});

test("the queue takes a new order and Send now, never moving the one being handed over", () => {
  const outbox = createOutbox();
  const [a, b, c] = ["first", "second", "third"].map((text) => outbox.add(A, { text, via: "app" }));
  const texts = () => outbox.list(A).map((m) => m.text);
  assert.equal(outbox.reorder(A, [c.id, a.id, b.id]), true);
  assert.deepEqual(texts(), ["third", "first", "second"]);
  // "third" is being handed over: it stays first whatever the new order.
  assert.equal(outbox.reorder(A, [a.id, b.id, c.id], c.id), true);
  assert.deepEqual(texts(), ["third", "first", "second"]);
  // An order that doesn't cover them all changes nothing.
  assert.equal(outbox.reorder(A, [a.id]), false);
  assert.equal(outbox.hurry(A, b.id), true);
  assert.deepEqual(texts(), ["second", "third", "first"]);
  assert.equal(outbox.list(A)[0].now, true);
});

// Send now to a chat the Claude app couldn't show: Reach retried at once, over
// and over, switching the Claude app to that chat and back about every second,
// pulling the person at the Mac back to the Claude app (and beeping). Send
// now is one try; after that the message waits like the others.
test("a Send now that can't go is tried once, then waits like the others", async () => {
  const { createAgentSessions } = await import("../server/agent-sessions/index.mjs");
  const outbox = createOutbox();
  const message = outbox.add(A, { text: "Also force send does not work", via: "app", title: "Fix" });
  outbox.hurry(A, message.id);
  let tries = 0;
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
    claudeCompose: {
      deliver: async () => {
        tries++;
        throw Object.assign(new Error("The Claude app is showing another chat."), { waiting: true });
      },
    },
  });
  try {
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(tries, 1);
    // Still there, with why, and no longer pushed in at once.
    assert.equal(outbox.list(A).length, 1);
    assert.equal(outbox.list(A)[0].now, undefined);
    assert.equal(outbox.list(A)[0].error, "The Claude app is showing another chat.");
  } finally {
    sessions.close();
  }
});

test("a Send now from before a restart doesn't fire when Reach starts again", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-outbox-"));
  try {
    const file = path.join(dir, "agent-outbox.json");
    const before = createOutbox({ file });
    const message = before.add(A, { text: "hi", via: "app", title: "Fix" });
    before.hurry(A, message.id);
    assert.equal(before.list(A)[0].now, true);
    // Reach restarts: the message is still there, waiting, not pushed in.
    const after = createOutbox({ file });
    assert.equal(after.list(A).length, 1);
    assert.equal(after.list(A)[0].text, "hi");
    assert.equal(after.list(A)[0].now, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
