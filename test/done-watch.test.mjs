import test from "node:test";
import assert from "node:assert/strict";
import { createDoneWatch } from "../server/agent-sessions/done-watch.mjs";

// "I'm not getting notified when sessions are done." A chat that was working
// (or waiting on you) and is now finished sends one notification that opens
// that chat, unless a phone has it open right then.
const watch = (lists, { watching = () => false, reply } = {}) => {
  const sent = [];
  let i = 0;
  const w = createDoneWatch({
    list: async () => ({ sessions: lists[Math.min(i++, lists.length - 1)] }),
    notify: async (m) => sent.push(m),
    watching,
    reply,
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
      // On an iPhone the icon is always Reach's: the chat's name says which.
      title: "Fix login",
      body: "Claude Code finished.",
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

test("the notification shows the agent's last reply, not your prompt", async () => {
  // A Codex chat's list preview is the first thing you asked; the
  // notification reads the chat for what the agent said last.
  const codex = { ...chat("running"), agent: "codex", preview: "Please fix the login redirect" };
  const asked = [];
  const { w, sent } = watch([[codex], [{ ...codex, status: "idle" }]], {
    reply: async (agent, id) => {
      asked.push([agent, id]);
      return "## Done\n\n**Fixed** the redirect in `auth.ts`; all 42 tests pass.";
    },
  });
  await w.look();
  await w.look();
  assert.deepEqual(asked, [["codex", codex.id]]);
  assert.equal(sent[0].title, "Fix login");
  assert.equal(sent[0].body, "Codex: Done Fixed the redirect in auth.ts; all 42 tests pass.");
});

test("a chat without a name, or a reply that can't be read, still says who", async () => {
  let { w, sent } = watch([[chat("running", { title: "Untitled Claude session" })], [chat("idle", { title: "Untitled Claude session" })]], {
    reply: async () => "Looks good.",
  });
  await w.look();
  await w.look();
  assert.deepEqual([sent[0].title, sent[0].body], ["Claude Code", "Looks good."]);
  ({ w, sent } = watch([[chat("running")], [chat("idle")]], { reply: async () => { throw new Error("gone"); } }));
  await w.look();
  await w.look();
  assert.deepEqual([sent[0].title, sent[0].body], ["Fix login", "Claude Code finished."]);
});
