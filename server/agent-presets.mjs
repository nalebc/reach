import path from "node:path";
import { protectedAppReason } from "./agent-guard.mjs";

// Agent access is one of four presets. Everything an agent may do (its scopes,
// the routes it may call, the tools it sees, the rules the native checker
// applies) is derived from the preset on every request, never stored as a
// list that could grow. What stays protected in every preset lives in
// agent-guard.mjs.
export const PRESETS = ["full", "apps", "files", "readonly"];
export const PRESET_NAMES = { full: "Full control", apps: "Apps", files: "Files", readonly: "Read only" };
const validBrowserTerminalId = (id) => typeof id === "string" && /^(reach|desktop):[A-Za-z0-9_-]{1,128}$/.test(id);
const invalid = (message, status = 400) => Object.assign(Error(message), { status });
const plain = (value) => value !== null && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const controls = (value) => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value);
export const validAppPath = (value) =>
  typeof value === "string" && value.length <= 4096 && path.posix.isAbsolute(value) && value.endsWith(".app") &&
  !controls(value) && !value.includes("\\") && path.posix.normalize(value) === value;

// Full control and Apps touch the Mac: Reach then answers only the phone that
// created the invitation (browser-host-guard.mjs), as app sessions did.
export const hostGuardedPreset = (policy) => policy?.browser === true && ["full", "apps"].includes(policy.preset);

// "Always": the agent keeps its access until the owner ends it and comes back
// from the same browser; the link still works once (Reopen link lets a new
// browser use it once more). Only over the public link.
export const STANDING_SECONDS = 10 * 365 * 86400;
export const standingPolicy = (policy) => policy?.browser === true && policy.standing === true;

export function presetScopes(policy) {
  const base = ["device", "browser:read"];
  switch (policy?.preset) {
    case "full": return [...base, "files:read", "browser:write", "browser:screen", "browser:control", "browser:open", "browser:shell"];
    case "apps": return [...base, "browser:screen", "browser:control", "browser:open"];
    case "files": return [...base, "files:read", ...(policy.write === true ? ["browser:write"] : [])];
    case "readonly": return [...base, "files:read", "browser:screen"];
    default: return [];
  }
}

const appList = (value, label) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 30 || value.some((app) => !plain(app) || !validAppPath(app.id) ||
      Object.keys(app).some((key) => !["id", "name", "bundleId", "identity"].includes(key)) ||
      (app.name !== undefined && (typeof app.name !== "string" || app.name.length > 100 || controls(app.name))) ||
      (app.bundleId !== undefined && (typeof app.bundleId !== "string" || app.bundleId.length > 200 || controls(app.bundleId))) ||
      (app.identity !== undefined && (typeof app.identity !== "string" || !/^[a-f0-9]{64}$/.test(app.identity)))))
    throw invalid(`Choose up to 30 ${label} on this computer.`);
  const ids = new Set(value.map((app) => app.id));
  if (ids.size !== value.length) throw invalid(`Choose each ${label.replace(/s$/, "")} once.`);
  return value.map(({ id, name, bundleId, identity }) => ({ id, ...(name !== undefined ? { name } : {}), ...(bundleId !== undefined ? { bundleId } : {}), ...(identity !== undefined ? { identity } : {}) }));
};

/** The owner's choice, checked: a preset plus what that preset needs, nothing more. */
export function validatePresetInvitation(input, { folderCount } = {}) {
  const fields = ["name", "ttlSeconds", "joinSeconds", "transport", "preset", "folders", "apps", "write", "hidden", "terminalIds", "standing"];
  if (!plain(input) || Object.keys(input).some((key) => !fields.includes(key)))
    throw invalid("This invitation contains unsupported fields.");
  const { name, ttlSeconds, joinSeconds = 900, transport = "tailnet", preset, folders = [], apps = [], write = false, hidden = [], terminalIds = [], standing } = input;
  if (!PRESETS.includes(preset)) throw invalid("Choose Full control, Apps, Files or Read only.");
  if (standing !== undefined && (standing !== true || ttlSeconds !== undefined || transport !== "funnel"))
    throw invalid("Always access is a link with no end time.");
  if (typeof name !== "string" || !name.trim() || name.length > 80 || controls(name) || /[\n\t]/.test(name) ||
      (!standing && (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400)) ||
      !Number.isInteger(joinSeconds) || joinSeconds < 60 || joinSeconds > 86400 ||
      !["tailnet", "funnel"].includes(transport) || (transport === "funnel" && joinSeconds > 900) ||
      typeof write !== "boolean" || !Array.isArray(terminalIds) || terminalIds.length > 20 || terminalIds.some((id) => !validBrowserTerminalId(id)))
    throw invalid("Name the agent, pick a preset, and a duration from 1 minute to 24 hours (joining within 15 minutes).");
  if (!Array.isArray(folders) || folders.length > 20 || folders.some((folder) =>
      !plain(folder) || Object.keys(folder).some((key) => !["root", "path"].includes(key)) ||
      !Number.isSafeInteger(folder.root) || folder.root < 0 || typeof folder.path !== "string" || folder.path.length > 4096 || controls(folder.path)))
    throw invalid("Choose up to 20 folders on this computer.");
  const chosenApps = appList(apps, "apps"), hiddenApps = appList(hidden, "hidden apps");
  if (preset === "apps" && !chosenApps.length) throw invalid("Choose at least one app for the Apps preset.");
  if (preset !== "apps" && chosenApps.length) throw invalid("Only the Apps preset chooses apps.");
  if (preset === "files" && !(folderCount ?? folders.length)) throw invalid("Choose at least one folder for the Files preset.");
  if (["apps"].includes(preset) && folders.length) throw invalid("The Apps preset has no folders.");
  if (write && preset !== "files") throw invalid("Only the Files preset chooses between reading and editing.");
  if (hiddenApps.length && !["full", "readonly"].includes(preset)) throw invalid("Hidden apps apply to Full control and Read only.");
  if (terminalIds.length && !["full", "readonly"].includes(preset)) throw invalid("Watching terminals applies to Full control and Read only.");
  for (const app of chosenApps) { const reason = protectedAppReason(app); if (reason) throw invalid(reason, 403); }
  return { name, ttlSeconds, joinSeconds, transport, preset, folders, apps: chosenApps, write: preset === "files" ? write : false, hidden: hiddenApps, terminalIds: [...new Set(terminalIds)], ...(standing ? { standing } : {}) };
}

/** The stored policy. `roots` are already chosen and checked against what Reach shares. */
export function presetPolicy(checked, roots) {
  const { preset, apps, write, hidden, terminalIds, standing } = checked;
  return {
    invite: true, browser: true, preset,
    ...(standing ? { standing: true } : {}),
    roots: [...new Set(roots)],
    ...(preset === "apps" ? { apps } : {}),
    ...(preset === "files" && write ? { write: true } : {}),
    ...(hidden.length ? { hidden } : {}),
    ...(terminalIds.length ? { terminalIds } : {}),
  };
}

// Re-derived on every request (agent-policy.mjs). A stored policy that fails
// here grants nothing.
export function validPresetPolicy(policy) {
  return plain(policy) && policy.invite === true && policy.browser === true && PRESETS.includes(policy.preset) &&
    Array.isArray(policy.roots) && policy.roots.every((root) => typeof root === "string" && path.isAbsolute(root)) &&
    (policy.apps === undefined || (policy.preset === "apps" && Array.isArray(policy.apps) && policy.apps.length > 0 && policy.apps.length <= 30 && policy.apps.every((app) => plain(app) && validAppPath(app.id) && !protectedAppReason(app)))) &&
    (policy.preset !== "apps" || policy.apps !== undefined) &&
    (policy.write === undefined || (policy.write === true && policy.preset === "files")) &&
    (policy.hidden === undefined || (Array.isArray(policy.hidden) && policy.hidden.length <= 30 && policy.hidden.every((app) => plain(app) && validAppPath(app.id)))) &&
    (policy.terminalIds === undefined || (Array.isArray(policy.terminalIds) && policy.terminalIds.length <= 20 && policy.terminalIds.every(validBrowserTerminalId))) &&
    (policy.standing === undefined || policy.standing === true) &&
    (policy.preset !== "files" || policy.roots.length > 0) &&
    (policy.preset !== "apps" || policy.roots.length === 0) &&
    policy.screen === undefined && policy.appAccess === undefined && policy.restrictedTerminal === undefined &&
    policy.terminalApproval === undefined && policy.scriptApproval === undefined && policy.commandRequests === undefined;
}

const fileReads = ["/browser/files/search", "/files", "/files/text", "/files/content", "/files/document-text", "/files/icons"];
/** The complete route allowlist for preset invitations. Nothing else answers them. */
export function presetRouteAllowed(client, method, route) {
  const policy = client?.policy;
  if (!validPresetPolicy(policy) || !Array.isArray(client.scopes)) return false;
  const has = (scope) => client.scopes.includes(scope);
  const read = ["GET", "HEAD"].includes(method);
  if (method === "DELETE" && route === "/device/access") return true;
  if (read && ["/device", "/browser"].includes(route)) return has("browser:read");
  // Discovery/requesting is available to every admitted preset. Execution also
  // requires separate, owner-approved service consent in agent-services.mjs.
  if (read && route === "/browser/services") return has("browser:read");
  if (method === "POST" && ["/browser/services/request", "/browser/services/run"].includes(route)) return has("browser:read");
  if (read && fileReads.includes(route)) return has("files:read") && policy.roots.length > 0;
  if (method === "POST" && route === "/browser/files/change") return has("browser:write") && policy.roots.length > 0;
  if (read && ["/browser/desktop/screen", "/browser/desktop/front"].includes(route)) return has("browser:screen");
  if (method === "POST" && route === "/browser/desktop/input") return has("browser:control");
  if (read && route === "/browser/desktop/apps") return has("browser:open");
  if (method === "POST" && route === "/browser/desktop/open") return has("browser:open");
  if (method === "POST" && route === "/browser/shell") return has("browser:shell");
  if (read && route === "/browser/shell/history") return has("browser:shell");
  if (["full", "apps"].includes(policy.preset) && has("browser:control") && has("browser:open") && has("browser:screen")) {
    if (read && ["/browser/tools", "/browser/tools/protocol"].includes(route)) return true;
    if (read && /^\/browser\/tools\/operations\/[a-f0-9-]{36}$/.test(route)) return true;
    if (method === "POST" && ["/browser/tools/define", "/browser/tools/run"].includes(route)) return true;
    if (read && route === "/browser/shortcuts") return true;
    if (method === "POST" && ["/browser/shortcuts/record", "/browser/shortcuts/save", "/browser/shortcuts/run"].includes(route)) return true;
    if (method === "DELETE" && route === "/browser/shortcuts/record") return true;
  }
  if (read && /^\/browser\/terminals\/[^/]+$/.test(route)) return has("browser:read") && (policy.terminalIds?.length || 0) > 0;
  return false;
}

/** Chosen apps, bound to the Mac's catalog: path, name, bundle id and signing identity when known. */
export function presetAppsFromCatalog(catalog, chosen, { allowProtected = false } = {}) {
  if (!Array.isArray(catalog)) throw invalid("The app list is unavailable. Try again.", 503);
  return chosen.map((choice) => {
    const app = catalog.find((entry) => entry?.id === choice.id);
    if (!app || !validAppPath(app.id)) throw invalid("Choose apps installed on this Mac.");
    const reason = protectedAppReason(app);
    if (reason && !allowProtected) throw invalid(reason, 403);
    return { id: app.id, name: String(app.name || path.basename(app.id, ".app")).slice(0, 100), bundleId: String(app.bundleId || "").slice(0, 200),
      ...(/^[a-f0-9]{64}$/.test(app.identity || "") ? { identity: app.identity } : {}) };
  });
}

/** What the agent is told about its own session (GET /api/browser, tools). */
export function presetAccess(client) {
  const policy = client.policy, scopes = client.scopes || [];
  return {
    preset: policy.preset,
    presetName: PRESET_NAMES[policy.preset],
    screen: scopes.includes("browser:screen"),
    control: scopes.includes("browser:control"),
    open: scopes.includes("browser:open"),
    shell: scopes.includes("browser:shell"),
    write: scopes.includes("browser:write"),
    apps: (policy.apps || []).map(({ id, name, bundleId }) => ({ id, ...(name !== undefined ? { name } : {}), ...(bundleId !== undefined ? { bundleId } : {}) })),
    hidden: (policy.hidden || []).map(({ id, name }) => ({ id, ...(name !== undefined ? { name } : {}) })),
    ...(policy.standing ? { standing: true } : {}),
  };
}
