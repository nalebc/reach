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
// The helper: types only while the window shows that very chat, by its id,
// looking again (the app moving on) for as long as it's given (waitMs).
const helper = (m) => async (message) => {
  for (let looks = 0; `local_${m.onScreen}` !== message.session && looks < (message.waitMs ? 10 : 0); looks++) m.shown();
  if (`local_${m.onScreen}` !== message.session)
    throw Object.assign(new Error("The Claude app is showing another chat."), { waiting: true, otherChat: true });
  m.typed.push(message);
};
const compose = (m, extra = {}) =>
  createClaudeCompose({
    type: helper(m),
    onScreen: async () => `local_${m.onScreen}`,
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
    if (!value.expected.includes(native)) throw Error("draft changed");
    native = value.text;
    return { drafted: true };
  } });
  await c.draft(A, { title: message.title, text: "hel", owner: "phone" });
  await c.draft(A, { title: message.title, text: "hello", owner: "phone" });
  assert.deepEqual(m.typed.map((v) => [v.draft, v.expected]), [[true, [""]], [true, ["hel"]]]);
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
  assert.deepEqual(m.typed.at(-1).expected, [message.text]);
  assert.deepEqual(await c.stop(A, { title: message.title }), { stopped: true });
  assert.deepEqual(m.typed.at(-1), { title: message.title, session: `local_${A}`, waitMs: 0, stop: true });
});

test("a message to the chat on screen goes into the Claude app's box at once, nothing switched", async () => {
  const m = mac({ onScreen: A, idle: 0 });
  assert.deepEqual(await compose(m).deliver(A, message), { delivered: true });
  assert.deepEqual(m.typed, [{ ...message, session: `local_${A}` }]);
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
  assert.deepEqual(m.typed, [{ ...message, session: `local_${A}`, waitMs: 50, keep: true }]);
  assert.deepEqual(m.opened, [`claude://code/continue?session=local_${A}`, `claude://code/continue?session=local_${B}`]);
});

test("nothing is typed unless the window really shows the chat; a switch that doesn't land is undone and retried later", async () => {
  const m = mac({ onScreen: B, lands: false });
  await assert.rejects(compose(m).deliver(A, message), (e) => e.waiting && /didn.t open this chat/.test(e.message));
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

test("a box with text typed on the Mac never holds a message: set aside and put back once nobody is at the Mac, or with Send now", async () => {
  // At the Mac, the chat on screen: nothing set aside under someone typing,
  // tried again once they'd count as away.
  const m = mac({ onScreen: A, idle: 5 });
  const kept = [];
  const c = compose(m, {
    keepText: (id, text) => kept.push([id, text]),
    type: async (value) => {
      if (!value.keep) throw Object.assign(new Error("typed on your Mac"), { waiting: true, occupied: true });
      m.typed.push(value);
      return { sent: true, ...(m.restore === false ? { kept: "my notes" } : { restored: true }) };
    },
  });
  await assert.rejects(c.deliver(A, message), (e) => e.waiting && e.inApp && e.retryMs === 25000 && /step away/.test(e.message));
  assert.deepEqual(m.typed, []);
  // Send now: in at once, the text put back.
  assert.deepEqual(await c.deliver(A, { ...message, now: true }), { delivered: true });
  assert.equal(m.typed.at(-1).keep, true);
  // Away, another chat on screen: switched, in, and never held after a refusal.
  m.idle = 600;
  m.onScreen = B;
  m.restore = false;
  assert.deepEqual(await c.deliver(A, message), { delivered: true });
  assert.deepEqual(m.typed.at(-1), { ...message, session: `local_${A}`, waitMs: 50, keep: true });
  // Text that couldn't be put back is saved, never lost.
  assert.deepEqual(kept, [[A, "my notes"]]);
});

test("a chat the app didn't open isn't switched to again for a few minutes", async () => {
  let at = 0;
  const lost = mac({ onScreen: B, lands: false });
  const later = compose(lost, { clock: () => at, heldMs: 1000 });
  await assert.rejects(later.deliver(A, message), /didn.t open this chat/);
  await assert.rejects(later.deliver(A, message), /few minutes/);
  assert.equal(lost.opened.length, 2);
  at = 1001;
  await assert.rejects(later.deliver(A, message), /didn.t open this chat/);
  assert.equal(lost.opened.length, 4);
  // Send now still switches at once.
  await assert.rejects(later.deliver(A, { ...message, now: true }), /didn.t open this chat/);
  assert.equal(lost.opened.length, 6);
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
  await assert.rejects(typeIntoClaude(message, helper('{"error":"There\'s a draft in that chat on your Mac.","draft":true,"sent":false}')), (e) => e.waiting && /draft/.test(e.message));
  await assert.rejects(typeIntoClaude(message, helper("garbage")), (e) => e.code === "AGENT_DELIVERY_UNKNOWN");
  // keep goes as JSON (never as an argument), and text not put back comes back.
  const stdin = [];
  const keeping = { binary: async () => "/bin/helper", run: (...args) => Object.assign(Promise.resolve({ stdout: '{"error":"The Claude app switched to another chat.","kept":"my notes","sent":false}' }), { child: { stdin: { on() {}, end: (v) => stdin.push(JSON.parse(v)) } }, args }) };
  await assert.rejects(typeIntoClaude({ ...message, keep: true }, keeping), (e) => e.waiting && e.kept === "my notes");
  assert.equal(stdin[0].keep, true);
});

// A permission mode is never picked in the Claude app's menu (that click
// failed silently): it goes with Claude Code's next request (agent-asks.mjs),
// and a message sent with one is only typed, nothing else.
test("the Claude app's permission mode is never clicked, not even with a message", async () => {
  const m = mac({ onScreen: A });
  const c = compose(m);
  assert.equal(c.mode, undefined);
  await c.deliver(A, { title: message.title, text: "Go", mode: "plan" });
  assert.deepEqual(m.typed.map((v) => v.mode || v.text), ["Go"]);
  // The helper isn't told a mode either.
  const calls = [];
  await typeIntoClaude(
    { title: "Fix the chart", mode: "Plan", text: "Hi" },
    { binary: async () => "/bin/helper", run: (file, args) => (calls.push(args), Promise.resolve({ stdout: '{"sent":true}\n' })) },
  );
  assert.equal(calls[0].includes("--mode"), false);
});

// Oct 6: the phone couldn't change a Claude app chat's effort ("Reach can't
// change the model or thinking level in Claude desktop yet"). It's picked in
// the app's own menu, as the permission mode is.
test("an effort level picked on the phone is picked in the Claude app's menu, by its name there", async () => {
  const m = mac({ onScreen: A });
  const c = compose(m, { type: async (v) => (m.typed.push(v), v.effort ? { effort: v.effort } : {}) });
  assert.deepEqual(await c.effort(A, { title: message.title, effort: "xhigh" }), { effort: "xhigh", unconfirmed: false });
  assert.deepEqual(m.typed.map((v) => v.effort), ["Extra high"]);
  await assert.rejects(c.effort(A, { title: message.title, effort: "ultra" }), (e) => e.status === 400);
  // Another chat on screen: never switched for an effort level.
  const away = mac({ onScreen: B });
  await assert.rejects(compose(away).effort(A, { title: message.title, effort: "high" }), /Open this chat in the Claude app/);
  assert.deepEqual(away.opened, []);
});

test("the helper is told the effort by the menu's name, and a level the menu lacks changes nothing", async () => {
  const calls = [];
  const run = (stdout) => (file, args) => (calls.push(args), Promise.resolve({ stdout }));
  await typeIntoClaude({ title: "Fix the chart", effort: "Extra high", images: ["/x.png"] }, { binary: async () => "/bin/helper", run: run('{"effort":"Extra high"}\n') });
  assert.deepEqual(calls, [["--title", "Fix the chart", "--effort", "Extra high"]]);
  await assert.rejects(
    typeIntoClaude({ title: "Fix the chart", effort: "Max" }, { binary: async () => "/bin/helper", run: run('{"error":"Couldn\'t find that effort level in the Claude app."}\n') }),
    /Couldn't find that effort level/,
  );
});

test("native model changes require the exact visible session and confirmed menu selection", async () => {
  const m = mac({ onScreen: A });
  const c = compose(m, { type: async (value) => (m.typed.push(value), { model: value.model }) });
  assert.deepEqual(await c.model(A, { title: message.title, model: "Sonnet 5.5" }), { model: "Sonnet 5.5" });
  assert.deepEqual(m.typed, [{ title: message.title, session: `local_${A}`, waitMs: 0, model: "Sonnet 5.5" }]);
  m.onScreen = B;
  await assert.rejects(c.model(A, { title: message.title, model: "Opus 5.5" }), /Open this chat/);
  assert.equal(m.typed.length, 1);
  assert.deepEqual(m.opened, []);
  const unknown = compose(mac({ onScreen: A }), { type: async () => ({ model: "Sonnet 5.5", unconfirmed: true }) });
  await assert.rejects(unknown.model(A, { title: message.title, model: "Sonnet 5.5" }), /confirm/);
});

test("the model helper carries no text or images and rejects a native refusal", async () => {
  const calls = [];
  const run = (stdout) => (file, args) => (calls.push(args), Promise.resolve({ stdout }));
  await typeIntoClaude({ title: "Audit", session: `local_${A}`, model: "Sonnet 5.5", text: "never send", images: ["/x.png"] }, { binary: async () => "/bin/helper", run: run('{"model":"Sonnet 5.5"}\n') });
  assert.deepEqual(calls, [["--title", "Audit", "--session", `local_${A}`, "--model", "Sonnet 5.5"]]);
  await assert.rejects(typeIntoClaude({ title: "Audit", model: "Sonnet 5.5" }, { binary: async () => "/bin/helper", run: run('{"error":"unexpected model confirmation","unconfirmed":true}\n') }), /unexpected model confirmation/);
});

test("effort settings follow exact visible session identity when app records lag", async () => {
  const m = mac({ onScreen: A });
  const c = compose(m, { onScreen: async () => `local_${B}` });
  await assert.rejects(c.effort(A, { title: message.title, effort: "high" }), /Open this chat/);
  assert.deepEqual(m.typed, []);
});

test("a setting selection that lost its session is uncertain and never automatically retried", async () => {
  for (const setting of [{ effort: "High" }]) {
    const output = JSON.stringify({ error: "Claude changed chats. Check the current setting.", unconfirmed: true });
    await assert.rejects(typeIntoClaude({ title: message.title, session: `local_${A}`, ...setting }, {
      binary: async () => "/bin/helper", run: async () => ({ stdout: output }),
    }), (e) => e.code === "AGENT_SETTINGS_UNKNOWN" && e.uncertain === true && e.retryable === false && !e.waiting);
  }
});
