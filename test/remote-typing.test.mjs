import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
import { inputAction } from "../server/desktop-protocol.mjs";
const source = await fs.readFile(
  new URL("../src/typing-edit.ts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  },
});
const { typingEdit, typingTail } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
test("live typing sends only edits, including autocorrection and middle replacements", () => {
  assert.deepEqual(typingEdit("", "hello"), { delete: 0, text: "hello" });
  assert.deepEqual(typingEdit("hello", "hello!"), { delete: 0, text: "!" });
  assert.deepEqual(typingEdit("teh", "the"), { delete: 2, text: "he" });
  assert.deepEqual(typingEdit("hello world", "hello there"), {
    delete: 5,
    text: "there",
  });
  assert.deepEqual(typingEdit("same", "same"), { delete: 0, text: "" });
});
test("emoji and combining characters delete as graphemes and oversized edits are bounded", () => {
  for (const text of ["👩🏽‍💻", "🇨🇦", "e\u0301"])
    assert.deepEqual(typingEdit("a" + text, "a"), { delete: 1, text: "" });
  assert.throws(() => typingEdit("a".repeat(257), ""));
  assert.throws(() => typingEdit("", "a".repeat(8001)));
});
test("typing protocol requires an opaque focus token, bounded edits and valid hit-test coordinates", () => {
  const focus = "fixture-focus";
  assert.deepEqual(inputAction({ type: "focus", x: 0.3, y: 0.5 }), {
    type: "focus",
    x: 0.3,
    y: 0.5,
  });
  assert.deepEqual(
    inputAction({
      type: "type-edit",
      focus,
      delete: 2,
      text: "hi",
      command: "ignored",
    }),
    { type: "type-edit", focus, delete: 2, text: "hi" },
  );
  assert.equal(inputAction({ type: "key", key: "enter", focus }).focus, focus);
  for (const a of [
    { type: "focus", x: 1.5, y: 0 },
    { type: "focus", x: 0 },
    { type: "type-edit", delete: 0, text: "hi" },
    { type: "type-edit", focus: "../bad", delete: 0, text: "hi" },
    { type: "type-edit", focus, delete: 257, text: "" },
    { type: "type-edit", focus, delete: -1, text: "" },
    { type: "type-edit", focus, delete: 0, text: "\0" },
  ])
    assert.throws(() => inputAction(a));
});

test("invisible keyboard keeps accepting long sessions and autocorrection after context rollover", () => {
  let context = "",
    remote = "";
  for (let i = 0; i < 3000; i++) {
    const next = context + "a";
    const edit = typingEdit(context, next);
    assert.equal(edit.delete, 0);
    remote += edit.text;
    context = typingTail(next);
  }
  assert.equal(remote.length, 3000);
  assert.equal(context.length, 128);
  context = typingTail(context + " teh");
  assert.deepEqual(typingEdit(context, context.slice(0, -3) + "the"), {
    delete: 2,
    text: "he",
  });
  const emoji = "👩🏽‍💻";
  assert.equal(typingTail(emoji.repeat(200)), emoji.repeat(128));
  assert.deepEqual(
    typingEdit(typingTail(emoji.repeat(200)), emoji.repeat(127)),
    { delete: 1, text: "" },
  );
});
