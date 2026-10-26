import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// "Simplify this. Keep a floating small bar in the middle bottom with icons
// instead of multiple buttons spread across the screen" (2026-10-06): the
// Screen had a top bar (Type, fullscreen, options, close), a bottom dock
// (Paste, Shortcuts, Control) and a fullscreen pill. Now one icon bar holds
// every control, including fullscreen without an extra menu.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const device = {
  id: "mac", name: "Mac", platform: "darwin", arch: "arm64", release: "25.0", roots: [],
  memory: { total: 1, free: 1 }, uptime: 1, network: { connected: true, peers: [] },
  capabilities: { files: true, terminal: true, apps: true, screen: true, codex: false },
};
let dom, React, Screen, computer;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "src/useRemoteScreen.ts": "test/dom/fakes/remote-screen.mjs",
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input.mjs",
      "src/DesktopSurface.tsx": "test/dom/fakes/desktop-surface.mjs",
    },
    routes: {
      "/api/screen/control": (init) => ({ enabled: JSON.parse(init.body).enabled }),
      "/api/screen/displays": () => ({ displays: [{ id: "primary", name: "Built-in", primary: true, width: 1470, height: 956, x: 0, y: 0 }] }),
    },
  });
  React = dom.React;
  // jsdom has no modal dialogs (the options popup opens one).
  dom.window.HTMLDialogElement.prototype.showModal ??= function () { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close ??= function () { this.removeAttribute("open"); };
  ({ default: Screen } = await dom.load("/src/Screen.tsx"));
  ({ computer } = await dom.load("/test/dom/fakes/computer.mjs"));
});
after(() => dom?.close());
const $ = (s) => dom.document.querySelector(s);
const names = (root) => [...root.querySelectorAll("button")].map((b) => b.getAttribute("aria-label") || b.textContent.trim());

test("every Screen control is one small icon bar; nothing else on the screen", async () => {
  const view = await dom.render(
    React.createElement(Screen, { peer, device, changes: '{"control":"a"}', toast: () => {}, onChanged: () => {}, onClose: () => {} }),
  );
  const bar = await dom.waitFor(() => $('[role="toolbar"][aria-label="Screen controls"]'));
  assert.deepEqual(names(bar), ["Control", "Enter fullscreen", "Screen options"]);
  // Icons, no words; no buttons at the top or in a second bar.
  for (const b of bar.querySelectorAll("button")) assert.equal(b.textContent.trim(), "", `${b.getAttribute("aria-label")} is an icon`);
  assert.equal($(".simple-screen-toolbar button"), null);
  assert.equal($(".screen-immersive-pill"), null);
  assert.equal($('[aria-label="Close screen session"]'), null);
  // Controlling: the same bar, with the keyboard and paste.
  bar.querySelector('[aria-label="Control"]').click();
  await dom.waitFor(() => bar.querySelector('[aria-label="Stop"]'));
  // Desktops (Oct 12): previous, all windows, next, as one small group.
  assert.deepEqual(names(bar), ["Stop", "Open phone keyboard", "Paste from your phone", "Pointer mode: Direct touch", "Previous desktop", "All windows", "Next desktop", "Enter fullscreen", "Screen options"]);
  assert.equal(bar.querySelector('[aria-label="Stop"]').getAttribute("aria-pressed"), "true");
  // Shortcuts and options are one menu: keys on top, then short lists.
  bar.querySelector('[aria-label="Screen options"]').click();
  const menu = await dom.waitFor(() => $('dialog[aria-label="Screen options"]'));
  assert.ok(menu.querySelector(".key-tile"), "keys in the menu");
  for (const row of ["Copy selected text", "Clipboard", "Touch", "Pause", "Connection"])
    assert.ok([...menu.querySelectorAll(".gs-row")].some((r) => r.textContent.startsWith(row)), row);
  // A key tile (Oct 13): one tap sends it to the Mac, the menu closes and
  // the line over the bar says what went.
  const sentBefore = computer.actions.length;
  menu.querySelector('[aria-label="New tab, ⌘ T"]').click();
  await dom.waitFor(() => !$("dialog[open]"));
  await dom.waitFor(() => /New tab sent/.test(dom.document.body.textContent));
  assert.deepEqual(
    computer.actions.slice(sentBefore).filter((a) => a.type === "key"),
    [{ type: "key", key: "t", modifiers: ["meta"] }],
  );
  // Fullscreen is directly reachable and keeps the same screen/control mount.
  bar.querySelector('[aria-label="Enter fullscreen"]').click();
  await dom.waitFor(() => $(".screen-expanded.screen-immersive"));
  assert.ok(bar.querySelector('[aria-label="Exit fullscreen"]'));
  assert.ok(bar.querySelector('[aria-label="Stop"]'));
  bar.querySelector('[aria-label="Exit fullscreen"]').click();
  await dom.waitFor(() => !$(".screen-expanded"));
  assert.ok(bar.querySelector('[aria-label="Enter fullscreen"]'));
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
