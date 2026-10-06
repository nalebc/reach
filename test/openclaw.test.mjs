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
        const payload =
          custom?.payload ??
          {
            connect: { type: "hello-ok", protocol: 3 },
            "sessions.list": { sessions: rows },
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
            "chat.send": { runId: "run-1", status: "started" },
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
  const { c, calls } = await fixture(t);
  const message = {
    key: rows[0].key,
    text: "Draft",
    requestId: "retry-same-id",
  };
  await c.send(message);
  await c.send(message);
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
  assert.deepEqual(sends[0], sends[1]);
  assert.equal(sends[2].deliver, true);
  await assert.rejects(
    c.send({ ...message, key: rows[2].key, deliver: true }),
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
  handle((req, socket) => {
    if (req.method === "chat.send")
      socket.event("chat", {
        sessionKey: rows[0].key,
        runId: "run-1",
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

test('OpenClaw HTTP routes inherit owner-device authentication before reaching the bridge', async (t) => {
  const { createReach } = await import('../server/index.mjs');
  const { ALL_SCOPES } = await import('../server/core.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reach-claw-http-'));
  const calls = [];
  const fake = Object.fromEntries(['overview', 'history', 'send', 'stop', 'approve'].map(method => [method, async (...args) => { calls.push({ method, args }); return { ok: true }; }]));
  const reach = await createReach({ roots: [dir], dataDir: path.join(dir, '.reach'), openClaw: fake, agentSessions: {} });
  t.after(async () => { await reach.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await new Promise(r => reach.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${reach.server.address().port}/api/sessions/openclaw`;
  const owner = reach.auth.issue('owner', ALL_SCOPES);
  const agent = reach.auth.issue('agent', ['terminal', 'files'], 'agent');
  const linked = reach.auth.issue('linked', ALL_SCOPES, 'linked-mac');
  const routes = [ ['overview', 'GET'], ['history?key=agent%3Amain%3Amain', 'GET'], ['send', 'POST'], ['stop', 'POST'], ['approval', 'POST'] ];
  for (const [route, method] of routes) {
    assert.equal((await fetch(`${url}/${route}`, { method })).status, 401);
    for (const credential of [agent, linked]) assert.equal((await fetch(`${url}/${route}`, { method, headers: { Authorization: `Bearer ${credential.token}` } })).status, 403);
  }
  assert.equal(calls.length, 0);
  for (const [route, method] of routes) assert.equal((await fetch(`${url}/${route}`, { method, headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify({ key: rows[0].key, text: 'test', requestId: 'test-request', id: 'approval', decision: 'deny' }) } : {}) })).status, 200);
  assert.deepEqual(calls.map(c => c.method), ['overview', 'history', 'send', 'stop', 'approve']);
});
