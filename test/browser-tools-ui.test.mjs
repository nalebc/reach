import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";
let dom, installBrowserTools;
const peer = { id: "mac", name: "Mac", url: "https://mac.tail.ts.net", token: "private-token", platform: "darwin" };
const access = { name: "Mac", expiresAt: Date.now() + 3600000, roots: [{ index: 0, name: "Project", path: "/shared" }], terminals: [], screen: "off", restrictedTerminal: true };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
before(async () => {
  dom = await startDom();
  ({ installBrowserTools } = await dom.load("/src/browser-tools.ts"));
});
after(async () => dom?.close());
afterEach(() => { delete dom.window.reach; });

test("bridge validates current access, exposes no credentials and invalidates captured references on replacement/end", async () => {
  let current = access;
  const calls = [];
  globalThis.fetch = dom.window.fetch = async (url, init = {}) => { calls.push([url, init]); return reply(new URL(url).pathname === "/api/browser" ? current : { items: [] }); };
  const first = installBrowserTools(peer);
  const captured = dom.window.reach;
  assert.deepEqual(Object.keys(captured).sort(), ["callTool", "listTools"]);
  assert.ok(!JSON.stringify(captured).includes(peer.token));
  assert.ok((await captured.listTools()).some((tool) => tool.name === "reach_request_batch"));
  for (const name of ["reach_screen", "reach_scroll"])
    await assert.rejects(captured.callTool(name, {}), /not available/);
  await assert.rejects(captured.callTool("reach_request_action", { action: { type: "click", x: 0.2, y: 0.4 }, reason: "Try a legacy screen action" }), /Invalid tool/);
  await assert.rejects(captured.callTool("reach_request_batch", { actions: [{ type: "key", key: "enter" }], reason: "Try a legacy batch" }), /Invalid tool/);
  await captured.callTool("reach_list_files", { root: 0, path: "" });
  assert.ok(calls.some(([url]) => url.includes("/api/files?")));
  current = { ...access, roots: [], screen: "off", restrictedTerminal: false };
  await assert.rejects(captured.callTool("reach_request_batch", { actions: [{ type: "key", key: "tab" }], reason: "inspect" }), /not available/);
  assert.equal(calls.filter(([url]) => url.includes("/api/browser/requests")).length, 0);
  const second = installBrowserTools({ ...peer, token: "another-token" });
  await assert.rejects(captured.listTools(), /session has ended/);
  first.dispose(); assert.equal(dom.window.reach, second.bridge, "old cleanup cannot remove the new bridge");
  const latest = second.bridge;
  second.dispose(); assert.equal(dom.window.reach, undefined);
  await assert.rejects(latest.callTool("reach_access"), /session has ended/);
});

test("bridge aborts outstanding calls on disposal and expires on server revocation", async () => {
  let signal;
  globalThis.fetch = dom.window.fetch = (_url, init) => new Promise((_resolve, reject) => { signal = init.signal; init.signal.addEventListener("abort", () => reject(Error("aborted")), { once: true }); });
  const active = installBrowserTools(peer);
  const result = active.bridge.listTools();
  active.dispose(); assert.equal(signal.aborted, true); await assert.rejects(result, /aborted/);
  let ended = 0;
  globalThis.fetch = dom.window.fetch = async () => reply({ error: "revoked" }, 401);
  const revoked = installBrowserTools(peer, () => ended++);
  await assert.rejects(revoked.bridge.listTools(), /expired or was revoked/);
  assert.equal(ended, 1); await assert.rejects(revoked.bridge.listTools(), /session has ended/); revoked.dispose();
});

test("tool bridge produces no React warnings", () => { assert.deepEqual(dom.errors, []); });

test("Full-control shell results can arrive after the ordinary request deadline", async (t) => {
  const timers = [], realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms === 35000 || ms === 70000) {
      timers.push({ ms, fire: () => callback(...args) });
      return realTimeout(callback, 10000, ...args);
    }
    return realTimeout(callback, ms, ...args);
  });
  const full = { ...access, preset: "full", shell: true, screen: true, control: true, open: true, write: true };
  globalThis.fetch = dom.window.fetch = async (url, init) => {
    if (new URL(url).pathname === "/api/browser") return reply(full);
    timers.filter(timer => timer.ms <= 35000).forEach(timer => timer.fire());
    if (init.signal.aborted) throw Error("fixture request aborted before the allowed shell finished");
    return reply({ status: "executed", output: "late fixture success" });
  };
  const session = installBrowserTools(peer);
  try {
    const result = await session.bridge.callTool("reach_shell", { root: 0, command: "fixture" });
    assert.equal(result.output, "late fixture success");
    assert.ok(timers.every(timer => timer.ms > 60000));
  } finally { session.dispose(); }
});


test("desktop screenshot and input preserve unavailable diagnostics without retrying or turning them into permission errors", async () => {
  const full = { ...access, preset: "full", screen: true, control: true };
  let calls = 0;
  globalThis.fetch = dom.window.fetch = async url => {
    const route = new URL(url).pathname;
    if (route === "/api/browser") return reply(full);
    calls++;
    return reply({ error: "Completion is unknown. Check the screen before trying again.", kind: "unavailable", helperReason: "process_exit", helperOperation: route.endsWith("screen") ? "shot" : "act", helperDispatch: "completion_unknown" }, 503);
  };
  const session = installBrowserTools(peer);
  try {
    for (const [name, args, op] of [["reach_screenshot", {}, "shot"], ["reach_act", { action: { type: "key", key: "enter" } }, "act"]]) {
      await assert.rejects(session.bridge.callTool(name, args), error => {
        assert.equal(error.status, 503);
        assert.equal(error.body.kind, "unavailable");
        assert.equal(error.body.helperReason, "process_exit");
        assert.equal(error.body.helperOperation, op);
        assert.equal(error.body.helperDispatch, "completion_unknown");
        assert.match(error.message, /Check the screen before trying again/);
        return true;
      });
    }
    assert.equal(calls, 2, "one request per tool; neither is retried");
  } finally { session.dispose(); }
});

for (const dynamic of [false, true]) test(`saved shortcut ${dynamic ? "named" : "generic"} call can receive its bounded result after the ordinary deadline`, async (t) => {
  const timers = [], realTimeout = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (callback, ms, ...args) => {
    if (ms === 35000 || ms === 70000) {
      timers.push({ ms, fire: () => callback(...args) });
      return realTimeout(callback, 10000, ...args);
    }
    return realTimeout(callback, ms, ...args);
  });
  const id = "12345678-1234-4321-8123-123456789abc";
  const current = { ...access, preset: "apps", screen: true, control: true, open: true,
    savedTools: [{ id, name: "Open sample", stepCount: 2, inputs: [], apps: ["com.apple.Safari"] }] };
  let requests = 0;
  globalThis.fetch = dom.window.fetch = async (url, init) => {
    if (new URL(url).pathname === "/api/browser") return reply(current);
    assert.equal(new URL(url).pathname, "/api/browser/shortcuts/run");
    requests++;
    timers.filter(timer => timer.ms <= 35000).forEach(timer => timer.fire());
    if (init.signal.aborted) throw Error("fixture replay aborted before its permitted result");
    return reply({ status: "completed", completedSteps: 2, totalSteps: 2 });
  };
  const session = installBrowserTools(peer);
  try {
    const name = dynamic ? "reach_saved_open_sample_12345678123443218123123456789abc" : "reach_run_shortcut";
    const result = await session.bridge.callTool(name, dynamic ? {} : { id });
    assert.equal(result.status, "completed");
    assert.equal(requests, 1, "no automatic replay");
    assert.ok(timers.length && timers.every(timer => timer.ms === 70000));
  } finally { session.dispose(); }
});
