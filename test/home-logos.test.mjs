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

test("what macOS itself asks shows under Needs you as the Mac's, with its picture, and nothing to press", async () => {
  const PNG = "data:image/png;base64,iVBORw0KGgo=";
  const view = await dom.render(
    React.createElement(HomeLive, {
      features: { terminal: false, codex: false, screen: false, desktopTerminals: false, shortcuts: false, owner: false, writeFiles: false },
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
      agentSessions: [],
      macPrompts: [
        {
          id: "166",
          kind: "privacy",
          title: "“Claude” wants access to control “Terminal”.",
          detail: "Allowing control will provide access to documents and data in “Terminal”. Claude needs this to run your scripts.",
          app: "Claude",
          buttons: ["Don’t Allow", "Allow"],
          lines: [
            "“Claude” wants access to control “Terminal”. Allowing control will provide access to documents and data in “Terminal”.",
            "Claude needs this to run your scripts.",
          ],
          default: "Allow",
          image: PNG,
        },
        { id: "9", kind: "password", title: "Your Mac is asking for your password", detail: "", app: null },
        // macOS showed no text: its picture is the dialog.
        { id: "12", kind: "security", title: "Your Mac is asking about an app", detail: "", app: null, buttons: [], lines: [], image: PNG },
      ],
      openAgentSession() {},
      onShortcuts() {},
      refreshSessions() {},
      toast() {},
    }),
  );
  const cards = () => [...dom.document.querySelectorAll(".home-needs .mac-prompt")];
  await dom.waitFor(() => cards().length === 3);
  const [privacy, password, pictured] = cards();
  assert.equal(privacy.querySelector("header strong").textContent, "Your Mac is asking");
  // Drawn as macOS draws the dialog: its message in bold, the rest, its buttons (the default one marked).
  const dialog = privacy.querySelector(".mac-dialog");
  assert.equal(
    dialog.querySelector(".mac-dialog-message").textContent,
    "“Claude” wants access to control “Terminal”. Allowing control will provide access to documents and data in “Terminal”.",
  );
  assert.equal(dialog.querySelector(".mac-dialog-info").textContent, "Claude needs this to run your scripts.");
  assert.deepEqual([...dialog.querySelectorAll(".mac-dialog-buttons span")].map((b) => [b.textContent, b.className]), [
    ["Don’t Allow", ""],
    ["Allow", "default"],
  ]);
  assert.equal(privacy.querySelector("img.mac-prompt-image"), null, "drawn, not pictured");
  assert.equal(privacy.querySelector(".mac-prompt-note").textContent, "Answer it on your Mac.");
  // Answered at the Mac: nothing to press, on any.
  assert.equal(dom.document.querySelector(".mac-prompt button, .mac-prompt a"), null);
  assert.equal(password.querySelector("img.mac-prompt-image"), null);
  assert.equal(password.querySelector(".mac-dialog-message").textContent, "Your Mac is asking for your password");
  assert.equal(password.querySelector(".mac-dialog-buttons"), null);
  assert.equal(pictured.querySelector("img.mac-prompt-image").getAttribute("src"), PNG);
  assert.equal(pictured.querySelector(".mac-dialog"), null);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});
