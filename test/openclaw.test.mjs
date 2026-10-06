import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { createOpenClaw, localOpenClawConfig } from "../server/openclaw.mjs";

const rows = [
  {
    key: "agent:main:whatsapp:direct:123",
    displayName: "Family plans",
    channel: "whatsapp",
    updatedAt: 100,
    deliveryContext: { channel: "whatsapp", to: "123" },
  },
  {
    key: "agent:work:discord:channel:456",
    displayName: "Launch",
    channel: "discord",
    updatedAt: 200,
    deliveryContext: { channel: "discord", to: "456" },
  },
  { key: "agent:main:main", displayName: "Direct", updatedAt: 1 },
  // A chat Reach made itself (webchat): the only kind Reach writes in.
  { key: "agent:main:reach-1a2b3c4d", label: "Login page", channel: "webchat", updatedAt: 50 },
];
const REACH = rows[3].key;
async function fixture(t, extra = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claw-test-"));
  const calls = [],
    sockets = [];
  let handler;
  class Socket extends EventEmitter {
    readyState = 1;
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() =>
        this.event("connect.challenge", { nonce: "challenge" }),
      );
    }
    event(event, payload) {
      this.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "event", event, payload })),
      );
    }
    send(raw) {
      const req = JSON.parse(raw);
      calls.push(req);
      queueMicrotask(() => {
        if (this.readyState !== 1) return;
        const custom = handler?.(req, this);
        if (custom?.drop || custom?.hold) return;
        const payload =
          custom?.payload ??
          {
            connect: { type: "hello-ok", protocol: 3 },
            "sessions.list": { sessions: rows },
            "channels.status": { channelAccounts: { whatsapp: [{ accountId: "default", connected: true }] } },
            "chat.history": {
              messages: [
                { id: "1", role: "user", content: "Hello" },
                {
                  id: "2",
                  role: "assistant",
                  content: [
                    { type: "thinking", thinking: "private" },
                    { type: "text", text: "Hi" },
                  ],
                },
                {
                  id: "3",
                  role: "toolResult",
                  content: [{ type: "text", text: "Result" }],
                },
              ],
            },
            "chat.send": {
              runId: req.params.idempotencyKey,
              status: "started",
            },
            agent: { runId: req.params.idempotencyKey, status: "accepted" },
            "agent.wait": { runId: req.params.runId, status: "timeout" },
            "chat.abort": { aborted: true },
            "exec.approval.resolve": { ok: true },
            "channels.status": {
              channelAccounts: {
                whatsapp: [
                  {
                    accountId: "default",
                    running: true,
                    connected: true,
                    linked: true,
                  },
                ],
              },
            },
          }[req.method] ??
          {};
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              type: "res",
              id: req.id,
              ok: !custom?.error,
              payload,
              error: custom?.error,
            }),
          ),
        );
      });
    }
    response(id, payload, error) {
      this.emit(
        "message",
        Buffer.from(
          JSON.stringify({ type: "res", id, ok: !error, payload, error }),
        ),
      );
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
  const c = createOpenClaw({
    dataDir: dir,
    Socket,
    configuration: async () => ({
      url: "ws://127.0.0.1:18789",
      token: "secret-token",
    }),
    ...extra,
  });
  t.after(async () => {
    c.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    c,
    calls,
    sockets,
    dir,
    handle(fn) {
      handler = fn;
    },
  };
}

test("all agents/channels discovered with metadata only; signed minimal-scope handshake", async (t) => {
  const { c, calls, dir } = await fixture(t);
  const r = await c.overview();
  assert.equal(r.connected, true);
  assert.equal(r.sessions.length, 4);
  // Named for people, never OpenClaw's raw ids; only Reach's own chat is writable.
  assert.deepEqual(
    Object.fromEntries(r.sessions.map((s) => [s.key, [s.title, s.writable]])),
    {
      [rows[0].key]: ["Family plans", false],
      [rows[1].key]: ["Launch", false],
      [rows[2].key]: ["Direct", false],
      [REACH]: ["Login page", true],
    },
  );
  assert.deepEqual(
    new Set(r.sessions.map((s) => s.agentId)),
    new Set(["main", "work"]),
  );
  assert.deepEqual(calls.find((c) => c.method === "sessions.list").params, {
    includeGlobal: true,
    includeUnknown: true,
  });
  assert.equal(
    calls.some((c) => c.method === "chat.history"),
    false,
  );
  assert.equal(JSON.stringify(r).includes("secret-token"), false);
  const p = calls[0].params,
    d = p.device;
  assert.deepEqual(p.scopes, [
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.admin",
  ]);
  const data = [
    "v3",
    d.id,
    p.client.id,
    p.client.mode,
    p.role,
    p.scopes.join(","),
    String(d.signedAt),
    p.auth.token,
    d.nonce,
    p.client.platform,
    "",
  ].join("|");
  const key = crypto.createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(d.publicKey, "base64url"),
    ]),
    type: "spki",
    format: "der",
  });
  assert.equal(
    crypto.verify(
      null,
      Buffer.from(data),
      key,
      Buffer.from(d.signature, "base64url"),
    ),
    true,
  );
  if (process.platform !== "win32") assert.equal(
    (await fs.stat(path.join(dir, "openclaw-device.json"))).mode & 0o777,
    0o600,
  );
});

test("history loads only selected known session, filters reasoning, clamps limit", async (t) => {
  const { c, calls } = await fixture(t);
  const h = await c.history(rows[1].key, 3000);
  assert.deepEqual(
    h.items.map((i) => i.text),
    ["Hello", "Hi", "Result"],
  );
  assert.equal(h.items[2].tool, true);
  assert.deepEqual(calls.find((c) => c.method === "chat.history").params, {
    sessionKey: rows[1].key,
    limit: 1000,
  });
  await assert.rejects(c.history("agent:other:unknown"), /no longer available/);
  await assert.rejects(c.history("bad\nkey"), /Choose/);
});

test("Reach never asks OpenClaw to post outside Reach; retry uses caller idempotency key", async (t) => {
  const { c, calls, sockets } = await fixture(t);
  const message = {
    key: REACH,
    text: "Draft",
    requestId: "retry-same-id",
  };
  await c.send(message);
  await c.send(message);
  assert.equal(calls.filter(c => c.method === "chat.send").length, 1);
  sockets[0].event("chat", { sessionKey: message.key, runId: message.requestId, state: "final" });
  // Oct 5: a "reply via WhatsApp" reached a WhatsApp group of friends.
  // Refused before any Gateway call, for every session and any non-false value.
  const before = calls.length;
  for (const [i, [key, deliver]] of [
    [rows[0].key, true],
    [rows[1].key, true],
    [rows[2].key, true],
    [rows[0].key, "true"],
    [rows[0].key, 1],
  ].entries())
    await assert.rejects(
      c.send({ ...message, key, deliver, requestId: `external-reply-${i}` }),
      (e) => e.status === 403 && /doesn’t post to WhatsApp/.test(e.message),
    );
  assert.deepEqual(calls.slice(before).map((c) => c.method), []);
  // A WhatsApp, Discord or other chat Reach didn't make: never written to,
  // even without asking to post outside (a message there runs the agent in
  // that group's context).
  for (const [i, row] of rows.slice(0, 3).entries())
    await assert.rejects(
      c.send({ ...message, key: row.key, requestId: `foreign-${i}` }),
      (e) => e.status === 403 && /Reach shows it but doesn’t write in it/.test(e.message) && /Nothing was sent/.test(e.message),
    );
  assert.equal(calls.slice(before).some((c) => ["chat.send", "agent"].includes(c.method)), false);
  const sends = calls
    .filter((c) => c.method === "chat.send")
    .map((c) => c.params);
  assert.deepEqual(sends, [
    {
      sessionKey: REACH,
      message: "Draft",
      deliver: false,
      idempotencyKey: message.requestId,
    },
  ]);
  const { sessions } = await c.overview();
  assert.equal(sessions.some((s) => "canDeliver" in s), false);
  await assert.rejects(c.send({ ...message, text: "" }), /Enter a message/);
  await c.stop(rows[0].key);
  assert.deepEqual(calls.at(-1).params, { sessionKey: rows[0].key });
});

test("history shows each turn once: fallback retries and delivery mirrors are OpenClaw's bookkeeping", async (t) => {
  const { c, handle } = await fixture(t);
  const retry =
    "Continue where you left off. The previous model attempt failed or timed out.";
  const user = (text) => ({ role: "user", content: text });
  const failed = (model) => ({ role: "assistant", content: [], model, stopReason: "error", errorMessage: "billing" });
  const said = (text, extra = {}) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    model: "gpt-4o",
    stopReason: "stop",
    ...extra,
  });
  const mirror = (text) => said(text, { provider: "openclaw", model: "delivery-mirror" });
  // The shape OpenClaw wrote on Oct 5 (a chat.send turn, then an agent turn),
  // plus genuine repeats and messages after a failed run, which must stay.
  const messages = [
    user("Test"), failed("claude-opus-4-6"), user("Test"), failed("gpt-5.1-codex"), user("Test"),
    said("Multiple entries?"), mirror("Multiple entries?"),
    user("Hey"), failed("claude-opus-4-6"), user(retry), failed("gpt-5.1-codex"), user(retry), said("I'm here"),
    user("yes"), said("Done"), user("yes"), said("Done"),
    user("Hi"), failed("claude-opus-4-6"), user("Are you there?"),
    mirror("Sent by a tool"),
  ];
  handle((req) => (req.method === "chat.history" ? { payload: { messages } } : undefined));
  const h = await c.history(rows[0].key);
  assert.deepEqual(
    h.items.map((i) => [i.id, i.role, i.text, i.sentTo]),
    [
      ["0:0", "user", "Test", undefined],
      ["0:5", "assistant", "Multiple entries?", "whatsapp"],
      ["0:7", "user", "Hey", undefined],
      ["0:12", "assistant", "I'm here", undefined],
      ["0:13", "user", "yes", undefined],
      ["0:14", "assistant", "Done", undefined],
      ["0:15", "user", "yes", undefined],
      ["0:16", "assistant", "Done", undefined],
      ["0:17", "user", "Hi", undefined],
      ["0:19", "user", "Are you there?", undefined],
      ["0:20", "assistant", "Sent by a tool", undefined],
    ],
  );
});

test("streaming, completed-before-response race, approval expiry and explicit resolution", async (t) => {
  const { c, sockets, handle, calls } = await fixture(t);
  await c.overview();
  const ws = sockets[0];
  ws.event("chat", {
    sessionKey: rows[0].key,
    runId: "r",
    state: "delta",
    message: { content: "Streaming" },
  });
  assert.equal((await c.history(rows[0].key)).streaming, "Streaming");
  ws.event("chat", { sessionKey: rows[0].key, runId: "r", state: "final" });
  handle((req, socket) => {
    if (req.method === "chat.send")
      socket.event("chat", {
        sessionKey: REACH,
        runId: req.params.idempotencyKey,
        state: "final",
      });
  });
  await c.send({ key: REACH, text: "Hi", requestId: "message-id" });
  assert.equal((await c.history(REACH)).session.status, "idle");
  const prompt = {
    id: "approval",
    request: { command: "npm test", sessionKey: rows[0].key },
    expiresAtMs: Date.now() + 60000,
  };
  ws.event("exec.approval.requested", prompt);
  assert.equal((await c.history(rows[1].key)).approvals.length, 0);
  assert.equal((await c.history(rows[0].key)).approvals.length, 1);
  await assert.rejects(
    c.approve("approval", "allow-always"),
    /Allow once or Deny/,
  );
  assert.equal(
    calls.some((c) => c.method === "exec.approval.resolve"),
    false,
  );
  await c.approve("approval", "allow-once");
  assert.deepEqual(calls.at(-1).params, {
    id: "approval",
    decision: "allow-once",
  });
  ws.event("exec.approval.requested", {
    ...prompt,
    expiresAtMs: Date.now() - 1,
  });
  await assert.rejects(c.approve("approval", "deny"), /expired/);
});

test("disconnect reconnects and Gateway errors cannot echo its credentials", async (t) => {
  const { c, sockets, handle } = await fixture(t);
  await c.overview();
  sockets[0].close();
  assert.equal((await c.overview()).connected, true);
  assert.equal(sockets.length, 2);
  handle((req) =>
    req.method === "chat.history"
      ? { error: { message: "invalid secret-token" } }
      : null,
  );
  await assert.rejects(c.history(rows[0].key), /invalid \[redacted\]/);
});

test("reads JSON5 local config and environment substitutions; remote profiles refused", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claw-config-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const file = path.join(home, "profile.json");
  await fs.writeFile(
    file,
    "{gateway: {port: 19999, auth: {token: '${LOCAL_SECRET}'}},}",
  );
  assert.deepEqual(
    await localOpenClawConfig({
      home,
      env: { OPENCLAW_CONFIG_PATH: file, LOCAL_SECRET: "value" },
    }),
    { url: "ws://127.0.0.1:19999", token: "value", password: undefined },
  );
  await fs.writeFile(file, '{gateway:{mode:"remote"}}');
  await assert.rejects(
    localOpenClawConfig({ home, env: { OPENCLAW_CONFIG_PATH: file } }),
    /remote Gateway/,
  );
  await assert.rejects(localOpenClawConfig({ home, env: {} }), /not found/);
});

test("OpenClaw HTTP routes inherit owner-device authentication before reaching the bridge", async (t) => {
  const { createReach } = await import("../server/index.mjs");
  const { ALL_SCOPES } = await import("../server/core.mjs");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claw-http-"));
  const calls = [];
  const fake = Object.fromEntries(
    ["overview", "history", "send", "stop", "approve"].map((method) => [
      method,
      async (...args) => {
        calls.push({ method, args });
        return { ok: true };
      },
    ]),
  );
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, ".reach"),
    openClaw: fake,
    agentSessions: {},
  });
  t.after(async () => {
    await reach.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}/api/sessions/openclaw`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["terminal", "files"], "agent");
  const linked = reach.auth.issue("linked", ALL_SCOPES, "linked-mac");
  const routes = [
    ["overview", "GET"],
    ["history?key=agent%3Amain%3Amain", "GET"],
    ["send", "POST"],
    ["stop", "POST"],
    ["approval", "POST"],
  ];
  for (const [route, method] of routes) {
    assert.equal((await fetch(`${url}/${route}`, { method })).status, 401);
    for (const credential of [agent, linked])
      assert.equal(
        (
          await fetch(`${url}/${route}`, {
            method,
            headers: { Authorization: `Bearer ${credential.token}` },
          })
        ).status,
        403,
      );
  }
  assert.equal(calls.length, 0);
  for (const [route, method] of routes)
    assert.equal(
      (
        await fetch(`${url}/${route}`, {
          method,
          headers: {
            Authorization: `Bearer ${owner.token}`,
            "Content-Type": "application/json",
          },
          ...(method === "POST"
            ? {
                body: JSON.stringify({
                  key: rows[0].key,
                  text: "test",
                  requestId: "test-request",
                  id: "approval",
                  decision: "deny",
                }),
              }
            : {}),
        })
      ).status,
      200,
    );
  assert.deepEqual(
    calls.map((c) => c.method),
    ["overview", "history", "send", "stop", "approve"],
  );
});

test("missing final chat event recovers through agent.wait and does not duplicate the history bubble", async (t) => {
  const { c, sockets, handle } = await fixture(t, { reconcileMs: 0 });
  await c.send({ key: REACH, text: "Hello", requestId: "recover-run" });
  sockets[0].event("chat", {
    sessionKey: REACH,
    runId: "recover-run",
    state: "delta",
    message: { content: "Hi" },
  });
  assert.equal((await c.history(REACH)).streaming, "");
  handle((req) =>
    req.method === "agent.wait"
      ? { payload: { runId: req.params.runId, status: "ok" } }
      : null,
  );
  const h = await c.history(REACH);
  assert.equal(h.session.status, "idle");
  assert.equal(h.items.filter((m) => m.text === "Hi").length, 1);
});

test("agent lifecycle completion works without a chat final; stale foreign events cannot reopen or finish a run", async (t) => {
  const { c, sockets } = await fixture(t);
  await c.send({ key: REACH, text: "Hello", requestId: "lifecycle-run" });
  const ws = sockets[0];
  ws.event("agent", {
    sessionKey: REACH,
    runId: "older-run",
    stream: "lifecycle",
    data: { phase: "end" },
  });
  assert.equal((await c.history(REACH)).session.status, "running");
  ws.event("agent", {
    sessionKey: REACH,
    runId: "lifecycle-run",
    stream: "lifecycle",
    data: { phase: "end" },
  });
  ws.event("chat", {
    sessionKey: REACH,
    runId: "lifecycle-run",
    state: "delta",
    message: { content: "late" },
  });
  assert.equal((await c.history(REACH)).session.status, "idle");
});

test("an acknowledged completed replay does not restart the spinner", async (t) => {
  const { c, handle } = await fixture(t);
  handle((req) =>
    req.method === "chat.send"
      ? { payload: { runId: req.params.idempotencyKey, status: "ok" } }
      : null,
  );
  const sent = await c.send({
    key: REACH,
    text: "Hello",
    requestId: "cached-complete",
  });
  assert.equal(sent.status, "idle");
  assert.equal((await c.history(REACH)).session.status, "idle");
});

test("unconfirmed runs become actionable instead of spinning indefinitely; no automatic resend", async (t) => {
  let clock = 1000;
  const { c, calls } = await fixture(t, {
    now: () => clock,
    reconcileMs: 0,
    staleMs: 100,
  });
  await c.send({ key: REACH, text: "Hello", requestId: "stalled-run" });
  clock += 101;
  const h = await c.history(REACH);
  assert.equal(h.session.status, "unknown");
  assert.match(h.error, /not confirmed completion/);
  await assert.rejects(
    c.send({ key: REACH, text: "Again", requestId: "another-run" }),
    /unconfirmed/,
  );
  assert.equal(calls.filter((r) => r.method === "chat.send").length, 1);
});

test("reconnection reconciles the same run, without resending the message", async (t) => {
  const { c, calls, sockets, handle } = await fixture(t, { reconcileMs: 0 });
  await c.send({ key: REACH, text: "Hello", requestId: "reconnect-run" });
  sockets[0].close();
  handle((req) =>
    req.method === "agent.wait"
      ? { payload: { runId: req.params.runId, status: "ok" } }
      : null,
  );
  assert.equal((await c.history(REACH)).session.status, "idle");
  assert.equal(sockets.length, 2);
  assert.equal(calls.filter((r) => r.method === "chat.send").length, 1);
});

test("external delivery is refused regardless of channel configuration or client overrides", async (t) => {
  const { c, calls } = await fixture(t);
  for (const key of [REACH, REACH, rows[1].key]) {
    await assert.rejects(c.send({ key, text: "Hello", deliver: true, requestId: "blocked-delivery", replyTo: "injected" }), { status: 403 });
  }
  assert.equal(calls.some((call) => ["agent", "chat.send"].includes(call.method)), false);
});

test("concurrent identical requests send once; reused IDs cannot change message or destination", async (t) => {
  const { c, calls } = await fixture(t);
  const message = { key: REACH, text: "Hello", requestId: "double-tap" };
  const result = await Promise.all([c.send(message), c.send(message)]);
  assert.deepEqual(result[0], result[1]);
  assert.equal(calls.filter((r) => r.method === "chat.send").length, 1);
  await assert.rejects(c.send({ ...message, deliver: true }), { status: 403 });
  await assert.rejects(
    c.send({ ...message, text: "Different" }),
    /already used/,
  );
});

test("unrecognized send results are uncertain, never fake success or a second send", async (t) => {
  const { c, calls, handle } = await fixture(t);
  handle((req) =>
    req.method === "chat.send" ? { payload: { unexpected: true } } : null,
  );
  const message = {
    key: REACH,
    text: "Hello",
    requestId: "unknown-result",
  };
  await assert.rejects(c.send(message), /unrecognized/);
  await assert.rejects(c.send(message), /unrecognized/);
  assert.equal((await c.history(REACH)).session.status, "unknown");
  assert.equal(calls.filter((r) => r.method === "chat.send").length, 1);
});

test("unsupported history and failed stop acknowledgements do not masquerade as empty/success", async (t) => {
  const { c, handle } = await fixture(t);
  await c.send({ key: REACH, text: "Hello", requestId: "stop-denied" });
  handle((req) =>
    req.method === "chat.abort" ? { payload: { aborted: false } } : null,
  );
  await assert.rejects(c.stop(REACH), /did not confirm stopping/);
  assert.equal((await c.history(REACH)).session.status, "running");
  handle((req) =>
    req.method === "chat.history" ? { payload: { unsupported: true } } : null,
  );
  await assert.rejects(
    c.history(REACH, 100),
    /unsupported conversation history/,
  );
});

test("OpenClaw keeps approvals until acknowledged, rejects duplicates, and retains failed answers", async t => {
  const { c, sockets, handle, calls } = await fixture(t);
  await c.overview();
  const ws = sockets[0];
  ws.event("exec.approval.requested", { id: "real", request: { command: "npm test", sessionKey: rows[0].key }, expiresAtMs: Date.now() + 60000 });
  handle(req => req.method === "exec.approval.resolve" ? { hold: true } : undefined);
  const pending = c.approve("real", "allow-once");
  await assert.rejects(c.approve("real", "deny"), /already being sent/);
  const request = calls.find(r => r.method === "exec.approval.resolve");
  assert.equal((await c.history(rows[0].key)).approvals.length, 1);
  ws.emit("message", Buffer.from(JSON.stringify({ type: "res", id: request.id, ok: true, payload: { ok: false } })));
  await assert.rejects(pending, /did not confirm/);
  assert.equal((await c.history(rows[0].key)).approvals.length, 1);
  handle(() => undefined);
  await assert.rejects(c.approve("real", "deny"), /already attempted/);
  assert.equal(calls.filter(r => r.method === "exec.approval.resolve").length, 1);
  ws.event("exec.approval.resolved", { id: "real" });
  assert.equal((await c.history(rows[0].key)).approvals.length, 0);
});

test("OpenClaw exposes only native pending requests, clears resolutions and disconnects, and gates unavailable responses", async t => {
  const { c, sockets, handle, calls } = await fixture(t);
  handle(req => req.method === "connect" ? { payload: { features: { methods: ["sessions.list", "chat.history"] } } } : undefined);
  await c.overview();
  const ws = sockets[0];
  const prompt = { id: "real", request: { command: "npm test", sessionKey: rows[0].key }, expiresAtMs: Date.now() + 60000 };
  ws.event("exec.approval.requested", { ...prompt, id: undefined });
  ws.event("exec.approval.requested", { ...prompt, request: {} });
  ws.event("chat", { message: { content: "Please approve npm test" } });
  assert.equal((await c.history(rows[0].key)).approvals.length, 0);
  ws.event("exec.approval.requested", prompt);
  assert.equal((await c.history(rows[0].key)).approvals[0].canRespond, false);
  await assert.rejects(c.approve("real", "deny"), /cannot accept approvals/);
  ws.event("exec.approval.resolved", { id: "real" });
  await assert.rejects(c.approve("real", "deny"), /already answered/);
  ws.event("exec.approval.requested", { ...prompt, id: "lost" });
  ws.close();
  await assert.rejects(c.approve("lost", "allow-once"), /already answered/);
  assert.equal(sockets.length, 1, "answering does not reconnect to deliver an old decision");
  assert.equal(calls.some(r => r.method === "exec.approval.resolve"), false);
});

test("OpenClaw disconnect while an answer is in flight fails instead of reporting success", async t => {
  const { c, sockets, handle } = await fixture(t);
  await c.overview();
  sockets[0].event("exec.approval.requested", { id: "lost", request: { command: "npm test" }, expiresAtMs: Date.now() + 60000 });
  handle(req => req.method === "exec.approval.resolve" ? { hold: true } : undefined);
  const answer = c.approve("lost", "deny");
  sockets[0].close();
  await assert.rejects(answer, /unavailable/);
});

test("a new chat from Reach is a webchat session of Reach's own; Reach removes only those", async (t) => {
  // "I couldn't start an OpenClaw chat in Reach": every chat on this Mac
  // belonged to WhatsApp, Discord or a cron job, and none could be written to.
  const { c, calls } = await fixture(t);
  const { key } = await c.create({ title: "Plan the trip" });
  assert.match(key, /^agent:main:reach-[\w-]{8}$/);
  assert.deepEqual(
    calls.filter((x) => ["sessions.reset", "sessions.patch"].includes(x.method)).map((x) => [x.method, x.params]),
    [
      ["sessions.reset", { key, reason: "new" }],
      ["sessions.patch", { key, label: "Plan the trip" }],
    ],
  );
  await assert.rejects(c.remove(rows[0].key), (e) => e.status === 403);
  assert.equal(calls.some((x) => x.method === "sessions.delete"), false);
  await c.remove(key);
  assert.deepEqual(calls.at(-1).params, { key, deleteTranscript: true });
});

test("a Gateway that can't add a moved chat's history says so up front; one that can but doesn't list it is asked", async (t) => {
  // OpenClaw 2026.3.13 handles chat.inject but leaves it out of hello's list
  // (verified in its code and on this Mac): "Continue in OpenClaw" was offered
  // nowhere. Asked once with nothing to add, it answers "invalid params".
  const unlisted = await fixture(t);
  unlisted.handle((req) =>
    req.method === "connect"
      ? { payload: { features: { methods: ["sessions.list", "sessions.reset", "chat.send"] } } }
      : req.method === "chat.inject"
        ? { error: { message: "invalid chat.inject params: must have required property 'sessionKey'" } }
        : undefined,
  );
  await unlisted.c.overview();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(unlisted.c.canMove(), true);
  // The question added nothing: no session named, nothing said.
  assert.deepEqual(unlisted.calls.filter((c) => c.method === "chat.inject").map((c) => c.params), [{}]);
  // A Gateway without it at all: said up front, not after confirming.
  const without = await fixture(t);
  without.handle((req) =>
    req.method === "connect"
      ? { payload: { features: { methods: ["sessions.list", "sessions.reset", "chat.send"] } } }
      : req.method === "chat.inject"
        ? { error: { message: "unknown method: chat.inject" } }
        : undefined,
  );
  await without.c.overview();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(without.c.canMove(), false);
  const listed = await fixture(t);
  listed.handle((req) => (req.method === "connect" ? { payload: { features: { methods: ["sessions.list", "chat.inject"] } } } : undefined));
  await listed.c.overview();
  assert.equal(listed.c.canMove(), true);
});

// "Make everything evented" (2026-10-06): notifications looked every 5 s, and
// that look also opened OpenClaw's connection again after a drop. Now they
// look when told: OpenClaw says when approvals come or go, and opens a
// dropped connection again by itself while anyone listens.
test("approvals coming, going or expiring are told at once; a dropped Gateway connection is opened again", async (t) => {
  const { c, sockets } = await fixture(t, { redialMs: 20 });
  let told = 0;
  c.onApprovalsChange(() => told++);
  await c.overview();
  const prompt = { id: "a1", request: { command: "npm test", sessionKey: rows[0].key }, expiresAtMs: Date.now() + 60000 };
  sockets[0].event("exec.approval.requested", prompt);
  assert.equal(told, 1);
  sockets[0].event("exec.approval.resolved", { id: "a1" });
  assert.equal(told, 2);
  // One that runs out with nothing said: told when it does.
  sockets[0].event("exec.approval.requested", { ...prompt, id: "a2", expiresAtMs: Date.now() + 100 });
  assert.equal(told, 3);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(told, 4);
  // The Gateway goes away and comes back: connected again without asking.
  sockets[0].event("exec.approval.requested", { ...prompt, id: "a3" });
  sockets[0].close();
  assert.equal(told, 6, "its approvals are gone with it");
  for (const end = Date.now() + 2000; sockets.length < 2 && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
  assert.equal(sockets.length, 2);
  // Closed by Reach: not opened again.
  c.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sockets.length, 2);
});

// "Make everything evented" (2026-10-06): the phone's OpenClaw page asked for
// the list every 5 s and an open chat every 1.8 s (200 messages from the
// Gateway each time). Now it waits for the Mac to say something changed.
test("a phone waiting on OpenClaw hears of a run starting, not each word; a chat's wait hears each word", async (t) => {
  const { c, sockets } = await fixture(t, { coalesceMs: 10 });
  const { version } = await c.overview();
  const ws = sockets[0];
  const listWait = c.changes({ after: version, ms: 2000 });
  ws.event("chat", { sessionKey: rows[0].key, runId: "r1", state: "delta", message: { content: "Hel" } });
  assert.notEqual((await listWait).version, version, "a run started");
  const chat = await c.history(rows[0].key);
  const { version: listed } = await c.overview();
  const quiet = c.changes({ after: listed, ms: 200 });
  const chatWait = c.changes({ key: rows[0].key, after: chat.version, ms: 2000 });
  ws.event("chat", { sessionKey: rows[0].key, runId: "r1", state: "delta", message: { content: "Hello" } });
  assert.notEqual((await chatWait).version, chat.version, "the chat's wait hears the words");
  assert.equal((await quiet).version, listed, "the list's wait doesn't");
  // An approval: the list's wait hears it at once.
  const approvalWait = c.changes({ after: listed, ms: 2000 });
  ws.event("exec.approval.requested", { id: "a1", request: { command: "npm test", sessionKey: rows[0].key }, expiresAtMs: Date.now() + 60000 });
  assert.notEqual((await approvalWait).version, listed);
  // Closing Reach lets every wait go.
  const last = c.changes({ after: (await c.overview()).version, ms: 60000 });
  c.close();
  assert.ok(await last);
});

test("while a reply streams in, the open chat is read from what OpenClaw last gave, not asked again", async (t) => {
  const { c, sockets, calls } = await fixture(t, { coalesceMs: 10 });
  await c.overview();
  const ws = sockets[0];
  const asked = () => calls.filter((r) => r.method === "chat.history").length;
  ws.event("chat", { sessionKey: rows[0].key, runId: "r2", state: "delta", message: { content: "Wor" } });
  await c.history(rows[0].key);
  ws.event("chat", { sessionKey: rows[0].key, runId: "r2", state: "delta", message: { content: "Working" } });
  const streaming = await c.history(rows[0].key);
  assert.equal(asked(), 1, "the Gateway asked once");
  assert.equal(streaming.streaming, "Working");
  // The turn ends: its messages are read again.
  ws.event("chat", { sessionKey: rows[0].key, runId: "r2", state: "final" });
  await c.history(rows[0].key);
  assert.equal(asked(), 2);
});

test("malformed Gateway envelopes close the adapter without crashing Reach", async t => {
  const { c, sockets } = await fixture(t);
  await c.overview();
  assert.doesNotThrow(() => sockets[0].emit("message", Buffer.from("null")));
  assert.equal(sockets[0].readyState, 3);
});

test("changed session labels cannot become React objects or crash the chat", async t => {
  const { c, handle } = await fixture(t);
  handle(req => req.method === "sessions.list" ? { payload: { sessions: [{ key: "agent:main:test", displayName: {} }] } } : undefined);
  const overview = await c.overview();
  assert.equal(overview.connected, false);
  assert.match(overview.error, /unsupported session list/);
});
