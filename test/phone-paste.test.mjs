import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transpile } from "./helpers/transpile.mjs";

// Paste from the phone: its clipboard onto the computer's, then the paste
// shortcut for that computer. Refusals and oversized text say why.
const outputText = transpile(await fs.readFile(new URL("../src/phone-paste.ts", import.meta.url), "utf8"));
const { pasteFromPhone, PASTE_LIMIT } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const recorder = () => {
  const sent = [];
  return { sent, send: async (a) => (sent.push(a), {}) };
};

test("a Windows PC gets ctrl+V, a Mac ⌘V", async () => {
  const pc = recorder();
  assert.equal(
    await pasteFromPhone(Promise.resolve("hi"), pc.send, "win32"),
    "pasted",
  );
  assert.deepEqual(pc.sent.at(-1), {
    type: "key",
    key: "v",
    modifiers: ["control"],
  });
  const mac = recorder();
  await pasteFromPhone(Promise.resolve("hi"), mac.send, "darwin");
  assert.deepEqual(mac.sent.at(-1), {
    type: "key",
    key: "v",
    modifiers: ["meta"],
  });
});

test("a refused read or text too long sends nothing and says why", async () => {
  const r = recorder();
  await assert.rejects(
    pasteFromPhone(
      Promise.reject(new Error("NotAllowedError")),
      r.send,
      "darwin",
    ),
    /Allow pasting/,
  );
  await assert.rejects(
    pasteFromPhone(
      Promise.resolve("x".repeat(PASTE_LIMIT + 1)),
      r.send,
      "darwin",
    ),
    /too long/,
  );
  assert.deepEqual(r.sent, []);
});
