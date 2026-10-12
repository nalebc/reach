// Check committed notices without installing npm dependencies or running Go.
// The hash also catches new or removed dependencies that have no heading yet.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const readText = file => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

export function noticeLockHash(root = process.cwd()) {
  const hash = crypto.createHash("sha256");
  for (const file of ["package-lock.json", "tailnet/go.mod", "tailnet/go.sum"])
    hash.update(file + "\0").update(readText(path.join(root, file))).update("\0");
  return hash.digest("hex");
}

export function noticeVersionFindings(root = process.cwd()) {
  try {
    const notices = readText(path.join(root, "docs/THIRD_PARTY_NOTICES.md"));
    const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
    const go = readText(path.join(root, "tailnet/go.mod"));
    const modules = new Map([...go.matchAll(/^\s*(?:require\s+)?(\S+) (v\S+)(?:\s|$)/gm)].map(([, name, version]) => [name, version]));
    const findings = [];
    if (!notices.includes(`Dependency locks: \`${noticeLockHash(root)}\`.`)) findings.push("dependency locks changed; run node scripts/build-notices.mjs");
    const runtime = go.match(/^go (\S+)/m)?.[1];
    if (!runtime || !notices.includes(`## Go runtime (go${runtime})\n`)) findings.push("Go runtime notice differs from tailnet/go.mod");
    for (const [, name, version] of notices.matchAll(/^## (\S+) (v?\d[^\s]*)$/gm)) {
      const expected = version.startsWith("v") ? modules.get(name) : lock.packages?.[`node_modules/${name}`]?.version;
      if (expected !== version) findings.push(`locked version differs for ${name}`);
    }
    return findings;
  } catch {
    return ["dependency notices or locks are missing or unreadable; run node scripts/build-notices.mjs"];
  }
}
