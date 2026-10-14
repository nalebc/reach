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

function priorityStage(t, { priority = ["codex", "claude", "gemini", "openclaw"], source = "codex", health: offered, notify } = {}) {
  const h = setup(t);
  if (notify) h.options.notify = notify;
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

test("priority continues once, skips read-only Gemini, and never moves the continued chat again", async t => {
  const h = priorityStage(t);
  await h.relays.start(h.body);
  h.limit("codex");
  await h.settle();
  assert.deepEqual(h.moves.map(m => m.options.to), ["claude"]);
  assert.equal(h.relays.list()[0].state, "done");
  h.limit("claude");
  await h.settle();
  assert.equal(h.moves.length, 1, "the continued chat is not continued again automatically");
});

test("custom order is honored and availability is checked when usage runs out", async t => {
  const h = priorityStage(t, { priority: ["codex", "openclaw", "claude", "gemini"] });
  h.health.find(x => x.agent === "openclaw").connected = false;
  await h.relays.start(h.body);
  h.health.find(x => x.agent === "openclaw").connected = true;
  h.limit("codex");
  await h.settle();
  assert.deepEqual(h.moves.map(m => m.options.to), ["openclaw"]);
  assert.equal(h.sends.length, 1);
  assert.match(h.sends[0].body.text, /Don't send anything to WhatsApp/);
});

test("auto-continue is refused on a chat that is already a continuation", async t => {
  const h = priorityStage(t);
  h.pages.codex.session.movedFrom = { agent: "claude", id: "earlier" };
  await assert.rejects(h.relays.start(h.body), { status: 409, message: /already continued/ });
  assert.equal(h.relays.list().length, 0);
});

test("a watch saved before the chat was continued stops instead of moving it again", async t => {
  const h = priorityStage(t);
  await h.relays.start(h.body);
  h.pages.codex.session.movedFrom = { agent: "claude", id: "earlier" };
  h.limit("codex");
  await h.settle();
  assert.equal(h.moves.length, 0);
  assert.equal(h.relays.list()[0].state, "stopped");
  assert.match(h.relays.list()[0].problem, /already continued/);
});

test("unavailable providers are skipped without creating a chat", async t => {
  const h = priorityStage(t);
  h.health.find(x => x.agent === "claude").usable = false;
  await h.relays.start(h.body);
  h.limit("codex");
  await h.settle();
  assert.deepEqual(h.moves.map(m => m.options.to), ["openclaw"]);
});

test("priority is preserved across a restart before the move", async t => {
  const h = priorityStage(t);
  await h.relays.start(h.body);
  const restored = createRelays(h.options);
  assert.deepEqual(restored.list()[0].priority, h.body.priority);
  h.limit("codex");
  await restored.check();
  h.advance(11);
  await restored.check();
  assert.deepEqual(h.moves.map(m => m.options.to), ["claude"]);
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
  // Without this chat's own provider, or not an order at all. This chat
  // alone is an order (it continues here): see the test below.
  for (const priority of [[], ["claude"], ["codex", "codex"], ["codex", "unknown"], ["claude", "gemini"], "codex"])
    await assert.rejects(h.relays.start({ ...h.body, priority }), { status: 400 });
  await assert.rejects(h.relays.start({ ...h.body, steps: [{ kind: "build", agent: "claude" }] }), { status: 400 });
});

test("simultaneous enables create only one priority watch", async t => {
  const h = priorityStage(t);
  const results = await Promise.allSettled([h.relays.start(h.body), h.relays.start(h.body)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.status, 409);
  assert.equal(h.relays.list().length, 1);
});

// Fail-open audit (Oct 8): meters that couldn't be read are not "has usage".
test("a chat is never moved into an agent whose usage is unknown", async () => {
  const { continueUnavailable } = await import("../server/agent-sessions/auto-continue.mjs");
  const h = (usable) => [{ agent: "codex", installed: true, signedIn: true, ...(usable === undefined ? {} : { usable }) }];
  assert.equal(continueUnavailable("codex", h(true)), "");
  assert.equal(continueUnavailable("codex", h(false)), "Out of usage");
  assert.equal(continueUnavailable("codex", h(undefined)), "Usage unknown");
});

// Meters in a shape Reach doesn't read are unknown, never "plenty left".
test("usage meters Reach can't read are unavailable, not empty and fine", async () => {
  const { codexUsage, claudeUsage } = await import("../server/agent-sessions/account-usage.mjs");
  assert.equal(codexUsage({ rateLimits: { renamed: {} } }).available, false);
  assert.equal(codexUsage({ rateLimits: { primary: { usedPercent: 40 } } }).available, true);
  assert.equal(claudeUsage({ newShape: [] }).available, false);
  assert.equal(claudeUsage({ limits: "x" }).available, false);
  assert.equal(claudeUsage({ five_hour: { utilization: 12 } }).available, true);
});

// Oct 9: none free when usage runs out → it waits; the first one back takes it.
test("with no provider free, it waits and the first one back takes the work", async t => {
  const h = priorityStage(t, { priority: ["codex", "claude", "openclaw"] });
  for (const x of h.health) if (x.agent !== "openclaw") x.usable = false;
  h.health.find(x => x.agent === "openclaw").connected = false;
  await h.relays.start(h.body);
  h.limit("codex");
  await h.settle();
  assert.equal(h.moves.length, 0);
  assert.equal(h.relays.list()[0].state, "waiting");
  assert.equal(h.relays.list()[0].holding, true);
  h.health.find(x => x.agent === "openclaw").connected = true;
  await h.relays.check();
  assert.equal(h.moves.length, 0, "read again at most once a minute");
  h.advance(60 * 1000);
  await h.relays.check();
  assert.deepEqual(h.moves.map(m => m.options.to), ["openclaw"]);
  assert.equal(h.relays.list()[0].state, "done");
});

test("when several come back at once, the order decides; this chat's own provider counts", async t => {
  const h = priorityStage(t, { priority: ["claude", "codex", "openclaw"] });
  for (const x of h.health) x.usable = false;
  h.health.find(x => x.agent === "openclaw").connected = false;
  await h.relays.start(h.body);
  h.limit("codex");
  await h.settle();
  h.health.find(x => x.agent === "openclaw").connected = true;
  h.health.find(x => x.agent === "codex").usable = true;
  h.advance(60 * 1000);
  await h.relays.check();
  assert.equal(h.moves.length, 0);
  assert.deepEqual(h.sends.map(s => [s.agent, s.id]), [["codex", "original"]]);
  assert.equal(h.relays.list()[0].state, "done");
});

// Oct 14: "what if I want to continue in same chat when back".
test("this chat alone waits for its own usage and continues here, never moving the chat", async t => {
  const notes = [];
  const h = priorityStage(t, { priority: ["codex"], notify: (n) => notes.push(n) });
  for (const x of h.health) x.usable = false;
  await h.relays.start(h.body);
  h.limit("codex");
  await h.settle();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.relays.list()[0].state, "waiting");
  assert.equal(h.relays.list()[0].holding, true);
  assert.deepEqual(notes.map((n) => n.body), ["Codex ran out of usage. Continues here when it's back."]);
  // Another provider with usage changes nothing: only this chat was chosen.
  h.health.find(x => x.agent === "claude").usable = true;
  h.advance(60 * 1000);
  await h.relays.check();
  assert.deepEqual([h.moves.length, h.sends.length], [0, 0]);
  h.health.find(x => x.agent === "codex").usable = true;
  h.advance(60 * 1000);
  await h.relays.check();
  assert.equal(h.moves.length, 0);
  assert.deepEqual(h.sends.map(s => [s.agent, s.id, s.body.text]), [["codex", "original", "Your usage is back. Continue where you left off."]]);
  assert.equal(h.relays.list()[0].state, "done");
});

test("a held watch expires after a day and lets go when continued by hand", async t => {
  const h = priorityStage(t);
  for (const x of h.health) x.usable = false;
  h.health.find(x => x.agent === "openclaw").connected = false;
  await h.relays.start(h.body);
  h.limit("codex");
  await h.settle();
  h.pages.codex.items.push({ id: "by-hand", role: "user", kind: "text", text: "Go on" });
  await h.relays.check();
  assert.equal(h.relays.list()[0].holding, undefined);
  assert.equal(h.relays.list()[0].state, "waiting");
  h.limit("codex");
  h.pages.codex.items.at(-1).id = "limit-2";
  await h.settle();
  assert.equal(h.relays.list()[0].holding, true);
  h.advance(WAIT_MS + 1);
  await h.relays.check();
  assert.equal(h.relays.list()[0].state, "stopped");
  assert.match(h.relays.list()[0].problem, /No provider was free/);
});
