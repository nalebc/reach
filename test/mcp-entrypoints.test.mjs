import { nativeFiles, unavailableFiles, expectFileExecution } from "./helpers/protected-files.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { browserToolsFor } from "../server/browser-tools.mjs";
import { toolsFor, callTool } from "../scripts/mcp-server.mjs";
import { createAgentClient } from "../scripts/agent-client.mjs";
import { tailnetApi } from "../scripts/agent-remote.mjs";
import { presetFixture, privateIngressTest, apps } from "./helpers/preset-fixture.mjs";

const cli = fileURLToPath(new URL("../scripts/agent-cli.mjs", import.meta.url));
const remote = fileURLToPath(new URL("../scripts/agent-remote.mjs", import.meta.url));
const exec = promisify(execFile);

// Real HTTP, real stdio subprocesses and disposable filesystem state. Native
// screen/app input is forbidden; those adapters have separate boundary tests.
async function fixture(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reach-mcp-e2e-")));
  const shared = path.join(dir, "project"), dataDir = path.join(dir, "private");
  await fs.mkdir(shared);
  await fs.writeFile(path.join(shared, "task.txt"), "The answer is ORCHID-42.\n");
  const reach = await createReach({ roots: [shared], dataDir, screen: false,
    desktopTerminals: { platform: "linux", run: async () => assert.fail("No desktop terminal access") },
    browserCapture: async () => assert.fail("No desktop capture"),
    browserInput: async () => assert.fail("No desktop input"),
  });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("Audit owner", ALL_SCOPES);
  const children = new Set();
  t.after(async () => {
    const closing = [...children, ...reach.jobs.running.values()].map(child =>
      child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
        : new Promise(resolve => child.once("close", resolve)));
    for (const child of children) child.kill();
    await reach.close();
    let timer;
    try {
      await Promise.race([Promise.all(closing), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Fixture child processes did not exit")), 10000);
      })]);
    } finally { clearTimeout(timer); }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const call = async (route, { token = owner.token, method = "GET", body } = {}) => {
    const response = await fetch(url + route, { method, headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json",
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const join = async () => {
    const invited = await call("/api/agents/browser-invitations", { method: "POST", body: {
      name: "Same display name", ttlSeconds: 600, folders: [{ root: 0, path: "" }],
      screen: "off", restrictedTerminal: true, terminalApproval: true,
    } });
    assert.equal(invited.status, 201, JSON.stringify(invited.body));
    const claim = await call("/api/invitations/redeem", { token: "", method: "POST", body: { invitation: invited.body.invitation } });
    assert.equal(claim.status, 202, JSON.stringify(claim.body));
    assert.equal(claim.body.token, undefined);
    const approved = await call(`/api/agents/admissions/${claim.body.requestId}`, { method: "POST", body: { decision: "approve" } });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const collected = await call(`/api/invitations/claims/${claim.body.requestId}/status`, { token: "", method: "POST", body: { secret: claim.body.requestSecret } });
    assert.equal(collected.status, 200, JSON.stringify(collected.body));
    return collected.body;
  };
  const credentialFile = async credential => {
    const file = path.join(dir, credential.clientId + ".json");
    await fs.writeFile(file, JSON.stringify({ ...credential, url }), { mode: 0o600 });
    return file;
  };
  const mcp = async credential => {
    const file = await credentialFile(credential);
    const child = spawn(process.execPath, [cli, "mcp", "--credential", file, "--allow-local"], { stdio: ["pipe", "pipe", "pipe"] });
    children.add(child);
    let id = 0, stderr = "";
    const pending = new Map();
    child.stderr.on("data", chunk => { stderr += chunk; });
    readline.createInterface({ input: child.stdout }).on("line", line => {
      const result = JSON.parse(line), handler = pending.get(result.id);
      if (handler) { pending.delete(result.id); handler.resolve(result); }
    });
    child.on("error", error => { for (const value of pending.values()) value.reject(error); });
    child.on("exit", () => { children.delete(child); for (const value of pending.values()) value.reject(Error(stderr || "MCP exited")); });
    const request = (method, params) => new Promise((resolve, reject) => {
      const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(Error("MCP response timed out: " + method)); }, 15000);
      pending.set(next, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: next, method, ...(params ? { params } : {}) }) + "\n");
    });
    const tool = async (name, args = {}) => {
      const response = await request("tools/call", { name, arguments: args });
      assert.equal(response.error, undefined, JSON.stringify(response));
      assert.notEqual(response.result.isError, true, JSON.stringify(response.result));
      return JSON.parse(response.result.content.find(part => part.type === "text").text);
    };
    return { request, tool, file };
  };
  const remoteCli = async (credential, args) => {
    const home = path.join(dir, "remote-" + credential.clientId);
    const connection = path.join(home, "audit-computer");
    await fs.mkdir(connection, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(connection, "credential.json"), JSON.stringify({ ...credential, via: "direct", origin: url, computer: "Audit computer" }), { mode: 0o600 });
    return exec(process.execPath, [remote, ...args, "--allow-local"], { env: { ...process.env, REACH_AGENT_HOME: home }, timeout: 15000 });
  };
  return { reach, shared, call, join, mcp, credentialFile, remoteCli };
}

test("MCP exposes every granted browser tool, including commands and selected apps", async () => {
  const access = { roots: [{ index: 0 }], terminals: [{ id: "reach:test" }], screen: "apps", restrictedTerminal: true };
  const scopes = ["device", "files:read", "browser:read", "browser:request"];
  const expected = browserToolsFor(access);
  assert.deepEqual(toolsFor(scopes, access).map(tool => tool.name), expected.map(tool => tool.name));
  assert.equal(toolsFor(scopes, access).find(tool => tool.name === "reach_terminal_command").annotations.readOnlyHint, false);
  const routes = [];
  const api = async (route, method, body) => {
    routes.push({ route, method, body });
    return route === "/api/browser" ? access : { done: true };
  };
  for (const tool of expected) await callTool(api, tool.name, tool.example, access);
  for (const tool of expected.filter(tool => !["reach_list_files", "reach_read_file"].includes(tool.name)))
    await callTool(api, tool.name, tool.example);
  assert.ok(routes.some(value => value.route === "/api/browser/terminal" && value.method === "POST"));
  assert.ok(routes.some(value => value.route.startsWith("/api/browser/apps/screen?")));
  assert.ok(!toolsFor(["browser:read"], access).some(tool => ["reach_terminal_command", "reach_request_app"].includes(tool.name)));
});

test("two stdio agents enforce file capability, isolate approvals and honor revocation", async t => {
  const f = await fixture(t);
  const [first, second] = await Promise.all([f.join(), f.join()]);
  const [one, two] = await Promise.all([f.mcp(first), f.mcp(second)]);
  assert.match((await f.remoteCli(first, ["tools"])).stdout, /reach_terminal_command/);
  const called = await f.remoteCli(first, ["call", "reach_terminal_command", JSON.stringify({ root: 0, command: "cat task.txt" })]);
  expectFileExecution(JSON.parse(called.stdout), body => assert.match(body.output, /ORCHID-42/));
  const readTool = async (agent, name, args, verify) => {
    if (nativeFiles) verify(await agent.tool(name, args));
    else {
      const response = await agent.request("tools/call", { name, arguments: args });
      assert.equal(response.result.isError, true);
      assert.match(JSON.stringify(response.result.content), unavailableFiles);
      assert.doesNotMatch(JSON.stringify(response.result.content), /ORCHID-42/);
    }
  };
  // Native hosts review writes; other hosts still exercise two independent
  // pending owner approvals and must fail closed when the read is approved.
  const request = (agent, name) => nativeFiles
    ? agent.tool("reach_terminal_command", { root: 0, command: `touch ${name}` })
    : agent.tool("reach_request_action", { action: { type: "terminal", root: 0, command: "pwd" }, reason: "Read the shared folder" });
  for (const agent of [one, two]) {
    const initialized = await agent.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "reach-audit", version: "1" } });
    assert.equal(initialized.result.serverInfo.name, "reach");
    const list = await agent.request("tools/list");
    assert.ok(list.result.tools.some(tool => tool.name === "reach_terminal_command"), JSON.stringify(list));
    await readTool(agent, "reach_list_files", { root: 0, path: "" }, files => assert.ok(files.items.some(file => file.name === "task.txt")));
    await readTool(agent, "reach_read_file", { root: 0, path: "task.txt" }, body => assert.match(body.text, /ORCHID-42/));
    const command = await agent.tool("reach_terminal_command", { root: 0, command: "cat task.txt" });
    expectFileExecution(command, body => assert.match(body.output, /ORCHID-42/));
  }
  const [requestOne, requestTwo] = await Promise.all([
    request(one, "agent-one.txt"),
    request(two, "agent-two.txt"),
  ]);
  assert.equal(requestOne.status, "pending"); assert.equal(requestTwo.status, "pending");
  await assert.rejects(fs.access(path.join(f.shared, "agent-one.txt")));
  const cross = await two.request("tools/call", { name: "reach_cancel_request", arguments: { id: requestOne.id } });
  assert.equal(cross.result.isError, true);
  const selfApprove = await f.call(`/api/agents/browser-requests/${requestOne.id}`, { token: first.token, method: "POST", body: { decision: "approve", reviewedTerminalChange: true } });
  assert.equal(selfApprove.status, 403);
  const approved = await f.call(`/api/agents/browser-requests/${requestOne.id}`, { method: "POST", body: { decision: "approve", ...(nativeFiles ? { reviewedTerminalChange: true } : {}) } });
  expectFileExecution(approved.body);
  if (nativeFiles) await fs.access(path.join(f.shared, "agent-one.txt"));
  else await assert.rejects(fs.access(path.join(f.shared, "agent-one.txt")));
  const firstHistory = await one.tool("reach_terminal_history");
  assert.ok(firstHistory.every(record => record.clientId === first.clientId));
  assert.equal(firstHistory.find(record => record.id === requestOne.id).status, nativeFiles ? "executed" : "failed");
  // A write changes the reviewed filesystem: another agent must request fresh
  // approval instead of executing an action approved against stale contents.
  const stale = (await two.tool("reach_list_requests")).find(record => record.id === requestTwo.id);
  if (nativeFiles) {
    assert.equal(stale.status, "cancelled");
    assert.match(stale.error, /Another agent changed/);
  } else {
    assert.equal(stale.status, "pending", "a failed native read cannot change another agent's approval");
    await two.tool("reach_cancel_request", { id: stale.id });
  }
  const fresh = await request(two, "agent-two.txt");
  assert.equal(fresh.status, "pending");
  const revoked = await f.call(`/api/clients/${first.clientId}`, { method: "DELETE" });
  assert.equal(revoked.status, 200);
  const ended = await one.request("tools/call", { name: "reach_access", arguments: {} });
  assert.equal(ended.result.isError, true);
  await readTool(two, "reach_read_file", { root: 0, path: "task.txt" }, body => assert.match(body.text, /ORCHID-42/));
  assert.equal((await two.tool("reach_list_requests")).find(record => record.id === fresh.id).status, "pending");
  await two.tool("reach_cancel_request", { id: fresh.id });
  await assert.rejects(fs.access(path.join(f.shared, "agent-two.txt")));
});

test("direct HTTP and tailnet adapters return preset screenshots as MCP image content", async t => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
  const routes = [];
  const server = http.createServer((request, response) => {
    routes.push(request.url);
    response.writeHead(200, { "Content-Type": "image/jpeg" });
    response.end(jpeg);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const direct = createAgentClient({ url: `http://127.0.0.1:${server.address().port}`, token: "synthetic-credential-for-image-tests" }, { allowLocal: true, proxy: "" });
  const expected = { image: jpeg.toString("base64"), mimeType: "image/jpeg" };
  for (const route of ["/api/browser/desktop/screen", "/api/browser/desktop/screen?maxWidth=2560", "/api/browser/apps/screen?target=one-window"])
    assert.deepEqual(await direct(route), expected);
  // The tailnet transport is injected: this verifies its byte decoder, not a
  // real Tailscale connection. The direct client above uses real HTTP.
  const node = { fetch() {
    let consumed = false;
    return { abort() {}, response: Promise.resolve({ status: 200, headers: ["Content-Type", "image/jpeg"],
      read: async () => consumed ? undefined : (consumed = true, jpeg), cancel() {},
    }) };
  } };
  assert.deepEqual(await tailnetApi(node, "https://mac.audit.ts.net", "synthetic-token")("/api/browser/desktop/screen?maxWidth=2560"), expected);
  await assert.rejects(direct("/api/device"), /JSON|Unexpected/);
  await assert.rejects(direct("/api/browser/desktop/screen?maxWidth=2560&extra=1"), /JSON|Unexpected/);
  assert.equal(routes.length, 5);
});

test("CLI execution and MCP jobs report real output and enforce per-agent ownership", async t => {
  const f = await fixture(t);
  const first = f.reach.auth.issue("Job agent", ["device", "files:read", "exec"], "agent");
  const second = f.reach.auth.issue("Other job agent", ["device", "files:read", "exec"], "agent");
  const one = await f.mcp(first), two = await f.mcp(second);
  const command = path.join(f.shared, "job.sh");
  await fs.writeFile(command, process.platform === "win32" ? "[Console]::Write('REACH_JOB_OK')\n" : "printf 'REACH_JOB_OK'\n");
  const started = await exec(process.execPath, [cli, "exec", "--credential", one.file, "--allow-local", "--command-file", command]);
  const job = JSON.parse(started.stdout);
  let result;
  const deadline = Date.now() + 10000;
  do {
    result = await one.tool("reach_get_job", { id: job.id });
    if (result.status !== "running") break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.exitCode, 0); assert.equal(result.output, "REACH_JOB_OK");
  const cross = await two.request("tools/call", { name: "reach_get_job", arguments: { id: job.id } });
  assert.equal(cross.result.isError, true);
  const running = await one.tool("reach_run_command", { command: "sleep 30", timeoutMs: 60000 });
  await one.tool("reach_cancel_job", { id: running.id });
  assert.equal((await one.tool("reach_get_job", { id: running.id })).status, "cancelled");
});

test("preset remote CLI and stdio MCP discover apps, open the browser, and deliver screenshot bytes", privateIngressTest, async t => {
  const nativeCalls = [];
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
  const f = await presetFixture(t, { desktopExtras: {
    open: async (client, app, authorize) => { authorize(); nativeCalls.push(["open", client.id, app]); return { ok: true, app: "Google Chrome" }; },
    screenshot: async (client, authorize) => { authorize(); nativeCalls.push(["screen", client.id]); return { jpeg, width: 100, height: 60 }; },
    act: async (client, action, authorize) => { authorize(); nativeCalls.push(["act", client.id, action]); return { ok: true }; },
  } });
  const joined = await f.join({ preset: "apps", apps: [{ id: apps.chrome.id }] });
  // A loopback proxy represents the tested private ingress. Tailscale identity
  // lookup and native app IO are fixtures; HTTP, auth and adapter processes are real.
  const proxy = http.createServer((request, response) => {
    const upstream = http.request({ socketPath: f.socketPath, method: request.method, path: request.url,
      headers: { ...request.headers, host: "localhost", "x-forwarded-for": "100.64.0.5", "tailscale-user-login": "owner@example.test" },
    }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
    upstream.on("error", () => { response.writeHead(502); response.end(); });
    request.pipe(upstream);
  });
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { proxy.closeAllConnections(); proxy.close(resolve); }));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "reach-preset-cli-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const conn = path.join(home, "audit"); await fs.mkdir(conn);
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const credential = { ...joined.joined, origin, url: origin, via: "direct", computer: "Audit Mac" };
  const file = path.join(conn, "credential.json");
  await fs.writeFile(file, JSON.stringify(credential), { mode: 0o600 });
  const run = args => exec(process.execPath, [remote, ...args, "--allow-local"], { env: { ...process.env, REACH_AGENT_HOME: home }, timeout: 15000 });
  const list = await run(["tools"]);
  assert.match(list.stdout, /reach_open_app/); assert.match(list.stdout, /reach_screenshot/); assert.doesNotMatch(list.stdout, /reach_shell/);
  assert.equal(JSON.parse((await run(["call", "reach_open_app", JSON.stringify({ app: apps.chrome.id })])).stdout).ok, true);
  for (const action of [{ type: "click", x: 0.4, y: 0.5 }, { type: "type", text: "Reach browser task" }, { type: "key", key: "enter" }])
    assert.equal(JSON.parse((await run(["call", "reach_act", JSON.stringify({ action })])).stdout).ok, true);
  assert.deepEqual(nativeCalls.filter(call => call[0] === "act").map(call => call[2].type), ["click", "type", "key"]);
  const responses = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "mcp", "--credential", file, "--allow-local"]);
    let output = "", error = "";
    const timeout = setTimeout(() => { child.kill(); reject(Error("Preset MCP timed out")); }, 15000);
    child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => error += chunk);
    child.once("error", reject);
    child.once("close", code => { clearTimeout(timeout); code === 0 ? resolve(output.trim().split("\n").map(JSON.parse)) : reject(Error(error)); });
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "reach_screenshot", arguments: { maxWidth: 800 } } }) + "\n");
  });
  assert.deepEqual(responses[0].result.content[0], { type: "image", data: jpeg.toString("base64"), mimeType: "image/jpeg" });
  assert.equal(nativeCalls.at(-1)[0], "screen");
});
