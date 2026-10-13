import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transpile } from "./helpers/transpile.mjs";
import { KEYS, MODIFIERS, inputAction } from "../server/desktop-protocol.mjs";

const read = (path) => fs.readFile(new URL(path, import.meta.url), "utf8");
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(
    transpile(source),
  ).toString("base64")}`;
const catalogUrl = moduleUrl(await read("../src/screen-action-catalog.ts"));
const { contextPicks, allCommands } = await import(
  moduleUrl(
    (await read("../src/app-context.ts")).replace(
      '"./screen-action-catalog"',
      JSON.stringify(catalogUrl),
    ),
  )
);
const chrome = { name: "Google Chrome", bundle: "com.google.Chrome" };
const chromeMenu = [
  { path: ["File", "New Tab"], shortcut: { key: "T", modifiers: ["meta"] } },
  { path: ["File", "Close Tab"], shortcut: { key: "W", modifiers: ["meta"] } },
  { path: ["View", "Reload This Page"], shortcut: { key: "R", modifiers: ["meta"] } },
];

test("Mac browsers press their own menu items, with key fallbacks", () => {
  const picks = contextPicks("darwin", chrome, chromeMenu);
  const byLabel = Object.fromEntries(picks.map((p) => [p.label, p]));
  assert.deepEqual(byLabel["New tab"].action, { type: "menu", path: ["File", "New Tab"] });
  assert.equal(byLabel["New tab"].keys, "⌘ T");
  assert.deepEqual(byLabel["Reload"].action, {
    type: "menu",
    path: ["View", "Reload This Page"],
  });
  // Not in this menu snapshot: fall back to the browser's keyboard shortcut.
  assert.deepEqual(byLabel["Back"].action, { type: "key", key: "left", modifiers: ["meta"] });
  assert.equal(byLabel["Back"].keys, "⌘ ←");
});

test("Windows apps get their real shortcuts", () => {
  const picks = Object.fromEntries(
    contextPicks("win32", { name: "Google Chrome", bundle: "chrome" }, []).map((p) => [
      p.label,
      p,
    ]),
  );
  assert.deepEqual(picks["New tab"].action, { type: "key", key: "t", modifiers: ["control"] });
  assert.deepEqual(picks["Back"].action, { type: "key", key: "left", modifiers: ["alt"] });
  assert.equal(picks["Back"].keys, "Alt ←");
  const terminal = Object.fromEntries(
    contextPicks("win32", { name: "Terminal", bundle: "windowsterminal" }, []).map((p) => [
      p.label,
      p,
    ]),
  );
  assert.deepEqual(terminal["New tab"].action.modifiers, ["control", "shift"]);
});

test("every curated shortcut is accepted by the server on every platform", () => {
  const apps = [
    "com.google.Chrome",
    "com.apple.Terminal",
    "com.apple.finder",
    "com.microsoft.VSCode",
    "chrome",
    "windowsterminal",
    "explorer",
    "code",
  ];
  for (const platform of ["darwin", "win32"])
    for (const bundle of apps)
      for (const pick of contextPicks(platform, { name: bundle, bundle }, [])) {
        assert.equal(pick.action.type, "key", `${bundle}: ${pick.label}`);
        assert.ok(KEYS.includes(pick.action.key), `${bundle}: ${pick.label} key`);
        for (const m of pick.action.modifiers)
          assert.ok(MODIFIERS.includes(m), `${bundle}: ${pick.label} ${m}`);
        assert.doesNotThrow(() => inputAction(pick.action), `${bundle}: ${pick.label}`);
      }
});

test("other apps (Codex, Claude…) surface their own top menu commands", () => {
  const codex = { name: "Codex", bundle: "com.openai.codex" };
  const menu = [
    { path: ["Edit", "Undo"], shortcut: { key: "Z", modifiers: ["meta"] } },
    { path: ["File", "Close Window"], shortcut: { key: "W", modifiers: ["meta"] } },
    { path: ["File", "New Chat"], shortcut: { key: "N", modifiers: ["meta"] } },
    { path: ["Help", "Report a Problem"] },
    { path: ["View", "Find…"], shortcut: { key: "F", modifiers: ["meta"] } },
  ];
  const picks = contextPicks("darwin", codex, menu);
  assert.equal(picks[0].label, "New Chat");
  assert.deepEqual(picks[0].action, { type: "menu", path: ["File", "New Chat"] });
  assert.ok(picks.some((p) => p.label === "Find"));
  assert.ok(!picks.some((p) => p.label === "Report a Problem"), "only items with shortcuts");
  const all = allCommands("darwin", menu);
  assert.equal(all.length, menu.length);
  assert.equal(all.find((a) => a.group === "Help").label, "Report a Problem");
  assert.deepEqual(contextPicks("darwin", null, menu), []);
});

test("the host only accepts well-formed context and menu requests", () => {
  assert.deepEqual(inputAction({ type: "context" }), { type: "context" });
  assert.deepEqual(inputAction({ type: "context", since: "abc" }), {
    type: "context",
    since: "abc",
  });
  assert.throws(() => inputAction({ type: "context", since: "x".repeat(65) }));
  assert.deepEqual(inputAction({ type: "menu", path: ["File", "New Tab"] }), {
    type: "menu",
    path: ["File", "New Tab"],
  });
  for (const path of [["File"], ["A", "B", "C", "D", "E"], ["File", ""], ["File", "a\nb"], "File"])
    assert.throws(() => inputAction({ type: "menu", path }), JSON.stringify(path));
});

test("native helpers answer context and menu requests", async () => {
  const swift = await read("../scripts/native/desktop-input.swift");
  assert.match(swift, /if type == "context" \{ return context\(since:/);
  assert.match(swift, /if type == "menu", let path = p\["path"\] as\? \[String\]/);
  assert.match(swift, /kAXPressAction/);
  const ps1 = await read("../scripts/native/desktop-input.ps1");
  assert.match(ps1, /'context' \{/);
});
