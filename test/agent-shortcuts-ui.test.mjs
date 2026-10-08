import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";
let dom, AgentShortcuts;
const views = new Set();
const peer = { id: "fixture", name: "Fixture", url: "https://fixture.test", token: "owner-fixture", platform: "darwin" };
const button = (root, name) => [...root.querySelectorAll("button")].find(item => item.textContent.trim() === name);
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
before(async () => {
  dom = await startDom();
  ({ default: AgentShortcuts } = await dom.load("/src/AgentShortcuts.tsx"));
});
afterEach(async () => { for (const view of views) await view.unmount(); views.clear(); });
after(async () => dom?.close());

test("owner stops the displayed replay once and waits for its current action to drain", async (t) => {
  const polls = [], realInterval = globalThis.setInterval;
  t.mock.method(globalThis, "setInterval", (callback, ms, ...args) => {
    if (ms === 3000) { polls.push(callback); return realInterval(callback, 60000, ...args); }
    return realInterval(callback, ms, ...args);
  });
  let running = { runId: "12345678-1234-4321-8123-123456789abc", id: "task", name: "Open sample", completedSteps: 1, totalSteps: 3 };
  let finishCancel;
  const mutations = [], notices = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    const route = new URL(url).pathname;
    if (route === "/api/agents/shortcuts") return reply({ shortcuts: [], recordings: [], running });
    assert.equal(route, "/api/agents/shortcuts/cancel");
    assert.equal(init.method, "POST");
    mutations.push(JSON.parse(init.body));
    return new Promise(resolve => { finishCancel = () => { running = { ...running, cancelled: true }; resolve(reply({ ok: true })); }; });
  };
  const view = await dom.render(dom.React.createElement(AgentShortcuts, { peer, toast: message => notices.push(message) }));
  views.add(view);
  await settle();
  assert.ok(button(view.container, "Stop shortcut"), "active replay must have an owner stop control");
  assert.match(view.container.textContent, /Open sample/);
  assert.match(view.container.textContent, /1.*3/);
  dom.update(() => { button(view.container, "Stop shortcut").click(); button(view.container, "Stop shortcut").click(); });
  await dom.waitFor(() => mutations.length === 1);
  assert.deepEqual(mutations, [{ runId: running.runId }]);
  finishCancel();
  await dom.waitFor(() => /Stop requested/.test(view.container.textContent));
  assert.match(view.container.textContent, /current action/i);
  assert.ok(button(view.container, "Stopping…").disabled);
  assert.ok(!notices.some(message => /shortcut stopped/i.test(message)), "an HTTP acknowledgement is not native termination");
  running = null;
  for (const poll of polls) await poll();
  await dom.waitFor(() => !button(view.container, "Stopping…"));
  assert.equal(mutations.length, 1);
  assert.deepEqual(dom.errors, []);
});

test("failed or stale cancellation stays visible and never cancels a replacement run automatically", async () => {
  let running = { runId: "12345678-1234-4321-8123-123456789abc", id: "task", name: "First run", completedSteps: 0, totalSteps: 2 };
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => {
    if (new URL(url).pathname === "/api/agents/shortcuts") return reply({ shortcuts: [], running });
    calls.push(JSON.parse(init.body));
    running = { ...running, runId: "87654321-1234-4321-8123-123456789abc", name: "Replacement run" };
    return reply({ error: "That shortcut run has already ended." }, 409);
  };
  const view = await dom.render(dom.React.createElement(AgentShortcuts, { peer, toast() {} }));
  views.add(view);
  await settle();
  assert.ok(button(view.container, "Stop shortcut"));
  dom.update(() => button(view.container, "Stop shortcut").click());
  await dom.waitFor(() => /already ended/.test(view.container.textContent));
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].runId, "12345678-1234-4321-8123-123456789abc");
});
