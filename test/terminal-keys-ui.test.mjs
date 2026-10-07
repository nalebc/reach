import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startDom, settle } from "./dom/harness.mjs";

// The terminal's key row (esc, tab, ctrl, arrows, Return) on a phone: with
// the keyboard closed it stays clear of the iPhone's home indicator, where
// Safari takes taps for its own toolbar; with the keyboard open it sits right
// on the keyboard.
const peer = {
  id: "mac",
  name: "Mac",
  url: "https://reach.test",
  token: "t",
  platform: "darwin",
};
const tabs = [
  {
    id: "a1",
    provider: "terminal",
    name: "reach — -zsh — 80×24",
    tty: "/dev/ttys004",
  },
];
let dom, React, TerminalView, viewport;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "@xterm/xterm": "test/dom/fakes/xterm.mjs",
      "@xterm/addon-fit": "test/dom/fakes/xterm.mjs",
    },
    routes: {
      "/api/terminals/desktop": () => ({ sessions: tabs, providers: [] }),
      "/api/terminals/agents": () => ({ agents: [] }),
      "/api/terminals/desktop/a1": (init, url) =>
        url.searchParams.get("after") === "0"
          ? { text: "$ ", version: 1 }
          : new Promise(() => {}),
    },
  });
  // A phone screen whose keyboard we can open and close.
  viewport = new dom.window.EventTarget();
  Object.assign(viewport, {
    height: 812,
    width: 375,
    offsetTop: 0,
    offsetLeft: 0,
  });
  Object.defineProperty(dom.window, "innerHeight", {
    value: 812,
    configurable: true,
  });
  dom.window.visualViewport = viewport;
  globalThis.visualViewport = viewport;
  React = dom.React;
  ({ TerminalView } = await dom.load("/src/Sessions.tsx"));
});
after(async () => dom?.close());

test("the key row clears the home indicator, and hugs the keyboard when it's open", async () => {
  const view = await dom.render(
    React.createElement(TerminalView, {
      desktopTerminals: true,
      peer,
      sessions: [],
      selected: "",
      onSelect() {},
      onNew() {},
      onRefresh() {},
      toast() {},
      source: "mac:a1",
      setSource() {},
      onExit() {},
      changes: '{"macTerminals":"v1"}',
    }),
  );
  const page = view.container.querySelector(".terminal-page");
  await dom.waitFor(() => view.container.querySelector(".terminal-key-row"));
  assert.equal(page.classList.contains("kb-open"), false, "keyboard closed");
  viewport.height = 470;
  viewport.dispatchEvent(new dom.window.Event("resize"));
  await settle();
  assert.equal(page.classList.contains("kb-open"), true, "keyboard open");
  viewport.height = 812;
  viewport.dispatchEvent(new dom.window.Event("resize"));
  await settle();
  assert.equal(page.classList.contains("kb-open"), false);
  // The rule that keeps the keys above the home indicator.
  const css = fs.readFileSync(
    new URL("../src/terminals.css", import.meta.url),
    "utf8",
  );
  assert.match(
    css,
    /\.terminal-page:not\(\.kb-open\) \.terminal-key-row \{[^}]*env\(safe-area-inset-bottom\)/,
  );
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
