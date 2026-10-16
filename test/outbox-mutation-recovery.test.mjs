import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";
import { createOutbox } from "../server/agent-sessions/outbox.mjs";

// Disposable storage and mocked Claude app/Code backends: no provider requests,
// native app control or real conversations. Windows uses the Code fallback.
const A = "11111111-2222-4333-8444-555555555555";
const diskOutbox = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-outbox-mutations-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "outbox.json");
  return { file, outbox: createOutbox({ file }) };
};
const sessionsWith = (t, outbox, deliver = async () => ({}), typeIntoApp = true) => {
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: {},
    codexLive: { drives: () => false },
    claude: { starts: async () => [], read: async () => ({ session: {} }) },
    live: async () => new Map(),
    claudeHost: { onRelease() {}, send: deliver },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} },
    outbox,
    queueMs: 60000,
    appRetryMs: 60000,
    typeIntoApp,
    claudeCompose: { deliver },
  });
  t.after(() => sessions.close());
  return sessions;
};
const failSave = (t, file) => {
  const rename = fs.renameSync;
  return t.mock.method(fs, "renameSync", (from, to) => {
    if (to === file) throw Object.assign(new Error("Fixture disk write refused"), { code: "EACCES" });
    return rename(from, to);
  });
};
const waitFor = async (check, ms = 1000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10));
  return check();
};

test("a queue edit refused by storage keeps the original text and error in memory and after reopening", (t) => {
  const { file, outbox } = diskOutbox(t);
  const message = outbox.add(A, { text: "Original message", images: ["picture"] });
  outbox.problem(A, message.id, "Waiting for the app");
  const refused = failSave(t, file);
  assert.throws(() => outbox.edit(A, message.id, "Rejected edit"), /Could not save/);
  assert.equal(outbox.list(A)[0].text, "Original message", "a rejected edit must never become the message delivered from memory");
  assert.equal(outbox.list(A)[0].error, "Waiting for the app");
  refused.mock.restore();
  assert.equal(createOutbox({ file }).list(A)[0].text, "Original message");
  assert.equal(outbox.edit(A, message.id, "Accepted edit"), true);
  assert.equal(createOutbox({ file }).list(A)[0].text, "Accepted edit");
});

test("queue cancellation fails visibly when it cannot persist, preserving the message for a safe retry", async (t) => {
  const { file, outbox } = diskOutbox(t);
  const message = outbox.add(A, { text: "Cancel this", via: "app" });
  outbox.pause(A, message.id, "Check delivery before continuing");
  const sent = [];
  const sessions = sessionsWith(t, outbox, async (_id, body) => sent.push(body.text));
  const refused = failSave(t, file);
  await assert.rejects(sessions.cancelQueued("claude", A, message.id), /Could not save/);
  assert.equal(outbox.list(A)[0]?.id, message.id, "the queue must agree with the refused cancellation");
  refused.mock.restore();
  assert.equal(createOutbox({ file }).list(A)[0]?.id, message.id);
  assert.deepEqual(await sessions.cancelQueued("claude", A, message.id), { deleted: true });
  assert.deepEqual(outbox.list(A), []);
  assert.deepEqual(createOutbox({ file }).list(A), []);
  assert.deepEqual(sent, []);
});

for (const typeIntoApp of [true, false]) {
const backend = typeIntoApp ? "app-preferred delivery (Code fallback on Windows)" : "Claude Code delivery";
test(`removing a paused queue head resumes the messages waiting behind it through ${backend}`, async (t) => {
  const outbox = createOutbox();
  const paused = outbox.add(A, { text: "Uncertain delivery", via: "app" });
  outbox.pause(A, paused.id, "Check delivery before continuing");
  outbox.add(A, { text: "Still needs to go", via: "app" });
  const sent = [];
  const sessions = sessionsWith(t, outbox, async (_id, body) => sent.push(body.text), typeIntoApp);
  // Let the startup worker observe the paused head and stop.
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(sent, []);
  await sessions.cancelQueued("claude", A, paused.id);
  assert.ok(await waitFor(() => sent.length === 1), "the remaining message should resume without another send or a restart");
  assert.deepEqual(sent, ["Still needs to go"]);
  assert.deepEqual(outbox.list(A), []);
});

test(`reordering a blocked queue wakes delivery for the message moved to the front through ${backend}`, async (t) => {
  const outbox = createOutbox();
  const blocked = outbox.add(A, { text: "Wait for its app chat", via: "app" });
  const ready = outbox.add(A, { text: "Ready now", via: "app" });
  const sent = [];
  const sessions = sessionsWith(t, outbox, async (_id, body) => {
    if (body.text === blocked.text)
      throw Object.assign(new Error("The first message cannot go yet"), { waiting: true });
    sent.push(body.text);
  }, typeIntoApp);
  assert.ok(await waitFor(() => !!outbox.list(A)[0]?.error));
  await sessions.reorderQueued("claude", A, [ready.id, blocked.id]);
  assert.ok(await waitFor(() => sent.length === 1), "moving a ready message ahead should wake the sleeping queue worker");
  assert.deepEqual(sent, ["Ready now"]);
  assert.equal(outbox.list(A)[0]?.id, blocked.id);
});
}
