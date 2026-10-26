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

// Fullscreen uses the whole usable viewport, upright or on its side, as a
// video does; the controls float over it (the owner's choice, Oct 25).
const MAC = 2940 / 1912;
const phones = [
  ["iPhone 17 Pro Max on its side", 956, 440, { top: 0, right: 62, bottom: 21, left: 62 }, MAC, "overlay"],
  ["iPhone 17 Pro Max upright", 440, 956, { top: 62, right: 0, bottom: 34, left: 0 }, MAC, "overlay"],
  ["iPhone 16 on its side", 852, 393, { top: 0, right: 59, bottom: 21, left: 59 }, MAC, "overlay"],
  ["iPhone SE on its side", 667, 375, { top: 0, right: 0, bottom: 0, left: 0 }, 1.6, "overlay"],
  ["iPhone SE upright", 375, 667, { top: 20, right: 0, bottom: 0, left: 0 }, 1.6, "overlay"],
  ["iPad on its side", 1180, 820, { top: 24, right: 0, bottom: 20, left: 0 }, 1.6, "overlay"],
  ["Android on its side", 915, 412, { top: 0, right: 0, bottom: 24, left: 30 }, 1920 / 1080, "overlay"],
  ["Android upright", 412, 915, { top: 24, right: 0, bottom: 24, left: 0 }, 1920 / 1080, "overlay"],
  ["an ultrawide display on a phone on its side", 956, 440, { top: 0, right: 62, bottom: 21, left: 62 }, 3440 / 1440, "overlay"],
  ["a portrait Windows display on a phone on its side", 956, 440, { top: 0, right: 62, bottom: 21, left: 62 }, 1080 / 1920, "overlay"],
];
test("fullscreen reserves no sidebar or control rows, upright or on its side", async () => {
  const { chromeLayout } = await dom.load("/src/screen-chrome.ts");
  for (const [name, width, height, insets, aspect] of phones) {
    const layout = chromeLayout(width, height, aspect, insets);
    assert.equal(layout.placement, "overlay", name);
    const { picture, stage } = layout;
    // On its side the picture runs top to bottom, under the home bar as a
    // video does; upright it keeps clear of the notch and the home bar.
    const side = width > height;
    const top = side ? 0 : insets.top, bottom = side ? 0 : insets.bottom;
    assert.deepEqual(stage, { x: insets.left, y: top,
      w: width - insets.left - insets.right, h: height - top - bottom }, name);
    // As big as the screen allows: one side touches the safe area's edges.
    assert.ok(Math.abs(picture.w - stage.w) < 0.5 || Math.abs(picture.h - stage.h) < 0.5, `${name}: as big as it fits`);
    // Centred on black, nothing kept above or below for the controls.
    assert.ok(Math.abs(picture.y - stage.y - (stage.h - picture.h) / 2) < 0.5, `${name}: centred`);
    assert.ok(picture.x >= insets.left - 0.5 && picture.y >= top - 0.5, name);
    assert.ok(picture.x + picture.w <= width - insets.right + 0.5 && picture.y + picture.h <= height - bottom + 0.5, name);
    assert.ok(Math.abs(picture.w / picture.h - aspect) < 0.01, name);
  }
});

test("fullscreen keeps taps accurate across Mac and Windows image shapes, phone safe areas and both orientations", async () => {
  const { chromeLayout } = await dom.load("/src/screen-chrome.ts");
  const { screenPoint } = await dom.load("/src/screen-pointer.ts");
  for (const [name, width, height, insets] of phones) {
    for (const [frameW, frameH] of [[1470, 956], [1920, 1080], [1080, 1920], [3440, 1440]]) {
      const { picture, stage } = chromeLayout(width, height, frameW / frameH, insets);
      assert.equal(stage.w, width - insets.left - insets.right);
      const box = { left: picture.x, top: picture.y, width: picture.w, height: picture.h };
      for (const point of [{ x: .001, y: .001 }, { x: .999, y: .999 }, { x: .5, y: .5 }]) {
        const tapped = screenPoint(picture.x + picture.w * point.x, picture.y + picture.h * point.y, box, frameW, frameH);
        assert.ok(Math.abs(tapped.x - point.x) < 1e-8, `${name}: x`);
        assert.ok(Math.abs(tapped.y - point.y) < 1e-8, `${name}: y`);
      }
    }
  }
});

for (const platform of ["darwin", "win32"]) test(`${platform}: fullscreen floats its controls on its side and upright alike`, async () => {
  const size = (width, height) => {
    Object.defineProperty(dom.window, "innerWidth", { value: width, configurable: true });
    Object.defineProperty(dom.window, "innerHeight", { value: height, configurable: true });
    dom.window.dispatchEvent(new dom.window.Event("resize"));
  };
  size(956, 440);
  const view = await render(platform);
  const bar = await dom.waitFor(() => $('[role="toolbar"][aria-label="Screen controls"]'));
  bar.querySelector('[aria-label="Enter fullscreen"]').click();
  const viewer = await dom.waitFor(() => $('.screen-immersive[data-chrome="overlay"]'));
  assert.equal(viewer.style.getPropertyValue("--screen-rail"), "");
  const canvas = viewer.querySelector(".fake-desktop");
  await control();
  assert.equal(viewer.querySelector(".fake-desktop"), canvas, "changing the layout keeps the stream mounted");
  assert.ok(bar.querySelector('[aria-label="Stop"]'));
  // A resize within landscape still uses the complete new viewport.
  size(844, 390);
  await settle(30);
  assert.equal(viewer.dataset.chrome, "overlay");
  // Upright, the same: the picture alone, the controls floating over it.
  size(440, 956);
  await settle(30);
  assert.equal(viewer.dataset.chrome, "overlay");
  assert.equal(viewer.querySelector(".fake-desktop"), canvas);
  size(956, 440);
  await dom.waitFor(() => $('.screen-immersive[data-chrome="overlay"]'));
  await dom.waitFor(() => viewer.classList.contains("chrome-hidden"), 5000);
  const dock = viewer.querySelector(".screen-bar-dock");
  assert.equal(dock.hasAttribute("inert"), true, "faded controls cannot catch taps or focus");
  assert.equal(dock.getAttribute("aria-hidden"), "true");
  canvas.dispatchEvent(new dom.window.PointerEvent("pointerup", { pointerId: 1, pointerType: "touch", bubbles: true }));
  await dom.waitFor(() => !viewer.classList.contains("chrome-hidden"));
  assert.equal(dock.hasAttribute("inert"), false);
  assert.equal(dock.hasAttribute("aria-hidden"), false);
  assert.equal(viewer.querySelector(".fake-desktop"), canvas);
  bar.querySelector('[aria-label="Exit fullscreen"]').click();
  await view.unmount();
  size(1024, 768);
  assert.deepEqual(dom.errors, []);
});

test("the fullscreen stylesheet floats its controls and lets touches through after fading", () => {
  const css = fs.readFileSync(new URL("../src/screen-chrome.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /data-chrome="ends"/, "no rows kept for the controls upright");
  for (const bar of ["simple-screen-toolbar", "simple-screen-dock.screen-bar-dock"]) {
    const selector = bar.replaceAll(".", "\\.");
    const overlay = new RegExp(`\\[data-chrome="overlay"\\]:not\\(\\.screen-typing\\)\\s*>\\s*\\.${selector} \\{([^}]*)\\}`);
    assert.match(overlay.exec(css)?.[1] || "", /position: absolute;/);
  }
  assert.doesNotMatch(css, /grid-template-columns|screen-rail|flex-direction: column/);
  assert.match(css, /chrome-hidden\[data-chrome="overlay"\][\s\S]*?opacity: 0;\s*pointer-events: none;/);
  assert.match(css, /chrome-hidden\[data-chrome="overlay"\][\s\S]*?\.screen-bar,[\s\S]*?\.screen-agents-wait \{\s*pointer-events: none;/);
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

test("the current pointer mode is visible and opens its existing controls", async () => {
  for (const platform of ["darwin", "win32"]) {
    const view = await render(platform);
    const bar = await control();
    const mode = bar.querySelector('[aria-label="Pointer mode: Direct touch"]');
    assert.ok(mode);
    mode.click();
    const select = await dom.waitFor(() => $('[aria-label="Touch mode"]'));
    select.value = "trackpad";
    select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await dom.waitFor(() => bar.querySelector('[aria-label="Pointer mode: Trackpad"]'));
    assert.equal(select.value, "trackpad");
    await view.unmount();
  }
  assert.deepEqual(dom.errors, []);
});
