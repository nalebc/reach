import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Check the files that could be committed, including new work but not ignored
// local state. Print only paths/reasons, never the matching secret.
const files = [...new Set(execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean))];
const findings = [];
const username = os.userInfo().username;
// Identifiers that must never appear: from the environment (CI keeps them in a
// secret), from an untracked local list (.reach/private-identifiers, one per
// line) and the local account name. The list itself is never published.
const privateWords = (process.env.REACH_PRIVATE_IDENTIFIERS || "").split(",").map((w) => w.trim()).filter(Boolean);
for (const listFile of [".reach/private-identifiers", path.join(os.homedir(), ".reach", "private-identifiers")]) {
  try { privateWords.push(...fs.readFileSync(listFile, "utf8").split("\n").map((w) => w.trim()).filter((w) => w && !w.startsWith("#"))); } catch { /* no list */ }
}
if (!process.env.CI && username.length >= 4) privateWords.push(username);
if (!privateWords.some((w) => w.length >= 4)) console.error("Note: no private identifiers configured (REACH_PRIVATE_IDENTIFIERS or .reach/private-identifiers); the scan covers only known credential formats.");
// Every commit must carry the project identity, author and committer alike: a
// personal email in history is published with the repository.
const projectEmail = "contributors@example.invalid";
try {
  const emails = execFileSync("git", ["log", "--format=%H %ae %ce"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const stray = emails.filter((line) => line.split(" ").slice(1).some((email) => email.toLowerCase() !== projectEmail));
  for (const line of stray.slice(0, 20)) findings.push([`commit ${line.split(" ")[0].slice(0, 12)}`, "author or committer is not the project identity"]);
  if (stray.length > 20) findings.push([`${stray.length - 20} more commits`, "author or committer is not the project identity"]);
} catch { findings.push(["git history", "could not read commit identities"]); }
const patterns = [
  ["private key", new RegExp("-----BEGIN " + "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----")],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["GitHub credential", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ["Tailscale credential", /\btskey-(?:auth|client|api)-[A-Za-z0-9]{12,}-[A-Za-z0-9]{24,}\b/],
];
for (const file of files) {
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) {
    findings.push([file, "review symlink target before release"]);
    continue;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
  if (/(^|\/)\.reach\/|(^|\/)\.env(?:\.|$)(?!example$)|\.(?:p12|pfx|mobileprovision|provisionprofile|p8|key|pem)$|Signing\.local\.xcconfig$/.test(file))
    findings.push([file, "private state or signing material"]);
  const body = fs.readFileSync(file);
  if (body.includes(0) || body.length > 2_000_000) continue;
  const text = body.toString("utf8");
  for (const [reason, pattern] of patterns) if (pattern.test(text)) findings.push([file, reason]);
  for (const word of privateWords)
    if (text.toLowerCase().includes(word.toLowerCase())) findings.push([file, "local personal identifier"]);
}
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (pkg.author !== "Reach Contributors") findings.push(["package.json", "use the project contributor identity"]);
if (findings.length) {
  for (const [file, reason] of findings) console.error(`${file}: ${reason}`);
  process.exitCode = 1;
} else console.log(`Release privacy checks passed (${files.length} files). This is a guardrail, not a complete secret audit.`);
