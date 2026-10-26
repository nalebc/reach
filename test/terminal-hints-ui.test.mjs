import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// First-time hints on the Terminal tab: a note on how to start a terminal,
// and a hand showing the swipe between terminals. Each shows once. With
// nothing open the empty note already says it, so the note waits.
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
// Holds the computer's answer to "which windows are open", when set.
let hold = null;
let dom, React, TerminalView;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "@xterm/xterm": "test/dom/fakes/xterm.mjs",
      "@xterm/addon-fit": "test/dom/fakes/xterm.mjs",
    },
    routes: {
      "/api/terminals/desktop": async () => {
        if (hold) await hold;
        return { sessions: tabs, providers: [] };
      },
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

const page = (source = "mac", on = peer, sessions = []) =>
  React.createElement(TerminalView, {
    desktopTerminals: on.platform === "darwin",
    peer: on,
    sessions,
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

test("with nothing open, only the empty note says how to start, said once", async () => {
  tabs = [];
  const view = await dom.render(page());
  const note = await dom.waitFor(() =>
    view.container.querySelector(".terminal-list-note.center"),
  );
  assert.equal(
    note.textContent,
    "Nothing open yet. Start one above; it keeps running on your Mac.",
  );
  assert.equal(view.container.querySelector(".terminal-hint"), null);
  // The start button still glows the first time.
  assert.ok(view.container.querySelector(".terminal-quick button.hinted"));
  await view.unmount();
});

test("while the computer's windows are still being looked for, no note comes and goes", async () => {
  tabs = [];
  let release;
  hold = new Promise((resolve) => (release = resolve));
  const view = await dom.render(page("mac", { ...peer, id: "mac-unlisted" }));
  await settle(30);
  // Before the list answers: no note to take back once the list turns out
  // empty.
  assert.match(view.container.textContent, /Looking for Terminal and iTerm2 windows/);
  assert.equal(view.container.querySelector(".terminal-hint"), null);
  release();
  hold = null;
  await dom.waitFor(() =>
    view.container.querySelector(".terminal-list-note.center"),
  );
  assert.equal(view.container.querySelector(".terminal-hint"), null);
  await view.unmount();
});

test("the first visit explains the start row; tapping the note or starting hides it for good", async () => {
  tabs = [tab("a")];
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

  // Two: the hand shows, and touching the header means it's understood.
  tabs = [tab("a"), tab("b")];
  view = await dom.render(page("mac:a"));
  const hint = await dom.waitFor(() =>
    view.container.querySelector(".terminal-swipe-hint"),
  );
  assert.match(hint.textContent, /Swipe the header to switch terminals/);
  assert.ok(hint.querySelector("svg"), "a hand shows the gesture");
  // It never catches the touch it teaches: the swipe reaches the terminal.
  const css = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/terminals.css", import.meta.url), "utf8"),
  );
  assert.match(css, /\.terminal-swipe-hint \{[^}]*pointer-events: none/);
  touch(view.container.querySelector(".terminal-bar"));
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

test("on a Windows computer the notes say Windows PC, not Mac", async () => {
  tabs = [];
  const pc = { ...peer, id: "pc", platform: "win32" };
  let view = await dom.render(page("reach", pc));
  const note = await dom.waitFor(() =>
    view.container.querySelector(".terminal-list-note.center"),
  );
  assert.equal(
    note.textContent,
    "Nothing open yet. Start one above; it keeps running on your Windows PC.",
  );
  assert.equal(view.container.querySelector(".terminal-hint"), null);
  await view.unmount();
  // A shell already running from the phone: the list has rows, so the note
  // shows instead.
  const shell = {
    id: "s1",
    name: "Terminal 1",
    cwd: "C:\\Users\\n",
    status: "running",
    createdAt: "",
  };
  view = await dom.render(page("reach", pc, [shell]));
  const hint = await dom.waitFor(() =>
    view.container.querySelector(".terminal-hint"),
  );
  assert.match(hint.textContent, /open a terminal on your Windows PC\./);
  await view.unmount();
});
