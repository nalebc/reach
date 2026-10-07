import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The Terminal tab's list: ways to start one, then every terminal grouped by
// where it lives, named as people read them (not raw Mac window titles).
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const tabs = [
  { id: "a1", provider: "terminal", name: "reach — node scripts/bootstrap.mjs — 120×40", tty: "/dev/ttys004" },
  { id: "a2", provider: "terminal", name: "reach — ✳ Fix terminal list — claude — 132×48", tty: "/dev/ttys007" },
  { id: "a3", provider: "iterm2", name: "ssh pi@raspberrypi (ssh)", tty: "/dev/ttys013" },
];
const calls = [];
const closedTabs = [];
// Which Macs were asked for the AI apps' logos (by host).
const logoAsks = [];
let listed = 0;
let slow = 0;
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
        listed++;
        if (slow) await settle(slow);
        return { sessions: tabs, providers: [] };
      },
      "/api/terminals/agents": () => ({ agents: ["claude", "codex"] }),
      "/api/terminals": (init) => {
        calls.push(JSON.parse(init.body || "{}"));
        return { id: "s9", name: "Claude Code", cwd: "/Users/n/reach", status: "running", createdAt: "" };
      },
      "/api/terminals/desktop/a2": () => ({ text: "working…" }),
      "/api/terminals/desktop/a2/close": (init) => {
        closedTabs.push(JSON.parse(init.body));
        return { ok: true };
      },
      "/api/sessions/logos": (init, href) => (logoAsks.push(href.host), {}),
    },
  });
  React = dom.React;
  ({ TerminalView } = await dom.load("/src/Sessions.tsx"));
});
after(async () => dom?.close());

function page(props = {}) {
  const state = { selected: "", source: "mac" };
  return React.createElement(TerminalView, {
    desktopTerminals: true,
    peer,
    sessions: [],
    selected: "",
    onSelect: (id) => (state.selected = id),
    onNew() {},
    onRefresh() {},
    toast() {},
    source: "mac",
    setSource() {},
    onExit() {},
    ...props,
  });
}
const text = (el) => el.textContent.replace(/\s+/g, " ").trim();
const rows = (root) =>
  [...root.querySelectorAll(".terminal-row-main")].map((r) => [
    r.querySelector("strong").textContent,
    r.querySelector("small").textContent,
  ]);

test("the list starts terminals and names Mac windows readably", async () => {
  const view = await dom.render(page());
  const root = view.container;
  await dom.waitFor(() => root.querySelectorAll(".terminal-row").length === 3);
  assert.equal(root.querySelector("h1").textContent, "Terminals");
  assert.deepEqual(
    [...root.querySelectorAll(".terminal-quick button")].map((b) =>
      b.lastChild.textContent.trim(),
    ),
    ["Terminal", "Claude Code", "Codex", "Folder…"],
  );
  assert.deepEqual(rows(root), [
    ["reach", "node scripts/bootstrap.mjs"],
    ["Fix terminal list", "Claude Code · reach"],
    ["ssh pi@raspberrypi", "ssh"],
  ]);
  assert.equal(text(root.querySelector("section h3")), "On your Mac");
  assert.doesNotMatch(text(root), /120×40|A terminal on/);

  // One tap starts Claude Code in a new shell.
  [...root.querySelectorAll(".terminal-quick button")][1].click();
  await dom.waitFor(() => calls.length === 1);
  assert.deepEqual(calls[0], { root: 0, run: "claude" });
  await view.unmount();
});

test("someone invited never asks for the AI apps' logos: those routes are the owner's only", async () => {
  const guest = await dom.render(page({ peer: { ...peer, id: "guest-mac", url: "https://guest.reach.test" } }));
  await dom.waitFor(() => guest.container.querySelectorAll(".terminal-row").length === 3);
  await settle(100);
  assert.deepEqual(logoAsks.filter((host) => host === "guest.reach.test"), []);
  // Line icons stand in for the logos.
  assert.ok(guest.container.querySelector(".terminal-quick button svg"));
  await guest.unmount();
  // The owner's own device does ask.
  const owner = await dom.render(page({ owner: true, peer: { ...peer, id: "owner-mac", url: "https://owner.reach.test" } }));
  await dom.waitFor(() => logoAsks.includes("owner.reach.test"));
  await owner.unmount();
});

test("coming back shows the Mac's windows at once, then checks again", async () => {
  slow = 400;
  const before = listed;
  const view = await dom.render(page());
  // Remembered from the last visit: no "Looking for…" wait.
  assert.equal(view.container.querySelectorAll(".terminal-row").length, 3);
  await dom.waitFor(() => listed > before);
  slow = 0;
  await view.unmount();
});

test("inside a terminal, the title opens the same list over it", async () => {
  const shells = [
    { id: "s1", name: "Terminal 1", cwd: "/Users/n/notes", status: "running", createdAt: "", preview: ["done", "n@mac notes %"] },
    { id: "s2", name: "Terminal 2", cwd: "/Users/n/old", status: "exited", createdAt: "" },
  ];
  const view = await dom.render(page({ sessions: shells, source: "mac:a2" }));
  const root = view.container;
  const title = await dom.waitFor(() => root.querySelector("button.terminal-switch"));
  assert.deepEqual(
    [title.querySelector("span").textContent, title.querySelector("small").textContent],
    ["Fix terminal list", "Claude Code · reach"],
  );
  title.click();
  await settle();
  const sheet = root.querySelector(".terminal-sheet");
  assert.deepEqual(
    [...sheet.querySelectorAll("section h3")].map(text),
    ["From your phone", "On your Mac"],
  );
  // Ended shells stay out of the way; the open terminal is marked.
  assert.deepEqual(rows(sheet)[0], ["Terminal 1", "notes · done"]);
  assert.equal(rows(sheet).length, 4);
  assert.equal(
    sheet.querySelector('[aria-current="true"] strong').textContent,
    "Fix terminal list",
  );
  assert.ok(!root.querySelector(".terminal-quick"), "no start row in the switcher");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("closing the viewed Mac tab requires confirmation and returns to the remaining list", async (t) => {
  const previousConfirm = globalThis.confirm;
  let approved = false;
  const prompts = [];
  globalThis.confirm = (message) => (prompts.push(message), approved);
  t.after(() => { globalThis.confirm = previousConfirm; });
  const view = await dom.render(page({ peer: { ...peer, id: "close-mac" }, source: "mac:a2" }));
  t.after(() => view.unmount());
  const root = view.container;
  const close = await dom.waitFor(() => root.querySelector('[aria-label="Close this tab on your Mac"]'));
  close.click();
  await settle();
  assert.equal(closedTabs.length, 0);
  assert.match(prompts[0], /Anything running in it will stop/);
  assert.match(prompts[0], /runs Reach, you will disconnect/);
  approved = true;
  close.click();
  await dom.waitFor(() => closedTabs.length === 1);
  await dom.waitFor(() => root.querySelectorAll(".terminal-row").length === 2);
  assert.deepEqual(closedTabs, [{ confirm: true }]);
  assert.ok(!root.querySelector('[aria-label="Close this tab on your Mac"]'));
  assert.ok(!rows(root).some(([title]) => title === "Fix terminal list"));
});
