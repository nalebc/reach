import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startDom, settle } from "./dom/harness.mjs";

// The owner's screen, Oct 12: desktops one tap away in the bar, and one
// quiet pill while agents wait for you ("Let them back").
const device = (platform) => ({
  id: "mac", name: "Studio", platform, arch: "arm64", release: "25.0", roots: [],
  memory: { total: 1, free: 1 }, uptime: 1, network: { connected: true, peers: [] },
  capabilities: { files: true, terminal: true, apps: true, screen: true, codex: false },
});
const peer = { id: "mac", name: "Studio", url: "https://reach.test", token: "t", platform: "darwin" };
let dom, React, Screen, computer;
const posted = [];
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "src/useRemoteScreen.ts": "test/dom/fakes/remote-screen.mjs",
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input.mjs",
      "src/DesktopSurface.tsx": "test/dom/fakes/desktop-surface.mjs",
    },
    routes: {
      "/api/screen/control": (init) => (posted.push(["control", JSON.parse(init.body)]), { enabled: JSON.parse(init.body).enabled }),
      "/api/screen/agents-back": () => (posted.push(["agents-back"]), { ok: true }),
      "/api/screen/displays": () => ({ displays: [{ id: "primary", name: "Built-in", primary: true, width: 1470, height: 956, x: 0, y: 0 }] }),
    },
  });
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal ??= function () { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close ??= function () { this.removeAttribute("open"); };
  ({ default: Screen } = await dom.load("/src/Screen.tsx"));
  ({ computer } = await dom.load("/test/dom/fakes/computer.mjs"));
});
after(() => dom?.close());
beforeEach(() => {
  computer.reset();
  posted.length = 0;
  dom.errors.length = 0;
});
const $ = (s) => dom.document.querySelector(s);
const render = (platform, changes = '{"control":"a"}') =>
  dom.render(React.createElement(Screen, { peer, device: device(platform), changes, toast: () => {}, onChanged: () => {} }));
const control = async () => {
  const bar = await dom.waitFor(() => $('[role="toolbar"][aria-label="Screen controls"]'));
  bar.querySelector('[aria-label="Control"]').click();
  await dom.waitFor(() => bar.querySelector('[aria-label="Stop"]'));
  return bar;
};

for (const [platform, keys] of [
  ["darwin", [
    ["Previous desktop", { type: "key", key: "left", modifiers: ["control"] }],
    ["All windows", { type: "key", key: "up", modifiers: ["control"] }],
    ["Next desktop", { type: "key", key: "right", modifiers: ["control"] }],
  ]],
  ["win32", [
    ["Previous desktop", { type: "key", key: "left", modifiers: ["meta", "control"] }],
    ["All windows", { type: "key", key: "tab", modifiers: ["meta"] }],
    ["Next desktop", { type: "key", key: "right", modifiers: ["meta", "control"] }],
  ]],
]) {
  test(`${platform}: the bar's desktop switcher sends the computer's own desktop keys`, async () => {
    const view = await render(platform);
    const bar = await dom.waitFor(() => $('[role="toolbar"][aria-label="Screen controls"]'));
    assert.equal(bar.querySelector('[aria-label="Desktops"]'), null, "only while controlling");
    await control();
    const group = await dom.waitFor(() => bar.querySelector('[role="group"][aria-label="Desktops"]'));
    const buttons = [...group.querySelectorAll("button")];
    assert.deepEqual(buttons.map((b) => b.getAttribute("aria-label")), keys.map(([label]) => label));
    for (const b of buttons) {
      assert.equal(b.textContent.trim(), "", "an icon, no words");
      assert.match(b.title, new RegExp(`^${b.getAttribute("aria-label")} · `), "the shortcut in its tooltip");
    }
    for (const [label, action] of keys) {
      computer.frame();
      await settle();
      group.querySelector(`[aria-label="${label}"]`).click();
      await dom.waitFor(() => computer.actions.length);
      assert.deepEqual(computer.actions.pop(), action, label);
      computer.actions.length = 0;
      await settle(20);
    }
    await view.unmount();
    assert.deepEqual(dom.errors, []);
  });
}

// "I could not see my doc and top bar from mac even in control": Reach's
// bars floated over the picture's top and bottom. Now they take the room
// the picture leaves; checked on the layout itself, phone held both ways.
const MAC = 2940 / 1912;
const phones = [
  // name, width, height, safe areas, the Mac's shape, where the room is
  ["iPhone 17 Pro Max on its side", 956, 440, { top: 0, right: 62, bottom: 21, left: 62 }, MAC, "side"],
  ["iPhone 17 Pro Max upright", 440, 956, { top: 62, right: 0, bottom: 34, left: 0 }, MAC, "ends"],
  ["iPhone 16 on its side", 852, 393, { top: 0, right: 59, bottom: 21, left: 59 }, MAC, "side"],
  ["iPhone SE on its side", 667, 375, { top: 0, right: 0, bottom: 0, left: 0 }, 1.6, "side"],
  ["iPhone SE upright", 375, 667, { top: 20, right: 0, bottom: 0, left: 0 }, 1.6, "ends"],
  ["iPad on its side", 1180, 820, { top: 24, right: 0, bottom: 20, left: 0 }, 1.6, "ends"],
  ["an ultrawide display on a phone on its side", 956, 440, { top: 0, right: 62, bottom: 21, left: 62 }, 3440 / 1440, "ends"],
];
test("fullscreen: Reach's controls never cover the picture, upright or on its side, zoomed or not", async () => {
  const { chromeLayout, overlaps, RAIL_MIN, RAIL_MAX } = await dom.load("/src/screen-chrome.ts");
  for (const [name, width, height, insets, aspect, placement] of phones) {
    const layout = chromeLayout(width, height, aspect, insets);
    assert.equal(layout.placement, placement, name);
    const { picture, stage } = layout;
    for (const chrome of layout.chrome) {
      assert.ok(!overlaps(picture, chrome), `${name}: the picture is clear of ${JSON.stringify(chrome)}`);
      // Zoomed in, the picture fills its area: still clear.
      assert.ok(!overlaps(stage, chrome), `${name}: zoomed in, still clear`);
    }
    // Inside the screen and its safe areas, its own shape.
    assert.ok(picture.x >= insets.left - 0.5 && picture.y >= insets.top - 0.5, name);
    assert.ok(picture.x + picture.w <= width - insets.right + 0.5 && picture.y + picture.h <= height - insets.bottom + 0.5, name);
    assert.ok(Math.abs(picture.w / picture.h - aspect) < 0.01, name);
    if (placement === "side") {
      assert.ok(layout.rail >= RAIL_MIN && layout.rail <= RAIL_MAX, `${name}: rail ${layout.rail}`);
      // On its side the Mac keeps the whole height when the room allows.
      const areaH = height - insets.top - insets.bottom;
      if (width - insets.left - insets.right - areaH * aspect >= RAIL_MIN) assert.ok(Math.abs(picture.h - areaH) < 0.5, `${name}: full height`);
    } else {
      assert.equal(layout.chrome[0].y, 0, `${name}: status on top`);
      assert.equal(layout.chrome[1].y + layout.chrome[1].h, height, `${name}: the bar below`);
    }
  }
});

test("fullscreen lays the Screen out by the room it has, and the stylesheet keeps the bars off the picture", async () => {
  const size = (width, height) => {
    Object.defineProperty(dom.window, "innerWidth", { value: width, configurable: true });
    Object.defineProperty(dom.window, "innerHeight", { value: height, configurable: true });
    dom.window.dispatchEvent(new dom.window.Event("resize"));
  };
  size(956, 440);
  const view = await render("darwin");
  const bar = await dom.waitFor(() => $('[role="toolbar"][aria-label="Screen controls"]'));
  bar.querySelector('[aria-label="Enter fullscreen"]').click();
  const viewer = await dom.waitFor(() => $('.screen-immersive[data-chrome="side"]'));
  assert.match(viewer.style.getPropertyValue("--screen-rail"), /^\d+px$/);
  // The computer's name isn't news in the rail; a problem would be.
  assert.equal($(".screen-state-text").textContent, "Studio");
  assert.equal($(".screen-state-text").hasAttribute("data-news"), false);
  size(440, 956);
  await dom.waitFor(() => $('.screen-immersive[data-chrome="ends"]'));
  (bar.querySelector('[aria-label="Exit fullscreen"]') || bar.querySelector('[aria-label="Enter fullscreen"]'))?.click();
  await view.unmount();
  size(1024, 768);
  // In those layouts the bars are in the flow, never absolute over the picture.
  const css = fs.readFileSync(new URL("../src/screen-chrome.css", import.meta.url), "utf8");
  for (const placement of ["ends", "side"])
    for (const bar of ["simple-screen-toolbar", "simple-screen-dock.screen-bar-dock"]) {
      const rule = new RegExp(`\\[data-chrome="${placement}"\\]:not\\(\\.screen-typing\\)\\s*>\\s*\\.${bar.replace(".", "\\.")} \\{([^}]*)\\}`);
      const body = rule.exec(css)?.[1] || "";
      assert.match(body, /position: relative;/, `${placement}: ${bar} takes its own room`);
      assert.match(body, /transform: none;/, `${placement}: ${bar} never slides over it`);
    }
  // Hidden means faded, the room kept: no slide that moves the picture.
  assert.match(css, /\.chrome-hidden\[data-chrome\]:not\(\.screen-typing\)\s*> \.simple-screen-toolbar \{\s*opacity: 0;\s*transform: none;/);
  assert.deepEqual(dom.errors, []);
});

test("while agents wait for you: one quiet pill, and Let them back ends control and the wait", async () => {
  const view = await render("darwin", '{"control":"a","agentsWait":true}');
  await control();
  const pill = await dom.waitFor(() => $(".screen-agents-wait"));
  assert.equal(pill.getAttribute("role"), "status");
  assert.match(pill.textContent, /^Agents wait · 2 min after you stop/);
  const back = [...pill.querySelectorAll("button")].find((b) => b.textContent === "Let them back");
  assert.ok(back);
  back.click();
  await dom.waitFor(() => posted.some(([what]) => what === "agents-back"));
  assert.deepEqual(posted.filter(([what]) => what === "control").at(-1), ["control", { enabled: false }], "your control ends too");
  await dom.waitFor(() => $('[aria-label="Control"]'));
  await view.unmount();
  // Nothing held: no pill.
  const quiet = await render("darwin");
  await dom.waitFor(() => $('[role="toolbar"][aria-label="Screen controls"]'));
  assert.equal($(".screen-agents-wait"), null);
  await quiet.unmount();
  assert.deepEqual(dom.errors, []);
});
