import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { validatePresetInvitation } from "../server/agent-presets.mjs";

// Reach as an MCP server at a URL (server/hosted-mcp.mjs): a hosted agent
// (claude.ai, ChatGPT, Muse, Grok) adds https://<the Mac>/mcp as a custom
// connector, discovers OAuth, registers, and when it connects the owner
// matches its code in Reach, as for any agent. Here the internet is the
// private socket with Tailscale's Funnel mark; the Mac's own routes listen on
// loopback, as they do when Reach runs.
const ORIGIN = "https://mac.fixture.ts.net";
const OWNER = { userId: "42", login: "owner@example.test" };
const CALLBACK = "https://agent.example/oauth/callback";
const posix = process.platform !== "win32";

const clock = (t) => {
  const real = Date.now;
  let offset = 0;
  t.mock.method(Date, "now", () => real() + offset);
  return (ms) => { offset += ms; };
};

async function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-hosted-")));
  const socketDir = fs.mkdtempSync("/tmp/reach-hosted-");
  const socketPath = path.join(socketDir, "s");
  const shared = path.join(root, "shared");
  fs.mkdirSync(path.join(shared, "work"), { recursive: true });
  fs.writeFileSync(path.join(shared, "work", "brief.txt"), "the brief");
  const reach = await createReach({
    name: "Fixture Mac", roots: [shared], dataDir: path.join(root, "state"), agentPolicyFile: path.join(root, "state", "none.json"),
    publicOrigin: `${ORIGIN}:8443`, allowedOrigins: [ORIGIN], tailscaleOwner: OWNER,
    tailscaleIdentity: { lookup: async () => null },
  });
  // The inner routes a hosted agent's tool calls reach (index.mjs hostedDispatch).
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  await reach.listenPrivate(socketPath, { publicApp: (req, res) => reach.publicAgent(req, res) || (res.statusCode = 404, res.end(), true) });
  reach.setFunnelController(async () => {});
  const reused = [];
  reach.auth.onCredentialReuse((client) => reused.push(client.id));
  t.after(async () => {
    await reach.close();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(socketDir, { recursive: true, force: true });
  });
  const host = new URL(ORIGIN).host;
  const send = ({ method = "GET", path: route, headers = {}, body, privately = false }) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method, headers: {
      ...headers, Host: "localhost", "X-Forwarded-Host": privately ? `${host}:8443` : host,
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
  const invite = (extra = {}) => reach.auth.inviteBrowser({ name: "Claude", transport: "funnel", preset: "files", folders: [{ root: 0, path: "work" }], hosted: true, standing: true, ...extra });
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
  const register = async (name = "Claude") => (await jsonPost("/oauth/register", { client_name: name, redirect_uris: [CALLBACK], token_endpoint_auth_method: "none" })).json;
  // The whole dance, as an MCP client does it: to the tokens, or to what the
  // token endpoint answered instead.
  const connect = async ({ decision = "approve", client: given, verifier: wrong } = {}) => {
    const client = given ?? await register();
    const { verifier, challenge } = pkce();
    const query = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "reach", resource: `${ORIGIN}/mcp` });
    const page = await send({ path: `/oauth/authorize?${query}` });
    assert.equal(page.status, 200, page.text);
    const statusPath = /\/oauth\/authorize\/[A-Za-z0-9_-]+\/status/.exec(page.text)?.[0];
    assert.ok(statusPath, "the page polls for the owner's answer");
    assert.deepEqual((await send({ path: statusPath })).json, { status: "pending" });
    const waiting = approve(decision);
    const answer = (await send({ path: statusPath })).json;
    if (decision !== "approve") return { answer, client, waiting };
    assert.equal(answer.status, "approved", JSON.stringify(answer));
    const back = new URL(answer.redirect);
    assert.equal(back.origin + back.pathname, CALLBACK);
    assert.equal(back.searchParams.get("state"), "xyz");
    const code = back.searchParams.get("code");
    const tokens = (await form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: wrong || verifier })).json;
    return { tokens, client, waiting, page, verifier, code };
  };
  const rpc = (accessToken, message, extra = {}) => jsonPost("/mcp", message, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json, text/event-stream" }, ...extra });
  const refresh = (refreshToken, clientId) => form("/oauth/token", { grant_type: "refresh_token", refresh_token: refreshToken, ...(clientId ? { client_id: clientId } : {}) });
  return { reach, send, jsonPost, form, invite, approve, pkce, register, connect, rpc, refresh, reused, root };
}

test("a hosted agent discovers Reach, registers, connects with the owner's code and uses the preset's tools", { skip: !posix, timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  // Nothing invited: the door is shut, discovery included.
  assert.equal((await f.send({ path: "/.well-known/oauth-authorization-server" })).status, 404);
  assert.equal((await f.jsonPost("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" })).status, 404);
  const grant = f.invite();
  assert.ok(f.reach.funnelWindow().open, "a hosted invitation waiting opens the door");
  const resource = await f.send({ path: "/.well-known/oauth-protected-resource" });
  assert.equal(resource.status, 200, resource.text);
  assert.equal(resource.json.resource, `${ORIGIN}/mcp`);
  assert.deepEqual(resource.json.authorization_servers, [ORIGIN]);
  const server = (await f.send({ path: "/.well-known/oauth-authorization-server" })).json;
  assert.equal(server.issuer, ORIGIN);
  assert.equal(server.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.equal(server.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.equal(server.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
  // Without a token, a client learns where to connect.
  const bare = await f.jsonPost("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(bare.status, 401);
  assert.match(bare.headers["www-authenticate"], /resource_metadata="https:\/\/mac\.fixture\.ts\.net\/\.well-known\/oauth-protected-resource"/);
  const { tokens, client, waiting, page, code } = await f.connect();
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
  assert.equal((await f.form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: "x".repeat(43) })).json.error, "invalid_grant");
  // MCP: the client's protocol revision, the preset's tools, a call.
  const init = await f.rpc(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "1" } } });
  assert.equal(init.status, 200, init.text);
  assert.equal(init.json.result.protocolVersion, "2025-06-18");
  assert.equal(init.json.result.serverInfo.name, "reach");
  assert.equal((await f.rpc(tokens.access_token, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const list = (await f.rpc(tokens.access_token, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json.result.tools.map((tool) => tool.name);
  assert.ok(list.includes("reach_list_files") && list.includes("reach_read_file"), list.join());
  assert.ok(!list.includes("reach_shell") && !list.includes("reach_screenshot"), "Files: no shell, no screen");
  const listed = (await f.rpc(tokens.access_token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "reach_list_files", arguments: { root: 0, path: "" } } })).json;
  assert.match(listed.result.content[0].text, /brief\.txt/, JSON.stringify(listed));
  const read = (await f.rpc(tokens.access_token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "reach_read_file", arguments: { root: 0, path: "brief.txt" } } })).json;
  assert.match(read.result.content[0].text, /the brief/, JSON.stringify(read));
  const shell = (await f.rpc(tokens.access_token, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "reach_shell", arguments: { command: "id" } } })).json;
  assert.equal(shell.result.isError, true, "nothing beyond the preset");
  const batch = (await f.rpc(tokens.access_token, [{ jsonrpc: "2.0", id: 6, method: "ping" }, { jsonrpc: "2.0", id: 7, method: "resources/list" }])).json;
  assert.deepEqual(batch.map((message) => message.id), [6, 7]);
  assert.deepEqual(batch[1].result, { resources: [] });
  assert.equal((await f.rpc(tokens.access_token, { jsonrpc: "2.0", id: 8, method: "nothing/here" })).json.error.code, -32601);
  assert.equal((await f.send({ path: "/mcp", headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 405, "no event stream");
  // On the owner's tailnet the same endpoint answers at the Mac's private name.
  assert.deepEqual((await f.rpc(tokens.access_token, { jsonrpc: "2.0", id: 9, method: "ping" }, { privately: true })).json.result, {});
  assert.equal((await f.send({ path: "/.well-known/oauth-authorization-server", privately: true })).json.issuer, `${ORIGIN}:8443`);
  // Connected: the door takes its token and the OAuth endpoints, strangers nothing.
  const window = f.reach.funnelWindow();
  assert.equal(window.open, true);
  assert.equal(window.keyed, true, JSON.stringify(window));
  assert.equal((await f.jsonPost("/mcp", { jsonrpc: "2.0", id: 1, method: "ping" })).status, 404, "no token: nothing, not even a 401");
  assert.equal((await f.rpc(`${"a".repeat(43)}.${"b".repeat(43)}`, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 404, "an unknown token: nothing");
  assert.equal((await f.send({ path: "/oauth/authorize?client_id=x" })).status, 404, "no invitation waiting: no authorize page");
  assert.equal((await f.jsonPost("/oauth/register", { redirect_uris: [CALLBACK] })).status, 404, "no registration either");
  assert.equal((await f.send({ path: "/.well-known/oauth-authorization-server" })).status, 200, "discovery stays for the connected agent's refreshes");
  assert.equal((await f.refresh("nope", client.client_id)).json.error, "invalid_grant");
  // In the owner's list, like any agent; ending it ends it, and the agent is told.
  const record = f.reach.auth.list().find((c) => c.id === grant.clientId);
  assert.equal(record.hosted, true);
  assert.equal(record.status, "accepted");
  f.reach.auth.revoke(grant.clientId);
  assert.equal((await f.rpc(tokens.access_token, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401, "ended: told so, so it asks the owner again");
  assert.equal((await f.refresh(tokens.refresh_token, client.client_id)).json.error, "invalid_grant");
});

test("a refresh rotates the credential; a copy used after the trade ends the access and tells the owner; a week unused ends an Always access", { skip: !posix, timeout: 30000 }, async (t) => {
  const advance = clock(t);
  const f = await fixture(t);
  f.invite();
  const { tokens: first, client } = await f.connect();
  const ping = (accessToken) => f.rpc(accessToken, { jsonrpc: "2.0", id: 1, method: "ping" });
  const second = (await f.refresh(first.refresh_token, client.client_id)).json;
  assert.match(second.access_token, /^[A-Za-z0-9_-]{43}\./, JSON.stringify(second));
  assert.notEqual(second.refresh_token, first.refresh_token);
  assert.equal(second.access_token.slice(0, 43), first.access_token.slice(0, 43), "the same connection");
  assert.equal((await ping(first.access_token)).status, 200, "the token before still works until its hour ends");
  assert.equal((await ping(second.access_token)).status, 200);
  // A refresh whose answer was lost: the old refresh token works until the new one is used.
  const third = (await f.refresh(first.refresh_token, client.client_id)).json;
  assert.ok(third.refresh_token, JSON.stringify(third));
  assert.deepEqual(f.reused, [], "an unused traded credential is no copy");
  // The new one used: it takes over; the old one has two minutes.
  const fourth = (await f.refresh(third.refresh_token, client.client_id)).json;
  assert.ok(fourth.refresh_token, JSON.stringify(fourth));
  assert.equal((await ping(fourth.access_token)).status, 200);
  advance(3 * 60_000);
  assert.equal((await f.refresh(first.refresh_token, client.client_id)).json.error, "invalid_grant", "the old one again: a copy is in use");
  assert.equal(f.reused.length, 1, "the owner hears why");
  assert.equal((await ping(fourth.access_token)).status, 401, "the access ended for both");
  assert.equal((await f.refresh(fourth.refresh_token, client.client_id)).json.error, "invalid_grant");
  // Another connector's refresh token is no good to this one.
  f.invite({ name: "Grok" });
  const grok = await f.connect();
  assert.equal((await f.refresh(grok.tokens.refresh_token, client.client_id)).json.error, "invalid_grant", "the connector that connected is the one that refreshes");
  // Then a week of silence.
  advance(6 * 86400_000);
  const later = (await f.refresh(grok.tokens.refresh_token, grok.client.client_id)).json;
  assert.ok(later.refresh_token, "six days: still on");
  advance(6 * 86400_000);
  const again = (await f.refresh(later.refresh_token, grok.client.client_id)).json;
  assert.ok(again.refresh_token, "used six days ago: still on");
  advance(7 * 86400_000 + 60_000);
  assert.equal((await f.refresh(again.refresh_token, grok.client.client_id)).json.error, "invalid_grant", "a week since its last use: ended");
  const ended = f.reach.auth.list().find((c) => c.id === grok.waiting.clientId);
  assert.ok(ended.expiresAt <= Date.now(), "ended for good, in the list too");
});

test("declined goes back as access_denied; PKCE must match and a code is spent by its first use; only a hosted invitation answers; a hosted invitation is no page link", { skip: !posix, timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  // Only a page invitation waiting: the door is open, but nothing for a hosted agent.
  const page = f.reach.auth.inviteBrowser({ name: "Muse", transport: "funnel", preset: "files", folders: [{ root: 0, path: "work" }], ttlSeconds: 3600 });
  const client = await f.register("ChatGPT");
  assert.equal((await f.jsonPost("/oauth/register", { redirect_uris: ["http://evil.example/cb"] })).status, 400, "http only on localhost");
  assert.equal((await f.jsonPost("/oauth/register", { client_name: "Claude Code", redirect_uris: ["http://localhost:4242/cb"] })).status, 201, "a local client's loopback callback");
  const bad = await f.send({ path: `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: "https://evil.example/cb", code_challenge: "a".repeat(43), code_challenge_method: "S256" })}` });
  assert.equal(bad.status, 400, "an unknown return address: an error page, no redirect");
  assert.equal(bad.headers.location, undefined);
  const plainPkce = await f.send({ path: `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: "a".repeat(43), code_challenge_method: "plain", state: "s" })}` });
  assert.equal(plainPkce.status, 302);
  assert.match(plainPkce.headers.location, /^https:\/\/agent\.example\/oauth\/callback\?error=invalid_request&/);
  const nothing = await f.send({ path: `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: "a".repeat(43), code_challenge_method: "S256" })}` });
  assert.equal(nothing.status, 404);
  assert.match(nothing.text, /Nothing is waiting/);
  f.reach.auth.revoke(page.clientId);
  // Declined: back to the agent with access_denied, nothing issued.
  f.invite();
  const declined = await f.connect({ decision: "deny", client });
  assert.equal(declined.answer.status, "denied");
  assert.equal(new URL(declined.answer.redirect).searchParams.get("error"), "access_denied");
  assert.equal(new URL(declined.answer.redirect).searchParams.get("state"), "xyz");
  // PKCE: the wrong verifier gets nothing, and the code is spent with it.
  f.invite();
  const wrong = await f.connect({ client, verifier: "w".repeat(43) });
  assert.equal(wrong.tokens.error, "invalid_grant", JSON.stringify(wrong.tokens));
  assert.equal((await f.form("/oauth/token", { grant_type: "authorization_code", code: wrong.code, redirect_uri: CALLBACK, client_id: client.client_id, code_verifier: wrong.verifier })).json.error, "invalid_grant", "spent");
  // Another registered client can't use this client's code.
  f.invite();
  const other = await f.register("Other");
  const { verifier, challenge } = f.pkce();
  const authorize = await f.send({ path: `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: CALLBACK, code_challenge: challenge, code_challenge_method: "S256", state: "q" })}` });
  const statusPath = /\/oauth\/authorize\/[A-Za-z0-9_-]+\/status/.exec(authorize.text)[0];
  f.approve();
  const code = new URL((await f.send({ path: statusPath })).json.redirect).searchParams.get("code");
  assert.equal((await f.form("/oauth/token", { grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: other.client_id, code_verifier: verifier })).json.error, "invalid_client");
  // A hosted invitation is no page link: a browser key can't claim it.
  const hosted = f.invite();
  assert.throws(() => f.reach.auth.redeemFunnelBrowser(hosted.invitation, crypto.randomBytes(32).toString("base64url")), { status: 401 });
});

test("a hosted invitation is a public-link invitation", () => {
  assert.throws(() => validatePresetInvitation({ name: "Claude", preset: "full", ttlSeconds: 3600, transport: "tailnet", hosted: true }), /public link/);
  assert.throws(() => validatePresetInvitation({ name: "Claude", preset: "full", ttlSeconds: 3600, transport: "funnel", hosted: "yes" }), /public link/);
  assert.equal(validatePresetInvitation({ name: "Claude", preset: "full", ttlSeconds: 3600, transport: "funnel", hosted: true }).hosted, true);
  assert.equal(validatePresetInvitation({ name: "Claude", preset: "full", ttlSeconds: 3600, transport: "funnel" }).hosted, undefined);
});

test("the invitation route hands the owner the connector address, never the invitation itself", { skip: process.platform !== "darwin", timeout: 20000 }, async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-hosted-route-")));
  const shared = path.join(root, "shared");
  fs.mkdirSync(path.join(shared, "work"), { recursive: true });
  const reach = await createReach({ name: "Fixture Mac", roots: [shared], dataDir: path.join(root, "state"), agentPolicyFile: path.join(root, "state", "none.json"), publicOrigin: `${ORIGIN}:8443`, allowedOrigins: [ORIGIN] });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  reach.setFunnelController(async () => ORIGIN);
  t.after(async () => { await reach.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const response = await fetch(`http://127.0.0.1:${reach.server.address().port}/api/agents/browser-invitations`, {
    method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Claude", preset: "files", folders: [{ root: 0, path: "work" }], transport: "funnel", hosted: true, standing: true }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  const made = JSON.parse(text);
  assert.equal(made.url, `${ORIGIN}/mcp`);
  assert.equal(made.privateUrl, `${ORIGIN}:8443/mcp`);
  assert.equal(made.hosted, true);
  assert.equal(made.transport, "funnel");
  assert.equal(made.invitation, undefined, "the invitation stays on the Mac");
  assert.equal(made.runtime, undefined, "nothing to download");
  const record = reach.auth.list().find((c) => c.id === made.clientId);
  assert.equal(record.hosted, true);
  assert.equal(record.status, "invited");
});
