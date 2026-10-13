import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createReach } from "../../server/index.mjs";
import { ALL_SCOPES } from "../../server/core.mjs";
import { admitAgent } from "./agent-admission.mjs";

// Preset invitations end to end: created from a pinned phone over the
// private listener, redeemed by the agent, and checked route by route. Native
// screen, input and app helpers are stand-ins; nothing touches this computer.
export const privateIngressTest = { skip: process.platform === "win32" && "Private ingress requires POSIX socket ownership and permissions" };
export const apps = {};
const chrome = { id: "/Applications/Google Chrome.app", name: "Google Chrome", bundleId: "com.google.Chrome", identity: "a".repeat(64), running: true };
const notes = { id: "/System/Applications/Notes.app", name: "Notes", bundleId: "com.apple.Notes", identity: "b".repeat(64) };
const onePassword = { id: "/Applications/1Password.app", name: "1Password", bundleId: "com.1password.1password", identity: "c".repeat(64) };
const terminal = { id: "/System/Applications/Utilities/Terminal.app", name: "Terminal", bundleId: "com.apple.Terminal", identity: "d".repeat(64) };
const messages = { id: "/System/Applications/Messages.app", name: "Messages", bundleId: "com.apple.MobileSMS", identity: "e".repeat(64) };
Object.assign(apps, { chrome, notes, onePassword, terminal, messages });
const ownerAccount = { userId: "42", login: "owner@example.test" };
const addresses = { nPhone: "100.64.0.1", nHost: "100.64.0.2", nWasm: "100.64.0.4", nAgent: "100.64.0.5" };

export async function presetFixture(t, { desktopAvailable = true, withDesktop = true, desktopExtras = {}, desktopFactory, agentShellRun, browserToolOptions, serviceOptions, macShortcuts, includeSystemRoot = false, ownerHold, overrides = {} } = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-presets-")));
  const socketDir = fs.mkdtempSync("/tmp/reach-presets-sock-");
  const socketPath = path.join(socketDir, "s"), dataDir = path.join(dir, "private");
  const home = path.join(dir, "home"), shared = path.join(dir, "shared");
  fs.mkdirSync(shared);
  fs.mkdirSync(path.join(home, "Desktop", "Project"), { recursive: true });
  fs.writeFileSync(path.join(home, "Desktop", "Project", "brief.txt"), "A project brief");
  // Private things an agent must never reach, even under Full control.
  fs.mkdirSync(path.join(home, ".reach"), { recursive: true });
  fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
  fs.writeFileSync(path.join(home, ".ssh", "id_rsa"), "secret");
  fs.writeFileSync(path.join(home, ".zshrc"), "export X=1");
  const cancelled = [];
  const desktop = {
    available: () => desktopAvailable,
    catalog: async (authorize) => { authorize(); return structuredClone([chrome, notes, onePassword, terminal, messages]); },
    cancelClient: (id) => cancelled.push(id),
    ...desktopExtras,
  };
  const reach = await createReach({
    roots: [home, includeSystemRoot ? path.parse(home).root : shared], dataDir, port: 0, screen: true, tailscaleOwner: ownerAccount, publicOrigin: "",
    browserScreenSupported: true, browserAppSupported: false,
    // Exercise preset admission/scopes independently of the host native file helper.
    browserFilesSupported: true,
    // A factory builds Reach's own desktop service with Reach's options (its
    // pause store among them); otherwise a stand-in, or none.
    ...(desktopFactory ? { agentDesktopFactory: desktopFactory } : { agentDesktop: withDesktop ? desktop : null }),
    ...(agentShellRun ? { agentShellRun } : {}),
    ...(browserToolOptions ? { browserToolOptions } : {}),
    ...(serviceOptions ? { serviceOptions } : {}),
    ...(macShortcuts !== undefined ? { macShortcuts } : {}),
    ...(ownerHold ? { ownerHold } : {}),
    // Stand-ins a test names for Reach's own parts (agentTimings, savings…).
    ...overrides,
    browserCapture: async () => assert.fail("Full desktop capture must not run"),
    browserInput: async () => assert.fail("Global desktop input must not run"),
    desktopTerminals: { platform: "linux", run: async () => assert.fail("Native terminal access is forbidden") },
    tailscaleIdentity: { lookup: async (ip) => {
      const nodeId = Object.keys(addresses).find((node) => addresses[node] === ip);
      assert.ok(nodeId, "only fixture Tailscale nodes exist");
      return nodeId === "nAgent" ? { Node: { StableID: nodeId, Tags: ["tag:agent"] } } :
        { Node: { StableID: nodeId, User: 42 }, UserProfile: { ID: 42, LoginName: ownerAccount.login } };
    } },
    browserHostGuard: { lookup: async () => ({ BackendState: "Running", Self: { ID: "nHost", Online: true },
      Peer: { phone: { ID: "nPhone", OS: "iOS", UserID: 42, Online: true }, wasm: { ID: "nWasm", OS: "js", UserID: 42, Online: true } } }) },
  });
  const owners = Object.fromEntries(["nPhone", "nHost", "nWasm"].map((nodeId) =>
    [nodeId, reach.auth.issue(nodeId, ALL_SCOPES, "device", { tailscale: { nodeId, userId: "42" } })]));
  t.after(async () => { await reach.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(socketDir, { recursive: true, force: true }); });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  await reach.listenPrivate(socketPath);
  const call = (route, { node = "nPhone", token = owners[node]?.token || "", method = "GET", body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method, headers: {
      Host: "localhost", "X-Forwarded-For": addresses[node], "Tailscale-User-Login": ownerAccount.login,
      ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", ...headers,
    } }, (res) => {
      const chunks = []; res.on("data", (chunk) => chunks.push(chunk)); res.once("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString(); let result; try { result = JSON.parse(text); } catch { result = text; }
        resolve({ status: res.statusCode, body: result });
      });
    });
    req.setTimeout(10000, () => req.destroy(Error("Fixture request timed out")));
    req.once("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  // Positive fixtures represent a current owner form that explicitly accepts
  // unrestricted Full control. Raw call() still tests stale/missing consent.
  const invite = (body, options = {}) => call("/api/agents/browser-invitations", { method: "POST", body: { name: "Muse", ttlSeconds: 600, ...(body.preset === "full" ? { fullControlVersion: 1 } : {}), ...body }, ...options });
  // Agents redeem over the ordinary listener; the admission gate is passed with the helper.
  const join = async (body) => {
    const created = await invite(body);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const joined = admitAgent(reach.auth, created.body.invitation, { nodeId: "nAgent", userId: "", tagged: true, validUntil: Date.now() + 60000 });
    const as = (route, options = {}) => call(route, { node: "nAgent", token: joined.token, ...options });
    return { created: created.body, joined, as };
  };
  return { reach, call, invite, join, home, shared, cancelled, socketPath, owners, addresses, ownerAccount };
}
