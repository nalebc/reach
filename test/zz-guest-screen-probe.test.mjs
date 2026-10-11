import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const base = {
  id: "mac", name: "Mac", platform: "darwin", arch: "arm64", release: "25.0", roots: [],
  memory: { total: 1, free: 1 }, uptime: 1, network: { connected: true, peers: [] },
  capabilities: { files: true, terminal: true, apps: true, screen: true, codex: false },
};
let dom, React, Screen;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "src/useDesktopInput.ts": "test/dom/fakes/desktop-input.mjs",
      "src/DesktopSurface.tsx": "test/dom/fakes/desktop-surface.mjs",
    },
    routes: {
      "/api/screen/control": (init) => ({ enabled: JSON.parse(init.body).enabled }),
      "/api/screen/displays": () => ({ displays: [{ id: "primary", name: "Built-in", primary: true, width: 1470, height: 956, x: 0, y: 0 }] }),
    },
  });
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal ??= function () { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close ??= function () { this.removeAttribute("open"); };
  ({ default: Screen } = await dom.load("/src/Screen.tsx"));
});
after(() => dom?.close());
for (const scopes of [["device", "screen"], ["device", "screen", "screen:control", "apps:open"], ["device", "files:read"]])
  test(`guest ${scopes.join(",")}`, async () => {
    const device = { ...base, access: { kind: "guest", scopes, expiresAt: Date.now() + 3600000 } };
    const view = await dom.render(React.createElement(Screen, { peer, device, changes: "{}", toast: () => {}, onChanged: () => {}, onClose: () => {} }));
    await settle(200);
    const opts = dom.document.querySelector('[aria-label="Screen options"]');
    if (opts) { opts.click(); await settle(80); }
    console.log("ERRORS", JSON.stringify(dom.errors).slice(0, 2000));
    console.log("TEXT", dom.document.body.textContent.slice(0, 400));
    await view.unmount();
  });
