import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { join } from "../scripts/agent-remote.mjs";
import { agentKey, funnelApi, funnelGateway, tailnetAddress } from "../scripts/agent-funnel.mjs";
import { callTool, computerPlan, computerTools } from "../scripts/mcp-server.mjs";

// Tools over the public link: an agent in a terminal outside the owner's
// Tailscale network joins with one command and no Tailscale key, then uses
// Reach's tools with every request signed by its own key, through the same
// gateway the agent page uses. Here the internet is the private socket with
// Tailscale's Funnel mark.
const ORIGIN = "https://mac.fixture.ts.net";
const OWNER = { userId: "42", login: "owner@example.test" };

async function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-funnel-tools-")));
  const socketDir = fs.mkdtempSync("/tmp/reach-funnel-tools-");
  const socketPath = path.join(socketDir, "s");
  const shared = path.join(root, "shared");
  fs.mkdirSync(path.join(shared, "work"), { recursive: true });
  fs.writeFileSync(path.join(shared, "work", "brief.txt"), "the brief");
  const reach = await createReach({
    name: "Fixture Mac", roots: [shared], dataDir: path.join(root, "state"), agentPolicyFile: path.join(root, "state", "none.json"),
    publicOrigin: `${ORIGIN}:8443`, allowedOrigins: [ORIGIN], tailscaleOwner: OWNER,
    tailscaleIdentity: { lookup: async () => null },
  });
  await reach.listenPrivate(socketPath, { publicApp: (req, res) => reach.publicAgent(req, res) || (res.statusCode = 404, res.end(), true) });
  reach.setFunnelController(async () => {});
  t.after(async () => {
    await reach.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(socketDir, { recursive: true, force: true });
  });
  // The internet, as Tailscale Funnel hands it to Reach; or, at the private
  // address, the owner's tailnet (no Funnel mark, a tailnet source), when
  // the test says that address answers.
  let privateAnswers = false;
  const sent = [];
  const send = (endpoint, body, headers) => new Promise((resolve, reject) => {
    sent.push(endpoint);
    const privately = endpoint.endsWith(":8443");
    if (privately && !privateAnswers) return reject(Object.assign(Error("connect EHOSTUNREACH"), { unreachable: true }));
    const req = http.request({ socketPath, path: "/agent-gateway", method: "POST",
      headers: { ...headers, Host: "localhost", "X-Forwarded-Host": new URL(endpoint).host,
        ...(privately ? { "X-Forwarded-For": "100.64.0.20" } : { "Tailscale-Funnel-Request": "?1", "X-Forwarded-For": "203.0.113.7" }) } },
    (res) => { const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) })); });
    req.once("error", reject);
    req.end(body);
  });
  const invite = () => reach.auth.inviteBrowser({ name: "Muse", transport: "funnel", preset: "files", folders: [{ root: 0, path: "work" }], write: true, ttlSeconds: 3600 });
  return { reach, send, invite, root, sent, socketPath, privately: (value) => { privateAnswers = value; } };
}

test("a terminal agent joins through the public link with no Tailscale key, then uses Reach's tools", { skip: process.platform !== "darwin" && "agent presets need macOS (its protected file and screen helpers)", timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const grant = f.invite();
  const home = path.join(f.root, "agent-home");
  process.env.REACH_AGENT_HOME = home;
  t.after(() => { delete process.env.REACH_AGENT_HOME; });
  const link = `${ORIGIN}/agent#i=${encodeURIComponent(`${ORIGIN}~${grant.invitation}`)}&t=funnel`;
  // The owner matches the code on the phone.
  const approve = setInterval(() => {
    const waiting = f.reach.auth.listAgentAdmissions().find((entry) => entry.clientId === grant.clientId);
    if (waiting) f.reach.auth.decideAgentAdmission(waiting.requestId, "approve");
  }, 50);
  t.after(() => clearInterval(approve));
  const writes = [];
  const stdout = process.stdout.write;
  process.stdout.write = (chunk, ...rest) => (writes.push(String(chunk)), typeof rest.at(-1) === "function" && rest.at(-1)(), true);
  try { assert.equal(await join({ _: ["join", link], send: f.send }), 0); }
  finally { process.stdout.write = stdout; clearInterval(approve); }
  assert.match(writes.join(""), /Connected to Fixture Mac \(through its public link\)/);
  const conn = path.join(home, "mac");
  const credential = JSON.parse(fs.readFileSync(path.join(conn, "credential.json"), "utf8"));
  assert.equal(credential.via, "funnel");
  assert.equal(fs.statSync(path.join(conn, "key.pem")).mode & 0o777, 0o600, "its own key, owner-only");
  assert.equal(fs.existsSync(path.join(conn, "tailnet-state.json")), false, "no Tailscale node at all");

  const key = agentKey(conn);
  const first = credential.token;
  const saved = [];
  const api = funnelApi({ conn, credential, key, gateway: funnelGateway(ORIGIN, key, { send: f.send }), save: (next) => saved.push(next.token) });
  // Its tools: what it may see and do, files in its folder.
  const device = await api("/api/device");
  assert.ok(device.access.scopes.includes("browser:read"));
  const access = await api("/api/browser");
  const listed = await callTool(api, "reach_list_files", { root: 0, path: "" }, access);
  assert.match(JSON.stringify(listed), /brief\.txt/);
  // Reach's own list and call plans pass the public link's door too: what
  // the agent offers is what Reach has now (mcp-server.mjs computerTools).
  const offered = await computerTools(api, (route) => `${route}?runtime=${"a".repeat(64)}`);
  assert.ok(offered?.tools.some((tool) => tool.name === "reach_list_files"), "Reach's list, not this copy's");
  const planned = await computerPlan(api, "reach_list_files", { root: 0, path: "" });
  assert.match(JSON.stringify(await api(planned.plan.route, planned.plan.method, planned.plan.body)), /brief\.txt/);
  // Nothing beyond its preset.
  await assert.rejects(api("/api/clients"), (e) => e.status === 403);
  // Its session ended (the owner reopened its link): the same key comes back at once.
  f.reach.auth.reopenBrowserInvitation(grant.clientId);
  assert.ok(await api("/api/browser"));
  assert.equal(saved.length, 1, "the new session is saved");
  assert.notEqual(saved[0], first);
  // Another computer with the same link: the owner's code, never the access.
  const other = funnelGateway(ORIGIN, agentKey(fs.mkdtempSync(path.join(f.root, "other-"))), { send: f.send });
  const asked = await other.claim(grant.invitation);
  assert.equal(asked.status, 202);
  assert.equal(asked.json.status, "pending");
  assert.notEqual(asked.json.refreshed, true);
  // Its own key takes its access back at once.
  assert.equal((await f.reach.auth.reconnectFunnelBrowser(grant.invitation, key.thumbprint)).refreshed, true);
});

test("on the owner's tailnet the private address is used, with the public link as the fallback; the same key either way", { skip: process.platform === "win32", timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const grant = f.invite();
  const conn = fs.mkdtempSync(path.join(f.root, "agent-"));
  const key = agentKey(conn);
  const endpoints = [`${ORIGIN}:8443`, ORIGIN];
  f.privately(true);
  const gateway = funnelGateway(ORIGIN, key, { send: f.send, endpoints });
  const claim = await gateway.claim(grant.invitation);
  assert.equal(claim.status, 202, JSON.stringify(claim.json));
  assert.equal(claim.endpoint, `${ORIGIN}:8443`, "joined through the tailnet");
  f.reach.auth.decideAgentAdmission(claim.json.requestId, "approve");
  const approved = await gateway.status(claim.json.requestId, claim.json.requestSecret);
  assert.equal(approved.json.status, "approved");
  const api = funnelApi({ conn, credential: { origin: ORIGIN, private: `${ORIGIN}:8443`, token: approved.json.token }, key, gateway });
  assert.ok((await api("/api/browser")).roots, "its tools, privately");
  assert.ok(f.sent.every((endpoint) => endpoint.endsWith(":8443")), "nothing went through the public link");
  // The tailnet goes away: the public link answers the same key at once.
  f.privately(false);
  assert.ok((await api("/api/browser")).roots);
  assert.equal(f.sent.at(-1), ORIGIN, "fell back to the public link");
  assert.equal(f.sent.at(-2), `${ORIGIN}:8443`, "after the private address was tried");
});

// Off the tailnet, the private name resolves to the public link's relay: the
// private address is used only when it resolves into the tailnet, so the
// agent never stalls on it, and only it is held to that (connections audit,
// Oct 10).
test("the private address counts only when it resolves into the tailnet; the public link is never held to that", async () => {
  for (const address of ["100.64.0.1", "100.107.161.117", "100.127.255.254", "fd7a:115c:a1e0::db33:a176"])
    assert.equal(tailnetAddress(address), true, address);
  for (const address of ["100.63.255.255", "100.128.0.1", "192.168.1.4", "127.0.0.1", "::1", "2001:db8::1", "not an address"])
    assert.equal(tailnetAddress(address), false, address);
  const held = [];
  const send = async (endpoint, body, headers, timeoutMs, { tailnetOnly }) => {
    held.push([endpoint, tailnetOnly]);
    if (tailnetOnly) throw Object.assign(Error("not on the tailnet"), { unreachable: true });
    return { status: 200, headers: {}, bytes: Buffer.from("{}") };
  };
  const key = agentKey(fs.mkdtempSync(path.join(os.tmpdir(), "reach-funnel-route-")));
  const gateway = funnelGateway(ORIGIN, key, { send, endpoints: [`${ORIGIN}:8443`, ORIGIN] });
  assert.equal((await gateway.status("r", "s")).endpoint, ORIGIN);
  assert.deepEqual(held, [[`${ORIGIN}:8443`, true], [ORIGIN, false]]);
  held.length = 0;
  await funnelGateway(ORIGIN, key, { send }).status("r", "s");
  assert.deepEqual(held, [[ORIGIN, false]], "the public link alone");
});

test("its credential is worth nothing without its key; leaving ends the access", { skip: process.platform === "win32", timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const grant = f.invite();
  const conn = fs.mkdtempSync(path.join(f.root, "agent-"));
  const key = agentKey(conn);
  const gateway = funnelGateway(ORIGIN, key, { send: f.send });
  const claim = await gateway.claim(grant.invitation);
  f.reach.auth.decideAgentAdmission(claim.json.requestId, "approve");
  const approved = await gateway.status(claim.json.requestId, claim.json.requestSecret);
  assert.equal(approved.json.status, "approved");
  const stranger = funnelGateway(ORIGIN, agentKey(fs.mkdtempSync(path.join(f.root, "x-"))), { send: f.send });
  const stolen = await stranger.request(approved.json.token, "GET", "/api/browser");
  assert.equal(stolen.status, 401, "its token is worth nothing without its key");
  const api = funnelApi({ conn, credential: { origin: ORIGIN, token: approved.json.token }, key, gateway });
  assert.ok(await api("/api/browser"));
  // Leaving ends it on the Mac.
  await api("/api/device/access", "DELETE");
  assert.ok(!f.reach.auth.list().some((c) => c.id === grant.clientId));
  await assert.rejects(api("/api/browser"), (e) => e.status === 401);
});

test("through the gateway, an agent trades its credential and the new one works; the old one ends", { skip: process.platform === "win32", timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const grant = f.invite();
  const conn = fs.mkdtempSync(path.join(f.root, "agent-"));
  const key = agentKey(conn);
  const gateway = funnelGateway(ORIGIN, key, { send: f.send });
  const claim = await gateway.claim(grant.invitation);
  f.reach.auth.decideAgentAdmission(claim.json.requestId, "approve");
  const approved = await gateway.status(claim.json.requestId, claim.json.requestSecret);
  const credential = { origin: ORIGIN, token: approved.json.token };
  const api = funnelApi({ conn, credential, key, gateway });
  const traded = await api("/api/device/rotate", "POST", {});
  assert.match(traded.token, /^[A-Za-z0-9_-]{43}$/);
  const fresh = funnelApi({ conn, credential: { origin: ORIGIN, token: traded.token }, key, gateway });
  assert.ok((await fresh("/api/browser")).roots, "the new credential works");
  assert.ok((await api("/api/browser")).roots, "the old one, for two minutes");
  // Another key can't trade this credential: with only a trading agent
  // holding the window, a stranger is shut out at the door, before the
  // gateway even sees the request.
  const stranger = funnelGateway(ORIGIN, agentKey(fs.mkdtempSync(path.join(f.root, "x-"))), { send: f.send });
  assert.equal((await stranger.request(traded.token, "POST", "/api/device/rotate", {})).status, 404);
});
