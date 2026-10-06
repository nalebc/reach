import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeCompose, typeIntoClaude } from "../server/agent-sessions/claude-compose.mjs";

const A = "11111111-2222-4333-8444-555555555555";
const B = "22222222-2222-4333-8444-555555555555";

// The Claude app's window: the chat on screen first; deep links switch it,
// after `delay` looks (as the app takes a moment).
const mac = ({ onScreen = B, idle = 600, running = true, delay = 2, lands = true } = {}) => {
  const state = { onScreen, idle, running, opened: [], typed: [], pending: null, looks: 0, arrived: true };
  state.shown = () => {
    if (state.pending && ++state.looks >= delay) {
      state.onScreen = state.pending;
      state.pending = null;
    }
    const others = [A, B].filter((id) => id !== state.onScreen);
    return [state.onScreen, ...others].map((id, i) => ({ id, session: `local_${id}`, at: 100 - i }));
  };
  state.open = async (url) => {
    state.opened.push(url);
    if (lands) state.pending = url.split("local_")[1];
    state.looks = 0;
  };
  return state;
};
const compose = (m, extra = {}) =>
  createClaudeCompose({
    type: async (message) => {
      if (m.onScreen !== A) throw Object.assign(new Error("The Claude app is showing another chat."), { waiting: true });
      m.typed.push(message);
    },
    open: m.open,
    arrived: async () => m.arrived,
    shown: m.shown,
    idle: async () => m.idle,
    appRunning: async () => m.running,
    wait: async () => {},
    switchMs: 50,
    confirmMs: 20,
    ...extra,
  });
const message = { title: "Fix the chart", text: "Run the tests", images: ["/data/agent-images/p.png"] };

test("draft updates only touch the visible chat, compare the previous value and never submit", async () => {
  const m = mac({ onScreen: A });
  let native = "";
  const c = compose(m, { type: async (value) => {
    m.typed.push(value);
    if (value.expected !== native) throw Error("draft changed");
    native = value.text;
    return { drafted: true };
  } });
  await c.draft(A, { title: message.title, text: "hel", owner: "phone" });
  await c.draft(A, { title: message.title, text: "hello", owner: "phone" });
  assert.deepEqual(m.typed.map((v) => [v.draft, v.expected]), [[true, ""], [true, "hel"]]);
  await assert.rejects(c.draft(A, { title: message.title, text: "stolen", owner: "other" }), /Another device/);
  native = "Edited on Mac";
  await assert.rejects(c.draft(A, { title: message.title, text: "overwrite", owner: "phone" }), /draft changed/);
  assert.equal(native, "Edited on Mac");
  m.onScreen = B;
  await assert.rejects(c.draft(A, { title: message.title, text: "wrong chat", owner: "phone" }), /visible/);
  assert.deepEqual(m.opened, []);
});

test("Send reuses the prepared draft and Stop requires confirmation from the exact app chat", async () => {
  const m = mac({ onScreen: A });
  const c = compose(m, { type: async (value) => (m.typed.push(value), value.draft ? { drafted: true } : value.stop ? { stopped: true } : { sent: true }) });
  await c.draft(A, { title: message.title, text: message.text, owner: "phone" });
  await c.deliver(A, { ...message, owner: "phone" });
  assert.equal(m.typed.at(-1).expected, message.text);
  assert.deepEqual(await c.stop(A, { title: message.title }), { stopped: true });
  assert.deepEqual(m.typed.at(-1), { title: message.title, stop: true });
});

test("a message to the chat on screen goes into the Claude app's box at once, nothing switched", async () => {
  const m = mac({ onScreen: A, idle: 0 });
  assert.deepEqual(await compose(m).deliver(A, message), { delivered: true });
  assert.deepEqual(m.typed, [message]);
  assert.deepEqual(m.opened, []);
});

test("another chat on screen: it waits while someone uses the Mac, then opens the chat, sends, and puts the window back", async () => {
  const m = mac({ onScreen: B, idle: 5 });
  // In use: never switched under someone typing.
  await assert.rejects(compose(m).deliver(A, message), (e) => e.waiting && /open this chat in the Claude app, or step away/.test(e.message));
  assert.deepEqual(m.opened, []);
  assert.deepEqual(m.typed, []);
  // Away: switched, sent, switched back to what was on screen.
  m.idle = 600;
  assert.deepEqual(await compose(m).deliver(A, message), { delivered: true });
  assert.deepEqual(m.typed, [message]);
  assert.deepEqual(m.opened, [`claude://code/continue?session=local_${A}`, `claude://code/continue?session=local_${B}`]);
});

test("nothing is typed unless the window really shows the chat; a switch that doesn't land is undone and retried later", async () => {
  const m = mac({ onScreen: B, lands: false });
  await assert.rejects(compose(m).deliver(A, message), (e) => e.waiting && /didn't open this chat/.test(e.message));
  assert.deepEqual(m.typed, []);
  assert.deepEqual(m.opened, [`claude://code/continue?session=local_${A}`, `claude://code/continue?session=local_${B}`]);
  // The helper's own refusal (another chat, a draft) keeps it waiting, and the window goes back.
  const draft = mac({ onScreen: B });
  const refusing = compose(draft, {
    type: async () => {
      throw Object.assign(new Error("There's a draft in that chat on your Mac."), { waiting: true });
    },
  });
  await assert.rejects(refusing.deliver(A, message), /draft/);
  assert.equal(draft.opened.at(-1), `claude://code/continue?session=local_${B}`);
});

test("the Claude app closed, or not listing the chat: it waits, saying so; taken but not yet in the transcript is never sent twice", async () => {
  await assert.rejects(compose(mac({ onScreen: A, running: false })).deliver(A, message), /Claude app is open/);
  const unlisted = mac({ onScreen: A });
  await assert.rejects(compose(unlisted).deliver("33333333-2222-4333-8444-555555555555", message), /doesn't list this chat/);
  const slow = mac({ onScreen: A });
  slow.arrived = false;
  assert.deepEqual(await compose(slow).deliver(A, message), { delivered: true, unconfirmed: true });
  assert.equal(slow.typed.length, 1);
});

test("the helper is given the chat's title, the text and each picture, and its refusals come back as reasons", async () => {
  const runs = [];
  const helper = (stdout) => ({ binary: async () => "/data/reach-claude-compose", run: async (...args) => (runs.push(args), { stdout }) });
  assert.deepEqual(await typeIntoClaude(message, helper('{"sent":true}\n')), { sent: true });
  assert.deepEqual(runs[0][1], ["--title", "Fix the chart", "--text", "Run the tests", "--image", "/data/agent-images/p.png"]);
  await assert.rejects(typeIntoClaude(message, helper('{"error":"There\'s a draft in that chat on your Mac.","draft":true}')), (e) => e.waiting && /draft/.test(e.message));
  await assert.rejects(typeIntoClaude(message, helper("garbage")), (e) => e.waiting);
});

test("a permission mode picked on the phone is picked in the Claude app's own menu; never Bypass", async () => {
  // On screen: picked in the app at once, by the name its menu gives it.
  const m = mac({ onScreen: A });
  const c = compose(m, { type: async (v) => (m.typed.push(v), v.mode ? { mode: v.mode } : {}) });
  assert.deepEqual(await c.mode(A, { title: message.title, mode: "acceptEdits" }), { mode: "acceptEdits" });
  assert.deepEqual(await c.mode(A, { title: message.title, mode: "default" }), { mode: "default" });
  assert.deepEqual(m.typed.map((v) => v.mode), ["Accept edits", "Manual"]);
  await assert.rejects(c.mode(A, { title: message.title, mode: "bypassPermissions" }), (e) => e.status === 400);
  // Another chat on screen: never switched for a mode; it goes with the next message.
  const away = mac({ onScreen: B });
  await assert.rejects(compose(away).mode(A, { title: message.title, mode: "plan" }), /with your next message/);
  assert.deepEqual(away.opened, []);
  // That next message: the mode first, then the text, as in the app's composer.
  const next = mac({ onScreen: A });
  await compose(next).deliver(A, { title: message.title, text: "Go", mode: "plan" });
  assert.deepEqual(next.typed.map((v) => v.mode || v.text), ["Plan", "Go"]);
});

test("the helper is told the mode by the name the Claude app's menu uses, with nothing else", async () => {
  const calls = [];
  await typeIntoClaude(
    { title: "Fix the chart", mode: "Plan", images: ["/x.png"] },
    { binary: async () => "/bin/helper", run: (file, args) => (calls.push(args), Promise.resolve({ stdout: '{"mode":"Plan"}\n' })) },
  );
  assert.deepEqual(calls, [["--title", "Fix the chart", "--mode", "Plan"]]);
});
