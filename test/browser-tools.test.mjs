import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import http from "node:http";
import { browserToolsFor, browserToolRequest } from "../server/browser-tools.mjs";
import { serveMcp, toolsFor } from "../scripts/mcp-server.mjs";
import { createAgentClient } from "../scripts/agent-client.mjs";
import { tailnetApi } from "../scripts/agent-remote.mjs";

const access = (overrides = {}) => ({ name: "Mac", expiresAt: Date.now() + 60000, roots: [{ index: 2, name: "Project", path: "/shared" }], terminals: [{ id: "reach:build", name: "Build" }], screen: "ask", ...overrides });
const names = (value) => browserToolsFor(value).map((tool) => tool.name);
const batch = (actions) => ({ actions, reason: "Inspect this project" });

test("catalog exposes only the current resources and approval capabilities", () => {
  assert.deepEqual(names(access({ roots: [], terminals: [], screen: "off" })), ["reach_access"]);
  assert.ok(names(access({ screen: "scroll" })).includes("reach_scroll"));
  assert.ok(!names(access()).includes("reach_scroll"));
  assert.ok(!names(access({ screen: "view" })).includes("reach_request_batch"));
  const terminal = browserToolsFor(access({ screen: "off", restrictedTerminal: true })).find((tool) => tool.name === "reach_request_batch");
  assert.equal(terminal.inputSchema.properties.actions.items.oneOf[0].properties.type.enum[0], "terminal");
  assert.equal(terminal.example.actions[0].root, 2);
  assert.equal(terminal.approvalRequired, true);
  assert.ok(names(access()).every((name) => !/invite|approve|grant|run_command|write|create/.test(name)));
  const first = browserToolsFor(access());
  first[0].inputSchema.properties.route = {};
  assert.deepEqual(browserToolsFor(access())[0].inputSchema.properties, {}, "schemas cannot mutate the shared catalog");
});

test("fixed tool requests validate roots, paths, terminal IDs, exact shapes and encoded searches", () => {
  assert.deepEqual(browserToolRequest("reach_search_files", { root: 2, query: "x&root=0" }, access()), { method: "GET", route: "/api/browser/files/search?root=2&q=x%26root%3D0", response: "json" });
  assert.equal(browserToolRequest("reach_read_terminal", { id: "reach:build" }, access()).route, "/api/browser/terminals/reach%3Abuild");
  for (const [name, args] of [
    ["reach_access", { route: "/api/agents/browser-invitations" }],
    ["reach_list_files", { root: 0 }],
    ["reach_read_file", { root: 2, path: "../secret" }],
    ["reach_read_file", { root: 2, path: "/secret" }],
    ["reach_read_file", { root: 2, path: "C:\\secret" }],
    ["reach_read_file", { root: 2, path: "a\\..\\secret" }],
    ["reach_read_terminal", { id: "reach:unshared" }],
    ["reach_cancel_request", { id: ".." }],
    ["reach_cancel_request", { id: "../../agents" }],
    ["reach_access", []],
    ["reach_access", null],
    ["reach_access", JSON.parse('{"__proto__":{}}')],
    ["reach_scroll", { direction: "down" }],
    ["reach_run_command", { command: "sudo true" }],
  ]) assert.throws(() => browserToolRequest(name, args, access()), /Invalid tool|not available/, name);
  assert.throws(() => browserToolRequest("reach_access", Object.create({ inherited: "x" }), access()), /must be an object/);
  const getter = Object.defineProperty({}, "root", { enumerable: true, get() { throw Error("getter ran"); } });
  assert.throws(() => browserToolRequest("reach_list_files", getter, access()), /plain values/);
  assert.throws(() => browserToolRequest("reach_scroll", { direction: "down", amount: Infinity }, access({ screen: "scroll" })), /range/);
});

test("exact batches cap count, bytes, fields and action families and cannot become free control", () => {
  const input = batch([{ type: "click", x: 0.2, y: 0.3 }, { type: "text", text: "hello" }, { type: "key", key: "enter" }]);
  const plan = browserToolRequest("reach_request_batch", input, access());
  assert.deepEqual(plan, { route: "/api/browser/requests", method: "POST", response: "json", body: { type: "batch", ...input } });
  input.actions[1].text = "changed";
  assert.equal(plan.body.actions[1].text, "hello", "request plan is detached from caller values");
  for (const args of [
    batch([]), batch(Array(6).fill({ type: "key", key: "tab" })),
    batch([{ type: "command", command: "echo no" }]),
    batch([{ type: "batch", actions: [{ type: "key", key: "tab" }] }]),
    batch([{ type: "text", text: "x", reason: "nested" }]),
    batch([{ type: "click", x: 2, y: 0.3 }]),
    batch([{ type: "key", key: "meta" }]),
    batch([{ type: "terminal", root: 2, command: "pwd" }]),
    { ...batch([{ type: "key", key: "tab" }]), approveAll: true },
    { ...batch([{ type: "key", key: "tab" }]), reason: "  " },
    batch(Array(3).fill({ type: "text", text: "界".repeat(2000) })),
  ]) assert.throws(() => browserToolRequest("reach_request_batch", args, access()), /Invalid tool/);
  const customArray = [{ type: "key", key: "tab" }];
  customArray.toJSON = () => [{ type: "command", command: "sudo true" }];
  assert.throws(() => browserToolRequest("reach_request_batch", batch(customArray), access()), /array fields/);
  const restricted = access({ screen: "off", restrictedTerminal: true });
  assert.equal(browserToolRequest("reach_request_batch", batch([{ type: "terminal", root: 2, cwd: "src", command: "ls" }]), restricted).body.actions[0].cwd, "src");
  assert.throws(() => browserToolRequest("reach_request_batch", batch([{ type: "terminal", root: 2, command: "pwd" }, { type: "key", key: "tab" }]), restricted), /Invalid tool/);
  assert.throws(() => browserToolRequest("reach_request_action", { action: { type: "terminal", root: 2, cwd: "../", command: "pwd" }, reason: "read" }, restricted), /inside/);
});

test("MCP browser credentials offer only named scoped tools and reject guessed broad calls", async () => {
  const scopes = ["browser:read", "browser:request", "files:read", "exec", "files:write", "apps:drive"];
  const offered = toolsFor(scopes, access());
  assert.ok(offered.some((tool) => tool.name === "reach_request_batch"));
  assert.ok(!offered.some((tool) => /run_command|write_file|open_app/.test(tool.name)));
  assert.ok(!toolsFor(["browser:read"], access()).some((tool) => /request|files|read_file/.test(tool.name)));
  const calls = [];
  const api = async (route, method = "GET", body) => {
    calls.push({ route, method, body });
    if (route === "/api/browser") return access();
    if (route === "/api/device") return { access: { scopes } };
    if (route === "/api/browser/requests") return { id: "request-1", status: "pending" };
    if (route === "/api/browser/screen") return { image: "AA==", mimeType: "image/jpeg" };
    throw Error(`Unexpected route ${route}`);
  };
  const input = new PassThrough(), output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString(); });
  const served = serveMcp({ api, scopes, input, output });
  for (const message of [
    { id: 1, method: "tools/list" },
    { id: 2, method: "tools/call", params: { name: "reach_run_command", arguments: { command: "sudo true" } } },
    { id: 3, method: "tools/call", params: { name: "reach_request_batch", arguments: batch([{ type: "key", key: "tab" }]) } },
    { id: 4, method: "tools/call", params: { name: "reach_screen", arguments: {} } },
  ]) input.write(`${JSON.stringify(message)}\n`);
  input.end(); await served;
  const results = new Map(text.trim().split("\n").map((line) => { const value = JSON.parse(line); return [value.id, value.result]; }));
  assert.equal(results.get(2).isError, true);
  assert.equal(JSON.parse(results.get(3).content[0].text).status, "pending");
  assert.equal(results.get(4).content[0].type, "image");
  assert.ok(calls.every((call) => !/jobs|agents|drive/.test(call.route)));
});

test("native screen conversion is bounded and limited to the exact screen route", async (t) => {
  let mode = "image";
  const server = http.createServer((req, res) => {
    if (mode === "error") { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "Screen was revoked" })); }
    else if (mode === "large") { res.writeHead(200, { "content-type": "image/jpeg" }); res.end(Buffer.alloc(8 * 1024 * 1024 + 1)); }
    else { res.writeHead(200, { "content-type": mode === "html" ? "text/html" : "image/jpeg" }); res.end(Buffer.from([255, 216, 255, 217])); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const api = createAgentClient({ url: `http://127.0.0.1:${server.address().port}`, token: "a".repeat(43) }, { allowLocal: true });
  assert.deepEqual(await api("/api/browser/screen"), { image: "/9j/2Q==", mimeType: "image/jpeg" });
  await assert.rejects(api("/api/files/text"), /JSON|Unexpected/);
  mode = "html"; await assert.rejects(api("/api/browser/screen"), /unsupported screen/);
  mode = "error"; await assert.rejects(api("/api/browser/screen"), /revoked/);
  mode = "large"; await assert.rejects(api("/api/browser/screen"), /exceeds 8 MiB/);
});


test("native tailnet transport handles only bounded screen images and preserves JSON errors", async () => {
  let status = 200, mimeType = "image/jpeg", data = Buffer.from([255, 216, 255, 217]), cancelled = false;
  const node = { fetch() {
    let read = false;
    return { abort() {}, response: Promise.resolve({ status, headers: ["Content-Type", mimeType], read: async () => { if (read) return null; read = true; return data; }, cancel() { cancelled = true; } }) };
  } };
  const api = tailnetApi(node, "https://mac.tail.ts.net", "secret");
  assert.deepEqual(await api("/api/browser/screen"), { image: "/9j/2Q==", mimeType });
  await assert.rejects(api("/api/files/text"), /JSON|Unexpected/);
  mimeType = "text/html"; await assert.rejects(api("/api/browser/screen"), /unsupported screen/);
  mimeType = "application/json"; status = 403; data = Buffer.from(JSON.stringify({ error: "revoked" }));
  await assert.rejects(api("/api/browser/screen"), /revoked/);
  status = 200; mimeType = "image/png"; data = Buffer.alloc(8 * 1024 * 1024 + 1);
  await assert.rejects(api("/api/browser/screen"), /exceeds 8 MiB/); assert.equal(cancelled, true);
});
