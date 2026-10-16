import { validAppAccess } from "./browser-app-policy.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { agentProfile, applyAgentPolicy, validBrowserTerminalId, within } from "./agent-policy.mjs";
import { defaultFileRoots } from "./file-roots.mjs";
import { validateBrowserRoot } from "./browser-private-paths.mjs";
import { createMascotDeck } from "./mascots.mjs";
import { STANDING_SECONDS, fullControlNeedsInvitation, hostGuardedPreset, presetPolicy, presetScopes, standingPolicy, validatePresetInvitation } from "./agent-presets.mjs";

export const fail = (status, message) =>
  Object.assign(new Error(message), { status });
export const isPlainRecord = (value) => value !== null && typeof value === "object" &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
// Names and review explanations must not hide or reorder the action being approved.
export const hasReviewControls = (value) => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value);
export function validateBrowserInvitation(input, options = {}) {
  // The presets (agent-presets.mjs) are the current form; the field list
  // below is the earlier one, still accepted for invitations made with it.
  if (isPlainRecord(input) && input.preset !== undefined) {
    try { return validatePresetInvitation(input, options); }
    catch (error) { throw fail(error.status || 400, error.message); }
  }
  const fields = ["name", "ttlSeconds", "joinSeconds", "folders", "terminalIds", "screen", "commandRequests", "restrictedTerminal", "terminalApproval", "scriptApproval", "transport", "appAccess", "workspaceMode"];
  if (!isPlainRecord(input) || Object.keys(input).some((key) => !fields.includes(key)))
    throw fail(400, "This invitation contains unsupported fields.");
  const {
    name, ttlSeconds, joinSeconds = 900, folders = [], terminalIds = [],
    screen = "off", commandRequests = false, restrictedTerminal = false, terminalApproval = false, scriptApproval = false, transport = "tailnet", appAccess = [], workspaceMode = "shared",
  } = input;
  // Agents always work in the real folders; Reach limits what they can do
  // there. "shared" is still accepted from older apps; copies no longer exist.
  if (
    typeof name !== "string" || !name.trim() || name.length > 80 || hasReviewControls(name) || /[\n\t]/.test(name) ||
    !Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400 ||
    !Number.isInteger(joinSeconds) || joinSeconds < 60 || joinSeconds > 86400 ||
    !Array.isArray(terminalIds) || terminalIds.length > 20 ||
    terminalIds.some((id) => !validBrowserTerminalId(id)) ||
    !["off", "view", "scroll", "ask", "apps"].includes(screen) ||
    !validAppAccess(appAccess) || (screen !== "apps" && appAccess.length > 0) ||
    typeof commandRequests !== "boolean" || typeof restrictedTerminal !== "boolean" ||
    (restrictedTerminal && commandRequests) ||
    typeof terminalApproval !== "boolean" || (terminalApproval && !restrictedTerminal) ||
    typeof scriptApproval !== "boolean" || (scriptApproval && (!terminalApproval || !restrictedTerminal)) ||
    !["tailnet", "funnel"].includes(transport) || workspaceMode !== "shared" ||
    (transport === "funnel" && (ttlSeconds > 3600 || joinSeconds > 900))
  ) throw fail(400, "Name the browser agent, choose its access, and a duration from 1 minute to 24 hours.");
  if (!Array.isArray(folders) || folders.length > 20 || folders.some((folder) =>
    !isPlainRecord(folder) || Object.keys(folder).some((key) => !["root", "path"].includes(key)) ||
    !Number.isSafeInteger(folder.root) || folder.root < 0 ||
    typeof folder.path !== "string" || folder.path.length > 4096 || hasReviewControls(folder.path)))
    throw fail(400, "Choose up to 20 folders on this computer.");
  return { name, ttlSeconds, joinSeconds, folders, terminalIds, screen, commandRequests, restrictedTerminal, terminalApproval, scriptApproval, transport, appAccess };
}
export const id = () => crypto.randomUUID();
// A public-link browser session ends after two silent minutes, unless the owner
// gave the agent Always access, or approved a preset agent: then it lasts until
// its access ends (or the owner ends it), however long the agent is quiet.
// Approved by the owner: stamped since 2026-10-08, or (agents approved before
// then) an admission the owner approved and the agent may have collected.
export const ownerApproved = (client) =>
  client?.approvedAt > 0 || ["approved", "collected"].includes(client?.admission?.status);
export const browserIdleEnded = (client, now = Date.now()) =>
  client?.browserTransport === "funnel" && !standingPolicy(client.policy) &&
  !(ownerApproved(client) && client.policy?.preset !== undefined) &&
  !(client.browserIdleExpiresAt > now);
export const hash = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
// A hosted agent's own address id (hosted-mcp.mjs: /mcp/<id>), derived from
// its invitation: the owner's URL carries it, the record keeps its hash.
export const hostedConnector = (invitation) =>
  crypto.createHash("sha256").update(`reach-hosted-connector:${invitation}`).digest("base64url");
// Two stored digests compared in constant time (a mismatch in length, or a
// missing value, is simply no match).
export function sameHash(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !a) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${id()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
export function getConfig(overrides = {}) {
  const dataDir = path.resolve(
    process.env.REACH_DATA || path.join(process.cwd(), ".reach"),
  );
  const roots = (
    process.env.REACH_ROOTS
      ? process.env.REACH_ROOTS.split(path.delimiter)
      : defaultFileRoots()
  ).map((p) => fs.realpathSync.native(p));
  return {
    port: Number(process.env.PORT || 4317),
    host: "127.0.0.1",
    dataDir,
    roots,
    name: process.env.REACH_NAME || os.hostname().replace(/\.local$/, ""),
    publicOrigin: process.env.REACH_ORIGIN || "",
    screen: process.env.REACH_SCREEN === "1",
    privatePaths: [path.join(process.cwd(), ".reach")],
    allowedOrigins: (process.env.REACH_ALLOWED_ORIGINS || "")
      .split(",")
      .filter(Boolean),
    agentPolicyFile: path.resolve(
      process.env.REACH_AGENT_POLICY ||
        path.join(process.cwd(), ".reach/agent-policy.json"),
    ),
    agentPolicyRequired: !!process.env.REACH_AGENT_POLICY,
    ...overrides,
  };
}
// The same checks for safePath and safePathAsync: a valid root, a path that
// stays inside it, and (after following links) a real target inside it too.
function locate(roots, rootIndex, relative) {
  const root = roots[Number(rootIndex)];
  if (
    !root ||
    typeof relative !== "string" ||
    relative.includes("\0") ||
    path.isAbsolute(relative)
  )
    throw fail(400, "Choose a valid folder.");
  const target = path.resolve(root, relative);
  const within = (p) => {
    const rel = path.relative(root, p);
    return (
      rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)
    );
  };
  if (!within(target))
    throw fail(403, "This path is outside your shared folders.");
  const inside = (resolved) => {
    if (!within(resolved))
      throw fail(403, "This shortcut points outside your shared folders.");
    return resolved;
  };
  return { target, inside };
}
const gone = () => fail(404, "This file or folder is no longer available.");
export function safePath(roots, rootIndex = 0, relative = "") {
  const { target, inside } = locate(roots, rootIndex, relative);
  let resolved;
  try {
    resolved = fs.realpathSync.native(target);
  } catch {
    throw gone();
  }
  return inside(resolved);
}
// For hot paths (folder listings): the same rules without blocking the server.
export async function safePathAsync(roots, rootIndex = 0, relative = "") {
  const { target, inside } = locate(roots, rootIndex, relative);
  let resolved;
  try {
    resolved = await fs.promises.realpath(target);
  } catch {
    throw gone();
  }
  return inside(resolved);
}
export function validLeafName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 255 &&
    !name.startsWith(".") &&
    !/[. ]$/.test(name) &&
    !/[\/\\:<>"|?*\x00-\x1f]/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)
  );
}
export function validOrigin(origin, allowed = []) {
  if (!origin) return true; // Native clients do not send Origin.
  if (origin === "capacitor://localhost") return true; // The Reach iPhone app.
  try {
    const u = new URL(origin);
    return (
      u.origin === origin &&
      allowed.includes(origin) &&
      (u.protocol === "https:" ||
        (u.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))
    );
  } catch {
    return false;
  }
}
export const ALL_SCOPES = [
  "admin",
  "files",
  "exec",
  "terminal",
  "apps",
  "codex",
  "screen",
  "device",
  "files:read",
  "files:write",
  // Control the screen (keyboard and mouse) without owning this computer.
  "screen:control",
  // Watch chosen apps' windows on the phone (client.guestApps; all if unset).
  "apps:open",
  // An agent uses apps it opens on hidden displays, and hands them to you
  // (server/agent-apps.mjs). Granted on purpose only, never to guests.
  "apps:drive",
];
// Agents never control the screen or open app windows.
export const AGENT_SCOPES = ALL_SCOPES.filter(
  (s) => !["admin", "screen:control", "apps:open"].includes(s),
);
// What an invitation may grant. `full` uses this computer like you do, except
// managing access (devices, invitations, settings): see GUEST_BLOCKED_ROUTES.
export const GUEST_BLOCKED_ROUTES = [
  "clients",
  "guests",
  "settings",
  "agents",
  "activity",
  "fleet",
  // What agents hand you is yours to answer.
  "handoffs",
  // Notifications go to your own devices.
  "push",
  // Every AI session's transcript, its approvals, and the Mac's own dialogs
  // (pressing their buttons, typing the Mac's password): the owner only, not
  // grantable to anyone, a full invitation included.
  "sessions",
];
// A credential a Face ID sign-in made for its own tagged device: only the
// /api/auth/face-join route issues these (server/face-join.mjs).
const faceJoined = (client) =>
  client.kind === "device" &&
  client.tailscale?.faceJoin === true &&
  client.tailscale.tagged === true &&
  client.tailscale.userId === "";
// The pairing window: while it's open the start page answers the internet,
// so a phone without the Tailscale app can sign in to Tailscale in its browser
// and ask to join (it still has to be approved at the computer). A file in
// Reach's private folder, so the terminal that opens it (./reach pair, setup)
// needn't be the Reach that answers.
export const PAIRING_WINDOW_MS = 15 * 60 * 1000;
export const pairingWindowFile = (dataDir) => path.join(dataDir, "pairing-window.json");
export function openPairingWindow(dataDir, { now = Date.now, ms = PAIRING_WINDOW_MS } = {}) {
  const until = now() + Math.min(ms, PAIRING_WINDOW_MS);
  atomicJson(pairingWindowFile(dataDir), { until });
  return until;
}
export function closePairingWindow(dataDir) {
  fs.rmSync(pairingWindowFile(dataDir), { force: true });
}

// The credential store's lock names its holder. A change takes milliseconds
// (all synchronous), so a lock whose holder is gone, or held 10 s, was left by
// a process that died mid-change (killed, out of memory, power lost); it used
// to block every change for good, Revoke included (reliability audit, Oct 10).
const LOCK_STALE_MS = 10000;
export function takeCredentialLock(lock, { now = Date.now, isAlive } = {}) {
  const alive = isAlive || ((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error.code === "EPERM";
    }
  });
  const busy = () => fail(409, "Credentials are being updated. Try again shortly.");
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST" || attempt) throw busy();
      let stat, holder = null;
      try {
        stat = fs.statSync(lock);
        holder = JSON.parse(fs.readFileSync(lock, "utf8"))?.pid;
      } catch {
        if (!stat) continue; // gone meanwhile: take it
      }
      const age = now() - stat.mtimeMs;
      // A holder still writing its name gets a moment.
      const stale = age > LOCK_STALE_MS || (Number.isInteger(holder) ? !alive(holder) : age > 2000);
      if (!stale) throw busy();
      // Still that same lock (not one taken meanwhile): removed, and said.
      try {
        if (fs.statSync(lock).ino !== stat.ino) throw busy();
        fs.unlinkSync(lock);
      } catch (removal) {
        if (removal.status) throw removal;
      }
      console.warn("Reach: removed a credential lock left by a Reach that stopped mid-change.");
      continue;
    }
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: now() }));
    } catch {
      /* unnamed: treated as stale after 2 s, like one whose holder died */
    }
    return fd;
  }
  throw busy();
}

// `firstDevice`: told when the first of your own devices gets in (index.mjs
// turns the screen on for it).
export function createAuth(config, { rotatePairing = true, firstDevice = () => {} } = {}) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  config.agentPolicyRequired ||= fs.existsSync(config.agentPolicyFile);
  const file = path.join(config.dataDir, "clients.json");
  // A pairing window (pairingWindowFile): the start page answers the internet
  // for a few minutes so a phone without the Tailscale app can join.
  const pairingFile = pairingWindowFile(config.dataDir);
  let clients = loadJson(file, []);
  let credentialStoreCreated = fs.existsSync(file);
  const mascots = createMascotDeck({ file: path.join(config.dataDir, "mascots.json"), load: loadJson, save: atomicJson });
  let credentialGeneration = 0;
  const listStoredClients = () => {
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!Array.isArray(stored) || stored.some((client) => !isPlainRecord(client)))
        throw Error("Invalid credential store");
      credentialStoreCreated = true;
      return stored;
    } catch (error) {
      // An absent file is normal only before this installation has issued its
      // first credential. Losing/corrupting an existing store must not tell the
      // app host guard that all agent sessions disappeared and reopen admission.
      if (error.code === "ENOENT" && !credentialStoreCreated) return [];
      throw fail(503, "Reach cannot read its access records. Access stays locked until they are restored.");
    }
  };
  const changeClients = (change) => {
    const lock = `${file}.lock`;
    const fd = takeCredentialLock(lock);
    try {
      // A corrupt or unreadable store must never be replaced by one new
      // client: that would erase every other credential (503, as reads do).
      clients = change(listStoredClients());
      // New agents and people draw their mascot as they're stored. Only a
      // face: a deck that can't be saved never holds up access (the faces
      // drawn are still kept on the records, and never two alike there).
      try {
        mascots.dress(clients);
      } catch {
        /* the deck forgets this draw; the access is written regardless */
      }
      atomicJson(file, clients);
      credentialStoreCreated = true;
      credentialGeneration++;
    } finally {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    }
  };
  const attempts = new Map();
  let pairing = {
    code: crypto.randomInt(10000000, 100000000).toString(),
    expiresAt: Date.now() + 600000,
  };
  const pairFile = path.join(config.dataDir, "pairing.json");
  if (rotatePairing) atomicJson(pairFile, pairing);
  function verify(token, identity) {
    if (!token || typeof token !== "string" || token.length > 256) return null;
    return verifyDigest(hash(token), identity);
  }
  // An agent on its own tailnet device trades its credential for a new one
  // (scripts/agent-remote.mjs, hourly while it works). The new one becomes
  // the credential when first used, so a trade lost on the way changes
  // nothing.
  const ROTATION_GRACE_MS = 120_000;
  const reuseListeners = [];
  // A rotated credential (security audit M6): the new one takes over on its
  // first use; the one it replaced works two more minutes. Used after that,
  // a copy is in use somewhere: the access ends, and the owner hears why.
  // False when the digest just ended an access.
  const retiredLive = (c, digest, now) => (c.retiredHashes || []).some((r) => sameHash(r.hash, digest) && r.until > now);
  const holdsDigest = (c, digest, now) => sameHash(c.hash, digest) || retiredLive(c, digest, now);
  function settleRotation(digest, now, authorized) {
    // A token alone never activates or revokes a bound connection. Check
    // its device, signing key or OAuth client before any credential write.
    if (clients.some((c) => sameHash(c.hash, digest) && authorized(c))) return true;
    const pending = clients.find((c) => sameHash(c.pendingHash, digest) && authorized(c));
    if (pending) {
      changeClients((latest) => {
        const c = latest.find((entry) => entry.id === pending.id && sameHash(entry.pendingHash, digest) && authorized(entry));
        if (c) {
          c.retiredHashes = [...(c.retiredHashes || []).slice(-7), { hash: c.hash, until: now + ROTATION_GRACE_MS }];
          c.hash = digest;
          c.rotatedAt = now;
          delete c.pendingHash;
        }
        return latest;
      });
      clients = loadJson(file, []);
      return true;
    }
    const wasReused = (c) => (c.retiredHashes || []).some((r) => sameHash(r.hash, digest) && r.until <= now) && authorized(c);
    const reused = clients.find(wasReused);
    if (!reused) return true;
    let removed;
    changeClients((latest) => latest.filter((c) => {
      if (c.id !== reused.id || !wasReused(c)) return true;
      removed = c;
      return false;
    }));
    clients = loadJson(file, []);
    if (!removed) return true;
    rememberEnded(removed);
    for (const listener of reuseListeners) try { listener(removed); } catch { /* the access ended regardless */ }
    return false;
  }
  // "Unused for a week, end it" (the owner, Oct 10): an Always access, or an
  // agent that trades its credential. Use is stamped at most every ten
  // minutes; a record from before stamping counts from its next use.
  const IDLE_MS = 7 * 86400_000, USE_STAMP_MS = 600_000;
  const idleJudged = (c) => standingPolicy(c.policy) || c.rotatedAt > 0;
  const idle = (c, now) => !!c && typeof c === "object" && idleJudged(c) && c.usedAt > 0 && now - Math.max(c.usedAt, c.rotatedAt || 0) > IDLE_MS;
  function noteUse(id, now) {
    const c = clients.find((entry) => entry.id === id);
    if (!c || !idleJudged(c) || (c.usedAt > 0 && now - c.usedAt < USE_STAMP_MS)) return;
    changeClients((latest) => { const entry = latest.find((item) => item.id === id); if (entry) entry.usedAt = now; return latest; });
  }
  // An Always access unused for a week ends for good: out of its window,
  // ended in every list.
  function endIdle(now = Date.now()) {
    const stored = loadJson(file, []);
    // A corrupt store is left alone here: reads and writes refuse it (503).
    if (!Array.isArray(stored)) return [];
    const ended = stored.filter((c) => idle(c, now) && c.expiresAt > now).map((c) => c.id);
    if (ended.length)
      changeClients((latest) => { for (const c of latest) if (ended.includes(c.id)) { c.expiresAt = now; c.idleEndedAt = now; } return latest; });
    return ended;
  }
  // An invitation nobody ever joined with goes for good a day after its
  // chance to join ended (the owner, Oct 13: a 15-minute link to a 10-year
  // Always grant sat in Agents & people as "Request expired" until 2036).
  // Its chance: an unopened link's join window (a person's lasts as long as
  // their access), or the request an agent made with it, declined or left to
  // run out. Within the day the owner can still send a new link, which starts
  // a new window. Anything that ever held a credential, or that the owner
  // approved, is never cleared here.
  const UNOPENED_KEEP_MS = 86400_000;
  const neverJoined = (c) =>
    isPlainRecord(c) && (c.kind === "guest" || (c.kind === "agent" && c.policy?.invite === true)) &&
    !c.hash && !c.pendingHash && !c.retiredHashes?.length && !c.redeemedAt && !c.macEntry &&
    !ownerApproved(c) && !c.approvedBinding && !c.onceJoined &&
    !(c.usedAt > 0) && !(c.rotatedAt > 0) && !c.idleEndedAt;
  // When its chance ended: Infinity while it lasts, and for anything else.
  // A value that isn't a time keeps the record (NaN is never long ago).
  const chanceEnded = (c, now) => {
    if (!neverJoined(c)) return Infinity;
    if (!c.admission)
      return typeof c.inviteHash === "string" && !c.browserBinding && !c.tailscale
        ? Math.min(c.inviteExpiresAt ?? Infinity, c.expiresAt)
        : Infinity;
    if (c.admission.moved || ["approved", "collected"].includes(c.admission.status) ||
        !["denied", "expired"].includes(admissionStatus(c, now))) return Infinity;
    // No decision time is kept: a request is answered before its own
    // deadline, so the deadline is never earlier than the answer.
    return Math.min(c.admission.expiresAt, c.expiresAt);
  };
  const unopenedLapsed = (c, now) => now - chanceEnded(c, now) > UNOPENED_KEEP_MS;
  // Removes them (index.mjs ends each the way removing it does, and records
  // it). The records as they were.
  function clearUnopened(now = Date.now()) {
    const stored = loadJson(file, []);
    if (!Array.isArray(stored) || !stored.some((c) => unopenedLapsed(c, now))) return [];
    let cleared = [];
    changeClients((latest) => {
      // Checked again under the lock: a new link sent meanwhile keeps it.
      cleared = latest.filter((c) => unopenedLapsed(c, now));
      for (const c of cleared) rememberEnded(c);
      return latest.filter((c) => !cleared.includes(c));
    });
    return cleared;
  }
  // The same trade for a public-link agent, with the key that signs for it.
  function rotateFunnelCredential(token, keyThumbprint) {
    const current = verifyFunnel(token, keyThumbprint);
    if (!current || current.kind !== "agent") throw fail(403, "Only an agent rotates its credential, with its own key.");
    const next = crypto.randomBytes(32).toString("base64url");
    changeClients((latest) => {
      // Retired credentials retain a short overlap for in-flight requests,
      // but only the current credential may exchange. Otherwise a copied
      // retired token can displace the legitimate client's pending successor.
      const client = latest.find((c) => c.id === current.id && sameHash(c.hash, hash(token)));
      if (!client) throw fail(401, "This browser connection has ended.");
      client.pendingHash = hash(next);
      return latest;
    });
    return { token: next, expiresAt: current.expiresAt };
  }
  // A hosted agent's refresh (hosted-mcp.mjs, hourly). Its refresh token is
  // the credential that rotates (settleRotation: the new one takes over when
  // first used, the one before works two more minutes, a copy used after that
  // ends the access), and a fresh access token comes with each refresh; the
  // one before stays good until its own hour ends, so a client's early
  // refresh never catches itself. The connector that connected is the one
  // that refreshes.
  const HOSTED_ACCESS_MS = 3600_000;
  const splitHostedToken = (value) => {
    if (typeof value !== "string" || value.length > 256 || value.indexOf(".") !== 43) return null;
    const binding = value.slice(0, 43), secret = value.slice(44);
    if (!validBrowserBinding(binding) || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    return [binding, secret];
  };
  function refreshHosted(refreshToken, { clientId, connector, authenticate } = {}) {
    const parts = splitHostedToken(refreshToken);
    if (!parts) return null;
    const [binding, secret] = parts;
    clients = loadJson(file, []);
    const now = Date.now();
    const digest = hash(secret);
    const authorized = (c) => c.hosted === true && c.browserBinding === binding &&
      !(clientId !== undefined && c.hostedClientId && c.hostedClientId !== clientId) &&
      (connector === undefined || sameHash(c.connectorHash, hash(String(connector)))) &&
      (!authenticate || authenticate(c.hostedClientId));
    if (!settleRotation(digest, now, authorized)) return null;
    // Only the current refresh token trades. One its successor already
    // replaced (in its two minutes) mints nothing: a new pair from it would
    // drop the real client's pending one (audit A3).
    const client = clients.find((c) => sameHash(c.hash, digest) && authorized(c));
    if (!client || idle(client, now) || !funnelSession(client, binding, now)) return null;
    const nextRefresh = crypto.randomBytes(32).toString("base64url");
    const nextAccess = crypto.randomBytes(32).toString("base64url");
    let refreshed = false;
    changeClients((latest) => {
      const c = latest.find((entry) => entry.id === client.id && sameHash(entry.hash, digest) && authorized(entry));
      if (!c) return latest;
      c.pendingHash = hash(nextRefresh);
      if (typeof c.accessHash === "string" && c.accessUntil > now) c.accessPrevious = { hash: c.accessHash, until: c.accessUntil };
      else delete c.accessPrevious;
      c.accessHash = hash(nextAccess);
      c.accessUntil = now + HOSTED_ACCESS_MS;
      c.usedAt = now;
      refreshed = true;
      return latest;
    });
    clients = loadJson(file, []);
    if (!refreshed) return null;
    return { accessToken: `${binding}.${nextAccess}`, refreshToken: `${binding}.${nextRefresh}`, expiresIn: HOSTED_ACCESS_MS / 1000, clientId: client.id, expiresAt: client.expiresAt };
  }
  function rotateCredential(token, identity) {
    const current = verify(token, identity);
    if (!current || current.kind !== "agent" || !current.tailscale?.tagged || current.browserTransport === "funnel")
      throw fail(403, "Only an agent on its own invited device rotates its credential.");
    const next = crypto.randomBytes(32).toString("base64url");
    changeClients((latest) => {
      const client = latest.find((c) => c.id === current.id && sameHash(c.hash, hash(token)));
      if (!client) throw fail(401, "Access expired or was revoked.");
      client.pendingHash = hash(next);
      return latest;
    });
    return { token: next, expiresAt: current.expiresAt };
  }
  // Every check `verify` makes, from the credential's stored hash: used by
  // download links, which must never hold the credential itself.
  function verifyDigest(digest, identity) {
    clients = loadJson(file, []);
    if (typeof digest !== "string" || !digest) return null;
    const now = Date.now();
    const authorized = (c) => c.browserTransport !== "funnel" && !c.browserBinding &&
      (!config.tailscaleOwner || identity?.validUntil > now) &&
      (!c.tailscale || (identity?.validUntil > now && c.tailscale.userId === identity.userId && c.tailscale.nodeId === identity.nodeId)) &&
      (!config.tailscaleOwner || ["guest", "agent"].includes(c.kind) ||
        (c.tailscale && (identity.tagged ? faceJoined(c) : identity.userId === config.tailscaleOwner.userId)));
    if (!settleRotation(digest, now, authorized)) return null;
    const client = clients.find(
      (c) =>
        holdsDigest(c, digest, now) &&
        authorized(c) &&
        !idle(c, now) &&
        c.browserTransport !== "funnel" &&
        !c.browserBinding &&
        (!c.admission || (c.admission.status === "collected" &&
          (c.policy?.browser !== true || (c.policy.screen !== "apps" && !hostGuardedPreset(c.policy)) || c.admission.grant === admissionGrant(c)))) &&
        Date.now() < (c.expiresAt || Date.parse(c.createdAt) + 30 * 86400000),
    );
    if (client) noteUse(client.id, now);
    if (client)
      client.expiresAt ||= Date.parse(client.createdAt) + 30 * 86400000;
    if (client?.kind === "guest") {
      const roots = client.guestRoots.filter((root) =>
        config.roots.some((shared) => within(shared, root)),
      );
      return { ...client, agentRoots: roots };
    }
    return client ? applyAgentPolicy(client, config) : null;
  }
  function pair(code, name, address, identity) {
    if (
      config.tailscaleOwner &&
      (!identity ||
        identity.tagged ||
        identity.validUntil <= Date.now() ||
        identity.userId !== config.tailscaleOwner.userId)
    )
      throw fail(
        403,
        "Connect through Tailscale using the configured owner account before pairing.",
      );
    const now = Date.now();
    if (attempts.size > 1000)
      for (const [key, value] of attempts)
        if (value.reset < now) attempts.delete(key);
    const state = attempts.get(address) || { count: 0, reset: now + 60000 };
    if (state.reset < now) {
      state.count = 0;
      state.reset = now + 60000;
    }
    if (++state.count > 5)
      throw fail(429, "Too many attempts. Try again in one minute.");
    attempts.set(address, state);
    pairing = loadJson(pairFile, pairing);
    if (
      typeof code !== "string" ||
      !/^\d{8}$/.test(code.replace(/\s/g, "")) ||
      code.replace(/\s/g, "") !== pairing.code ||
      now > pairing.expiresAt
    )
      throw fail(
        401,
        "That pairing code is incorrect or expired. Open Reach on your computer for a fresh code.",
      );
    const issued = issue(
      name || "My browser",
      ALL_SCOPES,
      "device",
      identity
        ? { tailscale: { userId: identity.userId, nodeId: identity.nodeId } }
        : {},
    );
    // Single use: generating a fresh code is a local-computer action.
    pairing = { code: "", expiresAt: 0, usedAt: now, usedBy: issued.name };
    atomicJson(pairFile, pairing);
    return { token: issued.token, clientId: issued.clientId };
  }
  // A guest invite and its redeemed credential share one absolute deadline.
  // Both transitions use the credential lock, including single-use redemption.
  // Folders chosen by browsing (for guests and agents): real folders inside
  // what Reach shares, never Reach's own private data.
  function chooseFolders(folders) {
    const chosen = [];
    if (!Array.isArray(folders) || folders.length > 20)
      throw fail(400, "Choose up to 20 folders.");
    for (const f of folders) {
      if (
        !f ||
        !Number.isInteger(f.root) ||
        !config.roots[f.root] ||
        typeof f.path !== "string" ||
        f.path.length > 4096
      )
        throw fail(400, "Choose folders on this computer.");
      const dir = safePath(config.roots, f.root, f.path);
      if (!fs.statSync(dir).isDirectory())
        throw fail(400, "Choose a folder, not a file.");
      // (A folder that contains it is fine: its files stay hidden there.)
      const real = (p) => {
        try {
          return fs.realpathSync.native(p);
        } catch {
          return path.resolve(p);
        }
      };
      if (
        [config.dataDir, ...(config.privatePaths || [])].some((p) =>
          within(real(p), dir),
        )
      )
        throw fail(403, "Reach's own private folder can't be shared.");
      chosen.push(dir);
    }
    return chosen;
  }
  // What you choose when inviting someone (or changing it later):
  //   roots/write  shared folders by index, read or read/write
  //   folders      any folder inside them: [{ root, path }] (path relative)
  //   screen       false | "view" | "control" (true means "view")
  //   apps         undefined | "all" | [app ids]: watch those apps' windows
  //   terminal     their own terminals;  agents  AI sessions (Codex)
  //   full         everything you can do, except managing access
  // `chosen`: the folders, already checked. Null if the choice isn't valid.
  function guestAccess(
    {
      roots = [],
      write = false,
      screen = false,
      apps,
      terminal = false,
      agents = false,
      full = false,
      fullControlVersion,
    },
    chosen,
  ) {
    const screenMode = screen === true ? "view" : screen;
    const appList =
      apps === undefined || apps === "all"
        ? apps
        : Array.isArray(apps) &&
            apps.length > 0 &&
            apps.length <= 100 &&
            apps.every((a) => typeof a === "string" && a && a.length <= 300)
          ? [...new Set(apps)]
          : null;
    if (
      !Array.isArray(roots) ||
      roots.some((r) => !Number.isInteger(r) || !config.roots[r]) ||
      typeof write !== "boolean" ||
      ![false, "view", "control"].includes(screenMode) ||
      appList === null ||
      typeof terminal !== "boolean" ||
      typeof agents !== "boolean" ||
      typeof full !== "boolean" ||
      (fullControlVersion !== undefined && (!full || fullControlVersion !== 1)) ||
      (!full &&
        !roots.length &&
        !chosen.length &&
        !screenMode &&
        !appList &&
        !terminal &&
        !agents)
    )
      return null;
    return {
      ...(full && fullControlVersion === 1 ? { fullControlVersion: 1 } : {}),
      scopes: full
        ? ALL_SCOPES.filter((s) => s !== "apps:drive")
        : [
            "device",
            ...(roots.length || chosen.length
              ? ["files:read", ...(write ? ["files:write"] : [])]
              : []),
            ...(screenMode ? ["screen"] : []),
            ...(screenMode === "control" ? ["screen:control"] : []),
            ...(appList ? ["apps:open"] : []),
            ...(terminal ? ["terminal"] : []),
            ...(agents ? ["codex"] : []),
          ],
      guestRoots: full
        ? [...config.roots]
        : [
            ...new Set([
              ...roots.map((r) => config.roots[r]),
              ...chosen,
            ]),
          ],
      ...(Array.isArray(appList) && !full ? { guestApps: appList } : {}),
    };
  }
  // One invitation over several computers: the same id on each (the phone
  // changes their access together).
  const GROUP = /^[A-Za-z0-9_-]{8,64}$/;
  function inviteGuest({ name, ttlSeconds, group, folders = [], ...choice }) {
    const access = guestAccess(choice, chooseFolders(folders));
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 80 ||
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 60 ||
      ttlSeconds > 86400 ||
      (group !== undefined && !GROUP.test(group)) ||
      !access
    )
      throw fail(
        400,
        "Choose a guest name, what they may use, and a duration from 1 minute to 24 hours.",
      );
    const token = crypto.randomBytes(32).toString("base64url");
    const client = {
      id: id(),
      kind: "guest",
      name: name.trim(),
      ...access,
      ...(group ? { group } : {}),
      inviteHash: hash(token),
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + ttlSeconds * 1000,
    };
    changeClients((latest) => {
      if (
        latest.filter((c) => c.kind === "guest" && c.expiresAt > Date.now())
          .length >= 100
      )
        throw fail(
          429,
          "Revoke an existing guest before creating another invitation.",
        );
      return [...latest, client];
    });
    return {
      invitation: token,
      clientId: client.id,
      expiresAt: client.expiresAt,
      scopes: client.scopes,
      mascot: client.mascot,
    };
  }
  // Invite an agent: its own folders and access, for up to 90 days, joined
  // within a short window (a pasted but unused command stops working).
  // Agents never get screen or app control, or manage access.
  function inviteAgent({
    name,
    ttlSeconds,
    joinSeconds = 900,
    folders = [],
    write = false,
    exec = false,
    terminal = false,
    codex = false,
  }) {
    if (
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 80 ||
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 60 ||
      ttlSeconds > 90 * 86400 ||
      !Number.isInteger(joinSeconds) ||
      joinSeconds < 60 ||
      joinSeconds > 86400 ||
      [write, exec, terminal, codex].some((v) => typeof v !== "boolean")
    )
      throw fail(
        400,
        "Name the agent and choose how long it may use this computer (up to 90 days).",
      );
    const { scopes, roots } = agentAccess(
      { write, exec, terminal, codex },
      chooseFolders(folders),
    );
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    const client = {
      id: id(),
      kind: "agent",
      name: name.trim(),
      scopes,
      // Its own folders and limits, not a profile in the agent policy file.
      policy: { invite: true, roots, maxJobMs: 30 * 60000 },
      inviteHash: hash(token),
      inviteExpiresAt: now + joinSeconds * 1000,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + ttlSeconds * 1000,
    };
    changeClients((latest) => [...latest, client]);
    return {
      invitation: token,
      clientId: client.id,
      expiresAt: client.expiresAt,
      joinBy: client.inviteExpiresAt,
      scopes,
      mascot: client.mascot,
    };
  }
  // A browser agent gets structured reads and, optionally, screen scrolling
  // or requests for one owner-reviewed action. Restricted commands are reads;
  // legacy command requests remain manual handoffs.
  // It never inherits shell, ordinary screen-input, or owner capabilities.
  function inviteBrowser(input, browserAppApprover) {
    const checked = validateBrowserInvitation(input);
    if (checked.preset) return invitePresetBrowser(checked, browserAppApprover);
    const {
      name, ttlSeconds, joinSeconds, folders, terminalIds, screen,
      commandRequests, restrictedTerminal, terminalApproval, scriptApproval, transport, appAccess,
    } = checked;
    const roots = [...new Set(chooseFolders(folders))];
    const { scopes, policy } = browserAccess({ terminalIds, screen, commandRequests, restrictedTerminal, terminalApproval, scriptApproval, appAccess }, roots);
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    const client = {
      id: id(), kind: "agent", name: name.trim(), scopes,
      ...(screen === "apps" && browserAppApprover ? { browserAppApprover: structuredClone(browserAppApprover) } : {}),
      ...(transport === "funnel" ? { browserTransport: "funnel" } : {}),
      policy,
      inviteHash: hash(token),
      inviteExpiresAt: now + Math.min(joinSeconds, ttlSeconds) * 1000,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + ttlSeconds * 1000,
    };
    changeClients((latest) => {
      if (latest.filter((entry) => entry.policy?.browser === true &&
          entry.expiresAt > now && (!entry.inviteExpiresAt || entry.inviteExpiresAt > now)).length >= 50)
        throw fail(429, "End an existing browser invitation before creating another.");
      return [...latest, client];
    });
    return {
      invitation: token, clientId: client.id,
      expiresAt: client.expiresAt, joinBy: client.inviteExpiresAt, scopes, mascot: client.mascot,
    };
  }
  // Keep convenient configured roots for Full control (presetPolicy adds the
  // filesystem root). Read only defaults to shareable configured folders;
  // Files needs chosen folders; Apps has none.
  const shareable = (preset) => config.roots.filter((root) => {
    try { validateBrowserRoot(root, { policy: { browser: true, preset } }); return true; }
    catch { return false; }
  });
  const presetRoots = (checked, chosen) =>
    checked.preset === "apps" ? [] : chosen.length || checked.preset === "files" ? chosen : shareable(checked.preset);
  // One of four presets. Its apps were matched to this Mac's catalog by the
  // route; its scopes are derived from the preset on every request.
  function invitePresetBrowser(checked, browserAppApprover) {
    const policy = presetPolicy(checked, presetRoots(checked, [...new Set(chooseFolders(checked.folders))]));
    const scopes = presetScopes(policy);
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    const client = {
      id: id(), kind: "agent", name: checked.name.trim(), scopes,
      ...(hostGuardedPreset(policy) && browserAppApprover ? { browserAppApprover: structuredClone(browserAppApprover) } : {}),
      ...(checked.transport === "funnel" ? { browserTransport: "funnel" } : {}),
      policy,
      inviteHash: hash(token),
      // Kept after joining, so the owner can reopen the same link for a new
      // browser (reopenBrowserInvitation); it works only while reopened.
      ...(checked.transport === "funnel" && !checked.hosted ? { linkHash: hash(token) } : {}),
      // A hosted agent (an MCP client at a URL: claude.ai, ChatGPT, Muse,
      // Grok): it connects through OAuth, with the owner's code (hosted-mcp.mjs).
      ...(checked.hosted ? { hosted: true, connectorHash: hash(hostedConnector(token)) } : {}),
      // Always joins like any link: once, within the join window.
      inviteExpiresAt: now + (checked.standing ? checked.joinSeconds : Math.min(checked.joinSeconds, checked.ttlSeconds)) * 1000,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + (checked.standing ? STANDING_SECONDS : checked.ttlSeconds) * 1000,
    };
    changeClients((latest) => {
      if (latest.filter((entry) => entry.policy?.browser === true &&
          entry.expiresAt > now && (!entry.inviteExpiresAt || entry.inviteExpiresAt > now)).length >= 50)
        throw fail(429, "End an existing browser invitation before creating another.");
      return [...latest, client];
    });
    return {
      invitation: token, clientId: client.id, preset: policy.preset,
      expiresAt: client.expiresAt, joinBy: client.inviteExpiresAt, scopes, mascot: client.mascot,
    };
  }
  function browserAccess({ terminalIds, screen, commandRequests, restrictedTerminal, terminalApproval, scriptApproval, appAccess }, roots) {
    if (restrictedTerminal && !roots.length)
      throw fail(400, "Choose at least one folder for restricted terminal commands.");
    if (!roots.length && !terminalIds.length && screen === "off" && !commandRequests && !restrictedTerminal)
      throw fail(400, "Choose a folder, terminal output, screen access, or command requests.");
    const scopes = [
      "device",
      ...(roots.length ? ["files:read"] : []),
      "browser:read",
      ...(screen === "scroll" ? ["browser:scroll"] : []),
      ...(["ask", "apps"].includes(screen) || commandRequests || restrictedTerminal ? ["browser:request"] : []),
    ];
    return {
      scopes,
      policy: {
        invite: true, browser: true, roots,
        terminalIds: [...new Set(terminalIds)], screen,
        ...(screen === "apps" ? { appAccess: structuredClone(appAccess) } : {}),
        ...(commandRequests ? { commandRequests: true } : {}),
        ...(restrictedTerminal ? { restrictedTerminal: true } : {}),
        ...(terminalApproval ? { terminalApproval: true } : {}),
        ...(scriptApproval ? { scriptApproval: true } : {}),
      },
    };
  }
  // What an agent may do in its folders (inviting it, or changing it later).
  // Never the screen, apps or managing access: only agent scopes.
  function agentAccess({ write = false, exec = false, terminal = false, codex = false }, roots) {
    if ([write, exec, terminal, codex].some((v) => typeof v !== "boolean"))
      throw fail(400, "Choose what the agent may do.");
    // At least one folder: it's where the agent's files, commands and
    // sessions start.
    if (!roots.length)
      throw fail(400, "Choose at least one folder for the agent.");
    const scopes = [
      "device",
      "files:read",
      ...(write ? ["files:write"] : []),
      ...(exec ? ["exec"] : []),
      ...(terminal ? ["terminal"] : []),
      ...(codex ? ["codex"] : []),
    ];
    if (scopes.some((s) => !AGENT_SCOPES.includes(s)))
      throw fail(400, "Invalid agent access.");
    return { scopes, roots };
  }
  // Change what someone you invited may use, without a new link: the same
  // choices and checks as inviting them. Their credential, their device and
  // their time stay; every request checks the new access from the next one.
  // `folders: "keep"` keeps the folders they have (never "everything" from
  // full access: those are chosen again).
  function changeAccess(clientId, changes = {}) {
    if (!isPlainRecord(changes) || Object.keys(changes).some((key) =>
      !["folders", "roots", "write", "screen", "apps", "terminal", "agents", "full", "fullControlVersion", "exec", "codex", "terminalIds", "commandRequests", "restrictedTerminal", "terminalApproval", "scriptApproval", "expiresAt", "appAccess", "preset", "hidden"].includes(key)))
      throw fail(400, "Choose valid permissions and an end time.");
    let result;
    changeClients((latest) => {
      const client = latest.find((c) => c.id === clientId);
      if (fullControlNeedsInvitation(client?.policy))
        throw fail(409, "This older Full control grant has ended. Create a new invitation to approve unrestricted access.");
      if (
        !client ||
        !(
          client.kind === "guest" ||
          (client.kind === "agent" && client.policy?.invite)
        ) ||
        client.expiresAt <= Date.now() ||
        (client.inviteExpiresAt && client.inviteExpiresAt <= Date.now())
      )
        throw fail(404, "That invitation has ended.");
      // Moving to another browser (relink): already approved, so the owner's
      // edits carry over as for a collected session.
      const moving = client.admission?.moved === true;
      if (client.browserTransport === "funnel" && client.admission && admissionStatus(client) === "expired" && !moving)
        throw fail(404, "That invitation has ended.");
      if (client.admission && client.admission.status !== "collected" && !moving)
        throw fail(409, "This agent's first connection is waiting or has ended. Create a new invitation to change its access.");
      const guest = client.kind === "guest";
      const browser = client.policy?.browser === true;
      const expiresAt = changes.expiresAt ?? client.expiresAt;
      // Preset invitations over Funnel may run a full day; the earlier form stays at an hour.
      const maxSeconds = client.browserTransport === "funnel" && client.policy?.preset === undefined ? 3600 : guest || browser ? 86400 : 90 * 86400;
      if (Object.hasOwn(changes, "expiresAt") &&
          (!Number.isSafeInteger(changes.expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + maxSeconds * 1000))
        throw fail(400, "Choose an end time within this invitation’s duration limit.");
      const had = guest
        ? client.scopes.includes("admin")
          ? []
          : client.guestRoots || []
        : client.policy.roots || [];
      const keep = changes.folders === "keep";
      if (keep && !had.length)
        throw fail(400, "Choose the folders they may use.");
      const folders = keep ? had : chooseFolders(changes.folders ?? []);
      const before = {
        scopes: [...client.scopes],
        fullControlVersion: client.fullControlVersion,
        roots: guest ? [...(client.guestRoots || [])] : [...had],
        apps: client.guestApps,
      };
      if (browser && client.policy.preset !== undefined) {
        // The same checks as inviting with a preset. Apps were matched to the
        // catalog by the route; an unchanged Apps preset keeps its apps.
        const { folders: ignoredFolders, expiresAt: ignoredExpiry, roots: ignoredRoots, ...permissions } = changes;
        const preset = permissions.preset ?? client.policy.preset;
        if ((preset === "full" && client.policy.preset !== "full") ||
            (preset === "apps" && !hostGuardedPreset(client.policy)))
          throw fail(409, "Full control and Apps need a new invitation from your phone.");
        const apps = permissions.apps ?? (preset === "apps" && preset === client.policy.preset ? client.policy.apps : undefined);
        const checked = validateBrowserInvitation({
          ...permissions, preset, ...(apps !== undefined ? { apps } : {}), name: client.name, ttlSeconds: 60,
          ...(preset === "full" ? { fullControlVersion: client.policy.fullControlVersion } : {}),
          transport: client.browserTransport || "tailnet", folders: [],
          ...(permissions.hidden === undefined && ["full", "readonly"].includes(preset) && client.policy.hidden ? { hidden: client.policy.hidden } : {}),
          // Watched terminals stay unless the edit names them (the phone's
          // editor doesn't send them).
          ...(permissions.terminalIds === undefined && ["full", "readonly"].includes(preset) && client.policy.terminalIds?.length ? { terminalIds: client.policy.terminalIds } : {}),
        }, { folderCount: folders.length });
        const policy = presetPolicy(checked, presetRoots(checked, folders));
        // A changed preset keeps Always access; only Stop ends it.
        if (standingPolicy(client.policy)) policy.standing = true;
        // Taking the Mac needs the phone that creates the invitation (the host
        // guard binds it); an invitation that didn't have it can't grow into it.
        if (hostGuardedPreset(policy) && (!hostGuardedPreset(client.policy) ||
            (policy.preset === "full" && client.policy.preset !== "full")))
          throw fail(409, "Full control and Apps need a new invitation from your phone.");
        client.scopes = presetScopes(policy);
        client.policy = policy;
      } else if (browser) {
        const { folders: ignoredFolders, expiresAt: ignoredExpiry, ...permissions } = changes;
        // Use the invitation's schema, so edits cannot add shell/admin scopes,
        // change transport, or enable unsupported command execution.
        const input = validateBrowserInvitation({
          ...permissions, name: client.name, ttlSeconds: 60,
          transport: client.browserTransport || "tailnet", folders: [],
        });
        const access = browserAccess(input, folders);
        client.scopes = access.scopes;
        client.policy = access.policy;
      } else if (guest) {
        const { roots, write, screen, apps, terminal, agents, full, fullControlVersion } = changes;
        const access = guestAccess(
          { roots, write, screen, apps, terminal, agents, full, fullControlVersion },
          folders,
        );
        if (!access) throw fail(400, "Choose what they may use.");
        client.scopes = access.scopes;
        client.guestRoots = access.guestRoots;
        if (access.fullControlVersion) client.fullControlVersion = access.fullControlVersion;
        else delete client.fullControlVersion;
        if (access.guestApps) client.guestApps = access.guestApps;
        else delete client.guestApps;
      } else {
        const access = agentAccess(changes, folders);
        client.scopes = access.scopes;
        client.policy = { ...client.policy, roots: access.roots };
      }
      client.expiresAt = expiresAt;
      // Keep the already-approved, browser-bound credential. Outstanding
      // action approvals have their own old grant and are invalidated below.
      if (client.admission?.status === "collected" || client.admission?.moved === true)
        client.admission.grant = admissionGrant(client);
      client.changedAt = new Date().toISOString();
      result = {
        client: {
          id: client.id,
          kind: client.kind,
          name: client.name,
          scopes: client.scopes,
          expiresAt: client.expiresAt,
          ...(guest
            ? { guestRoots: client.guestRoots }
            : { policy: client.policy }),
          ...(client.guestApps ? { guestApps: client.guestApps } : {}),
          ...(client.group ? { group: client.group } : {}),
        },
        before,
        after: {
          scopes: client.scopes,
          fullControlVersion: client.fullControlVersion,
          roots: guest ? client.guestRoots : client.policy.roots,
          apps: client.guestApps,
        },
      };
      return latest;
    });
    return result;
  }
  const admissionGrant = (client) => hash(JSON.stringify({
    id: client.id,
    name: client.name,
    kind: client.kind,
    scopes: client.scopes,
    policy: client.policy,
    expiresAt: client.expiresAt,
    tailscale: client.tailscale,
    browserTransport: client.browserTransport,
    browserBinding: client.browserBinding,
    browserAppApprover: client.browserAppApprover,
    hosted: client.hosted,
    // Only on invitations from the removed private-copy feature; the agent
    // policy refuses them.
    ...(client.browserWorkspaceId ? { browserWorkspaceId: client.browserWorkspaceId } : {}),
  }));
  const admissionStatus = (client, now = Date.now()) => {
    const request = client.admission;
    if (!request) return null;
    if (client.expiresAt <= now || fullControlNeedsInvitation(client.policy)) return "expired";
    if ((client.browserTransport === "funnel" || (client.policy?.browser === true && (client.policy.screen === "apps" || hostGuardedPreset(client.policy)))) &&
        request.grant !== admissionGrant(client)) return "expired";
    if (request.status === "collected")
      return browserIdleEnded(client, now) ? "expired" : "accepted";
    if (request.status === "denied") return "denied";
    if (request.expiresAt <= now || request.grant !== admissionGrant(client)) return "expired";
    return ["pending", "approved"].includes(request.status) ? request.status : "expired";
  };
  const admissionView = (client) => ({
    requestId: client.admission.requestId,
    clientId: client.id,
    name: client.name,
    ...(Number.isInteger(client.mascot) ? { mascot: client.mascot } : {}),
    scopes: [...client.scopes],
    roots: [...(client.policy?.roots || [])],
    browser: client.policy?.browser === true,
    ...(client.policy?.browser ? {
      ...(client.policy.preset ? { preset: client.policy.preset, apps: (client.policy.apps || []).map(({ id, name }) => ({ id, ...(name !== undefined ? { name } : {}) })), hidden: (client.policy.hidden || []).map(({ id, name }) => ({ id, ...(name !== undefined ? { name } : {}) })), ...(client.policy.write ? { write: true } : {}) } : {}),
      screen: client.policy.screen,
      terminalIds: [...(client.policy.terminalIds || [])],
      commandRequests: client.policy.commandRequests === true,
      ...(client.policy.restrictedTerminal ? { restrictedTerminal: true } : {}),
      ...(client.policy.terminalApproval ? { terminalApproval: true } : {}),
      ...(client.policy.scriptApproval ? { scriptApproval: true } : {}),
      ...(client.policy.screen === "apps" ? { appAccess: client.policy.appAccess.map(({id,mode}) => ({id,mode})) } : {}),
      ...(client.browserTransport === "funnel" ? { browserTransport: "funnel" } : {}),
      ...(client.hosted === true ? { hosted: true, ...(client.hostedClient ? { hostedClient: client.hostedClient } : {}) } : {}),
    } : {}),
    requestedAt: client.admission.requestedAt,
    expiresAt: client.admission.expiresAt,
    accessExpiresAt: client.expiresAt,
    verificationCode: client.admission.verificationCode,
    ...(client.nodeName ? { nodeName: client.nodeName } : {}),
    ...(client.tailscale?.nodeId ? { nodeId: client.tailscale.nodeId } : {}),
  });
  // Invited people keep immediate single-use redemption. Invited agents first
  // consume the link into a receipt with no access credential. A paired owner
  // must separately approve that exact claim before the claimant can collect.
  const validBrowserBinding = (value) =>
    typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, "base64url").toString("base64url") === value;
  const isFunnelBrowser = (client) =>
    client?.kind === "agent" && client.policy?.invite === true &&
    client.policy.browser === true && client.browserTransport === "funnel" &&
    !client.tailscale;
  // A Tools invitation made for the tailnet (an invite key), not opened yet:
  // it may be opened through the public link instead, by an agent that can't
  // reach Tailscale from where it runs ("public link or private", Oct 10).
  const toolsLink = (client) =>
    client?.kind === "agent" && client.policy?.invite === true && client.policy.browser === true &&
    client.policy.preset !== undefined && client.browserTransport === undefined && !client.tailscale &&
    !client.browserBinding && typeof client.inviteHash === "string";
  const claimSource = (client) => client.browserTransport === "funnel"
    ? `browser:${client.browserBinding}`
    : `tailnet:${client.tailscale?.nodeId || "unbound"}`;
  // An agent's one link, after its first opening. Approved by the owner: from
  // its own browser it refreshes the session (a lost answer, a rotated token);
  // from another browser (the agent's browser reset, a new tab, another machine)
  // opening it moves the access there and the browser it used is cut off. An
  // automatic reconnect never moves it (423): only opening the link does, so
  // two open browsers can't take it back and forth. Not approved yet: the
  // browser that opened it gets its waiting request again, nobody else gets
  // anything. Only an ended access (410), a declined one (403) or an unknown
  // or revoked link (revoking deletes it: null, 401) is final.
  const REBINDS_PER_MINUTE = 6;
  // A waiting browser checks in every few seconds. Kept in memory: polling
  // writes nothing. After a restart, and when Reach comes back from a pause
  // or a network outage (index.mjs), the quiet clock starts again: a waiting
  // agent that couldn't check in meanwhile always gets to before anyone else
  // may move it (security audit L3).
  const WAITING_QUIET_MS = 60_000;
  const waitingSeen = new Map(); // admission requestId -> last check-in
  // Check-ins a day old are long past any request's wait (they were kept for
  // good: reliability audit, Oct 10).
  const sawWaiting = (requestId, at) => {
    waitingSeen.set(requestId, at);
    if (waitingSeen.size > 200)
      for (const [id, seen] of waitingSeen) if (at - seen > 86400000) waitingSeen.delete(id);
  };
  let authStarted = Date.now();
  // The terms the owner approved must still be the record's terms: a change
  // that fails closed (another supervising phone, say) is never re-approved.
  const rebindable = (client, now = Date.now()) =>
    isFunnelBrowser(client) && client.policy?.preset !== undefined &&
    typeof client.linkHash === "string" && ownerApproved(client) &&
    client.admission?.grant === admissionGrant(client) &&
    client.expiresAt > now && !!applyAgentPolicy(client, config);
  function relink(latest, invitation, keyThumbprint, reconnect) {
    const now = Date.now();
    const client = latest.find((c) => isFunnelBrowser(c) && typeof c.linkHash === "string" && sameHash(c.linkHash, hash(invitation)));
    if (!client) return null;
    if (!(client.expiresAt > now) || !applyAgentPolicy(client, config))
      throw fail(410, "This agent's access has ended.");
    const receipt = (requestSecret, extra) => ({
      status: "pending",
      requestId: client.admission.requestId,
      requestSecret,
      verificationCode: client.admission.verificationCode,
      expiresAt: client.admission.expiresAt,
      clientId: client.id,
      kind: "agent",
      ...extra,
    });
    // The browser the owner approved last gets its access back at once
    // (records from before Oct 9: the browser holding the approved access).
    // Any other browser asks the owner again with a new code: a copied link
    // alone never moves the access (security audit H3), and a browser the
    // owner declined is refused. One already waiting keeps its code (below).
    const approvedKey = client.approvedBinding ??
      (["collected", "approved"].includes(client.admission?.status) ? client.browserBinding : undefined);
    const trusted = approvedKey === keyThumbprint;
    const waitingHere = client.browserBinding === keyThumbprint && admissionStatus(client, now) === "pending";
    if (rebindable(client, now) && (trusted || !waitingHere)) {
      if (client.browserBinding !== keyThumbprint && reconnect && !trusted)
        throw fail(423, "This agent's access is in use in another browser.");
      if (!trusted && (client.deniedBindings || []).includes(keyThumbprint))
        throw fail(403, "The owner declined this agent's connection from this browser.");
      const recent = (client.rebinds || []).filter((at) => at > now - 60000);
      if (recent.length >= REBINDS_PER_MINUTE)
        throw fail(429, "This link was opened too often just now. Wait a minute and try again.");
      client.rebinds = [...recent, now];
      // What was approved stays recorded while another browser waits.
      client.approvedAt ||= now;
      if (approvedKey) client.approvedBinding = approvedKey;
      // The previous token and receipt end here, in the same write.
      for (const key of ["hash", "pendingHash", "retiredHashes", "browserIdleExpiresAt", "redeemedAt", "inviteHash", "inviteExpiresAt"]) delete client[key];
      client.browserBinding = keyThumbprint;
      const requestSecret = crypto.randomBytes(32).toString("base64url");
      // `moved`: the owner's edits carry over, as for a collected session.
      client.admission = {
        requestId: id(),
        secretHash: hash(requestSecret),
        verificationCode: crypto.randomInt(100000, 1000000).toString(),
        requestedAt: now,
        moved: true,
        grant: admissionGrant(client),
        // Its approved browser: collected on the page's next check, any time
        // while the access lasts. Another: the owner's answer, for 5 minutes.
        ...(trusted
          ? { expiresAt: client.expiresAt, status: "approved" }
          : { expiresAt: Math.min(now + 300000, client.expiresAt), status: "pending" }),
      };
      // `moving`: an approved browser was cut off; the owner is asked.
      return receipt(requestSecret, trusted ? { refreshed: true } : { moving: true });
    }
    if (client.admission?.status === "denied")
      throw fail(403, "The owner declined this agent's connection.");
    // Still waiting for the owner, opened in another browser, and the first
    // browser has stopped checking in for a minute (its machine was replaced):
    // the waiting request moves under a new request and code, and the first
    // one ends. A browser still waiting is never taken over; the owner
    // matches the code the new browser shows.
    if (client.admission && client.browserBinding !== keyThumbprint && !reconnect &&
        admissionStatus(client, now) === "pending" &&
        now - Math.max(waitingSeen.get(client.admission.requestId) || 0, client.admission.requestedAt || 0, authStarted) > WAITING_QUIET_MS) {
      const recent = (client.rebinds || []).filter((at) => at > now - 60000);
      if (recent.length >= REBINDS_PER_MINUTE)
        throw fail(429, "This link was opened too often just now. Wait a minute and try again.");
      client.rebinds = [...recent, now];
      client.browserBinding = keyThumbprint;
      const requestSecret = crypto.randomBytes(32).toString("base64url");
      client.admission = {
        ...client.admission,
        requestId: id(),
        secretHash: hash(requestSecret),
        verificationCode: crypto.randomInt(100000, 1000000).toString(),
        requestedAt: now,
        grant: admissionGrant(client),
      };
      // A new request for the owner (not a moved access: nobody is cut off).
      return receipt(requestSecret);
    }
    // The owner didn't answer in time, the invitation still lasts: opening
    // the link asks again, from whichever browser opens it, with a new code.
    const asked = client.admission;
    if (asked && asked.status === "pending" && !reconnect && asked.expiresAt <= now &&
        client.expiresAt > now && asked.grant === admissionGrant(client)) {
      const recent = (client.rebinds || []).filter((at) => at > now - 60000);
      if (recent.length >= REBINDS_PER_MINUTE)
        throw fail(429, "This link was opened too often just now. Wait a minute and try again.");
      client.rebinds = [...recent, now];
      client.browserBinding = keyThumbprint;
      const requestSecret = crypto.randomBytes(32).toString("base64url");
      client.admission = {
        requestId: id(),
        secretHash: hash(requestSecret),
        verificationCode: crypto.randomInt(100000, 1000000).toString(),
        requestedAt: now,
        expiresAt: Math.min(now + 300000, client.expiresAt),
        status: "pending",
        grant: admissionGrant(client),
      };
      return receipt(requestSecret);
    }
    if (client.browserBinding !== keyThumbprint || !client.admission) return null;
    const status = admissionStatus(client, now);
    // Its answer was lost: the same waiting request (same code), a new secret.
    if (status === "pending") {
      sawWaiting(client.admission.requestId, now);
      const requestSecret = crypto.randomBytes(32).toString("base64url");
      client.admission.secretHash = hash(requestSecret);
      return receipt(requestSecret, { resumed: true });
    }
    if (status === "expired")
      throw fail(410, "This invitation expired before it was approved.");
    return null;
  }
  // hold: an agent has Full control or Apps right now (the host guard). The
  // person comes in, bound to their device, and waits for the owner's Allow
  // (allowPerson) before anything else: an agent that saw the link on the
  // Mac's screen can't use it to step outside its own limits.
  function redeemGuest(invitation, identity, { hold = false } = {}) {
    return redeemInvitation(invitation, identity, undefined, false, hold);
  }
  // A pre-existing browser person also needs explicit coexistence approval:
  // its embedded Tailscale node does not prove a separate physical device.
  function holdPerson(clientId, identity) {
    let result = null;
    changeClients((latest) => {
      const client = latest.find((c) => c.id === clientId && c.kind === "guest");
      if (!client || !identity?.nodeId || client.tailscale?.nodeId !== identity.nodeId ||
          client.macEntry?.status === "waiting" || !(client.expiresAt > Date.now())) return latest;
      client.macEntry = { status: "waiting", nodeId: identity.nodeId, requestedAt: new Date().toISOString(),
        ...(typeof identity.nodeName === "string" ? { nodeName: identity.nodeName.slice(0, 160) } : {}) };
      result = { id: client.id, name: client.name, macEntry: client.macEntry };
      return latest;
    });
    return result;
  }
  // The owner's Allow for a person who came in while an agent had the Mac.
  function allowPerson(clientId) {
    let result;
    changeClients((latest) => {
      const client = latest.find((c) => c.id === clientId && c.kind === "guest");
      if (!client || client.macEntry?.status !== "waiting" || !(client.expiresAt > Date.now()))
        throw fail(404, "This person isn't waiting any more.");
      client.macEntry = { ...client.macEntry, status: "allowed", allowedAt: new Date().toISOString() };
      result = { id: client.id, name: client.name };
      return latest;
    });
    return result;
  }
  function redeemFunnelBrowser(invitation, keyThumbprint) {
    if (!validBrowserBinding(keyThumbprint))
      throw fail(401, "A valid browser key is required to claim this invitation.");
    return redeemInvitation(invitation, undefined, keyThumbprint);
  }
  // The agent's page, on its own after a refused request: like opening the
  // link, except that it never moves the access from another browser.
  function reconnectFunnelBrowser(invitation, keyThumbprint) {
    if (!validBrowserBinding(keyThumbprint))
      throw fail(401, "A valid browser key is required to reconnect.");
    return redeemInvitation(invitation, undefined, keyThumbprint, true);
  }
  // An agent's claim becomes a request the owner answers: the invitation is
  // spent, the claimant bound (its browser key, or its tailnet node), a code
  // made for the owner to match. Shared by links and hosted agents.
  function startAdmission(latest, client, now, { funnel, keyThumbprint, identity }) {
    if (fullControlNeedsInvitation(client.policy))
      throw fail(410, "This older Full control grant has ended. Ask the owner for a new invitation to approve unrestricted access.");
    const source = funnel ? `browser:${keyThumbprint}` : `tailnet:${identity?.nodeId || "unbound"}`;
    const active = latest.filter((c) => ["pending", "approved"].includes(admissionStatus(c, now)));
    if (active.length >= 20 || active.filter((c) => claimSource(c) === source).length >= 3)
      throw fail(429, "An agent connection is already waiting. Finish it before opening another invitation.");
    const recent = latest.filter((c) => c.admission?.requestedAt > now - 60000);
    if (recent.length >= 60 || recent.filter((c) => claimSource(c) === source).length >= 10)
      throw fail(429, "Too many agent connection requests. Wait a minute and try again.");
    delete client.inviteHash;
    delete client.hash;
    delete client.pendingHash;
    delete client.retiredHashes;
    delete client.inviteExpiresAt;
    if (funnel) client.browserBinding = keyThumbprint;
    if (identity?.nodeId) client.tailscale = {
      userId: identity.userId || "",
      nodeId: identity.nodeId,
      ...(identity.tagged ? { tagged: true } : {}),
    };
    if (typeof identity?.nodeName === "string") client.nodeName = identity.nodeName.slice(0, 160);
    const requestSecret = crypto.randomBytes(32).toString("base64url");
    client.admission = {
      requestId: id(),
      secretHash: hash(requestSecret),
      verificationCode: crypto.randomInt(100000, 1000000).toString(),
      requestedAt: now,
      expiresAt: Math.min(now + 300000, client.expiresAt),
      status: "pending",
      grant: admissionGrant(client),
    };
    return {
      status: "pending",
      requestId: client.admission.requestId,
      requestSecret,
      verificationCode: client.admission.verificationCode,
      expiresAt: client.admission.expiresAt,
      clientId: client.id,
      kind: "agent",
    };
  }
  // A hosted agent connecting (hosted-mcp.mjs: OAuth from claude.ai, ChatGPT,
  // Muse, Grok...): the invitation of the address it came to is claimed for
  // it, under a connection id that stands where a browser's key would. The
  // owner matches the code as for any agent. No address, nothing claimed.
  function claimHostedInvitation(binding, { name, clientId, connector } = {}) {
    if (!validBrowserBinding(binding)) throw fail(401, "A valid connection id is required.");
    let result;
    changeClients((latest) => {
      const now = Date.now();
      const client = typeof connector === "string" && /^[A-Za-z0-9_-]{43}$/.test(connector)
        ? latest.find((c) => c.hosted === true && isFunnelBrowser(c) && sameHash(c.connectorHash, hash(connector)) &&
          c.inviteHash && !c.admission && !c.hash && c.expiresAt > now && c.inviteExpiresAt > now)
        : null;
      if (!client) throw fail(404, "No hosted agent invitation is waiting at this address. In Reach, invite a hosted agent and use the address it shows.");
      if (typeof name === "string" && name.trim()) client.hostedClient = name.trim().slice(0, 80);
      if (typeof clientId === "string" && clientId) client.hostedClientId = clientId.slice(0, 128);
      result = startAdmission(latest, client, now, { funnel: true, keyThumbprint: binding });
      return latest;
    });
    return result;
  }
  function redeemInvitation(invitation, identity, keyThumbprint, reconnect = false, hold = false) {
    const funnel = keyThumbprint !== undefined;
    if (
      typeof invitation !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(invitation)
    )
      throw fail(
        401,
        "This guest link expired, was revoked, or has already been used.",
      );
    let result;
    changeClients((latest) => {
      const client = latest.find(
        (c) =>
          ["guest", "agent"].includes(c.kind) &&
          (funnel ? (isFunnelBrowser(c) || toolsLink(c)) && c.hosted !== true : c.browserTransport !== "funnel" && !c.browserBinding) &&
          sameHash(c.inviteHash, hash(invitation)) &&
          c.expiresAt > Date.now() &&
          !(c.inviteExpiresAt && c.inviteExpiresAt <= Date.now()),
      );
      if (!client && funnel) {
        const linked = relink(latest, invitation, keyThumbprint, reconnect);
        if (linked) { result = linked; return latest; }
      }
      if (!client)
        throw fail(
          401,
          "This guest link expired, was revoked, or has already been used.",
        );
      const now = Date.now();
      if (client.kind === "agent") {
        if (!funnel && (config.tailscaleOwner || identity) &&
            (!identity?.nodeId || !(identity.validUntil > now)))
          throw fail(401, "A current Tailscale identity is required to claim this agent invitation.");
        // Always over Tools: only an agent on the device its invite key made,
        // whose credential rotates and whose copy is caught (audit M6).
        if (!funnel && standingPolicy(client.policy) && identity?.tagged !== true)
          throw fail(403, "Always access needs the agent to join with its invite key. Ask the owner for a new invitation.");
        if (funnel && !isFunnelBrowser(client)) {
          // Opened through the public link after all: a public-link agent
          // from here on, its link kept so its key reconnects it.
          client.browserTransport = "funnel";
          client.linkHash = client.inviteHash;
        }
        result = startAdmission(latest, client, now, { funnel, keyThumbprint, identity });
        return latest;
      }
      const token = crypto.randomBytes(32).toString("base64url");
      delete client.inviteHash;
      client.hash = hash(token);
      client.redeemedAt = new Date().toISOString();
      if (identity?.nodeId)
        client.tailscale = {
          userId: identity.userId || "",
          nodeId: identity.nodeId,
          ...(identity.tagged ? { tagged: true } : {}),
        };
      delete client.inviteExpiresAt;
      if (hold && client.kind === "guest")
        client.macEntry = {
          status: "waiting",
          requestedAt: new Date().toISOString(),
          ...(identity?.nodeId ? { nodeId: identity.nodeId } : {}),
          ...(typeof identity?.nodeName === "string" ? { nodeName: identity.nodeName.slice(0, 160) } : {}),
        };
      result = {
        token,
        clientId: client.id,
        expiresAt: client.expiresAt,
        kind: client.kind,
        scopes: client.scopes,
        ...(client.macEntry?.status === "waiting" ? { waiting: true } : {}),
      };
      return latest;
    });
    return result;
  }
  // The owner's "Reopen link" (the owner API; the link of an approved agent
  // already works from any browser): the browser in use is disconnected (the
  // route ends its work) and the link keeps working, nothing to approve. A
  // link not approved yet works once more, for 15 minutes, with the owner's
  // code approval like the first time.
  function reopenBrowserInvitation(clientId) {
    let result;
    changeClients((latest) => {
      const now = Date.now();
      const client = latest.find((c) => c.id === clientId);
      if (!isFunnelBrowser(client) || client.policy?.preset === undefined || !client.linkHash || !(client.expiresAt > now))
        throw fail(404, "This agent's link can't be reopened. Make a new invite.");
      if (fullControlNeedsInvitation(client.policy))
        throw fail(409, "This older Full control grant has ended. Create a new invitation to approve unrestricted access.");
      if (rebindable(client, now)) {
        for (const key of ["hash", "pendingHash", "retiredHashes", "browserIdleExpiresAt", "redeemedAt"]) delete client[key];
        result = { clientId: client.id, joinBy: client.expiresAt };
        return latest;
      }
      // Joined before: never cleared as an unopened invitation (clearUnopened).
      if (client.hash || client.redeemedAt || client.admission?.status === "collected") client.onceJoined = true;
      for (const key of ["hash", "pendingHash", "retiredHashes", "browserBinding", "admission", "browserIdleExpiresAt", "redeemedAt"]) delete client[key];
      client.inviteHash = client.linkHash;
      client.inviteExpiresAt = Math.min(client.expiresAt, now + 900000);
      result = { clientId: client.id, joinBy: client.inviteExpiresAt };
      return latest;
    });
    return result;
  }
  // "New invite link" (Agents & people): an invitation nobody has used yet
  // gets a fresh secret and the old link stops working. Who, what and until
  // when stay; a join window starts over at its first length. As when it was
  // made, the computer keeps only the new link's hash.
  function renewInvitation(clientId) {
    let result;
    changeClients((latest) => {
      const now = Date.now();
      const client = latest.find((c) => c.id === clientId);
      if (!client || !["guest", "agent"].includes(client.kind) || !(client.expiresAt > now))
        throw fail(404, "That invitation has ended.");
      if (fullControlNeedsInvitation(client.policy))
        throw fail(409, "This older Full control grant has ended. Create a new invitation to approve unrestricted access.");
      const status = admissionStatus(client, now);
      if (!client.inviteHash || client.redeemedAt || ["pending", "approved", "accepted"].includes(status))
        throw fail(409, `${client.name} already opened the link. Nothing to send again.`);
      const token = crypto.randomBytes(32).toString("base64url");
      client.inviteHash = hash(token);
      if (typeof client.linkHash === "string") client.linkHash = client.inviteHash;
      delete client.admission;
      if (client.inviteExpiresAt) {
        client.joinMs ??= Math.max(60000, client.inviteExpiresAt - Date.parse(client.createdAt));
        client.inviteExpiresAt = Math.min(client.expiresAt, now + client.joinMs);
      }
      result = {
        invitation: token,
        clientId: client.id,
        expiresAt: client.expiresAt,
        ...(client.inviteExpiresAt ? { joinBy: client.inviteExpiresAt } : {}),
        scopes: client.scopes,
      };
      return latest;
    });
    return result;
  }
  // Whose unopened invitation this is, without spending it: for telling a
  // person why they can't come in yet (index.mjs, the host guard).
  function unopenedInvitation(invitation) {
    if (typeof invitation !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(invitation)) return null;
    const digest = hash(invitation), now = Date.now();
    const client = loadJson(file, []).find((c) => sameHash(c.inviteHash, digest) && c.expiresAt > now &&
      !(c.inviteExpiresAt && c.inviteExpiresAt <= now));
    return client ? { id: client.id, kind: client.kind, name: client.name } : null;
  }
  function listAgentAdmissions() {
    return loadJson(file, []).filter((client) =>
      client.kind === "agent" && admissionStatus(client) === "pending",
    ).map(admissionView);
  }
  function decideAgentAdmission(requestId, decision) {
    if (!["approve", "deny"].includes(decision))
      throw fail(400, "Approve or deny this agent connection.");
    let result;
    changeClients((latest) => {
      const client = latest.find((c) => c.kind === "agent" && c.admission?.requestId === requestId);
      if (!client) throw fail(404, "This agent connection request was not found.");
      if (admissionStatus(client) !== "pending")
        throw fail(409, "This agent connection request is no longer pending.");
      client.admission.status = decision === "approve" ? "approved" : "denied";
      // Lasting: its link then reconnects this browser at once, and asks the
      // owner again from any other (rebindable).
      if (decision === "approve") {
        client.approvedAt = Date.now();
        if (client.browserBinding) client.approvedBinding = client.browserBinding;
      } else if (client.admission.moved && client.browserBinding)
        // A move declined: that browser is refused from then on; the agent's
        // approved browser keeps its link.
        client.deniedBindings = [...(client.deniedBindings || []), client.browserBinding].slice(-16);
      result = { requestId, clientId: client.id, status: client.admission.status };
      return latest;
    });
    return result;
  }
  function pollAgentAdmission(requestId, requestSecret, identity) {
    return pollAdmission(requestId, requestSecret, identity);
  }
  function pollFunnelAdmission(requestId, requestSecret, keyThumbprint) {
    if (!validBrowserBinding(keyThumbprint))
      throw fail(401, "This agent connection receipt is invalid or belongs to another browser.");
    return pollAdmission(requestId, requestSecret, undefined, keyThumbprint);
  }
  function pollAdmission(requestId, requestSecret, identity, keyThumbprint) {
    const funnel = keyThumbprint !== undefined;
    if (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/.test(requestId) ||
        typeof requestSecret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(requestSecret))
      throw fail(401, "This agent connection receipt is invalid.");
    const inspect = (latest) => {
      const client = latest.find((c) => c.kind === "agent" && c.admission?.requestId === requestId);
      if (!client) return { result: { status: "expired" } };
      const request = client.admission;
      if (funnel ? !isFunnelBrowser(client) || client.browserBinding !== keyThumbprint
        : client.browserTransport === "funnel" || client.browserBinding)
        throw fail(401, "This agent connection receipt belongs to another connection type or browser.");
      if (hash(requestSecret) !== request.secretHash ||
          (!funnel && config.tailscaleOwner && !(identity?.validUntil > Date.now())) ||
          (client.tailscale && (!identity || !(identity.validUntil > Date.now()) ||
            client.tailscale.nodeId !== identity.nodeId || client.tailscale.userId !== (identity.userId || ""))))
        throw fail(401, "This agent connection receipt is invalid or belongs to another device.");
      const status = admissionStatus(client);
      if (status === "pending") sawWaiting(requestId, Date.now());
      if (["pending", "denied", "expired"].includes(status))
        return { result: { status, expiresAt: request.expiresAt } };
      if (status === "accepted")
        throw fail(409, "This agent credential was already collected. Open the link again in this browser to reconnect.");
      if (status !== "approved") throw fail(401, "This agent connection receipt is invalid.");
      return { client };
    };
    // Public receipt polling is read-only until a valid, approved claimant
    // collects. Unknown IDs must never rewrite credentials or hold their lock.
    const initial = inspect(loadJson(file, []));
    if (initial.result) return initial.result;
    let result;
    changeClients((latest) => {
      // Another process may have denied, revoked, or collected after the read.
      // Recheck the secret, identity, exact grant, state, and deadline under lock.
      const checked = inspect(latest);
      if (checked.result) { result = checked.result; return latest; }
      const client = checked.client;
      const request = client.admission;
      const permitted = applyAgentPolicy(client, config);
      if (!permitted) {
        request.status = "denied";
        result = { status: "denied", expiresAt: request.expiresAt };
        return latest;
      }
      const token = crypto.randomBytes(32).toString("base64url");
      client.hash = hash(token);
      client.redeemedAt = new Date().toISOString();
      request.status = "collected";
      if (funnel && client.hosted !== true) client.browserIdleExpiresAt = Math.min(client.expiresAt, Date.now() + (client.policy?.preset ? 600000 : 120000));
      // A hosted agent: the credential collected here is its refresh token;
      // its first access token (an hour) comes with it. Collected but never
      // used, an Always access still ends after the week.
      const hostedAccess = client.hosted === true ? crypto.randomBytes(32).toString("base64url") : null;
      if (hostedAccess) {
        client.accessHash = hash(hostedAccess);
        client.accessUntil = Date.now() + HOSTED_ACCESS_MS;
        client.usedAt = Date.now();
      }
      // Persist the consumed receipt and token hash in one atomic write before
      // returning. A dropped response can never mint a second credential.
      result = {
        status: "approved", token, clientId: client.id, kind: "agent",
        scopes: permitted.scopes, expiresAt: client.expiresAt,
        ...(hostedAccess ? { accessToken: hostedAccess, accessSeconds: HOSTED_ACCESS_MS / 1000 } : {}),
        // Always: the page keeps this session in the browser's lasting storage.
        ...(standingPolicy(client.policy) ? { standing: true } : {}),
      };
      return latest;
    });
    return result;
  }
  function funnelSession(client, keyThumbprint, now = Date.now()) {
    if (!isFunnelBrowser(client) || !validBrowserBinding(keyThumbprint) ||
        client.browserBinding !== keyThumbprint || !client.hash ||
        client.admission?.status !== "collected" || !(client.expiresAt > now) ||
        browserIdleEnded(client, now) ||
        client.admission.grant !== admissionGrant(client)) return null;
    return applyAgentPolicy(client, config);
  }
  // The browser keys of public-link agents that have access (the one in
  // use, the one the owner approved), and of ones that ended lately: the
  // public door opens to them alone when nothing else needs it, the gateway
  // keeps capacity for them no stranger's traffic can take (audit M3), and an
  // agent that ended hears that it ended instead of finding nothing.
  const ENDED_KEYS_MS = 7 * 86400_000;
  const endedKeys = new Map();
  let endedVersion = 0;
  const endedHosted = new Map();
  const endedConnectors = new Map();
  const rememberEnded = (client) => {
    for (const key of [client?.browserBinding, client?.approvedBinding]) if (validBrowserBinding(key)) {
      endedKeys.set(key, Date.now() + ENDED_KEYS_MS);
      if (client.hosted === true) endedHosted.set(key, Date.now() + ENDED_KEYS_MS);
      if (client.hosted === true && typeof client.connectorHash === "string") endedConnectors.set(client.connectorHash, Date.now() + ENDED_KEYS_MS);
    }
    while (endedKeys.size > 256) endedKeys.delete(endedKeys.keys().next().value);
    endedVersion++;
  };
  // Atomic writes can share an mtime. Include the file identity and nanosecond
  // metadata for other writers, and a generation for successful local writes.
  // An uninspectable store must never reuse a cached public-door admission.
  const credentialRevision = () => {
    try {
      const stat = fs.statSync(file, { bigint: true });
      if (!stat.isFile()) return null;
      return `${credentialGeneration}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    } catch { return null; }
  };
  const publicDoorClients = () => {
    try { return listStoredClients(); } catch { return null; }
  };
  let keysMemo = { revision: null, ended: -1, at: 0, keys: new Set() };
  function funnelKeys() {
    const now = Date.now();
    const revision = credentialRevision();
    if (revision === null) return new Set();
    if (keysMemo.revision === revision && keysMemo.ended === endedVersion && now - keysMemo.at < 60_000) return keysMemo.keys;
    const stored = publicDoorClients();
    if (stored === null) return new Set();
    for (const [key, until] of endedKeys) if (until <= now) endedKeys.delete(key);
    const keys = new Set([...stored.filter((c) => isFunnelBrowser(c) && c.expiresAt > now - ENDED_KEYS_MS)
      .flatMap((c) => [c.browserBinding, c.approvedBinding]), ...endedKeys.keys()].filter(validBrowserBinding));
    keysMemo = { revision, ended: endedVersion, at: now, keys };
    return keys;
  }
  // Door keys (Oct 10): a browser that came in without the Tailscale app
  // talks to Reach through the tailnet, but its page and code (a screen
  // opened later, a reload) come from the public link. Asked for over that
  // private connection, its own key (a cookie there) lets it through the
  // door while its access lasts; strangers still get 404 (index.mjs). One per
  // person or device: asking again replaces it. Only its hash is kept.
  const DOOR_KEY = /^[A-Za-z0-9_-]{43}$/;
  const doorKind = (client) => client?.kind === "guest" || client?.kind === "device";
  function issueDoorKey(clientId) {
    const key = crypto.randomBytes(32).toString("base64url");
    let result;
    changeClients((latest) => {
      const client = latest.find((c) => c.id === clientId);
      if (!doorKind(client) || client.policy?.browser || !(client.expiresAt > Date.now()))
        throw fail(403, "Only a person or a device of yours keeps a door key.");
      client.doorHash = hash(key);
      result = { key, expiresAt: client.expiresAt };
      return latest;
    });
    return result;
  }
  let doorMemo = { revision: null, at: 0, keys: new Map() };
  function doorKeyKnown(key) {
    if (typeof key !== "string" || !DOOR_KEY.test(key)) return false;
    const now = Date.now();
    const revision = credentialRevision();
    if (revision === null) return false;
    if (doorMemo.revision !== revision || now - doorMemo.at >= 60_000) {
      const stored = publicDoorClients();
      if (stored === null) return false;
      doorMemo = { revision, at: now, keys: new Map(stored
        .filter((c) => doorKind(c) && !c.policy?.browser && typeof c.doorHash === "string")
        .map((c) => [c.doorHash, c.expiresAt])) };
    }
    return (doorMemo.keys.get(hash(key)) || 0) > now;
  }
  // The connection ids of hosted agents (hosted-mcp.mjs) with access, or
  // ended lately: the door answers their bearer tokens, and keeps the token
  // and discovery endpoints up for them, when nothing else opens it.
  let hostedMemo = { revision: null, ended: -1, at: 0, keys: new Set() };
  function hostedKeys() {
    const now = Date.now();
    const revision = credentialRevision();
    if (revision === null) return new Set();
    if (hostedMemo.revision === revision && hostedMemo.ended === endedVersion && now - hostedMemo.at < 60_000) return hostedMemo.keys;
    const stored = publicDoorClients();
    if (stored === null) return new Set();
    for (const [key, until] of endedHosted) if (until <= now) endedHosted.delete(key);
    const keys = new Set([...stored.filter((c) => c.hosted === true && isFunnelBrowser(c) && c.expiresAt > now - ENDED_KEYS_MS)
      .map((c) => c.browserBinding), ...endedHosted.keys()].filter(validBrowserBinding));
    hostedMemo = { revision, ended: endedVersion, at: now, keys };
    return keys;
  }
  // The address ids of hosted agents (hosted-mcp.mjs), hashed: an invitation
  // waiting at it, an agent with access, or one that ended lately. The door
  // answers a hosted agent's paths for these alone.
  let connectorsMemo = { revision: null, ended: -1, at: 0, map: new Map() };
  function hostedConnectors() {
    const now = Date.now();
    const revision = credentialRevision();
    if (revision === null) return new Map();
    if (connectorsMemo.revision === revision && connectorsMemo.ended === endedVersion && now - connectorsMemo.at < 60_000) return connectorsMemo.map;
    const stored = publicDoorClients();
    if (stored === null) return new Map();
    for (const [key, until] of endedConnectors) if (until <= now) endedConnectors.delete(key);
    const map = new Map([...endedConnectors.keys()].map((key) => [key, { waiting: false }]));
    for (const c of stored) {
      if (c.hosted !== true || typeof c.connectorHash !== "string" || !(c.expiresAt > now - ENDED_KEYS_MS)) continue;
      map.set(c.connectorHash, { waiting: !fullControlNeedsInvitation(c.policy) && !!c.inviteHash && !c.admission && !c.hash && c.expiresAt > now && c.inviteExpiresAt > now });
    }
    connectorsMemo = { revision, ended: endedVersion, at: now, map };
    return map;
  }
  function verifyFunnel(token, keyThumbprint) {
    if (typeof token !== "string" || !token || token.length > 256 ||
        !validBrowserBinding(keyThumbprint)) return null;
    const digest = hash(token);
    clients = loadJson(file, []);
    const now = Date.now();
    // A hosted agent (its connection id in place of a key): the bearer part
    // is its access token, good for an hour, or the one before it until that
    // one's hour ends. Its refresh token is the credential that rotates.
    const hosted = clients.find((c) => c.hosted === true && c.browserBinding === keyThumbprint);
    if (hosted) {
      const liveAccess = (sameHash(hosted.accessHash, digest) && hosted.accessUntil > now) ||
        (sameHash(hosted.accessPrevious?.hash, digest) && hosted.accessPrevious?.until > now);
      if (!liveAccess || idle(hosted, now)) return null;
      const session = funnelSession(hosted, keyThumbprint, now);
      if (session) noteUse(hosted.id, now);
      return session;
    }
    if (!settleRotation(digest, now, (c) => isFunnelBrowser(c) && c.hosted !== true && c.browserBinding === keyThumbprint)) return null;
    const client = clients.find((entry) => holdsDigest(entry, digest, now));
    if (!client || idle(client, now)) return null;
    const session = funnelSession(client, keyThumbprint, now);
    if (session) noteUse(client.id, now);
    return session;
  }
  // Only an authenticated browser request renews this short lease. Internal
  // stream authorization checks are read-only and cannot keep a dead tab alive.
  function touchFunnel(token, keyThumbprint) {
    const permitted = verifyFunnel(token, keyThumbprint);
    if (!permitted) throw fail(401, "This browser connection has ended.");
    const now = Date.now();
    if (standingPolicy(permitted.policy) ||
        permitted.browserIdleExpiresAt >= Math.min(permitted.expiresAt, now + 110000))
      return;
    const digest = hash(token);
    changeClients((latest) => {
      const client = latest.find((entry) => holdsDigest(entry, digest, Date.now()));
      if (!funnelSession(client, keyThumbprint)) throw fail(401, "This browser connection has ended.");
      client.browserIdleExpiresAt = Math.min(client.expiresAt, Date.now() + (client.policy?.preset ? 600000 : 120000));
      return latest;
    });
  }
  // Only explicit public browser invitations keep the shared Funnel open.
  // A pending admission has a five-minute deadline, not its longer grant.
  // Opening a new invitation never extends any existing client's credential.
  function funnelWindow() {
    const now = Date.now();
    endIdle(now);
    let result = { open: false, until: 0, reason: null };
    // Whether anyone without a key Reach knows must get in: a pairing, an
    // invitation waiting to be claimed, an agent's page (a browser agent, or
    // a Tools agent in its first hour, before its first credential trade).
    // When only trading Tools agents hold the window, the door takes known
    // keys alone (keyed; index.mjs).
    let strangers = false;
    // Opened at the computer (./reach in a terminal, setup, ./reach pair)
    // for a phone without the Tailscale app; closed by the first device that
    // gets in, or by its own deadline.
    // Held to 15 minutes from when the file was written, whatever it asks;
    // one written in the future (a clock or a hand set it) opens nothing.
    const pairing = loadJson(pairingFile, null);
    let written = -Infinity;
    try { written = Math.floor(fs.statSync(pairingFile).mtimeMs); } catch { /* none */ }
    const pairingUntil = Number.isFinite(pairing?.until) && written <= now + 2000 ? Math.min(pairing.until, written + PAIRING_WINDOW_MS) : 0;
    if (pairingUntil > now) {
      result = { open: true, until: pairingUntil, reason: "pairing" };
      strangers = true;
    }
    for (const client of loadJson(file, [])) {
      if (fullControlNeedsInvitation(client.policy)) continue;
      // A person's or a CLI agent's unopened invitation needs the start page
      // too: to sign in without the Tailscale app, or to fetch agent.mjs. The
      // page closes again once the link is used or runs out.
      // A Tools agent's unopened invitation too: agent.mjs, and the public
      // link when it can't reach Tailscale.
      if (!isFunnelBrowser(client) && (client.policy?.browser !== true || toolsLink(client)) && ["guest", "agent"].includes(client.kind) &&
          client.inviteHash && !client.hash && client.expiresAt > now) {
        const until = Math.min(client.expiresAt, client.inviteExpiresAt || client.expiresAt);
        if (until > now) strangers = true;
        if (until > now && until > result.until) result = { open: true, until, reason: "invitation" };
        continue;
      }
      if (!isFunnelBrowser(client) || !(client.expiresAt > now) ||
          !applyAgentPolicy(client, config)) continue;
      // Hosted agents keep nothing open: the door answers their own address
      // alone (hosted-mcp.mjs admits).
      if (client.hosted === true) continue;
      // Once joined, Always access keeps the public link up while the agent is
      // away, or its browser would have nothing to come back to.
      // (Only on the terms the owner approved: a changed grant can't act,
      // so it keeps nothing open; security audit L4.)
      if (standingPolicy(client.policy) && client.admission?.status === "collected" &&
          client.admission.grant === admissionGrant(client)) {
        if (!(client.rotatedAt > 0) && client.hosted !== true) strangers = true;
        if (client.expiresAt > result.until) result = { open: true, until: client.expiresAt, reason: "standing" };
        continue;
      }
      // Approved once: its link works again until the access ends (rebind),
      // so the page stays up for it until then.
      if (rebindable(client, now)) {
        if (!(client.rotatedAt > 0) && client.hosted !== true) strangers = true;
        if (client.expiresAt > result.until) result = { open: true, until: client.expiresAt, reason: "granted" };
        continue;
      }
      let until = 0, reason = "invitation";
      if (client.inviteHash && !client.admission && !client.hash && !client.browserBinding)
        until = Math.min(client.inviteExpiresAt || 0, client.expiresAt);
      else if (["pending", "approved"].includes(admissionStatus(client, now)) &&
          validBrowserBinding(client.browserBinding))
        until = Math.min(client.admission.expiresAt, client.expiresAt);
      else if (funnelSession(client, client.browserBinding, now)) {
        until = Math.min(client.expiresAt, client.browserIdleExpiresAt);
        reason = "session";
      }
      if (until > now) strangers = true;
      if (until > now && until > result.until) result = { open: true, until, reason };
    }
    return { ...result, ...(result.open && !strangers ? { keyed: true } : {}) };
  }
  function issue(name, scopes, kind = "device", options = {}) {
    let policy,
      ttlSeconds = 30 * 86400;
    if (
      kind === "agent" &&
      (options.profile ||
        config.agentPolicyRequired ||
        fs.existsSync(config.agentPolicyFile))
    ) {
      const profile = agentProfile(config, options.profile);
      ttlSeconds = options.ttlSeconds ?? profile.ttlSeconds;
      if (
        !Number.isInteger(ttlSeconds) ||
        ttlSeconds < 60 ||
        ttlSeconds > profile.ttlSeconds
      )
        throw fail(400, "Agent lifetime exceeds its profile limit.");
      scopes = profile.scopes;
      policy = {
        profile: options.profile,
        roots: profile.roots,
        maxJobMs: profile.maxJobMs,
      };
    }
    if (
      !Array.isArray(scopes) ||
      !scopes.length ||
      scopes.some((s) => !ALL_SCOPES.includes(s)) ||
      (kind === "agent" && scopes.some((s) => !AGENT_SCOPES.includes(s)))
    )
      throw fail(400, "Invalid credential scopes.");
    const token = crypto.randomBytes(32).toString("base64url");
    const client = {
      id: id(),
      kind,
      scopes,
      name: String(name).slice(0, 80),
      hash: hash(token),
      createdAt: new Date().toISOString(),
      expiresAt: Date.now() + ttlSeconds * 1000,
      ...(policy ? { policy } : {}),
      ...(options.tailscale ? { tailscale: options.tailscale } : {}),
      ...(typeof options.nodeName === "string"
        ? { nodeName: options.nodeName.slice(0, 160) }
        : {}),
      ...(typeof options.deviceGroup === "string"
        ? { deviceGroup: options.deviceGroup.slice(0, 64) }
        : {}),
    };
    let first = false;
    changeClients((latest) => {
      first = kind === "device" && !latest.some((c) => c.kind === "device");
      return [...latest, client];
    });
    if (first) firstDevice(client);
    // A new device got in: the pairing window it may have come through is
    // done. Another browser on a phone already approved (its Home Screen
    // copy, joined as that same device) isn't the phone it was opened for.
    if (kind === "device" && !options.deviceGroup) fs.rmSync(pairingFile, { force: true });
    return {
      token,
      clientId: client.id,
      name: client.name,
      scopes,
      expiresAt: client.expiresAt,
    };
  }
  return {
    verify,
    verifyDigest,
    verifyFunnel,
    funnelKeys,
    issueDoorKey,
    doorKeyKnown,
    rotateCredential,
    rotateFunnelCredential,
    claimHostedInvitation,
    unopenedInvitation,
    refreshHosted,
    hostedKeys,
    hostedConnectors,
    splitHostedToken,
    endIdle,
    clearUnopened,
    // Reach is reachable again: waiting agents get their minute anew.
    restartQuietClock: () => { authStarted = Date.now(); },
    // Called with an agent whose replaced credential was used again.
    onCredentialReuse: (listener) => reuseListeners.push(listener),
    touchFunnel,
    funnelWindow,
    inviteGuest,
    inviteAgent,
    inviteBrowser,
    changeAccess,
    redeemGuest,
    holdPerson,
    allowPerson,
    redeemFunnelBrowser,
    reconnectFunnelBrowser,
    reopenBrowserInvitation,
    renewInvitation,
    listAgentAdmissions,
    decideAgentAdmission,
    pollAgentAdmission,
    pollFunnelAdmission,
    pair,
    issue,
    // Agents and people listed before mascots draw theirs (at start).
    dressMascots() {
      if (mascots.needs(listStoredClients())) changeClients((latest) => latest);
    },
    list: () =>
      (endIdle(), listStoredClients()).map(({ hash, inviteHash, admission, linkHash, doorHash, ...rest }) => ({
        ...rest,
        ...(fullControlNeedsInvitation(rest.policy) ? { needsInvitation: true } : {}),
        // The owner may reopen this agent's link (Agents & people).
        ...(linkHash && rest.expiresAt > Date.now() ? { relink: true } : {}),
        ...(rest.kind === "guest" || rest.policy?.invite
          ? {
              // An agent that never joined in time can't anymore.
              status:
                fullControlNeedsInvitation(rest.policy) ? "expired" : admission ? admissionStatus({ ...rest, admission }) : rest.expiresAt <= Date.now() ||
                (inviteHash && rest.inviteExpiresAt <= Date.now())
                  ? "expired"
                  : inviteHash
                    ? "invited"
                    : rest.macEntry?.status === "waiting"
                      ? "waiting"
                      : "accepted",
            }
          : {}),
      })),
    // A reduction must survive pause/restart. This internal method cannot grant
    // access; only an existing base grant may be removed or reduced to viewing.
    restrictBrowserApp(clientId, appId, mode) {
      if (!["hidden", "view"].includes(mode) || typeof appId !== "string") throw fail(400, "Choose a reduced app permission.");
      changeClients((latest) => {
        const client = latest.find((entry) => entry.id === clientId);
        if (!client || client.kind !== "agent" || client.policy?.screen !== "apps" || client.expiresAt <= Date.now()) throw fail(404, "This app invitation has ended.");
        client.policy.appAccess = client.policy.appAccess.flatMap((entry) => entry.id !== appId ? [entry] : mode === "hidden" ? [] : [{...entry, mode:"view"}]);
        if (client.admission?.status === "collected" || client.admission?.moved === true) client.admission.grant = admissionGrant(client);
        client.changedAt = new Date().toISOString();
        return latest;
      });
    },
    // Admission carries its own one-use capability before a browser token exists.
    // This narrow check only bypasses the host UI guard; the normal claim/poll
    // handlers still consume/revalidate secrets, grant hashes and node binding.
    isBrowserAppAdmission(req) {
      if (req.method !== "POST") return false;
      const route = (req.originalUrl || req.url || "").split("?", 1)[0];
      const body = req.body;
      if (!isPlainRecord(body)) return false;
      const entries = loadJson(file, []), now = Date.now();
      const eligible = (client) => client.kind === "agent" && client.policy?.browser === true && (client.policy.screen === "apps" || hostGuardedPreset(client.policy)) && client.browserTransport !== "funnel" && client.expiresAt > now;
      if (route === "/api/invitations/redeem" && typeof body.invitation === "string" && body.invitation.length <= 256) {
        const digest = hash(body.invitation);
        return entries.some((client) => eligible(client) && client.inviteExpiresAt > now && sameHash(client.inviteHash, digest));
      }
      const match = /^\/api\/invitations\/claims\/([a-f0-9-]{36})\/status$/.exec(route);
      if (match && typeof body.secret === "string" && body.secret.length <= 256) {
        const digest = hash(body.secret);
        return entries.some((client) => eligible(client) && client.admission?.requestId === match[1] && client.admission.expiresAt > now && sameHash(client.admission.secretHash, digest));
      }
      return false;
    },
    revoke(clientId) {
      changeClients((latest) => {
        rememberEnded(latest.find((c) => c.id === clientId));
        return latest.filter((c) => c.id !== clientId);
      });
    },
    pairing,
  };
}
