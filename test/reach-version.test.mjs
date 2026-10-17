import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createReach } from "../server/index.mjs";
import { createAuth, hostedConnector } from "../server/core.mjs";
import { createHostedMcp } from "../server/hosted-mcp.mjs";
import { callTool, serveMcp } from "../scripts/mcp-server.mjs";
import { buildAgent, inputsFile } from "../scripts/build-agent.mjs";
import { agentStamp } from "../scripts/setup-stamp.mjs";
import { admitAgent } from "./helpers/agent-admission.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const runtime = "a".repeat(64);
function directory(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-version-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}
async function versionOnly(t, file, flag) {
  const dir = directory(t), home = path.join(dir, "agent-state"), data = path.join(dir, "host-state");
  // A downloaded agent may sit beside another project's unrelated package.
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "99.99.99" }));
  const guard = path.join(dir, "local-only.mjs");
  fs.writeFileSync(guard, `
    import net from "node:net"; import http from "node:http"; import https from "node:https"; import dns from "node:dns";
    let attempts = 0;
    const forbidden = () => { attempts++; throw Error("Version diagnostics must not use a network or credential"); };
    process.on("exit", () => { if (attempts) process.exitCode = 97; });
    net.connect = net.createConnection = http.request = https.request = dns.lookup = globalThis.fetch = forbidden;
    import fs from "node:fs";
    const read = fs.readFileSync;
    fs.readFileSync = (file, ...args) => String(file).includes("must-not-read") ? forbidden() : read(file, ...args);
    const readAsync = fs.promises.readFile;
    fs.promises.readFile = (file, ...args) => String(file).includes("must-not-read") ? forbidden() : readAsync(file, ...args);
  `);
  const answer = await exec(process.execPath, ["--import", pathToFileURL(guard).href, file, flag], {
    cwd: dir, timeout: 15000, env: { ...process.env, REACH_AGENT_HOME: home, REACH_HOME: data,
      REACH_DATA: data, REACH_CREDENTIAL: path.join(dir, "must-not-read-credential.json") },
  });
  assert.equal(answer.stdout.trim(), version);
  assert.equal(answer.stderr, "");
  assert.equal(fs.existsSync(home), false, "version must not initialize agent state");
  assert.equal(fs.existsSync(data), false, "version must not initialize host state");
}

for (const name of ["agent-remote", "agent-cli"])
  for (const flag of ["--version", "-v"])
    test(`${name} ${flag} reports its package without credentials, network or state`, async t => {
      await versionOnly(t, path.join(root, "scripts", `${name}.mjs`), flag);
    });

test("the package version is captured at module startup in source and packaged layouts", async t => {
  const dir = directory(t), server = path.join(dir, "server"), manifest = path.join(dir, "package.json");
  fs.mkdirSync(server);
  const file = path.join(server, "reach-version.mjs");
  fs.copyFileSync(path.join(root, "server", "reach-version.mjs"), file);
  fs.writeFileSync(manifest, JSON.stringify({ version: "7.8.9-fixture" }));
  const loaded = await import(pathToFileURL(file).href);
  assert.equal(loaded.REACH_VERSION, "7.8.9-fixture");
  fs.writeFileSync(manifest, JSON.stringify({ version: "7.8.10-fixture" }));
  assert.equal(loaded.REACH_VERSION, "7.8.9-fixture", "installed files changing cannot relabel an already loaded process");
  const next = await exec(process.execPath, ["--input-type=module", "-e", `import { REACH_VERSION } from ${JSON.stringify(pathToFileURL(file).href)}; console.log(REACH_VERSION)`]);
  assert.equal(next.stdout.trim(), "7.8.10-fixture", "the next process loads the new package");
});

test("stdio initialize identifies the local implementation separately from the remote host and runtime SHA", async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = "";
  output.on("data", chunk => { text += chunk; });
  const remote = { reachVersion: "8.9.10-host", runtime, access: { scopes: ["device"] } };
  const served = serveMcp({ api: async () => remote, scopes: ["device"], input, output });
  input.end(JSON.stringify({ id: 1, method: "initialize", params: {} }) + "\n" +
    JSON.stringify({ id: 2, method: "tools/call", params: { name: "reach_device", arguments: {} } }) + "\n");
  await served;
  const messages = text.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(messages.find(message => message.id === 1).result.serverInfo.version, version);
  assert.deepEqual(JSON.parse(messages.find(message => message.id === 2).result.content[0].text), remote);
});

// Real HTTP and authentication with disposable state; no native screen,
// input, providers or running Reach instance participates in these checks.
test("health, reach_device and reach_access report the loaded host package and preserve its runtime SHA", async t => {
  const dir = directory(t), runtimeFile = path.join(dir, "served-agent.mjs");
  fs.writeFileSync(runtimeFile, "// Synthetic runtime, never executed.\n");
  const sha = crypto.createHash("sha256").update(fs.readFileSync(runtimeFile)).digest("hex");
  const reach = await createReach({ roots: [dir], dataDir: path.join(dir, "state"), screen: false, agentRuntimeFile: runtimeFile,
    agentDesktop: null, desktopTerminals: { platform: "linux", run: async () => assert.fail("No native terminal access") },
    browserCapture: async () => assert.fail("No screen capture"), browserInput: async () => assert.fail("No input"),
  });
  t.after(() => reach.close());
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${reach.server.address().port}`;
  const grant = reach.auth.inviteBrowser({ name: "Version fixture", ttlSeconds: 600, folders: [{ root: 0, path: "" }], terminalIds: [], screen: "off" });
  const access = admitAgent(reach.auth, grant.invitation);
  const apiFor = token => async route => {
    const response = await fetch(origin + route, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200, route);
    return response.json();
  };
  const api = apiFor(access.token);
  const preset = reach.auth.inviteBrowser({ name: "Preset version fixture", preset: "readonly", ttlSeconds: 600 });
  const presetAccess = admitAgent(reach.auth, preset.invitation);
  const presetBrowser = await callTool(apiFor(presetAccess.token), "reach_access", {});
  const health = await api("/api/health"), device = await callTool(api, "reach_device", {}), browser = await callTool(api, "reach_access", {});
  assert.deepEqual({ health: health.version, device: device.reachVersion, browser: browser.reachVersion, preset: presetBrowser.reachVersion },
    { health: version, device: version, browser: version, preset: version });
  assert.equal(device.runtime, sha);
  assert.equal(browser.runtime, sha);
  assert.equal(presetBrowser.runtime, sha);
});

test("hosted MCP initialize reports the host implementation version", async t => {
  const dir = directory(t), auth = createAuth({ dataDir: path.join(dir, "state"), roots: [dir], agentPolicyFile: path.join(dir, "policy.json") });
  const grant = auth.inviteBrowser({ name: "Hosted version fixture", transport: "funnel", preset: "readonly", hosted: true, standing: true });
  const key = crypto.randomBytes(32).toString("base64url"), connector = hostedConnector(grant.invitation);
  const claim = auth.claimHostedInvitation(key, { connector, clientId: "fixture-client" });
  auth.decideAgentAdmission(claim.requestId, "approve");
  const access = auth.pollFunnelAdmission(claim.requestId, claim.requestSecret, key);
  const hosted = createHostedMcp({ auth, origin: "https://mac.fixture.ts.net", requestHost: () => "mac.fixture.ts.net", dataDir: path.join(dir, "state"),
    dispatch: async () => assert.fail("Initialize must not dispatch an action"),
  });
  const server = http.createServer((req, res) => { if (!hosted.handle(req, res)) { res.statusCode = 404; res.end(); } });
  t.after(async () => { hosted.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/mcp/${connector}`, {
    method: "POST", headers: { Authorization: `Bearer ${key}.${access.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.serverInfo.version, version);
});

test("the standalone Node18-target bundle embeds its version and package changes invalidate its inputs", { timeout: 60000 }, async t => {
  const dir = directory(t), built = path.join(dir, "built"), download = path.join(dir, "download");
  fs.mkdirSync(built); fs.mkdirSync(download);
  const file = await buildAgent(path.join(built, "agent.mjs"));
  const downloaded = path.join(download, "agent.mjs");
  fs.copyFileSync(file, downloaded);
  await versionOnly(t, downloaded, "--version");
  const inputs = JSON.parse(fs.readFileSync(inputsFile(file), "utf8"));
  assert.ok(inputs.includes("package.json"), "changing the package version rebuilds the standalone agent");
  const synthetic = path.join(dir, "checkout");
  fs.mkdirSync(path.join(synthetic, "dist"), { recursive: true });
  fs.writeFileSync(path.join(synthetic, "dist", ".agent-inputs.json"), JSON.stringify(inputs));
  fs.writeFileSync(path.join(synthetic, "package.json"), JSON.stringify({ version: "7.8.9-fixture" }));
  const before = agentStamp(synthetic);
  fs.writeFileSync(path.join(synthetic, "package.json"), JSON.stringify({ version: "7.8.10-fixture" }));
  assert.notEqual(agentStamp(synthetic), before, "bootstrap sees a version-only package change");
});
