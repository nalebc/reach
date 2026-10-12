import { approvedFullPolicy } from "./helpers/full-control-policy.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { presetFixture } from "./helpers/preset-fixture.mjs";
import { serveMcp, toolsFor } from "../scripts/mcp-server.mjs";
import { missingKeepUp } from "../scripts/build-agent.mjs";
import { permittedPath } from "../server/funnel-agent.mjs";
import { presetRouteAllowed } from "../server/agent-presets.mjs";
import { createAgentRuntimes, fromBrowserPage, updateNotice } from "../server/agent-runtimes.mjs";

// An agent's copy offers the tools Reach has now, not the ones it was built
// with: Reach lists them and plans each call with its own code (Oct 10: Grok's
// copy, built without its self-update, never saw reach_tool_batch).

// The MCP server over pipes, one message at a time.
async function serve(api, messages, scopes = ["browser:read"]) {
  const input = new PassThrough(), output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  const served = serveMcp({ api, scopes, input, output });
  for (const message of messages) {
    input.write(JSON.stringify(message) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  input.end();
  await served;
  const lines = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return { results: new Map(lines.filter((l) => l.id !== undefined).map((l) => [l.id, l.result])), notes: lines.filter((l) => l.id === undefined).map((l) => l.method) };
}

test("Reach lists an agent's tools and plans each call with its own code; the call then goes out like any other", async (t) => {
  const f = await presetFixture(t);
  const full = await f.join({ preset: "full" });
  const scopes = (await full.as("/api/device")).body.access.scopes;
  const view = (await full.as("/api/browser")).body;
  const listed = await full.as("/api/browser/mcp/tools");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  assert.deepEqual(listed.body.tools.map((tool) => tool.name), toolsFor(scopes, view).map((tool) => tool.name));
  assert.match(listed.body.list, /^[a-f0-9]{16}$/);
  const planned = await full.as("/api/browser/mcp/plan", { method: "POST", body: { name: "reach_front", arguments: {} } });
  assert.equal(planned.status, 200, JSON.stringify(planned.body));
  assert.deepEqual(planned.body.plan, { route: "/api/browser/desktop/front", method: "GET", response: "json" });
  assert.equal(planned.body.list, listed.body.list);
  // The planned request then goes out as any other (this fixture's desktop is inert; access isn't).
  const access = (await full.as("/api/browser/mcp/plan", { method: "POST", body: { name: "reach_access" } })).body.plan;
  assert.deepEqual(access, { route: "/api/browser", method: "GET", response: "json" });
  assert.equal((await full.as(access.route)).status, 200);
  // Refusals stand: no such tool, wrong arguments, extra fields, a tool the preset lacks.
  assert.equal((await full.as("/api/browser/mcp/plan", { method: "POST", body: { name: "reach_nothing", arguments: {} } })).status, 400);
  const wrong = await full.as("/api/browser/mcp/plan", { method: "POST", body: { name: "reach_act", arguments: {} } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.body.error, /action/);
  assert.equal((await full.as("/api/browser/mcp/plan", { method: "POST", body: { name: "reach_front", extra: 1 } })).status, 400);
  const watcher = await f.join({ name: "Watcher", preset: "readonly" });
  const refused = await watcher.as("/api/browser/mcp/plan", { method: "POST", body: { name: "reach_act", arguments: { action: { type: "click", x: 0.5, y: 0.5 } } } });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /not available/);
});

test("an agent's copy offers Reach's tools, one it has never heard of included, calls them by Reach's plan, and says when the list changes", async () => {
  const calls = [];
  let list = "a".repeat(16);
  const api = async (route, method = "GET", body) => {
    const [path] = route.split("?");
    calls.push([method, path, body]);
    if (path === "/api/device") return { access: { scopes: ["browser:read", "browser:control"] } };
    if (path === "/api/browser/mcp/tools") return { tools: [{ name: "reach_brand_new", description: "New on the computer", inputSchema: { type: "object", properties: {} } }], list };
    if (path === "/api/browser/mcp/plan") return { plan: { route: "/api/browser/brand-new", method: "POST", body: { from: body.name, ...body.arguments }, response: "json" }, list };
    if (path === "/api/browser/brand-new") return { ok: true, got: body };
    throw Error(`Unexpected route ${route}`);
  };
  const first = await serve(api, [
    { id: 1, method: "tools/list" },
    { id: 2, method: "tools/call", params: { name: "reach_brand_new", arguments: { x: 1 } } },
  ]);
  assert.deepEqual(first.results.get(1).tools.map((tool) => tool.name), ["reach_brand_new"]);
  assert.deepEqual(JSON.parse(first.results.get(2).content[0].text), { ok: true, got: { from: "reach_brand_new", x: 1 } });
  assert.deepEqual(calls.filter(([, path]) => path.startsWith("/api/browser")).map(([method, path]) => `${method} ${path}`),
    ["GET /api/browser/mcp/tools", "POST /api/browser/mcp/plan", "POST /api/browser/brand-new"]);
  assert.deepEqual(first.notes, []);
  // Reach's tools changed after the client read them: it's told to read again, once.
  const changed = async (route, method, body) => {
    if (route.startsWith("/api/browser/mcp/plan")) list = "b".repeat(16);
    return api(route, method, body);
  };
  const second = await serve(changed, [
    { id: 1, method: "tools/list" },
    { id: 2, method: "tools/call", params: { name: "reach_brand_new", arguments: {} } },
    { id: 3, method: "tools/call", params: { name: "reach_brand_new", arguments: {} } },
  ]);
  assert.deepEqual(second.notes, ["notifications/tools/list_changed"]);
});

test("Reach's refusal of a call stands; a computer without these routes gets this copy's own tools, as before", async () => {
  const refusing = async (route, method = "GET") => {
    const [path] = route.split("?");
    if (path === "/api/device") return { access: { scopes: ["browser:read"] } };
    if (path === "/api/browser/mcp/plan") throw Object.assign(Error("These arguments don't fit this tool."), { status: 400 });
    throw Error(`Unexpected route ${method} ${route}`);
  };
  const refused = await serve(refusing, [{ id: 1, method: "tools/call", params: { name: "reach_act", arguments: {} } }]);
  assert.equal(refused.results.get(1).isError, true);
  assert.match(refused.results.get(1).content[0].text, /arguments/);
  const access = { name: "Mac", preset: "full", screen: true, control: true, open: true, roots: [], terminals: [] };
  const older = async (route) => {
    const [path] = route.split("?");
    if (path === "/api/device") return { access: { scopes: ["browser:read", "browser:screen", "browser:control", "browser:open"] } };
    if (path === "/api/browser") return access;
    if (path === "/api/browser/desktop/front") return { app: "Finder" };
    throw Object.assign(Error("Not found"), { status: 404 });
  };
  const { results } = await serve(older, [
    { id: 1, method: "tools/list" },
    { id: 2, method: "tools/call", params: { name: "reach_front", arguments: {} } },
  ]);
  assert.ok(results.get(1).tools.some((tool) => tool.name === "reach_front"));
  assert.deepEqual(JSON.parse(results.get(2).content[0].text), { app: "Finder" });
});

test("a program that names no runtime is a copy too old to update itself: the owner sees it at once, and the agent is told how", () => {
  const served = "c".repeat(64);
  const runtimes = createAgentRuntimes({ current: () => served });
  const agent = { id: "a1", kind: "agent", browserTransport: "funnel", browserBinding: "k".repeat(43) };
  runtimes.note(agent, undefined, { program: true });
  assert.equal(runtimes.statusOf(agent), "one-time");
  // A browser page names none either, and runs nothing of Reach's.
  runtimes.note(agent, undefined, { program: false });
  assert.equal(runtimes.statusOf(agent), undefined);
  runtimes.note(agent, served, { program: true });
  assert.equal(runtimes.statusOf(agent), "current");
  assert.equal(fromBrowserPage({ headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } }), true);
  assert.equal(fromBrowserPage({ headers: { "user-agent": "node" } }), false);
  assert.equal(fromBrowserPage({ headers: {} }), false);
  const program = { headers: {}, query: {} };
  // Having just named its runtime, it isn't told on a call that doesn't say
  // (reach_access's planned /api/browser); a copy that never named one is.
  assert.deepEqual(updateNotice({ client: agent, req: program, served, host: "mac.example.ts.net" }), {});
  runtimes.note(agent, undefined, { program: true });
  assert.equal(runtimes.statusOf(agent), "current");
  const older = { ...agent, id: "a1-older" };
  const { update } = updateNotice({ client: older, req: program, served, host: "mac.example.ts.net" });
  assert.match(update.reason, /can't update itself/);
  assert.ok(update.command.startsWith(`curl -fsSL -H 'Reach-Key: ${older.browserBinding}' -o ~/.reach-agent/agent.mjs.new https://mac.example.ts.net/agent-runtimes/${served}.mjs && `));
  assert.ok(update.command.endsWith("mv ~/.reach-agent/agent.mjs.new ~/.reach-agent/agent.mjs"));
  assert.deepEqual(updateNotice({ client: older, req: { headers: { "user-agent": "Mozilla/5.0" }, query: {} }, served, host: "mac.example.ts.net" }), {});
  assert.deepEqual(updateNotice({ client: older, req: { headers: {}, query: { runtime: "d".repeat(64) } }, served, host: "mac.example.ts.net" }), {});
  assert.deepEqual(updateNotice({ client: { ...older, hosted: true }, req: program, served, host: "mac.example.ts.net" }), {});
  assert.deepEqual(updateNotice({ client: older, req: program, served, host: "" }), {});
});

test("a build that lacks what keeps agents up to date is never handed out; the routes pass the doors", () => {
  const whole = 'function runtimeUpdater({ home }) {} api("/api/device/runtime"); api("/api/browser/mcp/tools"); api("/api/browser/mcp/plan");';
  assert.deepEqual(missingKeepUp(whole), []);
  assert.deepEqual(missingKeepUp(whole.replace("function runtimeUpdater(", "")), ["self-update"]);
  assert.deepEqual(missingKeepUp(""), ["self-update", "the computer's runtime", "Reach's tool list", "Reach's call plans"]);
  assert.equal(permittedPath("GET", `/api/browser/mcp/tools?runtime=${"a".repeat(64)}`), "/browser/mcp/tools");
  assert.equal(permittedPath("POST", "/api/browser/mcp/plan"), "/browser/mcp/plan");
  const agent = { kind: "agent", policy: approvedFullPolicy(), scopes: ["browser:read", "browser:control", "browser:open", "browser:screen"] };
  assert.equal(presetRouteAllowed(agent, "GET", "/browser/mcp/tools"), true);
  assert.equal(presetRouteAllowed(agent, "POST", "/browser/mcp/plan"), true);
  assert.equal(presetRouteAllowed({ ...agent, scopes: [] }, "POST", "/browser/mcp/plan"), false);
});
