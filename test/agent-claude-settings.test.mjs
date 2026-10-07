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
    claude: { read: async () => ({ session: { ...native }, items: [] }), list: async () => [], starts: async () => [] },
    claudeHost: {
      drives: () => false, close() {},
      models: async () => [
        { value: "opus", resolvedModel: "claude-opus-5-5" },
        { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
        { value: "default", resolvedModel: "claude-opus-5-5" },
      ],
    },
    claudeOpen: async () => true,
    claudeCompose: {
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

test("an unconfirmed effort click with an unchanged native record never reports applied", async (t) => {
  const { sessions, native } = await fixture(t, { effort: async () => ({ effort: "high", unconfirmed: true }) });
  await assert.rejects(sessions.model("claude", ID, { effort: "high" }), (e) => e.status === 409 && /confirm/.test(e.message));
  assert.equal(native.effort, "medium");
});

test("the native record can confirm an effort change when the chip has not redrawn", async (t) => {
  let native;
  const result = await fixture(t, { effort: async () => { native.effort = "high"; return { effort: "high", unconfirmed: true }; } });
  native = result.native;
  assert.deepEqual(await result.sessions.model("claude", ID, { effort: "high" }), { model: undefined, effort: "high", applied: true });
});


test("missing or mismatched native effort acknowledgements fail unless the actual record confirms", async (t) => {
  for (const response of [undefined, {}, { effort: "low" }]) {
    const { sessions, native } = await fixture(t, { effort: async () => response });
    await assert.rejects(sessions.model("claude", ID, { effort: "high" }), (e) => e.status === 409 && /confirm/.test(e.message));
    assert.equal(native.effort, "medium");
  }
});
