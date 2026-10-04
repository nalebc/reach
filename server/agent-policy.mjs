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
];
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
        const real = fs.realpathSync(root);
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
