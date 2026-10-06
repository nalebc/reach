import test from "node:test";
import assert from "node:assert/strict";
import { createDoneWatch } from "../server/agent-sessions/done-watch.mjs";

// "I'm not getting notified when sessions are done." A chat that was working
// (or waiting on you) and is now finished sends one notification that opens
// that chat, unless a phone has it open right then.
const watch = (lists, { watching = () => false } = {}) => {
  const sent = [];
  let i = 0;
  const w = createDoneWatch({
    list: async () => ({ sessions: lists[Math.min(i++, lists.length - 1)] }),
    notify: async (m) => sent.push(m),
    watching,
    setTimer: () => null,
    clearTimer: () => {},
  });
  return { w, sent };
};
const chat = (status, extra = {}) => ({ agent: "claude", id: "11111111-2222-4333-8444-555555555555", title: "Fix login", status, ...extra });

test("a chat that finishes sends one notification that opens it", async () => {
  const { w, sent } = watch([[chat("running")], [chat("running")], [chat("idle")], [chat("idle")]]);
  await w.look(); // learns the states: nothing sent for what was already so
  await w.look();
  await w.look();
  await w.look();
  assert.deepEqual(sent, [
    {
      category: "done",
      // Who, never the chat's words (lock screens).
      title: "Claude Code · Ready for you",
      body: "The response is ready. Open the conversation to continue.",
      icon: "claude",
      actions: [{ action: "open", title: "Open conversation" }],
      tag: "done-claude-11111111-222",
      url: "/?page=sessions&agent=claude&id=11111111-2222-4333-8444-555555555555",
    },
  ]);
});

test("finished after waiting on you counts; already finished, still working or open on a phone doesn't", async () => {
  let { w, sent } = watch([[chat("waiting")], [chat("idle")]]);
  await w.look();
  await w.look();
  assert.equal(sent.length, 1);
  ({ w, sent } = watch([[chat("idle")], [chat("idle")], [chat("running")]]));
  for (let n = 0; n < 3; n++) await w.look();
  assert.equal(sent.length, 0);
  ({ w, sent } = watch([[chat("running")], [chat("idle")]], { watching: () => true }));
  await w.look();
  await w.look();
  assert.equal(sent.length, 0, "the open chat shows its own reply");
});

test("a list that fails is skipped without losing what it knew", async () => {
  const sent = [];
  let call = 0;
  const w = createDoneWatch({
    list: async () => {
      call++;
      if (call === 2) throw new Error("busy");
      return { sessions: [chat(call === 1 ? "running" : "idle")] };
    },
    notify: async (m) => sent.push(m),
    setTimer: () => null,
    clearTimer: () => {},
  });
  await w.look();
  await w.look();
  await w.look();
  assert.equal(sent.length, 1);
});
