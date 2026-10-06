import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The Chat tab's list after its feed restarts (the peer dropping out and
// coming back, a new pairing): answers to polls sent before the restart are
// dropped, so an old "unchanged" can't leave the tab on "Finding your
// conversations…" with every later poll answered "unchanged" too.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
const chat = (id, title) => ({
  agent: "claude",
  id,
  title,
  cwd: "/work/app",
  branch: "",
  origin: "cli",
  inApp: false,
  updatedAt: Date.now() - 60000,
  createdAt: Date.now() - 120000,
  status: "idle",
  preview: "Fixed it.",
  archived: false,
});
// What each pairing's token sees.
const lists = { t: [chat("c1", "Fix the build")], old: [chat("c0", "Old pairing chat")] };
const health = [
  { agent: "codex", installed: true, signedIn: true, supported: true },
  { agent: "claude", installed: true, signedIn: true, supported: true },
];

// Every /api/sessions request's `known`; `held` keeps the next one waiting.
let asked = [];
let held = null;
let hidden = false;
let dom, React, EverythingChat, useAgentSessions;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      // As the server's `versioned`: { unchanged } when `known` matches.
      "/api/sessions": (init, href) => {
        const token = init.headers.get("Authorization").replace("Bearer ", "");
        const version = `v-${token}`;
        const known = href.searchParams.get("known");
        asked.push(known);
        const answer = known === version
          ? { unchanged: true, version }
          : { sessions: lists[token], errors: {}, version };
        if (!held) return answer;
        return new Promise((resolve) => (held.release = () => resolve(answer)));
      },
      "/api/sessions/health": () => ({ agents: health }),
      "/api/sessions/logos": () => ({ version: "v1", logos: {} }),
      "/api/sessions/commands": () => ({ commands: [] }),
      "/api/sessions/models": () => ({ models: [], modes: [], mode: null }),
    },
  });
  React = dom.React;
  ({ default: EverythingChat } = await dom.load("/src/EverythingChat.tsx"));
  ({ useAgentSessions } = await dom.load("/src/agent-sessions.ts"));
  Object.defineProperty(dom.document, "hidden", { configurable: true, get: () => hidden });
});
after(() => {
  delete dom?.document.hidden;
  return dom?.close();
});
beforeEach(() => {
  dom.errors.length = 0;
  dom.window.localStorage.setItem("reach.moveHint", "99");
  dom.window.localStorage.setItem("reach.chatAgent", "claude");
  asked = [];
  held = null;
  hidden = false;
});
const views = [];
afterEach(async () => {
  for (const view of views.splice(0)) await view.unmount();
});

const $$ = (s) => [...dom.document.querySelectorAll(s)];
const row = (title) => $$("button").find((b) => b.getAttribute("aria-label")?.startsWith(title));
const finding = () => /Finding your conversations/.test(dom.document.body.textContent);
const visible = async (yes) => {
  hidden = !yes;
  dom.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await settle();
};
// As App.tsx does: one feed for the app, its peer null while not usable.
// A long interval: loads come from visibility changes, in a known order.
let setFeedPeer;
function App({ first }) {
  const [feedPeer, set] = React.useState(first);
  setFeedPeer = (p) => dom.update(() => set(p));
  const feed = useAgentSessions(feedPeer, 600000);
  return React.createElement(EverythingChat, { peer, feed });
}

test("a stale 'unchanged' answer after the feed restarts doesn't leave the chat list stuck", async () => {
  views.push(await dom.render(React.createElement(App, { first: peer })));
  await dom.waitFor(() => row("Fix the build"));
  assert.deepEqual(asked, [null]);

  // A poll for the version held goes out and takes its time…
  held = {};
  await visible(true);
  assert.deepEqual(asked, [null, "v-t"]);
  const stale = held;
  held = null;
  // …meanwhile the page is hidden and the feed restarts (the peer drops
  // out and comes back), so no fresh load goes out yet.
  await visible(false);
  setFeedPeer(null);
  await settle();
  setFeedPeer(peer);
  await settle();
  assert.ok(finding(), "the restarted feed starts from nothing");
  assert.deepEqual(asked, [null, "v-t"]);

  // The old poll comes back "unchanged", after the restart.
  stale.release();
  await settle();

  // Back on the page: the list comes, asked for whole since the restart.
  await visible(true);
  await dom.waitFor(() => row("Fix the build"), 2000);
  assert.ok(!finding());
  assert.ok(asked.slice(2).includes(null), `asked for the whole list again: ${JSON.stringify(asked)}`);
  assert.deepEqual(dom.errors, []);
});

test("an answer sent before the feed restarted isn't shown after it", async () => {
  // The first load, under an old pairing, takes its time…
  held = {};
  views.push(await dom.render(React.createElement(App, { first: { ...peer, token: "old" } })));
  const stale = held;
  held = null;
  // …and Reach is paired again meanwhile, while the page is hidden.
  await visible(false);
  setFeedPeer(peer);
  await settle();
  stale.release();
  await settle();
  assert.ok(!row("Old pairing chat"), "the old pairing's list isn't shown");
  assert.ok(finding());

  await visible(true);
  await dom.waitFor(() => row("Fix the build"), 2000);
  assert.ok(!row("Old pairing chat"));
  assert.deepEqual(dom.errors, []);
});
