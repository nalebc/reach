import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The phone's back gesture after a reload, through the real Chat screen
// (src/EverythingChat.tsx). A reload keeps the history entry's state: still
// marked a chat's, the first chat opened pushed no entry of its own and
// Back reloaded the page instead of closing it.

const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "test-token", platform: "darwin" };
const CODEX = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const session = {
  agent: "codex", id: CODEX, title: "Fix login", cwd: "/work/app", branch: "main", origin: "app", inApp: true,
  updatedAt: Date.now(), createdAt: Date.now(), status: "idle", preview: "", archived: false,
  model: "gpt-6-astra", effort: "medium", mode: "guardian-approvals", held: null,
};
const routes = {
  "/api/sessions/models": () => ({ models: [], modes: [], mode: null }),
  "/api/sessions/health": () => ({ agents: [] }),
  "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
  "/api/sessions/commands": () => ({ commands: [] }),
  "/api/sessions": () => ({ sessions: [], errors: {} }),
  [`/api/sessions/codex/${CODEX}`]: () => ({ session, items: [] }),
  [`/api/sessions/codex/${CODEX}/live`]: async () => (await settle(60), { version: 1, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 }),
};

let dom, EverythingChat;
before(async () => {
  dom = await startDom({ mobile: true, routes });
  // Reloaded while a chat was open: the entry still says so.
  dom.window.history.replaceState({ reachChat: true }, "");
  ({ default: EverythingChat } = await dom.load("/src/EverythingChat.tsx"));
});
after(() => dom?.close());

test("after a reload, the phone's back gesture closes the first chat opened instead of leaving Reach", async () => {
  const { window, document } = dom;
  const $ = (selector) => document.querySelector(selector);
  window.localStorage.setItem("reach.chatAgent", "codex");
  const health = [{ agent: "codex", installed: true, signedIn: true, usable: true }];
  const view = await dom.render(dom.React.createElement(EverythingChat, {
    peer,
    feed: { sessions: [session], errors: {}, health, failure: "", relays: [], reload: async () => {}, recheck: () => {} },
  }));
  const entries = window.history.length;
  const card = await dom.waitFor(() => [...document.querySelectorAll(".chat-card")].find((c) => /Fix login/.test(c.textContent)));
  card.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  await dom.waitFor(() => $(".as-page"));
  await settle();
  assert.equal(window.history.length, entries + 1, "the open chat is an entry of its own");
  assert.equal(window.history.state?.reachChat, true);
  window.history.back();
  await dom.waitFor(() => !$(".as-page"));
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
