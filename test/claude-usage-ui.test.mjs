import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The native limit message and all recovery controls share one card above
// the composer. The active error is not repeated in the transcript.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const ID = "11111111-2222-4333-8444-555555555555";
const LIMIT = "You've hit your session limit · resets 3:20pm (America/Vancouver)";
const session = {
  agent: "claude",
  id: ID,
  title: "Refactor auth",
  cwd: "/work/app",
  branch: "main",
  origin: "app",
  inApp: true,
  updatedAt: Date.now(),
  createdAt: Date.now(),
  status: "idle",
  preview: "",
  archived: false,
  model: "claude-opus-5-5",
  effort: "max",
  mode: "auto",
  live: { where: "claude-app", pid: 10, tty: null },
};
const page = { session, items: [] };
const live = { version: 1, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 };
let dom, React, AgentSessionView;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      [`/api/sessions/claude/${ID}`]: () => page,
      // The real server holds this request until something changes.
      [`/api/sessions/claude/${ID}/live`]: async () => (await settle(60), live),
      "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
      "/api/sessions/models": () => ({ models: [] }),
      "/api/sessions/commands": () => ({ commands: [] }),
    },
  });
  React = dom.React;
  ({ default: AgentSessionView } = await dom.load("/src/AgentSession.tsx"));
});
after(() => dom?.close());
beforeEach(() => {
  dom.errors.length = 0;
});
const views = [];
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
});
const open = async (health) => {
  const view = await dom.render(
    React.createElement(AgentSessionView, { peer, session, siblings: [], health, logos: {}, onSelect() {}, onBack() {} }),
  );
  views.push(view);
  return view;
};
const outOfUsage = [
  { agent: "codex", installed: true, signedIn: true },
  { agent: "claude", installed: true, signedIn: true, usable: false, resetsAt: Date.parse("2026-10-05T22:20:00Z"), limit: LIMIT },
];
const cards = () => [...dom.document.querySelectorAll(".as-error.claude")];
const strip = () => dom.document.querySelector(".as-composer .usage-strip");
const moreUsage = () => [...dom.document.querySelectorAll("a")].filter((a) => a.getAttribute("href") === "https://claude.ai/settings/usage");

test("Claude out of usage: one card with its native message and usage link", async () => {
  page.items = [{ id: "u1", role: "user", kind: "text", text: "Refactor the auth module", at: Date.now() - 60000 }];
  await open(outOfUsage);
  await dom.waitFor(() => strip());
  assert.equal(strip().querySelector(".usage-strip-text").getAttribute("aria-label"), LIMIT);
  assert.match(strip().querySelector(".usage-strip-text").textContent, /^Resets at 3:20 PM/);
  const more = strip().querySelector('a[href="https://claude.ai/settings/usage"]');
  assert.equal(more.getAttribute("aria-label"), "Get more usage");
  assert.deepEqual(dom.errors, []);
});

test("the current native limit merges into one card with its usage link, notification and continuation actions", async () => {
  page.items = [
    { id: "u1", role: "user", kind: "text", text: "Try again", at: Date.now() - 60000 },
    { id: "e1", role: "system", kind: "error", text: LIMIT, detail: "rate_limit", at: Date.now() - 50000 },
  ];
  await open(outOfUsage);
  await dom.waitFor(() => strip());
  await settle(100);
  assert.equal(cards().length, 0, "the current error is not a second transcript card");
  assert.equal(moreUsage().length, 1, "one way to more usage");
  assert.ok(strip().contains(moreUsage()[0]));
  assert.equal(strip().querySelector(".usage-strip-text").getAttribute("aria-label"), LIMIT);
  assert.match(strip().querySelector(".usage-strip-text").textContent, /^Resets at 3:20 PM/);
  assert.ok(strip().querySelector(".usage-notify"));
  assert.ok(strip().querySelector(".usage-continue"));
  assert.equal(dom.document.querySelectorAll(".usage-panel").length, 1);
  assert.deepEqual(dom.errors, []);
});

test("with usage left, no card", async () => {
  page.items = [{ id: "u1", role: "user", kind: "text", text: "Hi", at: Date.now() }];
  await open([
    { agent: "codex", installed: true, signedIn: true },
    { agent: "claude", installed: true, signedIn: true, usable: true },
  ]);
  await dom.waitFor(() => dom.document.querySelector(".as-composer"));
  await settle(100);
  assert.equal(cards().length, 0);
  assert.equal(strip(), null);
  assert.deepEqual(dom.errors, []);
});

test("a different earlier limit stays in history while the live limit owns the combined card", async t => {
  const current = "You've hit your weekly limit · resets tomorrow at 3pm";
  page.items = [{ id: "e1", role: "system", kind: "error", text: LIMIT, detail: "rate_limit", at: Date.now() - 50000 }];
  live.error = current;
  t.after(() => { live.error = null; });
  await open(outOfUsage);
  await dom.waitFor(() => strip()?.querySelector(".usage-strip-text")?.getAttribute("aria-label") === current);
  assert.equal(cards().length, 1, "an earlier, different error remains in history");
  assert.equal(cards()[0].querySelector("p").textContent, LIMIT);
  assert.equal(dom.document.querySelectorAll(".usage-panel").length, 1);
  assert.deepEqual(dom.errors, []);
});
