import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { agentProfile, applyAgentPolicy, within } from "./agent-policy.mjs";
import { defaultFileRoots } from "./file-roots.mjs";

export const fail = (status, message) =>
  Object.assign(new Error(message), { status });
export const id = () => crypto.randomUUID();
export const hash = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
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
  ).map((p) => fs.realpathSync(p));
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
    resolved = fs.realpathSync(target);
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
];
export function createAuth(config, { rotatePairing = true } = {}) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  config.agentPolicyRequired ||= fs.existsSync(config.agentPolicyFile);
  const file = path.join(config.dataDir, "clients.json");
  let clients = loadJson(file, []);
  const changeClients = (change) => {
    const lock = `${file}.lock`;
    let fd;
    try {
      fd = fs.openSync(lock, "wx", 0o600);
    } catch {
      throw fail(409, "Credentials are being updated. Try again shortly.");
    }
    try {
      clients = change(loadJson(file, []));
      atomicJson(file, clients);
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
  // Every check `verify` makes, from the credential's stored hash: used by
  // download links, which must never hold the credential itself.
  function verifyDigest(digest, identity) {
    clients = loadJson(file, []);
    if (typeof digest !== "string" || !digest) return null;
    const client = clients.find(
      (c) =>
        c.hash === digest &&
        Date.now() < (c.expiresAt || Date.parse(c.createdAt) + 30 * 86400000),
    );
    if (
      config.tailscaleOwner &&
      (!identity || identity.validUntil <= Date.now())
    )
      return null;
    if (
      client?.tailscale &&
      (!identity ||
        identity.validUntil <= Date.now() ||
        client.tailscale.userId !== identity.userId ||
        client.tailscale.nodeId !== identity.nodeId)
    )
      return null;
    if (
      client &&
      config.tailscaleOwner &&
      !["guest", "agent"].includes(client.kind) &&
      (!client.tailscale ||
        identity.tagged ||
        identity.userId !== config.tailscaleOwner.userId)
    )
      return null;
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
  // What you choose when inviting someone:
  //   roots/write  folders, read or read/write
  //   screen       false | "view" | "control" (true means "view")
  //   apps         undefined | "all" | [app ids]: watch those apps' windows
  //   terminal     their own terminals;  agents  AI sessions (Codex)
  //   full         everything you can do, except managing access
  function inviteGuest({
    name,
    ttlSeconds,
    roots = [],
    write = false,
    screen = false,
    apps,
    terminal = false,
    agents = false,
    full = false,
  }) {
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
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 80 ||
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 60 ||
      ttlSeconds > 86400 ||
      !Array.isArray(roots) ||
      roots.some((r) => !Number.isInteger(r) || !config.roots[r]) ||
      typeof write !== "boolean" ||
      ![false, "view", "control"].includes(screenMode) ||
      appList === null ||
      typeof terminal !== "boolean" ||
      typeof agents !== "boolean" ||
      typeof full !== "boolean" ||
      (!full &&
        !roots.length &&
        !screenMode &&
        !appList &&
        !terminal &&
        !agents)
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
      scopes: full
        ? [...ALL_SCOPES]
        : [
            "device",
            ...(roots.length
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
        : [...new Set(roots)].map((r) => config.roots[r]),
      ...(Array.isArray(appList) && !full ? { guestApps: appList } : {}),
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
    };
  }
  // The credential works only on the Tailscale device that redeemed it.
  function redeemGuest(invitation, identity) {
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
          c.kind === "guest" &&
          c.inviteHash === hash(invitation) &&
          c.expiresAt > Date.now(),
      );
      if (!client)
        throw fail(
          401,
          "This guest link expired, was revoked, or has already been used.",
        );
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
      result = { token, clientId: client.id, expiresAt: client.expiresAt };
      return latest;
    });
    return result;
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
    changeClients((latest) => [...latest, client]);
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
    inviteGuest,
    redeemGuest,
    pair,
    issue,
    list: () =>
      loadJson(file, []).map(({ hash, inviteHash, ...rest }) => ({
        ...rest,
        ...(rest.kind === "guest"
          ? {
              status:
                rest.expiresAt <= Date.now()
                  ? "expired"
                  : inviteHash
                    ? "invited"
                    : "accepted",
            }
          : {}),
      })),
    revoke(clientId) {
      changeClients((latest) => latest.filter((c) => c.id !== clientId));
    },
    pairing,
  };
}
