import fs from "node:fs";
import path from "node:path";

export const POLICY_SCOPES = [
  "device",
  "files:read",
  "files:write",
  "exec",
  "terminal",
  "codex",
  "apps",
  "screen",
  // Use apps on hidden displays and hand them to you (server/agent-apps.mjs).
  "apps:drive",
];
// Browser invitations only reach the narrow browser action API. These are
// deliberately absent from ordinary agent profiles and token issuance.
export const BROWSER_SCOPES = [
  "device", "files:read", "browser:read", "browser:scroll", "browser:request",
];
export const validBrowserTerminalId = (id) =>
  typeof id === "string" && /^(reach|desktop):[A-Za-z0-9_-]{1,128}$/.test(id);
const invalid = (message) => Object.assign(Error(message), { status: 403 });
export const within = (root, file) => {
  const relative = path.relative(root, file);
  return (
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
};
export function readAgentPolicy(file) {
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw invalid("Agent policy is missing or invalid. Access is disabled.");
  }
  if (
    policy.version !== 1 ||
    !policy.profiles ||
    typeof policy.profiles !== "object" ||
    Array.isArray(policy.profiles)
  )
    throw invalid("Agent policy requires version 1 and named profiles.");
  const profiles = Object.create(null);
  for (const [name, p] of Object.entries(policy.profiles)) {
    if (
      !/^[a-z][a-z0-9-]{0,63}$/.test(name) ||
      !p ||
      !Array.isArray(p.scopes) ||
      !p.scopes.length ||
      p.scopes.some((s) => !POLICY_SCOPES.includes(s)) ||
      !Array.isArray(p.roots)
    )
      throw invalid(`Invalid agent profile: ${name}.`);
    const ttlSeconds = p.ttlSeconds ?? 3600,
      maxJobMs = p.maxJobMs ?? 60000;
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 60 ||
      ttlSeconds > 86400 ||
      !Number.isInteger(maxJobMs) ||
      maxJobMs < 1000 ||
      maxJobMs > 3600000
    )
      throw invalid(`Invalid duration in agent profile: ${name}.`);
    const roots = p.roots.map((root) => {
      if (typeof root !== "string" || !path.isAbsolute(root))
        throw invalid("Agent folders must be absolute paths.");
      try {
        const real = fs.realpathSync.native(root);
        if (!fs.statSync(real).isDirectory()) throw Error();
        return real;
      } catch {
        throw invalid("An agent folder is unavailable. Access is disabled.");
      }
    });
    profiles[name] = {
      scopes: [...new Set(["device", ...p.scopes])],
      roots: [...new Set(roots)],
      ttlSeconds,
      maxJobMs,
    };
  }
  return { version: 1, profiles };
}
export function intersectRoots(a, b) {
  return [
    ...new Set(
      a.flatMap((left) =>
        b.flatMap((right) =>
          within(left, right) ? [right] : within(right, left) ? [left] : [],
        ),
      ),
    ),
  ];
}
export function agentProfile(config, name) {
  const profile = readAgentPolicy(config.agentPolicyFile).profiles[name];
  if (!profile)
    throw invalid("This agent profile is disabled or does not exist.");
  const roots = intersectRoots(profile.roots, config.roots);
  if (
    profile.roots.length !== roots.length ||
    profile.roots.some((r) => !roots.includes(r))
  )
    throw invalid("Agent folders must be inside Reach's shared folders.");
  return { ...profile, roots };
}
export function applyAgentPolicy(client, config) {
  if (client.kind !== "agent") return client;
  if (client.policy?.browser === true) {
    const policy = client.policy;
    if (
      policy.invite !== true ||
      !Array.isArray(policy.roots) ||
      policy.roots.some((root) => typeof root !== "string" || !path.isAbsolute(root)) ||
      !Array.isArray(policy.terminalIds) ||
      policy.terminalIds.length > 20 ||
      policy.terminalIds.some((id) => !validBrowserTerminalId(id)) ||
      !["off", "view", "scroll", "ask"].includes(policy.screen) ||
      (policy.commandRequests !== undefined && typeof policy.commandRequests !== "boolean") ||
      (policy.restrictedTerminal !== undefined && typeof policy.restrictedTerminal !== "boolean") ||
      (policy.restrictedTerminal === true && (!policy.roots.length || policy.commandRequests === true)) ||
      (policy.terminalApproval !== undefined && typeof policy.terminalApproval !== "boolean") ||
      (policy.terminalApproval === true && policy.restrictedTerminal !== true) ||
      (policy.scriptApproval !== undefined && typeof policy.scriptApproval !== "boolean") ||
      (policy.scriptApproval === true && (policy.terminalApproval !== true || policy.restrictedTerminal !== true)) ||
      !Array.isArray(client.scopes)
    ) return null;
    const roots = policy.roots.filter((root) =>
      config.roots.some((shared) => within(shared, root)),
    );
    if (policy.restrictedTerminal === true && !roots.length) return null;
    return {
      ...client,
      scopes: client.scopes.filter((scope) =>
        BROWSER_SCOPES.includes(scope) &&
        (scope !== "files:read" || roots.length > 0) &&
        (scope !== "browser:scroll" || policy.screen === "scroll") &&
        (scope !== "browser:request" || policy.screen === "ask" || policy.commandRequests === true || (policy.restrictedTerminal === true && roots.length > 0)),
      ),
      policy: { ...policy, roots },
      agentRoots: roots,
    };
  }
  // Invited from the phone: its own folders and limits, chosen by you when
  // inviting (not a profile in the policy file), still inside what Reach
  // shares, and never screen control or apps.
  if (client.policy?.invite) {
    const roots = client.policy.roots.filter((root) =>
      config.roots.some((shared) => within(shared, root)),
    );
    return {
      ...client,
      scopes: client.scopes.filter((s) => POLICY_SCOPES.includes(s) && !["apps", "screen", "apps:drive"].includes(s)),
      agentRoots: roots,
      maxJobMs: client.policy.maxJobMs,
    };
  }
  config.agentPolicyRequired ||= fs.existsSync(config.agentPolicyFile);
  if (!client.policy) {
    // Once an owner enables a policy, old broad credentials cannot bypass it.
    return config.agentPolicyRequired || fs.existsSync(config.agentPolicyFile)
      ? null
      : client;
  }
  try {
    const profile = agentProfile(config, client.policy.profile);
    const scopes = client.scopes.filter((s) => profile.scopes.includes(s));
    const roots = intersectRoots(client.policy.roots, profile.roots);
    const expiresAt = Math.min(
      client.expiresAt,
      Date.parse(client.createdAt) + profile.ttlSeconds * 1000,
    );
    if (Date.now() >= expiresAt) return null;
    return {
      ...client,
      scopes,
      expiresAt,
      agentRoots: roots,
      maxJobMs: Math.min(client.policy.maxJobMs, profile.maxJobMs),
    };
  } catch {
    return null;
  }
}
