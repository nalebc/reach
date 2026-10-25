import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

const LOGO = "data:image/png;base64,iVBORw0KGgo=";
const peer = { id: "mac", name: "Mac", url: "https://mac.test", token: "t", platform: "darwin" };
let dom, React, HomeLive;
let desktopReads = 0;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/logos": () => ({ version: "v1", logos: { codex: LOGO, claude: LOGO, terminal: LOGO } }),
      "/api/terminals/desktop": () => {
        desktopReads++;
        return {
          sessions: [{ id: "t1", provider: "terminal", name: "owner — -zsh — 80×24", tty: "/dev/ttys000" }],
          providers: [],
        };
      },
    },
  });
  React = dom.React;
  ({ default: HomeLive } = await dom.load("/src/HomeLive.tsx"));
});
after(() => dom?.close());

test("Home retains agent icons on requests that need attention", async () => {
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
        { agent: "codex", id: "c1", title: "Fix login", status: "waiting", prompts: [{ id: "review", kind: "question", title: "Review change" }], updatedAt: Date.now(), preview: "" },
      ],
      openAgentSession() {},
      onShortcuts() {},
      refreshSessions() {},
      toast() {},
    }),
  );
  const icons = () => [...dom.document.querySelectorAll(".home-needs .need-icon img.agent-logo")];
  await dom.waitFor(() => icons().length === 1);
  assert.deepEqual(icons().map((i) => i.alt).sort(), ["Codex"]);
  assert.equal(icons()[0].getAttribute("src"), LOGO);
  assert.equal(desktopReads, 0, "Home does not read desktop terminals");
  assert.equal(dom.document.querySelector(".home-terminals"), null);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("Mac requests show their available actions and a noninteractive dialog preview", async () => {
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
  // One strip, a card at a time (swipe for the next), dots for how many: the
  // Mac's dialogs are said, marked to be answered at the Mac, nothing to press.
  const cards = () => [...dom.document.querySelectorAll(".home-needs .need-card")];
  await dom.waitFor(() => cards().length === 3);
  assert.deepEqual(
    cards().map((c) => c.querySelector("strong").textContent),
    [
      "“Claude” wants access to control “Terminal”. Allowing control will provide access to documents and data in “Terminal”.",
      "Your Mac needs authentication",
      "Your Mac is asking about an app",
    ],
  );
  // Answered right here: the dialog's own buttons (its default marked), the
  // password dialog's password; one macOS gave nothing to read: at the Mac.
  assert.deepEqual([...cards()[0].querySelectorAll(".need-actions button")].map((b) => [b.textContent, b.className]), [
    ["Don’t Allow", ""],
    ["Allow", "primary"],
  ]);
  assert.ok(cards()[1].querySelector(".mac-password input[type=password]"));
  assert.equal(cards()[2].querySelector(".need-note").textContent, "Answer on your Mac");
  const dots = [...dom.document.querySelectorAll(".need-dots button")];
  assert.deepEqual(dots.map((d) => d.getAttribute("aria-selected")), ["true", "false", "false"]);
  // A tap shows the Mac's own dialog under the strip, as macOS draws it.
  cards()[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await dom.waitFor(() => dom.document.querySelector(".need-more .mac-dialog"));
  const dialog = dom.document.querySelector(".need-more .mac-dialog");
  assert.equal(
    dialog.querySelector(".mac-dialog-message").textContent,
    "“Claude” wants access to control “Terminal”. Allowing control will provide access to documents and data in “Terminal”.",
  );
  assert.equal(dialog.querySelector(".mac-dialog-info").textContent, "Claude needs this to run your scripts.");
  assert.deepEqual([...dialog.querySelectorAll(".mac-dialog-buttons span")].map((b) => [b.textContent, b.className]), [
    ["Don’t Allow", ""],
    ["Allow", "default"],
  ]);
  assert.equal(dom.document.querySelector(".need-more .mac-dialog button, .need-more a"), null);
  assert.equal(
    dom.document.querySelector(".need-more .mac-prompt-note").textContent,
    "This is a preview of the Mac's dialog. Use the request's actions or open the live screen. Some permissions require approval on the Mac itself.",
  );
  // Tapped again: put away.
  cards()[0].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await dom.waitFor(() => !dom.document.querySelector(".need-more"));
  // The picture-only one shows its picture.
  cards()[2].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await dom.waitFor(() => dom.document.querySelector(".need-more img.mac-prompt-image"));
  assert.equal(dom.document.querySelector(".need-more img.mac-prompt-image").getAttribute("src"), PNG);
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});
