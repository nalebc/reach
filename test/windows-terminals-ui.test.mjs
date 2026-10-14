import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// A Windows owner's Terminals page and Home show the PC's own terminals as a
// Mac owner's show Terminal and iTerm2 tabs (workstream T): Windows
// Terminal's tabs and console windows, named readably, "on your Windows PC",
// each called what it is (a Windows Terminal tab, a console window).
const pc = { id: "pc", name: "Desk PC", url: "https://pc.reach.test", token: "t", platform: "win32" };
const tabs = [
  { id: "w1", provider: "windows-terminal", name: "C:\\Program Files\\PowerShell\\7\\pwsh.exe", tty: "100" },
  { id: "w2", provider: "console", name: "Command Prompt - npm  run dev", tty: "200" },
  { id: "w3", provider: "windows-terminal", name: "✳ Fix the list", tty: "300" },
  { id: "w4", provider: "console", name: 'C:\\WINDOWS\\system32\\cmd.exe - "C:\\Users\\me\\AppData\\Roaming\\npm\\codex.cmd"', tty: "400" },
];
const focused = [];
const closed = [];
// Consoles running as administrator the PC reports (it can't show them).
let administrator = 0;
let dom, React, TerminalView, HomeLive, workspaceCapabilities;
before(async () => {
  dom = await startDom({
    mobile: true,
    fakes: {
      "@xterm/xterm": "test/dom/fakes/xterm.mjs",
      "@xterm/addon-fit": "test/dom/fakes/xterm.mjs",
    },
    routes: {
      "/api/terminals/desktop": () => ({
        sessions: tabs,
        providers: [
          { id: "windows-terminal", name: "Windows Terminal", running: true },
          { id: "console", name: "Console window", running: true, ...(administrator ? { administrator } : {}) },
        ],
      }),
      "/api/terminals/agents": () => ({ agents: [] }),
      "/api/terminals/desktop/w1": () => ({ text: "PS C:\\Users\\me> " }),
      "/api/terminals/desktop/w2": () => ({ text: "> npm run dev" }),
      "/api/terminals/desktop/w1/focus": () => (focused.push("w1"), { ok: true, front: false }),
      "/api/terminals/desktop/w2/close": (init) => (closed.push(JSON.parse(init.body)), { ok: true }),
      "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
      "/api/clients": () => ({ current: "me", clients: [] }),
      "/api/browser/agents": () => ({ agents: [], at: Date.now() }),
    },
  });
  React = dom.React;
  ({ TerminalView } = await dom.load("/src/Sessions.tsx"));
  ({ default: HomeLive } = await dom.load("/src/HomeLive.tsx"));
  ({ workspaceCapabilities } = await dom.load("/src/capabilities.ts"));
});
after(async () => dom?.close());

const page = (props = {}) =>
  React.createElement(TerminalView, {
    desktopTerminals: true,
    peer: pc,
    sessions: [],
    selected: "",
    onSelect() {},
    onNew() {},
    onRefresh() {},
    toast() {},
    source: "mac",
    setSource() {},
    onExit() {},
    ...props,
  });
const text = (el) => el.textContent.replace(/\s+/g, " ").trim();
// Labels with backslashes (Windows paths) aren't CSS selectors.
const labelled = (root, test) => [...root.querySelectorAll("[aria-label]")].find((el) => test(el.getAttribute("aria-label")));
const rows = (root) =>
  [...root.querySelectorAll(".terminal-row-main")].map((r) => [
    r.querySelector("strong").textContent,
    r.querySelector("small").textContent,
  ]);

test("a Windows PC's own terminals are offered to its owner, as a Mac's are", () => {
  const device = (platform, scopes = ["admin", "terminal"]) => ({
    platform,
    capabilities: { terminal: true },
    access: { scopes, kind: "device" },
  });
  assert.equal(workspaceCapabilities(device("win32")).desktopTerminals, true);
  assert.equal(workspaceCapabilities(device("darwin")).desktopTerminals, true);
  assert.equal(workspaceCapabilities(device("linux")).desktopTerminals, false);
  assert.equal(workspaceCapabilities(device("win32", ["terminal"])).desktopTerminals, false, "only someone using the PC as its owner");
});

test("the list says Windows PC and names Windows Terminal tabs and console windows readably", async () => {
  const view = await dom.render(page());
  const root = view.container;
  await dom.waitFor(() => root.querySelectorAll(".terminal-row").length === 4);
  assert.equal(text(root.querySelector("section h3")), "On your Windows PC");
  assert.deepEqual(rows(root), [
    ["PowerShell", "Windows Terminal"],
    ["npm run dev", "Console"],
    ["Fix the list", "Windows Terminal"],
    ["Codex", "Console"],
  ]);
  assert.ok(labelled(root, (label) => label === "Close C:\\Program Files\\PowerShell\\7\\pwsh.exe on your Windows PC"));
  assert.doesNotMatch(text(root), /\bMac\b/);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("consoles running as administrator are said once not to be shown, in the PC's words", async (t) => {
  administrator = 2;
  t.after(() => (administrator = 0));
  const view = await dom.render(page({ peer: { ...pc, id: "pc-admin" } }));
  t.after(() => view.unmount());
  const root = view.container;
  await dom.waitFor(() => root.querySelectorAll(".terminal-row").length === 4);
  const notes = [...root.querySelectorAll("section .terminal-list-note")].map(text);
  assert.deepEqual(notes, ["Terminals running as administrator on your Windows PC aren't shown: Windows keeps Reach out of them."]);
});

test("an open PC tab says what it is, and Show on Screen says when Windows kept it behind", async (t) => {
  const toasts = [];
  let screens = 0;
  const view = await dom.render(page({ source: "mac:w1", toast: (m) => toasts.push(m), onOpenScreen: () => screens++ }));
  t.after(() => view.unmount());
  const root = view.container;
  const hint = await dom.waitFor(() => root.querySelector(".terminal-line-hint"));
  assert.equal(hint.textContent, "Type, then Enter sends the line to this Windows Terminal tab.");
  assert.ok(root.querySelector('[aria-label="Close this tab on your Windows PC"]'));
  // From the list: bring it forward, then the screen.
  root.querySelector("button.terminal-switch").click();
  await settle();
  const show = await dom.waitFor(() => labelled(root.querySelector(".terminal-sheet") || root, (label) => label.startsWith("Show C:\\Program Files")));
  show.click();
  await dom.waitFor(() => screens === 1);
  assert.deepEqual(focused, ["w1"]);
  assert.deepEqual(toasts, ["Windows didn't bring it to the front: it's waiting on the taskbar."]);
});

test("closing a console window asks first, in the PC's words", async (t) => {
  const previous = globalThis.confirm;
  const prompts = [];
  globalThis.confirm = (message) => (prompts.push(message), true);
  t.after(() => {
    globalThis.confirm = previous;
  });
  const view = await dom.render(page({ peer: { ...pc, id: "pc-close" }, source: "mac:w2" }));
  t.after(() => view.unmount());
  const root = view.container;
  const hint = await dom.waitFor(() => root.querySelector(".terminal-line-hint"));
  assert.equal(hint.textContent, "Type, then Enter sends the line to this console window.");
  (await dom.waitFor(() => root.querySelector('[aria-label="Close this tab on your Windows PC"]'))).click();
  await dom.waitFor(() => closed.length === 1);
  assert.deepEqual(prompts, ["Close “npm run dev” on your Windows PC? Anything running in it will stop. If this terminal runs Reach, you will disconnect."]);
  assert.deepEqual(closed, [{ confirm: true }]);
});

test("Home shows the PC's tabs with a PC badge, said to be on your Windows PC", async (t) => {
  const view = await dom.render(
    React.createElement(HomeLive, {
      features: { terminal: false, codex: false, screen: false, desktopTerminals: true, shortcuts: false, owner: true, writeFiles: false },
      device: { name: "Desk PC", roots: [], platform: "win32" },
      peer: pc,
      active: "pc",
      connections: { pc: { state: "connected" } },
      connection: "Direct connection",
      terminals: [],
      chats: [],
      pending: [],
      decide() {},
      navigate() {},
      openChat() {},
      openTerminal() {},
      openMacTab() {},
      openAgentSession() {},
      onShortcuts() {},
      refreshSessions() {},
      toast() {},
    }),
  );
  t.after(() => view.unmount());
  const story = await dom.waitFor(() => dom.document.querySelector('.story[aria-label^="Command Prompt - npm  run dev"]'));
  assert.match(story.getAttribute("aria-label"), /, on your Windows PC/);
  assert.equal(story.querySelector(".story-badge").textContent, "PC");
});
