import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { presetFixture, privateIngressTest, apps } from "./helpers/preset-fixture.mjs";
import { serveMcp, toolsFor } from "../scripts/mcp-server.mjs";
import { presetScopes } from "../server/agent-presets.mjs";

// The agent knows only MCP tool descriptions and schemas. Requests pass through
// the real private HTTP listener; desktop adapters never control the host.
function agentMcp(t, agent, profile = "compact") {
  const input = new PassThrough(), output = new PassThrough();
  const waiting = new Map(), requests = [], notifications = [];
  let nextId = 0, buffer = "";
  output.on("data", chunk => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (message.id === undefined) notifications.push(message);
      else waiting.get(message.id)?.(message);
    }
  });
  const served = serveMcp({ input, output, profile, scopes: ["browser:read"], api: async (route, method = "GET", body) => {
    requests.push({ route, method });
    const result = await agent.as(route, { method, body });
    if (result.status >= 400) throw Object.assign(Error(result.body.error), { status: result.status, body: result.body });
    return result.body;
  } });
  t.after(async () => { input.end(); await served; });
  const rpc = async (method, params) => {
    const id = ++nextId;
    const reply = new Promise(resolve => waiting.set(id, resolve));
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const message = await reply;
    waiting.delete(id);
    assert.equal(message.error, undefined, JSON.stringify(message.error));
    return message.result;
  };
  return { rpc, requests, notifications,
    call: async (name, args = {}) => {
      const result = await rpc("tools/call", { name, arguments: args });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      const [done, screen] = result.content.filter(item => item.type === "text");
      const value = JSON.parse(done.text);
      // The screen after acting comes as plain text of its own (toContent).
      if (screen) {
        assert.equal(value.screen.text, undefined, "not escaped inside the JSON too");
        value.screen.text = screen.text;
      }
      return value;
    },
  };
}

test("a new Files agent discovers a task in ordinary words, reads its shared file and cannot escape", { skip: process.platform !== "darwin" && "Protected browser-agent files require macOS" }, async t => {
  const f = await presetFixture(t);
  const agent = await f.join({ preset: "files", folders: [{ root: 0, path: "Desktop/Project" }] });
  const mcp = agentMcp(t, agent);
  const initial = await mcp.rpc("tools/list");
  assert.ok(initial.tools.some(tool => tool.name === "reach_discover"));
  assert.ok(initial.tools.length <= 12);
  assert.doesNotMatch(initial.tools.find(tool => tool.name === "reach_access").description, /reach_act|reach_open_bank|vault/);
  const access = await mcp.call("reach_access");
  assert.equal(access.preset, "files");
  assert.equal(access.write, false);
  const matches = await mcp.call("reach_discover", { query: "read file" });
  assert.equal(matches.tools[0]?.name, "reach_read_file");
  assert.equal(matches.tools[0].annotations.readOnlyHint, true);
  const exact = await mcp.call("reach_discover", { name: matches.tools[0].name });
  assert.deepEqual(exact.tools[0].inputSchema.required, ["root", "path"]);
  const before = mcp.requests.length;
  const file = await mcp.call("reach_execute", { name: exact.tools[0].name, arguments: { root: access.roots[0].index, path: "brief.txt" } });
  assert.equal(file.text, "A project brief");
  assert.equal(mcp.requests.length - before, 1, "one HTTP request after discovering the tool");
  for (const args of [
    { name: "reach_read_file", arguments: { root: 0, path: "../private.txt" } },
    { name: "reach_read_file", arguments: { root: 999, path: "brief.txt" } },
    { name: "reach_change_file", arguments: { op: "rm", root: 0, path: "brief.txt" } },
    { name: "reach_shell", arguments: { root: 0, command: "pwd" } },
    { name: "reach_execute", arguments: { name: "reach_access", arguments: {} } },
  ]) assert.equal((await mcp.rpc("tools/call", { name: "reach_execute", arguments: args })).isError, true);
});

test("discovery handles word order, whitespace and exact names without exposing another preset's tools", privateIngressTest, async t => {
  const f = await presetFixture(t);
  const agent = await f.join({ preset: "files", write: false, folders: [{ root: 0, path: "Desktop/Project" }] });
  for (const query of ["read file", "FILE READ", "  read   file  ", "read_file", "reach_read_file"]) {
    const result = await agent.as(`/api/browser/mcp/discover?query=${encodeURIComponent(query)}`);
    assert.equal(result.status, 200);
    assert.equal(result.body.tools[0]?.name, "reach_read_file", query);
  }
  for (const query of ["shell", "change file", "press control"]) {
    const result = await agent.as(`/api/browser/mcp/discover?query=${encodeURIComponent(query)}`);
    assert.ok(result.body.tools.every(tool => !["reach_shell", "reach_change_file", "reach_press", "reach_act"].includes(tool.name)), query);
  }
  const exact = await agent.as("/api/browser/mcp/discover?name=reach_shell");
  assert.deepEqual(exact.body.tools, []);
});

test("an Apps agent navigates and verifies in one call, receives a completed-action receipt when observation fails, and stops on revoke", privateIngressTest, async t => {
  let actions = 0, reads = 0, failRead = false;
  const f = await presetFixture(t, { desktopExtras: {
    openUrl: async (_client, url, _browser, authorize) => { authorize(); actions++; assert.equal(url, "https://example.test/"); return { ok: true }; },
    act: async (_client, _action, authorize) => { authorize(); actions++; return { ok: true }; },
    elements: async (_client, authorize) => { authorize(); reads++; if (failRead) throw Object.assign(Error("Fixture observation unavailable"), { status: 503, kind: "unavailable" }); return { snapshot: `s${reads}`, app: "Browser", title: "Ready", items: [], texts: [] }; },
  } });
  const agent = await f.join({ preset: "apps", apps: [{ id: apps.chrome.id }] });
  const mcp = agentMcp(t, agent);
  await mcp.rpc("tools/list");
  const before = mcp.requests.length;
  const result = await mcp.call("reach_open_url", { url: "https://example.test/", browser: apps.chrome.id, waitFor: { text: "Ready" }, observe: true });
  assert.equal(result.found, true);
  assert.match(result.screen.text, /Ready/);
  assert.equal(mcp.requests.length - before, 1);
  assert.equal(reads, 1);
  failRead = true;
  const receipt = await mcp.call("reach_act", { action: { type: "key", key: "tab" }, observe: true });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.observationFailed, true);
  assert.equal(actions, 2, "failed observation must never repeat completed input");
  f.reach.auth.revoke(agent.created.clientId);
  const revoked = await mcp.rpc("tools/call", { name: "reach_act", arguments: { action: { type: "key", key: "enter" } } });
  assert.equal(revoked.isError, true);
  assert.equal(actions, 2);
});

test("tool safety hints distinguish observations, arbitrary effects and local file changes", () => {
  const access = { preset: "full", screen: true, control: true, open: true, shell: true, write: true, roots: [{ index: 0 }], terminals: [], browserTools: { browsers: ["Chrome"], tools: [{ protocol: "reach.tool.v1", id: "sample", title: "Sample", description: "Sample", inputs: {}, steps: [] }] } };
  const tools = new Map(toolsFor(presetScopes(access), access).map(tool => [tool.name, tool]));
  for (const name of ["reach_act", "reach_press", "reach_fill", "reach_open_file", "reach_run_mac_shortcut", "reach_shell", "reach_tool_sample", "reach_tool_batch"]) {
    assert.equal(tools.get(name)?.annotations.readOnlyHint, false, name);
    assert.equal(tools.get(name)?.annotations.destructiveHint, true, name);
    assert.equal(tools.get(name)?.annotations.openWorldHint, true, name);
  }
  for (const name of ["reach_access", "reach_discover", "reach_read_file", "reach_list_files"]) {
    assert.equal(tools.get(name).annotations.readOnlyHint, true, name);
    assert.equal(tools.get(name).annotations.openWorldHint, false, name);
  }
  assert.equal(tools.get("reach_change_file").annotations.destructiveHint, true);
  assert.equal(tools.get("reach_change_file").annotations.openWorldHint, false);
});

test("a connected MCP agent loses removed tools immediately and can discover its remaining access", privateIngressTest, async t => {
  let inputs = 0;
  const f = await presetFixture(t, { desktopExtras: {
    act: async (_client, _action, authorize) => { authorize(); inputs++; return { ok: true }; },
  } });
  const agent = await f.join({ preset: "full" });
  const mcp = agentMcp(t, agent);
  assert.ok((await mcp.rpc("tools/list")).tools.some(tool => tool.name === "reach_act"));
  await mcp.call("reach_act", { action: { type: "key", key: "tab" } });
  const change = await f.call(`/api/guests/${agent.created.clientId}/access`, { method: "POST", body: { preset: "readonly", folders: "keep" } });
  assert.equal(change.status, 200, JSON.stringify(change.body));
  const denied = await mcp.rpc("tools/call", { name: "reach_act", arguments: { action: { type: "key", key: "enter" } } });
  assert.equal(denied.isError, true);
  assert.equal(inputs, 1);
  assert.equal((await mcp.call("reach_access")).preset, "readonly");
  assert.ok(mcp.notifications.some(message => message.method === "notifications/tools/list_changed"));
  assert.deepEqual((await mcp.call("reach_discover", { name: "reach_act" })).tools, []);
  const remaining = (await mcp.rpc("tools/list")).tools;
  assert.ok(remaining.some(tool => tool.name === "reach_screenshot"));
  assert.ok(!remaining.some(tool => tool.name === "reach_act"));
});

test("malformed MCP arguments cannot become an empty-argument action", async () => {
  const input = new PassThrough(), output = new PassThrough();
  let calls = 0, text = "";
  output.on("data", chunk => { text += chunk; });
  const served = serveMcp({ input, output, scopes: ["browser:read"], liveScopes: false, api: async () => { calls++; return {}; } });
  for (const [id, args] of [null, false, 0, "", [], "unexpected"].entries()) {
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "reach_discard_shortcut", arguments: args } }) + "\n");
  }
  input.end();
  await served;
  const replies = text.trim().split("\n").map(JSON.parse);
  assert.equal(replies.length, 6);
  assert.ok(replies.every(reply => reply.error?.code === -32602));
  assert.equal(calls, 0, "invalid arguments never dispatch or look up a tool");
});
