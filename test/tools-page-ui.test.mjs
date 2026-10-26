import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";
let dom, ToolsPage, PinnedTools, usePinnedTools, workspaceCapabilities;
before(async () => {
  dom = await startDom({ mobile: true });
  ({
    default: ToolsPage,
    PinnedTools,
    usePinnedTools,
  } = await dom.load("/src/ToolsPage.tsx"));
  ({ workspaceCapabilities } = await dom.load("/src/capabilities.ts"));
});
after(async () => dom?.close());
const features = (platform, scopes) =>
  workspaceCapabilities({
    platform,
    capabilities: { files: true, terminal: true, screen: true },
    ...(scopes && { access: { kind: "guest", scopes } }),
  });
test("Tools works for Mac and Windows, with chat as an optional destination and access enforced", async () => {
  for (const platform of ["darwin", "win32"]) {
    for (const [scopes, expected] of [
      [undefined, ["Files", "Terminal", "Chat", "Agents & people"]],
      [["files:read"], ["Files"]],
      [["terminal"], ["Terminal"]],
      [["screen"], []],
    ]) {
      const calls = [];
      const view = await dom.render(
        dom.React.createElement(ToolsPage, {
          features: features(platform, scopes),
          pinned: [],
          onTogglePin: () => {},
          onNavigate: (id) => calls.push(id),
          waiting: 2,
        }),
      );
      assert.equal(view.container.querySelector("dialog"), null);
      const links = [...view.container.querySelectorAll(".tool-open")];
      assert.deepEqual(
        links.map((b) => b.getAttribute("aria-label")),
        expected,
      );
      for (const link of links) link.click();
      assert.equal(calls.length, expected.length);
      if (!scopes) {
        assert.match(view.container.textContent, /2 conversations need you/);
        view.container.querySelector(".tools-invite").click();
        assert.equal(calls.at(-1), "invite:new");
      } else assert.equal(view.container.querySelector(".tools-invite"), null);
      if (!expected.length)
        assert.match(view.container.textContent, /No additional tools/);
      await view.unmount();
    }
  }
});
test("pinning gives inline feedback, persists on Home, and never bypasses another computer's access", async () => {
  localStorage.removeItem("reach.pinnedTools");
  const calls = [];
  function Workspace({ scopes }) {
    const { pinned, toggle } = usePinnedTools();
    const props = {
      features: features("win32", scopes),
      pinned,
      onNavigate: (id) => calls.push(id),
    };
    return dom.React.createElement(
      dom.React.Fragment,
      null,
      dom.React.createElement(ToolsPage, { ...props, onTogglePin: toggle }),
      dom.React.createElement(PinnedTools, props),
    );
  }
  let view = await dom.render(dom.React.createElement(Workspace));
  view.container.querySelector('[aria-label="Pin Terminal to Home"]').click();
  await settle();
  assert.match(
    view.container.querySelector('[role="status"]').textContent,
    /Terminal pinned to Home/,
  );
  assert.equal(
    view.container
      .querySelector('[aria-label="Unpin Terminal from Home"]')
      .getAttribute("aria-pressed"),
    "true",
  );
  view.container.querySelector(".home-pinned button").click();
  assert.deepEqual(calls, ["terminal"]);
  await view.unmount();
  view = await dom.render(
    dom.React.createElement(Workspace, { scopes: ["files:read"] }),
  );
  assert.equal(view.container.querySelector(".home-pinned"), null);
  await view.unmount();
  view = await dom.render(dom.React.createElement(Workspace));
  assert.match(
    view.container.querySelector(".home-pinned").textContent,
    /Terminal/,
  );
  view.container
    .querySelector('[aria-label="Unpin Terminal from Home"]')
    .click();
  await settle();
  assert.equal(view.container.querySelector(".home-pinned"), null);
  assert.deepEqual(JSON.parse(localStorage.getItem("reach.pinnedTools")), []);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("Home shortcuts can be added, removed and reordered; hidden permissions keep their saved place", async () => {
  localStorage.setItem("reach.pinnedTools", JSON.stringify(["sessions", "terminal", "files", "sessions", "invalid"]));
  function Home({ scopes }) {
    const { pinned, toggle, move } = usePinnedTools();
    return dom.React.createElement(PinnedTools, { features: features("win32", scopes), pinned,
      onNavigate() {}, onTogglePin: toggle, onMove: move });
  }
  const names = () => [...dom.document.querySelectorAll(".shortcut-open span")].map(el => el.textContent);
  let view = await dom.render(dom.React.createElement(Home, { scopes: ["files:read", "terminal"] }));
  assert.deepEqual(names(), ["Terminal", "Files"]);
  view.container.querySelector('[aria-label="Edit shortcuts"]').click();
  await settle();
  assert.equal(view.container.querySelector('[aria-label="Move Terminal earlier"]').disabled, true);
  assert.equal(view.container.querySelector('[aria-label="Move Files later"]').disabled, true);
  view.container.querySelector('[aria-label="Move Files earlier"]').click();
  await settle();
  assert.deepEqual(JSON.parse(localStorage.getItem("reach.pinnedTools")), ["sessions", "files", "terminal"]);
  assert.match(view.container.querySelector('[role="status"]').textContent, /Files moved earlier/);
  assert.doesNotMatch(view.container.textContent, /Chat/);
  await view.unmount();
  view = await dom.render(dom.React.createElement(Home));
  assert.deepEqual(names(), ["Chat", "Files", "Terminal"], "saved order survives remount and a different grant");
  view.container.querySelector('[aria-label="Edit shortcuts"]').click();
  await settle();
  view.container.querySelector('[aria-label="Remove Terminal from Shortcuts"]').click();
  await settle();
  view.container.querySelector('[aria-label="Add Terminal to Shortcuts"]').click();
  await settle();
  view.container.querySelector('[aria-label="Done editing shortcuts"]').click();
  await settle();
  assert.deepEqual(names(), ["Chat", "Files", "Terminal"]);
  await view.unmount();
  localStorage.removeItem("reach.pinnedTools");
  view = await dom.render(dom.React.createElement(Home));
  assert.deepEqual(names(), [], "no tools are automatically pinned");
  view.container.querySelector(".shortcuts-add").click();
  await settle();
  assert.ok(view.container.querySelector('[aria-label="Add Chat to Shortcuts"]'));
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
