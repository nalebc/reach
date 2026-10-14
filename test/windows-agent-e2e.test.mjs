import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createReach } from "../server/index.mjs";
import { createAgentDesktop } from "../server/agent-desktop.mjs";
import { cscCandidates, windowsHelper } from "../server/desktop-native.mjs";
import { ensurePrivateFolders } from "../server/windows-private-folder.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { newIngressKey } from "../server/tailscale-auth.mjs";
import { admitAgent } from "./helpers/agent-admission.mjs";
import { callTool, toContent } from "../scripts/mcp-server.mjs";

// Real Windows helpers and HTTP/MCP preset wiring, on a disposable runner.
// Tailscale identity/peer verification and the one fixture catalog entry are
// injected. No physical phone or tailnet is claimed. The medium launch uses
// Windows' SAFER token, as B's native suite does; it is not a UAC user session.
const enabled = process.platform === "win32" && process.env.CI === "true" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1";
const exec = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, name, ms = 30000) => {
  for (const end = Date.now() + ms; ; await sleep(100)) {
    const found = await check();
    if (found) return found;
    if (Date.now() >= end) throw Error(`Timed out waiting for ${name}`);
  }
};

test("Windows agents join with each preset, use real screen and file helpers, and stop when the owner takes control", {
  skip: !enabled && "a disposable Windows runner with its desktop", timeout: 300000,
}, async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-preset-e2e-")));
  const shared = fs.mkdtempSync(path.join(os.homedir(), "reach-preset-project-"));
  const state = path.join(dir, "private"), native = path.join(state, "native");
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(shared, "brief.txt"), "A synthetic project brief");
  fs.mkdirSync(path.join(shared, ".ssh"));
  fs.writeFileSync(path.join(shared, ".ssh", "key"), "synthetic private data");
  const folders = await ensurePrivateFolders({ protect: [state], check: [], nativeDir: native, helpers: [] });
  assert.equal(folders.ok, true, folders.reason);
  const csc = cscCandidates().find(file => fs.existsSync(file));
  const consoleFixture = path.join(dir, "fixture-console.exe"), app = path.join(dir, "document.exe");
  for (const [target, out] of [["exe", consoleFixture], ["winexe", app]])
    await exec(csc, ["/nologo", `/target:${target}`, `/out:${out}`,
      ...["System.dll", "System.Drawing.dll", "System.Windows.Forms.dll"].map(name => `/reference:${path.join(path.dirname(csc), name)}`),
      path.resolve("test/fixtures/windows/desktop-fixture.cs")], { windowsHide: true, timeout: 60000 });
  const launcher = spawn(consoleFixture, ["medium", app, "window", dir, "document", "Synthetic document", "ff8800", "180", "180", "700", "420", "topmost"], { stdio: "ignore", windowsHide: true });
  const extra = [];
  let target, reach;
  t.after(async () => {
    await reach?.close();
    if (target?.pid) await exec("taskkill.exe", ["/F", "/PID", String(target.pid)], { windowsHide: true }).catch(() => {});
    for (const item of extra) { await exec("taskkill.exe", ["/F", "/PID", String(item.pid)], { windowsHide: true }).catch(() => {}); item.child.kill(); }
    launcher.kill();
    await sleep(200);
    fs.rmSync(shared, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  target = JSON.parse(await until(() => {
    try { return fs.readFileSync(path.join(dir, "document.json"), "utf8"); } catch { return false; }
  }, "the fixture window"));
  const log = () => { try { return fs.readFileSync(path.join(dir, "document.log"), "utf8"); } catch { return ""; } };
  const login = "owner@example.test", ownerAccount = { userId: "42", login };
  const ips = { phone: "100.64.0.1", agent: "100.64.0.5" };
  reach = await createReach({ roots: [shared], dataDir: state, port: 0, screen: true, tailscaleOwner: ownerAccount,
    windowsSandboxHelper: () => windowsHelper("sandbox", { dir: native }),
    windowsDesktopHelper: () => windowsHelper("agent-desktop", { dir: native }),
    tailscaleIdentity: { lookup: async ip => ip === ips.phone
      ? { Node: { StableID: "phone", User: 42 }, UserProfile: { ID: 42, LoginName: login } }
      : { Node: { StableID: "agent", Tags: ["tag:agent"] } } },
    browserHostGuard: { lookup: async () => ({ BackendState: "Running", Self: { ID: "host", Online: true },
      Peer: { phone: { ID: "phone", OS: "iOS", UserID: 42, Online: true } } }) },
    agentDesktopFactory: (config, options) => {
      const desktop = createAgentDesktop(config, { ...options,
        spawnProcess: (file, args, settings) => spawn(consoleFixture, ["medium", file, ...args], settings),
      });
      // Only the picker entry is injected; every screen/input operation uses
      // Reach's production helper against the actual fixture process.
      desktop.catalog = async authorize => { authorize(); return [{ id: app, name: "Synthetic document", bundleId: "", running: true }]; };
      return desktop;
    },
  });
  const owner = reach.auth.issue("phone", ALL_SCOPES, "device", { tailscale: { nodeId: "phone", userId: "42" } });
  const key = newIngressKey();
  const port = await reach.listenKeyed({ key, peerCheck: { check: async () => true } });
  const request = (route, { token = owner.token, node = "phone", method = "GET", body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: `/r-${key}${route}`, method, headers: {
      Host: "localhost", "X-Forwarded-For": ips[node], "Tailscale-User-Login": login,
      Authorization: `Bearer ${token}`, "Content-Type": "application/json",
    } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        let value;
        if (String(res.headers["content-type"]).startsWith("image/")) value = { image: bytes.toString("base64"), mimeType: res.headers["content-type"] };
        else { try { value = JSON.parse(bytes); } catch { value = bytes.toString(); } }
        resolve({ status: res.statusCode, body: value });
      });
    });
    req.setTimeout(90000, () => req.destroy(Error("Preset request timed out")));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const options = await request("/api/agents/browser-options");
  assert.equal(options.status, 200);
  assert.equal(options.body.desktopAvailable, true);
  assert.equal(options.body.protectedFilesSupported, true);
  const clients = {};
  for (const preset of ["full", "apps", "files", "readonly"]) {
    const created = await request("/api/agents/browser-invitations", { method: "POST", body: {
      name: `Synthetic ${preset}`, preset, transport: "tailnet", ttlSeconds: 600,
      ...(preset === "full" ? { fullControlVersion: 1 } : {}),
      ...(preset === "apps" ? { apps: [{ id: app }] } : {}),
      ...(preset === "files" ? { folders: [{ root: 0, path: "" }], write: true } : {}),
    } });
    assert.equal(created.status, 201, `${preset}: ${JSON.stringify(created.body)}`);
    const joined = admitAgent(reach.auth, created.body.invitation, { nodeId: "agent", userId: "", tagged: true, validUntil: Date.now() + 600000 });
    const api = async (route, method = "GET", body) => {
      const result = await request(route, { token: joined.token, node: "agent", method, body });
      if (result.status >= 400) throw Object.assign(Error(result.body?.error || `HTTP ${result.status}`), { status: result.status,
        kind: result.body?.kind, retryInMs: result.body?.retryInMs });
      return result.body;
    };
    const access = await api("/api/browser");
    assert.equal(access.preset, preset);
    clients[preset] = { id: created.body.clientId, api, access };
  }
  const tool = (preset, name, args = {}) => {
    if (name === "reach_act") {
      const { describe, ...action } = args;
      args = { action, describe };
    }
    return callTool(clients[preset].api, name, args, clients[preset].access);
  };
  const displays = await clients.full.api("/api/browser/desktop/displays");
  const primary = (displays.displays || displays).find(d => d.main) || (displays.displays || displays)[0];
  const at = point => ({ x: (point[0] - primary.x) / primary.width, y: (point[1] - primary.y) / primary.height });
  const screenshot = await tool("full", "reach_screenshot");
  assert.equal(toContent(screenshot)[0].type, "image", "MCP receives a real screenshot");
  await tool("full", "reach_act", { type: "click", ...at(target.notes), describe: false });
  await tool("full", "reach_act", { type: "type", text: "café 日本", describe: false });
  await until(() => log().includes("café 日本"), "the typed text in the fixture");
  await tool("apps", "reach_screenshot");
  await until(async () => {
    try { await tool("apps", "reach_act", { type: "click", ...at(target.password), describe: false }); return true; }
    catch (error) { if (error.kind === "busy") return false; throw error; }
  }, "the full agent to release its input lease");
  // As on the Mac: the password box can be focused, but ordinary text is
  // refused there; a credential must use the vault's explicit secret path.
  await assert.rejects(tool("apps", "reach_act", { type: "type", text: "not a secret", describe: false }), e => e.status === 403);
  assert.ok(!log().includes("secret "), "no text reached the password field");
  const vault = path.join(dir, "bitwarden.exe");
  fs.copyFileSync(app, vault);
  const child = spawn(consoleFixture, ["medium", vault, "window", dir, "vault", "Password Manager", "2255ff", "720", "220", "300", "280", "topmost"], { stdio: "ignore", windowsHide: true });
  const protectedWindow = JSON.parse(await until(() => { try { return fs.readFileSync(path.join(dir, "vault.json"), "utf8"); } catch { return false; } }, "the protected fixture"));
  extra.push({ child, pid: protectedWindow.pid });
  await tool("apps", "reach_screenshot");
  await assert.rejects(tool("apps", "reach_act", { type: "click", ...at([protectedWindow.x+30, protectedWindow.y+protectedWindow.height-25]), describe: false }), e => e.status === 403);
  const file = await tool("files", "reach_read_file", { root: 0, path: "brief.txt" });
  assert.equal(file.text, "A synthetic project brief");
  await assert.rejects(tool("files", "reach_read_file", { root: 0, path: ".ssh/key" }), e => e.status === 403);
  const shellRoot = clients.full.access.roots.find(root => root.path.toLowerCase() === shared.toLowerCase());
  assert.ok(shellRoot, "Full control includes the synthetic project folder");
  const shell = await tool("full", "reach_shell", { command: "Write-Output 'synthetic shell result'", root: shellRoot.index, cwd: "" });
  assert.match(JSON.stringify(shell), /synthetic shell result/);
  assert.equal((await request("/api/browser/agents/pause", { method: "POST", body: { clientId: clients.full.id, paused: true } })).status, 200);
  await assert.rejects(tool("full", "reach_act", { type: "type", text: "never typed", describe: false }), e => [403, 423].includes(e.status));
  assert.equal((await request("/api/browser/agents/pause", { method: "POST", body: { clientId: clients.full.id, paused: false } })).status, 200);
  assert.equal((await request("/api/screen/control", { method: "POST", body: { enabled: true } })).status, 200);
  await assert.rejects(tool("full", "reach_act", { type: "type", text: "never typed", describe: false }), e => [403, 409, 423].includes(e.status));
  assert.equal((await request("/api/screen/control", { method: "POST", body: { enabled: false } })).status, 200);
  assert.equal((await request("/api/settings/pause", { method: "POST", body: { paused: true } })).status, 200);
  await assert.rejects(tool("full", "reach_act", { type: "type", text: "never typed", describe: false }), e => [403, 423, 503].includes(e.status));
  assert.ok(!log().includes("never typed"));
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/windows-agent-e2e.json", JSON.stringify({ presets: Object.keys(clients), nativeScreen: true, nativeInput: true,
    nativeFiles: true, nativeShell: true, pauseAndOwnerControl: true, injected: ["Tailscale identity and peer", "fixture catalog entry", "SAFER medium launch"], physicalPC: false }, null, 2));
});
