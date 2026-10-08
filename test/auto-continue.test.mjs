import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRelays, WAIT_MS } from "../server/agent-sessions/relays.mjs";

function setup(t, { agent = "claude", error = "", resumed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-auto-continue-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = 1000, access = "";
  const page = { session: { title: "Work", cwd: "/work", status: "idle" }, items: [{ id: "u", role: "user", kind: "text", text: "Finish the feature" }] };
  const end = (text, kind = "error", role = "system") => page.items.push({ id: `i${page.items.length}`, role, kind, text });
  if (error) end(error);
  const moves = [];
  const sessions = {
    list: async () => ({ sessions: [] }), read: async () => structuredClone(page),
    async move(source, id, options) {
      options.authorize();
      moves.push({ source, id, options });
      return { agent: options.to, id: "new-chat", resumed, resumeError: resumed ? undefined : "Sign in again" };
    },
  };
  const options = { sessions, file: path.join(dir, "relays.json"), now: () => clock, authorized: () => access,
    settleMs: 10, setTimer: () => 0, setEvery: () => 0, clearEvery() {} };
  const relays = createRelays(options);
  const body = { owner: "phone", from: { agent, id: "original" }, trigger: "usage", steps: [{ kind: "build", agent: agent === "claude" ? "codex" : "claude" }] };
  const settle = async (r = relays) => { await r.check(); clock += 11; await r.check(); };
  return { relays, options, body, page, moves, end, settle, revoke: () => { access = "Phone revoked"; }, advance: (ms) => { clock += ms; } };
}

for (const agent of ["claude", "codex"]) test(`${agent} usage exhaustion moves history and resumes once, including an existing limit`, async t => {
  const h = setup(t, { agent, error: "You've hit your usage limit." });
  await h.relays.start(h.body);
  await h.settle();
  await h.settle();
  assert.equal(h.moves.length, 1);
  assert.equal(h.moves[0].options.resume, true);
  assert.equal(h.moves[0].options.owner, "phone");
  assert.equal(h.relays.list()[0].state, "done");
  assert.equal(h.relays.list()[0].chain.at(-1).id, "new-chat");
});

test("ordinary replies, transient errors, stops, and active turns do not switch", async t => {
  const h = setup(t);
  await h.relays.start(h.body);
  for (const [text, kind, role] of [["Done", "text", "assistant"], ["Request rejected (429)", "error", "system"], ["Stopped", "notice", "system"]]) {
    h.end(text, kind, role);
    await h.settle();
    assert.equal(h.moves.length, 0);
  }
  h.page.items.push({ id: "u2", role: "user", kind: "text", text: "Continue" });
  h.end("Claude usage limit reached");
  h.page.session.status = "running";
  await h.settle();
  assert.equal(h.moves.length, 0);
  h.page.session.status = "idle";
  await h.settle();
  assert.equal(h.moves.length, 1);
});

for (const action of ["cancel", "revoke", "expire"]) test(`${action} prevents auto-continuation`, async t => {
  const h = setup(t);
  const { relay } = await h.relays.start(h.body);
  h.end("Claude usage limit reached");
  if (action === "cancel") h.relays.cancel(relay.id);
  if (action === "revoke") h.revoke();
  if (action === "expire") h.advance(WAIT_MS + 1);
  await h.settle();
  assert.equal(h.moves.length, 0);
  assert.equal(h.relays.list()[0].state, "stopped");
});

test("a saved watch survives restart and failed resume retains the destination without retrying", async t => {
  const h = setup(t, { resumed: false });
  await h.relays.start(h.body);
  const restored = createRelays(h.options);
  h.end("Claude usage limit reached");
  await h.settle(restored);
  await h.settle(restored);
  assert.equal(h.moves.length, 1);
  assert.equal(restored.list()[0].state, "stopped");
  assert.equal(restored.list()[0].problem, "Sign in again");
  assert.equal(restored.list()[0].chain.at(-1).id, "new-chat");
});

test("auto-continue validates its destination and trigger", async t => {
  const h = setup(t);
  for (const extra of [{ trigger: "oops" }, { now: true }, { steps: [{ kind: "build", agent: "claude" }] }, { steps: [{ kind: "review", agent: "codex" }] }])
    await assert.rejects(h.relays.start({ ...h.body, ...extra }), { status: 400 });
});
