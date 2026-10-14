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

test("a trailing condition wait supplies the final observation without a second read", async t => {
  let reads = [], serial = 0, title = "Ready", readDelayMs = 0;
  const f = await presetFixture(t, { desktopExtras: {
    act: async (client, action, authorize) => { authorize(); title = "After action"; return { ok: true }; },
    elements: async (client, authorize, options = {}) => {
      authorize(); reads.push(options.displayId);
      if (readDelayMs) await new Promise(resolve => setTimeout(resolve, readDelayMs));
      return { snapshot: String(++serial), app: "Fixture", title, displayId: options.displayId ?? 1,
        items: [{ n: 1, ref: "e-1234abcd", role: "Button", name: "Target", context: "Row A", x: 0, y: 0, w: 1, h: 1 },
          { n: 2, ref: "e-5678abcd", role: "Button", name: "Unrelated", context: "Row B", x: 0, y: 1, w: 1, h: 1 }], texts: [], truncated: false };
    },
    waitForChange: async (client, revision, ms, authorize) => {
      authorize(); await new Promise(resolve => setTimeout(resolve, ms)); return { revision: 1, changed: false };
    },
  } });
  const full = await f.join({ preset: "full" });
  const batch = async body => {
    reads = []; title = "Ready";
    const result = await full.as("/api/browser/desktop/input", { method: "POST", body: { describe: true, full: true, ...body } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body;
  };
  const ready = { type: "wait_for", text: "Ready", timeoutMs: 500 };
  const result = await batch({ actions: [ready] });
  assert.equal(result.results[0].found, true);
  assert.equal(result.screen.snapshot, String(serial));
  assert.deepEqual(reads, [undefined]);

  const scoped = await batch({ actions: [{ ...ready, displayId: "2" }], observe: { displayId: 2, query: "Target", within: "Row A" } });
  assert.deepEqual(reads, [2]);
  assert.match(scoped.screen.text, /Target/);
  assert.doesNotMatch(scoped.screen.text, /Unrelated/);
  assert.equal(scoped.screen.displayId, 2);

  const otherDisplay = await batch({ actions: [{ ...ready, displayId: 2 }], observe: { displayId: 3 } });
  assert.deepEqual(reads, [2, 3]);
  assert.equal(otherDisplay.screen.displayId, 3);
  await batch({ actions: [{ ...ready, displayId: 2 }] });
  assert.deepEqual(reads, [2, undefined], "an omitted display still means the main display");

  await batch({ actions: [ready], waitFor: { text: "Ready" } });
  assert.equal(reads.length, 2, "a separate requested condition must still be checked");
  const after = await batch({ actions: [ready, { type: "key", key: "tab" }] });
  assert.equal(reads.length, 2, "a later effect invalidates the earlier observation");
  assert.equal(after.screen.title, "After action");
  await batch({ actions: [ready, { type: "wait", ms: 50 }] });
  assert.equal(reads.length, 2, "time passing after the condition requires another look");

  await batch({ actions: [ready], describe: undefined });
  assert.equal(reads.length, 1, "receipt-only batches still wait but add no observation");

  readDelayMs = 510; // One read crosses the wait deadline; no polling count depends on scheduling.
  const timedOut = await batch({ actions: [{ ...ready, text: "Never" }, { type: "key", key: "enter" }] });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.done, 0);
  assert.equal(timedOut.stopped.index, 0);
  assert.equal(timedOut.screen.title, "Ready");
  assert.equal(reads.length, 1, "reuse the last timeout read instead of settling and reading again");
});

test("desktop routes preserve navigation diagnostics and setup refusals for recovery", async t => {
  const diagnostics = { kind: "unavailable", helperReason: "timeout", helperOperation: "elements", helperDispatch: "completion_unknown" };
  const f = await presetFixture(t, { desktopExtras: {
    elements: async () => { throw Object.assign(Error("The Mac helper timed out."), { status: 503, ...diagnostics, stderr: "PRIVATE" }); },
    openUrl: async () => { throw Object.assign(Error("The owner needs to enable macOS Automation."), { status: 503, kind: "setup_required", path: "PRIVATE" }); },
  } });
  const full = await f.join({ preset: "full" });
  const read = await full.as("/api/browser/desktop/describe");
  assert.equal(read.status, 503);
  assert.deepEqual(read.body, { error: "The Mac helper timed out.", ...diagnostics });
  const open = await full.as("/api/browser/desktop/open-url", { method: "POST", body: { url: "https://example.com" } });
  assert.equal(open.status, 503);
  assert.deepEqual(open.body, { error: "The owner needs to enable macOS Automation.", kind: "setup_required" });
});

test("a changed grant prevents reuse of the screen returned by a batch wait", async t => {
  let reads = 0, changed = false;
  const f = await presetFixture(t, { desktopExtras: {
    elements: async (client, authorize) => {
      authorize(); reads++;
      const first = !changed;
      return { snapshot: String(reads), app: "Fixture", items: [], texts: [], truncated: false,
        get title() {
          // The condition is checked after the read's final authorization.
          // Change the grant before the route resumes with that observation.
          if (first && !changed) {
            changed = true;
            queueMicrotask(() => f.reach.auth.changeAccess(client.id, { folders: "keep", expiresAt: Date.now() + 120000 }));
          }
          return first ? "Ready under old grant" : "Fresh under current grant";
        } };
    },
  } });
  const full = await f.join({ preset: "full" });
  const result = await full.as("/api/browser/desktop/input", { method: "POST", body: { actions: [{ type: "wait_for", text: "Ready" }], describe: true } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  assert.equal(reads, 2);
  assert.match(result.body.screen.text, /Fresh under current grant/);
  assert.doesNotMatch(result.body.screen.text, /old grant/);
});

test("condition waits read beyond the region chosen for the returned observation", async t => {
  const reads = [];
  const f = await presetFixture(t, { desktopExtras: {
    elements: async (client, authorize, options = {}) => {
      authorize(); reads.push(options);
      return { snapshot: String(reads.length), app: "Fixture", title: "Invoices", items: [], truncated: false,
        texts: [{ text: "Ready", context: "Status", x: 0, y: 0, w: 1, h: 1 }, { text: "Total 25", context: "Details", x: 0, y: 1, w: 1, h: 1 }].filter(item => !options.within || item.context === options.within) };
    },
  } });
  const full = await f.join({ preset: "full" });
  const result = await full.as("/api/browser/desktop/wait", { method: "POST", body: { text: "Ready", within: "Status", timeoutMs: 500, observe: { within: "Details", displayId: 2 } } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.found, true);
  assert.deepEqual(reads, [{ displayId: 2 }]);
  assert.match(result.body.screen.text, /Total 25/);
  assert.doesNotMatch(result.body.screen.text, /Ready/);
  await full.as("/api/browser/desktop/describe?within=Details&displayId=2");
  assert.deepEqual(reads.at(-1), { within: "Details", displayId: 2 });
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
