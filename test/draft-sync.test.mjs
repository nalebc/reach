import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
const { outputText } = ts.transpileModule(await fs.readFile(new URL("../src/draft-sync.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
});
const { createDraftSync } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);

test("drafts coalesce, stay ordered through slow writes, and flush before Send", async () => {
  const writes = [];
  let release;
  const sync = createDraftSync(async (text) => {
    writes.push(text);
    if (text === "hello") await new Promise((r) => { release = r; });
  }, 10000);
  sync.update("h"); sync.update("hello");
  const first = sync.flush();
  sync.update("hello w"); sync.update("hello world");
  const sent = sync.flush();
  assert.deepEqual(writes, ["hello"]);
  release();
  await Promise.all([first, sent]);
  assert.deepEqual(writes, ["hello", "hello world"]);
  sync.close();
});
test("closing a conversation drops unsent updates; a refused Mac draft does not prevent Send", async () => {
  const writes = [];
  const sync = createDraftSync(async (text) => { writes.push(text); throw Error("Mac draft changed"); }, 10000);
  sync.update("first");
  await sync.flush();
  sync.update("second"); sync.close();
  await sync.flush();
  assert.deepEqual(writes, ["first"]);
});

test("Send doesn't write the draft first: it drops the one not yet written and waits only for one on its way", async () => {
  const writes = [];
  let release;
  const sync = createDraftSync(async (text) => {
    writes.push(text);
    if (text === "hel") await new Promise((r) => { release = r; });
  }, 10000);
  sync.update("hel");
  const writing = sync.flush();
  sync.update("hello world");
  let settled = false;
  const sent = sync.settle().then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(settled, false, "waits for the write on its way");
  release();
  await Promise.all([writing, sent]);
  assert.deepEqual(writes, ["hel"], "the newer draft is never written: the message replaces it");
  sync.update("next");
  await sync.settle();
  assert.deepEqual(writes, ["hel"]);
  sync.close();
});
