import test from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

const peer = { id: "computer", name: "Computer", url: "https://reach.test", token: "grant", platform: "darwin" };
const shell = (id, status = "running") => ({ id, name: id, cwd: "/work", status, createdAt: "2026-10-25T10:00:00Z", preview: ["prompt >"] });
const sockets = [];
class Socket {
  constructor() { sockets.push(this); this.sent = []; }
  send(value) { this.sent.push(JSON.parse(value)); }
  close() {}
  message(type, data) { this.onmessage?.({ data: JSON.stringify({ type, data }) }); }
}
async function fixture(t, routes = {}) {
  const dom = await startDom({ fakes: {
    "@xterm/xterm": "test/dom/fakes/xterm.mjs",
    "@xterm/addon-fit": "test/dom/fakes/xterm.mjs",
  }, routes: {
    "/api/terminals/agents": () => ({ agents: [] }),
    "/api/sessions/logos": () => ({ version: "1", logos: {} }),
    ...routes,
  } });
  const original = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  sockets.length = 0;
  t.after(async () => { await dom.close(); globalThis.WebSocket = original; });
  const { default: HomeTerminals } = await dom.load("/src/HomeTerminals.tsx");
  const cards = (props = {}) => dom.React.createElement(HomeTerminals, {
    peer, sessions: [], tabs: [], peeks: {}, desktopPeeks: {}, now: Date.now(), logos: {}, onOpen() {}, onOpenDesktop() {}, onAll() {}, ...props,
  });
  const $ = s => dom.document.querySelector(s);
  return { dom, cards, $ };
}

for (const platform of ["darwin", "win32"]) {
  for (const native of [false, true]) {
    test(`${platform}: Home resumes the last viewed ${native ? "desktop" : "Reach"} terminal, once, and hides it after closing`, async t => {
      const tab = { id: "native", name: platform === "win32" ? "Command Prompt - npm test" : "project — npm test — 80×24", provider: platform === "win32" ? "console" : "terminal", tty: "test" };
      const { dom, cards, $ } = await fixture(t, {
        "/api/terminals/desktop": () => ({ sessions: [tab], providers: [] }),
        "/api/terminals/desktop/native": () => ({ text: "done" }),
      });
      const { TerminalView } = await dom.load("/src/Sessions.tsx");
      const selectedPeer = { ...peer, platform };
      const sessions = [shell("Build"), shell("Deploy")];
      const terminal = await dom.render(dom.React.createElement(TerminalView, {
        peer: selectedPeer, desktopTerminals: native, sessions,
        selected: "Deploy", source: native ? "mac:native" : "reach",
        onSelect() {}, setSource() {}, onNew() {}, onRefresh() {}, onExit() {}, toast() {},
      }));
      await dom.waitFor(() => $(".terminal-switch"));
      await settle(40);
      await terminal.unmount();
      const opened = [];
      const props = { peer: selectedPeer, sessions, tabs: native ? [tab] : [], onOpen: id => opened.push(`reach:${id}`), onOpenDesktop: id => opened.push(`mac:${id}`) };
      const home = await dom.render(cards(props));
      const resume = await dom.waitFor(() => $('[aria-label^="Resume terminal:"]'));
      assert.match(resume.textContent, /Open/);
      assert.equal(dom.document.querySelectorAll(".home-terminal").length, 1, "quiet unvisited terminals do not crowd Home");
      resume.click();
      assert.deepEqual(opened, [native ? "mac:native" : "reach:Deploy"]);
      assert.equal(sockets.flatMap(s => s.sent).some(m => m.type === "input" || m.type === "data"), false, "opening a terminal sends no command");
      await home.unmount();
      const closed = await dom.render(cards({ ...props, sessions: [sessions[0], shell("Deploy", "exited")], tabs: [] }));
      assert.equal($('[aria-label^="Resume terminal:"]'), null);
      await closed.unmount();
      for (const other of [{ ...selectedPeer, token: "new-grant" }, { ...selectedPeer, id: "another-computer" }]) {
        const changed = await dom.render(cards({ ...props, peer: other }));
        assert.equal($('[aria-label^="Resume terminal:"]'), null, "a different computer or grant has its own history");
        await changed.unmount();
      }
      assert.deepEqual(dom.errors, []);
    });
  }
}

test("Home shows at most three terminals with recent output, one resume card, and no duplicate or closed session", async t => {
  const { dom, cards, $ } = await fixture(t);
  const { useViewState, viewScope } = await dom.load("/src/view-memory.ts");
  let remember;
  function Previous() { [, remember] = useViewState(viewScope(peer, "terminal"), "lastViewed", ""); return null; }
  const seed = await dom.render(dom.React.createElement(Previous));
  dom.update(() => remember("reach:Last used"));
  await seed.unmount();
  const now = Date.now();
  const sessions = [shell("Last used"), ...Array.from({ length: 5 }, (_, i) => shell(`Job ${i}`)), shell("Quiet"), shell("Closed", "exited")];
  const peeks = Object.fromEntries(sessions.filter(s => s.id !== "Quiet").map((s, i) => [s.id, { lines: ["new output"], at: now - i }]));
  let all = 0;
  const view = await dom.render(cards({ sessions, peeks, now, onAll: () => all++ }));
  const labels = [...dom.document.querySelectorAll(".home-terminal")].map(b => b.getAttribute("aria-label"));
  assert.deepEqual(labels, ["Resume terminal: Last used", "Recent output: Job 0", "Recent output: Job 1", "Recent output: Job 2"]);
  assert.match($(".home-terminals h2").textContent, /7 open/);
  assert.doesNotMatch($(".home-terminals").textContent, /Closed|Quiet|working|Running/);
  $('[aria-label="View all terminals"]').click();
  assert.equal(all, 1);
  await view.unmount();
  await dom.render(cards({ sessions, peeks, now: now + 16000 }));
  assert.equal(dom.document.querySelectorAll(".home-terminal").length, 1, "old output is no longer labelled recent");
  assert.deepEqual(dom.errors, []);
});

test("a Reach terminal snapshot is not fresh activity, and a departed grant cannot publish late output", async t => {
  const { dom } = await fixture(t);
  const { useTerminalPeeks } = await dom.load("/src/useTerminalPeeks.ts");
  let peeks, change;
  function Watch() {
    const [computer, set] = dom.React.useState(peer);
    change = set;
    peeks = useTerminalPeeks(computer, [shell("one")]);
    return null;
  }
  await dom.render(dom.React.createElement(Watch));
  const first = sockets.at(-1);
  first.message("snapshot", "old prompt >");
  await dom.waitFor(() => peeks.one);
  assert.equal(peeks.one.at, 0);
  first.message("data", "\nnew output");
  await dom.waitFor(() => peeks.one.at > 0);
  dom.update(() => change({ ...peer, token: "new-grant" }));
  assert.deepEqual(peeks, {});
  first.message("data", "\nlate private output");
  await settle(180);
  assert.deepEqual(peeks, {});
  sockets.at(-1).message("snapshot", "new grant prompt >");
  await dom.waitFor(() => peeks.one);
  assert.equal(peeks.one.at, 0);
  assert.deepEqual(peeks.one.lines, ["new grant prompt >"]);
  assert.deepEqual(dom.errors, []);
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: Home's desktop snapshot stays quiet until its output changes`, async t => {
    let release, read = 0;
    const tab = { id: "desktop", name: "Project", provider: platform === "win32" ? "console" : "terminal", tty: "test" };
    const { dom, $ } = await fixture(t, {
      "/api/terminals/desktop": () => ({ sessions: [tab], providers: [] }),
      "/api/terminals/desktop/activity": async () => {
        if (!read++) return { version: 1, peeks: { desktop: "old prompt >" } };
        if (read === 2) return new Promise(resolve => { release = () => resolve({ version: 2, peeks: { desktop: "new output" } }); });
        return new Promise(() => {});
      },
    });
    const { default: HomeLive } = await dom.load("/src/HomeLive.tsx");
    let change;
    function Home() {
      const [allowed, set] = dom.React.useState(true);
      change = set;
      return dom.React.createElement(HomeLive, {
        peer: { ...peer, platform }, device: { name: "Computer", platform, roots: [] },
        active: peer.id, connections: { [peer.id]: { state: "connected", changes: '{"macTerminals":"v1"}' } },
        features: { terminal: false, desktopTerminals: allowed, screen: false, shortcuts: false, codex: false },
        terminals: [], chats: [], pending: [], decide() {}, navigate() {}, openChat() {}, openTerminal() {}, openMacTab() {}, onShortcuts() {}, refreshSessions() {}, toast() {},
      });
    }
    await dom.render(dom.React.createElement(Home));
    await dom.waitFor(() => release && $(".home-terminals"));
    assert.equal($(".home-terminal"), null);
    release();
    await dom.waitFor(() => $('[aria-label="Recent output: Project"]'));
    assert.match($(".home-terminal").textContent, /new output/);
    dom.update(() => change(false));
    assert.equal($(".home-terminals"), null, "loss of terminal access removes the whole card");
    assert.deepEqual(dom.errors, []);
  });
}

test("View all opens the terminal list directly and records a session only when it is opened", async t => {
  const { dom, cards, $ } = await fixture(t);
  const { useViewState, viewScope } = await dom.load("/src/view-memory.ts");
  let remember;
  function Previous() { [, remember] = useViewState(viewScope(peer, "terminal"), "lastViewed", ""); return null; }
  const previous = await dom.render(dom.React.createElement(Previous));
  dom.update(() => remember("reach:Last used"));
  await previous.unmount();
  const { TerminalView } = await dom.load("/src/Sessions.tsx");
  const sessions = [shell("Default selection"), shell("Last used")];
  function List() {
    const [source, setSource] = dom.React.useState("list");
    const [selected, onSelect] = dom.React.useState("Default selection");
    return dom.React.createElement(TerminalView, { peer, sessions, source, setSource, selected, onSelect, desktopTerminals: false, onNew() {}, onRefresh() {}, onExit() {}, toast() {} });
  }
  let list = await dom.render(dom.React.createElement(List));
  await dom.waitFor(() => $(".terminal-sheet .terminal-row-main"));
  assert.equal(dom.document.querySelectorAll(".terminal-row-main").length, 2);
  await list.unmount();
  const home = await dom.render(cards({ sessions }));
  assert.ok($('[aria-label="Resume terminal: Last used"]'), "browsing the list does not replace the last session");
  await home.unmount();
  list = await dom.render(dom.React.createElement(List));
  const row = await dom.waitFor(() => [...dom.document.querySelectorAll(".terminal-row-main")].find(b => b.textContent.includes("Default selection")));
  dom.update(() => row.click());
  await dom.waitFor(() => !$(".terminal-sheet"));
  await list.unmount();
  await dom.render(cards({ sessions }));
  assert.ok($('[aria-label="Resume terminal: Default selection"]'));
  assert.deepEqual(dom.errors, []);
});
