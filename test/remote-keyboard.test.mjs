import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

const read = (path) => fs.readFile(new URL(path, import.meta.url), "utf8");

test("native keyboard keeps the same text tail as the web diff", async () => {
  // If these drift, edits are computed against the wrong text and the computer
  // receives bogus deletions.
  const swift = await read("../ios/App/App/RemoteKeyboard.swift");
  const js = await read("../src/typing-edit.ts");
  const native = Number(swift.match(/static let tail = (\d+)/)[1]);
  const web = Number(js.match(/graphemes\.slice\(-(\d+)\)/)[1]);
  assert.equal(native, web);
});

test("native keyboard plugin is registered and compiled into the app", async () => {
  const bridge = await read("../ios/App/App/QRScanner.swift");
  assert.match(bridge, /registerPluginInstance\(RemoteKeyboardPlugin\(\)\)/);
  const project = await read("../ios/App/App.xcodeproj/project.pbxproj");
  assert.match(project, /RemoteKeyboard\.swift in Sources \*\/,/);
  const js = await read("../src/remote-keyboard.ts");
  const swift = await read("../ios/App/App/RemoteKeyboard.swift");
  assert.equal(
    js.match(/registerPlugin<[^>]+>\("(\w+)"\)/)[1],
    swift.match(/jsName = "(\w+)"/)[1],
  );
});
