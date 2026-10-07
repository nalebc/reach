import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { computerWord } from "../server/computer-word.mjs";
import { claudeAnswer, createClaudeHost } from "../server/agent-sessions/claude-host.mjs";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";
import { createCodexLive } from "../server/agent-sessions/codex-live.mjs";
import { createSignIn } from "../server/agent-sessions/sign-in.mjs";
import { createAgentAsks } from "../server/agent-sessions/agent-asks.mjs";
import { createClaudeConsent } from "../server/agent-sessions/claude-consent.mjs";
import { createAppCards } from "../server/agent-sessions/app-cards.mjs";
import { uncertainDelivery } from "../server/agent-sessions/compatibility.mjs";
import { createCodexDaemon } from "../server/agent-sessions/codex-daemon.mjs";
import { elicitationPrompt } from "../server/agent-sessions/elicitation.mjs";
import { pausedMessage } from "../server/screen.mjs";

// Oct 6: on Windows and Linux the phone's Chat screens said "your computer"
// (src/pause.ts) while the server's own words on them still said "Mac": a
// dialog's title, why a reply can't go, what to do instead. Then (user: "If it
// is a mac it should say mac if windows it says windows"): a Mac is "Mac", a
// Windows computer "Windows PC", anything else "computer", including words
// that used to say "computer" everywhere. Every module is given the platform,
// so each case reads the same on any computer running the tests.
const ID = "11111111-2222-4333-8444-555555555555";
const T = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const PLATFORMS = [["win32", "Windows PC"], ["linux", "computer"], ["darwin", "Mac"]];
const settled = async () => {
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
};

test("a Mac is a Mac, a Windows computer a Windows PC, anything else a computer", () => {
  assert.equal(computerWord("darwin"), "Mac");
  assert.equal(computerWord("win32"), "Windows PC");
  for (const platform of ["linux", "freebsd"]) assert.equal(computerWord(platform), "computer");
  assert.equal(computerWord(), { darwin: "Mac", win32: "Windows PC" }[process.platform] || "computer");
  assert.equal(pausedMessage("win32"), "Reach is paused on this Windows PC.");
  assert.equal(pausedMessage("linux"), "Reach is paused on this computer.");
  assert.equal(pausedMessage("darwin"), "Reach is paused on this Mac.");
});

test("words that said \"computer\" on every computer name it", async () => {
  for (const [platform, word] of PLATFORMS) {
    assert.equal(
      uncertainDelivery("codex", platform).message,
      `Codex did not confirm the action. It may already have happened. Automatic retry is paused; check the conversation on your ${word} before sending again.`,
    );
    assert.equal(
      elicitationPrompt({ serverName: "calendar", mode: "url", message: "Sign in" }, "Codex", platform).reason,
      `Complete this request in Codex on your ${word}. Reach cannot submit the required form or device verification yet.`,
    );
    await assert.rejects(createCodexDaemon({ locate: async () => null, platform }).rpc("thread/list"), {
      status: 503,
      message: `Codex is not installed on this ${word}.`,
    });
  }
});

// `claude -p` played by a fake that answers Reach's handshake and lets the
// test print on its stdout (as in agent-claude-host.test.mjs).
function fakeClaude() {
  const runs = [];
  const spawn = (file, args) => {
    const proc = new EventEmitter();
    proc.args = args;
    proc.exitCode = null;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.print = (message) => proc.stdout.emit("data", `${JSON.stringify(message)}\n`);
    proc.kill = () => ((proc.exitCode = 143), proc.emit("exit", 143));
    proc.stdin = {
      on() {},
      end() {},
      write(text, callback) {
        for (const line of text.split("\n").filter(Boolean)) {
          const message = JSON.parse(line);
          if (message.type === "control_request")
            queueMicrotask(() =>
              proc.print({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } }),
            );
        }
        callback?.();
      },
    };
    runs.push(proc);
    return proc;
  };
  return { spawn, last: () => runs.at(-1) };
}

test("Claude Code's own words name the computer it runs on", async (t) => {
  for (const [platform, word] of PLATFORMS) {
    const missing = createClaudeHost({ locate: async () => null, spawn: fakeClaude().spawn, env: {}, platform });
    await assert.rejects(missing.send(ID, { text: "hi", cwd: "/work" }), { status: 404, message: `Claude Code isn't installed on this ${word}.` });

    const claude = fakeClaude();
    const h = createClaudeHost({ locate: async () => "/usr/local/bin/claude", spawn: claude.spawn, env: {}, platform });
    t.after(() => h.close());
    await assert.rejects(h.stop(ID), { status: 409, message: `Reach isn't running anything here. Stop it on your ${word}.` });
    await h.send(ID, { text: "hello", cwd: "/work/app" });
    const proc = claude.last();
    // A dialog only the computer can answer: the phone can only cancel it.
    proc.print({ type: "control_request", request_id: "d", request: { subtype: "request_user_dialog" } });
    const dialog = h.view(ID).prompts.find((p) => p.id === "d");
    assert.equal(dialog.title, `Claude Code needs your answer on your ${word}`);
    assert.equal(dialog.reason, `This dialog needs Claude on your ${word}. Cancel request dismisses it; it does not open Claude.`);
    // A form only the agent itself can take.
    proc.print({ type: "control_request", request_id: "e", request: { subtype: "elicitation", mcp_server_name: "calendar", mode: "url", message: "Sign in" } });
    assert.equal(
      h.view(ID).prompts.find((p) => p.id === "e").reason,
      `Complete this request in Claude on your ${word}. Reach cannot submit the required form or device verification yet.`,
    );
    await assert.rejects(h.respond(ID, "d", { decision: "allow" }), { status: 409, message: `Answer this one on your ${word}.` });
    assert.throws(() => claudeAnswer(dialog, { decision: "allow" }, platform), { message: `Answer this one on your ${word}.` });
    // An answer that may or may not have reached it is never sent twice.
    proc.print({ type: "control_request", request_id: "p", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "ls" } } });
    proc.stdin.write = (_, callback) => callback(Error("disconnected"));
    await assert.rejects(h.respond(ID, "p", { decision: "allow" }));
    await assert.rejects(h.respond(ID, "p", { decision: "allow" }), { status: 409, message: `This answer was already attempted. Check Claude on your ${word}.` });
  }
});

// The Chat tab's sessions with only what each case needs.
const sessionsOn = (platform, { health = { agent: "claude", installed: true, signedIn: true }, live = null, session = {}, items = [] } = {}) =>
  createAgentSessions({
    platform,
    daemon: { rpc: async () => ({}), onNotification() {} },
    codex: {},
    codexLive: { drives: () => false },
    claude: {
      health: async () => health,
      starts: async () => [],
      read: async (id) => ({ session: { agent: "claude", id, cwd: "/work", status: "idle", ...session }, items, before: null }),
    },
    live: async () => new Map(live ? [[ID, { pid: 4242, tty: null, exact: true, busy: false, ...live }]] : []),
    liveMs: -1,
    claudeHost: { onRelease() {}, start: async () => ({ threadId: "t", turnId: null }), drives: () => false },
    signIn: {},
    claudeImports: { add: async () => {}, close() {} },
    agentAsks: { close() {} },
    // The Claude app lists no chats.
    claudeShown: () => [],
  });

test("why a Claude chat can't take a reply from the phone names the computer it runs on", async () => {
  for (const [platform, word] of PLATFORMS) {
    const out = sessionsOn(platform, { health: { agent: "claude", installed: true, signedIn: false } });
    await assert.rejects(out.start("claude", { cwd: "/work", text: "hi" }), {
      status: 409,
      message: `Claude Code is signed out on your ${word}. Sign in to reply from here.`,
    });
    out.close();
    const terminal = sessionsOn(platform, { live: { where: "terminal" } });
    await assert.rejects(terminal.send("claude", ID, { text: "hi" }), {
      status: 409,
      message: `This session is open in a terminal on your ${word}. Reply there or from the Terminal tab.`,
    });
    terminal.close();
    const other = sessionsOn(platform, { live: { where: "claude-app", exact: false } });
    await assert.rejects(other.send("claude", ID, { text: "hi" }), {
      status: 409,
      message: `This session is open in another Claude Code process on your ${word}. Reply there.`,
    });
    other.close();
  }
});

test("the Claude app's own cards, answered from the phone, name the computer they're on", async () => {
  for (const [platform, word] of PLATFORMS) {
    // Through the Chat tab, which hands its platform on: a consent card and a
    // permission card in Claude app chats the app no longer lists.
    const sessions = sessionsOn(platform, {
      live: { where: "claude-app", waiting: "permission prompt" },
      session: { consent: { id: "consent:toolu_1", kind: "apps", apps: ["Calculator"] } },
      items: [{ role: "tool", id: "toolu_2", status: "running", kind: "command", text: "npm test" }],
    });
    await assert.rejects(sessions.respond("claude", ID, "consent:toolu_1", { decision: "deny" }), {
      status: 409,
      message: `The Claude app doesn't list this session. Answer it on your ${word}.`,
    });
    await assert.rejects(sessions.card("claude", ID), {
      status: 409,
      message: `The Claude app doesn't list this chat. Answer it on your ${word}.`,
    });
    sessions.close();

    // A press that may have landed is never repeated.
    const consent = createClaudeConsent({
      press: async () => {
        throw Error("The helper stopped.");
      },
      open: async () => {},
      pending: async () => ({ id: "consent:toolu_1" }),
      shown: () => [{ id: ID, session: `local_${ID}` }],
      wait: async () => {},
      platform,
    });
    await assert.rejects(consent.answer(ID, "consent:toolu_1", { decision: "allow" }), /helper stopped/);
    await assert.rejects(consent.answer(ID, "consent:toolu_1", { decision: "allow" }), {
      status: 409,
      message: `Reach already pressed an answer in the Claude app but couldn't confirm it. Check the card on your ${word}.`,
    });

    const cards = createAppCards({
      read: async () => ({}),
      press: async () => {},
      open: async () => {},
      pending: async () => ({ id: "app-permission:toolu_3", expect: [] }),
      shown: () => [],
      wait: async () => {},
      platform,
    });
    await assert.rejects(cards.card("claude", ID), {
      status: 409,
      message: `Reach can't tell this request's card apart. Answer it on your ${word}.`,
    });

    // A question card the app never took: never answered twice.
    const asking = createAppCards({
      read: async () => ({}),
      press: async () => {},
      open: async () => {},
      pending: async () => null,
      pendingQuestion: async () => ({ id: "app-question:toolu_4", questions: [{ question: "Pick", options: [{ label: "A" }] }] }),
      answerQuestion: async () => {},
      shown: () => [{ id: ID }],
      wait: async () => {},
      confirmMs: 0,
      platform,
    });
    await assert.rejects(asking.answer("claude", ID, "app-question:toolu_4", { answers: { q0: ["A"] } }), {
      status: 409,
      message: `The Claude app didn't take the answer. Answer it on your ${word}.`,
    });
    await assert.rejects(asking.answer("claude", ID, "app-question:toolu_4", { answers: { q0: ["A"] } }), {
      status: 409,
      message: `This answer was already attempted. Check the app or terminal on your ${word} before answering again.`,
    });
  }
});

test("signing an agent in from the phone names the computer it isn't on", async () => {
  for (const [platform, word] of PLATFORMS) {
    const signIn = createSignIn({ dataDir: "/tmp", claudeCommand: async () => null, claudeHealth: async () => ({}), env: {}, platform });
    await assert.rejects(signIn.start("claude"), { status: 404, message: `Claude Code isn't installed on this ${word}.` });
    await assert.rejects(signIn.start("codex"), { status: 404, message: `Codex isn't available on this ${word}.` });
  }
});

test("a Codex message no window took says to open the chat on the computer it runs on", async () => {
  for (const [platform, word] of PLATFORMS) {
    let clock = 0;
    const calls = [];
    const replies = {
      "thread/resume": new Error("already has a live local writer"),
      "thread/queue/add": { queuedSubmission: { id: "q1" } },
      "thread/queue/list": { data: [{ id: "q1" }] },
      "thread/turns/list": { data: [{ id: "t0", status: "completed", completedAt: 5 }] },
      "thread/queue/delete": { deleted: true },
    };
    const daemon = {
      async rpc(method, params) {
        calls.push(method);
        const value = replies[method];
        if (value instanceof Error) throw value;
        return value ?? {};
      },
      onNotification() {},
      onRequest() {},
      onClose() {},
    };
    const live = createCodexLive({ daemon, wait: async () => {}, now: () => (clock += 1000), deliverMs: 3000, platform });
    await live.send(T, { text: "hi" });
    await settled();
    assert.ok(calls.includes("thread/queue/delete"));
    assert.equal(
      live.view(T).outbox[0].error,
      `Another Codex window has this chat open and didn't take it. Open the chat in the Codex app on your ${word}, then send it again.`,
    );
  }
});

test("a question handed back to the computer says where it was answered", async (t) => {
  for (const [platform, word] of PLATFORMS) {
    // The broker's own connection handler, without opening a socket (as in
    // agent-asks-state.test.mjs).
    let server;
    const create = net.createServer;
    net.createServer = (...args) => (server = create(...args));
    let asks;
    try {
      asks = createAgentAsks({ socketPath: "/unused-test.sock", idle: async () => 600, everyMs: 5, watchGraceMs: 30, watching: () => true, platform });
    } finally {
      net.createServer = create;
    }
    t.after(() => asks.close());
    const socket = new EventEmitter();
    socket.setEncoding = () => {};
    socket.end = () => socket.emit("close");
    socket.destroy = () => socket.emit("close");
    server.emit("connection", socket);
    const questions = [{ question: "Choose one", options: [{ label: "A" }, { label: "B" }] }];
    socket.emit("data", JSON.stringify({ agent: "claude", session_id: ID, tool_name: "AskUserQuestion", tool_input: { questions } }) + "\n");
    await new Promise((r) => setTimeout(r, 0));
    const [prompt] = asks.prompts("claude", ID);
    assert.deepEqual(asks.answer("claude", ID, prompt.id, { decision: "answerOnMac" }), { handedOff: true });
    assert.throws(() => asks.answer("claude", ID, prompt.id, { answers: { "Choose one": ["A"] } }), {
      status: 409,
      message: `Answered on your ${word}.`,
    });
  }
});
