import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { browserToolsFor, browserToolRequest, compactTools } from "../server/browser-tools.mjs";
import { browserAccessRoutes, browserRouteAllowed } from "../server/browser-access.mjs";
import { presetAccess, presetPolicy, presetScopes, presetRouteAllowed, validPresetPolicy, validatePresetInvitation } from "../server/agent-presets.mjs";
import { createFunnelAgentGateway, permittedPath } from "../server/funnel-agent.mjs";
import { createHostedMcp } from "../server/hosted-mcp.mjs";
import { callTool, serveMcp, toolsFor } from "../scripts/mcp-server.mjs";

// No local coding engine or Reach instance runs. HTTP, provider execution
// and credentials are stand-ins; schemas, policy, signatures, JSON-RPC and
// the browser's named dispatch handlers are production code.
const names = ["reach_start_coding_task", "reach_get_coding_task", "reach_list_coding_tasks", "reach_cancel_coding_task"];
const start = { requestId: "request_123", agent: "codex", task: "Explain the fixture code." };
const taskId = "task-123";
const origin = "https://mac.fixture.ts.net";
const sha = text => crypto.createHash("sha256").update(text).digest("base64url");
const connectorHash = text => crypto.createHash("sha256").update(text).digest("hex");
function client(preset = "full") {
  const policy = presetPolicy(validatePresetInvitation({ name: "Fixture", ttlSeconds: 600, preset,
    ...(preset === "apps" ? { apps: [{ id: "/Applications/Fixture.app" }] } : {}),
    ...(preset === "files" ? { folders: [{ root: 0, path: "" }] } : {}),
    ...(preset === "full" ? { fullControlVersion: 1 } : {}) }), preset === "apps" ? [] : [path.join(os.tmpdir(), "coding-task-project")]);
  assert.ok(validPresetPolicy(policy), "fixtures use valid current policies on this platform");
  return { id: "fixture-agent", kind: "agent", policy, scopes: presetScopes(policy), agentRoots: policy.roots, expiresAt: Date.now() + 600000 };
}
const view = c => ({ ...presetAccess(c), roots: c.agentRoots.map((p, index) => ({ index, path: p })), terminals: [] });
const offered = tools => tools.filter(tool => names.includes(tool.name));

test("Full control v1 and legacy codex discover the four coding tools with honest engine and mutation contracts", () => {
  const full = client(), browser = offered(toolsFor(full.scopes, view(full))), legacy = offered(toolsFor(["device", "codex"]));
  assert.deepEqual(browser.map(t => t.name), names);
  assert.deepEqual(legacy.map(t => t.name), names);
  assert.deepEqual(browser[0].inputSchema.properties.agent.enum, ["codex", "claude"]);
  assert.deepEqual(legacy[0].inputSchema.properties.agent.enum, ["codex"]);
  assert.equal(browser[0].inputSchema.additionalProperties, false);
  assert.match(browser[0].description, /same requestId/i);
  for (const tools of [browser, legacy]) {
    assert.equal(tools[0].annotations.readOnlyHint, false);
    assert.equal(tools[0].annotations.openWorldHint, true);
    assert.equal(tools[1].annotations.readOnlyHint, true);
    assert.equal(tools[2].annotations.readOnlyHint, true);
    assert.equal(tools[3].annotations.readOnlyHint, false);
  }
});

test("narrow presets, stale Full consent, downgraded scopes and non-codex legacy callers neither discover nor plan coding tools", () => {
  for (const preset of ["apps", "files", "readonly"]) {
    const c = client(preset), access = { ...view(c), fullControlVersion: 1 };
    assert.deepEqual(offered(toolsFor([...c.scopes, "codex"], access)), []);
    for (const name of names) assert.throws(() => browserToolRequest(name, name === names[0] ? start : {}, access), /not available/);
  }
  const full = client(), access = view(full);
  for (const version of [undefined, 0, 2]) assert.deepEqual(offered(browserToolsFor({ ...access, fullControlVersion: version })), []);
  assert.deepEqual(offered(toolsFor(full.scopes.filter(scope => scope !== "browser:shell"), access)), []);
  assert.deepEqual(offered(toolsFor(["device", "exec"])), []);
});

test("coding plans default only specified fields, preserve requestId and confine polling/cancellation to dedicated task routes", async () => {
  const access = view(client());
  assert.deepEqual(browserToolRequest(names[0], start, access), { route: "/api/coding-tasks", method: "POST", body: { ...start, root: 0, path: "", timeoutSeconds: 1800 }, response: "json" });
  assert.deepEqual(browserToolRequest(names[1], { id: taskId, after: 0, waitSeconds: 25 }, access), { route: `/api/coding-tasks/${taskId}?after=0&waitSeconds=25`, method: "GET", response: "json" });
  assert.deepEqual(browserToolRequest(names[2], {}, access), { route: "/api/coding-tasks", method: "GET", response: "json" });
  assert.deepEqual(browserToolRequest(names[3], { id: taskId }, access), { route: `/api/coding-tasks/${taskId}/cancel`, method: "POST", body: {}, response: "json" });
  const calls = [];
  await callTool(async (...args) => { calls.push(args); return {}; }, names[0], start);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].requestId, start.requestId);
  await assert.rejects(callTool(async () => assert.fail("legacy must not dispatch Claude"), names[0], { ...start, agent: "claude" }), /supported|available/);
});

test("coding schemas reject thread/config/approval injection, traversal and unbounded inputs before any dispatch", async () => {
  const access = view(client());
  for (const extra of [{ threadId: "owner-thread" }, { mode: "full-auto" }, { config: {} }, { approval: true }, { root: -1 }, { root: 0.5 },
    { path: "../other" }, { path: "C:\\private" }, { path: "/private" }, { requestId: "short" }, { requestId: "bad/id_123" },
    { task: " " }, { task: "x".repeat(16001) }, { title: "x".repeat(121) }, { title: "line\nbreak" }, { timeoutSeconds: 59 }, { timeoutSeconds: 3601 }])
    assert.throws(() => browserToolRequest(names[0], { ...start, ...extra }, access), /Invalid tool arguments/);
  for (const args of [{ id: ".." }, { id: "a/b" }, { id: "%2f" }, { id: taskId, after: -1 }, { id: taskId, waitSeconds: 26 }, { id: taskId, waitSeconds: 1.5 }])
    assert.throws(() => browserToolRequest(names[1], args, access), /Invalid tool arguments/);
  assert.throws(() => browserToolRequest(names[3], { id: taskId, approval: true }, access), /Invalid tool arguments/);
  const max = { ...start, requestId: "a".repeat(80), task: "x".repeat(16000), title: "x".repeat(120), timeoutSeconds: 3600 };
  assert.equal(browserToolRequest(names[0], max, access).body.task.length, 16000);
});

test("preset and Funnel allowlists permit only the four dedicated task routes, with bounded polling and no sessions exposure", () => {
  const full = client();
  const plans = [["POST", "/api/coding-tasks"], ["GET", "/api/coding-tasks"], ["GET", `/api/coding-tasks/${taskId}?after=0&waitSeconds=25`], ["POST", `/api/coding-tasks/${taskId}/cancel`]];
  for (const [method, route] of plans) {
    const inner = permittedPath(method, route);
    assert.ok(presetRouteAllowed(full, method, inner));
    for (const preset of ["apps", "files", "readonly"]) assert.equal(presetRouteAllowed(client(preset), method, inner), false);
    assert.equal(presetRouteAllowed({ ...full, kind: "device" }, method, inner), false);
    assert.equal(presetRouteAllowed({ ...full, policy: { ...full.policy, fullControlVersion: undefined } }, method, inner), false);
  }
  for (const [method, route] of [["DELETE", `/api/coding-tasks/${taskId}`], ["POST", `/api/coding-tasks/${taskId}/messages`], ["GET", "/api/sessions"],
    ["POST", "/api/sessions/codex/thread/messages"], ["GET", `/api/coding-tasks/${taskId}?waitSeconds=26`], ["GET", `/api/coding-tasks/${taskId}?after=-1`],
    ["GET", `/api/coding-tasks/${taskId}?after=1&after=2`], ["GET", `/api/coding-tasks/${taskId}?threadId=owner`], ["POST", "/api/coding-tasks?mode=full-auto"]])
    assert.throws(() => permittedPath(method, route), error => [400, 403].includes(error.status), `${method} ${route}`);
});

function browserHarness(initial) {
  let current = initial;
  const handlers = new Map(), calls = [];
  const projection = { id: taskId, status: "running", version: 1, summary: "Fixture", commands: [], changes: [], progress: [], needsOwner: false };
  const app = (req, res) => {
    const url = new URL(req.url, origin); req.query = Object.fromEntries(url.searchParams); req.path = url.pathname;
    if (!browserRouteAllowed(current, req.method, req.path.slice(4))) return res.status(403).json({ error: "Not allowed" });
    if (req.path.startsWith("/api/coding-tasks")) {
      calls.push({ method: req.method, path: req.url, body: req.body });
      if (req.method === "POST" && req.path === "/api/coding-tasks") res.status(202);
      return res.json(req.method === "GET" && req.path === "/api/coding-tasks" ? { tasks: [projection] } : projection);
    }
    const handler = handlers.get(`${req.method} ${req.path}`);
    if (typeof handler !== "function") return res.status(404).json({ error: "No fixture route" });
    Promise.resolve(handler(req, res)).catch(error => res.status(error.status || 500).json({ error: error.message }));
  };
  for (const method of ["get", "post", "delete"]) app[method] = (route, handler) => handlers.set(`${method.toUpperCase()} ${route}`, handler);
  browserAccessRoutes(app, { auth: {}, config: { name: "Fixture", publicOrigin: origin }, terminals: { list: () => [] }, desktopTerminals: { platform: "linux" }, screenAvailable: () => false });
  const request = (route, method = "GET", body) => new Promise(resolve => {
    const req = { url: route, originalUrl: route, method, body: body || {}, query: {}, headers: {}, reauthorize: () => current };
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { resolve({ status: this.statusCode, json: value }); return this; }, send(value) { return this.json(value); } };
    app(req, res);
  });
  const api = async (route, method, body) => {
    if (route.startsWith("/api/device")) return { access: { scopes: current.scopes } };
    const response = await request(route, method, body);
    if (response.status >= 400) throw Object.assign(Error(response.json.error), { status: response.status });
    return response.json;
  };
  return { request, api, calls, projection, change: next => { current = next; } };
}

async function stdio(api, scopes, messages) {
  const input = new PassThrough(), output = new PassThrough(), waiting = new Map();
  let buffered = "";
  output.on("data", chunk => {
    buffered += chunk;
    for (let at; (at = buffered.indexOf("\n")) >= 0;) {
      const message = JSON.parse(buffered.slice(0, at)); buffered = buffered.slice(at + 1);
      waiting.get(message.id)?.(message);
    }
  });
  const serving = serveMcp({ api, scopes, input, output });
  const answers = [];
  for (const message of messages) answers.push(await new Promise(resolve => { waiting.set(message.id, resolve); input.write(JSON.stringify(message) + "\n"); }));
  input.end(); await serving;
  return answers;
}
test("stdio uses the browser's named dispatcher once and does not replay a lost coding-task reply", async () => {
  const c = client(), h = browserHarness(c);
  const answers = await stdio(async (...args) => {
    const value = await h.api(...args);
    if (args[0].startsWith("/api/browser/mcp/call")) throw Object.assign(Error("Synthetic reply lost"), { status: 503 });
    return value;
  }, c.scopes, [{ id: 1, method: "tools/list" }, { id: 2, method: "tools/call", params: { name: names[0], arguments: { ...start, agent: "claude" } } }]);
  assert.deepEqual(offered(answers[0].result.tools).map(t => t.name), names);
  assert.equal(answers[1].result.isError, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].body.agent, "claude");
  assert.equal(h.calls[0].body.requestId, start.requestId);
});

test("browser discovery, compact execution and plan handlers retain eligibility and the strict coding schema", async () => {
  const h = browserHarness(client());
  const listed = await h.api("/api/browser/mcp/tools");
  assert.deepEqual(offered(listed.tools).map(t => t.name), names);
  assert.ok(!offered(compactTools(listed.tools)).length, "compact users discover the same strict tools by name");
  const discovered = await h.api(`/api/browser/mcp/discover?name=${names[0]}`);
  assert.equal(discovered.tools[0].inputSchema.additionalProperties, false);
  const plan = await h.api("/api/browser/mcp/plan", "POST", { name: names[0], arguments: start });
  assert.equal(plan.plan.route, "/api/coding-tasks");
  await h.api("/api/browser/mcp/call", "POST", { name: "reach_execute", arguments: { name: names[0], arguments: start } });
  assert.equal(h.calls.length, 1);
  assert.equal((await h.request("/api/browser/mcp/call", "POST", { name: names[0], arguments: { ...start, threadId: "owner" } })).status, 400);
  h.change(client("apps"));
  assert.equal((await h.request("/api/browser/mcp/plan", "POST", { name: names[0], arguments: start })).status, 400);
  assert.equal((await h.request("/api/coding-tasks", "POST", start)).status, 403);
  assert.equal(h.calls.length, 1);
});

class Response extends Writable {
  headers = {}; statusCode = 200; chunks = []; headersSent = false;
  _write(chunk, _encoding, done) { this.headersSent = true; this.chunks.push(Buffer.from(chunk)); done(); }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers = {}) { this.statusCode = status; for (const [name, value] of Object.entries(headers)) this.setHeader(name, value); this.headersSent = true; }
}
function httpRequest(handler, url, body, headers = {}) {
  const req = new PassThrough(), res = new Response();
  req.method = "POST"; req.url = url; req.socket = { remoteAddress: "127.0.0.1" };
  req.headers = { host: new URL(origin).host, origin, "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers };
  const answer = new Promise((resolve, reject) => { res.once("finish", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(res.chunks).toString()) })); res.once("error", reject); });
  assert.equal(handler(req, res), true); req.end(JSON.stringify(body));
  return answer;
}
test("signed Funnel and hosted MCP carry coding tasks through the same policy and browser dispatch boundaries", async () => {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }), publicKey = pair.publicKey.export({ format: "jwk" });
  const binding = sha(JSON.stringify({ crv: "P-256", kty: "EC", x: publicKey.x, y: publicKey.y }));
  const token = crypto.randomBytes(32).toString("base64url"), connector = crypto.randomBytes(32).toString("base64url");
  let c = { ...client(), browserTransport: "funnel", browserBinding: binding, hosted: true, connectorHash: connectorHash(connector) };
  const h = browserHarness(c);
  const auth = { funnelKeys: () => new Set([binding]), hostedKeys: () => new Set([binding]), hostedConnectors: () => new Map([[connectorHash(connector), {}]]),
    splitHostedToken: value => value === `${binding}.${token}` ? [binding, token] : null,
    verifyFunnel: (secret, key) => secret === token && key === binding ? c : null };
  const dispatch = async context => { const answer = await h.request(context.path, context.method, context.body); return { status: answer.status, headers: { "content-type": "application/json" }, bytes: Buffer.from(JSON.stringify(answer.json)) }; };
  const gateway = createFunnelAgentGateway({ auth, origin, device: () => ({}), dispatch: async (_req, res, context) => { const response = await dispatch(context); res.writeHead(response.status, response.headers); res.end(response.bytes); } });
  const signed = value => { const payload = JSON.stringify({ v: 1, audience: origin, issuedAt: Date.now(), nonce: crypto.randomBytes(24).toString("base64url"), operation: "request", token, ...value });
    return { payload, publicKey, signature: crypto.sign("sha256", Buffer.from(payload), { key: pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") }; };
  const run = await httpRequest(gateway, "/agent-gateway", signed({ method: "POST", path: "/api/coding-tasks", body: start }));
  assert.equal(run.status, 202); assert.equal(h.calls.length, 1);
  const hosted = createHostedMcp({ auth, origin, dataDir: path.join(os.tmpdir(), "coding-task-auth-fixture"), dispatch });
  try {
    const answer = await httpRequest(hosted.handle, `/mcp/${connector}`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: names[1], arguments: { id: taskId, after: 0, waitSeconds: 25 } } }, { authorization: `Bearer ${binding}.${token}` });
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.json.result.content[0].text), h.projection);
    assert.equal(h.calls[1].path, `/api/coding-tasks/${taskId}?after=0&waitSeconds=25`);
    c = { ...c, ...client("apps") }; h.change(c);
    assert.equal((await httpRequest(gateway, "/agent-gateway", signed({ method: "POST", path: "/api/coding-tasks", body: start }))).status, 403);
    assert.equal(h.calls.length, 2);
  } finally { hosted.close(); }
});
