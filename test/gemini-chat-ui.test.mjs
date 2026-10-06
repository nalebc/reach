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
  const view = await dom.render(
    React.createElement(EverythingChat, {
      peer,
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
  assert.equal($(".as-page.gemini textarea").getAttribute("placeholder"), "Type your message or @path/to/file");
  assert.match($(".as-scroll").textContent, /Fix the build[\s\S]*Looking at the build\.[\s\S]*Fixed it\./);
  assert.match(dom.document.body.textContent, /Gemini CLI no longer answers personal Google accounts \(Google moved them to Antigravity\)\. Continue this chat in another app\./);
  // The way on: the apps that can take it, right above the box.
  assert.deepEqual(
    $$(".move-offer.usage .move-offer-row strong").map((s) => s.textContent),
    ["Continue in Codex", "Continue in Claude Code"],
  );
  assert.deepEqual(dom.errors, []);
});
