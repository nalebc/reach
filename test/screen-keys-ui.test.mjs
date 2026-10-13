import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { startDom, settle } from "./dom/harness.mjs";

// "Redesign the keys section in screen control. I dont like the horizontal
// scrolling. Prefer icons and simplicity, inspire from chat gpt i want modern
// ui" (2026-10-13): Keys and the app's commands were one sideways-scrolling
// row of pills, and "Other keys" was a select plus Send key. Now they are
// wrapping grids of icon tiles; the shortcut is each tile's name and
// tooltip; any other key is modifier chips, then one tap on the key.
const read = (path) => fs.readFile(new URL(path, import.meta.url), "utf8");
let dom, React, ScreenActions, AppCommandList, contextPicks;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  ({ default: ScreenActions } = await dom.load("/src/ScreenActions.tsx"));
  ({ AppCommandList } = await dom.load("/src/AppCommands.tsx"));
  ({ contextPicks } = await dom.load("/src/app-context.ts"));
});
after(() => dom?.close());

const click = async (element) => {
  assert.ok(element, "element to click");
  element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle(10);
};
const keys = (props) => {
  const sent = [];
  return {
    sent,
    render: () =>
      dom.render(
        React.createElement(ScreenActions, {
          disabled: false,
          run: (action) => sent.push(action),
          ...props,
        }),
      ),
  };
};
const grids = (c) => [...c.querySelectorAll(".key-tiles")];
const tiles = (root) => [...root.querySelectorAll(":scope > .key-tile")];
const label = (tile) => tile.querySelector(".key-tile-label")?.textContent;
const named = (c, name) => c.querySelector(`[aria-label="${name}"]`);
const more = (c) => c.querySelector(".screen-keys .key-more");

// What each everyday tile must send, as the computer's keyboard would.
const EVERYDAY = {
  darwin: [
    ["Previous tab", "Previous tab", "Ctrl Shift Tab", "tab", ["control", "shift"]],
    ["Next tab", "Next tab", "Ctrl Tab", "tab", ["control"]],
    ["New tab", "New tab", "⌘ T", "t", ["meta"]],
    ["Close tab", "Close tab / window", "⌘ W", "w", ["meta"]],
    ["Switch app", "Switch app", "⌘ Tab", "tab", ["meta"]],
    ["Find", "Find", "⌘ F", "f", ["meta"]],
    ["Undo", "Undo", "⌘ Z", "z", ["meta"]],
    ["Escape", "Escape", "Esc", "escape", []],
  ],
  win32: [
    ["Previous tab", "Previous tab", "Ctrl Shift Tab", "tab", ["control", "shift"]],
    ["Next tab", "Next tab", "Ctrl Tab", "tab", ["control"]],
    ["New tab", "New tab", "Ctrl T", "t", ["control"]],
    ["Close tab", "Close tab / window", "Ctrl W", "w", ["control"]],
    ["Switch app", "Switch app", "Alt Tab", "tab", ["alt"]],
    ["Find", "Find", "Ctrl F", "f", ["control"]],
    ["Undo", "Undo", "Ctrl Z", "z", ["control"]],
    ["Escape", "Escape", "Esc", "escape", []],
  ],
};

for (const platform of ["darwin", "win32"])
  test(`${platform}: eight everyday keys as icon tiles, the shortcut in each name, the right keys sent`, async () => {
    const { sent, render } = keys({ platform });
    const view = await render();
    const c = view.container;
    const [everyday] = grids(c);
    assert.equal(grids(c).length, 1, "the rest waits behind More");
    const shown = tiles(everyday);
    assert.deepEqual(shown.map(label), EVERYDAY[platform].map(([tile]) => tile));
    for (const [i, [tile, name, shortcut, key, modifiers]] of EVERYDAY[platform].entries()) {
      const button = shown[i];
      assert.equal(button.getAttribute("type"), "button");
      assert.ok(button.querySelector("svg"), `${tile} has an icon`);
      assert.equal(button.getAttribute("aria-label"), `${name}, ${shortcut}`);
      assert.equal(button.getAttribute("title"), shortcut, "the tooltip is the shortcut");
      assert.equal(button.textContent, tile, "only a word or two is printed");
      await click(button);
      const action = { type: "key", key, ...(modifiers.length ? { modifiers } : {}) };
      assert.deepEqual(sent.at(-1), { label: name, keys: shortcut, action }, tile);
    }
    assert.equal(sent.length, 8);
    await view.unmount();
    assert.deepEqual(dom.errors, []);
  });

test("More opens the rest in place: the other shortcuts and the key composer, no picker", async () => {
  for (const [platform, chips, rest] of [
    ["darwin", [["⌘", "Command"], ["⌥", "Option"], ["⌃", "Control"], ["⇧", "Shift"]], ["Ctrl ↑", "Ctrl ←", "Ctrl →"]],
    ["win32", [["Win", "Win"], ["Ctrl", "Ctrl"], ["Alt", "Alt"], ["Shift", "Shift"]], ["Win Tab", "Win Ctrl ←", "Win Ctrl →"]],
  ]) {
    const { render } = keys({ platform });
    const view = await render();
    const c = view.container;
    const toggle = more(c);
    assert.equal(toggle.textContent, "More");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    await click(toggle);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(toggle.textContent, "Less");
    assert.ok(c.querySelector(`#${CSS.escape(toggle.getAttribute("aria-controls"))}`), "it names what it opened");
    const [, others, named] = grids(c);
    assert.deepEqual(tiles(others).map(label), ["Reopen tab", "All windows", "Previous desktop", "Next desktop"]);
    assert.deepEqual(tiles(others).slice(1).map((t) => t.title), rest);
    // The chips, in the keyboard's own order and words.
    const chipButtons = [...c.querySelectorAll(".key-chip")];
    assert.deepEqual(
      chipButtons.map((b) => [b.querySelector(".key-chip-symbol").textContent, b.getAttribute("aria-label")]),
      chips,
    );
    assert.ok(chipButtons.every((b) => b.getAttribute("aria-pressed") === "false"));
    // Named keys as tiles; function keys, letters and digits one more tap away.
    assert.equal(tiles(named).length, 14);
    assert.ok(tiles(named).every((t) => t.querySelector("svg")));
    assert.equal(label(tiles(named)[0]), platform === "darwin" ? "Return" : "Enter");
    assert.equal(
      named.querySelector(`[title="←"]`).getAttribute("aria-label"),
      "Left, ←",
      "a key's name starts with its word, then what it sends",
    );
    assert.equal(c.querySelector(".key-pad"), null);
    await click(c.querySelector(".key-expand"));
    assert.equal(tiles(c.querySelector(".key-pad")).length, 12 + 26 + 10);
    // Voice control: every tile's name starts with the words it shows.
    for (const tile of c.querySelectorAll(".key-tile"))
      assert.ok(
        tile.getAttribute("aria-label").startsWith(tile.textContent),
        `${tile.textContent} is named ${tile.getAttribute("aria-label")}`,
      );
    // The old picker is gone: no select, no Send key, no sideways strip.
    assert.equal(c.querySelector("select"), null);
    assert.ok(![...c.querySelectorAll("button")].some((b) => /Send key|Other keys/.test(b.textContent)));
    assert.equal(c.querySelector(".screen-helper-grid"), null);
    await view.unmount();
  }
  assert.deepEqual(dom.errors, []);
});

test("the composer sends the chips with the key in one tap, then lets go (Mac)", async () => {
  const { sent, render } = keys({ platform: "darwin" });
  const view = await render();
  const c = view.container;
  await click(more(c));
  const preview = c.querySelector(".key-preview");
  assert.equal(preview.textContent, "");
  await click(named(c, "Command"));
  await click(named(c, "Shift"));
  assert.equal(named(c, "Command").getAttribute("aria-pressed"), "true");
  assert.equal(preview.textContent, "⇧⌘ + …", "a tiny preview of what's held");
  // The key's name says the whole combination it will send.
  const ret = named(c, "Return, Shift ⌘ Return");
  assert.ok(ret, "Return names the combination");
  assert.equal(ret.title, "Shift ⌘ Return");
  assert.equal(sent.length, 0, "holding a chip sends nothing");
  await click(ret);
  assert.deepEqual(sent, [
    {
      label: "Shift ⌘ Return",
      keys: "Shift ⌘ Return",
      action: { type: "key", key: "enter", modifiers: ["meta", "shift"] },
    },
  ]);
  assert.ok([...c.querySelectorAll(".key-chip")].every((b) => b.getAttribute("aria-pressed") === "false"));
  assert.equal(preview.textContent, "");
  // With no chip held, a key goes alone.
  await click(named(c, "Delete, ⌫"));
  assert.deepEqual(sent.at(-1).action, { type: "key", key: "backspace" });
  // A chip tapped twice lets go before anything is sent.
  await click(named(c, "Option"));
  await click(named(c, "Option"));
  assert.equal(preview.textContent, "");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("the composer on Windows: Win Ctrl Alt Shift, letters and F-keys behind one tap", async () => {
  const { sent, render } = keys({ platform: "win32" });
  const view = await render();
  const c = view.container;
  await click(more(c));
  await click(c.querySelector(".key-expand"));
  await click(named(c, "Ctrl"));
  assert.equal(named(c, "Ctrl").title, "Control");
  await click(named(c, "Alt"));
  assert.equal(c.querySelector(".key-preview").textContent, "Ctrl + Alt + …");
  const letter = named(c, "T, Ctrl Alt T");
  assert.equal(letter.textContent, "T");
  await click(letter);
  await click(named(c, "Win"));
  await click(named(c, "F4, Win F4"));
  await click(named(c, "7"));
  assert.deepEqual(
    sent.map((s) => s.action),
    [
      { type: "key", key: "t", modifiers: ["control", "alt"] },
      { type: "key", key: "f4", modifiers: ["meta"] },
      { type: "key", key: "7" },
    ],
  );
  assert.deepEqual(sent.map((s) => s.label), ["Ctrl Alt T", "Win F4", "7"]);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("control off: every key and chip is disabled and nothing is sent", async () => {
  const { sent, render } = keys({ platform: "darwin", disabled: true });
  const view = await render();
  const c = view.container;
  // Opening more is only looking: it still works.
  await click(more(c));
  await click(c.querySelector(".key-expand"));
  const senders = [...c.querySelectorAll(".key-tile, .key-chip")];
  assert.ok(senders.length > 60);
  assert.ok(senders.every((b) => b.disabled), "all disabled");
  for (const b of [senders[0], named(c, "Command"), named(c, "Return")]) await click(b);
  assert.deepEqual(sent, [], "no key, no fake feedback");
  assert.equal(named(c, "Command").getAttribute("aria-pressed"), "false");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("the app's commands are tiles too, and Keys doesn't repeat what they offer", async () => {
  const app = { name: "Chrome", bundle: "com.google.chrome" };
  const picks = contextPicks("darwin", app, []);
  const ran = [];
  const all = [
    { id: "menu:a", label: "File › New Window", keys: "Shift ⌘ N", group: "File", action: { type: "menu", path: ["File", "New Window"] } },
  ];
  const view = await dom.render(
    React.createElement(
      "div",
      null,
      React.createElement(AppCommandList, { app, picks, all, disabled: false, run: (a) => ran.push(a) }),
      React.createElement(ScreenActions, {
        platform: "darwin",
        disabled: false,
        run: () => {},
        shownAbove: picks.map((p) => p.label),
      }),
    ),
  );
  const c = view.container;
  const section = c.querySelector(".app-commands");
  assert.equal(section.querySelector("h3").textContent, "For Chrome");
  const appTiles = tiles(section.querySelector(".key-tiles"));
  assert.deepEqual(appTiles.map(label), ["New tab", "Close tab", "Reopen tab", "Reload", "Back", "Forward", "Address bar", "Find"]);
  assert.ok(appTiles.every((t) => t.querySelector("svg")), "every command has an icon");
  assert.equal(appTiles[0].getAttribute("aria-label"), "New tab, ⌘ T");
  assert.equal(appTiles[0].title, "⌘ T");
  await click(appTiles[3]);
  assert.deepEqual(ran.map((a) => a.label), ["Reload"]);
  // Keys keeps its order and drops what Chrome already shows.
  assert.deepEqual(tiles(c.querySelector(".screen-keys .key-tiles")).map(label), [
    "Previous tab",
    "Next tab",
    "Switch app",
    "Undo",
    "Escape",
  ]);
  // Every menu command, searched in place.
  const toggle = section.querySelector(".key-more");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  await click(toggle);
  assert.ok(section.querySelector('input[placeholder="Search Chrome commands"]'));
  assert.match(section.querySelector(".app-commands-list").textContent, /New Window/);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("nothing in the sheet scrolls sideways", async () => {
  const files = ["key-tiles.css", "app-commands.css", "screen-bar.css", "screen-popup.css"];
  const css = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await read(`../src/${f}`)])));
  // In the stylesheets: no rule for the sheet sets overflow (or overflow-x)
  // to auto or scroll; the old sideways strip is gone.
  for (const [file, text] of Object.entries(css))
    for (const [, selector, body] of text.matchAll(/([^{}]+)\{([^{}]*)\}/g))
      assert.doesNotMatch(body, /overflow(-x)?\s*:\s*(auto|scroll)/, `${file}: ${selector.trim()}`);
  assert.doesNotMatch(css["screen-bar.css"], /screen-helper-grid|overscroll-behavior-x/);
  // On the rendered sheet, with those styles applied (jsdom applies plain
  // rules, not @media or @container).
  const style = dom.document.createElement("style");
  style.textContent = Object.values(css).join("\n");
  dom.document.head.append(style);
  const app = { name: "Chrome", bundle: "com.google.chrome" };
  const view = await dom.render(
    React.createElement(
      "dialog",
      { className: "screen-popup gs-sheet screen-menu", open: true },
      React.createElement(AppCommandList, {
        app,
        picks: contextPicks("darwin", app, []),
        all: [{ id: "m", label: "File › New Window", group: "File", action: { type: "menu", path: ["File", "New Window"] } }],
        disabled: false,
        run: () => {},
      }),
      React.createElement(ScreenActions, { platform: "darwin", disabled: false, run: () => {} }),
    ),
  );
  const c = view.container;
  await click(c.querySelector(".app-commands .key-more"));
  await click(more(c));
  await click(c.querySelector(".key-expand"));
  const sheet = c.querySelector("dialog");
  const checked = [...sheet.querySelectorAll("*")];
  assert.ok(checked.length > 100);
  for (const el of checked) {
    const x = dom.window.getComputedStyle(el).overflowX;
    assert.ok(!["auto", "scroll"].includes(x), `${el.className || el.tagName} scrolls sideways (${x})`);
  }
  for (const grid of sheet.querySelectorAll(".key-tiles, .key-chips"))
    assert.equal(dom.window.getComputedStyle(grid).display, "grid", "tiles wrap in a grid");
  assert.equal(dom.window.getComputedStyle(sheet.querySelector(".app-commands-list")).overflowX, "hidden");
  await view.unmount();
  style.remove();
  assert.deepEqual(dom.errors, []);
});
