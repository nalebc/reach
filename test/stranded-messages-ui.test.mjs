import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// A message from the phone whose chat was deleted ("In reach project",
// 2026-10-05) waited where nobody could see it. Above the chat list it now
// says so, and goes to another chat or is deleted.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const GONE = "11111111-2222-4333-8444-555555555555";
const OTHER = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const chat = (agent, id, title) => ({
  agent,
  id,
  title,
  cwd: "/work",
  branch: "",
  origin: "app",
  inApp: true,
  updatedAt: Date.now(),
  createdAt: Date.now(),
  status: "idle",
  preview: "",
  archived: false,
});
let dom, React, StrandedMessages;
let waiting = [];
const posts = [];
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions/stranded": () => ({ messages: waiting }),
      "/api/sessions/stranded/m1/send": (init) => (posts.push(["send", JSON.parse(init.body)]), { queued: true }),
      [`/api/sessions/claude/${GONE}/queue/m1/cancel`]: () => (posts.push(["delete"]), { deleted: true }),
    },
  });
  React = dom.React;
  ({ default: StrandedMessages } = await dom.load("/src/StrandedMessages.tsx"));
});
after(() => dom?.close());
beforeEach(() => {
  posts.length = 0;
  waiting = [{ session: GONE, id: "m1", text: "In reach project", images: 0, at: Date.now(), title: "Untitled" }];
});
const $ = (s) => dom.document.querySelector(s);
const $$ = (s) => [...dom.document.querySelectorAll(s)];
const click = async (el) => {
  assert.ok(el, "button exists");
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle();
};
const button = (text) => $$("button").find((b) => b.textContent.trim() === text || b.getAttribute("aria-label") === text);

test("a message whose chat was deleted says so and goes to another chat picked right there", async () => {
  let changed = 0;
  const view = await dom.render(
    React.createElement(StrandedMessages, {
      peer,
      sessions: [chat("codex", OTHER, "Fix login"), chat("gemini", "g1", "Read only")],
      logos: {},
      onChanged: () => changed++,
    }),
  );
  await dom.waitFor(() => $(".stranded"));
  assert.match($(".stranded-text").textContent, /In reach project/);
  assert.match($(".stranded-text small").textContent, /From your phone · its chat was deleted/);
  await click(button("Send to…"));
  // Recent chats it can go to (not Gemini's read-only ones).
  assert.deepEqual($$(".stranded-pick-title").map((s) => s.textContent), ["Fix login"]);
  await click($(".stranded-pick button"));
  await dom.waitFor(() => !$(".stranded"));
  assert.deepEqual(posts, [["send", { agent: "codex", id: OTHER }]]);
  assert.equal(changed, 1);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("it can be deleted instead; nothing shows when nothing waits", async () => {
  const view = await dom.render(React.createElement(StrandedMessages, { peer, sessions: [], logos: {} }));
  await dom.waitFor(() => $(".stranded"));
  await click(button("Delete this message"));
  await dom.waitFor(() => !$(".stranded"));
  assert.deepEqual(posts, [["delete"]]);
  await view.unmount();
  waiting = [];
  const empty = await dom.render(React.createElement(StrandedMessages, { peer, sessions: [], logos: {} }));
  await settle(50);
  assert.equal($(".stranded"), null);
  await empty.unmount();
  assert.deepEqual(dom.errors, []);
});
