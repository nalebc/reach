import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
import { inputAction } from "../server/desktop-protocol.mjs";
const { outputText } = ts.transpileModule(
  await fs.readFile(new URL("../src/remote-copy.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  },
);
const { copyRemoteSelection } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
class Item {
  constructor(data) {
    this.data = data;
  }
}
test("remote selection copy starts clipboard write during the tap, before remote data arrives", async () => {
  let resolve;
  const pending = new Promise((r) => {
    resolve = r;
  });
  let started = false,
    copied = "";
  const result = copyRemoteSelection(
    () => pending,
    {
      write: async (items) => {
        started = true;
        copied = await (await items[0].data["text/plain"]).text();
      },
    },
    Item,
  );
  assert.equal(started, true);
  resolve("Selected laptop text");
  assert.deepEqual(await result, { copied: true, text: "" });
  assert.equal(copied, "Selected laptop text");
});
test("denied clipboard access returns only the requested selection for native copy fallback", async () => {
  assert.deepEqual(
    await copyRemoteSelection(
      async () => "Selected text",
      {
        write: async () => {
          throw Error("Denied");
        },
      },
      Item,
    ),
    { copied: false, text: "Selected text" },
  );
});
test("unavailable or empty remote selection never falls back to unrelated clipboard data", async () => {
  const clipboard = {
    write: async (items) => {
      await items[0].data["text/plain"];
    },
  };
  await assert.rejects(
    copyRemoteSelection(
      async () => {
        throw Error("Not accessible");
      },
      clipboard,
      Item,
    ),
    /Not accessible/,
  );
  await assert.rejects(
    copyRemoteSelection(async () => "", clipboard, Item),
    /Select some text/,
  );
  assert.deepEqual(
    inputAction({
      type: "selection-read",
      text: "injected",
      command: "ignored",
    }),
    { type: "selection-read" },
  );
});
