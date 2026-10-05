import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// First-time hints on the Terminal tab: a note on how to start a terminal,
// and a hand showing the swipe between terminals. Each shows once.
const peer = {
  id: "mac",
  name: "Mac",
  url: "https://reach.test",
  token: "t",
  platform: "darwin",
};
const tab = (id) => ({
  id,
  provider: "terminal",
  name: `${id} — -zsh — 80×24`,
  tty: `/dev/ttys${id.length}`,
});
let tabs = [];
let dom, React, TerminalView;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "@xterm/xterm": "test/dom/fakes/xterm.mjs",
      "@xterm/addon-fit": "test/dom/fakes/xterm.mjs",
    },
    routes: {
      "/api/terminals/desktop": () => ({ sessions: tabs, providers: [] }),
      "/api/terminals/agents": () => ({ agents: ["codex"] }),
      "/api/terminals": () => ({
        id: "s1",
        name: "Terminal 1",
        cwd: "/x",
        status: "running",
        createdAt: "",
      }),
      // The Mac answers at once, then only when the tab prints (never here).
      "/api/terminals/desktop/a": (init, url) =>
        url.searchParams.get("after") === "0"
          ? { text: "a", version: 1 }
          : new Promise(() => {}),
    },
  });
  React = dom.React;
  ({ TerminalView } = await dom.load("/src/Sessions.tsx"));
});
after(async () => dom?.close());
beforeEach(() => dom.window.localStorage.clear());

const page = (source = "mac", on = peer) =>
  React.createElement(TerminalView, {
    desktopTerminals: on.platform === "darwin",
    peer: on,
    sessions: [],
    selected: "",
    onSelect() {},
    onNew() {},
    onRefresh() {},
    toast() {},
    source,
    setSource() {},
    onExit() {},
    changes: '{"macTerminals":"v1"}',
  });
const touch = (element) => {
  const event = new dom.window.Event("touchstart", { bubbles: true });
  Object.defineProperty(event, "touches", {
    value: [{ clientX: 120, clientY: 300 }],
  });
  element.dispatchEvent(event);
};

test("the first visit explains the start row; tapping the note or starting hides it for good", async () => {
  tabs = [];
  let view = await dom.render(page());
  let hint = await dom.waitFor(() =>
    view.container.querySelector(".terminal-hint"),
  );
  assert.match(hint.textContent, /open a terminal on your Mac/);
  assert.ok(view.container.querySelector(".terminal-quick button.hinted"));
  hint.click();
  await settle();
  assert.equal(view.container.querySelector(".terminal-hint"), null);
  await view.unmount();
  view = await dom.render(page());
  await settle(50);
  assert.equal(
    view.container.querySelector(".terminal-hint"),
    null,
    "only the first time",
  );
  await view.unmount();

  // Starting one counts as having understood it.
  dom.window.localStorage.clear();
  view = await dom.render(page());
  await dom.waitFor(() => view.container.querySelector(".terminal-hint"));
  view.container.querySelector(".terminal-quick button").click();
  await settle();
  assert.equal(
    dom.window.localStorage.getItem("reach.hint.terminal-start"),
    "seen",
  );
  await view.unmount();
});

test("the swipe hand shows once, only with another terminal to go to", async () => {
  // A tap on the list before any terminal is open doesn't use it up.
  tabs = [tab("a"), tab("b")];
  let view = await dom.render(page());
  const stage = await dom.waitFor(() =>
    view.container.querySelector(".terminal-stage"),
  );
  touch(stage);
  await view.unmount();

  // One terminal: nothing to swipe to, so no hand.
  tabs = [tab("a")];
  view = await dom.render(page("mac:a"));
  await dom.waitFor(() =>
    view.container.querySelector("button.terminal-switch"),
  );
  await settle(50);
  assert.equal(view.container.querySelector(".terminal-swipe-hint"), null);
  await view.unmount();

  // Two: the hand shows, and touching the terminal means it's understood.
  tabs = [tab("a"), tab("b")];
  view = await dom.render(page("mac:a"));
  const hint = await dom.waitFor(() =>
    view.container.querySelector(".terminal-swipe-hint"),
  );
  assert.match(hint.textContent, /Swipe to switch terminals/);
  assert.ok(hint.querySelector("svg"), "a hand shows the gesture");
  // It never catches the touch it teaches: the swipe reaches the terminal.
  const css = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/terminals.css", import.meta.url), "utf8"),
  );
  assert.match(css, /\.terminal-swipe-hint \{[^}]*pointer-events: none/);
  touch(view.container.querySelector(".terminal-stage"));
  await settle();
  assert.equal(view.container.querySelector(".terminal-swipe-hint"), null);
  await view.unmount();
  view = await dom.render(page("mac:a"));
  await dom.waitFor(() =>
    view.container.querySelector("button.terminal-switch"),
  );
  await settle(50);
  assert.equal(
    view.container.querySelector(".terminal-swipe-hint"),
    null,
    "only the first time",
  );
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("on a Windows computer the note says computer, not Mac", async () => {
  tabs = [];
  const view = await dom.render(
    page("reach", { ...peer, id: "pc", platform: "win32" }),
  );
  const hint = await dom.waitFor(() =>
    view.container.querySelector(".terminal-hint"),
  );
  assert.match(hint.textContent, /open a terminal on your computer\./);
  await view.unmount();
});
