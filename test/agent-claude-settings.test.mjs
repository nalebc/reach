import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";

const ID = "11111111-2222-4333-8444-555555555555";
async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-native-settings-"));
  const native = { agent: "claude", id: ID, inApp: true, appTitle: "Audit only", model: "claude-opus-5-5", effort: "medium" };
  const calls = [];
  const sessions = createAgentSessions({
    dataDir,
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {}, close() {} },
    codex: { list: async () => [] },
    claude: {
      read: async () => ({ session: { ...native }, items: [] }), list: async () => [], starts: async () => [],
      appEffort: async (id, effort) => (calls.push({ id, record: effort }), true),
      health: async () => ({ agent: "claude", installed: true, signedIn: true, usable: true }),
    },
    claudeHost: {
      drives: () => false, close() {},
      send: async (id, message) => (calls.push({ id, sent: message }), { ok: true }),
      running: () => false, view: () => ({}),
      models: async () => [
        { value: "opus", resolvedModel: "claude-opus-5-5" },
        { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
        { value: "default", resolvedModel: "claude-opus-5-5" },
      ],
    },
    claudeOpen: async () => true,
    // The Claude app's window helper is the Mac's (no Windows twin yet): modeled on every host.
    platform: "darwin", typeIntoApp: true, claudeCompose: {
      model: async (id, value) => (calls.push({ id, ...value }), { model: value.model }),
      effort: async (id, value) => (calls.push({ id, ...value }), { effort: value.effort }),
      ...overrides,
    },
    signIn: {},
    live: async () => new Map(),
    claudeImports: { close() {} }, claudeRefresh: { close() {} },
    detect: async () => [], proactive: false,
  });
  t.after(async () => { sessions.close(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { sessions, native, calls };
}

test("desktop Claude resolves the catalog model to its exact native menu name", async (t) => {
  const { sessions, calls } = await fixture(t);
  assert.deepEqual(await sessions.model("claude", ID, { model: "sonnet" }), { model: "sonnet", effort: undefined, applied: true });
  assert.deepEqual(calls, [{ id: ID, title: "Audit only", model: "Sonnet 5.5" }]);
});

test("unknown desktop models fail before touching any native control", async (t) => {
  const { sessions, calls } = await fixture(t);
  await assert.rejects(sessions.model("claude", ID, { model: "invented" }), (e) => e.status === 409 && /identify/.test(e.message));
  assert.deepEqual(calls, []);
});

test("an unconfirmed native model click never reports applied", async (t) => {
  const { sessions } = await fixture(t, { model: async () => ({ model: "Sonnet 5.5", unconfirmed: true }) });
  await assert.rejects(sessions.model("claude", ID, { model: "sonnet" }), (e) => e.status === 409 && /confirm/.test(e.message));
});

// Oct 10: never by a click in the Claude app's menu. Kept for the chat and
// written in the app's record; its next message from the phone goes to
// Claude Code at that level, never typed into the app's process.
test("an effort picked on the phone is kept and its next message runs at it, with no click in the app", async (t) => {
  const { sessions, calls } = await fixture(t, { effort: async () => { throw new Error("clicked the menu"); } });
  assert.deepEqual(await sessions.model("claude", ID, { effort: "max" }), { model: undefined, effort: "max", applied: true });
  assert.deepEqual(calls, [{ id: ID, record: "max" }]);
  assert.equal((await sessions.read("claude", ID, { limit: 1 })).session.effort, "max");
  await sessions.send("claude", ID, { text: "Go on" });
  const sent = calls.find((c) => c.sent)?.sent;
  assert.equal(sent?.effort, "max");
  assert.equal(sent?.text, "Go on");
});
