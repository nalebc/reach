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
      if (!scopes)
        assert.match(view.container.textContent, /2 conversations need you/);
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
