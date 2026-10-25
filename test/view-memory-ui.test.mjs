import test from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

const peer = { id: "computer", name: "Computer", url: "https://reach.test", token: "grant", platform: "darwin" };
function type(dom, field, value) {
  dom.update(() => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(field, value);
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
}
function viewport(dom) {
  const element = dom.document.documentElement;
  let height = 2400;
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => height },
    clientHeight: { configurable: true, value: 700 },
  });
  return {
    element,
    height: (value) => { height = value; },
    scroll: (value) => { element.scrollTop = value; element.dispatchEvent(new dom.window.Event("scroll")); },
  };
}

test("view memory separates providers, computers and grants, and survives a verified handoff", async () => {
  const dom = await startDom();
  try {
    const { useViewState, viewScope } = await dom.load("/src/view-memory.ts");
    let change, set, value;
    function Fixture() {
      const [target, update] = dom.React.useState({ peer, app: "codex" });
      change = update;
      [value, set] = useViewState(viewScope(target.peer, target.app), "search", "");
      return dom.React.createElement("span", null, value);
    }
    let view = await dom.render(dom.React.createElement(Fixture));
    dom.update(() => set("my project"));
    dom.update(() => change({ peer, app: "claude" }));
    assert.equal(value, "");
    dom.update(() => set("other search"));
    dom.update(() => change({ peer, app: "codex" }));
    assert.equal(value, "my project");
    for (const next of [{ ...peer, id: "another" }, { ...peer, token: "new-grant" }]) {
      dom.update(() => change({ peer: next, app: "codex" }));
      assert.equal(value, "");
    }
    dom.update(() => change({ peer: { ...peer, url: "https://private.test", workspaceKey: JSON.stringify([peer.id, peer.url, peer.token, peer.transport, peer.sessionId]) }, app: "codex" }));
    assert.equal(value, "my project");
    await view.unmount();
    view = await dom.render(dom.React.createElement(Fixture));
    assert.equal(value, "my project", "returning after unmount restores the view");
    assert.equal(dom.window.localStorage.length, 0);
    assert.equal(dom.window.sessionStorage.length, 0);
    assert.deepEqual(dom.errors, []);
  } finally { await dom.close(); }
});

test("scroll waits for data, ignores swipe previews, and yields to new user scrolling", async () => {
  const dom = await startDom();
  try {
    const { useViewScroll } = await dom.load("/src/view-memory.ts");
    const v = viewport(dom);
    let change;
    function Fixture() {
      const [state, set] = dom.React.useState({ screen: "list", ready: true, preview: false });
      change = (next) => set((old) => ({ ...old, ...next }));
      const scroll = useViewScroll(state.screen, true, state.ready);
      const preview = useViewScroll("neighbor", state.preview);
      return dom.React.createElement("div", null,
        dom.React.createElement("div", { ref: scroll }),
        dom.React.createElement("div", { ref: preview }));
    }
    await dom.render(dom.React.createElement(Fixture));
    v.scroll(600);
    dom.update(() => change({ screen: "settings" }));
    assert.equal(v.element.scrollTop, 0);
    v.height(700);
    dom.update(() => change({ screen: "list", ready: false }));
    assert.equal(v.element.scrollTop, 0);
    v.height(2400);
    dom.update(() => change({ ready: true }));
    assert.equal(v.element.scrollTop, 600, "data can arrive after the first layout");
    dom.update(() => change({ preview: true }));
    assert.equal(v.element.scrollTop, 0, "the neighbor restores only when promoted");
    dom.update(() => change({ preview: false, screen: "settings" }));
    v.height(700);
    dom.update(() => change({ screen: "list", ready: false }));
    dom.document.dispatchEvent(new dom.window.Event("touchstart", { bubbles: true }));
    v.scroll(90);
    v.height(2400);
    dom.update(() => change({ ready: true }));
    assert.equal(v.element.scrollTop, 90, "late content must not undo a new gesture");
    assert.deepEqual(dom.errors, []);
  } finally { await dom.close(); }
});

test("chat libraries restore searches and expanded folders independently without opening the keyboard", async () => {
  const dom = await startDom();
  try {
    const { default: ChatList } = await dom.load("/src/ChatList.tsx");
    const sessions = ["codex", "claude"].flatMap((agent) => Array.from({ length: 8 }, (_, i) => ({ agent, id: `${agent}-${i}`, title: `${agent} task ${i}`, cwd: "/work", updatedAt: Date.now() - i, status: "idle" })));
    let change;
    function Fixture() {
      const [agent, set] = dom.React.useState("codex");
      change = set;
      return dom.React.createElement(ChatList, { key: agent, peer, agent, sessions, logos: {}, onOpen() {}, onNew() {} });
    }
    await dom.render(dom.React.createElement(Fixture));
    const $ = (s) => dom.document.querySelector(s);
    dom.update(() => $('.chat-list-top button[aria-label="Search chats"]').click());
    type(dom, $('input[aria-label="Search chats"]'), "task");
    dom.update(() => $(".chat-list-more").click());
    assert.equal(dom.document.querySelectorAll(".chat-card").length, 8);
    dom.update(() => change("claude"));
    assert.equal($('input[aria-label="Search chats"]').value, "");
    dom.update(() => change("codex"));
    assert.equal($('input[aria-label="Search chats"]').value, "task");
    assert.equal(dom.document.querySelectorAll(".chat-card").length, 8);
    assert.equal(dom.document.activeElement === $('input[aria-label="Search chats"]'), false);
    assert.deepEqual(dom.errors, []);
  } finally { await dom.close(); }
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: Files keeps search, hidden preference and expanded long lists when returning`, async () => {
    const queries = [];
    const items = Array.from({ length: 180 }, (_, i) => ({ name: `project-${String(i).padStart(3, "0")}.txt`, path: `project-${i}.txt`, type: "file", size: 10, modified: Date.now() }));
    const dom = await startDom({ routes: { "/api/files": (_init, url) => { queries.push(url.searchParams.get("hidden")); return { items }; } } });
    try {
      const { default: Files } = await dom.load("/src/Files.tsx");
      const device = { id: peer.id, name: peer.name, platform, roots: [{ id: 0, name: "Work", path: "/work" }], capabilities: { files: true }, memory: {}, network: {} };
      const props = { peer: { ...peer, platform }, device, toast() {}, onNavigate() {} };
      const $ = (s) => dom.document.querySelector(s);
      const count = () => dom.document.querySelectorAll(".file-tile, .file-item:not(.is-skeleton)").length;
      let view = await dom.render(dom.React.createElement(Files, props));
      await dom.waitFor(() => count() === 150);
      dom.update(() => $('[aria-label="Search this folder"]').click());
      type(dom, $(".files-search input"), "project");
      await settle();
      dom.update(() => [...dom.document.querySelectorAll("button")].find((b) => /Show 30 more/.test(b.textContent)).click());
      await dom.waitFor(() => count() === 180);
      await view.unmount();
      view = await dom.render(dom.React.createElement(Files, props));
      await dom.waitFor(() => count() === 180);
      assert.equal($(".files-search input").value, "project");
      assert.equal(dom.document.activeElement === $(".files-search input"), false);
      dom.update(() => $('[aria-label="Folder options"]').click());
      const hidden = [...dom.document.querySelectorAll("label")].find((l) => /Show hidden files/.test(l.textContent)).querySelector("input");
      dom.update(() => hidden.click());
      await dom.waitFor(() => queries.includes("1"));
      await view.unmount();
      view = await dom.render(dom.React.createElement(Files, props));
      await dom.waitFor(() => count() > 0);
      assert.equal(queries.at(-1), "1");
      assert.equal($(".files-search input").value, "project");
      assert.deepEqual(dom.errors, []);
    } finally { await dom.close(); }
  });
}

for (const app of ["all", "openclaw"]) {
  test(`${app} restores its search when remounted as a swipe preview without moving or focusing it`, async () => {
    const dom = await startDom({ routes: {
      "/api/sessions/openclaw/overview": () => ({ connected: true, sessions: [{ key: "agent:main:one", title: "Weekend plan", channel: "webchat", agentId: "main", updatedAt: Date.now() }], approvals: [] }),
      "/api/sessions/activity": () => ({ chats: [], overlaps: [] }),
      "/api/sessions/search": () => ({ results: [], partial: false }),
    } });
    try {
      const file = app === "all" ? "ChatHub" : "OpenClawSpace";
      const { default: Component } = await dom.load(`/src/${file}.tsx`);
      const props = { peer, apps: [{ agent: app, name: app, supported: true }], logos: {}, sessions: [], relays: [], pending: 0, appPending: {}, onAgentChange() {}, onAppChange() {}, onOpen() {}, onReviewDevice() {} };
      const v = viewport(dom);
      const $ = (s) => dom.document.querySelector(s);
      let view = await dom.render(dom.React.createElement(Component, props));
      await dom.waitFor(() => $('.chat-list-top button[aria-label="Search chats"]'));
      dom.update(() => $('.chat-list-top button[aria-label="Search chats"]').click());
      type(dom, $('input[type="search"]'), "Weekend");
      v.scroll(350);
      await view.unmount();
      v.scroll(110);
      view = await dom.render(dom.React.createElement(Component, { ...props, active: false }));
      await dom.waitFor(() => $('input[type="search"]'));
      assert.equal($('input[type="search"]').value, "Weekend");
      assert.equal(dom.document.activeElement === $('input[type="search"]'), false);
      assert.equal(v.element.scrollTop, 110);
      await view.unmount();
      await dom.render(dom.React.createElement(Component, props));
      await dom.waitFor(() => v.element.scrollTop === 350);
      assert.deepEqual(dom.errors, []);
    } finally { await dom.close(); }
  });
}
