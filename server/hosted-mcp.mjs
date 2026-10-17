// Reach as an MCP server at a URL (`/mcp/<id>`, each invitation its own), for
// agents that live in a service
// and take a connector address: claude.ai and Claude Desktop's custom
// connectors, ChatGPT, Muse, Grok, or `claude mcp add --transport http`. They
// get the same tools an invited agent gets, derived from the owner's preset on
// every call (agent-presets.mjs), reached through OAuth as the MCP
// specification asks: discovery (RFC 8414, RFC 9728), registration (RFC 7591),
// an authorization code with PKCE, refresh tokens.
//
// The owner invites a hosted agent on the phone and pastes its address into
// the agent: the invitation's own, so nothing at a shared address claims
// anything (Oct 10: "the public link should not be the same for everyone").
// When the agent connects, the authorize page shows a code the owner matches
// in Reach, as for any agent. Nothing here grants anything on its own: the owner's approval
// mints the credential (core.mjs claimHostedInvitation, pollFunnelAdmission),
// and every tool call goes through Reach's inner routes under the preset's
// allowlist, as the signed gateway's do (index.mjs hostedDispatch).
//
// The credential: an access token `<id>.<secret>` good for an hour, and a
// refresh token `<id>.<secret>` that rotates on every refresh (core.mjs
// refreshHosted: a copy used after the new one took over ends the access, a
// week unused ends an Always access). The id stands where a browser agent's
// key would (its browserBinding): the public door knows it, and keeps the
// token and discovery endpoints up while a hosted agent has access.
import crypto from "node:crypto";
import { REACH_VERSION } from "./reach-version.mjs";
import { compactTools } from "./browser-tools.mjs";
import path from "node:path";
import { atomicJson, loadJson, sameHash } from "./core.mjs";
import { browserRouteAllowed } from "./browser-access.mjs";
import { permittedPath, sourceKey } from "./funnel-agent.mjs";
import { agentErrorDetails, agentRequestError, agentRequestTimeout, agentJsonResponseLimit, validateAgentJsonResponse } from "./agent-transport.mjs";
import { PROTOCOLS, serverInstructions, toContent, toolsFor, withGuide } from "../scripts/mcp-server.mjs";
import { isScreenImageRoute } from "../scripts/agent-client.mjs";

const ACCESS_SECONDS = 3600;
const CODE_MS = 5 * 60_000;
const PENDING_MS = 10 * 60_000;
const OAUTH_BODY_LIMIT = 8 * 1024;
const MCP_BODY_LIMIT = 256 * 1024;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const MAX_CLIENTS = 64, MAX_CLIENTS_PER_ADDRESS = 16;
const CLIENT_IDLE_MS = 30 * 86400_000;
const FLOOD_PER_MINUTE = 300, FLOOD_PAUSE_MS = 5 * 60_000;
const SCOPE = "reach";
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
const MESSAGES = {
  400: "The request is invalid.", 401: "Connect to Reach first.", 403: "Not allowed.", 404: "Not found.",
  405: "Method not allowed.", 408: "The request took too long.", 413: "The request is too large.",
  415: "Use JSON.", 421: "Unrecognized host.", 429: "Too many requests. Wait briefly and retry.",
  503: "Reach is briefly unavailable (paused or reconnecting). Retry in a few seconds.",
};

const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const token = () => crypto.randomBytes(32).toString("base64url");
const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const clean = (value, max) =>
  String(value).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, " ").trim().slice(0, max);
const escape = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const failure = (status, oauth, description) =>
  Object.assign(Error(description || MESSAGES[status] || "Request refused."), { status, ...(oauth ? { oauth, description } : {}) });
// Every path of a hosted agent carries its address id (core.mjs
// hostedConnector): the MCP endpoint, its discovery (RFC 9728, RFC 8414 with
// the path inserted, and the OpenID forms), and its OAuth endpoints.
const ID = "[A-Za-z0-9_-]{43}";
const ROUTES = [
  ["mcp", new RegExp(`^/mcp/(${ID})$`)],
  ["resource", new RegExp(`^/\\.well-known/oauth-protected-resource/mcp/(${ID})$`)],
  ["server", new RegExp(`^/\\.well-known/(?:oauth-authorization-server|openid-configuration)/mcp/(${ID})$`)],
  ["server", new RegExp(`^/mcp/(${ID})/\\.well-known/(?:oauth-authorization-server|openid-configuration)$`)],
  ["register", new RegExp(`^/mcp/(${ID})/oauth/register$`)],
  ["authorize", new RegExp(`^/mcp/(${ID})/oauth/authorize$`)],
  ["status", new RegExp(`^/mcp/(${ID})/oauth/authorize/(${ID})/status$`)],
  ["token", new RegExp(`^/mcp/(${ID})/oauth/token$`)],
];
const routeOf = (pathname) => {
  for (const [kind, pattern] of ROUTES) {
    const match = pattern.exec(pathname);
    if (match) return { kind, connector: match[1], pending: match[2] };
  }
  return null;
};

// A client's return address: https anywhere, http only on this machine
// (a local MCP client's callback, RFC 8252), never with a fragment.
const validRedirect = (value) => {
  if (typeof value !== "string" || value.length > 2048) return false;
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return !!url.hostname;
  return url.protocol === "http:" && LOOPBACK.includes(url.hostname);
};
// Exactly as registered; a loopback client may pick its port when it runs.
const sameRedirect = (registered, given) => {
  if (registered === given) return true;
  try {
    const a = new URL(registered), b = new URL(given);
    return a.protocol === "http:" && b.protocol === "http:" && LOOPBACK.includes(a.hostname) &&
      a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
};
const withParams = (redirect, params) => {
  const target = new URL(redirect);
  for (const [key, value] of Object.entries(params)) if (value) target.searchParams.set(key, value);
  return target.href;
};

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], finished = false;
    const complete = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      req.removeListener("data", data);
      req.removeListener("end", end);
      req.removeListener("aborted", aborted);
      req.removeListener("error", aborted);
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    const data = (chunk) => {
      size += chunk.length;
      if (size > limit) return complete(failure(413));
      chunks.push(chunk);
    };
    const end = () => complete(null, Buffer.concat(chunks));
    const aborted = () => complete(failure(400));
    const timer = setTimeout(() => complete(failure(408)), 8000);
    timer.unref?.();
    if (req.headers["content-length"] !== undefined &&
        (!/^\d+$/.test(req.headers["content-length"]) || Number(req.headers["content-length"]) > limit))
      return complete(failure(413));
    req.on("data", data);
    req.once("end", end);
    req.once("aborted", aborted);
    req.once("error", aborted);
  });
}
const parseJson = (bytes) => {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw failure(400); }
};

const CSS = `:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text",Inter,system-ui,sans-serif;background:#f4f6f5;color:#111}.card{max-width:420px;margin:24px;padding:28px 24px;border-radius:20px;background:#fff;box-shadow:0 10px 40px #0000001a;text-align:center}h1{margin:0 0 8px;font-size:22px;font-weight:600;letter-spacing:-.3px}p{margin:8px 0;color:#555}.code{display:inline-flex;gap:14px;margin:18px 0 6px;font:600 40px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:4px;color:#0f8f5f}.quiet{font-size:14px}.mark{display:inline-block;width:44px;height:44px;border-radius:50%;background:#0f8f5f1a;color:#0f8f5f;line-height:44px;font-weight:700;font-size:20px}@media(prefers-color-scheme:dark){body{background:#0f1311;color:#eef2ef}.card{background:#171d1a;box-shadow:none}p{color:#b8c0bb}}`;
// The authorize page's only script: it asks for the owner's answer every two
// seconds and goes back to the agent with it.
const poll = (statusPath) => `(function(){var s=document.getElementById("status"),n=0;function tick(){fetch(${JSON.stringify(statusPath)},{cache:"no-store",credentials:"omit"}).then(function(r){return r.json()}).then(function(a){if(a.status==="pending"){if(++n<330)setTimeout(tick,2000);else s.textContent="This request timed out. Start again from your agent.";return}if(a.redirect){s.textContent=a.status==="approved"?"Approved. Taking you back…":"Declined. Taking you back…";location.replace(a.redirect);return}s.textContent="This request expired. Start again from your agent."}).catch(function(){setTimeout(tick,3000)})}setTimeout(tick,1500)})();`;

export function createHostedMcp({
  auth,
  // The computer's public link and its private address: the same endpoint at
  // either, each naming itself in discovery.
  origin,
  privateOrigin,
  requestHost = (req) => req.headers.host,
  available = () => true,
  computerName = "this Mac",
  toolProfile = process.env.REACH_MCP_PROFILE === "compact" ? "compact" : "full",
  dataDir,
  // Told when an agent asks to connect (the owner's Needs you), and when a
  // flood of strangers is refused.
  claimed = () => {},
  onFlood = () => {},
  // One of the agent's tool calls, carried to Reach's inner routes with the
  // context the endpoint verified: (context, {timeout}) → {status, headers, bytes}.
  dispatch,
  // What the agent may do and its rules, from its access now
  // (server/agent-guide.mjs), told at initialize.
  guide = () => "",
  now = Date.now,
}) {
  const hosts = new Set([new URL(origin).host, ...(privateOrigin ? [new URL(privateOrigin).host] : [])]);
  const file = path.join(dataDir, "hosted-clients.json");
  const loadClients = () => { const stored = loadJson(file, {}); return plain(stored) ? stored : {}; };
  const saveClients = (clients) => atomicJson(file, clients);
  // Authorizations under way: id → what the client asked, the admission it
  // became, the code once the owner approved. In memory: a restart means
  // connecting again, nothing more.
  const pending = new Map();
  const sweep = () => { const current = now(); for (const [id, entry] of pending) if (entry.until < current) pending.delete(id); };

  // Strangers (requests without a known connection id): a flood is refused
  // for five minutes before anything is read, each source gets a minute's
  // share, and a few run at a time. Known ids have their own lane.
  const strangers = { minute: 0, count: 0 };
  let floodUntil = 0;
  const sources = new Map();
  const active = { strangers: 0, known: 0 };
  const strangerGate = (req) => {
    const current = now();
    if (current < floodUntil) throw failure(503);
    const minute = Math.floor(current / 60_000);
    if (strangers.minute !== minute) { strangers.minute = minute; strangers.count = 0; }
    if (++strangers.count > FLOOD_PER_MINUTE) {
      floodUntil = current + FLOOD_PAUSE_MS;
      try { onFlood(strangers.count); } catch { /* told, or not */ }
      throw failure(503);
    }
    const forwarded = req.headers["x-forwarded-for"];
    const key = sourceKey(typeof forwarded === "string" ? forwarded.trim() : req.socket?.remoteAddress);
    for (const [k, v] of sources) if (v.until <= current) sources.delete(k);
    if (sources.size >= 1024 && !sources.has(key)) throw failure(429);
    const bucket = sources.get(key) || { until: current + 60_000, count: 0 };
    sources.set(key, bucket);
    if (++bucket.count > 60) throw failure(429);
  };
  const hold = (res, lane) => {
    if (active[lane] >= (lane === "known" ? 32 : 16)) throw failure(429);
    active[lane]++;
    let released = false;
    const release = () => { if (released) return; released = true; active[lane]--; };
    res.once("finish", release);
    res.once("close", release);
  };

  const json = (res, status, body, headers = {}) => {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(body));
  };
  const rejection = (req, res, error) => {
    req.resume?.();
    if (res.headersSent || res.destroyed) { res.destroy?.(); return; }
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    const headers = { "Cache-Control": "no-store" };
    if (status === 429 || status === 503) headers["Retry-After"] = "5";
    json(res, status, error?.oauth
      ? { error: error.oauth, ...(error.description ? { error_description: error.description } : {}) }
      : { error: MESSAGES[status] || "The request could not be completed." }, headers);
  };
  const render = (res, status, { title, body, code, script }) => {
    const nonce = crypto.randomBytes(16).toString("base64");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)} · Reach</title><style nonce="${nonce}">${CSS}</style></head><body><main class="card"><div class="mark" aria-hidden="true">R</div><h1>${escape(title)}</h1>${body}${code ? `<div class="code" aria-label="Connection code"><span>${code.slice(0, 3)}</span><span>${code.slice(3)}</span></div><p class="quiet" id="status">Waiting for your approval…</p>` : ""}${script ? `<script nonce="${nonce}">${script}</script>` : ""}</main></body></html>`;
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    res.end(html);
  };

  // What a client finds out about this server (RFC 9728, RFC 8414), at
  // whichever of the computer's addresses it asked.
  const resourceMetadata = (base, connector) => ({
    resource: `${base}/mcp/${connector}`,
    authorization_servers: [`${base}/mcp/${connector}`],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
    resource_name: `Reach on ${computerName}`,
  });
  const serverMetadata = (base, connector) => ({
    issuer: `${base}/mcp/${connector}`,
    authorization_endpoint: `${base}/mcp/${connector}/oauth/authorize`,
    token_endpoint: `${base}/mcp/${connector}/oauth/token`,
    registration_endpoint: `${base}/mcp/${connector}/oauth/register`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [SCOPE],
  });

  // Registration (RFC 7591): at an address whose invitation waits; the client
  // gets an id bound to that address, and a secret only if it asked to keep
  // one. Bounded.
  async function register(req, res, connector) {
    const body = parseJson(await readBody(req, OAUTH_BODY_LIMIT));
    if (!plain(body)) throw failure(400, "invalid_client_metadata");
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || !uris.length || uris.length > 8 || !uris.every(validRedirect) || new Set(uris).size !== uris.length)
      throw failure(400, "invalid_redirect_uri", "Give 1 to 8 https redirect URIs (http only on localhost).");
    const method = body.token_endpoint_auth_method ?? "none";
    if (!["none", "client_secret_post", "client_secret_basic"].includes(method))
      throw failure(400, "invalid_client_metadata", "token_endpoint_auth_method: none, client_secret_post or client_secret_basic.");
    const grants = body.grant_types ?? ["authorization_code", "refresh_token"];
    if (!Array.isArray(grants) || !grants.length || grants.some((grant) => !["authorization_code", "refresh_token"].includes(grant)))
      throw failure(400, "invalid_client_metadata", "grant_types: authorization_code and refresh_token.");
    const responses = body.response_types ?? ["code"];
    if (!Array.isArray(responses) || responses.some((type) => type !== "code"))
      throw failure(400, "invalid_client_metadata", "response_types: code.");
    const name = typeof body.client_name === "string" && clean(body.client_name, 80) ? clean(body.client_name, 80) : "An agent";
    const clients = loadClients();
    const current = now();
    for (const [id, client] of Object.entries(clients))
      if (!((client.usedAt || client.createdAt) > current - CLIENT_IDLE_MS)) delete clients[id];
    // Bounded overall, and per address: one address's flood never fills another's.
    if (Object.keys(clients).length >= MAX_CLIENTS ||
        Object.values(clients).filter((client) => client.connector === sha(connector)).length >= MAX_CLIENTS_PER_ADDRESS) throw failure(429);
    const id = token();
    const secret = method === "none" ? null : token();
    clients[id] = { name, redirectUris: uris, authMethod: method, connector: sha(connector), ...(secret ? { secretHash: sha(secret) } : {}), createdAt: current, usedAt: current };
    saveClients(clients);
    json(res, 201, {
      client_id: id, client_id_issued_at: Math.floor(current / 1000), client_name: name, redirect_uris: uris,
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: method,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    }, { "Cache-Control": "no-store" });
  }
  const authenticated = (client, secret) =>
    client.authMethod === "none" ? true : typeof secret === "string" && sameHash(client.secretHash, sha(secret));
  const touch = (clients, id) => {
    if (!clients[id] || now() - (clients[id].usedAt || 0) < 3600_000) return;
    clients[id].usedAt = now();
    try { saveClients(clients); } catch { /* a stamp */ }
  };

  // The authorize page: the agent's request becomes an admission the owner
  // answers on the phone (core.mjs claimHostedInvitation), and the page
  // shows the code to match. A registration or return address that doesn't
  // match gets an error page, never a redirect.
  function authorize(res, base, url, connector) {
    const query = url.searchParams;
    const clientId = query.get("client_id") || "", redirect = query.get("redirect_uri") || "";
    const client = loadClients()[clientId];
    if (!client || (client.connector && client.connector !== sha(connector)) || !client.redirectUris.some((registered) => sameRedirect(registered, redirect)))
      return render(res, 400, { title: "This connection request isn't valid.", body: "<p>The agent's registration or return address doesn't match. Start again from the agent.</p>" });
    const state = query.get("state") || "";
    const back = (params) => withParams(redirect, { ...params, state });
    if (query.get("response_type") !== "code") return redirectTo(res, back({ error: "unsupported_response_type" }));
    const challenge = query.get("code_challenge") || "";
    if (query.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge))
      return redirectTo(res, back({ error: "invalid_request", error_description: "PKCE with S256 is required." }));
    if (!available()) return render(res, 503, { title: "Reach is paused.", body: "<p>Try again when Reach is running.</p>" });
    const binding = token();
    let claim;
    try {
      claim = auth.claimHostedInvitation(binding, { name: client.name, clientId, connector });
    } catch (error) {
      if (error?.status === 404)
        return render(res, 404, { title: "Nothing is waiting at this address.", body: `<p>Its invitation was used or has ended. In Reach on your phone, invite a hosted agent again (Invite → Agent → Connects: Hosted) and give <b>${escape(client.name)}</b> its new address.</p>` });
      if (error?.status === 429)
        return render(res, 429, { title: "Another connection is waiting.", body: "<p>Finish or decline it in Reach, then try again.</p>" });
      throw error;
    }
    sweep();
    const id = token();
    pending.set(id, { id, connector, clientId, redirect, state, challenge, binding, agentId: claim.clientId, requestId: claim.requestId, requestSecret: claim.requestSecret, until: now() + PENDING_MS });
    try { claimed({ ...claim, hosted: true }); } catch { /* the owner is told by the list too */ }
    render(res, 200, {
      title: "Approve in Reach",
      body: `<p><b>${escape(client.name)}</b> wants to use <b>${escape(computerName)}</b> through Reach. On your phone, open Reach → Needs you and approve the connection with this code.</p>`,
      code: claim.verificationCode,
      script: poll(`${base}/mcp/${connector}/oauth/authorize/${id}/status`),
    });
  }
  const redirectTo = (res, location) => {
    res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
    res.end();
  };
  // The page asks: pending, or approved (the code, once) or not.
  function statusOf(res, connector, id) {
    sweep();
    const entry = pending.get(id);
    if (!entry || entry.connector !== connector) return json(res, 200, { status: "expired" }, { "Cache-Control": "no-store" });
    const state = auth.list().find((client) => client.id === entry.agentId)?.status;
    const back = (params) => withParams(entry.redirect, { ...params, state: entry.state });
    if (state === "pending") return json(res, 200, { status: "pending" }, { "Cache-Control": "no-store" });
    if (state === "approved" || state === "accepted") {
      if (!entry.code) { entry.code = token(); entry.codeUntil = now() + CODE_MS; }
      return json(res, 200, { status: "approved", redirect: back({ code: entry.code }) }, { "Cache-Control": "no-store" });
    }
    pending.delete(id);
    json(res, 200, { status: state === "denied" ? "denied" : "expired", redirect: back({ error: "access_denied" }) }, { "Cache-Control": "no-store" });
  }

  // The token endpoint: a code (once, with its PKCE verifier, within its
  // minutes) collects the credential the owner's approval made; a refresh
  // token trades for the next pair (core.mjs refreshHosted).
  async function tokens(req, res, connector) {
    const raw = await readBody(req, OAUTH_BODY_LIMIT);
    const type = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const params = type === "application/json" ? parseJson(raw) : Object.fromEntries(new URLSearchParams(raw.toString("utf8")));
    if (!plain(params)) throw failure(400, "invalid_request");
    let clientId = params.client_id, secret = params.client_secret;
    const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization || "");
    if (basic) {
      const [id, ...rest] = Buffer.from(basic[1], "base64").toString("utf8").split(":");
      try { clientId = decodeURIComponent(id); secret = decodeURIComponent(rest.join(":")); } catch { throw failure(401, "invalid_client"); }
    }
    const clients = loadClients();
    const client = typeof clientId === "string" ? clients[clientId] : undefined;
    const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };
    if (params.grant_type === "authorization_code") {
      sweep();
      const entry = typeof params.code === "string" && [...pending.values()].find((candidate) => candidate.code && candidate.code === params.code);
      if (!entry || !(entry.codeUntil > now())) throw failure(400, "invalid_grant");
      // A code is spent by its first use, whatever comes of it.
      pending.delete(entry.id);
      if (entry.connector !== connector) throw failure(400, "invalid_grant");
      if (!client || entry.clientId !== clientId || !authenticated(client, secret)) throw failure(401, "invalid_client");
      if (params.redirect_uri !== undefined && params.redirect_uri !== entry.redirect) throw failure(400, "invalid_grant");
      if (typeof params.code_verifier !== "string" || !/^[A-Za-z0-9._~-]{43,128}$/.test(params.code_verifier) ||
          crypto.createHash("sha256").update(params.code_verifier).digest("base64url") !== entry.challenge)
        throw failure(400, "invalid_grant", "PKCE verification failed.");
      let collected;
      try { collected = auth.pollFunnelAdmission(entry.requestId, entry.requestSecret, entry.binding); }
      catch (error) { if (error?.status) throw failure(400, "invalid_grant"); throw error; }
      if (collected?.status !== "approved" || typeof collected.token !== "string" || typeof collected.accessToken !== "string")
        throw failure(400, "invalid_grant", "The owner hasn't approved this connection.");
      touch(clients, clientId);
      return json(res, 200, {
        access_token: `${entry.binding}.${collected.accessToken}`, token_type: "Bearer",
        expires_in: collected.accessSeconds || ACCESS_SECONDS, refresh_token: `${entry.binding}.${collected.token}`, scope: SCOPE,
      }, noStore);
    }
    if (params.grant_type === "refresh_token") {
      if (client && !authenticated(client, secret)) throw failure(401, "invalid_client");
      // The client that connected, found from the token when it gives no id,
      // proves itself as it registered: a secret is never skipped.
      const authenticate = (id) => {
        const owner = typeof id === "string" ? clients[id] : undefined;
        if (!owner || !authenticated(owner, secret)) throw failure(401, "invalid_client");
        return true;
      };
      const refreshed = auth.refreshHosted(params.refresh_token, { clientId: typeof clientId === "string" ? clientId : undefined, connector, authenticate });
      if (!refreshed) throw failure(400, "invalid_grant");
      if (client) touch(clients, clientId);
      return json(res, 200, {
        access_token: refreshed.accessToken, token_type: "Bearer", expires_in: refreshed.expiresIn, refresh_token: refreshed.refreshToken, scope: SCOPE,
      }, noStore);
    }
    throw failure(400, "unsupported_grant_type");
  }

  // The agent's API, as its tools call it: the gateway's path rules, the
  // preset's allowlist, then Reach's inner route with this connection as the
  // request's identity.
  const apiFor = (client, binding, secret) => async (route, method = "GET", body) => {
    let inner;
    try { inner = permittedPath(method, route); }
    catch (error) { throw agentRequestError(error?.status === 403 ? 403 : 400, { error: "This request isn't one an agent may make." }); }
    if (!browserRouteAllowed(client, method, inner)) throw agentRequestError(403, { error: "This agent's preset doesn't allow that." });
    const response = await dispatch(Object.freeze({ keyThumbprint: binding, token: secret, method, path: route, body: body ?? null }), { timeout: agentRequestTimeout(route, method) });
    const responseLimit = Math.max(RESPONSE_LIMIT, agentJsonResponseLimit(route, method, body, response.status));
    if (response.bytes.length > responseLimit) throw agentRequestError(502, { error: "The response was too large." });
    const type = String(response.headers["content-type"] || "").split(";")[0].trim();
    const text = response.bytes.toString("utf8");
    if (response.status >= 200 && response.status < 300) {
      if (isScreenImageRoute(route) && ["image/jpeg", "image/png"].includes(type))
        return { image: response.bytes.toString("base64"), mimeType: type };
      let parsed;
      try { parsed = JSON.parse(text || "null"); } catch { return null; }
      return validateAgentJsonResponse(route, method, body, parsed);
    }
    let error = null;
    try { error = JSON.parse(text); } catch { /* plain text */ }
    throw agentRequestError(response.status, error);
  };
  // Its guide never keeps it from connecting.
  const guideOf = (client) => {
    try { return guide(client); } catch { return ""; }
  };
  const unauthorized = (res, base, connector) => json(res, 401, { error: "invalid_token", error_description: "Connect to Reach first." }, {
    "WWW-Authenticate": `Bearer realm="Reach", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp/${connector}"`,
    "Cache-Control": "no-store",
  });
  async function answer(message, client, api, accessOf) {
    try {
      const params = plain(message.params) ? message.params : {};
      switch (message.method) {
        case "initialize":
          return { result: {
            protocolVersion: PROTOCOLS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOLS.at(-1),
            // No stream back to the client here, so no change notices.
            capabilities: { tools: {} },
            serverInfo: { name: "reach", version: REACH_VERSION },
            ...withGuide(serverInstructions(client.scopes, toolProfile), guideOf(client)),
          } };
        case "ping": return { result: {} };
        case "tools/list": {
          const offered = toolsFor(client.scopes, await accessOf());
          return { result: { tools: toolProfile === "compact" ? compactTools(offered) : offered } };
        }
        case "tools/call": {
          if (typeof params.name !== "string") return { error: { code: -32602, message: "Name the tool." } };
          if (params.arguments !== undefined && !plain(params.arguments)) return { error: { code: -32602, message: "Tool arguments must be an object." } };
          try {
            const executed = await api("/api/browser/mcp/call", "POST", { name: params.name, arguments: plain(params.arguments) ? params.arguments : {} });
            return { result: { content: toContent(executed.result) } };
          } catch (error) {
            const details = agentErrorDetails(error);
            return { result: { isError: true, content: [{ type: "text", text: details.kind ? JSON.stringify(details) : details.error }] } };
          }
        }
        case "resources/list": return { result: { resources: [] } };
        case "resources/templates/list": return { result: { resourceTemplates: [] } };
        case "prompts/list": return { result: { prompts: [] } };
        default: return { error: { code: -32601, message: "Method not found" } };
      }
    } catch (error) {
      return { error: { code: -32603, message: agentErrorDetails(error).error } };
    }
  }
  // MCP over HTTP (the Streamable HTTP transport, answered as JSON): one
  // message or a batch per POST, a notification gets 202, no stream opens.
  async function mcp(req, res, base, connector) {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || "")?.[1];
    const parts = auth.splitHostedToken(bearer);
    const known = !!parts && auth.hostedKeys().has(parts[0]);
    if (!known) strangerGate(req);
    hold(res, known ? "known" : "strangers");
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST", "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(JSON.stringify({ error: req.method === "GET" ? "Reach's MCP endpoint takes POST messages and opens no event stream." : MESSAGES[405] }));
    }
    const client = parts ? auth.verifyFunnel(parts[1], parts[0]) : null;
    if (!client || client.hosted !== true || client.kind !== "agent" || client.policy?.browser !== true || client.browserBinding !== parts[0] ||
        client.connectorHash !== sha(connector))
      return unauthorized(res, base, connector);
    if (!available()) throw failure(503);
    if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers["content-type"] || "") || req.headers["content-encoding"]) throw failure(415);
    const body = parseJson(await readBody(req, MCP_BODY_LIMIT));
    const messages = Array.isArray(body) ? body : [body];
    if (!messages.length || messages.length > 20) throw failure(400);
    // The version a client speaks after initialize (none: 2025-03-26). One
    // Reach doesn't speak is a plain 400; version negotiation (initialize,
    // and the server/discover newer clients try first) answers as before,
    // which is what lets them fall back.
    const version = req.headers["mcp-protocol-version"];
    if (version !== undefined && !PROTOCOLS.includes(version) &&
        messages.some((message) => !plain(message) || !["initialize", "server/discover"].includes(message.method)))
      return json(res, 400, { error: `Unsupported MCP-Protocol-Version. Reach speaks ${PROTOCOLS.join(", ")}.` }, { "Cache-Control": "no-store" });
    const api = apiFor(client, parts[0], parts[1]);
    let access, accessRead = false;
    const accessOf = async () => {
      if (!accessRead) { access = client.scopes.includes("browser:read") ? await api("/api/browser") : undefined; accessRead = true; }
      return access;
    };
    const answers = [];
    for (const message of messages) {
      if (!plain(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
        answers.push({ jsonrpc: "2.0", id: plain(message) && message.id !== undefined ? message.id : null, error: { code: -32600, message: "Invalid request" } });
        continue;
      }
      if (message.id === undefined) continue;
      answers.push({ jsonrpc: "2.0", id: message.id, ...(await answer(message, client, api, accessOf)) });
    }
    if (!answers.length) { res.writeHead(202, { "Cache-Control": "no-store" }); return res.end(); }
    json(res, 200, Array.isArray(body) ? answers : answers[0], { "Cache-Control": "no-store" });
  }

  const run = async (req, res, pathname) => {
    const host = requestHost(req);
    if (!hosts.has(host)) throw failure(421);
    const base = `https://${host}`;
    const route = routeOf(pathname);
    if (!route) throw failure(404);
    const { kind, connector } = route;
    // The door's rule whatever opened it (a pairing window lets strangers to
    // the start page, never to an address Reach didn't give out; audit A4).
    if (kind === "mcp") { if (!admits(req)) throw failure(404); return mcp(req, res, base, connector); }
    const method = { resource: "GET", server: "GET", register: "POST", authorize: "GET", status: "GET", token: "POST" }[kind];
    if (req.method !== method) throw failure(405);
    if (!admits(req)) throw failure(404);
    strangerGate(req);
    if (kind === "resource") return json(res, 200, resourceMetadata(base, connector), { "Cache-Control": "no-store" });
    if (kind === "server") return json(res, 200, serverMetadata(base, connector), { "Cache-Control": "no-store" });
    if (kind === "register") { hold(res, "strangers"); return register(req, res, connector); }
    if (kind === "authorize") return authorize(res, base, new URL(req.url, base), connector);
    if (kind === "status") return statusOf(res, connector, route.pending);
    hold(res, "strangers");
    return tokens(req, res, connector);
  };
  const mine = (pathname) => routeOf(pathname) !== null;
  // The public door's rule for these paths when nothing else opens it
  // (index.mjs listenPrivate), and every request's here: only an address
  // Reach gave out, checked by its hash before anything is read. Registration
  // and the authorize page only while that address's invitation waits; the
  // endpoint, discovery and the token endpoint while its agent has access or
  // ended lately (its refreshes, and a proper 401 for an ended one); the page
  // of an authorization under way, while it is.
  function admits(req) {
    const route = routeOf(String(req.url || "").split("?")[0]);
    if (!route) return false;
    let known;
    try { known = auth.hostedConnectors().get(sha(route.connector)); } catch { return false; }
    if (!known) return false;
    if (route.kind === "register") return req.method === "POST" && known.waiting;
    if (route.kind === "authorize") return req.method === "GET" && known.waiting;
    if (route.kind === "status") return req.method === "GET" && pending.get(route.pending)?.connector === route.connector;
    if (route.kind === "token") return req.method === "POST";
    if (route.kind === "mcp") return true;
    return req.method === "GET";
  }
  return {
    // Answers its own paths; false for anything else.
    handle(req, res) {
      const pathname = String(req.url || "").split("?")[0];
      if (!mine(pathname)) return false;
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Frame-Options", "DENY");
      void run(req, res, pathname).catch((error) => rejection(req, res, error));
      return true;
    },
    admits,
    close() { pending.clear(); },
  };
}
