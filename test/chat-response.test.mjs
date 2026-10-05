import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
const { outputText } = ts.transpileModule(
  await fs.readFile(
    new URL("../src/chat-response.ts", import.meta.url),
    "utf8",
  ),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  },
);
const { parseChatResponse } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const chat = {
  id: "chat-1",
  name: "Example",
  cwd: "/work",
  status: "idle",
  items: [],
  approvals: [],
};
test("incomplete chat payloads produce a recoverable error instead of reaching the renderer", () => {
  for (const value of [
    undefined,
    null,
    [],
    {},
    { ...chat, items: undefined },
    { ...chat, approvals: null },
    { ...chat, items: [null] },
    { ...chat, id: "other-chat" },
  ]) {
    assert.throws(() => parseChatResponse(value, "chat-1"), /incomplete data/);
  }
});
test("chat messages and pending approvals validate nested arrays before rendering", () => {
  for (const value of [
    { ...chat, items: [{ id: "m", type: "userMessage", content: {} }] },
    { ...chat, items: [{ id: "m", type: "fileChange", changes: [null] }] },
    { ...chat, items: [{ id: "m", type: "agentMessage", text: {} }] },
    {
      ...chat,
      approvals: [
        {
          id: 1,
          method: "question",
          params: {
            questions: [{ id: "q", question: "Continue?", options: {} }],
          },
        },
      ],
    },
    { ...chat, approvals: [{ id: 1, method: "question" }] },
  ])
    assert.throws(() => parseChatResponse(value, "chat-1"), /incomplete data/);
  const valid = {
    ...chat,
    items: [
      {
        id: "m",
        type: "userMessage",
        content: [{ type: "text", text: "Hello" }],
      },
    ],
    approvals: [
      {
        id: 1,
        method: "question",
        params: {
          questions: [
            { id: "q", question: "Continue?", options: [{ label: "Yes" }] },
          ],
        },
      },
    ],
  };
  assert.equal(parseChatResponse(valid, "chat-1"), valid);
  assert.equal(parseChatResponse(chat, "chat-1"), chat);
  assert.equal(
    parseChatResponse({ ...chat, error: null }, "chat-1").error,
    null,
  );
});
