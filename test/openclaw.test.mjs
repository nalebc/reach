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
];
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
  assert.equal(r.sessions.length, 3);
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
  assert.equal(
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

test("reply routing is explicit and retry uses caller idempotency key", async (t) => {
  const { c, calls, sockets } = await fixture(t);
  const message = {
    key: rows[0].key,
    text: "Draft",
    requestId: "retry-same-id",
  };
  await c.send(message);
  await c.send(message);
  sockets[0].event("chat", {
    sessionKey: rows[0].key,
    runId: message.requestId,
    state: "final",
  });
  await c.send({ ...message, deliver: true, requestId: "external-reply" });
  const sends = calls
    .filter((c) => c.method === "chat.send")
    .map((c) => c.params);
  assert.deepEqual(sends[0], {
    sessionKey: rows[0].key,
    message: "Draft",
    deliver: false,
    idempotencyKey: message.requestId,
  });
  assert.equal(sends.length, 1);
  assert.deepEqual(calls.find((c) => c.method === "agent").params, {
    sessionKey: rows[0].key,
    message: "Draft",
    deliver: true,
    idempotencyKey: "external-reply",
    replyChannel: "whatsapp",
    replyTo: "123",
    bestEffortDeliver: false,
  });
  await assert.rejects(
    c.send({
      ...message,
      key: rows[2].key,
      deliver: true,
      requestId: "no-destination",
    }),
    /no external reply/,
  );
  await assert.rejects(c.send({ ...message, text: "" }), /Enter a message/);
  await c.stop(rows[0].key);
  assert.deepEqual(calls.at(-1).params, { sessionKey: rows[0].key });
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
        sessionKey: rows[0].key,
        runId: req.params.idempotencyKey,
        state: "final",
      });
  });
  await c.send({ key: rows[0].key, text: "Hi", requestId: "message-id" });
  assert.equal((await c.history(rows[0].key)).session.status, "idle");
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
  await c.send({ key: rows[0].key, text: "Hello", requestId: "recover-run" });
  sockets[0].event("chat", {
    sessionKey: rows[0].key,
    runId: "recover-run",
    state: "delta",
    message: { content: "Hi" },
  });
  assert.equal((await c.history(rows[0].key)).streaming, "");
  handle((req) =>
    req.method === "agent.wait"
      ? { payload: { runId: req.params.runId, status: "ok" } }
      : null,
  );
  const h = await c.history(rows[0].key);
  assert.equal(h.session.status, "idle");
  assert.equal(h.items.filter((m) => m.text === "Hi").length, 1);
});

test("agent lifecycle completion works without a chat final; stale foreign events cannot reopen or finish a run", async (t) => {
  const { c, sockets } = await fixture(t);
  await c.send({ key: rows[0].key, text: "Hello", requestId: "lifecycle-run" });
  const ws = sockets[0];
  ws.event("agent", {
    sessionKey: rows[0].key,
    runId: "older-run",
    stream: "lifecycle",
    data: { phase: "end" },
  });
  assert.equal((await c.history(rows[0].key)).session.status, "running");
  ws.event("agent", {
    sessionKey: rows[0].key,
    runId: "lifecycle-run",
    stream: "lifecycle",
    data: { phase: "end" },
  });
  ws.event("chat", {
    sessionKey: rows[0].key,
    runId: "lifecycle-run",
    state: "delta",
    message: { content: "late" },
  });
  assert.equal((await c.history(rows[0].key)).session.status, "idle");
});

test("an acknowledged completed replay does not restart the spinner", async (t) => {
  const { c, handle } = await fixture(t);
  handle((req) =>
    req.method === "chat.send"
      ? { payload: { runId: req.params.idempotencyKey, status: "ok" } }
      : null,
  );
  const sent = await c.send({
    key: rows[0].key,
    text: "Hello",
    requestId: "cached-complete",
  });
  assert.equal(sent.status, "idle");
  assert.equal((await c.history(rows[0].key)).session.status, "idle");
});

test("unconfirmed runs become actionable instead of spinning indefinitely; no automatic resend", async (t) => {
  let clock = 1000;
  const { c, calls } = await fixture(t, {
    now: () => clock,
    reconcileMs: 0,
    staleMs: 100,
  });
  await c.send({ key: rows[0].key, text: "Hello", requestId: "stalled-run" });
  clock += 101;
  const h = await c.history(rows[0].key);
  assert.equal(h.session.status, "unknown");
  assert.match(h.error, /not confirmed completion/);
  await assert.rejects(
    c.send({ key: rows[0].key, text: "Again", requestId: "another-run" }),
    /unconfirmed/,
  );
  assert.equal(calls.filter((r) => r.method === "chat.send").length, 1);
});

test("reconnection reconciles the same run, without resending the message", async (t) => {
  const { c, calls, sockets, handle } = await fixture(t, { reconcileMs: 0 });
  await c.send({ key: rows[0].key, text: "Hello", requestId: "reconnect-run" });
  sockets[0].close();
  handle((req) =>
    req.method === "agent.wait"
      ? { payload: { runId: req.params.runId, status: "ok" } }
      : null,
  );
  assert.equal((await c.history(rows[0].key)).session.status, "idle");
  assert.equal(sockets.length, 2);
  assert.equal(calls.filter((r) => r.method === "chat.send").length, 1);
});

test("external routing pins the session channel, account, destination and thread; no client override", async (t) => {
  const { c, calls, handle } = await fixture(t);
  handle((req) =>
    req.method === "sessions.list"
      ? {
          payload: {
            sessions: [
              {
                ...rows[0],
                deliveryContext: {
                  channel: "whatsapp",
                  to: "group-test@g.us",
                  accountId: "work",
                  threadId: 8,
                },
              },
            ],
          },
        }
      : req.method === "channels.status"
        ? {
            payload: {
              channelAccounts: {
                whatsapp: [{ accountId: "work", connected: true }],
              },
            },
          }
        : null,
  );
  await c.send({
    key: rows[0].key,
    text: "Hello",
    deliver: true,
    requestId: "external-route",
    replyTo: "injected",
  });
  const req = calls.find((r) => r.method === "agent");
  assert.deepEqual(req.params, {
    sessionKey: rows[0].key,
    message: "Hello",
    deliver: true,
    idempotencyKey: "external-route",
    replyChannel: "whatsapp",
    replyTo: "group-test@g.us",
    replyAccountId: "work",
    threadId: "8",
    bestEffortDeliver: false,
  });
  assert.equal(
    calls.some((r) => r.method === "chat.send"),
    false,
  );
});

test("a disconnected WhatsApp account fails before generation, and reconnect allows an explicit retry", async (t) => {
  const { c, calls, handle } = await fixture(t);
  handle((req) =>
    req.method === "channels.status"
      ? { payload: { channelAccounts: { whatsapp: [{ connected: false }] } } }
      : null,
  );
  const message = {
    key: rows[0].key,
    text: "Hello",
    deliver: true,
    requestId: "disconnected-channel",
  };
  await assert.rejects(c.send(message), /WhatsApp is not connected/);
  assert.equal(
    calls.some((r) => ["agent", "chat.send"].includes(r.method)),
    false,
  );
  handle(() => null);
  await c.send(message);
  assert.equal(calls.filter((r) => r.method === "agent").length, 1);
});

test("generation completion is not delivery success; the second RPC response reports channel failures", async (t) => {
  const { c, sockets, calls } = await fixture(t);
  await c.send({
    key: rows[0].key,
    text: "Hello",
    deliver: true,
    requestId: "delivery-failure",
  });
  const ws = sockets[0],
    request = calls.find((r) => r.method === "agent");
  ws.event("agent", {
    sessionKey: rows[0].key,
    runId: "delivery-failure",
    stream: "lifecycle",
    data: { phase: "end" },
  });
  let h = await c.history(rows[0].key);
  assert.equal(h.session.status, "running");
  assert.equal(h.phase, "delivery");
  assert.equal(h.delivery.status, "pending");
  assert.equal(h.session.canStop, false);
  ws.response(
    request.id,
    { runId: "delivery-failure", status: "error" },
    { message: "Delivery failed secret-token" },
  );
  h = await c.history(rows[0].key);
  assert.equal(h.session.status, "error");
  assert.equal(h.delivery.status, "failed");
  assert.equal(h.error, "Delivery failed [redacted]");
});

test("delivery receipts are explicit; older gateways without a receipt stay unconfirmed", async (t) => {
  const { c, sockets, calls } = await fixture(t);
  for (const [status, expected] of [
    [undefined, "unconfirmed"],
    ["sent", "sent"],
    ["suppressed", "suppressed"],
    ["partial_failed", "failed"],
  ]) {
    const id = `delivery-${expected}`;
    await c.send({
      key: rows[0].key,
      text: "Hello",
      deliver: true,
      requestId: id,
    });
    const req = calls.filter((r) => r.method === "agent").at(-1);
    sockets[0].response(req.id, {
      runId: id,
      status: "ok",
      result: { deliveryStatus: status },
    });
    const h = await c.history(rows[0].key);
    assert.equal(h.delivery.status, expected);
    assert.notEqual(h.session.status, "running");
  }
});

test("concurrent identical requests send once; reused IDs cannot change message or destination", async (t) => {
  const { c, calls } = await fixture(t);
  const message = { key: rows[0].key, text: "Hello", requestId: "double-tap" };
  const result = await Promise.all([c.send(message), c.send(message)]);
  assert.deepEqual(result[0], result[1]);
  assert.equal(calls.filter((r) => r.method === "chat.send").length, 1);
  await assert.rejects(c.send({ ...message, deliver: true }), /already used/);
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
    key: rows[0].key,
    text: "Hello",
    requestId: "unknown-result",
  };
  await assert.rejects(c.send(message), /unrecognized/);
  await assert.rejects(c.send(message), /unrecognized/);
  assert.equal((await c.history(rows[0].key)).session.status, "unknown");
  assert.equal(calls.filter((r) => r.method === "chat.send").length, 1);
});

test("unsupported history and failed stop acknowledgements do not masquerade as empty/success", async (t) => {
  const { c, handle } = await fixture(t);
  await c.send({ key: rows[0].key, text: "Hello", requestId: "stop-denied" });
  handle((req) =>
    req.method === "chat.abort" ? { payload: { aborted: false } } : null,
  );
  await assert.rejects(c.stop(rows[0].key), /did not confirm stopping/);
  assert.equal((await c.history(rows[0].key)).session.status, "running");
  handle((req) =>
    req.method === "chat.history" ? { payload: { unsupported: true } } : null,
  );
  await assert.rejects(
    c.history(rows[0].key),
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
