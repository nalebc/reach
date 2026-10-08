import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  createCodexOwner,
  codexOwnerSnapshot,
} from "../server/agent-sessions/codex-owner.mjs";

const id = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const other = "0199aaaa-bbbb-7ccc-8ddd-ffffffffffff";
const nativeItem = {
  type: "agentMessage",
  id: "answer",
  text: "Same answer",
  phase: "final_answer",
  questions: [{ title: "Choose", options: ["One", "Two"] }],
};
const thread = {
  id,
  cwd: "/Users/me/project",
  name: "Shared chat",
  createdAt: 1,
  updatedAt: 2,
  historyMode: "paginated",
  status: { type: "idle" },
};
const frame = (message) => {
  const data = Buffer.from(JSON.stringify(message)),
    header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  return Buffer.concat([header, data]);
};
async function until(check) {
  for (let n = 0; n < 40; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("IPC event did not arrive");
}
function fixture(t, { handleRequest } = {}) {
  const packets = [],
    calls = [];
  const daemon = {
    async rpc(method, params) {
      calls.push([method, params]);
      if (method === "thread/read") return { thread };
      if (method === "thread/turns/list")
        return {
          data: [
            {
              id: "turn-1",
              startedAt: 1,
              completedAt: 2,
              status: "completed",
              items: [
                {
                  type: "userMessage",
                  id: "question",
                  content: [{ type: "text", text: "Build", text_elements: [] }],
                  clientId: "message-1",
                },
                nativeItem,
              ],
            },
          ],
          nextCursor: null,
        };
      if (method === "thread/queue/list")
        return {
          data: [
            {
              id: "q1",
              clientUserMessageId: "m1",
              input: [
                { type: "text", text: "Next", text_elements: [] },
                { type: "localImage", path: "/tmp/a.png" },
              ],
            },
          ],
        };
    },
  };
  let ws;
  const actions = [];
  const owner = createCodexOwner({
    daemon,
    enabled: true,
    gapMs: 1,
    checkEndpoint: async () => {},
    handleRequest: async (...args) => {
      actions.push(args);
      if (handleRequest) return handleRequest(...args);
      return { result: { turn: { id: "next-turn" } } };
    },
    connect() {
      ws = new EventEmitter();
      ws.writable = true;
      ws.destroy = () => {
        ws.writable = false;
        ws.emit("close");
      };
      ws.write = (bytes) => {
        const m = JSON.parse(bytes.subarray(4));
        packets.push(m);
        if (m.method === "initialize")
          queueMicrotask(() =>
            ws.emit(
              "data",
              frame({
                type: "response",
                method: "initialize",
                resultType: "success",
                result: { clientId: "reach-owner" },
              }),
            ),
          );
      };
      queueMicrotask(() => ws.emit("connect"));
      return ws;
    },
  });
  t.after(() => owner.close());
  const send = (m) => {
    const f = frame(m);
    ws.emit("data", f.subarray(0, 2));
    ws.emit("data", f.subarray(2));
  };
  return { owner, daemon, packets, calls, actions, send, disconnect: () => ws.destroy(),
    closing: (property) => { ws[property] = property === "writable" ? false : true; } };
}

test("Reach announces only its actual native writers and compatible local requests", async (t) => {
  const f = fixture(t);
  await f.owner.claim(id, { model: "gpt-6-sol" });
  for (const [requestId, threadId, version, hostId] of [
    ["own", id, 1, "local"],
    ["other", other, 1, "local"],
    ["old-version", id, 0, "local"],
    ["remote", id, 1, "remote"],
  ]) {
    f.send({
      type: "client-discovery-request",
      requestId,
      request: {
        method: "thread-owner-discovery",
        version,
        params: { conversationId: threadId, hostId },
      },
    });
  }
  await until(
    () =>
      f.packets.filter((m) => m.type === "client-discovery-response").length ===
      4,
  );
  assert.deepEqual(
    f.packets
      .filter((m) => m.type === "client-discovery-response")
      .map((m) => [m.requestId, m.response.canHandle]),
    [
      ["own", true],
      ["other", false],
      ["old-version", false],
      ["remote", false],
    ],
  );
  f.owner.forget(id);
  f.send({
    type: "client-discovery-request",
    requestId: "released",
    request: {
      method: "thread-owner-discovery",
      version: 1,
      params: { conversationId: id },
    },
  });
  assert.equal(f.packets.at(-1).response.canHandle, false);
});

test("Codex follows the same task, with native history, attachments, and queue ids", async (t) => {
  const f = fixture(t);
  await f.owner.claim(id, {
    model: "gpt-6-sol",
    approvalPolicy: "never",
    approvalsReviewer: "auto_review",
  });
  f.send({
    type: "broadcast",
    method: "thread-stream-following-changed",
    sourceClientId: "codex-window",
    params: { conversationId: id, hostId: "local", following: true },
  });
  await until(() =>
    f.packets.some((m) => m.method === "thread-queued-followups-changed"),
  );
  assert.equal(f.owner.hasFollowers(id), true);
  const snapshot = f.packets.find(
    (m) => m.method === "thread-stream-state-changed",
  );
  assert.equal(snapshot.version, 11);
  assert.deepEqual(snapshot.targetClientIds, ["codex-window"]);
  const state = snapshot.params.change.conversationState;
  assert.equal(state.id, id);
  assert.equal(state.resumeState, "resumed");
  assert.equal(state.turns[0].turnId, "turn-1");
  assert.deepEqual(state.turns[0].items[1], nativeItem);
  assert.equal(state.currentPermissions.approvalPolicy, "never");
  const queue = f.packets.find(
    (m) => m.method === "thread-queued-followups-changed",
  ).params.messages;
  assert.equal(queue[0].id, "q1");
  assert.equal(queue[0].context.imageAttachments[0].localPath, "/tmp/a.png");
  assert.equal(
    f.calls.some(([m]) =>
      ["thread/start", "thread/fork", "thread/resume"].includes(m),
    ),
    false,
  );
});

test("desktop composer actions reach the existing writer once and carry the last advertised queue", async (t) => {
  const f = fixture(t);
  await f.owner.claim(id);
  f.send({
    type: "broadcast",
    method: "thread-stream-following-changed",
    sourceClientId: "codex-window",
    params: { conversationId: id, hostId: "local", following: true },
  });
  await until(() =>
    f.packets.some((m) => m.method === "thread-queued-followups-changed"),
  );
  const params = {
    conversationId: id,
    turnStart: {
      request: {
        threadId: id,
        input: [{ type: "text", text: "Continue", text_elements: [] }],
      },
    },
  };
  f.send({
    type: "request",
    requestId: "send-1",
    sourceClientId: "codex-window",
    method: "thread-follower-start-turn",
    version: 2,
    params,
  });
  await until(() => f.packets.some((m) => m.requestId === "send-1"));
  const reply = f.packets.find((m) => m.requestId === "send-1");
  assert.equal(reply.handledByClientId, "reach-owner");
  assert.equal(reply.result.result.turn.id, "next-turn");
  assert.equal(f.actions.length, 1);
  assert.deepEqual(f.actions[0][1], params);
  assert.deepEqual(f.actions[0][2].queueIds, ["q1"]);
  f.send({
    type: "request",
    requestId: "wrong-task",
    sourceClientId: "codex-window",
    method: "thread-follower-start-turn",
    version: 2,
    params: { ...params, conversationId: other },
  });
  await until(() => f.packets.some((m) => m.requestId === "wrong-task"));
  assert.equal(
    f.packets.find((m) => m.requestId === "wrong-task").resultType,
    "error",
  );
  assert.equal(f.actions.length, 1);
});

test("complete native history drains all pages, while initial snapshots stay bounded", async () => {
  const cursors = [];
  const daemon = {
    async rpc(method, params) {
      if (method === "thread/read") return { thread };
      cursors.push(params.cursor || null);
      return params.cursor
        ? {
            data: [{ id: "old", status: "completed", items: [] }],
            nextCursor: null,
          }
        : {
            data: [{ id: "new", status: "completed", items: [] }],
            nextCursor: "older",
          };
    },
  };
  const initial = await codexOwnerSnapshot(daemon, id);
  assert.equal(initial.turnsPagination.hasLoadedOldest, false);
  const complete = await codexOwnerSnapshot(daemon, id, {}, [], true);
  assert.deepEqual(
    complete.turns.map((t) => t.turnId),
    ["old", "new"],
  );
  assert.deepEqual(cursors, [null, null, "older"]);
});

test("closing while the endpoint check waits never connects afterward", async () => {
  let finishCheck, connects = 0;
  const owner = createCodexOwner({
    daemon: {}, enabled: true,
    checkEndpoint: () => new Promise(resolve => { finishCheck = resolve; }),
    connect: () => { connects++; throw Error("inert connect must not run after close"); },
  });
  const claim = owner.claim(id);
  owner.close();
  finishCheck();
  await claim;
  assert.equal(connects, 0);
  await owner.claim(other);
  assert.equal(owner.has(other), false, "a closed owner never advertises a new claim");
});


test("known queue IDs survive an empty refresh and unreadable queues never publish cancellation", async (t) => {
  const f = fixture(t);
  const original = f.daemon.rpc;
  let queueResponse;
  f.daemon.rpc = (method, params) => method === "thread/queue/list" && queueResponse !== undefined
    ? Promise.resolve(queueResponse) : original(method, params);
  await f.owner.claim(id);
  f.send({ type: "broadcast", method: "thread-stream-following-changed", sourceClientId: "codex-window",
    params: { conversationId: id, hostId: "local", following: true } });
  const queues = () => f.packets.filter(m => m.method === "thread-queued-followups-changed");
  await until(() => queues().length === 1);
  queueResponse = {};
  f.owner.update(id);
  await until(() => f.packets.filter(m => m.method === "thread-stream-state-changed").length === 2);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(queues().length, 1, "an unknown queue is not an empty queue");
  queueResponse = { data: [] };
  f.owner.update(id);
  await until(() => queues().length === 2);
  f.send({ type: "request", requestId: "stale-queue", sourceClientId: "codex-window",
    method: "thread-follower-set-queued-follow-ups-state", version: 1,
    params: { conversationId: id, state: { [id]: [{ id: "q1", text: "Old" }] } } });
  await until(() => f.actions.length === 1);
  assert.deepEqual(f.actions[0][2].queueIds, []);
  assert.deepEqual(f.actions[0][2].knownQueueIds, ["q1", "m1"]);
});

test("requests queued behind an in-flight action never dispatch after IPC disconnect", async (t) => {
  let finish;
  const f = fixture(t, { handleRequest: () => new Promise(resolve => { finish = resolve; }) });
  await f.owner.claim(id);
  const request = requestId => ({ type: "request", requestId, sourceClientId: "codex-window",
    method: "thread-follower-start-turn", version: 2, params: { conversationId: id } });
  f.send(request("first"));
  await until(() => f.actions.length === 1);
  f.send(request("second"));
  f.disconnect();
  finish({ result: { turn: { id: "already-dispatched" } } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.actions.length, 1);
  assert.equal(f.packets.some(p => p.requestId === "first" || p.requestId === "second"), false,
    "never acknowledge an old connection's requests on a replacement connection");
});

for (const loss of ["close", "disconnect", "replace", "nonwritable", "destroyed"])
  test(`the original owner authorization expires across ${loss} during a request read`, async (t) => {
    let finish, mutated = false;
    const f = fixture(t, { handleRequest: async (_method, _params, context) => {
      await new Promise(resolve => { finish = resolve; });
      context.authorize();
      mutated = true;
      return { ok: true };
    } });
    await f.owner.claim(id);
    f.send({ type: "request", requestId: "read-then-write", sourceClientId: "codex-window",
      method: "thread-follower-steer-turn", version: 1, params: { conversationId: id } });
    await until(() => typeof finish === "function");
    if (loss === "close") f.owner.close();
    else if (loss === "disconnect") f.disconnect();
    else if (loss === "nonwritable" || loss === "destroyed") f.closing(loss === "nonwritable" ? "writable" : "destroyed");
    else { f.owner.forget(id); await f.owner.claim(id); }
    finish();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(mutated, false, "a read from the retired ownership must never authorize a write");
    assert.equal(f.packets.some(p => p.requestId === "read-then-write" && p.resultType === "success"), false);
  });
