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

test("apps installed without the keyboard plugin keep the web keyboard", async () => {
  // An older installed app still loads the newest interface from the computer.
  const js = await read("../src/remote-keyboard.ts");
  assert.match(js, /isNativePlatform\(\) && Capacitor\.isPluginAvailable\("RemoteKeyboard"\)/);
  const screen = await read("../src/Screen.tsx");
  assert.match(screen, /nativeKeyboard \? \(\s*<NativeRemoteTyping/);
  const native = await read("../src/NativeRemoteTyping.tsx");
  assert.match(native, /if \(current.target.pending\)/);
  assert.match(screen, /!nativeKeyboard &&\s*mobile/);
  assert.doesNotMatch(screen, /\bisNative\b/);
});

test("the phone never rewrites text it already sent", async () => {
  // Autocorrect and Safari's inline suggestions replace earlier letters,
  // which reach the computer as deletions ("first letter disappears").
  const web = await read("../src/RemoteTyping.tsx");
  assert.match(web, /autoCorrect: "off"/);
  assert.match(web, /spellCheck: false/);
  assert.match(web, /writingsuggestions: "false"/);
});
