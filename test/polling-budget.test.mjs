import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// The phone asks the Mac as little as it can without showing anything late:
// what the Mac pushes is read the moment it changes, and a page in the
// background asks nothing until it's back.
let dom, React, BrowserAgents, useBrowserApprovals, useAgentAdmissions;
const peer = { id: "mac", name: "My Mac", url: "https://mac.tail.ts.net:8443", token: "owner", platform: "darwin" };
const device = { name: "My Mac", roots: [], capabilities: { screen: true } };
const reply = (body) => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
const views = new Set();
before(async () => {
  dom = await startDom();
  React = dom.React;
  ({ default: BrowserAgents } = await dom.load("/src/BrowserAgents.tsx"));
  ({ useBrowserApprovals } = await dom.load("/src/browser-approvals.tsx"));
  ({ useAgentAdmissions } = await dom.load("/src/agent-admissions.tsx"));
});
afterEach(async () => {
  for (const view of views) await view.unmount();
  views.clear();
  delete dom.document.hidden;
});
after(async () => dom?.close());
const setHidden = async (hidden) => {
  Object.defineProperty(dom.document, "hidden", { configurable: true, value: hidden });
  dom.document.dispatchEvent(new dom.window.Event("visibilitychange"));
  await settle(30);
};
function count() {
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url) => {
    const route = new URL(url).pathname;
    calls.push(route);
    if (route === "/api/browser/agents") return reply({ agents: [], at: Date.now() });
    return reply([]);
  };
  return calls;
}
// Intervals in this window, by delay: what each screen keeps asking.
function intervals() {
  const made = [];
  const real = dom.window.setInterval;
  const realGlobal = globalThis.setInterval;
  const spy = (fn, ms, ...rest) => { made.push(ms); return realGlobal(fn, ms, ...rest); };
  dom.window.setInterval = spy;
  globalThis.setInterval = spy;
  return { made, restore: () => { dom.window.setInterval = real; globalThis.setInterval = realGlobal; } };
}

test("Settings → Agents asks nothing while the page is in the background, and at once when it's back", async () => {
  const calls = count();
  const view = await dom.render(React.createElement(BrowserAgents, { peer, device, toast() {} }));
  views.add(view);
  await dom.waitFor(() => calls.includes("/api/browser/agents"));
  await setHidden(true);
  const hiddenAt = calls.length;
  await settle(3300);
  assert.equal(calls.length, hiddenAt, "no request while hidden");
  await setHidden(false);
  assert.ok(calls.slice(hiddenAt).includes("/api/browser/agents"), "back on screen: read at once");
});

test("approvals and connection requests follow the Mac's signal: read when it changes, else a slow safety look", async () => {
  const calls = count();
  const timers = intervals();
  let setChanges;
  function Probe({ changes: first }) {
    const [changes, set] = React.useState(first);
    setChanges = set;
    useBrowserApprovals(peer, true, changes);
    useAgentAdmissions(peer, true, changes);
    return null;
  }
  try {
    let view = await dom.render(React.createElement(Probe, { changes: undefined }));
    views.add(view);
    assert.deepEqual(timers.made.filter((ms) => ms !== 1000).sort(), [3000, 3000], "no live signal: every 3 s, as before");
    await view.unmount(); views.delete(view);
    timers.made.length = 0;
    const signal = (n) => JSON.stringify({ browserRequests: `r${n}`, agentAdmissions: `a${n}` });
    view = await dom.render(React.createElement(Probe, { changes: signal(1) }));
    views.add(view);
    assert.deepEqual(timers.made.filter((ms) => ms !== 1000).sort(), [60000, 60000], "with the signal: a safety look a minute");
    const before = calls.length;
    dom.update(() => setChanges(signal(2)));
    await settle(40);
    assert.deepEqual(calls.slice(before).sort(), ["/api/agents/admissions", "/api/agents/browser-requests"], "a change is read at once");
  } finally {
    timers.restore();
  }
});

test("stalled approval and connection queues time out and resume polling", async (t) => {
  const polls = [], deadlines = [];
  const realInterval = globalThis.setInterval, realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setInterval", (callback, ms, ...args) => {
    if (ms === 3000) { polls.push(callback); return realInterval(callback, 60000, ...args); }
    return realInterval(callback, ms, ...args);
  });
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms === 35000) deadlines.push(callback);
    return realTimeout(callback, ms, ...args);
  });
  let stalled = true, aborted = 0;
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init) => {
    const route = new URL(url).pathname;
    calls.push(route);
    if (stalled) return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => { aborted++; reject(init.signal.reason); }, { once: true });
    });
    const pending = { clientId: "one", name: "Muse", expiresAt: Date.now() + 60000 };
    return reply(route.endsWith("admissions")
      ? [{ ...pending, requestId: "join-one", verificationCode: "ABCD-1234" }]
      : [{ ...pending, id: "request-one", status: "pending", action: { type: "command", command: "pwd" } }]);
  };
  function Probe() {
    const approvals = useBrowserApprovals(peer, true);
    const admissions = useAgentAdmissions(peer, true);
    return React.createElement("output", null, `${approvals.items.length}:${admissions.items.length}`);
  }
  const view = await dom.render(React.createElement(Probe));
  views.add(view);
  assert.equal(deadlines.length, 2);
  deadlines.forEach(expire => expire());
  await dom.waitFor(() => aborted === 2);
  await settle();
  stalled = false;
  polls.forEach(poll => poll());
  await dom.waitFor(() => view.container.textContent === "1:1");
  assert.equal(calls.filter(route => route.endsWith("admissions")).length, 2);
  assert.equal(calls.filter(route => route.endsWith("browser-requests")).length, 2);
});

test("polling budget tests emit no React warnings", () => assert.deepEqual(dom.errors, []));
