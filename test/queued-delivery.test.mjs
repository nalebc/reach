import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOutbox } from "../server/agent-sessions/outbox.mjs";
import { claudeFrontmost, createClaudeCompose } from "../server/agent-sessions/claude-compose.mjs";
import { AppThreads } from "../server/app-threads.mjs";

// Messages from the phone took too long and, while they waited, never showed
// in the Claude app (2026-10-05): the first try sat out a 1.5 s beat; a chat
// that wasn't on screen waited even while you were in another app; a message
// whose chat was deleted retried forever where nobody could see it; and
// nothing on the Mac said a message was waiting.
const A = "11111111-2222-4333-8444-555555555555";
const B = "22222222-2222-4333-8444-555555555555";

const sessionsWith = async (outbox, extra = {}) => {
  const { createAgentSessions } = await import("../server/agent-sessions/index.mjs");
  return createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: {},
    codexLive: { drives: () => false },
    claude: {},
    claudeHost: { onRelease() {} },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} },
    outbox,
    ...extra,
  });
};
const until = async (check, ms = 2000) => {
  for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 10))) if (Date.now() > end) return false;
  return true;
};

test("a message just sent is tried at once, not after the usual beat", async () => {
  const outbox = createOutbox();
  outbox.add(A, { text: "hi", via: "app", title: "Fix" });
  const tries = [];
  const start = Date.now();
  const sessions = await sessionsWith(outbox, {
    queueMs: 2000,
    claudeCompose: { deliver: async () => (tries.push(Date.now() - start), { delivered: true }) },
  });
  try {
    assert.ok(await until(() => tries.length === 1, 1500), "tried within 1.5 s");
    assert.ok(tries[0] < 500, `tried after ${tries[0]} ms`);
  } finally {
    sessions.close();
  }
});

test("a deleted chat's messages stop retrying and wait for the phone, which sends them to another chat", async () => {
  const outbox = createOutbox();
  const lost = outbox.add(A, { text: "In reach project", via: "app", title: "Untitled", images: ["/tmp/a.png"] });
  let tries = 0;
  const sent = [];
  const sessions = await sessionsWith(outbox, {
    queueMs: 10,
    claude: { exists: async (id) => id !== A },
    codexLive: { drives: () => false, send: async (id, body) => (sent.push([id, body]), { queued: true, delivered: false }) },
    claudeCompose: {
      deliver: async () => {
        tries++;
        throw Object.assign(new Error("The Claude app doesn't list this chat."), { waiting: true, unlisted: true });
      },
    },
  });
  try {
    assert.ok(await until(() => outbox.list(A)[0]?.stranded), "marked as its chat being gone");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(tries, 1, "no more tries once its chat is gone");
    assert.deepEqual(
      sessions.stranded().map((m) => [m.session, m.id, m.text, m.images]),
      [[A, lost.id, "In reach project", 1]],
    );
    // To another chat from the phone; it leaves only once that chat has it.
    await sessions.sendStranded(lost.id, { agent: "codex", id: B });
    assert.equal(sent[0][0], B);
    assert.equal(sent[0][1].text, "In reach project");
    assert.deepEqual(sent[0][1].images, ["/tmp/a.png"]);
    assert.deepEqual(outbox.list(A), []);
    assert.deepEqual(sessions.stranded(), []);
    await assert.rejects(sessions.sendStranded(lost.id, { agent: "codex", id: B }), (e) => e.status === 409);
  } finally {
    sessions.close();
  }
});

test("a chat the Claude app doesn't list but Claude Code still has isn't taken for deleted", async () => {
  const outbox = createOutbox();
  outbox.add(A, { text: "hi", via: "app", title: "Fix" });
  const sessions = await sessionsWith(outbox, {
    queueMs: 60000,
    claude: { exists: async () => true },
    claudeCompose: {
      deliver: async () => {
        throw Object.assign(new Error("The Claude app doesn't list this chat."), { waiting: true, unlisted: true });
      },
    },
  });
  try {
    assert.ok(await until(() => outbox.list(A)[0]?.error));
    assert.equal(outbox.list(A)[0].stranded, undefined);
    assert.deepEqual(sessions.stranded(), []);
  } finally {
    sessions.close();
  }
});

test("messages waiting for their Claude app chat are listed for the Mac's menu bar, with the chat's link", async () => {
  const outbox = createOutbox();
  outbox.add(A, { text: "one", via: "app", title: "Fix the list" });
  outbox.add(A, { text: "two", via: "app", title: "Fix the list" });
  const sessions = await sessionsWith(outbox, {
    queueMs: 60000,
    appShown: () => [{ id: A, session: "local_abc", at: 1 }],
    claudeCompose: {
      deliver: async () => {
        throw Object.assign(new Error("Goes in when you open this chat in the Claude app."), { waiting: true });
      },
    },
  });
  try {
    assert.ok(await until(() => outbox.list(A)[0]?.error));
    assert.deepEqual(sessions.waitingOnMac(), [
      { id: A, title: "Fix the list", count: 2, link: "claude://code/continue?session=local_abc" },
    ]);
    // Told when it changes.
    let changes = 0;
    sessions.onOutbox(() => changes++);
    outbox.remove(A, outbox.list(A)[1].id);
    assert.equal(changes, 1);
    assert.equal(sessions.waitingOnMac()[0].count, 1);
  } finally {
    sessions.close();
  }
});

test("Reach's menu bar item gets the waiting chats, also when its helper starts after them", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-waiting-"));
  const requests = [];
  try {
    const threads = new AppThreads({
      file: path.join(dir, "app-threads.json"),
      listApps: async () => [],
      platform: "darwin",
      startHelper: async () => ({
        stopped: false,
        async request(cmd, payload = {}) {
          requests.push([cmd, payload]);
          return {};
        },
        async stop() {},
      }),
    });
    const chats = [{ id: A, title: "Fix", count: 1, link: "claude://code/continue?session=local_x" }];
    // Before the item shows: kept, and sent along with it.
    threads.waiting(chats);
    assert.deepEqual(requests, []);
    await threads.showMenu();
    assert.deepEqual(requests, [["state", { paused: false }], ["waiting", { chats }]]);
    threads.waiting([]);
    assert.deepEqual(requests.at(-1), ["waiting", { chats: [] }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the menu bar helper lists them and a click opens only the chat's own claude:// link", () => {
  const helper = fs.readFileSync(new URL("../scripts/native/app-displays.m", import.meta.url), "utf8");
  assert.match(helper, /\[cmd isEqual:@"waiting"\]/);
  assert.match(helper, /if \(\[url\.scheme isEqual:@"claude"\]\) \[NSWorkspace\.sharedWorkspace openURL:url\];/);
});

const mac = ({ onScreen = B, frontmost = false, idle = 0 } = {}) => {
  const m = { onScreen, opened: [], typed: [] };
  m.compose = createClaudeCompose({
    type: async ({ text }) => (m.typed.push(text), { sent: true }),
    open: async (url, options) => {
      m.opened.push([url, options]);
      m.onScreen = url.endsWith(A) ? A : B;
    },
    arrived: async () => true,
    shown: () => [m.onScreen, m.onScreen === A ? B : A].map((id) => ({ id, session: `local_${id}` })),
    idle: async () => idle,
    appRunning: async () => true,
    frontmost: async () => frontmost,
    wait: async () => {},
    switchMs: 50,
    confirmMs: 20,
  });
  return m;
};

test("while you're in another app, the chat switches in the background, the message goes in, and the window goes back", async () => {
  const m = mac({ frontmost: false, idle: 0 });
  assert.deepEqual(await m.compose.deliver(A, { title: "Fix", text: "hi" }), { delivered: true });
  assert.deepEqual(m.typed, ["hi"]);
  // Claude never comes forward over what you're doing.
  assert.deepEqual(m.opened, [
    [`claude://code/continue?session=local_${A}`, { background: true }],
    [`claude://code/continue?session=local_${B}`, { background: true }],
  ]);
  // Using the Claude app itself: never switched under you.
  const busy = mac({ frontmost: true, idle: 0 });
  await assert.rejects(busy.compose.deliver(A, { title: "Fix", text: "hi" }), (e) => e.waiting && /step away from the app/.test(e.message));
  assert.deepEqual(busy.opened, []);
});

test("which app is in use is read from macOS's own app list", async () => {
  const run = (bundle) => async (cmd, args) =>
    args[0] === "front" ? { stdout: "ASN:0x0-0x2b02b:\n" } : { stdout: `"CFBundleIdentifier"="${bundle}"\n` };
  assert.equal(await claudeFrontmost(run("com.anthropic.claudefordesktop")), true);
  assert.equal(await claudeFrontmost(run("com.google.Chrome")), false);
});

// "Draft stays on your phone until this chat is visible in Claude." filled
// Reach's log, once per keystroke, and reached the phone as a 500: an expected
// wait had no status, so the server took it for a crash.
test("waiting for the chat (a draft, a Stop, a message) is a 409 with its reason, not a failure", async () => {
  const m = mac({ onScreen: B });
  await assert.rejects(m.compose.draft(A, { title: "Fix", text: "hel", owner: "phone" }), (e) => e.waiting && e.status === 409 && /Draft stays on your phone/.test(e.message));
  await assert.rejects(m.compose.stop(A, { title: "Fix" }), (e) => e.status === 409 && /Open this chat in Claude to stop it/.test(e.message));
});

test("the menu bar's helper tells Reach which app is in front, and when it stops telling", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-front-"));
  let tell;
  let exit;
  try {
    const threads = new AppThreads({
      file: path.join(dir, "app-threads.json"),
      listApps: async () => [],
      platform: "darwin",
      startHelper: async ({ onEvent, onExit }) => {
        tell = onEvent;
        exit = onExit;
        return { stopped: false, async request() { return {}; }, async stop() {} };
      },
    });
    const fronts = [];
    const launched = [];
    threads.onFrontmost = (bundle) => fronts.push(bundle);
    threads.onLaunched = (bundle) => launched.push(bundle);
    await threads.showMenu();
    tell({ event: "frontmost", bundle: "com.anthropic.claudefordesktop" });
    tell({ event: "launched", bundle: "com.apple.Notes" });
    tell({ event: "frontmost", bundle: "com.apple.Safari" });
    assert.deepEqual(fronts, ["com.anthropic.claudefordesktop", "com.apple.Safari"]);
    assert.deepEqual(launched, ["com.apple.Notes"]);
    // The helper stopped: no word on the app in front until it's back.
    threads.stopping = true;
    exit();
    assert.equal(fronts.at(-1), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the real menu bar helper says which app is in front as it starts", { skip: process.platform !== "darwin" && "needs macOS", timeout: 120000 }, async () => {
  const { appDisplaysBinary, AppDisplaysHelper } = await import("../server/app-threads.mjs");
  const { spawn } = await import("node:child_process");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-front-helper-"));
  const events = [];
  const binary = await appDisplaysBinary({ dataDir });
  const helper = new AppDisplaysHelper(
    spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, REACH_APP_DISPLAY_SLOTS: "41" } }),
    { onEvent: (event) => events.push(event) },
  );
  try {
    for (const end = Date.now() + 10000; !events.length && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
    assert.equal(events[0]?.event, "frontmost");
    assert.equal(typeof events[0].bundle, "string");
  } finally {
    await helper.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
