import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Gemini CLI's chats in Chat: listed beside the others, opened in Gemini's
// own look, read only (Gemini CLI no longer answers personal accounts), with
// the way to continue them in another app.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const ID = "563e04d4-2c16-49ff-97f7-c9f505e5d346";
const geminiChat = {
  agent: "gemini",
  id: ID,
  title: "Fix the build",
  cwd: "/work/app",
  branch: "",
  origin: "cli",
  inApp: false,
  updatedAt: Date.now() - 60000,
  createdAt: Date.now() - 120000,
  status: "idle",
  preview: "Fixed it.",
  archived: false,
  model: "gemini-3-pro",
  effort: null,
  mode: null,
};
const health = [
  { agent: "codex", installed: true, signedIn: true, supported: true },
  { agent: "claude", installed: true, signedIn: true, supported: true },
  { agent: "gemini", name: "Gemini CLI", installed: true, signedIn: true, supported: true },
];
let dom, React, EverythingChat;
before(async () => {
  const live = { version: 0, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 };
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
      "/api/sessions/commands": () => ({ commands: [] }),
      "/api/sessions/models": () => ({ models: [], modes: [], mode: null }),
      [`/api/sessions/gemini/${ID}`]: () => ({
        session: geminiChat,
        items: [
          { id: "m1", role: "user", kind: "text", text: "Fix the build" },
          { id: "m2:text", role: "assistant", kind: "text", text: "Looking at the build." },
          { id: "t1", role: "tool", kind: "command", text: "npm run build", status: "completed" },
          { id: "m3:text", role: "assistant", kind: "text", text: "Fixed it." },
        ],
        before: null,
      }),
      // The real server holds it; an instant answer would spin the poll.
      [`/api/sessions/gemini/${ID}/live`]: async () => (await settle(60), live),
    },
  });
  React = dom.React;
  ({ default: EverythingChat } = await dom.load("/src/EverythingChat.tsx"));
});
after(() => dom?.close());
beforeEach(() => {
  dom.errors.length = 0;
  dom.window.localStorage.setItem("reach.moveHint", "99");
  dom.window.localStorage.setItem("reach.chatAgent", "gemini");
});
const views = [];
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
});
const $ = (s) => dom.document.querySelector(s);
const $$ = (s) => [...dom.document.querySelectorAll(s)];
const click = async (el) => {
  assert.ok(el, "button exists");
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle();
};

test("Gemini CLI's chats are listed with the others, open in Gemini's look, and offer to continue elsewhere", async () => {
  let screens = 0;
  const view = await dom.render(
    React.createElement(EverythingChat, {
      peer,
      onScreen: () => screens++,
      feed: { sessions: [geminiChat], errors: {}, health, failure: "", reload: async () => {}, recheck: () => {} },
    }),
  );
  views.push(view);
  const row = await dom.waitFor(() => $$("button").find((b) => b.getAttribute("aria-label")?.startsWith("Fix the build")));
  assert.match(row.getAttribute("aria-label"), /Gemini CLI/);
  // No new Gemini CLI chats: it no longer answers personal accounts.
  assert.equal($$("button").find((b) => b.textContent.trim() === "New chat"), undefined);
  await click(row);
  await dom.waitFor(() => $(".as-page.gemini"));
  await dom.waitFor(() => $$(".as-assistant").length === 2);
  // Read only, and it looks it: no box to type into (it refused only after Send).
  assert.equal($$(".as-page.gemini textarea").length, 0);
  assert.equal($$("button").filter((b) => b.getAttribute("aria-label") === "Send").length, 0);
  assert.match($(".as-scroll").textContent, /Fix the build[\s\S]*Looking at the build\.[\s\S]*Fixed it\./);
  assert.match(dom.document.body.textContent, /Gemini CLI no longer answers personal Google accounts \(Google moved them to Antigravity\)\. Continue this chat in another app from ⋯\./);
  // The way on: in ⋯ only, the apps that can take it; no card above the box.
  assert.equal($(".move-offer"), null);
  await click($$("button").find((b) => b.getAttribute("aria-label") === "More"));
  assert.deepEqual(
    $$(".as-details .move-item .move-item-text > span").map((s) => s.textContent),
    ["Continue in Codex", "Continue in Claude Code"],
  );
  assert.equal($(".as-prompt"), null, "read-only histories never become actionable approvals");
  await click($$("button").find(b => b.textContent === "Open live screen"));
  assert.equal(screens, 1);
  assert.deepEqual(dom.errors, []);
});

// New chat offered Gemini CLI: you could type and tap Start, then it was refused.
test("New chat says Gemini CLI is read only instead of offering a chat it refuses", async () => {
  dom.window.localStorage.setItem("reach.chatAgent", "codex");
  const view = await dom.render(
    React.createElement(EverythingChat, {
      peer,
      feed: { sessions: [geminiChat], errors: {}, health, failure: "", reload: async () => {}, recheck: () => {} },
    }),
  );
  views.push(view);
  await click(await dom.waitFor(() => $$("button").find((b) => b.textContent.trim() === "New chat")));
  await dom.waitFor(() => $("textarea[aria-label='New Codex chat']"));
  await click($$(".chat-new-app-row button").find((b) => /Gemini CLI/.test(b.textContent + (b.getAttribute("aria-label") || ""))));
  const note = await dom.waitFor(() => $(".chat-coming-soon"));
  assert.match(note.textContent, /Read only/);
  assert.match(note.textContent, /To start a new one, pick another app above\./);
  assert.equal($$("textarea[aria-label='New Gemini CLI chat']").length, 0);
  assert.deepEqual(dom.errors, []);
});

// The list showed Gemini's raw markdown ("**Canonical ID**") and its "›" sign.
test("the list shows a chat's words, not its markdown or a prompt sign", async () => {
  const view = await dom.render(
    React.createElement(EverythingChat, {
      peer,
      feed: {
        sessions: [{ ...geminiChat, title: "› fix the build", preview: "**Canonical ID** is `abc` — see [docs](https://x.test)" }],
        errors: {}, health, failure: "", reload: async () => {}, recheck: () => {},
      },
    }),
  );
  views.push(view);
  const row = await dom.waitFor(() => $(".chat-card-preview"));
  assert.equal(row.textContent, "Canonical ID is abc — see docs");
  assert.ok($$("strong").some((s) => s.textContent === "fix the build"));
  assert.deepEqual(dom.errors, []);
});
