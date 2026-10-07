import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// Tag in on the phone: an agent handed you a live app. The card says who,
// in which app and what to do; Open goes to that app, Done hands it back,
// Stop tells the agent to stop. The list follows the computer's live
// fingerprint, never a timer.
let dom, React, handoffs, NeedsYouStrip;
before(async () => {
  dom = await startDom({ mobile: true });
  React = dom.React;
  handoffs = await dom.load("/src/handoffs.tsx");
  ({ NeedsYouStrip } = await dom.load("/src/NeedsYou.tsx"));
});
after(async () => dom?.close());

const peer = {
  id: "a",
  name: "Mac A",
  url: "https://reach.test:8443",
  token: "T",
  platform: "darwin",
};
const HANDOFF = {
  id: "h1",
  threadId: "t1",
  agent: "Claude",
  app: "Google Chrome",
  appId: "/Applications/Google Chrome.app",
  reason: "Type the sign-in code from your texts.",
  createdAt: "2026-10-05T10:00:00Z",
};
function computer(list = [HANDOFF]) {
  const log = [];
  const reply = (v) =>
    new Response(JSON.stringify(v), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || "GET";
    log.push([
      method,
      u.pathname,
      init.body ? JSON.parse(init.body) : undefined,
    ]);
    if (u.pathname === "/api/handoffs") return reply(list);
    if (u.pathname.startsWith("/api/handoffs/"))
      return reply({ handoff: "h1", state: "back" });
    return reply({});
  };
  return log;
}
const button = (c, text) =>
  [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const click = (el) =>
  el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));

function Card({ changes, onOpen, onEnded }) {
  const [list, setList] = handoffs.useHandoffs(peer, true, changes);
  const items = handoffs.handoffNeeds({
    peer,
    handoffs: list,
    logos: {},
    open: onOpen,
    ended: (h) => {
      setList((l) => l.filter((x) => x.id !== h.id));
      onEnded?.(h);
    },
  });
  return React.createElement(NeedsYouStrip, { items });
}

test("the card says who needs you, where and for what; Open goes to that app", async () => {
  const log = computer();
  const opened = [];
  const view = await dom.render(
    React.createElement(Card, {
      changes: JSON.stringify({ handoffs: "f1" }),
      onOpen: (h) => {
        handoffs.requestOpenThread("a", h.threadId);
        opened.push(h.id);
      },
    }),
  );
  await settle(60);
  const c = view.container;
  assert.match(c.textContent, /Claude needs you in Google Chrome/);
  assert.match(c.textContent, /Type the sign-in code from your texts\./);
  assert.deepEqual(
    [...c.querySelectorAll(".need-actions button")].map((b) => b.textContent),
    ["Stop", "Done", "Open"],
  );
  click(button(c, "Open"));
  await settle();
  assert.deepEqual(opened, ["h1"]);
  // The Apps page takes the request once.
  assert.equal(handoffs.takeOpenRequest("a"), "t1");
  assert.equal(handoffs.takeOpenRequest("a"), null);
  assert.deepEqual(
    log,
    [["GET", "/api/handoffs", undefined]],
    "Open sends nothing to the agent",
  );
  assert.deepEqual(dom.errors, []);
  await view.unmount();
});

test("Done hands the app back; Stop tells the agent to stop", async () => {
  for (const [label, stop] of [
    ["Done", false],
    ["Stop", true],
  ]) {
    const log = computer();
    const ended = [];
    const view = await dom.render(
      React.createElement(Card, {
        changes: JSON.stringify({ handoffs: "f1" }),
        onOpen: () => {},
        onEnded: (h) => ended.push(h.id),
      }),
    );
    await settle(60);
    click(button(view.container, label));
    await settle(60);
    assert.deepEqual(
      log.slice(1),
      [["POST", "/api/handoffs/h1", { stop }]],
      label,
    );
    assert.deepEqual(ended, ["h1"]);
    assert.equal(
      view.container.querySelectorAll(".need-card").length,
      0,
      `${label}: the card goes`,
    );
    await view.unmount();
  }
  assert.deepEqual(dom.errors, []);
});

test("the list is fetched when the computer's fingerprint moves, and not without one", async () => {
  const log = computer([]);
  let set;
  function Live() {
    const [changes, setChanges] = React.useState(JSON.stringify({ apps: "x" }));
    set = setChanges;
    return React.createElement(Card, { changes, onOpen: () => {} });
  }
  const view = await dom.render(React.createElement(Live));
  await settle(40);
  assert.deepEqual(log, [], "an older computer without hand-offs isn't asked");
  const fetches = () => log.filter(([, p]) => p === "/api/handoffs").length;
  set(JSON.stringify({ apps: "x", handoffs: "f1" }));
  await settle(40);
  assert.equal(fetches(), 1);
  // Another list moved, not this one: no fetch.
  set(JSON.stringify({ apps: "y", handoffs: "f1" }));
  await settle(40);
  assert.equal(fetches(), 1);
  set(JSON.stringify({ apps: "y", handoffs: "f2" }));
  await settle(40);
  assert.equal(fetches(), 2);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});
