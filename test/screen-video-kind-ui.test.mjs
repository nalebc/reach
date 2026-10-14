import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// No silent downgrade (audit #26): the Screen page says which video the
// computer sends (Screen options → Connection → Video) and, when it isn't
// the best this computer could send, why, once as a notice and under the
// row. Same on a Mac and a Windows PC; the words are the computer's.
const device = (platform) => ({
  id: platform, name: platform === "win32" ? "PC" : "Mac", platform, arch: "x64", release: "10.0", roots: [],
  memory: { total: 1, free: 1 }, uptime: 1, network: { connected: true, peers: [] },
  capabilities: { files: true, terminal: true, apps: true, screen: true, codex: false },
});
const peerOf = (platform) => ({ id: platform, name: platform, url: `https://${platform}.reach.test`, token: "t", platform });
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
      "/api/screen/displays": () => ({ displays: [{ id: "DISPLAY1", name: "\\\\.\\DISPLAY1", primary: true, width: 1920, height: 1080, x: 0, y: 0 }] }),
    },
  });
  React = dom.React;
  dom.window.HTMLDialogElement.prototype.showModal ??= function () { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close ??= function () { this.removeAttribute("open"); };
  ({ default: Screen } = await dom.load("/src/Screen.tsx"));
  ({ computer } = await dom.load("/test/dom/fakes/computer.mjs"));
});
after(() => dom?.close());
const $ = (s) => dom.document.querySelector(s);

async function connection(platform, toasts) {
  const view = await dom.render(
    React.createElement(Screen, { peer: peerOf(platform), device: device(platform), toast: (s) => toasts.push(s), onChanged: () => {}, onClose: () => {} }),
  );
  const bar = await dom.waitFor(() => $('[role="toolbar"][aria-label="Screen controls"]'));
  bar.querySelector('[aria-label="Screen options"]').click();
  const menu = await dom.waitFor(() => $('dialog[aria-label="Screen options"]'));
  [...menu.querySelectorAll(".gs-row")].find((r) => r.textContent.startsWith("Connection")).click();
  const panel = await dom.waitFor(() => $('dialog[aria-label="Connection"]'));
  const rows = Object.fromEntries(
    [...panel.querySelectorAll(".gs-row")]
      .filter((r) => r.querySelector(".gs-value"))
      .map((r) => [r.querySelector(".gs-label").textContent, r.querySelector(".gs-value").textContent]),
  );
  const notes = [...panel.querySelectorAll(".gs-foot")].map((p) => p.textContent);
  return { view, rows, notes };
}

test("a PC without an H.264 encoder: Still images, and why, once as a notice and under the row", async () => {
  computer.reset();
  const why = "This N edition of Windows has no H.264 video encoder: it comes with the Media Feature Pack (Settings, Apps, Optional features). Until then, the screen comes as still images.";
  computer.video = "Still images";
  computer.videoWhy = why;
  const toasts = [];
  const first = await connection("win32", toasts);
  assert.equal(first.rows.Video, "Still images");
  assert.ok(first.notes.includes(why), JSON.stringify(first.notes));
  assert.deepEqual(toasts, [why], "said once as a notice");
  await first.view.unmount();
  // Opened again on this page: under the row, not another notice.
  const again = await connection("win32", toasts);
  assert.ok(again.notes.includes(why));
  assert.deepEqual(toasts, [why]);
  await again.view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("H.264 from Windows itself or from a Mac: its word, and nothing to explain", async () => {
  for (const [platform, video] of [["win32", "H.264, hardware"], ["darwin", "H.264"]]) {
    computer.reset();
    computer.video = video;
    const toasts = [];
    const { view, rows, notes } = await connection(platform, toasts);
    assert.equal(rows.Video, video);
    // (A PC's own note about staying unlocked stays.)
    assert.ok(!notes.some((n) => /encoder|still images|FFmpeg/i.test(n)), JSON.stringify(notes));
    assert.deepEqual(toasts, []);
    await view.unmount();
  }
  // A Reach that doesn't say: the stream's own format.
  computer.reset();
  computer.video = "";
  const { view, rows } = await connection("darwin", []);
  assert.equal(rows.Video, "H.264");
  await view.unmount();
  await settle();
  assert.deepEqual(dom.errors, []);
});
