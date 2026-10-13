import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { presetFixture } from "./helpers/preset-fixture.mjs";
import { serveMcp, toolsFor } from "../scripts/mcp-server.mjs";
import { compactTools, browserToolRequest } from "../server/browser-tools.mjs";
import { presetScopes } from "../server/agent-presets.mjs";
import { normalizeAction } from "../server/agent-desktop.mjs";

test("stdio executes a tool with one request after capability discovery and never retries a failed mutation", async () => {
  const input = new PassThrough(), output = new PassThrough(), calls = [];
  const messages = [];
  output.on("data", chunk => messages.push(...chunk.toString().trim().split("\n").map(JSON.parse)));
  const run = serveMcp({ input, output, liveScopes: false, scopes: ["browser:read"], api: async (path) => {
    calls.push(path);
    if (path === "/api/browser/mcp/tools") return { tools: [], dispatch: true, list: "a" };
    if (path === "/api/browser/mcp/call") throw Object.assign(Error("Response lost after input"), { status: 503 });
    assert.fail("Unexpected fallback " + path);
  } });
  input.write(JSON.stringify({ id: 1, method: "tools/list" }) + "\n");
  while (!messages.length) await new Promise(resolve => setImmediate(resolve));
  input.end(JSON.stringify({ id: 2, method: "tools/call", params: { name: "reach_press", arguments: { name: "Save" } } }) + "\n");
  await run;
  assert.deepEqual(calls, ["/api/browser/mcp/tools", "/api/browser/mcp/call"]);
  assert.equal(messages.find(message => message.id === 2).result.isError, true);
});

test("one-call dispatch reauthorizes real routes, carries images and supports compact discovery", async t => {
  let actions = 0;
  const f = await presetFixture(t, { desktopExtras: {
    act: async (client, action, authorize) => { authorize(); actions++; return { ok: true }; },
    screenshot: async (client, authorize) => { authorize(); return { jpeg: Buffer.from([255, 216, 255, 217]), width: 2, height: 2 }; },
  } });
  const full = await f.join({ preset: "full" });
  const call = (agent, name, args) => agent.as("/api/browser/mcp/call", { method: "POST", body: { name, arguments: args } });
  const list = await full.as("/api/browser/mcp/tools?profile=compact");
  assert.equal(list.body.dispatch, true);
  assert.ok(list.body.tools.length <= 12);
  assert.ok(list.body.tools.some(tool => tool.name === "reach_execute"));
  assert.equal((await call(full, "reach_execute", { name: "reach_act", arguments: { action: { type: "key", key: "tab" } } })).body.result.ok, true);
  assert.equal(actions, 1);
  const image = await call(full, "reach_screenshot", {});
  assert.equal(image.status, 200, JSON.stringify(image.body));
  assert.ok(image.body.result, JSON.stringify(image.body));
  assert.equal(image.body.result.mimeType, "image/jpeg");
  assert.equal(image.body.result.image, "/9j/2Q==");
  const discovered = await call(full, "reach_discover", { name: "reach_fill" });
  assert.ok(discovered.body.result.tools[0].inputSchema.properties.waitFor);
  const readonly = await f.join({ name: "Reader", preset: "readonly" });
  assert.equal((await call(readonly, "reach_execute", { name: "reach_act", arguments: { action: { type: "key", key: "tab" } } })).status, 400);
  assert.equal(actions, 1);
  assert.equal((await call(full, "reach_execute", { name: "reach_execute", arguments: {} })).status, 400);
});

test("navigation waits in the same call and batches stop before later effects when readiness fails", async t => {
  let reads = 0, actions = 0, opened = 0;
  const f = await presetFixture(t, { desktopExtras: {
    openUrl: async (client, url, browser, authorize) => { authorize(); opened++; return { ok: true }; },
    act: async (client, action, authorize) => { authorize(); actions++; return { ok: true }; },
    elements: async (client, authorize) => { authorize(); reads++; return { snapshot: String(reads), app: "Browser", title: "Ready", items: [], texts: [], truncated: false }; },
  } });
  const full = await f.join({ preset: "full" });
  const result = await full.as("/api/browser/desktop/open-url", { method: "POST", body: { url: "https://example.com", waitFor: { text: "Ready" }, observe: true } });
  assert.equal(result.status, 200); assert.equal(result.body.found, true); assert.match(result.body.screen.text, /Ready/);
  assert.equal(opened, 1); assert.equal(reads, 1);
  const invalid = await full.as("/api/browser/desktop/open-url", { method: "POST", body: { url: "https://example.com", waitFor: { text: "Ready", name: "Ready" } } });
  assert.equal(invalid.status, 400); assert.equal(opened, 1);
  const batch = await full.as("/api/browser/desktop/input", { method: "POST", body: { actions: [
    { type: "key", key: "tab" }, { type: "wait_for", text: "Never", timeoutMs: 500 }, { type: "key", key: "enter" },
  ] } });
  assert.equal(batch.body.ok, false); assert.equal(batch.body.done, 1); assert.equal(batch.body.stopped.index, 1); assert.equal(actions, 1);
});

test("reference actions and display selection survive normalization; compact catalogs shrink schemas", () => {
  const action = { type: "element", ref: "e-1234abcd", displayId: 2 };
  assert.deepEqual(normalizeAction(action), action);
  assert.throws(() => normalizeAction({ ...action, snapshot: "old", n: 1 }));
  const access = { preset: "full", screen: true, open: true, control: true, shell: true, roots: [{ index: 0 }], terminals: [] };
  const full = toolsFor(presetScopes({ preset: "full" }), access);
  const compact = compactTools(full);
  assert.ok(JSON.stringify(compact).length < JSON.stringify(full).length * 0.7);
  const plan = browserToolRequest("reach_press", { name: "Open", within: "March", waitFor: { text: "Invoice" }, observe: true }, access);
  assert.equal(plan.body.action.within, "March");
  assert.equal(plan.body.waitFor.text, "Invoice");
  assert.equal(plan.body.action.observe, undefined);
});
