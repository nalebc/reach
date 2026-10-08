import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createOpenClaw } from "../server/openclaw.mjs";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";
import { createClaudeSessions } from "../server/agent-sessions/claude.mjs";
import { createCodexLive } from "../server/agent-sessions/codex-live.mjs";
import { openClawNotes } from "../server/agent-sessions/move.mjs";

// Chats move to and from OpenClaw too: a session of its own there, named
// after the chat, its history added as notes (shown in OpenClaw's app, read
// by its agent; verified against the real Gateway, Oct 5).
const CLAUDE = "11111111-2222-4333-8444-555555555555";
const NEW_CODEX = "0199ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee";

// A Gateway that answers each method from `replies` (an Error refuses it).
function gateway(replies = {}) {
  const calls = [];
  class Socket extends EventEmitter {
    readyState = 1;
    constructor() {
      super();
      queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ type: "event", event: "connect.challenge", payload: { nonce: "n" } }))));
    }
    send(raw) {
      const req = JSON.parse(raw);
      calls.push(req);
      queueMicrotask(async () => {
        const value = req.method === "connect" ? { type: "hello-ok", protocol: 3 } : replies[req.method] ?? {};
        const reply = typeof value === "function" ? await value(req) : value;
        const failed = reply instanceof Error;
        this.emit(
          "message",
          Buffer.from(JSON.stringify({ type: "res", id: req.id, ok: !failed, payload: failed ? undefined : reply, error: failed ? { message: reply.message } : undefined })),
        );
      });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close");
    }
    terminate() {
      this.close();
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-claw-move-"));
  const claw = createOpenClaw({ dataDir: dir, Socket, configuration: async () => ({ url: "ws://127.0.0.1:18789", token: "secret-gateway-token" }) });
  return { claw, calls, dir };
}

test("into OpenClaw: a new session named after the chat, its history as notes; one that fails half-way is removed", async () => {
  const { claw, calls, dir } = gateway();
  const { key } = await claw.fork({ title: "Login page", notes: ["first part", "second part"], label: "Moved from Claude Code" });
  assert.match(key, /^agent:main:reach-[0-9a-f]{8}$/);
  const asked = calls.filter((c) => c.method !== "connect").map((c) => [c.method, c.params]);
  assert.deepEqual(asked, [
    ["sessions.reset", { key, reason: "new" }],
    ["sessions.patch", { key, label: "Login page" }],
    ["chat.inject", { sessionKey: key, message: "first part", label: "Moved from Claude Code" }],
    ["chat.inject", { sessionKey: key, message: "second part", label: "Moved from Claude Code" }],
  ]);
  claw.close();
  const failing = gateway({ "chat.inject": new Error("too large") });
  await assert.rejects(failing.claw.fork({ title: "x", notes: ["n"] }), /OpenClaw reported an error/);
  const removed = failing.calls.find((c) => c.method === "sessions.delete");
  assert.equal(removed.params.deleteTranscript, true);
  assert.match(removed.params.key, /^agent:main:reach-/);
  failing.claw.close();
  for (const d of [dir, failing.dir]) fs.rmSync(d, { recursive: true, force: true });
});

test("OpenClaw notes: the move said first, each side named, in pieces it takes one at a time", () => {
  const notes = openClawNotes(
    [
      { role: "user", text: "Build the login page" },
      { role: "assistant", text: "Built it." },
      { role: "user", text: "x".repeat(70) },
    ],
    { note: "Moved here.", from: "Claude Code", max: 80 },
  );
  assert.deepEqual(notes.slice(0, 1), ["Moved here.\n\n**You:** Build the login page\n\n**Claude Code:** Built it."]);
  assert.equal(notes.length, 2);
  assert.ok(notes.every((n) => n.length <= 80));
});

const claudeChat = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  const base = { sessionId: CLAUDE, cwd: "/work/app", entrypoint: "claude-desktop" };
  fs.writeFileSync(
    path.join(dir, `${CLAUDE}.jsonl`),
    [
      JSON.stringify({ type: "custom-title", customTitle: "Login page", sessionId: CLAUDE }),
      JSON.stringify({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: new Date(1e12).toISOString(), message: { role: "user", content: "Build the login page" } }),
      JSON.stringify({ ...base, type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: new Date(1e12 + 1000).toISOString(), message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "Built it." }] } }),
    ].join("\n") + "\n",
  );
};
const fakeDaemon = () => {
  const calls = [];
  return {
    calls,
    async rpc(method, params) {
      calls.push([method, params]);
      return { "model/list": { data: [{ id: "gpt-6-astra", isDefault: true }] }, "thread/fork": { thread: { id: NEW_CODEX } } }[method] ?? {};
    },
    onNotification() {},
    onRequest() {},
    onClose() {},
    close() {},
  };
};
const hub = (openClaw, extra = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-claw-hub-"));
  claudeChat(path.join(root, "projects", "-work-app"));
  const daemon = fakeDaemon();
  const sessions = createAgentSessions({
    daemon,
    codexLive: createCodexLive({ daemon }),
    claude: createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records"), run: async () => ({ stdout: "2.1.289" }) }),
    codex: {
      read: async (id) => ({ session: { agent: "codex", id, title: "", cwd: "/work/app", status: "idle" }, items: [], before: null }),
      list: async () => [],
      health: async () => ({ agent: "codex", signedIn: true }),
    },
    live: async () => new Map(),
    detect: async () => [],
    dataDir: root,
    claudeImports: { add: async () => {}, close() {} },
    openClaw,
    ...extra,
  });
  return { root, daemon, sessions };
};

test("a Claude Code chat moves into OpenClaw, and says where it went", async () => {
  const forks = [];
  const { root, sessions } = hub({ fork: async (f) => (forks.push(f), { key: "agent:main:reach-0001" }), history: async () => ({ items: [] }) });
  assert.deepEqual(await sessions.move("claude", CLAUDE, { to: "openclaw" }), { agent: "openclaw", id: "agent:main:reach-0001" });
  assert.equal(forks[0].title, "Login page");
  assert.equal(forks[0].label, "Moved from Claude Code");
  assert.match(forks[0].notes[0], /^This conversation was moved here from Claude Code \(“Login page”, in \/work\/app\)\.[\s\S]*\*\*You:\*\* Build the login page\n\n\*\*Claude Code:\*\* Built it\.$/);
  const old = await sessions.read("claude", CLAUDE, {});
  assert.deepEqual(old.session.movedTo.map((m) => [m.agent, m.id]), [["openclaw", "agent:main:reach-0001"]]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an OpenClaw chat moves to Codex, shown as a fork of it", async () => {
  const key = "agent:main:discord:channel:9";
  const { root, daemon, sessions } = hub({
    fork: async () => ({ key: "unused" }),
    history: async (asked) => ({
      session: { key: asked, title: "Weekend plans", model: "claude-opus-4-6" },
      items: [
        { id: "m1", role: "user", text: "Plan Saturday", at: 1 },
        { id: "m2", role: "toolResult", tool: true, text: "weather: sunny", at: 2 },
        { id: "m3", role: "assistant", text: "A hike, then lunch.", at: 3 },
      ],
    }),
  });
  assert.deepEqual(await sessions.move("openclaw", key, { to: "codex" }), { agent: "codex", id: NEW_CODEX });
  const file = daemon.calls.find(([m]) => m === "thread/fork")[1].path;
  const injected = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse).filter(e => e.type === "response_item").map(e => e.payload);
  assert.deepEqual(
    injected.map((i) => i.content[0].text),
    ["Plan Saturday", "[Historical tool]\nweather: sunny", "A hike, then lunch.", "Continued with Codex · earlier messages are from OpenClaw"],
  );
  assert.ok(!daemon.calls.some(([m]) => m === "thread/inject_items"));
  const page = await sessions.read("codex", NEW_CODEX, {});
  assert.equal(page.session.movedFrom.agent, "openclaw");
  // Only between the apps Reach chats with.
  await assert.rejects(sessions.move("openclaw", key, { to: "gemini" }), (e) => e.status === 400);
  fs.rmSync(root, { recursive: true, force: true });
});

test("revocation during source history prevents creating an OpenClaw target", async (t) => {
  let release, arrived;
  const ready = new Promise((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let forks = 0,
    revoked = false;
  const f = hub(
    {
      fork: async () => {
        forks++;
        return { key: "agent:main:reach-audit" };
      },
    },
    {
      codex: {
        read: async (id) => {
          arrived();
          await gate;
          return {
            session: {
              agent: "codex",
              id,
              title: "Synthetic source",
              cwd: "/work/app",
            },
            items: [],
            before: null,
          };
        },
      },
    },
  );
  t.after(() => {
    f.sessions.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const work = f.sessions.move("codex", NEW_CODEX, {
    to: "openclaw",
    authorize() {
      if (revoked) throw Object.assign(Error("Revoked"), { status: 401 });
    },
  });
  await ready;
  revoked = true;
  release();
  await assert.rejects(work, { status: 401 });
  assert.equal(forks, 0);
});

test("revocation after the final OpenClaw note cleans only the created target and never records a move", async (t) => {
  let release, arrived;
  const ready = new Promise((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const f = gateway({
    "chat.inject": async () => {
      arrived();
      await gate;
      return {};
    },
  });
  const h = hub(f.claw);
  t.after(() => {
    h.sessions.close();
    f.claw.close();
    for (const dir of [h.root, f.dir])
      fs.rmSync(dir, { recursive: true, force: true });
  });
  let revoked = false;
  const work = h.sessions.move("claude", CLAUDE, {
    to: "openclaw",
    authorize() {
      if (revoked) throw Object.assign(Error("Revoked"), { status: 401 });
    },
  });
  await ready;
  revoked = true;
  release();
  await assert.rejects(work, { status: 401 });
  const created = f.calls.find((req) => req.method === "sessions.reset").params
    .key;
  assert.deepEqual(
    f.calls
      .filter((req) => req.method === "sessions.delete")
      .map((req) => req.params),
    [{ key: created, deleteTranscript: true }],
  );
  const original = await h.sessions.read("claude", CLAUDE, {});
  assert.equal(original.session.movedTo?.length || 0, 0);
});

test("revoked owner HTTP move request forwards live authorization to deferred provider work", async (t) => {
  const { createReach } = await import("../server/index.mjs");
  const { ALL_SCOPES } = await import("../server/core.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-claw-move-auth-"));
  let release,
    arrived,
    writes = 0;
  const ready = new Promise((resolve) => {
    arrived = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: {
      async move(_agent, _id, { authorize = () => {} }) {
        arrived();
        await gate;
        authorize();
        writes++;
        return { agent: "openclaw", id: "agent:main:reach-audit" };
      },
    },
  });
  t.after(async () => {
    await reach.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const work = fetch(
    `http://127.0.0.1:${reach.server.address().port}/api/sessions/claude/${CLAUDE}/move`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ to: "openclaw" }),
    },
  );
  await ready;
  reach.auth.revoke(owner.clientId);
  release();
  assert.equal((await work).status, 401);
  assert.equal(writes, 0);
});
