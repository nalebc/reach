import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { EventEmitter } from "node:events";
import { createAgentAsks } from "../server/agent-sessions/agent-asks.mjs";

const SESSION = "34ab778a-0bc2-4a3d-a86b-887f8209431d";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await delay(5);
  return check();
};
// Exercise the broker's real connection handler without opening a socket.
// agent-asks.test.mjs separately covers the child hook and Unix permissions.
function setup(t, options = {}) {
  let server;
  const create = net.createServer;
  net.createServer = (...args) => (server = create(...args));
  let asks;
  try {
    asks = createAgentAsks({ socketPath: "/unused-test.sock", idle: async () => 600, everyMs: 5, watchGraceMs: 30, ...options });
  } finally { net.createServer = create; }
  t.after(() => asks.close());
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.end = (data) => { socket.result = JSON.parse(data); socket.emit("close"); };
  socket.destroy = () => socket.emit("close");
  server.emit("connection", socket);
  const send = (questions) => socket.emit("data", JSON.stringify({
    agent: "claude", session_id: SESSION, tool_name: "AskUserQuestion", tool_input: { questions },
  }) + "\n");
  return { asks, socket, send };
}
const questions = [
  { question: "Choose one", options: [{ label: "A" }, { label: "B" }] },
  { question: "Choose several", multiSelect: true, options: [{ label: "C" }, { label: "D" }] },
];

test("remote input and poll gaps cannot remove a question being answered on the phone", async (t) => {
  let watching = true;
  // The Mac is in use the whole time (idle 0 s). A grace far longer than the
  // phone's gap keeps the outcome the same on coarse or starved timers.
  const { asks, socket, send } = setup(t, { idle: async () => 0, watching: () => watching, watchGraceMs: 2000 });
  send(questions);
  assert.ok(await until(() => asks.has("claude", SESSION)));
  watching = false;
  await delay(60); // several poll rounds (everyMs 5) with the phone away
  assert.equal(asks.has("claude", SESSION), true);
  watching = true;
  await delay(20);
  const [prompt] = asks.prompts("claude", SESSION);
  assert.equal(prompt.questions.length, 2);
  asks.answer("claude", SESSION, prompt.id, { answers: { "Choose one": ["B"], "Choose several": ["C", "D"] } });
  assert.deepEqual(socket.result.decision.updatedInput.answers, { "Choose one": "B", "Choose several": "C, D" });
  assert.equal(asks.has("claude", SESSION), false);
});

test("an explicit local handoff is scoped to the session and grants no approval", async (t) => {
  const { asks, socket, send } = setup(t, { watching: () => true });
  send(questions);
  await delay(0);
  const [prompt] = asks.prompts("claude", SESSION);
  assert.equal(prompt.canAnswerOnMac, true);
  assert.throws(() => asks.answer("codex", SESSION, prompt.id, { decision: "answerOnMac" }), { status: 409 });
  assert.throws(() => asks.answer("claude", SESSION, prompt.id, { answers: {} }), { status: 400 });
  assert.equal(asks.has("claude", SESSION), true);
  assert.deepEqual(asks.answer("claude", SESSION, prompt.id, { decision: "answerOnMac" }), { handedOff: true });
  assert.deepEqual(socket.result, {});
  assert.throws(() => asks.answer("claude", SESSION, prompt.id, { decision: "allow" }), { status: 409 });
});

test("leaving the phone still hands the request back when the Mac is in use", async (t) => {
  let watching = true;
  const { asks, socket, send } = setup(t, { idle: async () => 0, watching: () => watching });
  send(questions);
  watching = false;
  assert.ok(await until(() => !asks.has("claude", SESSION)));
  assert.deepEqual(socket.result, {});
});
