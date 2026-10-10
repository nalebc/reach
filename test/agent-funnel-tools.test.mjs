import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { hooks, join, open } from "../scripts/agent-remote.mjs";
import { agentKey, funnelApi, funnelGateway } from "../scripts/agent-funnel.mjs";
import { callTool } from "../scripts/mcp-server.mjs";

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

test("a terminal agent joins through the public link with no Tailscale key, then uses Reach's tools", { skip: process.platform === "win32", timeout: 30000 }, async (t) => {
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

// One Tools invite, the route chosen where the agent runs (Oct 10, Muse from
// a sandbox that can't reach Tailscale's control plane): an invitation made
// for the tailnet (an invite key) is opened through the public link at once,
// with the agent's own key and the owner's code as for any public-link agent,
// while the tailnet joins in the background. Nothing waits for it.
const keyLink = (grant) => `${ORIGIN}/agent#k=tskey-auth-abc123def456&h=rg-ab12-abcdefghij&i=${encodeURIComponent(`${ORIGIN}:8443~${grant.invitation}`)}`;
const quiet = async (work) => {
  const out = [], err = [];
  const stdout = process.stdout.write, stderr = process.stderr.write;
  process.stdout.write = (chunk, ...rest) => (out.push(String(chunk)), typeof rest.at(-1) === "function" && rest.at(-1)(), true);
  process.stderr.write = (chunk, ...rest) => (err.push(String(chunk)), typeof rest.at(-1) === "function" && rest.at(-1)(), true);
  try { return { result: await work(), out: out.join(""), err: err.join("") }; }
  finally { process.stdout.write = stdout; process.stderr.write = stderr; }
};
const approving = (t, f, grant) => {
  const timer = setInterval(() => {
    const waiting = f.reach.auth.listAgentAdmissions().find((entry) => entry.clientId === grant.clientId);
    if (waiting) f.reach.auth.decideAgentAdmission(waiting.requestId, "approve");
  }, 50);
  t.after(() => clearInterval(timer));
  return timer;
};
// A node as the agent's tailnet client offers it, reaching the computer's
// private address (the fixture's tailnet source).
const fakeNode = (f) => ({
  used: 0,
  fetch({ url, method, headers, body }) {
    const node = this;
    const response = new Promise((resolve, reject) => {
      const pairs = {};
      for (let index = 0; index < headers.length; index += 2) pairs[headers[index]] = headers[index + 1];
      const target = new URL(url);
      const req = http.request({ socketPath: f.socketPath, path: target.pathname, method, headers: { ...pairs, Host: "localhost", "X-Forwarded-Host": target.host, "X-Forwarded-For": "100.64.0.20" } }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          node.used++;
          const bytes = Buffer.concat(chunks);
          let given = false;
          resolve({ status: res.statusCode, headers: Object.entries(res.headers).flat(), read: async () => { if (given) return null; given = true; return new Uint8Array(bytes); }, cancel() {} });
        });
      });
      req.once("error", reject);
      req.end(body ? Buffer.from(body) : undefined);
    });
    return { response, abort() {} };
  },
});
const invitedForTailnet = (f) => f.reach.auth.inviteBrowser({ name: "Muse", transport: "tailnet", preset: "files", folders: [{ root: 0, path: "work" }], ttlSeconds: 3600 });
test("a Tools invitation made for the tailnet is opened through the public link at once; the tailnet joins behind", { skip: process.platform === "win32", timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const grant = invitedForTailnet(f);
  const window = f.reach.funnelWindow();
  assert.equal(window.open, true, "its unopened invitation keeps the start page and the gateway up");
  assert.equal(window.reason, "invitation");
  const home = path.join(f.root, "muse-home");
  process.env.REACH_AGENT_HOME = home;
  t.after(() => { delete process.env.REACH_AGENT_HOME; });
  const timer = approving(t, f, grant);
  // Tailscale can't be reached from here: the join fails on its own time.
  let tried = 0;
  const { result, out, err } = await quiet(() => join({ _: ["join", keyLink(grant)], send: f.send,
    connect: () => { tried++; return new Promise((_, reject) => setTimeout(() => reject(Error("Couldn't join the tailnet (state: starting). Check this machine's internet connection.")), 300)); } }));
  clearInterval(timer);
  assert.equal(result, 0);
  assert.equal(tried, 1, "the tailnet join was started");
  assert.match(out, /Connected to Fixture Mac \(through its public link\)/);
  assert.match(err, /joining the owner's tailnet in the background/);
  assert.match(err, /Couldn't join the tailnet.*the public link for now/s);
  const conn = path.join(home, "mac");
  const credential = JSON.parse(fs.readFileSync(path.join(conn, "credential.json"), "utf8"));
  assert.equal(credential.via, "funnel");
  assert.equal(credential.origin, ORIGIN);
  assert.equal(credential.private, `${ORIGIN}:8443`);
  assert.equal(credential.invitation, grant.invitation, "its link reconnects it");
  assert.equal(credential.tailnetKey, "tskey-auth-abc123def456", "the key is kept for the background join while it's good");
  assert.ok(credential.tailnetKeyUntil > Date.now());
  assert.equal(credential.tailnet, undefined);
  // On the Mac: a public-link agent from here on, its link kept for its key.
  const record = f.reach.auth.list().find((c) => c.id === grant.clientId);
  assert.equal(record.browserTransport, "funnel");
  assert.equal(record.relink, true);
  assert.equal(record.status, "accepted");
  // Its tools, through the public link.
  const key = agentKey(conn);
  const api = funnelApi({ conn, credential, key, gateway: funnelGateway(ORIGIN, key, { send: f.send }) });
  assert.match(JSON.stringify(await callTool(api, "reach_list_files", { root: 0, path: "" }, await api("/api/browser"))), /brief\.txt/);
  // The same invitation can't be opened over the tailnet any more.
  assert.throws(() => f.reach.auth.redeemGuest(grant.invitation, { nodeId: "n1", userId: "", tagged: true, validUntil: Date.now() + 60_000 }), { status: 401 });
  // The agent's MCP server later: the join goes on in a process of its own
  // (stood in for here) while calls take the public link; when it has
  // registered the node, the node comes up in the server and calls move over.
  const real = { ...hooks };
  t.after(() => Object.assign(hooks, real));
  let spawned = 0, nodeAsked = 0;
  hooks.startTailnetJoin = () => { spawned++; return true; };
  const node = fakeNode(f);
  hooks.connectTailnet = async () => { nodeAsked++; return node; };
  hooks.send = f.send;
  const opened = await open(home, "mac", false, { tailnet: true });
  assert.equal(spawned, 1, "the background join was started in its own process");
  assert.equal(nodeAsked, 0, "no node in the server until the join has registered it");
  f.sent.length = 0;
  assert.ok((await opened.api("/api/browser")).roots);
  assert.deepEqual(f.sent, [`${ORIGIN}:8443`, ORIGIN], "the public link meanwhile");
  // The child registered the node and said so in the credential.
  const joined = JSON.parse(fs.readFileSync(path.join(conn, "credential.json"), "utf8"));
  delete joined.tailnetKey;
  delete joined.tailnetKeyUntil;
  joined.tailnet = "joined";
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(path.join(conn, "credential.json"), JSON.stringify(joined, null, 2));
  f.sent.length = 0;
  assert.ok((await opened.api("/api/browser")).roots, "this call sees it and starts the node; the public link still");
  assert.equal(nodeAsked, 1);
  await new Promise((resolve) => setImmediate(resolve));
  f.sent.length = 0;
  assert.ok((await opened.api("/api/browser")).roots);
  assert.equal(node.used, 1, "then through the node");
  assert.deepEqual(f.sent, []);
});

test("once the agent's node is up, calls move to the computer's private address through it; the public link while it's down", { skip: process.platform === "win32", timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const grant = invitedForTailnet(f);
  const home = path.join(f.root, "muse-home");
  process.env.REACH_AGENT_HOME = home;
  t.after(() => { delete process.env.REACH_AGENT_HOME; });
  const node = fakeNode(f);
  // The join: the node comes up while the owner answers.
  const timer = approving(t, f, grant);
  const { result, err } = await quiet(() => join({ _: ["join", keyLink(grant)], send: f.send, connect: async () => node }));
  clearInterval(timer);
  assert.equal(result, 0);
  assert.match(err, /on the owner's tailnet too/);
  const conn = path.join(home, "mac");
  const credential = JSON.parse(fs.readFileSync(path.join(conn, "credential.json"), "utf8"));
  assert.equal(credential.tailnet, "joined");
  assert.equal(credential.tailnetKey, undefined, "the key is spent");
  // Later, the agent's MCP server: the node is brought up in the background;
  // the first call goes through the public link, the next ones through the node.
  const real = { ...hooks };
  t.after(() => Object.assign(hooks, real));
  hooks.send = f.send;
  let release;
  hooks.connectTailnet = () => new Promise((resolve) => { release = () => resolve(node); });
  const opened = await open(home, "mac", false, { tailnet: true });
  f.sent.length = 0;
  assert.ok((await opened.api("/api/browser")).roots, "the public link, before the node is up");
  assert.deepEqual(f.sent, [`${ORIGIN}:8443`, ORIGIN], "the private address on the host's own network first, then the public link");
  assert.equal(node.used, 0);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  f.sent.length = 0;
  assert.ok((await opened.api("/api/browser")).roots);
  assert.equal(node.used, 1, "through the node, at once");
  assert.deepEqual(f.sent, [], "nothing on the host's own network");
  assert.ok((await opened.api("/api/browser")).roots);
  assert.equal(node.used, 2);
  // A one-off command (no MCP server holding the folder) stays on the public
  // link rather than starting a node of its own.
  const once = await open(home, "mac", false);
  f.sent.length = 0;
  assert.ok((await once.api("/api/browser")).roots);
  assert.equal(node.used, 2);
  assert.deepEqual(f.sent, [`${ORIGIN}:8443`, ORIGIN]);
});
