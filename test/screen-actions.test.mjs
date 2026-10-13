import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transpile } from "./helpers/transpile.mjs";
import { KEYS, MODIFIERS } from "../server/desktop-protocol.mjs";

const read = (path) => fs.readFile(new URL(path, import.meta.url), "utf8");
const outputText = transpile(await read("../src/screen-action-catalog.ts"));
const { screenActionGroups, shortcutText, EXTRA_KEYS } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
const swift = await read("../scripts/native/desktop-input.swift");
const ps1 = await read("../scripts/native/desktop-input.ps1");

// What each native helper can actually send for a {type: "key"} action.
const swiftKeyBlock = swift.slice(swift.indexOf('type == "key"'));
const helperKeys = {
  darwin: new Set(
    [...swiftKeyBlock.matchAll(/"([a-z0-9]+)": \d+/g)].map((m) => m[1]),
  ),
  win32: new Set([
    ...[...ps1.match(/\$keys=@\{([^}]*)\}/)[1].matchAll(/([a-z]+)=\d+/g)].map(
      (m) => m[1],
    ),
    ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
    ..."abcdefghijklmnopqrstuvwxyz0123456789",
  ]),
};
const helperModifiers = {
  darwin: new Set([...swift.matchAll(/case "([a-z]+)": f\.insert/g)].map((m) => m[1])),
  win32: new Set(
    [...ps1.match(/\$mods=@\{([^}]*)\}/)[1].matchAll(/([a-z]+)=\d+/g)].map(
      (m) => m[1],
    ),
  ),
};
const actions = (platform) =>
  Object.fromEntries(
    screenActionGroups(platform)
      .flatMap((g) => g.items)
      .map((a) => [a.id, a]),
  );

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: every screen action and key is supported end to end`, () => {
    const sent = [
      ...Object.values(actions(platform)),
      ...EXTRA_KEYS.map((key) => ({ id: `key ${key}`, key, modifiers: [] })),
    ];
    for (const action of sent) {
      assert.ok(KEYS.includes(action.key), `${action.id}: server rejects ${action.key}`);
      assert.ok(
        helperKeys[platform].has(action.key),
        `${action.id}: ${platform} helper cannot send ${action.key}`,
      );
      for (const m of action.modifiers) {
        assert.ok(MODIFIERS.includes(m), `${action.id}: server rejects ${m}`);
        assert.ok(
          helperModifiers[platform].has(m),
          `${action.id}: ${platform} helper cannot hold ${m}`,
        );
      }
    }
  });
}

test("each action sends the platform's real shortcut and says so", () => {
  const expected = {
    darwin: {
      "previous-tab": ["tab", ["control", "shift"], "Ctrl Shift Tab"],
      "next-tab": ["tab", ["control"], "Ctrl Tab"],
      "new-tab": ["t", ["meta"], "⌘ T"],
      "reopen-tab": ["t", ["meta", "shift"], "Shift ⌘ T"],
      "close-tab": ["w", ["meta"], "⌘ W"],
      "switch-app": ["tab", ["meta"], "⌘ Tab"],
      "all-windows": ["up", ["control"], "Ctrl ↑"],
      "previous-desktop": ["left", ["control"], "Ctrl ←"],
      "next-desktop": ["right", ["control"], "Ctrl →"],
      find: ["f", ["meta"], "⌘ F"],
      undo: ["z", ["meta"], "⌘ Z"],
      escape: ["escape", [], "Esc"],
    },
    win32: {
      "previous-tab": ["tab", ["control", "shift"], "Ctrl Shift Tab"],
      "next-tab": ["tab", ["control"], "Ctrl Tab"],
      "new-tab": ["t", ["control"], "Ctrl T"],
      "reopen-tab": ["t", ["control", "shift"], "Ctrl Shift T"],
      "close-tab": ["w", ["control"], "Ctrl W"],
      "switch-app": ["tab", ["alt"], "Alt Tab"],
      "all-windows": ["tab", ["meta"], "Win Tab"],
      "previous-desktop": ["left", ["meta", "control"], "Win Ctrl ←"],
      "next-desktop": ["right", ["meta", "control"], "Win Ctrl →"],
      find: ["f", ["control"], "Ctrl F"],
      undo: ["z", ["control"], "Ctrl Z"],
      escape: ["escape", [], "Esc"],
    },
  };
  for (const [platform, table] of Object.entries(expected)) {
    const catalog = actions(platform);
    assert.deepEqual(Object.keys(catalog).sort(), Object.keys(table).sort());
    for (const [id, [key, modifiers, text]] of Object.entries(table)) {
      assert.equal(catalog[id].key, key, `${platform} ${id} key`);
      assert.deepEqual(catalog[id].modifiers, modifiers, `${platform} ${id} modifiers`);
      assert.equal(
        shortcutText(platform, catalog[id].modifiers, catalog[id].key),
        text,
        `${platform} ${id} label`,
      );
    }
  }
});

test("macOS helper presses modifiers and marks arrow/navigation keys like real hardware", () => {
  // System shortcuts (⌘Tab, Mission Control, desktops) ignore flag-only modifiers
  // and arrow events without the fn/numeric-pad flags physical keys carry.
  assert.match(swift, /case 123, 124, 125, 126: return \[\.maskSecondaryFn, \.maskNumericPad\]/);
  assert.match(swift, /case 114, 115, 116, 117, 119, 121: return \.maskSecondaryFn/);
  assert.match(swift, /for \(modifier, flag\) in Input\.modifierKeys where flags\.contains\(flag\)/);
  assert.match(swift, /e\?\.flags = flags\.union\(Input\.keyFlags\(code\)\)/);
});

test("Windows helper sends navigation keys and the Windows key as extended keys", () => {
  const extended = ps1
    .match(/extended=\{([^}]*)\}/)[1]
    .split(",")
    .map(Number);
  // PgUp PgDn End Home ← ↑ → ↓ Insert Delete LWin RWin
  for (const vk of [33, 34, 35, 36, 37, 38, 39, 40, 45, 46, 91, 92])
    assert.ok(extended.includes(vk), `VK ${vk} must be extended`);
  const keyBranch = ps1.slice(ps1.indexOf("'key' {"), ps1.indexOf("default {"));
  assert.doesNotMatch(keyBranch, /keybd_event/, "key actions must go through Key()");
});

test("native helpers rebuild whenever their source changes", async () => {
  const native = await read("../server/desktop-native.mjs");
  assert.match(native, /createHash\("sha256"\)\.update\(source\)/);
  assert.doesNotMatch(native, /reach-\$\{kind\}-\$\{kind === "desktop-input" \? "v/);
  const stream = await read("../server/screen-stream.mjs");
  assert.match(stream, /createHash\("sha256"\)\.update\(source\)/);
  assert.doesNotMatch(stream, /reach-screen-stream-v\d/);
});

test("guest invites never preselect a folder", async () => {
  // The first shared folder is often the whole home folder.
  const invite = await read("../src/InviteSheet.tsx");
  // Folders are chosen per computer, starting with none.
  assert.match(
    invite,
    /const \[folders, setFolders\] = useState<Record<string, PickedFolder\[\]>>\(\{\}\);/,
  );
  assert.doesNotMatch(invite, /useState<number\[\]>\(\s*device\.roots/);
});
