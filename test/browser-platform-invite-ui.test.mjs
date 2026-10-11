import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

let dom, BrowserInvite;
const views = new Set();
before(async () => {
  dom = await startDom();
  ({ default: BrowserInvite } = await dom.load("/src/BrowserInvite.tsx"));
});
afterEach(async () => { for (const view of views) await view.unmount(); views.clear(); });
after(async () => dom?.close());

async function render(platform, support) {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    calls.push([new URL(url).pathname, init.method || "GET"]);
    assert.equal(new URL(url).pathname, "/api/agents/browser-options");
    return new Response(JSON.stringify({ terminals: [], presetApps: [], ...support }), {
      headers: { "Content-Type": "application/json" },
    });
  };
  const peer = { id: "host", name: "Computer", url: "https://host.test", token: "owner", platform };
  const device = { name: "Computer", platform, roots: [{ id: 0, name: "Project", path: "/project" }] };
  const view = await dom.render(dom.React.createElement(BrowserInvite, {
    peer, device, keyPeer: peer, onSetup() {}, onCreated() { assert.fail("Unsupported invitation must not be created"); },
  }));
  views.add(view);
  await dom.waitFor(() => calls.length === 1);
  await settle(30);
  return { container: view.container, calls };
}
// The presets: the one question the invitation asks.
async function presets(container) {
  await settle(30);
  return Object.fromEntries([...container.querySelectorAll('[aria-label="Access preset"] [role="radio"]')].map((b) => [b.getAttribute("aria-label"), b]));
}

for (const platform of ["linux", "win32"]) {
  test(`${platform} explains browser preset limits before inviting, without Mac permission instructions`, async () => {
    const { container, calls } = await render(platform, { protectedFilesSupported: false, desktopAvailable: false });
    const choices = Object.values(await presets(container));
    assert.equal(choices.length, 4);
    assert.ok(choices.every((choice) => choice.disabled));
    assert.match(container.textContent, /Browser invitations currently require macOS/);
    assert.match(container.textContent, /Your own Files and terminals remain available/);
    assert.match(container.textContent, /choose Command line\s+under Connects/);
    assert.doesNotMatch(container.textContent, /Turn on Screen Recording|Screen presets need this Mac/);
    // Tapping any of them (each would make the invite at once) does nothing.
    for (const choice of choices) choice.click();
    await settle();
    assert.equal(calls.length, 1, "unavailable controls never send an invitation request");
  });
}

test("missing Mac screen permissions leave supported file invitations available", async () => {
  const { container } = await render("darwin", { protectedFilesSupported: true, desktopAvailable: false });
  const choices = await presets(container);
  assert.equal(choices.Files.disabled, false);
  for (const label of ["Full control", "Apps", "Read only"])
    assert.equal(choices[label].disabled, true);
  assert.match(container.textContent, /Screen presets need this Mac's Screen Recording and Accessibility/);
  assert.doesNotMatch(container.textContent, /Browser invitations currently require macOS/);
});

test("the server's explicit unsupported file capability overrides a cached Mac device", async () => {
  const { container } = await render("darwin", { protectedFilesSupported: false, desktopAvailable: true });
  const choices = await presets(container);
  assert.equal(choices.Files.disabled, true);
  assert.equal(choices.Apps.disabled, false);
  assert.match(container.textContent, /Browser-agent file access requires macOS/);
});
