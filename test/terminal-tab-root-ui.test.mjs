import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { startDom, settle } from "./dom/harness.mjs";

// The Terminal tab's list is a main page, like Home and Chat: no back arrow,
// and the bottom bar stays. Inside an open terminal (a level deeper) the
// back arrow comes back and the terminal covers the bar. Same on a Mac and
// on a Windows PC.
const tab = (id) => ({
  id,
  provider: "terminal",
  name: `${id} — shell — 80×24`,
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
      "/api/terminals/agents": () => ({ agents: [] }),
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
beforeEach(() => {
  dom.window.localStorage.clear();
  hold = null;
});

const page = (peer, source) =>
  React.createElement(TerminalView, {
    desktopTerminals: true,
    peer,
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
const back = (root) => root.querySelector('button[aria-label="Leave terminal"]');
const atRoot = (root) =>
  root.querySelector(".terminal-page").classList.contains("at-root");

for (const [platform, word] of [
  ["darwin", "Mac"],
  ["win32", "Windows PC"],
]) {
  const peer = {
    name: word,
    url: "https://reach.test",
    token: "t",
    platform,
  };

  test(`${word}: the list has no back arrow and keeps the bottom bar`, async () => {
    tabs = [tab("a")];
    const view = await dom.render(page({ ...peer, id: `${platform}-list` }, "reach"));
    const root = view.container;
    await dom.waitFor(() => root.querySelector(".terminal-row-main"));
    assert.equal(root.querySelector("h1").textContent, "Terminals");
    assert.equal(back(root), null, "no back arrow at the tab's root");
    assert.ok(atRoot(root), "marked as the tab's root, so the bar stays");
    // New terminal is still at hand.
    assert.ok(root.querySelector('button[aria-label="New terminal"]'));

    // Opening a window goes a level deeper: back arrow, bar covered.
    root.querySelector(".terminal-row-main").click();
    await dom.waitFor(() => back(root));
    assert.equal(atRoot(root), false);
    await view.unmount();
  });

  test(`${word}: a window opened from Home shows its back arrow from the first paint`, async () => {
    tabs = [tab("a")];
    let release;
    hold = new Promise((resolve) => (release = resolve));
    // A computer not seen yet: its windows aren't known until it answers.
    const view = await dom.render(page({ ...peer, id: `${platform}-home` }, "mac:a"));
    const root = view.container;
    await settle(30);
    assert.ok(back(root), "the open window's back arrow, not a flash of the list's");
    assert.equal(atRoot(root), false);
    release();
    await dom.waitFor(() => root.querySelector("button.terminal-switch"));
    assert.ok(back(root));
    assert.equal(atRoot(root), false);
    await view.unmount();
  });
}

test("a Mac window opened from Home that's gone by the time the list comes falls back to the root", async () => {
  tabs = [];
  const peer = { id: "gone", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
  const view = await dom.render(page(peer, "mac:a"));
  const root = view.container;
  await dom.waitFor(() => root.querySelector(".terminal-list-note.center"));
  await dom.waitFor(() => atRoot(root));
  assert.equal(back(root), null);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("on phones the bottom bar sits above the list, never above an open terminal", () => {
  const css = fs.readFileSync(new URL("../src/terminals.css", import.meta.url), "utf8");
  const phones = css.indexOf("@media (max-width: 1024px), (pointer: coarse) {");
  const rule = css.indexOf(".app-shell:has(.terminal-page.at-root) .mobile-nav");
  assert.ok(phones >= 0 && rule > phones, "inside the phone layout");
  const [, z] = css.slice(rule).match(/z-index:\s*(\d+)/);
  const [, page] = css.slice(phones).match(/\.terminal-page \{[^}]*z-index:\s*(\d+)/);
  assert.ok(Number(z) > Number(page), "the bar paints over the full-screen list");
  // The last row scrolls clear of the floating bar.
  assert.match(
    css,
    /\.terminal-page\.at-root > \.terminal-stage > \.terminal-list \{[^}]*padding-bottom: calc\(106px/,
  );
});
