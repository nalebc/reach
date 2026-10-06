import test, { before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startDom } from "./dom/harness.mjs";
let dom, installBrowserTools;
const peer = { id: "mac", name: "Mac", url: "https://mac.tail.ts.net", token: "private-token", platform: "darwin" };
const access = { name: "Mac", expiresAt: Date.now() + 3600000, roots: [{ index: 0, name: "Project", path: "/shared" }], terminals: [], screen: "ask" };
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
  await captured.callTool("reach_list_files", { root: 0, path: "" });
  assert.ok(calls.some(([url]) => url.includes("/api/files?")));
  current = { ...access, roots: [], screen: "view" };
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
