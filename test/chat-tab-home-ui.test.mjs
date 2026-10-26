import test from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

test("Tools returns from nested chats and reopens the selected provider", async () => {
  const peer = {
    id: "mac",
    name: "Mac",
    url: "https://reach.test",
    token: "fixture",
    platform: "darwin",
  };
  const session = {
    key: "agent:main:reach-1234",
    title: "Weekend plans",
    agentId: "main",
    channel: "webchat",
    writable: true,
    updatedAt: Date.now(),
    model: "test",
    status: "idle",
  };
  const base = "/api/sessions/openclaw";
  const dom = await startDom({
    mobile: true,
    routes: {
      "/api/device": () => ({
        id: "mac",
        name: "Mac",
        platform: "darwin",
        roots: [],
        memory: { total: 1, free: 1 },
        network: { connected: true, peers: [] },
        capabilities: { files: true, terminal: true, apps: true, screen: true },
      }),
      "/api/terminals": () => [],
      "/api/codex": () => ({ sessions: [] }),
      "/api/handoffs": () => [],
      "/api/chats": () => [],
      "/api/terminals/desktop": () => ({ sessions: [] }),
      "/api/terminals/agents": () => ({ agents: [] }),
      "/api/activity": () => ({ activities: [] }),
      "/api/sessions": () => ({ sessions: [], errors: {} }),
      "/api/sessions/health": () => ({
        agents: [
          {
            agent: "openclaw",
            name: "OpenClaw",
            installed: true,
            signedIn: true,
            supported: true,
          },
        ],
      }),
      "/api/sessions/logos": () => ({ version: "1", logos: {} }),
      [base + "/overview"]: () => ({
        connected: true,
        sessions: [session],
        approvals: [],
      }),
      [base + "/history"]: () => ({
        session,
        items: [],
        streaming: "",
        error: "",
        approvals: [],
      }),
      [base + "/channels"]: () => ({ channels: [] }),
      [base + "/agents"]: () => ({ supported: true, agents: [] }),
      [base + "/automations"]: () => ({ jobs: [] }),
    },
  });
  const socket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    close() {}
    send() {}
  };
  let view;
  const button = (label) =>
    [...dom.document.querySelectorAll("button")].find(
      (b) =>
        b.getAttribute("aria-label") === label ||
        (b.querySelector("strong")?.textContent || b.textContent).trim() ===
          label,
    );
  const click = async (label) => {
    const b = button(label);
    assert.ok(b, label);
    b.click();
    await settle();
  };
  const openChatFromTools = async () => {
    dom.document.querySelector('.mobile-nav [aria-label="Tools"]').click();
    (await dom.waitFor(() => dom.document.querySelector('.tools-page [aria-label="Chat"]'))).click();
  };
  try {
    localStorage.setItem("reach.devices", JSON.stringify([peer]));
    localStorage.setItem("reach.active", peer.id);
    localStorage.setItem("reach.chatAgent", "openclaw");
    sessionStorage.setItem(
      "reach.place",
      JSON.stringify({ peer: peer.id, page: "sessions" }),
    );
    const { default: App } = await dom.load("/src/App.tsx");
    view = await dom.render(dom.React.createElement(App));
    await dom.waitFor(() => button("Customize"));
    assert.ok(
      dom.document.querySelector(
        ".claw-library .chat-companion .brand-courier",
      ),
    );
    for (const nested of [null, "Agents", "Scheduled", "Weekend plans"]) {
      if (nested === "Scheduled") await click("Scheduled");
      else if (nested === "Weekend plans") await click("Weekend plans");
      else {
        await click("Customize");
        assert.ok(
          dom.document.querySelector(
            '[aria-label="Customize OpenClaw"] .chat-companion .brand-courier',
          ),
        );
        if (nested) await click(nested);
      }
      assert.equal(button("Customize"), undefined);
      const previous = dom.document.querySelector(".claw-conversation, .claw-page");
      const label = previous.getAttribute("aria-label");
      const at = dom.window.history.state.reach.i;
      dom.document.querySelector(".workspace-settings").click();
      await dom.waitFor(() => dom.document.querySelector(".page-settings"));
      dom.document.querySelector(".workspace-back").click();
      await dom.waitFor(() => [...dom.document.querySelectorAll(".claw-conversation, .claw-page")].some(el => el.getAttribute("aria-label") === label));
      await settle();
      assert.equal(dom.window.history.state.reach.i, at, "Settings restores the same nested OpenClaw entry");
      await openChatFromTools();
      await dom.waitFor(() => button("Customize") && button("Weekend plans"));
      assert.equal(
        localStorage.getItem("reach.chatAgent"),
        "openclaw",
        "keeps the chosen provider",
      );
      assert.equal(dom.document.querySelector(".claw-conversation"), null);
      assert.equal(dom.document.querySelector(".claw-page"), null);
    }
    await openChatFromTools();
    await dom.waitFor(() => button("Customize"));
    assert.equal(localStorage.getItem("reach.chatAgent"), "openclaw");
    assert.deepEqual(dom.errors, []);
  } finally {
    await view?.unmount();
    globalThis.WebSocket = socket;
    await dom.close();
  }
});

// A notification's Open request from the Chat tab opens that chat. Before,
// going to Chat while on Chat reset it to its list, dropping the chat the
// notification had just asked for.
test("Open request on a notification opens its chat even when Chat is already open", async () => {
  const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "fixture", platform: "darwin" };
  const session = { key: "agent:main:reach-1234", title: "Weekend plans", agentId: "main", channel: "webchat", writable: true, updatedAt: Date.now(), model: "test", status: "idle" };
  const base = "/api/sessions/openclaw";
  const dom = await startDom({
    mobile: true,
    routes: {
      "/api/device": () => ({ id: "mac", name: "Mac", platform: "darwin", roots: [], memory: { total: 1, free: 1 }, network: { connected: true, peers: [] }, capabilities: { files: true, terminal: true, apps: true, screen: true } }),
      "/api/terminals": () => [],
      "/api/codex": () => ({ sessions: [] }),
      "/api/handoffs": () => [],
      "/api/chats": () => [],
      "/api/terminals/desktop": () => ({ sessions: [] }),
      "/api/terminals/agents": () => ({ agents: [] }),
      "/api/activity": () => ({ activities: [] }),
      "/api/sessions": () => ({ sessions: [], errors: {} }),
      "/api/sessions/health": () => ({ agents: [{ agent: "openclaw", name: "OpenClaw", installed: true, signedIn: true, supported: true }] }),
      "/api/sessions/logos": () => ({ version: "1", logos: {} }),
      "/api/notifications": () => ({
        items: [{ id: "chat:openclaw:1", source: "openclaw", sender: "OpenClaw", icon: "openclaw", kind: "permission", title: "Permission needed", revision: "d".repeat(64), actions: [], target: { page: "sessions", agent: "openclaw", id: session.key } }],
        unavailable: [],
      }),
      [base + "/overview"]: () => ({ connected: true, sessions: [session], approvals: [] }),
      [base + "/history"]: () => ({ session, items: [], streaming: "", error: "", approvals: [] }),
      [base + "/channels"]: () => ({ channels: [] }),
      [base + "/agents"]: () => ({ supported: true, agents: [] }),
      [base + "/automations"]: () => ({ jobs: [] }),
    },
  });
  const socket = globalThis.WebSocket;
  globalThis.WebSocket = class {
    close() {}
    send() {}
  };
  // jsdom has no modal dialogs; the bell's panel opens in one.
  dom.window.HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  let view;
  const button = (label) =>
    [...dom.document.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === label || (b.querySelector("strong")?.textContent || b.textContent).trim() === label,
    );
  try {
    localStorage.setItem("reach.devices", JSON.stringify([peer]));
    localStorage.setItem("reach.active", peer.id);
    localStorage.setItem("reach.chatAgent", "openclaw");
    sessionStorage.setItem("reach.place", JSON.stringify({ peer: peer.id, page: "sessions" }));
    const { default: App } = await dom.load("/src/App.tsx");
    view = await dom.render(dom.React.createElement(App));
    await dom.waitFor(() => button("Customize") && dom.document.querySelector(".notification-count"));
    assert.equal(dom.document.querySelector(".claw-conversation"), null, "on Chat's list");
    dom.document.querySelector(".notification-bell").click();
    await dom.waitFor(() => button("Open request"));
    button("Open request").click();
    await dom.waitFor(() => dom.document.querySelector(".claw-conversation"));
    // A notification opened from Home has Home directly underneath it.
    dom.document.querySelector('.mobile-nav [aria-label="Home"]').click();
    await dom.waitFor(() => dom.document.querySelector(".page-overview"));
    dom.document.querySelector(".notification-bell").click();
    await dom.waitFor(() => button("Open request"));
    button("Open request").click();
    await dom.waitFor(() => dom.document.querySelector(".claw-conversation"));
    await settle();
    assert.equal(dom.window.history.state.reach.i, 1);
    dom.document.querySelector('.claw-conversation [aria-label="Back to previous view"]').click();
    await dom.waitFor(() => dom.document.querySelector(".page-overview"));
    assert.equal(dom.window.history.state.reach.i, 0);
    assert.deepEqual(dom.errors, []);
  } finally {
    await view?.unmount();
    globalThis.WebSocket = socket;
    await dom.close();
  }
});
