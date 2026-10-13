import test from "node:test";
import assert from "node:assert/strict";
import { agentChats, checkSteps, CLAW_NOTE, createRelays } from "../server/agent-sessions/relays.mjs";

// OpenClaw in relays and second opinions (server/agent-sessions/relays.mjs,
// docs/ACROSS_AGENTS.md) against a stand-in for its client that keeps the
// real one's rules: it writes only in chats Reach made, never delivers to a
// channel, asks authorize before each call, and stamps the time before a
// message the way OpenClaw's Gateway does.
const CODEX = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const OURS = "agent:main:reach-1a2b3c4d";
const WHATSAPP = "agent:main:whatsapp:direct:+33600000000";
const user = (id, text) => ({ id, role: "user", kind: "text", text });
const reply = (id, text) => ({ id, role: "assistant", kind: "text", text });
const edit = (id, file, diff) => ({ id, role: "tool", kind: "file-change", text: file, detail: diff, status: "completed" });
const stamp = (text) => `[Thu 2026-10-08 14:02 GMT+2] ${text}`;

export function fakeOpenClaw() {
  let n = 0;
  const chats = {
    [OURS]: { session: { title: "Research", status: "idle", writable: true }, items: [{ id: "c1", role: "user", text: stamp("Find prices") }, { id: "c2", role: "assistant", text: "Three vendors." }] },
    [WHATSAPP]: { session: { title: "Alex on WhatsApp", status: "idle", writable: false }, items: [{ id: "w1", role: "user", text: "Can someone fix the login page?" }, { id: "w2", role: "assistant", text: "Asking the team: the login page is broken on Safari." }] },
  };
  const calls = [];
  const authorizedCalls = [];
  const client = {
    chats,
    calls,
    authorizedCalls,
    async history(key) {
      const c = chats[key];
      if (!c) throw Object.assign(new Error("This OpenClaw session is no longer available. Refresh the list."), { status: 404 });
      return { session: structuredClone(c.session), items: structuredClone(c.items), error: c.error || "" };
    },
    async start({ text, requestId, ...rest }, authorize) {
      authorize();
      authorizedCalls.push("start");
      calls.push({ method: "start", text, requestId, rest });
      const key = `agent:main:reach-${String(++n).padStart(8, "0")}`;
      chats[key] = { session: { title: text.split("\n")[0], status: "running", writable: true }, items: [{ id: `${key}-u`, role: "user", text: stamp(text) }] };
      return { key };
    },
    async send({ key, text, requestId, ...rest }, authorize) {
      authorize();
      authorizedCalls.push("send");
      if (rest.deliver !== undefined && rest.deliver !== false) throw Object.assign(new Error("Reach doesn’t post to WhatsApp"), { status: 403 });
      const c = chats[key];
      if (!c.session.writable) throw Object.assign(new Error("Reach shows it but doesn’t write in it."), { status: 403 });
      calls.push({ method: "send", key, text, requestId, rest });
      c.session.status = "running";
      c.items.push({ id: `${key}-u${c.items.length}`, role: "user", text: stamp(text) });
      return { runId: requestId, status: "running" };
    },
    // Post-back: OpenClaw's own `send` to the chat's one-to-one destination
    // (the real one refuses groups and channels: test/openclaw.test.mjs).
    async postTarget({ key }, authorize) {
      authorize();
      if (!/:direct:/.test(key)) throw Object.assign(new Error("Reach posts only to one-to-one WhatsApp or Telegram chats"), { status: 403 });
      return { channel: "whatsapp", to: key.split(":direct:")[1] };
    },
    async post({ key, text, requestId, to }, authorize) {
      authorize();
      authorizedCalls.push("post");
      calls.push({ method: "post", key, text, requestId, to });
      return { posted: true, channel: "whatsapp" };
    },
    async stop(key) {
      calls.push({ method: "stop", key });
      chats[key].session.status = "idle";
      return { aborted: true };
    },
    redact: () => "OpenClaw reported an error. Check OpenClaw on this computer.",
    // An OpenClaw chat's turn ends.
    finish(key, text) {
      const c = chats[key];
      c.session.status = "idle";
      c.items.push({ id: `${key}-r${c.items.length}`, role: "assistant", text });
    },
    fail(key, status = "error") {
      chats[key].session.status = status;
      chats[key].error = "sk-live-123 provider exploded";
    },
  };
  return client;
}

function stage({ authorized = () => "", openClaw = fakeOpenClaw() } = {}) {
  let clock = 1_000_000;
  const pages = {
    [`codex:${CODEX}`]: {
      session: { title: "Fix login", cwd: "/work/app", status: "idle" },
      items: [user("u1", "Fix the login bug"), edit("e1", "src/login.ts", "-a\n+b"), reply("a1", "Fixed: the token was compared as a number.")],
    },
  };
  const started = [];
  const sent = [];
  let n = 0;
  const sessions = {
    list: async () => ({ sessions: Object.entries(pages).map(([key, p]) => ({ agent: key.split(":")[0], id: key.split(":")[1], status: p.session.status })) }),
    read: async (agent, id) => {
      const page = pages[`${agent}:${id}`];
      if (!page) throw Object.assign(new Error("No such chat."), { status: 404 });
      return structuredClone(page);
    },
    start: async (agent, body) => {
      assert.notEqual(agent, "openclaw", "OpenClaw goes through its own client");
      const threadId = `new-${++n}`;
      started.push({ agent, body });
      pages[`${agent}:${threadId}`] = { session: { title: "", cwd: body.cwd, status: "running" }, items: [user(`${threadId}-u`, body.text)] };
      return { threadId };
    },
    send: async (agent, id, body) => {
      assert.notEqual(agent, "openclaw");
      sent.push({ agent, id, body });
      return { turnId: "t" };
    },
  };
  const relays = createRelays({
    sessions,
    openClaw,
    authorized,
    folder: (cwd) => {
      if (!cwd.startsWith("/work")) throw Object.assign(new Error("Choose a folder."), { status: 400 });
      return cwd;
    },
    now: () => clock,
    settleMs: 4000,
    setTimer: () => ({ unref() {} }),
    setEvery: () => 0,
    clearEvery: () => {},
  });
  // A finished turn is seen twice, a few seconds apart.
  const settle = async () => {
    await relays.check();
    clock += 4100;
    await relays.check();
  };
  return { relays, openClaw, pages, started, sent, settle, tick: (ms) => (clock += ms) };
}

test("OpenClaw is a step's agent only when Reach has its Gateway, and only Reach's chats receive", () => {
  const from = { agent: "codex", id: CODEX };
  const claw = ["codex", "claude", "openclaw"];
  assert.throws(() => checkSteps([{ kind: "build", agent: "openclaw" }], from), /Choose Codex or Claude Code/);
  assert.deepEqual(checkSteps([{ kind: "review", agent: "openclaw" }], from, claw), [{ kind: "review", agent: "openclaw" }]);
  assert.throws(() => checkSteps([{ kind: "build", agent: "gemini" }], from, claw), /Codex, Claude Code or OpenClaw/);
  // A chat to send to: one Reach made (a WhatsApp, Discord or cron chat never).
  assert.throws(() => checkSteps([{ kind: "send", to: { agent: "openclaw", id: WHATSAPP } }], from, claw), /only in OpenClaw chats it made/);
  assert.deepEqual(checkSteps([{ kind: "send", to: { agent: "openclaw", id: OURS } }], from, claw), [{ kind: "send", to: { agent: "openclaw", id: OURS } }]);
  // A review can't go back to an OpenClaw chat Reach doesn't write in.
  assert.throws(() => checkSteps([{ kind: "review", agent: "claude" }, { kind: "back" }], { agent: "openclaw", id: WHATSAPP }, claw), /can't go back/);
});

test("a second opinion from OpenClaw: a new Reach chat, no mode, the note last, and the review back", async () => {
  const { relays, openClaw, sent, settle } = stage();
  const { relay, opened } = await relays.start({ owner: "phone", from: { agent: "codex", id: CODEX }, steps: [{ kind: "review", agent: "openclaw" }, { kind: "back" }], now: true });
  const call = openClaw.calls[0];
  assert.equal(call.method, "start");
  assert.match(call.requestId, new RegExp(`^relay-${relay.id}-0$`));
  assert.deepEqual(call.rest, {}, "no model, mode or channel");
  assert.match(call.text, /^Please review this work by Codex/);
  assert.match(call.text, /token was compared as a number/);
  assert.ok(call.text.endsWith(CLAW_NOTE));
  assert.deepEqual(openClaw.authorizedCalls, ["start"]);
  assert.equal(opened.agent, "openclaw");
  assert.match(opened.id, /^agent:main:reach-/);
  // Still working: nothing goes back yet.
  await settle();
  assert.equal(sent.length, 0);
  // Its reply (after the time OpenClaw stamped on our message) goes back once.
  openClaw.finish(opened.id, "Looks right; add a test for string tokens.");
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].agent, "codex");
  assert.equal(sent[0].id, CODEX);
  assert.match(sent[0].body.text, /add a test for string tokens/);
  assert.equal(relays.list()[0].state, "done");
});

test("a Codex reply relayed into a Reach-made OpenClaw chat: sent once, with a request id, never to a channel", async () => {
  const { relays, openClaw } = stage();
  await assert.rejects(
    relays.start({ owner: "phone", from: { agent: "codex", id: CODEX }, steps: [{ kind: "send", to: { agent: "openclaw", id: WHATSAPP } }], now: true }),
    /only in OpenClaw chats it made/,
  );
  // Reach-made by its key but no longer writable (a channel set behind it).
  openClaw.chats["agent:main:reach-bbbbbbbb"] = { session: { title: "Old", status: "idle", writable: false }, items: [] };
  await assert.rejects(
    relays.start({ owner: "phone", from: { agent: "codex", id: CODEX }, steps: [{ kind: "send", to: { agent: "openclaw", id: "agent:main:reach-bbbbbbbb" } }], now: true }),
    /only in OpenClaw chats it made/,
  );
  assert.equal(openClaw.calls.length, 0);
  const { relay } = await relays.start({ owner: "phone", from: { agent: "codex", id: CODEX }, steps: [{ kind: "send", to: { agent: "openclaw", id: OURS }, instructions: "Summarise this for me." }], now: true });
  const call = openClaw.calls.find((c) => c.method === "send");
  assert.equal(call.key, OURS);
  assert.equal(call.requestId, `relay-${relay.id}-0`);
  assert.deepEqual(call.rest, {}, "no deliver, no channel");
  assert.match(call.text, /^Summarise this for me\./);
  assert.ok(call.text.endsWith(CLAW_NOTE));
  assert.equal(relays.list()[0].state, "done");
});

test("from an OpenClaw chat (a WhatsApp ask) to Claude Code: a folder is picked, and the work starts there", async () => {
  const { relays, started } = stage();
  const from = { agent: "openclaw", id: WHATSAPP };
  await assert.rejects(relays.start({ owner: "phone", from, steps: [{ kind: "build", agent: "claude" }], now: true }), /Pick the folder/);
  await assert.rejects(relays.start({ owner: "phone", from, steps: [{ kind: "build", agent: "claude" }], now: true, cwd: "/etc" }), /Choose a folder/);
  const { opened } = await relays.start({ owner: "phone", from, steps: [{ kind: "build", agent: "claude" }], now: true, cwd: "/work/app" });
  assert.equal(opened.agent, "claude");
  assert.equal(started[0].body.cwd, "/work/app");
  assert.equal(started[0].body.mode, "auto");
  assert.match(started[0].body.text, /login page is broken on Safari/);
  // A key that isn't OpenClaw's shape is refused before anything is read.
  await assert.rejects(relays.start({ owner: "phone", from: { agent: "openclaw", id: "main\nx" }, steps: [{ kind: "build", agent: "claude" }], now: true, cwd: "/work/app" }), /Unknown chat/);
});

test("an OpenClaw run that errs or is never confirmed sends nothing on; its error text never travels", async () => {
  const { relays, openClaw, sent, settle } = stage();
  const { opened } = await relays.start({ owner: "phone", from: { agent: "codex", id: CODEX }, steps: [{ kind: "review", agent: "openclaw" }, { kind: "back" }], now: true });
  openClaw.fail(opened.id);
  await settle();
  assert.equal(sent.length, 0);
  assert.match(relays.list()[0].problem, /OpenClaw ended on an error/);
  const chats = agentChats({}, openClaw);
  const page = await chats.read("openclaw", opened.id);
  assert.equal(page.items.at(-1).kind, "error");
  assert.doesNotMatch(JSON.stringify(page), /sk-live|exploded/);
  openClaw.fail(opened.id, "unknown");
  const unknown = await chats.read("openclaw", opened.id);
  assert.match(unknown.items.at(-1).text, /hasn't confirmed/);
  assert.equal(unknown.session.status, "idle");
});

test("lost access stops an OpenClaw step before its client is called", async () => {
  let reason = "";
  const { relays, openClaw, pages, settle } = stage({ authorized: () => reason });
  await relays.start({ owner: "phone", from: { agent: "codex", id: CODEX }, steps: [{ kind: "build", agent: "openclaw" }] });
  reason = "The phone that set this up no longer has access.";
  pages[`codex:${CODEX}`].items.push(user("u2", "Again"), reply("a2", "Done again."));
  await settle();
  assert.equal(openClaw.calls.length, 0);
  assert.equal(relays.list()[0].state, "stopped");
  // And the client's own check: the authorize it's given throws then.
  const chats = agentChats({}, openClaw);
  await assert.rejects(
    chats.start("openclaw", {
      text: "x",
      requestId: "relay-test-0",
      authorize: () => {
        throw Object.assign(new Error(reason), { status: 403 });
      },
    }),
    /no longer has access/,
  );
});

// Post-back (Oct 8): a WhatsApp ask, Claude Code's answer posted back to it.
test("post-back: Claude Code's answer goes to the WhatsApp chat that asked, once, after its reply", async () => {
  const { relays, openClaw, pages, settle } = stage();
  const from = { agent: "openclaw", id: WHATSAPP };
  // Only from an OpenClaw chat, and only as a yes.
  await assert.rejects(
    relays.start({ owner: "phone", from: { agent: "codex", id: CODEX }, steps: [{ kind: "review", agent: "claude" }], now: true, postBack: true }),
    /Only a WhatsApp or Telegram chat/,
  );
  await assert.rejects(relays.start({ owner: "phone", from, steps: [{ kind: "build", agent: "claude" }], now: true, cwd: "/work/app", postBack: "yes" }), /Only a WhatsApp/);
  // The phone can't ask for a "post" step itself.
  assert.throws(() => checkSteps([{ kind: "post" }], from, ["codex", "claude", "openclaw"]), /Unknown step/);
  const { relay, opened } = await relays.start({ owner: "phone", from, steps: [{ kind: "build", agent: "claude" }], now: true, cwd: "/work/app", postBack: true });
  assert.equal(relays.list()[0].state, "waiting");
  // Still working: nothing posted.
  await settle();
  assert.equal(openClaw.calls.filter((c) => c.method === "post").length, 0);
  pages[`claude:${opened.id}`].session.status = "idle";
  pages[`claude:${opened.id}`].items.push(reply("c-r1", "Fixed: Safari blocked the third-party cookie."));
  await settle();
  const posts = openClaw.calls.filter((c) => c.method === "post");
  assert.deepEqual(posts, [{ method: "post", key: WHATSAPP, text: "Fixed: Safari blocked the third-party cookie.", requestId: `relay-${relay.id}-post`, to: { channel: "whatsapp", to: "+33600000000" } }]);
  assert.equal(relays.list()[0].state, "done");
  // Seen again: never posted twice.
  await settle();
  assert.equal(openClaw.calls.filter((c) => c.method === "post").length, 1);
});

test("post-back: refused up front for a group, and keys in the answer are hidden", async () => {
  const { relays, openClaw, pages, settle } = stage();
  const GROUP = "agent:main:whatsapp:group:120@g.us";
  pages[`openclaw:${GROUP}`] = { session: { title: "Friends", status: "idle" }, items: [user("g1", "Hi")] };
  await assert.rejects(
    relays.start({ owner: "phone", from: { agent: "openclaw", id: GROUP }, steps: [{ kind: "build", agent: "claude" }], cwd: "/work/app", postBack: true }),
    /one-to-one/,
  );
  assert.equal(relays.list().length, 0);
  const { opened } = await relays.start({ owner: "phone", from: { agent: "openclaw", id: WHATSAPP }, steps: [{ kind: "build", agent: "claude" }], now: true, cwd: "/work/app", postBack: true });
  pages[`claude:${opened.id}`].session.status = "idle";
  pages[`claude:${opened.id}`].items.push(reply("c-r1", "Here: OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234 and Bearer abc.def"));
  await settle();
  const [post] = openClaw.calls.filter((c) => c.method === "post");
  assert.equal(post.text, "Here: OPENAI_API_KEY=[hidden] and Bearer [hidden]");
});

test("post-back stops when access is gone, before anything is posted", async () => {
  let reason = "";
  const { relays, openClaw, pages, settle } = stage({ authorized: () => reason });
  const { opened } = await relays.start({ owner: "phone", from: { agent: "openclaw", id: WHATSAPP }, steps: [{ kind: "build", agent: "claude" }], now: true, cwd: "/work/app", postBack: true });
  reason = "The phone that set this up no longer has access.";
  pages[`claude:${opened.id}`].session.status = "idle";
  pages[`claude:${opened.id}`].items.push(reply("c-r1", "Done."));
  await settle();
  assert.equal(openClaw.calls.filter((c) => c.method === "post").length, 0);
  assert.equal(relays.list()[0].state, "stopped");
});
