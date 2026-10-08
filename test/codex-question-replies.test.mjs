import test from "node:test";
import assert from "node:assert/strict";
import { createCodexLive } from "../server/agent-sessions/codex-live.mjs";
import { codexItem, questionKey, questionReply, readQuestionReply, withQuestionReplies } from "../server/agent-sessions/codex.mjs";
import { chatMarkdown } from "../server/agent-sessions/export.mjs";

const threadId = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const asked = { turnId: "turn-1", item: { type: "agentMessage", id: "q1", text: "", questions: [
  { title: "Which target?", options: ["Mac", "Phone"] }, { title: "Anything else?", options: null },
] } };
const body = { itemId: "q1", turnId: "turn-1", answers: [{ index: 0, answer: "Phone" }, { index: 1, answer: " Offline mode " }] };
const nativeReplies = [
  { questionItemId: '["request_user_input_async","q1",0]', question: "Which target?", answer: "Phone" },
  { questionItemId: '["request_user_input_async","q1",1]', question: "Anything else?", answer: "Offline mode" },
];
const nativeText = `<send_user_message_question_reply>\n${JSON.stringify(nativeReplies)}\n</send_user_message_question_reply>`;
function fixture({ latest = { id: "turn-1", status: "interrupted", completedAt: null }, steerError, items } = {}) {
  const calls = [], steers = [];
  const daemon = {
    onNotification() {}, onRequest() {},
    async rpc(method, params) {
      calls.push([method, params]);
      if (method === "thread/items/list") return items ? items(params) : { data: [asked] };
      if (method === "thread/turns/list") return { data: [latest] };
      if (method === "thread/read") return { thread: { cwd: "/work/app" } };
      if (method === "turn/start") return { turn: { id: "turn-1" } };
      return {};
    },
  };
  const desktop = { async steer(id, params) { steers.push([id, params]); if (steerError) throw steerError; return { steered: true }; } };
  return { live: createCodexLive({ daemon, desktop, queues: false }), calls, steers };
}

test("desktop question replies use native question IDs and envelope, never the message queue", async () => {
  const { live, calls, steers } = fixture();
  assert.deepEqual(await live.answerQuestions(threadId, body), { answered: true });
  assert.equal(steers.length, 1);
  assert.equal(steers[0][0], threadId);
  assert.deepEqual(steers[0][1].input, [{ type: "text", text: nativeText, text_elements: [] }]);
  assert.equal(steers[0][1].text, "Phone\n\nOffline mode");
  assert.equal(steers[0][1].cwd, "/work/app");
  assert.ok(calls.every(([method]) => ["thread/items/list", "thread/turns/list", "thread/read"].includes(method)));
});

test("Reach-owned replies target the turn that asked, without starting another turn", async () => {
  const { live, calls, steers } = fixture();
  await live.send(threadId, { text: "Start" });
  calls.length = 0;
  await live.answerQuestions(threadId, body);
  assert.deepEqual(calls.at(-1), ["turn/steer", { threadId, expectedTurnId: "turn-1", input: [{ type: "text", text: nativeText, text_elements: [] }] }]);
  assert.equal(steers.length, 0);
  assert.ok(!calls.some(([method]) => /queue|start|resume/.test(method)));
});

test("an earlier question remains answerable after more than one page of tool activity", async () => {
  const { live, calls } = fixture({ items: ({ cursor }) => cursor ? { data: [asked] } : { data: [], nextCursor: "older" } });
  await live.answerQuestions(threadId, body);
  assert.equal(calls.filter(([m]) => m === "thread/items/list")[1][1].cursor, "older");
});

test("finished or replaced turns reject answers without queueing or starting work", async () => {
  for (const latest of [{ id: "turn-1", status: "completed" }, { id: "turn-2", status: "inProgress" }, { id: "turn-1", status: "interrupted", completedAt: 1 }]) {
    const { live, calls, steers } = fixture({ latest });
    await assert.rejects(live.answerQuestions(threadId, body), /moved on/);
    assert.equal(steers.length, 0);
    assert.ok(calls.every(([method]) => method.endsWith("/list")));
  }
});

test("refused and uncertain replies never fall back to the queue", async () => {
  for (const steerError of [new Error("Unavailable"), Object.assign(new Error("Not confirmed"), { uncertain: true })]) {
    const { live, calls, steers } = fixture({ steerError });
    await assert.rejects(live.answerQuestions(threadId, body), steerError.uncertain ? /Not confirmed/ : /couldn't take/);
    assert.equal(steers.length, 1);
    assert.ok(!calls.some(([method]) => /queue|start|resume/.test(method)));
    if (steerError.uncertain) {
      await assert.rejects(live.answerQuestions(threadId, body), /didn't confirm/);
      assert.equal(steers.length, 1, "an uncertain answer cannot be replayed");
    }
  }
});

test("malformed, duplicated, unknown and empty answers are rejected before delivery", async () => {
  for (const answers of [null, [], [null], [{ index: -1, answer: "x" }], [{ index: "0", answer: "x" }], [{ index: 2, answer: "x" }], [{ index: 0, answer: " " }], [{ index: 0, answer: 1 }], [{ index: 0, answer: "a" }, { index: 0, answer: "b" }]]) {
    const { live, steers } = fixture();
    await assert.rejects(live.answerQuestions(threadId, { ...body, answers }), { status: 400 });
    assert.equal(steers.length, 0);
  }
});

const userItem = (text, id = "reply") => codexItem({ turnId: "turn-1", item: { type: "userMessage", id, content: [{ type: "text", text }] } });
test("native replies reload on their questions and remain in exported conversations", () => {
  const items = withQuestionReplies([codexItem(asked), userItem(nativeText)]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].questions.map((q) => q.answer), ["Phone", "Offline mode"]);
  const markdown = chatMarkdown({ agent: "codex", items });
  assert.match(markdown, /Which target\?/);
  assert.match(markdown, /> Phone/);
  assert.match(markdown, /> Offline mode/);
  assert.ok(!markdown.includes("send_user_message_question_reply"));
});

test("reply parsing preserves unmatched answers and rejects unrelated IDs and malformed envelopes", () => {
  assert.equal(questionKey("q1", 0), nativeReplies[0].questionItemId);
  assert.equal(questionReply(nativeReplies), nativeText);
  assert.deepEqual(readQuestionReply(questionReply(nativeReplies[0])), [nativeReplies[0]]);
  assert.equal(readQuestionReply(questionReply([{ answer: "bad" }])), null);
  assert.equal(readQuestionReply("plain text"), null);
  const mixed = [...nativeReplies, { questionItemId: '["wrong","q1",0]', question: "Elsewhere", answer: "Keep this" }];
  const items = withQuestionReplies([codexItem(asked), userItem(questionReply(mixed))]);
  assert.equal(items[0].questions[0].answer, "Phone");
  assert.equal(items[1].text, "Keep this");
  assert.equal(withQuestionReplies([userItem(nativeText)])[0].text, "Phone\n\nOffline mode");
});

test("a confirmed answer cannot be replayed from another stale view", async () => {
  const { live, steers } = fixture();
  await live.answerQuestions(threadId, body);
  await assert.rejects(live.answerQuestions(threadId, body), /already answered/);
  assert.equal(steers.length, 1);
});

test("native transcript answers block replay after a new Reach instance starts", async () => {
  const replied = { turnId: "turn-1", item: { type: "userMessage", id: "native-reply", content: [{ type: "text", text: nativeText }] } };
  const { live, steers } = fixture({ items: ({ cursor }) => cursor ? { data: [asked] } : { data: [replied], nextCursor: "older" } });
  await assert.rejects(live.answerQuestions(threadId, body), /already answered/);
  assert.equal(steers.length, 0);
});

test("answers on a newer page attach when the question page arrives, without mutating pages", () => {
  const newer = [userItem(nativeText)], older = [codexItem(asked)];
  const original = structuredClone([...older, ...newer]);
  const newestPage = withQuestionReplies(newer);
  assert.equal(newestPage[0].text, "Phone\n\nOffline mode", "an unmatched answer remains visible");
  const combined = withQuestionReplies([...older, ...newestPage]);
  assert.equal(combined.length, 1);
  assert.deepEqual(combined[0].questions.map(q => q.answer), ["Phone", "Offline mode"]);
  assert.deepEqual([...older, ...newer], original, "the raw pages remain available for later merges");
});
