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

async function workspace({ url, place, state, deferDevice = false, platform = "darwin", extraRoutes = {} } = {}) {
  let releaseDevice;
  const deviceReady = new Promise((resolve) => { releaseDevice = resolve; });
  const hostRoutes = { ...routes, "/api/device": () => ({ ...routes["/api/device"](), platform }), ...extraRoutes };
  const fixtureRoutes = deferDevice ? {
    ...hostRoutes,
    "/api/device": async (...args) => {
      await deviceReady;
      return hostRoutes["/api/device"](...args);
    },
  } : hostRoutes;
  const dom = await startDom({ mobile: true, routes: fixtureRoutes, url });
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
      (b) => !b.closest(".sidebar") && (b.getAttribute("aria-label") === label || (b.querySelector(".gs-label")?.textContent || b.textContent).trim() === label),
    );
  // The page shell can precede its navigation controls on a busy runner.
  // Wait for the actual target using the existing DOM readiness budget.
  const click = async (label) => {
    if (label === "Chat" && !button(label)) {
      (await dom.waitFor(() => $('.mobile-nav [aria-label="Tools"]'))).click();
      await on("tools");
    }
    (await dom.waitFor(() => button(label))).click();
  };
  // Nothing went wrong, and Back never left this page.
  const clean = () => {
    assert.deepEqual(dom.errors, []);
    assert.equal(landed, 0, "never back on the page before");
  };
  const close = async () => {
    releaseDevice();
    await view.unmount();
    globalThis.WebSocket = socket;
    await dom.close();
  };
  try {
    if (deferDevice) {
      // The Home shell renders while its device request is still pending. Chat
      // becomes available only once the connected computer's access is known.
      assert.ok($(".main-content.page-overview"));
      assert.equal(button("Chat"), undefined, "the loading shell has no Chat tab yet");
      releaseDevice();
    }
    // Access-dependent tabs arrive after /api/device, later than the initial
    // Home shell. Wait for the actual control these tests use.
    await dom.waitFor(() => $('.workspace-settings'));
    return { dom, $, on, reach, button, click, clean, close };
  } catch (error) {
    await close();
    throw error;
  }
}
const card = (dom) => dom.waitFor(() => [...dom.document.querySelectorAll(".chat-card")].find((c) => /Fix login/.test(c.textContent)));

test("a chat opened from Tools returns through its list and Tools to Home", async () => {
  const { dom, $, on, reach, click, clean, close } = await workspace();
  try {
    await on("overview");
    assert.deepEqual(reach(), { page: "overview", i: 0 }, "Home is the first entry");
    await click("Chat");
    await on("sessions");
    assert.deepEqual(reach(), { page: "sessions", i: 2 });
    (await card(dom)).click();
    await dom.waitFor(() => $(".as-page"));
    await settle();
    assert.equal(reach().i, 3, "the open chat is an entry above its list");
    dom.window.history.back();
    await dom.waitFor(() => !$(".as-page"));
    await settle();
    assert.ok($(".main-content.page-sessions"), "back on the chat list");
    assert.deepEqual(reach(), { page: "sessions", i: 2 });
    dom.window.history.back();
    await on("tools");
    assert.deepEqual(reach(), { page: "tools", i: 1 });
    dom.window.history.back();
    await on("overview");
    assert.deepEqual(reach(), { page: "overview", i: 0 });
    clean();
  } finally {
    await close();
  }
});

test("Settings from the header, then Agents & people: back twice returns Home", async () => {
  const { dom, on, reach, button, click, clean, close } = await workspace();
  try {
    await on("overview");
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
test("Tools and Screen switch directly, and a tool returns to Tools before Home", async () => {
  const { dom, $, on, reach, click, clean, close } = await workspace();
  try {
    const start = dom.window.history.length;
    await click("Tools");
    await on("tools");
    assert.equal(dom.window.history.length, start + 1);
    await click("Files");
    await on("files");
    assert.deepEqual(reach(), { page: "files", i: 2 });
    $('.mobile-nav [aria-label="Screen"]').click();
    await on("screen");
    assert.deepEqual(reach(), { page: "screen", i: 1 });
    $('.mobile-nav [aria-label="Tools"]').click();
    await on("tools");
    assert.deepEqual(reach(), { page: "tools", i: 1 });
    $('.mobile-nav [aria-label="Tools"]').click();
    await settle();
    assert.deepEqual(reach(), { page: "tools", i: 1 });
    dom.window.history.back();
    await on("overview");
    clean();
  } finally { await close(); }
});

test("with a chat open, the Home tab stays on Home: the chat's entry goes first", async () => {
  const { dom, $, on, reach, click, clean, close } = await workspace({ deferDevice: true });
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
    assert.equal(reach().i, 3);
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

test("a notification's link straight into a chat returns to Home without an invented list", async () => {
  const { dom, $, on, reach, clean, close } = await workspace({ url: `https://reach.test/?page=sessions&agent=codex&id=${CODEX}` });
  try {
    await dom.waitFor(() => $(".as-page"));
    await settle();
    assert.equal(dom.window.location.search, "", "the link is gone from the address");
    assert.equal(reach().i, 1, "Home is directly under the linked chat");
    dom.window.history.back();
    await dom.waitFor(() => !$(".as-page"));
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
    assert.equal(reach().i, 1);
    assert.equal(dom.window.history.state.reachChat, true);
    dom.window.history.back();
    await dom.waitFor(() => !$(".as-page"));
    assert.ok($(".main-content.page-overview"), "Home in this document: no old page or invented list");
    assert.deepEqual(reach(), { page: "overview", i: 0 });
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


// Shared touch-client navigation against both supported host contracts.
for (const platform of ["darwin", "win32"]) {
  test(`${platform}: Settings Back follows Home, Tools, Files and Screen, by button or gesture`, async () => {
    const { dom, $, on, reach, click, clean, close } = await workspace({ platform });
    try {
      for (const from of ["overview", "tools", "files", "screen"]) {
        if (from === "files") {
          await click("Tools"); await on("tools"); await click("Files");
        } else await click(from === "overview" ? "Home" : from === "tools" ? "Tools" : "Screen");
        await on(from);
        const before = { ...reach() };
        for (const gesture of [false, true]) {
          $('.workspace-settings').click();
          await on("settings");
          if (gesture) dom.window.history.back();
          else $('.workspace-back').click();
          await on(from);
          assert.deepEqual(reach(), before, "returns to its caller without adding Tools");
        }
      }
      clean();
    } finally { await close(); }
  });

  test(`${platform}: Home's review request returns directly Home; Settings restores the exact chat and draft`, async () => {
    const { dom, $, on, reach, click, clean, close } = await workspace({ platform, extraRoutes: {
      "/api/sessions": () => ({ sessions: [{ ...session, status: "waiting", prompts: [{ id: "review", kind: "question", title: "Review this change" }] }], errors: {} }),
    } });
    try {
      const review = await dom.waitFor(() => $(".home-needs .need-actions button"));
      review.click();
      await dom.waitFor(() => $(".as-page"));
      await settle();
      assert.equal(reach().i, 1, "a direct chat has no unseen list inserted under it");
      const input = await dom.waitFor(() => $('textarea[aria-label="Message"]'));
      dom.update(() => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value").set.call(input, "Keep this draft");
        input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      await settle();
      $('.workspace-settings').click(); await on("settings");
      $('.workspace-back').click();
      await dom.waitFor(() => $(".as-page")); await settle();
      assert.match($(".as-title").textContent, /Fix login/);
      assert.equal($('textarea[aria-label="Message"]').value, "Keep this draft");
      assert.equal(reach().i, 1, "returning does not duplicate the chat entry");
      $('.as-page [aria-label="Back to previous view"]').click();
      await on("overview");
      assert.equal(reach().i, 0);
      // Re-enter by the list instead: both Back controls keep that origin.
      await click("Chat"); (await card(dom)).click();
      await dom.waitFor(() => $(".as-page")); await settle();
      $('.workspace-settings').click(); await on("settings");
      dom.window.history.back(); await dom.waitFor(() => $(".as-page")); await settle();
      assert.equal(reach().i, 3);
      $('.as-page [aria-label="Back to previous view"]').click();
      await dom.waitFor(() => !$(".as-page"));
      assert.deepEqual(reach(), { page: "sessions", i: 2 });
      $('.workspace-back').click(); await on("tools");
      clean();
    } finally { await close(); }
  });
}

test("Back double taps take one step; browser Forward restores the chat", async () => {
  const { dom, $, on, reach, click, clean, close } = await workspace();
  try {
    await click("Chat"); (await card(dom)).click();
    await dom.waitFor(() => $(".as-page")); await settle();
    $('.workspace-settings').click(); await on("settings");
    const back = $('.workspace-back'); back.click(); back.click();
    await dom.waitFor(() => $(".as-page")); await settle();
    assert.equal(reach().i, 3, "one back step from Settings");
    $('.as-page [aria-label="Back to previous view"]').click();
    await dom.waitFor(() => !$(".as-page"));
    dom.window.history.forward();
    await dom.waitFor(() => $(".as-page")); await settle();
    assert.equal(reach().i, 3);
    assert.match($(".as-title").textContent, /Fix login/);
    clean();
  } finally { await close(); }
});


test("Settings preserves the Agents & people sub-page and its parent steps", async () => {
  const { dom, $, on, reach, click, clean, close } = await workspace({ extraRoutes: {
    "/api/agents/shortcuts": () => ({ shortcuts: [{ id: "one", name: "Example", enabled: true, steps: [] }] }),
  } });
  try {
    await click("Settings"); await on("settings");
    await click("Agents & people"); await on("invite");
    (await dom.waitFor(() => [...dom.document.querySelectorAll(".ppl button")].find(b => b.querySelector(".gs-label")?.textContent === "Shortcuts"))).click();
    await dom.waitFor(() => $('[aria-label="Shortcuts"].sub-page'));
    const at = reach().i;
    $('.workspace-settings').click(); await on("settings");
    $('.workspace-back').click();
    await dom.waitFor(() => $('[aria-label="Shortcuts"].sub-page'));
    assert.equal(reach().i, at, "the nested entry survives Settings");
    await click("Back to Agents & people");
    await dom.waitFor(() => !$('.sub-page'));
    assert.equal(reach().i, at - 1);
    $('.workspace-back').click(); await on("settings");
    $('.workspace-back').click(); await on("overview");
    clean();
  } finally { await close(); }
});

test("Screen opened inside a chat returns to that same conversation", async () => {
  const { dom, $, on, reach, click, clean, close } = await workspace({
    url: `https://reach.test/?page=sessions&agent=gemini&id=${CODEX}`,
    extraRoutes: {
      [`/api/sessions/gemini/${CODEX}`]: () => ({ session: { ...session, agent: "gemini" }, items: [] }),
      [`/api/sessions/gemini/${CODEX}/live`]: async () => (await settle(60), { version: 1, status: "idle", prompts: [], items: 0 }),
    },
  });
  try {
    await dom.waitFor(() => $(".as-page"));
    assert.equal(reach().i, 1, "direct linked chat starts above Home");
    await click("Open live screen"); await on("screen");
    assert.equal(reach().i, 2, "the screen is above the chat, not a replacement tab");
    (await dom.waitFor(() => $('.workspace-back'))).click();
    await dom.waitFor(() => $(".as-page"));
    assert.equal(reach().i, 1);
    await dom.waitFor(() => $(".as-title")?.textContent.includes("Fix login"));
    assert.match($(".as-title").textContent, /Fix login/);
    $('.as-page [aria-label="Back to previous view"]').click(); await on("overview");
    clean();
  } finally { await close(); }
});

for (const platform of ["darwin", "win32"]) {
  test(`${platform}: chat and Settings Back preserve the list search and scroll without refocusing`, async () => {
    const { dom, $, click, on, clean, close } = await workspace({ platform });
    try {
      const scroller = dom.document.documentElement;
      Object.defineProperties(scroller, {
        scrollHeight: { configurable: true, value: 2400 },
        clientHeight: { configurable: true, value: 700 },
      });
      await click("Chat");
      await on("sessions");
      await card(dom);
      dom.update(() => $('.chat-list-top button[aria-label="Search chats"]').click());
      const field = $('input[aria-label="Search chats"]');
      dom.update(() => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(field, "login");
        field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
      assert.equal(dom.document.activeElement === field, true, "an explicit search tap opens the keyboard");
      scroller.scrollTop = 380;
      scroller.dispatchEvent(new dom.window.Event("scroll"));
      (await card(dom)).click();
      await dom.waitFor(() => $(".as-page"));
      scroller.scrollTop = 0;
      dom.window.history.back();
      await dom.waitFor(() => !$(".as-page") && $('input[aria-label="Search chats"]'));
      await settle();
      assert.equal($('input[aria-label="Search chats"]').value, "login");
      assert.equal(scroller.scrollTop, 380);
      assert.equal(dom.document.activeElement === $('input[aria-label="Search chats"]'), false);
      await click("Settings");
      await on("settings");
      dom.window.history.back();
      await on("sessions");
      await card(dom);
      assert.equal($('input[aria-label="Search chats"]').value, "login");
      assert.equal(scroller.scrollTop, 380);
      assert.equal(dom.document.activeElement === $('input[aria-label="Search chats"]'), false);
      clean();
    } finally {
      await close();
    }
  });
}
