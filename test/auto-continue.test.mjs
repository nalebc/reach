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

function priorityStage(t, { priority = ["codex", "claude", "gemini", "openclaw"], source = "codex", health: offered } = {}) {
  const h = setup(t);
  const pages = Object.fromEntries(["codex", "claude", "openclaw"].map(agent => [agent, {
    session: { title: "Work", cwd: "/work", status: "idle" },
    items: [{ id: `${agent}-u`, role: "user", kind: "text", text: "Finish" }],
  }]));
  const health = offered || ["codex", "claude", "gemini", "openclaw"].map(agent => ({ agent, installed: true, signedIn: true, usable: true, connected: true, canTakeMoves: true }));
  const moves = [], sends = [];
  h.options.sessions = {
    list: async () => ({ sessions: [] }),
    health: async () => health,
    read: async (agent) => structuredClone(pages[agent]),
    move: async (agent, id, options) => {
      options.authorize();
      moves.push({ agent, options });
      return { agent: options.to, id: `${options.to}-new`, resumed: options.resume };
    },
    send: async (agent, id, body) => { body.authorize(); sends.push({ agent, id, body }); },
  };
  const relays = createRelays(h.options);
  const body = { owner: "phone", from: { agent: source, id: "original" }, trigger: "usage", priority };
  const limit = (agent) => pages[agent].items.push({ id: `${agent}-limit`, kind: "error", role: "system", text: "You've hit your usage limit." });
  return { ...h, relays, pages, health, moves, sends, body, limit, settle: () => h.settle(relays) };
}

test("priority continues through multiple providers, skips read-only Gemini, and never loops", async t => {
  const h = priorityStage(t);
  await h.relays.start(h.body);
  h.limit("codex");
  await h.settle();
  assert.deepEqual(h.moves.map(m => m.options.to), ["claude"]);
  assert.equal(h.relays.list()[0].state, "waiting");
  h.limit("claude");
  await h.settle();
  assert.deepEqual(h.moves.map(m => m.options.to), ["claude", "openclaw"]);
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0].body.text, /Don't send anything to WhatsApp/);
  assert.equal(h.relays.list()[0].state, "done");
  h.limit("openclaw");
  await h.settle();
  assert.equal(h.moves.length, 2);
});

test("custom order is honored and availability is rechecked when usage runs out", async t => {
  const h = priorityStage(t, { priority: ["codex", "openclaw", "claude", "gemini"] });
  await h.relays.start(h.body);
  h.limit("codex");
  await h.settle();
  assert.equal(h.moves[0].options.to, "openclaw");
  // Claude loses its sign-in after the watch was enabled.
  h.health.find(x => x.agent === "claude").signedIn = false;
  h.limit("openclaw");
  await h.settle();
  assert.equal(h.moves.length, 1);
  assert.equal(h.relays.list()[0].state, "stopped");
  assert.match(h.relays.list()[0].problem, /No unused provider/);
});

test("unavailable providers are skipped without creating a chat", async t => {
  const h = priorityStage(t);
  h.health.find(x => x.agent === "claude").usable = false;
  await h.relays.start(h.body);
  h.limit("codex");
  await h.settle();
  assert.deepEqual(h.moves.map(m => m.options.to), ["openclaw"]);
});

test("priority is preserved across a restart between fallback hops", async t => {
  const h = priorityStage(t);
  await h.relays.start(h.body);
  h.limit("codex");
  await h.settle();
  const restored = createRelays(h.options);
  assert.deepEqual(restored.list()[0].priority, h.body.priority);
  h.limit("claude");
  await restored.check();
  h.advance(11);
  await restored.check();
  assert.deepEqual(h.moves.map(m => m.options.to), ["claude", "openclaw"]);
});

for (const action of ["cancel", "revoke"]) test(`${action} while checking availability prevents a move`, async t => {
  const h = priorityStage(t);
  const { relay } = await h.relays.start(h.body);
  h.options.sessions.health = async () => {
    if (action === "cancel") h.relays.cancel(relay.id);
    else h.revoke();
    return h.health;
  };
  h.limit("codex");
  await h.settle();
  assert.equal(h.moves.length, 0);
  assert.equal(h.relays.list()[0].state, "stopped");
});

test("malformed, duplicate, unsupported, or ambiguous priorities are rejected", async t => {
  const h = priorityStage(t);
  for (const priority of [[], ["codex"], ["codex", "codex"], ["codex", "unknown"], ["claude", "gemini"], ["codex", "gemini"]])
    await assert.rejects(h.relays.start({ ...h.body, priority }), { status: 400 });
  await assert.rejects(h.relays.start({ ...h.body, steps: [{ kind: "build", agent: "claude" }] }), { status: 400 });
});

test("a later move out of OpenClaw keeps the original project folder", async t => {
  const h = priorityStage(t, { priority: ["codex", "openclaw", "claude"] });
  await h.relays.start(h.body);
  h.limit("codex");
  await h.settle();
  h.limit("openclaw");
  await h.settle();
  assert.equal(h.moves[1].options.to, "claude");
  assert.equal(h.moves[1].options.cwd, "/work");
});

test("simultaneous enables create only one priority watch", async t => {
  const h = priorityStage(t);
  const results = await Promise.allSettled([h.relays.start(h.body), h.relays.start(h.body)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.status, 409);
  assert.equal(h.relays.list().length, 1);
});
