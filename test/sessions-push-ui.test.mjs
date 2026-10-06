import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// "Don't pull" (2026-10-06): the phone asked for the whole chat list every
// 4 s. When the Mac's live connection carries the list's revision, the phone
// reads the list when it changes, with only a slow safety look; a Mac that
// doesn't send it is asked every few seconds, as before.
const peer = { id: "mac", name: "Mac", url: "https://reach.test", token: "t", platform: "darwin" };
let dom, React, useAgentSessions;
let reads = 0;
const asked = [];
// Reads that fail as if the Mac were out of reach.
let unreachable = 0;
before(async () => {
  dom = await startDom({
    mobile: true,
    routes: {
      "/api/sessions": (init, href) => {
        reads++;
        asked.push(href.searchParams.get("fresh"));
        if (unreachable > 0 && unreachable--) throw new TypeError("Load failed");
        return { sessions: [], errors: {}, version: `v${reads}` };
      },
      "/api/sessions/health": () => ({ agents: [] }),
    },
  });
  React = dom.React;
  ({ useAgentSessions } = await dom.load("/src/agent-sessions.ts"));
});
after(() => dom?.close());

let setRevision;
function Probe({ first, everyMs }) {
  const [revision, set] = React.useState(first);
  setRevision = (r) => dom.update(() => set(r));
  const feed = useAgentSessions(peer, everyMs, revision);
  return React.createElement("p", null, feed.sessions ? "listed" : "finding");
}

test("with the Mac telling the list's revision, the phone reads it when it changes, not on a beat", async () => {
  reads = 0;
  const view = await dom.render(React.createElement(Probe, { first: "1", everyMs: 50 }));
  await dom.waitFor(() => /listed/.test(dom.document.body.textContent));
  const first = reads;
  // Many beats of the old 50 ms poll: no reads.
  await settle(300);
  assert.equal(reads, first, "not asked on a beat");
  // The revision changes: one read.
  setRevision("2");
  await dom.waitFor(() => reads === first + 1);
  await settle(100);
  assert.equal(reads, first + 1);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("a Mac that doesn't tell is asked every few seconds, as before", async () => {
  reads = 0;
  const view = await dom.render(React.createElement(Probe, { first: undefined, everyMs: 50 }));
  await dom.waitFor(() => reads >= 3, 2000);
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

test("Refresh asks the Mac to build the list anew; the phone's own looks take the one it keeps", async () => {
  let feed;
  function Feed() {
    feed = useAgentSessions(peer, 60000, "1");
    return React.createElement("p", null, feed.sessions ? "listed" : "finding");
  }
  asked.length = 0;
  const view = await dom.render(React.createElement(Feed));
  await dom.waitFor(() => /listed/.test(dom.document.body.textContent));
  assert.deepEqual(asked, [null]);
  await dom.update(() => feed.reload());
  await dom.waitFor(() => asked.length === 2);
  assert.equal(asked[1], "1");
  await view.unmount();
  assert.deepEqual(dom.errors, []);
});

// "Chat sometimes shows can't reach your Mac" (2026-10-06): one read failed
// (the phone waking, Reach restarting) and the message stayed up until the
// next look, now a minute away. It's tried again soon, and said only if the
// Mac stays out of reach.
test("a read that fails for a moment is tried again by itself and never says the Mac is out of reach", async () => {
  const shown = [];
  let setRev;
  function Feed() {
    const [revision, set] = React.useState("1");
    setRev = (r) => dom.update(() => set(r));
    const feed = useAgentSessions(peer, 60000, revision);
    if (feed.failure) shown.push(feed.failure);
    return React.createElement("p", null, feed.sessions ? "listed" : "finding");
  }
  unreachable = 0;
  const view = await dom.render(React.createElement(Feed));
  await dom.waitFor(() => /listed/.test(dom.document.body.textContent));
  const before = reads;
  unreachable = 1;
  setRev("2");
  await dom.waitFor(() => reads === before + 2, 3000);
  await settle(50);
  assert.deepEqual(shown, [], "nothing said for a moment's blip");
  // Out of reach for longer: said, and cleared once it answers again.
  unreachable = 3;
  setRev("3");
  await dom.waitFor(() => shown.length > 0, 4000);
  assert.match(shown.at(-1), /Couldn.t reach/);
  await view.unmount();
  unreachable = 0;
  assert.deepEqual(dom.errors, []);
});
