import test from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Back is one step of Reach's own stack, in the same document (src/nav-history.ts),
// through the real workspace (src/App.tsx). Oct 13: on the iPhone's Home
// Screen app, the edge swipe in a Claude chat showed a blank page and
// reloaded Reach instead of going back to the chat list: the entry behind
// the chat was one of the page before a reload. A step to an entry of
// another document is a navigation, which jsdom reports as "Not implemented"
// in `dom.errors`: every test ends with none.

const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "fixture", platform: "darwin" };
const CODEX = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const session = {
  agent: "codex", id: CODEX, title: "Fix login", cwd: "/work/app", branch: "main", origin: "app", inApp: true,
  updatedAt: Date.now(), createdAt: Date.now(), status: "idle", preview: "", archived: false,
  model: "gpt-6-astra", effort: "medium", mode: "guardian-approvals", held: null,
};
const routes = {
  "/api/device": () => ({
    id: "mac", name: "Mac", platform: "darwin", roots: [], memory: { total: 1, free: 1 },
    network: { connected: true, peers: [] },
    capabilities: { files: true, terminal: true, apps: true, screen: true },
  }),
  "/api/terminals": () => [],
  "/api/terminals/desktop": () => ({ sessions: [] }),
  "/api/terminals/agents": () => ({ agents: [] }),
  "/api/handoffs": () => [],
  "/api/chats": () => [],
  "/api/codex": () => ({ sessions: [] }),
  "/api/activity": () => ({ activities: [] }),
  "/api/sessions": () => ({ sessions: [session], errors: {} }),
  "/api/sessions/health": () => ({ agents: [{ agent: "codex", name: "Codex", installed: true, signedIn: true, usable: true, supported: true }] }),
  "/api/sessions/logos": () => ({ version: "1", logos: {} }),
  "/api/sessions/models": () => ({ models: [], modes: [], mode: null }),
  "/api/sessions/commands": () => ({ commands: [] }),
  [`/api/sessions/codex/${CODEX}`]: () => ({ session, items: [] }),
  [`/api/sessions/codex/${CODEX}/live`]: async () => (await settle(60), { version: 1, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 }),
  "/api/clients": () => ({ current: "me", clients: [] }),
  "/api/browser/agents": () => ({ agents: [], at: Date.now() }),
  "/api/agents/shortcuts": () => ({ shortcuts: [], running: null }),
  "/api/agents/services": () => ({ access: [] }),
};

async function workspace({ url, place, state } = {}) {
  const dom = await startDom({ mobile: true, routes, url });
  const socket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    close() {}
    send() {}
  };
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  localStorage.setItem("reach.devices", JSON.stringify([peer]));
  localStorage.setItem("reach.active", peer.id);
  localStorage.setItem("reach.chatAgent", "codex");
  if (place) sessionStorage.setItem("reach.place", JSON.stringify({ peer: peer.id, ...place }));
  // Two entries of "the page before" (another document on a phone): Back
  // landing on one is the reload the owner saw. jsdom has one document, so
  // each landing is counted instead.
  dom.window.history.replaceState({ oldPage: true }, "");
  dom.window.history.pushState({ oldPage: true }, "");
  dom.window.history.pushState(state ?? null, "");
  let landed = 0;
  dom.window.addEventListener("popstate", () => dom.window.history.state?.oldPage && landed++);
  const { default: App } = await dom.load("/src/App.tsx");
  const view = await dom.render(dom.React.createElement(App));
  const $ = (selector) => dom.document.querySelector(selector);
  const on = (page) => dom.waitFor(() => $(`.main-content.page-${page}`));
  const reach = () => dom.window.history.state?.reach;
  const button = (label) =>
    [...dom.document.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === label || (b.querySelector(".more-row-label, .gs-label")?.textContent || b.textContent).trim() === label,
    );
  // The page shell can precede its navigation controls on a busy runner.
  // Wait for the actual target using the existing DOM readiness budget.
  const click = async (label) => (await dom.waitFor(() => button(label))).click();
  // Nothing went wrong, and Back never left this page.
  const clean = () => {
    assert.deepEqual(dom.errors, []);
    assert.equal(landed, 0, "never back on the page before");
  };
  const close = async () => {
    await view.unmount();
    globalThis.WebSocket = socket;
    await dom.close();
  };
  return { dom, $, on, reach, button, click, clean, close };
}
const card = (dom) => dom.waitFor(() => [...dom.document.querySelectorAll(".chat-card")].find((c) => /Fix login/.test(c.textContent)));

test("a chat, then back: its list, then Home; never a reload", async () => {
  const { dom, $, on, reach, click, clean, close } = await workspace();
  try {
    await on("overview");
    assert.deepEqual(reach(), { page: "overview", i: 0 }, "Home is the first entry");
    await click("Chat");
    await on("sessions");
    assert.deepEqual(reach(), { page: "sessions", i: 1 });
    (await card(dom)).click();
    await dom.waitFor(() => $(".as-page"));
    await settle();
    assert.equal(reach().i, 2, "the open chat is an entry above its list");
    dom.window.history.back();
    await dom.waitFor(() => !$(".as-page"));
    await settle();
    assert.ok($(".main-content.page-sessions"), "back on the chat list");
    assert.deepEqual(reach(), { page: "sessions", i: 1 });
    dom.window.history.back();
    await on("overview");
    assert.deepEqual(reach(), { page: "overview", i: 0 });
    clean();
  } finally {
    await close();
  }
});

test("More, Settings, Agents & people: back twice comes back the same way", async () => {
  const { dom, on, reach, button, click, clean, close } = await workspace();
  try {
    await on("overview");
    await click("More workspace options");
    await dom.waitFor(() => button("Settings"));
    await click("Settings");
    await on("settings");
    assert.deepEqual(reach(), { page: "settings", i: 1 });
    await dom.waitFor(() => button("Agents & people"));
    await click("Agents & people");
    await on("invite");
    assert.deepEqual(reach(), { page: "invite", i: 2 });
    dom.window.history.back();
    await on("settings");
    dom.window.history.back();
    await on("overview");
    assert.deepEqual(reach(), { page: "overview", i: 0 });
    clean();
  } finally {
    await close();
  }
});

// Not quite "tabs only replace": Home stays under the tabs, so the first tab
// opened from Home adds the one entry back to it; after that, tabs replace.
test("Home is under every tab; switching between tabs adds no entry", async () => {
  const { dom, on, reach, button, click, clean, close } = await workspace();
  try {
    await on("overview");
    const start = dom.window.history.length;
    await click("Chat");
    await on("sessions");
    const above = dom.window.history.length;
    assert.equal(above, start + 1, "Home stays under the tab");
    for (const [tab, page] of [["Files", "files"], ["Chat", "sessions"]]) {
      if (tab === "Files") {
        // A page from More, then a tab: the tab takes the place above Home.
        await click("More workspace options");
        await dom.waitFor(() => button("Files"));
        await click("Files");
      } else await click(tab);
      await on(page);
    }
    assert.deepEqual(reach(), { page: "sessions", i: 1 });
    await click("Chat");
    await settle(50);
    assert.deepEqual(reach(), { page: "sessions", i: 1 }, "re-selecting the tab adds nothing");
    dom.window.history.back();
    await on("overview");
    assert.equal(reach().i, 0);
    clean();
  } finally {
    await close();
  }
});

test("with a chat open, the Home tab stays on Home: the chat's entry goes first", async () => {
  const { dom, $, on, reach, click, clean, close } = await workspace();
  try {
    await on("overview");
    await click("Chat");
    (await card(dom)).click();
    await dom.waitFor(() => $(".as-page"));
    await settle();
    await click("Home");
    await on("overview");
    await settle(100);
    assert.ok($(".main-content.page-overview"), "still on Home once the chat's entry is popped");
    assert.deepEqual(reach(), { page: "overview", i: 0 });
    clean();
  } finally {
    await close();
  }
});

// jsdom works out both steps from the same entry, so it lands on Home either
// way; a phone may take the second from Home, past it. App's leaveTo ignores
// a step asked for while one is under way.
test("a double tap on Home with a chat open steps back once, never past Home", async () => {
  const { dom, $, on, reach, button, click, clean, close } = await workspace();
  try {
    await on("overview");
    await click("Chat");
    (await card(dom)).click();
    await dom.waitFor(() => $(".as-page"));
    await settle();
    assert.equal(reach().i, 2);
    const home = await dom.waitFor(() => button("Home"));
    home.click();
    home.click();
    await on("overview");
    await settle(150);
    assert.deepEqual(reach(), { page: "overview", i: 0 });
    clean();
  } finally {
    await close();
  }
});

test("a notification's link straight into a chat: back is its list, then Home", async () => {
  const { dom, $, on, reach, clean, close } = await workspace({ url: `https://reach.test/?page=sessions&agent=codex&id=${CODEX}` });
  try {
    await dom.waitFor(() => $(".as-page"));
    await settle();
    assert.equal(dom.window.location.search, "", "the link is gone from the address");
    assert.equal(reach().i, 2, "Home, then the list, under the chat");
    dom.window.history.back();
    await dom.waitFor(() => !$(".as-page"));
    assert.ok($(".main-content.page-sessions"));
    dom.window.history.back();
    await on("overview");
    clean();
  } finally {
    await close();
  }
});

test("after a reload in a chat (an interface rebuild), the chat has its parent in the new page", async () => {
  // The entry kept the old page's marks; the place says which chat was open.
  const { dom, $, reach, clean, close } = await workspace({
    state: { reach: { page: "sessions", i: 2 }, reachChat: true },
    place: { page: "sessions", chat: { agent: "codex", id: CODEX } },
  });
  try {
    await dom.waitFor(() => $(".as-page"));
    await settle();
    assert.equal(reach().i, 2);
    assert.equal(dom.window.history.state.reachChat, true);
    dom.window.history.back();
    await dom.waitFor(() => !$(".as-page"));
    assert.ok($(".main-content.page-sessions"), "the list, in this page: no reload");
    assert.deepEqual(reach(), { page: "sessions", i: 1 });
    clean();
  } finally {
    await close();
  }
});

test("an interface rebuild reload steps back to the first entry before it replaces it", async () => {
  const dom = await startDom();
  try {
    const nav = await dom.load("/src/nav-history.ts");
    nav.seedBase();
    nav.pushPage("sessions", 0);
    nav.pushInPage({ reachChat: true });
    assert.equal(nav.stackDepth(), 2);
    const reloaded = await new Promise((resolve) => {
      nav.reloadFromBase(() => resolve({ at: nav.stackDepth(), leaving: nav.leavingForReload() }), { wait: 5000 });
    });
    assert.deepEqual(reloaded, { at: 0, leaving: true }, "replaced from Home's entry, views told to stay");
    nav.forgetReload();
    let now = 0;
    nav.reloadFromBase(() => now++);
    assert.equal(now, 1, "at the first entry already: at once");
    assert.deepEqual(dom.errors, []);
  } finally {
    await dom.close();
  }
});
