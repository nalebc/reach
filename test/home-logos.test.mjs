import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

const LOGO = "data:image/png;base64,iVBORw0KGgo=";
const peer = { id: "mac", name: "Mac", url: "https://mac.test", token: "t", platform: "darwin" };
let dom, React, HomeLive;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/logos": () => ({ version: "v1", logos: { codex: LOGO, claude: LOGO, terminal: LOGO } }),
      "/api/terminals/desktop": () => ({
        sessions: [{ id: "t1", provider: "terminal", name: "owner — -zsh — 80×24", tty: "/dev/ttys000" }],
        providers: [],
      }),
    },
  });
  React = dom.React;
  ({ default: HomeLive } = await dom.load("/src/HomeLive.tsx"));
});
after(() => dom?.close());

test("Home's circles are filled by the real app icons, terminals included", async () => {
  const view = await dom.render(
    React.createElement(HomeLive, {
      features: { terminal: false, codex: false, screen: false, desktopTerminals: true, shortcuts: false, owner: false, writeFiles: false },
      device: { name: "Mac", roots: [] },
      peer,
      active: "mac",
      connections: { mac: { state: "connected" } },
      connection: "Direct connection",
      terminals: [],
      chats: [],
      pending: [],
      decide() {},
      navigate() {},
      openChat() {},
      openTerminal() {},
      openMacTab() {},
      agentSessions: [
        { agent: "codex", id: "c1", title: "Fix login", status: "running", live: { where: "codex-app" }, updatedAt: Date.now(), preview: "" },
      ],
      openAgentSession() {},
      onShortcuts() {},
      refreshSessions() {},
      toast() {},
    }),
  );
  const icons = () => [...dom.document.querySelectorAll(".story-ring img.agent-logo")];
  await dom.waitFor(() => icons().length === 2);
  assert.deepEqual(icons().map((i) => i.alt).sort(), ["Codex", "Terminal"]);
  // Sized by the frame (drawn larger and cropped), not a small fixed icon in the middle.
  for (const icon of icons()) {
    assert.ok(icon.classList.contains("fill"), `${icon.alt} fills its circle`);
    assert.equal(icon.getAttribute("style"), null);
  }
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});
