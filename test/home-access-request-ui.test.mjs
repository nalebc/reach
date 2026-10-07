import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";

// An agent asking for access, on Home's "Needs you" card: what it would get
// is there before Allow, with a warning when it could act as you.
const peer = {
  id: "mac",
  name: "Mac",
  url: "https://mac.test",
  token: "t",
  platform: "darwin",
};
let dom, React, HomeLive, words;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: { "/api/sessions/logos": () => ({ version: "v1", logos: {} }) },
  });
  React = dom.React;
  ({ default: HomeLive } = await dom.load("/src/HomeLive.tsx"));
  words = await dom.load("/src/scope-words.ts");
});
after(() => dom?.close());

const home = (pending) =>
  React.createElement(HomeLive, {
    features: {
      terminal: false,
      codex: false,
      screen: false,
      desktopTerminals: false,
      shortcuts: false,
      owner: true,
      writeFiles: false,
    },
    device: { name: "Mac", roots: [] },
    peer,
    active: "mac",
    connections: { mac: { state: "connected" } },
    connection: "Direct connection",
    terminals: [],
    chats: [],
    pending,
    decide() {},
    navigate() {},
    openChat() {},
    openTerminal() {},
    openMacTab() {},
    onShortcuts() {},
    refreshSessions() {},
    toast() {},
  });

test("an agent asking to use apps says so, with a warning, before Allow", async () => {
  const view = await dom.render(
    home([
      {
        id: "r1",
        name: "Helper",
        scopes: ["device", "apps:drive"],
        createdAt: "2026-10-05T10:00:00Z",
      },
      {
        id: "r2",
        name: "Reader",
        scopes: ["device", "files:read"],
        createdAt: "2026-10-05T10:00:00Z",
      },
    ]),
  );
  const cards = () => [...dom.document.querySelectorAll(".need-card")];
  await dom.waitFor(() => cards().length === 2);
  assert.deepEqual(
    cards().map((c) => [
      c.querySelector("strong").textContent,
      c.querySelector("small")?.textContent,
    ]),
    [
      [
        "Helper wants access to Mac",
        "Use apps. It can act as you on this computer.",
      ],
      ["Reader wants access to Mac", "Read files"],
    ],
  );
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("access in words: commands, terminals, screen and apps can act as you", () => {
  assert.equal(
    words.requestWords(["device", "files:read", "files:write"]),
    "Read files · Write files",
  );
  for (const s of ["exec", "terminal", "screen", "apps:drive"])
    assert.match(
      words.requestWords(["device", s]),
      /It can act as you on this computer\.$/,
      s,
    );
  assert.equal(words.scopeLabel("apps:drive"), "Use apps");
  assert.equal(words.scopeLabel("unknown"), "unknown");
});
