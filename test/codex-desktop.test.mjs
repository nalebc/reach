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
      socket.write = (bytes, written) => {
        assert.equal(bytes.readUInt32LE(), bytes.length - 4);
        const message = JSON.parse(bytes.subarray(4));
        messages.push(message);
        if (written) queueMicrotask(written);
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

// Archived by Reach through the shared daemon: every Codex window is told,
// as they tell each other, whether or not one holds the chat.
test("an archive is broadcast to the Codex app, with no owner to find", async () => {
  const f = fixture();
  await f.desktop.archived(thread);
  await f.desktop.archived(thread, false);
  assert.deepEqual(
    f.messages.map((m) => [m.type, m.method, m.version]),
    [
      ["request", "initialize", 0],
      ["broadcast", "thread-archived", 2],
      ["request", "initialize", 0],
      ["broadcast", "thread-unarchived", 1],
    ],
  );
  assert.deepEqual(f.messages[1].params, { hostId: "local", conversationId: thread });
  assert.equal(f.messages[1].sourceClientId, "reach-client");
  assert.equal(f.socket.writable, false);
  await assert.rejects(() => f.desktop.archived("nope"));
});

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

test("Send now and answers steer through the app that owns the chat, as its own Steer", async () => {
  const { desktop, messages } = fixture();
  const input = [{ type: "text", text: "do it", text_elements: [] }];
  const r = await desktop.steer(thread, { input, text: "do it", cwd: "/Users/me/reach", queued: "q1", clientUserMessageId: "m-1" });
  assert.deepEqual(r, { steered: true, clientUserMessageId: "m-1" });
  const steer = messages.find((m) => m.method === "thread-follower-steer-turn");
  assert.equal(steer.version, 1);
  assert.equal(steer.targetClientId, "desktop-owner");
  assert.deepEqual(steer.params, {
    conversationId: thread,
    clientUserMessageId: "m-1",
    input,
    attachments: [],
    restoreMessage: {
      id: "m-1",
      text: "do it",
      cwd: "/Users/me/reach",
      context: { workspaceRoots: ["/Users/me/reach"], collaborationMode: null },
      serverQueuedMessageId: "q1",
    },
  });
  await assert.rejects(desktop.steer(thread, { input: [] }), /stays queued/);
});

test("a steer with no answer after it's written is uncertain, never retried", async () => {
  const { desktop, messages } = fixture((message) => message.method === "thread-follower-steer-turn");
  await assert.rejects(desktop.steer(thread, { input: [{ type: "text", text: "x", text_elements: [] }] }), (e) => e.uncertain === true);
  assert.equal(messages.filter((m) => m.method === "thread-follower-steer-turn").length, 1);
});

test("messages start through the native owner with one task id and no writer takeover", async () => {
  const f = fixture((m, { reply }) => {
    if (m.method !== "thread-follower-start-turn") return false;
    reply(m, { result: { result: { turn: { id: "native-turn" } } } }); return true;
  });
  const request = { input: [{ type: "text", text: "Continue", text_elements: [] }], clientUserMessageId: "msg" };
  assert.deepEqual(await f.desktop.startTurn(thread, request), { turnId: "native-turn" });
  const sent = f.messages.find(m => m.method === "thread-follower-start-turn");
  assert.equal(sent.targetClientId, "desktop-owner"); assert.equal(sent.version, 2);
  assert.deepEqual(sent.params.turnStart.request, { ...request, threadId: thread });
});

test("an unconfirmed native send is uncertain and never replayed", async () => {
  const f = fixture(m => m.method === "thread-follower-start-turn");
  await assert.rejects(f.desktop.startTurn(thread, { input: [{ type: "text", text: "Continue", text_elements: [] }] }), error => error.uncertain === true);
  assert.equal(f.messages.filter(m => m.method === "thread-follower-start-turn").length, 1);
});

test("editing your last message asks the app that owns the chat, as its own Edit", async () => {
  const { desktop, messages } = fixture();
  assert.deepEqual(await desktop.editLast(thread, { turnId: "turn-2", message: "again" }), { edited: true });
  const edit = messages.find((m) => m.method === "thread-follower-edit-last-user-turn");
  assert.equal(edit.version, 2);
  assert.equal(edit.targetClientId, "desktop-owner");
  assert.deepEqual(edit.params, { conversationId: thread, turnId: "turn-2", message: "again" });
});

// The Codex app's approvals: read from the chat's state (its owner sends it
// to a follower), answered by the request's own id, and taken as answered
// only once the request has left the state. The owner says "ok" even for an
// id it no longer has, so that alone never counts.
const approval = { id: 12, method: "item/commandExecution/requestApproval", params: { itemId: "c7", command: "npm test" } };
function owner(states) {
  return (message, { socket }) => {
    if (message.type === "broadcast" && message.method === "thread-stream-following-changed" && message.params.following) {
      const state = states.length > 1 ? states.shift() : states[0];
      const packet = frame({
        type: "broadcast",
        method: "thread-stream-state-changed",
        sourceClientId: "desktop-owner",
        params: { conversationId: thread, hostId: "local", change: { type: "snapshot", revision: 1, conversationState: state } },
      });
      // A large state arrives in many pieces.
      for (let at = 0; at < packet.length; at += 7) socket.emit("data", packet.subarray(at, at + 7));
      return true;
    }
    if (message.type === "request" && message.method.startsWith("thread-follower-")) {
      queueMicrotask(() =>
        socket.emit("data", frame({ type: "response", requestId: message.requestId, method: message.method, handledByClientId: "desktop-owner", resultType: "success", result: { ok: true } })),
      );
      return true;
    }
    return message.type !== "request";
  };
}

test("Codex app approvals are read from the chat's state and answered by the request's own id", async () => {
  const pending = { requests: [approval, { id: "q1", method: "item/tool/requestUserInput", params: {} }], padding: "x".repeat(5000) };
  const { desktop, messages } = fixture(owner([pending, pending, { requests: [] }]));
  assert.deepEqual((await desktop.requests(thread)).map((r) => r.id), [12, "q1"]);
  assert.deepEqual(await desktop.answer(thread, { id: 12, method: approval.method, response: { decision: "accept" } }), { answered: true });
  const sent = messages.find((m) => m.method === "thread-follower-command-approval-decision");
  assert.deepEqual(sent.params, { conversationId: thread, requestId: 12, decision: "accept" });
  assert.equal(sent.targetClientId, "desktop-owner");
  // Following ends once done.
  assert.ok(messages.some((m) => m.method === "thread-stream-following-changed" && m.params.following === false));
});

test("a Codex app approval still in the chat after its answer is uncertain, and one already gone isn't answered", async () => {
  const { desktop } = fixture(owner([{ requests: [approval] }]), { timeoutMs: 5000 });
  await assert.rejects(
    desktop.answer(thread, { id: 12, method: approval.method, response: { decision: "accept" } }),
    (e) => e.uncertain === true,
  );
  const gone = fixture(owner([{ requests: [] }]));
  await assert.rejects(gone.desktop.answer(thread, { id: 12, method: approval.method, response: { decision: "accept" } }), /already answered/);
  assert.equal(gone.messages.some((m) => m.method === "thread-follower-command-approval-decision"), false);
});
