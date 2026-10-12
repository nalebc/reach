import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES, hostedConnector, openPairingWindow } from "../server/core.mjs";
import { validatePresetInvitation } from "../server/agent-presets.mjs";
import { newIngressKey } from "../server/tailscale-auth.mjs";

// Reach as an MCP server at a URL (server/hosted-mcp.mjs): a hosted agent
// (claude.ai, ChatGPT, Muse, Grok) adds the address its invitation shows,
// https://<the Mac>/mcp/<id>, as a custom connector, discovers OAuth under
// it, registers, and when it connects the owner matches its code in Reach, as
// for any agent. Each invitation has its own address: nothing at a shared one
// claims anything. Here the internet is the private socket with Tailscale's
// Funnel mark; the Mac's own routes listen on loopback, as they do when Reach
// runs.
const ORIGIN = "https://mac.fixture.ts.net";
const OWNER = { userId: "42", login: "owner@example.test" };
const CALLBACK = "https://agent.example/oauth/callback";
const posix = process.platform !== "win32";
const strangerId = () => crypto.randomBytes(32).toString("base64url");

const clock = (t) => {
  const real = Date.now;
  let offset = 0;
  t.mock.method(Date, "now", () => real() + offset);
  return (ms) => { offset += ms; };
};

// Each flow runs on both private routes: a Mac's Unix socket, and Windows'
// keyed loopback route (REACH_WINDOWS_ACCOUNT=1; docs/parity/D-public-door.md
// §7.2), whose door and gateway are the same. Not yet on a real Windows
// runner: its presets wait for workstream E.
const keyedRuns = new WeakSet();
const both = (name, options, fn) => {
  test(name, options, fn);
  test(`${name} (Windows keyed route)`, { ...options, skip: process.platform === "win32" ? "Windows' agent presets wait for workstream E" : options.skip }, (t) => (keyedRuns.add(t), fn(t)));
};

async function fixture(t) {
  const keyed = keyedRuns.has(t);
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-hosted-")));
  const socketDir = keyed ? "" : fs.mkdtempSync("/tmp/reach-hosted-");
  const socketPath = keyed ? "" : path.join(socketDir, "s");
  const shared = path.join(root, "shared");
  fs.mkdirSync(path.join(shared, "work"), { recursive: true });
  fs.writeFileSync(path.join(shared, "work", "brief.txt"), "the brief");
  const reach = await createReach({
    name: "Fixture Mac", roots: [shared], dataDir: path.join(root, "state"), agentPolicyFile: path.join(root, "state", "none.json"),
    publicOrigin: `${ORIGIN}:8443`, allowedOrigins: [ORIGIN], tailscaleOwner: OWNER,
    tailscaleIdentity: { lookup: async () => null },
    ...(keyed && { platform: "win32" }),
  });
  // The inner routes a hosted agent's tool calls reach (index.mjs hostedDispatch).
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  const publicApp = (req, res) => reach.publicAgent(req, res) || (res.statusCode = 404, res.end(), true);
  // Windows: the route's key, and a peer check that knows this process is Tailscale's.
  const ingressKey = keyed ? newIngressKey() : "";
  const keyedPort = keyed ? await reach.listenKeyed({ key: ingressKey, peerCheck: { check: async () => true }, publicApp }) : 0;
  if (!keyed) await reach.listenPrivate(socketPath, { publicApp });
  reach.setFunnelController(async () => {});
  const reused = [];
  reach.auth.onCredentialReuse((client) => reused.push(client.id));
  t.after(async () => {
    await reach.close();
    fs.rmSync(root, { recursive: true, force: true });
    if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true });
  });
  const host = new URL(ORIGIN).host;
  // As Tailscale delivers it: to the socket with Host rewritten (a Mac), or
  // to the keyed port under the key with the original Host (Windows).
  const send = ({ method = "GET", path: route, headers = {}, body, privately = false }) => new Promise((resolve, reject) => {
    const req = http.request({ ...(keyed ? { host: "127.0.0.1", port: keyedPort, path: `/r-${ingressKey}${route}` } : { socketPath, path: route }), method, headers: {
      ...headers, Host: keyed ? (privately ? `${host}:8443` : host) : "localhost", "X-Forwarded-Host": privately ? `${host}:8443` : host,
      ...(privately ? { "X-Forwarded-For": "100.64.0.20" } : { "Tailscale-Funnel-Request": "?1", "X-Forwarded-For": "203.0.113.7" }),
    } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = JSON.parse(text); } catch { /* a page */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.once("error", reject);
    req.end(body);
  });
  const jsonPost = (route, value, extra = {}) => send({ method: "POST", path: route, headers: { "Content-Type": "application/json", ...(extra.headers || {}) }, body: JSON.stringify(value), privately: extra.privately });
  const form = (route, value, extra = {}) => send({ method: "POST", path: route, headers: { "Content-Type": "application/x-www-form-urlencoded", ...(extra.headers || {}) }, body: new URLSearchParams(value).toString(), privately: extra.privately });
  // A hosted invitation and the address the owner gets for it.
  const invite = (extra = {}) => {
    const grant = reach.auth.inviteBrowser({ name: "Claude", transport: "funnel", preset: "files", folders: [{ root: 0, path: "work" }], hosted: true, standing: true, ...extra });
    return { ...grant, connector: hostedConnector(grant.invitation) };
  };
  const approve = (decision = "approve") => {
    const waiting = reach.auth.listAgentAdmissions().at(-1);
    assert.ok(waiting, "an admission waits for the owner");
    reach.auth.decideAgentAdmission(waiting.requestId, decision);
    return waiting;
  };
  const pkce = () => {
    const verifier = crypto.randomBytes(32).toString("base64url");
    return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
  };
  const register = async (connector, name = "Claude") => {
    const response = await jsonPost(`/mcp/${connector}/oauth/register`, { client_name: name, redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" });
    assert.equal(response.status, 201, `Hosted registration: ${response.status} ${response.text}`);
    assert.ok(response.json?.client_id, "hosted registration returns a client ID");
    return response.json;
  };
  const authorizeUrl = (connector, client, challenge, method = "S256") => `/mcp/${connector}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: method, state: "xyz", scope: "reach", resource: `${ORIGIN}/mcp/${connector}` })}`;
  // The whole dance, as an MCP client does it: to the tokens, or to what the
  // token endpoint answered instead.
  const connect = async (connector, { decision = "approve", client: given, verifier: wrong } = {}) => {
    const client = given ?? await register(connector);
    const { verifier, challenge } = pkce();
    const page = await send({ path: authorizeUrl(connector, client, challenge) });
    assert.equal(page.status, 200, page.text);
    const statusPath = new RegExp(`/mcp/${connector}/oauth/authorize/[A-Za-z0-9_-]+/status`).exec(page.text)?.[0];
    assert.ok(statusPath, "the page polls for the owner's answer at its own address");
    assert.deepEqual((await send({ path: statusPath })).json, { status: "pending" });
    const waiting = approve(decision);
    const answer = (await send({ path: statusPath })).json;
    if (decision !== "approve") return { answer, client, waiting };
    assert.equal(answer.status, "approved", JSON.stringify(answer));
    const back = new URL(answer.redirect);
    assert.equal(back.origin + back.pathname, CALLBACK);
    assert.equal(back.searchParams.get("state"), "xyz");
    const code = back.searchParams.get("code");
    const tokens = (await form(`/mcp/${connector}/oauth/token`, { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: wrong || verifier })).json;
    return { tokens, client, waiting, page, verifier, code };
  };
  const rpc = (connector, accessToken, message, extra = {}) => jsonPost(`/mcp/${connector}`, message, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json, text/event-stream" }, ...extra });
  const refresh = (connector, refreshToken, clientId) => form(`/mcp/${connector}/oauth/token`, { grant_type: "refresh_token", refresh_token: refreshToken, ...(clientId ? { client_id: clientId } : {}) });
  return { reach, send, jsonPost, form, invite, approve, pkce, register, authorizeUrl, connect, rpc, refresh, reused, root };
}

both("a new hosted connector registers immediately when credential writes share the same mtime", { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const file = path.join(f.reach.config.dataDir, "clients.json");
  const stamp = new Date("2026-01-01T00:00:00Z");
  const first = f.invite();
  fs.utimesSync(file, stamp, stamp);
  await f.register(first.connector); // Populate the public door's connector cache.
  const mtime = fs.statSync(file).mtimeMs;
  const second = f.invite();
  fs.utimesSync(file, stamp, stamp);
  assert.equal(fs.statSync(file).mtimeMs, mtime, "force the coarse-filesystem collision");
  const response = await f.jsonPost(`/mcp/${second.connector}/oauth/register`, {
    client_name: "Second connector", redirect_uris: [CALLBACK], token_endpoint_auth_method: "none",
  });
  assert.equal(response.status, 201, `A fresh invitation must not return ${response.status}: ${response.text}`);
  assert.ok(response.json?.client_id);
});

both("a hosted agent at its own address discovers Reach, registers, connects with the owner's code and uses the preset's tools", { skip: process.platform !== "darwin" && "agent presets need macOS (its protected file and screen helpers)", timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const nobody = strangerId();
  // Nothing invited: no address answers, and no shared one exists.
  for (const route of [`/mcp/${nobody}`, "/mcp", "/oauth/register", "/.well-known/oauth-authorization-server"])
    assert.equal((await f.jsonPost(route, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 404, route);
  assert.equal((await f.send({ path: `/.well-known/oauth-protected-resource/mcp/${nobody}` })).status, 404);
  const grant = f.invite();
  const c = grant.connector;
  assert.match(c, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(f.reach.funnelWindow().open, false, "a hosted invitation opens nothing else of the public link");
  // A stranger without the address gets nothing, even while it waits.
  for (const route of [`/mcp/${nobody}`, `/mcp/${nobody}/oauth/register`])
    assert.equal((await f.jsonPost(route, { redirect_uris: [CALLBACK] })).status, 404, route);
  for (const route of [`/mcp/${nobody}/oauth/authorize?client_id=x`, `/.well-known/oauth-authorization-server/mcp/${nobody}`, "/"])
    assert.equal((await f.send({ path: route })).status, 404, route);
  // At its own address: discovery, every endpoint under it.
  const resource = await f.send({ path: `/.well-known/oauth-protected-resource/mcp/${c}` });
  assert.equal(resource.status, 200, resource.text);
  assert.equal(resource.json.resource, `${ORIGIN}/mcp/${c}`);
  assert.deepEqual(resource.json.authorization_servers, [`${ORIGIN}/mcp/${c}`]);
  const server = (await f.send({ path: `/.well-known/oauth-authorization-server/mcp/${c}` })).json;
  assert.equal(server.issuer, `${ORIGIN}/mcp/${c}`);
  assert.equal(server.authorization_endpoint, `${ORIGIN}/mcp/${c}/oauth/authorize`);
  assert.equal(server.token_endpoint, `${ORIGIN}/mcp/${c}/oauth/token`);
  assert.equal(server.registration_endpoint, `${ORIGIN}/mcp/${c}/oauth/register`);
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
  assert.equal((await f.send({ path: `/mcp/${c}/.well-known/openid-configuration` })).json.issuer, `${ORIGIN}/mcp/${c}`, "the OpenID forms too");
  // Without a token, a client learns where to connect.
  const bare = await f.jsonPost(`/mcp/${c}`, { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(bare.status, 401);
  assert.equal(bare.headers["www-authenticate"], `Bearer realm="Reach", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/${c}"`);
  const { tokens, client, waiting, page, code } = await f.connect(c);
  assert.equal(client.token_endpoint_auth_method, "none");
  assert.match(page.text, new RegExp(`<span>${waiting.verificationCode.slice(0, 3)}</span><span>${waiting.verificationCode.slice(3)}</span>`), "the page shows the code the owner matches");
  assert.match(page.text, /<b>Claude<\/b> wants to use <b>Fixture Mac<\/b>/);
  assert.equal(waiting.hosted, true);
  assert.equal(waiting.hostedClient, "Claude");
  assert.equal(waiting.browserTransport, "funnel");
  assert.equal(waiting.preset, "files");
  assert.match(tokens.access_token, /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/, JSON.stringify(tokens));
  assert.match(tokens.refresh_token, /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, 3600);
  // The code was spent.
  assert.equal((await f.form(`/mcp/${c}/oauth/token`, { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: "x".repeat(43) })).json.error, "invalid_grant");
  // MCP: the client's protocol revision, the preset's tools, a call.
  const init = await f.rpc(c, tokens.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "1" } } });
  assert.equal(init.status, 200, init.text);
  assert.equal(init.json.result.protocolVersion, "2025-06-18");
  assert.equal(init.json.result.serverInfo.name, "reach");
  assert.equal((await f.rpc(c, tokens.access_token, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const list = (await f.rpc(c, tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json.result.tools.map((tool) => tool.name);
  assert.ok(list.includes("reach_list_files") && list.includes("reach_read_file"), list.join());
  assert.ok(!list.includes("reach_shell") && !list.includes("reach_screenshot"), "Files: no shell, no screen");
  const listed = (await f.rpc(c, tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "reach_list_files", arguments: { root: 0, path: "" } } })).json;
  assert.match(listed.result.content[0].text, /brief\.txt/, JSON.stringify(listed));
  const read = (await f.rpc(c, tokens.access_token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "reach_read_file", arguments: { root: 0, path: "brief.txt" } } })).json;
  assert.match(read.result.content[0].text, /the brief/, JSON.stringify(read));
  const shell = (await f.rpc(c, tokens.access_token, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "reach_shell", arguments: { command: "id" } } })).json;
  assert.equal(shell.result.isError, true, "nothing beyond the preset");
  for (const args of [null, false, 0, "", [], "unexpected"]) {
    const invalid = (await f.rpc(c, tokens.access_token, { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "reach_access", arguments: args } })).json;
    assert.equal(invalid.error?.code, -32602, "malformed arguments are never converted to an empty object");
    assert.equal(invalid.result, undefined);
  }
  const batch = (await f.rpc(c, tokens.access_token, [{ jsonrpc: "2.0", id: 6, method: "ping" }, { jsonrpc: "2.0", id: 7, method: "resources/list" }])).json;
  assert.deepEqual(batch.map((message) => message.id), [6, 7]);
  assert.deepEqual(batch[1].result, { resources: [] });
  assert.equal((await f.rpc(c, tokens.access_token, { jsonrpc: "2.0", id: 8, method: "nothing/here" })).json.error.code, -32601);
  assert.equal((await f.send({ path: `/mcp/${c}`, headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 405, "no event stream");
  // On the owner's tailnet the same address answers at the Mac's private name.
  assert.deepEqual((await f.rpc(c, tokens.access_token, { jsonrpc: "2.0", id: 9, method: "ping" }, { privately: true })).json.result, {});
  assert.equal((await f.send({ path: `/.well-known/oauth-authorization-server/mcp/${c}`, privately: true })).json.issuer, `${ORIGIN}:8443/mcp/${c}`);
  // Connected: its invitation is spent, so its address takes no new registration or authorization.
  assert.equal(f.reach.funnelWindow().open, false, "still nothing else of the public link");
  assert.equal((await f.jsonPost(`/mcp/${c}/oauth/register`, { redirect_uris: [CALLBACK] })).status, 404);
  assert.equal((await f.send({ path: `/mcp/${c}/oauth/authorize?client_id=x` })).status, 404);
  assert.equal((await f.send({ path: `/.well-known/oauth-authorization-server/mcp/${c}` })).status, 200, "discovery stays for its refreshes");
  assert.equal((await f.refresh(c, "nope", client.client_id)).json.error, "invalid_grant");
  assert.equal((await f.jsonPost(`/mcp/${nobody}`, { jsonrpc: "2.0", id: 1, method: "ping" }, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 404, "its token opens no other address");
  // Its token is no good at another invitation's address.
  const other = f.invite({ name: "Grok" });
  assert.equal((await f.rpc(other.connector, tokens.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);
  // In the owner's list, like any agent; ending it ends it, and the agent is told.
  const record = f.reach.auth.list().find((entry) => entry.id === grant.clientId);
  assert.equal(record.hosted, true);
  assert.equal(record.status, "accepted");
  f.reach.auth.revoke(grant.clientId);
  assert.equal((await f.rpc(c, tokens.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401, "ended: told so, so it asks the owner again");
  assert.equal((await f.refresh(c, tokens.refresh_token, client.client_id)).json.error, "invalid_grant");
});

both("a refresh rotates the credential at its own address; a copy used after the trade ends the access and tells the owner; a week unused ends an Always access", { skip: !posix, timeout: 30000 }, async (t) => {
  const advance = clock(t);
  const f = await fixture(t);
  const { connector: c } = f.invite();
  const { tokens: first, client } = await f.connect(c);
  const ping = (accessToken) => f.rpc(c, accessToken, { jsonrpc: "2.0", id: 1, method: "ping" });
  const second = (await f.refresh(c, first.refresh_token, client.client_id)).json;
  assert.match(second.access_token, /^[A-Za-z0-9_-]{43}\./, JSON.stringify(second));
  assert.notEqual(second.refresh_token, first.refresh_token);
  assert.equal(second.access_token.slice(0, 43), first.access_token.slice(0, 43), "the same connection");
  assert.equal((await ping(first.access_token)).status, 200, "the token before still works until its hour ends");
  assert.equal((await ping(second.access_token)).status, 200);
  // A refresh whose answer was lost: the old refresh token works until the new one is used.
  const third = (await f.refresh(c, first.refresh_token, client.client_id)).json;
  assert.ok(third.refresh_token, JSON.stringify(third));
  assert.deepEqual(f.reused, [], "an unused traded credential is no copy");
  // The new one used: it takes over; the old one has two minutes.
  const fourth = (await f.refresh(c, third.refresh_token, client.client_id)).json;
  assert.ok(fourth.refresh_token, JSON.stringify(fourth));
  assert.equal((await ping(fourth.access_token)).status, 200);
  advance(3 * 60_000);
  assert.equal((await f.refresh(c, first.refresh_token, client.client_id)).json.error, "invalid_grant", "the old one again: a copy is in use");
  assert.equal(f.reused.length, 1, "the owner hears why");
  assert.equal((await ping(fourth.access_token)).status, 401, "the access ended for both");
  assert.equal((await f.refresh(c, fourth.refresh_token, client.client_id)).json.error, "invalid_grant");
  // Another connector's refresh token is no good at this address, nor its client.
  const grokGrant = f.invite({ name: "Grok" });
  const grok = await f.connect(grokGrant.connector);
  assert.equal((await f.refresh(c, grok.tokens.refresh_token, grok.client.client_id)).json.error, "invalid_grant", "refreshed at its own address only");
  assert.equal((await f.refresh(grokGrant.connector, grok.tokens.refresh_token, client.client_id)).json.error, "invalid_grant", "by the connector that connected");
  // Then a week of silence.
  advance(6 * 86400_000);
  const later = (await f.refresh(grokGrant.connector, grok.tokens.refresh_token, grok.client.client_id)).json;
  assert.ok(later.refresh_token, "six days: still on");
  advance(6 * 86400_000);
  const again = (await f.refresh(grokGrant.connector, later.refresh_token, grok.client.client_id)).json;
  assert.ok(again.refresh_token, "used six days ago: still on");
  advance(7 * 86400_000 + 60_000);
  assert.equal((await f.refresh(grokGrant.connector, again.refresh_token, grok.client.client_id)).json.error, "invalid_grant", "a week since its last use: ended");
  const ended = f.reach.auth.list().find((entry) => entry.id === grok.waiting.clientId);
  assert.ok(ended.expiresAt <= Date.now(), "ended for good, in the list too");
});

both("a refresh token replayed inside the two-minute grace mints nothing, and the real client keeps working", { skip: !posix, timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const { connector: c } = f.invite();
  const { tokens: a, client } = await f.connect(c);
  const ping = (accessToken) => f.rpc(c, accessToken, { jsonrpc: "2.0", id: 1, method: "ping" });
  const b = (await f.refresh(c, a.refresh_token, client.client_id)).json;
  const cPair = (await f.refresh(c, b.refresh_token, client.client_id)).json;
  assert.ok(cPair.refresh_token, JSON.stringify(cPair));
  // A copy of the first refresh token, within its grace: no new pair.
  const replay = (await f.refresh(c, a.refresh_token, client.client_id)).json;
  assert.equal(replay.error, "invalid_grant", JSON.stringify(replay));
  assert.equal(replay.access_token, undefined);
  // The real client's latest pair still trades and works.
  const next = (await f.refresh(c, cPair.refresh_token, client.client_id)).json;
  assert.ok(next.refresh_token, JSON.stringify(next));
  assert.equal((await ping(next.access_token)).status, 200);
});

both("a confidential client's refresh needs its secret, with or without its client_id", { skip: !posix, timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const { connector: c } = f.invite();
  const registered = await f.jsonPost(`/mcp/${c}/oauth/register`, { client_name: "ChatGPT", redirect_uris: [CALLBACK], token_endpoint_auth_method: "client_secret_post" });
  assert.equal(registered.status, 201, registered.text);
  const client = registered.json;
  assert.ok(client.client_secret);
  const { verifier, challenge } = f.pkce();
  const page = await f.send({ path: f.authorizeUrl(c, client, challenge) });
  const statusPath = new RegExp(`/mcp/${c}/oauth/authorize/[A-Za-z0-9_-]+/status`).exec(page.text)[0];
  f.approve();
  const code = new URL((await f.send({ path: statusPath })).json.redirect).searchParams.get("code");
  const tokens = (await f.form(`/mcp/${c}/oauth/token`, { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: client.client_id, client_secret: client.client_secret, code_verifier: verifier })).json;
  assert.ok(tokens.refresh_token, JSON.stringify(tokens));
  for (const params of [{}, { client_id: client.client_id }, { client_id: client.client_id, client_secret: "wrong" }, { client_secret: "wrong" }]) {
    const refused = await f.form(`/mcp/${c}/oauth/token`, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, ...params });
    assert.equal(refused.status, 401, `${JSON.stringify(Object.keys(params))}: ${refused.text}`);
    assert.equal(refused.json.error, "invalid_client");
  }
  const refreshed = await f.form(`/mcp/${c}/oauth/token`, { grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_secret: client.client_secret });
  assert.equal(refreshed.status, 200, refreshed.text);
  const again = await f.form(`/mcp/${c}/oauth/token`, { grant_type: "refresh_token", refresh_token: refreshed.json.refresh_token, client_id: client.client_id, client_secret: client.client_secret });
  assert.equal(again.status, 200, again.text);
});

both("while the public window is open, an address Reach never gave out still gets 404, and one address's registrations can't fill another's", { skip: !posix, timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  openPairingWindow(f.reach.config.dataDir);
  assert.equal(f.reach.funnelWindow().open, true, "the window lets strangers to the start page");
  const nobody = strangerId();
  for (const route of [`/mcp/${nobody}`, `/mcp/${nobody}/oauth/register`, `/mcp/${nobody}/oauth/token`])
    assert.equal((await f.jsonPost(route, { jsonrpc: "2.0", id: 1, method: "ping", redirect_uris: [CALLBACK] })).status, 404, route);
  for (const route of [`/.well-known/oauth-protected-resource/mcp/${nobody}`, `/.well-known/oauth-authorization-server/mcp/${nobody}`, `/mcp/${nobody}/oauth/authorize?client_id=x`])
    assert.equal((await f.send({ path: route })).status, 404, route);
  // A flood of registrations at one invited address stops at its own cap.
  const { connector: first } = f.invite();
  const statuses = [];
  for (let i = 0; i < 20; i++)
    statuses.push((await f.jsonPost(`/mcp/${first}/oauth/register`, { client_name: `Flood ${i}`, redirect_uris: [CALLBACK] })).status);
  assert.deepEqual(statuses, [...Array(16).fill(201), ...Array(4).fill(429)], "one address registers 16 clients at most");
  const { connector: second } = f.invite({ name: "Grok" });
  await f.register(second, "Grok");
});

both("an unsupported MCP-Protocol-Version is refused after initialize; version negotiation still answers as before", { skip: !posix, timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const { connector: c } = f.invite();
  const { tokens } = await f.connect(c);
  const call = (message, version) => f.jsonPost(`/mcp/${c}`, message, { headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: "application/json, text/event-stream", ...(version ? { "MCP-Protocol-Version": version } : {}) } });
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  const refused = await call(ping, "1999-01-01");
  assert.equal(refused.status, 400, refused.text);
  assert.equal(refused.json?.jsonrpc, undefined, "a plain HTTP error, not a JSON-RPC answer");
  assert.match(refused.json.error, /2025-06-18/, "it names the versions Reach speaks");
  assert.equal((await call([ping], "1999-01-01")).status, 400, "batches too");
  assert.equal((await call(ping, "2025-06-18")).status, 200);
  assert.equal((await call(ping, "2025-03-26")).status, 200);
  assert.equal((await call(ping)).status, 200, "no header: 2025-03-26, as the spec says");
  // A newer client's first tries, as Claude Code 2.1.296 makes them: it
  // falls back on today's answers, so they don't change.
  const discover = await call({ jsonrpc: "2.0", id: 2, method: "server/discover", params: {} }, "2026-07-28");
  assert.equal(discover.status, 200, discover.text);
  assert.equal(discover.json.error.code, -32601);
  const init = await call({ jsonrpc: "2.0", id: 3, method: "initialize", params: { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "c", version: "1" } } }, "2026-07-28");
  assert.equal(init.status, 200, init.text);
  assert.equal(init.json.result.protocolVersion, "2025-06-18");
  // Then, as task 4 logged it: initialize without a header, the rest at 2025-06-18.
  assert.equal((await call({ jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "c", version: "1" } } })).json.result.protocolVersion, "2025-06-18");
  assert.equal((await call({ jsonrpc: "2.0", method: "notifications/initialized" }, "2025-06-18")).status, 202);
  assert.equal((await call({ jsonrpc: "2.0", method: "notifications/initialized" }, "2026-07-28")).status, 400, "after initialize, an unsupported version is refused");
});

both("declined goes back as access_denied; PKCE must match and a code is spent by its first use; a client stays at the address it registered at; a hosted invitation is no page link", { skip: !posix, timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const { connector: c } = f.invite();
  const client = await f.register(c, "ChatGPT");
  assert.equal((await f.jsonPost(`/mcp/${c}/oauth/register`, { redirect_uris: ["http://evil.example/cb"] })).status, 400, "http only on localhost");
  assert.equal((await f.jsonPost(`/mcp/${c}/oauth/register`, { client_name: "Claude Code", redirect_uris: ["http://localhost:4242/cb"] })).status, 201, "a local client's loopback callback");
  const bad = await f.send({ path: `/mcp/${c}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://evil.example/cb", code_challenge: "a".repeat(43), code_challenge_method: "S256" })}` });
  assert.equal(bad.status, 400, "an unknown return address: an error page, no redirect");
  assert.equal(bad.headers.location, undefined);
  const plainPkce = await f.send({ path: f.authorizeUrl(c, client, "a".repeat(43), "plain") });
  assert.equal(plainPkce.status, 302);
  assert.match(plainPkce.headers.location, /^https:\/\/agent\.example\/oauth\/callback\?error=invalid_request&/);
  // Declined: back to the agent with access_denied, nothing issued; the address's invitation is spent.
  const declined = await f.connect(c, { decision: "deny", client });
  assert.equal(declined.answer.status, "denied");
  assert.equal(new URL(declined.answer.redirect).searchParams.get("error"), "access_denied");
  assert.equal(new URL(declined.answer.redirect).searchParams.get("state"), "xyz");
  assert.equal((await f.send({ path: f.authorizeUrl(c, client, "a".repeat(43)) })).status, 404, "its invitation was used");
  // PKCE: the wrong verifier gets nothing, and the code is spent with it.
  const second = f.invite();
  const wrongClient = await f.register(second.connector);
  const wrong = await f.connect(second.connector, { client: wrongClient, verifier: "w".repeat(43) });
  assert.equal(wrong.tokens.error, "invalid_grant", JSON.stringify(wrong.tokens));
  assert.equal((await f.form(`/mcp/${second.connector}/oauth/token`, { grant_type: "authorization_code", code: wrong.code, redirect_uri: CALLBACK, client_id: wrongClient.client_id, code_verifier: wrong.verifier })).json.error, "invalid_grant", "spent");
  // Another registered client can't use this client's code.
  const third = f.invite();
  const mine = await f.register(third.connector), theirs = await f.register(third.connector, "Other");
  const { verifier, challenge } = f.pkce();
  const authorize = await f.send({ path: f.authorizeUrl(third.connector, mine, challenge) });
  const statusPath = new RegExp(`/mcp/${third.connector}/oauth/authorize/[A-Za-z0-9_-]+/status`).exec(authorize.text)[0];
  f.approve();
  const code = new URL((await f.send({ path: statusPath })).json.redirect).searchParams.get("code");
  assert.equal((await f.form(`/mcp/${third.connector}/oauth/token`, { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: theirs.client_id, code_verifier: verifier })).json.error, "invalid_client");
  // A client registered at one address can't authorize at another's.
  const fourth = f.invite();
  const elsewhere = await f.send({ path: f.authorizeUrl(fourth.connector, mine, f.pkce().challenge) });
  assert.equal(elsewhere.status, 400, elsewhere.text);
  assert.equal(elsewhere.headers.location, undefined);
  // A hosted invitation is no page link: a browser key can't claim it.
  assert.throws(() => f.reach.auth.redeemFunnelBrowser(fourth.invitation, crypto.randomBytes(32).toString("base64url")), { status: 401 });
});

test("a hosted invitation is a public-link invitation", () => {
  assert.throws(() => validatePresetInvitation({ name: "Claude", preset: "full", fullControlVersion: 1, ttlSeconds: 3600, transport: "tailnet", hosted: true }), /public link/);
  assert.throws(() => validatePresetInvitation({ name: "Claude", preset: "full", fullControlVersion: 1, ttlSeconds: 3600, transport: "funnel", hosted: "yes" }), /public link/);
  assert.equal(validatePresetInvitation({ name: "Claude", preset: "full", fullControlVersion: 1, ttlSeconds: 3600, transport: "funnel", hosted: true }).hosted, true);
  assert.equal(validatePresetInvitation({ name: "Claude", preset: "full", fullControlVersion: 1, ttlSeconds: 3600, transport: "funnel" }).hosted, undefined);
});

test("the invitation route hands the owner the invitation's own connector address, never the invitation itself", { skip: process.platform !== "darwin", timeout: 20000 }, async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-hosted-route-")));
  const shared = path.join(root, "shared");
  fs.mkdirSync(path.join(shared, "work"), { recursive: true });
  const reach = await createReach({ name: "Fixture Mac", roots: [shared], dataDir: path.join(root, "state"), agentPolicyFile: path.join(root, "state", "none.json"), publicOrigin: `${ORIGIN}:8443`, allowedOrigins: [ORIGIN] });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  reach.setFunnelController(async () => ORIGIN);
  t.after(async () => { await reach.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const make = async () => {
    const response = await fetch(`http://127.0.0.1:${reach.server.address().port}/api/agents/browser-invitations`, {
      method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Claude", preset: "files", folders: [{ root: 0, path: "work" }], transport: "funnel", hosted: true, standing: true }),
    });
    const text = await response.text();
    assert.equal(response.status, 201, text);
    return JSON.parse(text);
  };
  const made = await make();
  const id = /^https:\/\/mac\.fixture\.ts\.net\/mcp\/([A-Za-z0-9_-]{43})$/.exec(made.url)?.[1];
  assert.ok(id, made.url);
  assert.equal(made.privateUrl, `${ORIGIN}:8443/mcp/${id}`);
  assert.equal(made.hosted, true);
  assert.equal(made.transport, "funnel");
  assert.equal(made.invitation, undefined, "the invitation stays on the Mac");
  assert.equal(made.runtime, undefined, "nothing to download");
  assert.notEqual((await make()).url, made.url, "each invitation its own address");
  const record = reach.auth.list().find((entry) => entry.id === made.clientId);
  assert.equal(record.hosted, true);
  assert.equal(record.status, "invited");
});
