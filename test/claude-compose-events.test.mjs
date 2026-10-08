import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeCompose } from "../server/agent-sessions/claude-compose.mjs";
import { createOutbox } from "../server/agent-sessions/outbox.mjs";

// "Don't pull" (2026-10-06): putting a message into the Claude app, Reach
// re-read the chat's transcript every 300 ms to see it arrive, and the app's
// records every 250 ms to see a switch land; a message waiting for its chat
// tried again every 5 s. Now each waits on the agents' files saying so.
const A = "11111111-2222-4333-8444-555555555555";
const B = "22222222-2222-4333-8444-555555555555";
const later = (ms) => new Promise((r) => setTimeout(r, ms));
// A one-shot signal the test fires: what a write on the Mac would tell.
const signal = () => {
  const waiting = new Set();
  return {
    wait: (ms) => new Promise((resolve) => {
      waiting.add(resolve);
      setTimeout(resolve, ms);
    }),
    fire: () => {
      for (const resolve of [...waiting]) resolve();
      waiting.clear();
    },
  };
};

test("a message counts as in when its chat's transcript is written, not on a 300 ms re-read", async () => {
  let written = false;
  let looks = 0;
  const transcript = signal();
  const compose = createClaudeCompose({
    type: async () => ({ sent: true }),
    open: async () => {},
    arrived: async () => (looks++, written),
    shown: () => [{ id: A, session: `local_${A}` }],
    idle: async () => 0,
    appRunning: async () => true,
    frontmost: async () => true,
    wait: later,
    confirmMs: 5000,
    transcriptNews: (id, ms) => transcript.wait(ms),
  });
  const done = compose.deliver(A, { title: "Fix", text: "hi" });
  await later(700);
  assert.equal(looks, 1, "looked once, then waited for the write");
  written = true;
  transcript.fire();
  assert.deepEqual(await done, { delivered: true });
  assert.equal(looks, 2);
});

test("a switch to the chat is known when the Claude app's records change, not on a 250 ms beat", async () => {
  let onScreen = B;
  let looks = 0;
  const app = signal();
  const compose = createClaudeCompose({
    type: async () => ({ sent: true }),
    open: async (url) => {
      // The app switches a little later, and its records say so.
      if (url.endsWith(A)) later(400).then(() => ((onScreen = A), app.fire()));
      else onScreen = B;
    },
    arrived: async () => true,
    shown: () => (looks++, [onScreen, onScreen === A ? B : A].map((id) => ({ id, session: `local_${id}` }))),
    idle: async () => 0,
    appRunning: async () => true,
    frontmost: async () => false,
    wait: later,
    switchMs: 5000,
    appNews: (ms) => app.wait(ms),
  });
  assert.deepEqual(await compose.deliver(A, { title: "Fix", text: "hi" }), { delivered: true });
  // Source/target ownership checks around the switch, never a polling beat.
  assert.ok(looks <= 4, `looked ${looks} times`);
});

test("a message waiting for its chat to show tries again the moment the Claude app's records change", async () => {
  const { createAgentSessions } = await import("../server/agent-sessions/index.mjs");
  const outbox = createOutbox();
  outbox.add(A, { text: "hi", via: "app", title: "Fix" });
  const tries = [];
  let tell = () => {};
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: {},
    codexLive: { drives: () => false },
    claude: {},
    claudeHost: { onRelease() {} },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} },
    agentWatch: { onChange: (fn) => ((tell = fn), () => {}) },
    outbox,
    claudeCompose: {
      deliver: async () => {
        tries.push(Date.now());
        if (tries.length === 1) throw Object.assign(new Error("Goes in when you open this chat in the Claude app."), { waiting: true });
        return { delivered: true };
      },
    },
  });
  try {
    for (const end = Date.now() + 1000; tries.length < 1 && Date.now() < end; ) await later(10);
    await later(50);
    // The chat comes on screen: the Claude app's records change.
    tell({ agent: "claude", kind: "app" });
    for (const end = Date.now() + 1000; outbox.list(A).length && Date.now() < end; ) await later(10);
    assert.equal(outbox.list(A).length, 0, "in, without waiting 5 s");
    assert.ok(tries[1] - tries[0] < 1000);
  } finally {
    sessions.close();
  }
});

// The 5 s retry while you're in the Claude app (2026-10-06): the menu bar's
// helper now says which app is in front, so a message waiting because you're
// in the Claude app goes in the moment you leave it, or once you'd count as
// away, without asking every 5 s.
const CLAUDE = "com.anthropic.claudefordesktop";
test("you're in the Claude app: the wait says when you'd count as away; the app closed: it says so", async () => {
  const base = {
    type: async () => ({ sent: true }),
    open: async () => {},
    arrived: async () => true,
    shown: () => [B, A].map((id) => ({ id, session: `local_${id}` })),
    frontmost: async () => true,
    idle: async () => 10,
    awayMs: 30000,
  };
  await assert.rejects(createClaudeCompose({ ...base, appRunning: async () => true }).deliver(A, { title: "Fix", text: "hi" }), (e) => {
    assert.equal(e.waiting, true);
    assert.equal(e.inApp, true);
    assert.equal(e.retryMs, 20000);
    return true;
  });
  await assert.rejects(createClaudeCompose({ ...base, appRunning: async () => false }).deliver(A, { title: "Fix", text: "hi" }), (e) => {
    assert.equal(e.waiting, true);
    assert.equal(e.appClosed, true);
    return true;
  });
});

async function waitingSessions(deliver, extra = {}) {
  const { createAgentSessions } = await import("../server/agent-sessions/index.mjs");
  const outbox = createOutbox();
  outbox.add(A, { text: "hi", via: "app", title: "Fix" });
  const tries = [];
  const sessions = createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: {},
    codexLive: { drives: () => false },
    claude: {},
    claudeHost: { onRelease() {} },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} },
    agentWatch: { onChange: () => () => {} },
    outbox,
    claudeCompose: { deliver: async () => (tries.push(Date.now()), deliver(tries.length)) },
    ...extra,
  });
  const delivered = async (ms) => {
    for (const end = Date.now() + ms; outbox.list(A).length && Date.now() < end; ) await later(10);
    return !outbox.list(A).length;
  };
  return { sessions, tries, delivered };
}
const inApp = (retryMs) => Object.assign(new Error("Goes in when you open this chat in the Claude app, or step away from the app."), { waiting: true, inApp: true, retryMs });

test("a message waiting because you're in the Claude app goes in the moment you switch to another app", async () => {
  const { sessions, tries, delivered } = await waitingSessions((n) => {
    if (n === 1) throw inApp(60000);
    return { delivered: true };
  });
  try {
    sessions.frontmost(CLAUDE);
    for (const end = Date.now() + 1000; tries.length < 1 && Date.now() < end; ) await later(10);
    await later(50);
    assert.equal(tries.length, 1);
    // You switch to Safari.
    sessions.frontmost("com.apple.Safari");
    assert.ok(await delivered(1000), "in at once");
  } finally {
    sessions.close();
  }
});

test("with the app in front told, a message waiting while you're in the Claude app tries again when you'd count as away, not every 5 s", async () => {
  const { sessions, tries, delivered } = await waitingSessions((n) => {
    if (n === 1) throw inApp(300);
    return { delivered: true };
  }, { appRetryMs: 5000 });
  try {
    sessions.frontmost(CLAUDE);
    assert.ok(await delivered(2000), "tried again at its time");
    const gap = tries[1] - tries[0];
    assert.ok(gap >= 250 && gap < 1500, `tried again after ${gap} ms`);
  } finally {
    sessions.close();
  }
});

test("a message waiting for the Claude app to open goes in when it opens", async () => {
  const closed = Object.assign(new Error("Goes in when the Claude app is open on your Mac."), { waiting: true, appClosed: true });
  const { sessions, tries, delivered } = await waitingSessions((n) => {
    if (n === 1) throw closed;
    return { delivered: true };
  });
  try {
    sessions.frontmost("com.apple.Safari");
    for (const end = Date.now() + 1000; tries.length < 1 && Date.now() < end; ) await later(10);
    await later(50);
    // Another app opening changes nothing; the Claude app opening does.
    sessions.launched("com.apple.Notes");
    await later(100);
    assert.equal(tries.length, 1);
    sessions.launched(CLAUDE);
    assert.ok(await delivered(1000), "in once the app opened");
  } finally {
    sessions.close();
  }
});

// "Make sure a message is always delivered to the right session. Use session
// id instead of names" (2026-10-06): the window was checked by the chat's
// name, which two chats can share, and Reach switched back to the chat the
// app's records named, which could lag what the window showed.
test("two chats with the same name: the message is typed only once the window shows that chat's own id", async () => {
  let showing = "local_b";
  const typed = [];
  const opened = [];
  const compose = createClaudeCompose({
    type: async (message) => (typed.push(message), { sent: true }),
    open: async (url) => {
      opened.push(url);
      showing = url.split("session=")[1];
    },
    arrived: async () => true,
    // Same name; the app's records even name A first.
    shown: () => [{ id: A, session: "local_a", title: "Fix" }, { id: B, session: "local_b", title: "Fix" }],
    onScreen: async () => showing,
    idle: async () => 0,
    appRunning: async () => true,
    frontmost: async () => false,
    wait: later,
  });
  assert.deepEqual(await compose.deliver(A, { title: "Fix", text: "hi" }), { delivered: true });
  // The window showed B (whatever the records said): switched to A by id, typed for A's id, back to B.
  assert.deepEqual(opened, ["claude://code/continue?session=local_a", "claude://code/continue?session=local_b"]);
  assert.equal(typed.length, 1);
  assert.equal(typed[0].session, "local_a");
  assert.ok(typed[0].waitMs > 0, "given time to show it");
  // Already on screen by id: typed at once, no switch.
  opened.length = 0;
  showing = "local_a";
  await compose.deliver(A, { title: "Fix", text: "again" });
  assert.deepEqual(opened, []);
  assert.equal(typed.at(-1).session, "local_a");
});

test("drafts and Stop are typed only into the chat with that id", async () => {
  const typed = [];
  const compose = createClaudeCompose({
    type: async (message) => (typed.push(message), message.stop ? { stopped: true } : message.mode ? { mode: message.mode } : { drafted: true }),
    open: async () => {},
    arrived: async () => true,
    shown: () => [{ id: A, session: "local_a", title: "Fix" }],
    appRunning: async () => true,
  });
  await compose.draft(A, { title: "Fix", text: "dra", owner: "phone" });
  await compose.stop(A, { title: "Fix" });
  assert.deepEqual(typed.map((m) => [m.session, m.waitMs]), [["local_a", 0], ["local_a", 0]]);
});

test("the Claude app helper is asked for the chat by its id, and says which one it shows", async () => {
  const { typeIntoClaude, claudeOnScreen } = await import("../server/agent-sessions/claude-compose.mjs");
  const calls = [];
  const run = async (file, args) => (calls.push(args), { stdout: JSON.stringify(args.includes("--check") ? { sessions: ["local_x"] } : { sent: true }) });
  await typeIntoClaude({ title: "Fix", session: "local_x", waitMs: 15000, text: "hi" }, { run, binary: async () => "/helper" });
  assert.deepEqual(calls[0].slice(0, 6), ["--title", "Fix", "--session", "local_x", "--wait", "15000"]);
  assert.equal(await claudeOnScreen({ run, binary: async () => "/helper" }), "local_x");
  const unsure = async () => ({ stdout: JSON.stringify({ sessions: ["local_x", "local_y"] }) });
  assert.equal(await claudeOnScreen({ run: unsure, binary: async () => "/helper" }), null);
  // The helper itself compares ids, before typing and right before Send.
  const { readFileSync } = await import("node:fs");
  const helper = readFileSync(new URL("../scripts/native/claude-compose.swift", import.meta.url), "utf8");
  assert.match(helper, /session\.map \{ w\.sessions == \[\$0\] \}/);
  assert.match(helper, /guard showing\(window\) else \{ out\(\["error": "The Claude app switched to another chat."\]\) \}/);
});
