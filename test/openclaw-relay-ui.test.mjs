import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// An OpenClaw reply handed to Codex or Claude Code (OpenClawRelay.tsx),
// through the real component and the real relay sheets. The computer is a
// stand-in that records what the phone sent.

const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "test-token", platform: "darwin" };
const KEY = "agent:main:whatsapp:direct:+15550001111";
const NEW = "11111111-2222-4333-8444-555555555555";
const LOGO = "data:image/png;base64,iVBORw0KGgo=";
const chat = (agent, id, cwd) => ({
  agent,
  id,
  title: "Chat",
  cwd,
  branch: "",
  origin: "app",
  inApp: false,
  updatedAt: Date.now(),
  createdAt: Date.now(),
  status: "idle",
  preview: "",
  archived: false,
});
const both = [
  { agent: "codex", installed: true, signedIn: true, usable: true },
  { agent: "claude", installed: true, signedIn: true, usable: true },
  { agent: "openclaw", installed: true, signedIn: true, usable: true },
];

const mac = { sent: [], answer: null };
const routes = {
  "/api/sessions": () => ({
    sessions: [chat("codex", "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee", "/Users/me/app"), chat("claude", NEW, "/Users/me/site")],
    errors: {},
  }),
  "/api/device": () => ({ roots: [{ id: 1, name: "Home", path: "/Users/me" }] }),
  "/api/files": () => ({ items: [] }),
  "/api/sessions/relays": (init) => {
    mac.sent.push(JSON.parse(init.body));
    return typeof mac.answer === "function" ? mac.answer() : mac.answer;
  },
};

let dom, React, ClawRelayAction;
before(async () => {
  dom = await startDom({ mobile: true, routes });
  React = dom.React;
  ({ ClawRelayAction } = await dom.load("/src/OpenClawRelay.tsx"));
});
after(() => dom?.close());
beforeEach(() => {
  dom.errors.length = 0;
  mac.sent = [];
  mac.answer = { relay: { id: "r1", state: "sending", steps: [], chain: [], next: 0, sent: [] } };
  dom.window.localStorage.clear();
});
const views = [];
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
});
const $ = (s) => dom.document.querySelector(s);
const $$ = (s) => [...dom.document.querySelectorAll(s)];
const button = (label, within = dom.document) =>
  [...within.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label);
const click = async (el) => {
  assert.ok(el, "button exists");
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  await settle();
};
// Two replies in a transcript, as OpenClawSpace lays them out.
const mount = async ({ health = both, opened = [] } = {}) => {
  const h = React.createElement;
  const reply = (item) =>
    h(
      "article",
      { key: item, className: "claw-message from-agent" },
      h("p", null, `reply ${item}`),
      h(ClawRelayAction, { peer, sessionKey: KEY, title: "WhatsApp", item, health, logos: { codex: LOGO, claude: LOGO }, onOpenChat: (s) => opened.push(s) }),
    );
  const view = await dom.render(h("div", { className: "claw-transcript" }, reply("a1"), reply("a2")));
  views.push(view);
  await settle();
  return view;
};

test("no Codex or Claude Code: no row", async () => {
  await mount({ health: [{ agent: "openclaw", installed: true, signedIn: true, usable: true }] });
  assert.equal($(".claw-relay"), null);
  assert.deepEqual(dom.errors, []);
});

test("the newest reply shows the row with Relay; an older one shows Second opinion and Relay once tapped", async () => {
  await mount();
  const [older, newest] = $$(".claw-relay");
  assert.ok(newest.classList.contains("on"));
  assert.ok(button("Relay", newest));
  assert.ok(!older.classList.contains("on"));
  await click(older.closest("article").querySelector("p"));
  assert.ok(older.classList.contains("on"));
  assert.ok(button("Second opinion", older));
  // An older reply relays from itself (RelaySheet's item).
  assert.ok(button("Relay", older));
  assert.deepEqual(dom.errors, []);
});

test("a second opinion asks for a folder first, remembers it, and opens the new chat", async () => {
  mac.answer = { relay: { id: "r1", state: "sending", steps: [], chain: [], next: 0, sent: [] }, opened: { agent: "codex", id: "0199ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee" } };
  const opened = [];
  await mount({ opened });
  const older = $$(".claw-relay")[0];
  await click(button("Second opinion", older));
  // The folder pills come from the Mac's chats.
  const site = await dom.waitFor(() => button("site", older));
  assert.ok(button("app", older));
  await click(site);
  assert.equal(dom.window.localStorage.getItem("reach-claw-relay-folder:mac"), "/Users/me/site");
  const go = await dom.waitFor(() => $(".relay-go"));
  assert.match(go.textContent, /Ask Codex/);
  await click(go);
  await dom.waitFor(() => opened.length === 1);
  assert.deepEqual(mac.sent, [
    { from: { agent: "openclaw", id: KEY }, steps: [{ kind: "review", agent: "codex" }], now: true, item: "a1", cwd: "/Users/me/site" },
  ]);
  assert.deepEqual([opened[0].agent, opened[0].id, opened[0].cwd], ["codex", "0199ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee", "/Users/me/site"]);
  assert.equal($(".relay-sheet"), null);
  assert.deepEqual(dom.errors, []);
});

test("a remembered folder goes straight to the relay sheet; no chat back says Started", async () => {
  dom.window.localStorage.setItem("reach-claw-relay-folder:mac", "/Users/me/app");
  await mount();
  const newest = $$(".claw-relay")[1];
  assert.ok(button("Folder: /Users/me/app", newest));
  await click(button("Relay", newest));
  const go = await dom.waitFor(() => $(".relay-go"));
  assert.equal($(".claw-relay-folders"), null);
  await click(go);
  await dom.waitFor(() => $(".claw-relay-done"));
  assert.equal($(".claw-relay-done").textContent.trim(), "Started");
  assert.equal(mac.sent.length, 1);
  assert.equal(mac.sent[0].cwd, "/Users/me/app");
  assert.deepEqual(mac.sent[0].from, { agent: "openclaw", id: KEY });
  assert.equal(mac.sent[0].steps[0].kind, "build");
  assert.ok(["codex", "claude"].includes(mac.sent[0].steps[0].agent));
  assert.deepEqual(dom.errors, []);
});

test("an older reply relays from itself, now", async () => {
  dom.window.localStorage.setItem("reach-claw-relay-folder:mac", "/Users/me/app");
  await mount();
  const older = $$(".claw-relay")[0];
  await click(older.closest("article").querySelector("p"));
  await click(button("Relay", older));
  const go = await dom.waitFor(() => $(".relay-go"));
  // No "when": it's that reply, now.
  assert.equal($(".relay-when"), null);
  await click(go);
  await dom.waitFor(() => mac.sent.length === 1);
  assert.equal(mac.sent[0].item, "a1");
  assert.equal(mac.sent[0].now, true);
  assert.deepEqual(dom.errors, []);
});

test("the Mac's error shows in the sheet", async () => {
  dom.window.localStorage.setItem("reach-claw-relay-folder:mac", "/Users/me/app");
  mac.answer = () => new Response(JSON.stringify({ error: "Pick the folder to work in." }), { status: 400, headers: { "Content-Type": "application/json" } });
  await mount();
  await click(button("Second opinion", $$(".claw-relay")[1]));
  await click(await dom.waitFor(() => $(".relay-go")));
  const alert = await dom.waitFor(() => $(".relay-problem"));
  assert.equal(alert.textContent, "Pick the folder to work in.");
  assert.deepEqual(dom.errors, []);
});

test("a WhatsApp chat offers to post the answer back, off until chosen", async () => {
  dom.window.localStorage.setItem("reach-claw-relay-folder:mac", "/Users/me/app");
  await mount();
  await click(button("Second opinion", $$(".claw-relay")[1]));
  await dom.waitFor(() => $(".relay-go"));
  const toggle = [...dom.document.querySelectorAll(".relay-switch")].find((l) => /Post the answer on WhatsApp/.test(l.textContent));
  assert.ok(toggle);
  assert.equal(toggle.querySelector("input").checked, false);
  await click(toggle.querySelector("input"));
  await click($(".relay-go"));
  await dom.waitFor(() => mac.sent.length === 1);
  assert.equal(mac.sent[0].postBack, true);
  assert.deepEqual(dom.errors, []);
});
