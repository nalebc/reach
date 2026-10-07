import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCodexDesktop } from "../server/agent-sessions/codex-desktop.mjs";

const thread = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const frame = (value) => {
  const body = Buffer.from(JSON.stringify(value)),
    header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};
function fixture(handler = () => false, options = {}) {
  const messages = [];
  let connections = 0,
    socket;
  const desktop = createCodexDesktop({
    checkEndpoint: async () => {},
    timeoutMs: 80,
    connect() {
      connections++;
      socket = new EventEmitter();
      socket.writable = true;
      socket.destroy = () => {
        socket.writable = false;
      };
      const reply = (request, patch = {}) => {
        const result =
          request.method === "initialize"
            ? { clientId: "reach-client" }
            : request.method === "thread-owner-discovery"
              ? { supportsUntrustedAppInput: true }
              : { applied: true };
        const packet = frame({
          type: "response",
          requestId: request.requestId,
          method: request.method,
          handledByClientId: "desktop-owner",
          resultType: "success",
          result,
          ...patch,
        });
        // Real sockets may split both the length header and body.
        for (const chunk of [
          packet.subarray(0, 2),
          packet.subarray(2, 11),
          packet.subarray(11),
        ])
          socket.emit("data", chunk);
      };
      socket.write = (bytes) => {
        assert.equal(bytes.readUInt32LE(), bytes.length - 4);
        const message = JSON.parse(bytes.subarray(4));
        messages.push(message);
        queueMicrotask(() => {
          if (
            !handler(message, { reply, socket }) &&
            message.type === "request"
          )
            reply(message);
        });
      };
      queueMicrotask(() => socket.emit("connect"));
      return socket;
    },
    ...options,
  });
  return {
    desktop,
    messages,
    get connections() {
      return connections;
    },
    get socket() {
      return socket;
    },
  };
}

test("desktop model changes use the discovered owner and confirm its exact response", async () => {
  const f = fixture();
  assert.deepEqual(
    await f.desktop.model(thread, {
      model: "gpt-6-luna",
      effort: "high",
      approvalPolicy: "never",
    }),
    { model: "gpt-6-luna", effort: "high", applied: true },
  );
  assert.deepEqual(
    f.messages.map((m) => [m.method, m.version]),
    [
      ["initialize", 0],
      ["thread-owner-discovery", 1],
      ["thread-follower-update-thread-settings", 2],
    ],
  );
  assert.deepEqual(f.messages[0].params, { clientType: "reach" });
  assert.deepEqual(f.messages[1].params, {
    hostId: "local",
    conversationId: thread,
  });
  assert.equal(f.messages[2].targetClientId, "desktop-owner");
  assert.equal(f.messages[2].sourceClientId, "reach-client");
  assert.deepEqual(f.messages[2].params, {
    conversationId: thread,
    threadSettings: { model: "gpt-6-luna", effort: "high" },
  });
  assert.equal(f.socket.writable, false);
});

test("Reach never offers to own or answer native client requests", async () => {
  const f = fixture((m, { socket }) => {
    if (m.method === "initialize")
      socket.emit(
        "data",
        frame({
          type: "client-discovery-request",
          requestId: "discovery",
          method: "thread-follower-respond-to-server-request",
        }),
      );
  });
  await f.desktop.model(thread, { model: "gpt-6-luna" });
  assert.deepEqual(
    f.messages.find((m) => m.type === "client-discovery-response"),
    {
      type: "client-discovery-response",
      requestId: "discovery",
      response: { canHandle: false },
    },
  );
});

test("missing desktop owner never sends settings", async () => {
  const f = fixture((m, { reply }) => {
    if (m.method !== "thread-owner-discovery") return false;
    reply(m, { resultType: "error" });
    return true;
  });
  await assert.rejects(f.desktop.model(thread, { model: "gpt-6-luna" }), {
    status: 409,
  });
  assert.equal(f.messages.length, 2);
});

for (const [label, patch] of [
  ["another owner's response", { handledByClientId: "wrong-owner" }],
  ["a mismatched method", { method: "another-method" }],
  ["an unapplied result", { result: { applied: false } }],
  ["a native failure", { resultType: "error" }],
])
  test(`model changes reject ${label}`, async () => {
    const f = fixture((m, { reply }) => {
      if (m.method !== "thread-follower-update-thread-settings") return false;
      reply(m, patch);
      return true;
    });
    await assert.rejects(
      f.desktop.model(thread, { model: "gpt-6-luna" }),
      /didn't confirm/,
    );
    assert.equal(f.connections, 1);
    assert.equal(
      f.messages.filter(
        (m) => m.method === "thread-follower-update-thread-settings",
      ).length,
      1,
    );
  });

for (const event of ["close", "error", "timeout", "malformed"])
  test(`no replay after ${event} during settings delivery`, async () => {
    const f = fixture((m, { socket }) => {
      if (m.method !== "thread-follower-update-thread-settings") return false;
      if (event === "malformed") {
        const header = Buffer.alloc(4);
        header.writeUInt32LE(0xffffffff);
        socket.emit("data", header);
      } else if (event !== "timeout") socket.emit(event);
      return true;
    });
    await assert.rejects(
      f.desktop.model(thread, { model: "gpt-6-luna" }),
      /didn't confirm/,
    );
    assert.equal(f.connections, 1);
    assert.equal(
      f.messages.filter(
        (m) => m.method === "thread-follower-update-thread-settings",
      ).length,
      1,
    );
    assert.equal(f.socket.writable, false);
  });

test("untrusted endpoint or invalid thread never opens a connection", async () => {
  const f = fixture(() => false, {
    checkEndpoint: async () => {
      throw Error("wrong owner");
    },
  });
  await assert.rejects(f.desktop.model(thread, { model: "gpt-6-luna" }), {
    status: 409,
  });
  await assert.rejects(
    f.desktop.model("not-a-thread", { model: "gpt-6-luna" }),
    { status: 409 },
  );
  assert.equal(f.connections, 0);
});

test("desktop permission selection changes only the explicit next-turn policy", async () => {
  const f = fixture();
  const settings = { approvalPolicy: "on-request", approvalsReviewer: "user", permissions: ":workspace" };
  await f.desktop.permissions(thread, { ...settings, model: "ignored", activeTurnId: "ignored" });
  assert.deepEqual(f.messages.at(-1).params, { conversationId: thread, threadSettings: settings });
  assert.equal(f.messages.at(-1).targetClientId, "desktop-owner");
});
