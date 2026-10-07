import test from "node:test";
import assert from "node:assert/strict";
import { createAppCards, questionId } from "../server/agent-sessions/app-cards.mjs";

// Oct 6: Claude's questions in the Claude app could only be answered through
// the live screen ("This request is already open in the Claude app"). The
// phone taps the options; Reach presses the same ones in the app, then Submit.
const questions = [
  { question: "How should an agent get your folders?", options: [{ label: "Real folder, read-only (Recommended)" }, { label: "Keep private copy only" }] },
  { question: "Which layout for the new invite screen?", multiSelect: true, options: [{ label: "One page, 3 switches (Recommended)" }, { label: "Step by step" }, { label: "Presets first" }] },
];
const ID = questionId("toolu_1");
function setup({ onScreen = "chat", takes = true } = {}) {
  let waiting = true;
  const calls = { answered: [], opened: [] };
  const cards = createAppCards({
    read: async () => ({}),
    press: async () => ({}),
    open: async (url) => calls.opened.push(url),
    shown: () => [{ id: onScreen }],
    wait: async () => {},
    confirmMs: 50,
    pending: async () => null,
    pendingQuestion: async () => (waiting ? { id: ID, questions, appSessionId: "local_x" } : null),
    answerQuestion: async (agent, answers) => {
      calls.answered.push(answers);
      if (takes) waiting = false;
    },
  });
  return { cards, calls };
}

test("tapped options are pressed in the Claude app, question by question, then confirmed", async () => {
  const { cards, calls } = setup();
  assert.equal(cards.owns(ID), true);
  const result = await cards.answer("claude", "chat", ID, {
    answers: { q0: ["Real folder, read-only (Recommended)"], q1: ["Step by step", "Presets first"] },
  });
  assert.deepEqual(result, { answered: true });
  assert.deepEqual(calls.answered, [
    [
      { question: questions[0].question, picks: ["Real folder, read-only (Recommended)"] },
      { question: questions[1].question, picks: ["Step by step", "Presets first"] },
    ],
  ]);
  // Already on screen: the app isn't switched.
  assert.deepEqual(calls.opened, []);
});

test("only the question's own options, one where it takes one, every question answered", async () => {
  const { cards, calls } = setup();
  for (const answers of [
    { q0: ["Something I made up"], q1: ["Step by step"] },
    { q0: ["Real folder, read-only (Recommended)", "Keep private copy only"], q1: ["Step by step"] },
    { q0: ["Real folder, read-only (Recommended)"] },
    undefined,
  ])
    await assert.rejects(cards.answer("claude", "chat", ID, { answers }), (e) => e.status === 400);
  assert.deepEqual(calls.answered, []);
});

test("another chat on screen is brought up first; an answer the app didn't take is never pressed twice", async () => {
  const { cards, calls } = setup({ onScreen: "other", takes: false });
  const answers = { q0: ["Keep private copy only"], q1: ["Presets first"] };
  await assert.rejects(cards.answer("claude", "chat", ID, { answers }), /didn't take the answer/);
  assert.deepEqual(calls.opened, ["claude://code/needs-input?session=local_x"]);
  await assert.rejects(cards.answer("claude", "chat", ID, { answers }), /already attempted/);
  assert.equal(calls.answered.length, 1);
  // A question already gone: said so, nothing pressed.
  await assert.rejects(setup().cards.answer("claude", "chat", questionId("old"), { answers }), /already answered/);
});
