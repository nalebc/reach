import test from "node:test";
import assert from "node:assert/strict";
import { changedFiles, createTurnWatch, turnOutcome, usageLimited } from "../server/agent-sessions/turn-watch.mjs";

// A turn's end is read from the chat, not guessed from the list's status
// (server/agent-sessions/turn-watch.mjs).
const user = (id, text = "Do it") => ({ id, role: "user", kind: "text", text });
const reply = (id, text = "Done.") => ({ id, role: "assistant", kind: "text", text });
const edit = (id, text) => ({ id, role: "tool", kind: "file-change", text, detail: "+a" });
// A timer's work runs on: let it finish.
const fire = async (timer) => (timer(), await new Promise((r) => setImmediate(r)));

test("a turn ends on a reply only when the agent's words come after your last message", () => {
  assert.equal(turnOutcome([user("u1"), reply("a1")]).kind, "reply");
  assert.equal(turnOutcome([user("u1"), reply("a1")]).item.id, "a1");
  assert.equal(turnOutcome([user("u1"), reply("a1"), edit("e1", "a.ts")]).kind, "open", "still working after it spoke");
  assert.equal(turnOutcome([reply("a0"), user("u1")]).kind, "open", "nothing after your message yet");
  assert.equal(turnOutcome([user("u1"), reply("a1"), { id: "n", role: "system", kind: "notice", text: "Stopped" }]).kind, "stopped");
  const failed = turnOutcome([user("u1"), { id: "x", role: "system", kind: "error", text: "You’ve hit your usage limit." }]);
  assert.equal(failed.kind, "error");
  assert.equal(usageLimited("codex", failed.item), true);
  assert.equal(usageLimited("claude", { text: "API Error: overloaded" }), false);
  assert.equal(usageLimited("claude", { text: "Claude AI usage limit reached" }), true);
  // A question is waiting on you, not an answer.
  assert.equal(turnOutcome([user("u1"), { ...reply("a1"), questions: [{ title: "Which?", options: [] }] }]).kind, "open");
  // A notice after the reply (a move's line) doesn't hide it.
  assert.equal(turnOutcome([user("u1"), reply("a1"), { id: "m", role: "system", kind: "notice", text: "Continued with Codex" }]).kind, "reply");
  assert.deepEqual(changedFiles([edit("e1", "a.ts"), edit("e2", "b.ts, a.ts"), reply("a1")]), ["a.ts", "b.ts"]);
});

test("a chat that stops working is read again later and counts once, only if it's still not working", async () => {
  let sessions = [{ agent: "codex", id: "c1", status: "running" }];
  const pages = { c1: { session: { status: "idle" }, items: [user("u1"), reply("a1")] } };
  const timers = [];
  const ended = [];
  const watch = createTurnWatch({
    list: async () => ({ sessions }),
    read: async (agent, id) => pages[id],
    onEnded: (event) => ended.push(event),
    setTimer: (fn) => (timers.push(fn), timers.length),
    clearTimer: () => {},
    setEvery: () => 0,
    clearEvery: () => {},
  });
  await watch.look(); // learns the states
  sessions = [{ agent: "codex", id: "c1", status: "idle" }];
  await watch.look();
  await watch.look(); // the same idle again: one look, not two
  assert.equal(timers.length, 1);
  await fire(timers.shift());
  assert.equal(ended.length, 1);
  assert.equal(ended[0].session.id, "c1");
  assert.equal(ended[0].outcome.kind, "reply");

  // A blip: idle in the list, working again by the time it's read.
  sessions = [{ agent: "codex", id: "c1", status: "running" }];
  await watch.look();
  sessions = [{ agent: "codex", id: "c1", status: "idle" }];
  await watch.look();
  pages.c1 = { session: { status: "running" }, items: [user("u1"), reply("a1")] };
  await fire(timers.shift());
  assert.equal(ended.length, 1, "not ended");
  watch.stop();
});

test("the first look only learns the states", async () => {
  const timers = [];
  const watch = createTurnWatch({
    list: async () => ({ sessions: [{ agent: "claude", id: "k1", status: "idle" }] }),
    read: async () => ({ session: { status: "idle" }, items: [] }),
    setTimer: (fn) => (timers.push(fn), timers.length),
    setEvery: () => 0,
    clearEvery: () => {},
  });
  await watch.look();
  await watch.look();
  assert.equal(timers.length, 0);
  watch.stop();
});
