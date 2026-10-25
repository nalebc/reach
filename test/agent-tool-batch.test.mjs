import { approvedFullPolicy } from "./helpers/full-control-policy.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createAgentTools, batchItemId } from "../server/agent-tools.mjs";
import { browserToolRequest, browserToolsFor } from "../server/browser-tools.mjs";
import { presetRouteAllowed } from "../server/agent-presets.mjs";
import { agentRequestTimeout } from "../server/agent-transport.mjs";
import { serverInstructions } from "../scripts/mcp-server.mjs";
import { toolBrowserFixture, toolAppsFor } from "./helpers/tool-browser-fixture.mjs";

// The browser platform is modeled and the same on every CI host: the app
// inventory, the driver and Reach's own browser allowlist agree (as in
// test/agent-tools.test.mjs). Unmodeled, real Windows refused the macOS apps.
function setup(t, extra = {}) {
  const { platform = "darwin", apps = toolAppsFor(platform), ...options } = extra;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-batch-test-")),
    driver = toolBrowserFixture({ platform }),
    saved = [];
  const client = {
    id: "agent",
    name: "Test agent",
    kind: "agent",
    status: "accepted",
    expiresAt: Date.now() + 600000,
    policy: { browser: true, preset: "full", roots: [] },
    scopes: ["browser:read", "browser:open", "browser:control", "browser:screen"],
  };
  const authorize = () => client;
  const desktop = {
    catalog: async (auth) => {
      auth();
      return apps;
    },
    withBrowser: async (_client, _app, auth, work) =>
      work(async () => { auth(); }, async () => {}),
  };
  const opened = [];
  // Another Reach on the same data folder and browser: a restart.
  const make = () => {
    const tools = createAgentTools(
      { dataDir },
      { desktop, driver, platform, waitMs: 250, runMs: 5000, savings: { record: (entry) => saved.push(entry) }, ...options },
    );
    opened.push(tools);
    return tools;
  };
  const tools = make();
  t.after(() => {
    for (const item of opened) item.close();
    driver.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const batch = (input) => tools.batch(authorize, { browser: "Chrome", requestId: crypto.randomUUID(), ...input });
  return { tools, driver, authorize, batch, saved, dataDir, make, apps };
}
// Reach's own record of the batch tabs it has open.
const tracked = (f) => JSON.parse(fs.readFileSync(path.join(f.dataDir, "agent-tool-tabs.json"), "utf8"));
const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
  return check();
};

// A search on one site: one tab per item, the item's own address.
const searchTool = {
  protocol: "reach.tool.v1",
  id: "shop_add",
  title: "Add an item",
  description: "Search the shop for an item and add it.",
  origins: ["https://example.com"],
  inputs: { item: { type: "string", label: "Item", maxLength: 200 } },
  steps: [
    { op: "navigate", url: { concat: ["https://example.com/search?q=", { urlEncode: { input: "item" } }] } },
    { op: "click", target: { role: "button", name: "Do task" } },
    { op: "assert", target: { css: "#result", text: "Done" } },
    { op: "read", target: { css: "#result" }, as: "result" },
  ],
};
const ops = (driver, op) => driver.calls.filter((call) => call.op === op);

for (const [platform, browser] of [["darwin", "Chrome"], ["win32", "Chrome"], ["win32", "Edge"]])
test(`a batch opens a tab per item behind, never focuses, leaves the owner's tab alone and closes its own (${platform} ${browser})`, async (t) => {
  const f = setup(t, { platform });
  await f.tools.define(f.authorize, searchTool);
  const mine = f.driver.add(browser, "https://example.com/search?q=mine");
  const items = ["milk", "eggs", "bread"].map((item) => ({ item }));
  const result = await f.batch({ id: "shop_add", items, browser });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.items.map((item) => [item.status, item.data.result]), items.map(() => ["completed", "Done"]));
  assert.equal(f.driver.counters.clicks, 3);
  assert.deepEqual(ops(f.driver, "create").map((call) => [call.url, call.background]), [
    ["https://example.com/search?q=milk", true],
    ["https://example.com/search?q=eggs", true],
    ["https://example.com/search?q=bread", true],
  ]);
  assert.equal(ops(f.driver, "focus").length, 0);
  // One scripting check for the whole batch, not one per item.
  assert.equal(ops(f.driver, "preflight").length, 1);
  assert.equal(result.tabsClosed, 3);
  assert.deepEqual(f.driver.browsers.get(browser), [mine]);
  assert.equal(mine.dom.window.document.querySelector("#result").textContent, "Ready");
  assert.deepEqual(f.saved, [{ agent: "browser", kind: "tab-batch", tokens: 600, count: 3 }]);
});

test("calling a batch again never repeats a finished item; a partial batch finishes on the next call", async (t) => {
  const f = setup(t, { batchMs: 0 });
  await f.tools.define(f.authorize, searchTool);
  const requestId = crypto.randomUUID(),
    items = ["milk", "eggs", "bread"].map((item) => ({ item }));
  const first = await f.batch({ id: "shop_add", requestId, items });
  assert.equal(first.status, "partial");
  assert.match(first.next, /same requestId/);
  assert.deepEqual(first.items.map((item) => item.status), ["completed", "not_started", "not_started"]);
  assert.equal(f.driver.counters.clicks, 1);
  const second = await f.batch({ id: "shop_add", requestId, items });
  assert.deepEqual(second.items.map((item) => item.status), ["completed", "completed", "not_started"]);
  const third = await f.batch({ id: "shop_add", requestId, items });
  assert.equal(third.status, "completed");
  assert.equal(f.driver.counters.clicks, 3);
  const again = await f.batch({ id: "shop_add", requestId, items });
  assert.equal(again.status, "completed");
  assert.equal(f.driver.counters.clicks, 3);
  assert.equal(third.items[0].requestId, batchItemId(requestId, 0));
  // Each item is an ordinary run: its status is there after a lost response.
  assert.equal(f.tools.operation(f.authorize, batchItemId(requestId, 2)).status, "completed");
  // Same request, different items: the finished ones are refused, not redone.
  const changed = await f.batch({ id: "shop_add", requestId, items: [{ item: "cheese" }] });
  assert.equal(changed.items[0].code, "request_conflict");
  assert.equal(f.driver.counters.clicks, 3);
});

test("search with handles kept, then one handle tool across those tabs", async (t) => {
  const f = setup(t);
  const found = await f.batch({ id: "builtin_walmart_find", items: [{ query: "ORDER" }, { query: "chair" }], keepTabs: true });
  assert.equal(found.status, "completed");
  assert.deepEqual(found.tabsKept, [0, 1]);
  assert.equal(found.tabsClosed, 0);
  assert.equal(f.driver.browsers.get("Chrome").length, 2);
  const handles = found.items.map((item) => item.data.orders.items[0].handle);
  const tracked = await f.batch({ id: "builtin_walmart_track", items: handles.map((order) => ({ order })) });
  assert.equal(tracked.status, "completed");
  assert.deepEqual(tracked.items.map((item) => /Delivered/.test(item.data.tracking)), [true, true]);
  assert.equal(ops(f.driver, "focus").length, 0);
  // Every click landed in its own tab, and Reach's tabs close at the end.
  assert.equal(f.driver.counters.clicks, 2);
  assert.equal(tracked.tabsClosed, 2);
  assert.equal(f.driver.browsers.get("Chrome").length, 0);
});

test("a stop every item would meet ends the batch; bad input and Safari are refused before any tab opens", async (t) => {
  const f = setup(t);
  await f.tools.define(f.authorize, searchTool);
  f.driver.before = async (_browser, request) => {
    if (request.op === "bind" && request.expectedURL.includes("eggs"))
      throw Object.assign(Error("The browser needs you to sign in."), { code: "login_required" });
  };
  const result = await f.batch({ id: "shop_add", items: ["milk", "eggs", "bread"].map((item) => ({ item })) });
  assert.deepEqual(result.items.map((item) => item.status), ["completed", "needs_owner", "not_started"]);
  assert.equal(result.items[2].code, "login_required");
  assert.equal(f.driver.counters.clicks, 1);
  f.driver.calls.length = 0;
  await assert.rejects(f.batch({ id: "shop_add", browser: "Safari", items: [{ item: "milk" }] }), /Chrome/);
  await assert.rejects(f.batch({ id: "shop_add", items: Array.from({ length: 11 }, () => ({ item: "milk" })) }), /1 to 10/);
  await assert.rejects(f.batch({ id: "shop_add", items: [{ item: "milk" }], extra: 1 }), /1 to 10/);
  await assert.rejects(f.tools.define(f.authorize, { ...searchTool, id: "batch" }), /reserved/);
  assert.equal(f.driver.calls.length, 0);
});

test("an uncertain or stopped item's tab stays open to inspect; finished items' tabs close", async (t) => {
  const f = setup(t);
  await f.tools.define(f.authorize, searchTool);
  f.driver.after = async (_browser, request) => {
    if (request.op === "click" && f.driver.counters.clicks === 2)
      throw Object.assign(Error("The browser did not acknowledge this command."), { code: "uncertain", uncertain: true });
  };
  const result = await f.batch({ id: "shop_add", items: ["milk", "eggs", "bread"].map((item) => ({ item })) });
  assert.deepEqual(result.items.map((item) => item.status), ["completed", "uncertain", "completed"]);
  assert.deepEqual(result.tabsKept, [1]);
  assert.equal(result.tabsClosed, 2);
  assert.deepEqual(f.driver.browsers.get("Chrome").map((tab) => tab.url), ["https://example.com/search?q=eggs"]);
});

test("Apps cannot define bank batches; Full control retains its explicit unrestricted access", async (t) => {
  const f = setup(t);
  const definition = { ...searchTool, id: "bank_peek", origins: ["https://www.chase.com"], steps: [{ op: "navigate", url: "https://www.chase.com/" }, { op: "read", target: { css: "main" }, as: "x" }] };
  const client = f.authorize();
  client.policy = { ...client.policy, preset: "apps", apps: f.apps };
  await assert.rejects(
    f.tools.define(f.authorize, definition),
    /bank/,
  );
  client.policy.preset = "full";
  await f.tools.define(f.authorize, definition);
  assert.equal(ops(f.driver, "create").length, 0);
});

test("reach_tool_batch is offered with the tools, sent to its own route with the long budget, and allowed by the presets", () => {
  const access = {
    preset: "full", control: true, open: true, screen: true,
    browserTools: { browsers: ["Chrome", "Safari"], tools: [searchTool] },
  };
  const tool = browserToolsFor(access).find((item) => item.name === "reach_tool_batch");
  assert.deepEqual(tool.inputSchema.properties.id.enum, ["shop_add"]);
  const requestId = crypto.randomUUID();
  const plan = browserToolRequest("reach_tool_batch", { id: "shop_add", browser: "Chrome", requestId, items: [{ item: "milk" }] }, access);
  assert.deepEqual(plan, { route: "/api/browser/tools/batch", method: "POST", body: { id: "shop_add", browser: "Chrome", requestId, items: [{ item: "milk" }] }, response: "json" });
  assert.throws(() => browserToolRequest("reach_tool_batch", { id: "shop_add", browser: "Safari", requestId, items: [{ item: "milk" }] }, access));
  assert.equal(agentRequestTimeout("/api/browser/tools/batch", "POST"), 70000);
  assert.equal(browserToolsFor({ ...access, browserTools: { browsers: ["Safari"], tools: [searchTool] } }).some((item) => item.name === "reach_tool_batch"), false);
  // Found where an agent looks: each saved tool names the batch, and so does reach_tools.
  const listed = browserToolsFor(access);
  assert.match(listed.find((item) => item.name === "reach_tool_shop_add").description, /Several items at once: reach_tool_batch\.$/);
  assert.match(listed.find((item) => item.name === "reach_tools").description, /reach_tool_batch/);
  assert.match(tool.description, /^Run one saved tool for a list of up to 10 items at once, each in its own Chrome tab/);
  const safari = browserToolsFor({ ...access, browserTools: { browsers: ["Safari"], tools: [searchTool] } });
  assert.doesNotMatch(safari.find((item) => item.name === "reach_tool_shop_add").description, /reach_tool_batch/);
  assert.doesNotMatch(safari.find((item) => item.name === "reach_tools").description, /reach_tool_batch/);
  // And in what the agent reads on connecting.
  const { instructions } = serverInstructions(["browser:read", "browser:control"]);
  assert.match(instructions, /list of items, use reach_tool_batch/);
  assert.ok(instructions.length < 120);
  assert.deepEqual(serverInstructions(["browser:read"]), {});
  const agent = { kind: "agent", policy: approvedFullPolicy(), scopes: ["browser:control", "browser:open", "browser:screen"] };
  assert.equal(presetRouteAllowed(agent, "POST", "/browser/tools/batch"), true);
  assert.equal(presetRouteAllowed({ ...agent, policy: { invite: true, browser: true, preset: "readonly", roots: [] } }, "POST", "/browser/tools/batch"), false);
});

test("never more than 10 batch tabs open: a full set refuses more, and tabs past their time close first", async (t) => {
  let offset = 0;
  const f = setup(t, { now: () => Date.now() + offset });
  await f.tools.define(f.authorize, searchTool);
  const kept = await f.batch({ id: "shop_add", items: Array.from({ length: 10 }, (_, n) => ({ item: `item${n}` })), keepTabs: true });
  assert.equal(kept.status, "completed");
  assert.equal(f.driver.browsers.get("Chrome").length, 10);
  const full = await f.batch({ id: "shop_add", items: [{ item: "milk" }, { item: "eggs" }] });
  assert.deepEqual(full.items.map((item) => [item.status, item.code]), [["not_started", "tab_limit"], ["not_started", "tab_limit"]]);
  assert.equal(ops(f.driver, "create").length, 10);
  assert.equal(f.driver.browsers.get("Chrome").length, 10);
  // Past their time, the kept tabs close before the next batch opens its own.
  offset = 6 * 60 * 1000;
  const next = await f.batch({ id: "shop_add", items: [{ item: "milk" }, { item: "eggs" }] });
  assert.equal(next.status, "completed");
  assert.equal(f.driver.browsers.get("Chrome").length, 0);
  assert.deepEqual(tracked(f), []);
});

test("a retry goes back to the tabs it opened instead of opening more", async (t) => {
  const f = setup(t, { batchMs: 0 });
  await f.tools.define(f.authorize, searchTool);
  const requestId = crypto.randomUUID(),
    items = ["milk", "eggs", "bread"].map((item) => ({ item }));
  let result;
  for (let call = 0; call < 3; call++) result = await f.batch({ id: "shop_add", requestId, items, keepTabs: true });
  assert.equal(result.status, "completed");
  assert.equal(ops(f.driver, "create").length, 3);
  assert.equal(f.driver.browsers.get("Chrome").length, 3);
  assert.equal(f.driver.counters.clicks, 3);
});

test("Reach closes batch tabs on its own: when the agent's access ends, and after a restart on the page they were left on", async (t) => {
  const f = setup(t);
  await f.tools.define(f.authorize, searchTool);
  await f.batch({ id: "shop_add", items: [{ item: "milk" }, { item: "eggs" }], keepTabs: true });
  assert.equal(f.driver.browsers.get("Chrome").length, 2);
  f.tools.cancelClient("agent");
  assert.ok(await until(() => f.driver.browsers.get("Chrome").length === 0));
  assert.deepEqual(tracked(f), []);
  // Kept tabs, then a restart: the next Reach closes them, except one the owner took to another page.
  await f.batch({ id: "shop_add", items: [{ item: "bread" }, { item: "jam" }], keepTabs: true });
  const [, moved] = f.driver.browsers.get("Chrome");
  f.driver.load(moved, "https://example.com/search?q=mine");
  f.tools.close();
  f.make();
  assert.ok(await until(() => f.driver.browsers.get("Chrome").length === 1));
  assert.equal(f.driver.browsers.get("Chrome")[0], moved);
  assert.ok(await until(() => tracked(f).length === 0));
});

test("a batch tab the owner is looking at stays open and becomes theirs", async (t) => {
  const f = setup(t);
  await f.tools.define(f.authorize, searchTool);
  f.driver.before = async (_browser, request) => {
    if (request.op === "close" && request.target.url.includes("eggs"))
      throw Object.assign(Error("The owner is looking at this tab."), { code: "owner_tab" });
  };
  const result = await f.batch({ id: "shop_add", items: [{ item: "milk" }, { item: "eggs" }] });
  assert.equal(result.tabsClosed, 1);
  assert.deepEqual(f.driver.browsers.get("Chrome").map((tab) => tab.url), ["https://example.com/search?q=eggs"]);
  assert.deepEqual(tracked(f), []);
  assert.ok(ops(f.driver, "close").every((call) => call.behind === true));
});

test("one batch at a time; kept tabs don't confuse a single run", async (t) => {
  const f = setup(t);
  await f.tools.define(f.authorize, searchTool);
  const first = f.batch({ id: "shop_add", items: [{ item: "milk" }, { item: "eggs" }], keepTabs: true });
  await assert.rejects(f.batch({ id: "shop_add", items: [{ item: "bread" }] }), /Another batch/);
  await first;
  // Two kept tabs on the search page: a single run still finds no tab of the owner's there and opens its own.
  const single = await f.tools.run(f.authorize, { id: "shop_add", browser: "Chrome", requestId: crypto.randomUUID(), values: { item: "jam" } });
  assert.equal(single.status, "completed");
});

test("pages that never settle on their address stop the batch after two; their tabs stay to inspect, tracked", async (t) => {
  const f = setup(t);
  await f.tools.define(f.authorize, searchTool);
  f.driver.before = async (_browser, request) => {
    if (request.op === "bind") throw Object.assign(Error("Still loading."), { code: "loading" });
  };
  const result = await f.batch({ id: "shop_add", items: ["milk", "eggs", "bread"].map((item) => ({ item })) });
  assert.deepEqual(result.items.map((item) => [item.status, item.code]), [["stopped", "loading"], ["stopped", "loading"], ["not_started", "loading"]]);
  assert.equal(f.driver.browsers.get("Chrome").length, 2);
  assert.equal(tracked(f).length, 2);
});

test("reach_tools tells an agent with Chrome about the batch", async (t) => {
  const f = setup(t);
  assert.match((await f.tools.catalog(f.authorize)).hint, /list of items, use reach_tool_batch/);
});
