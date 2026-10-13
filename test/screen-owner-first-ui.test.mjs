import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
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
