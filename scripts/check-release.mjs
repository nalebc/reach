import fs from "node:fs";
import { noticeVersionFindings } from "./notice-versions.mjs";
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
// Explicitly approved attribution can overlap a configured private identifier.
// This list exempts those exact identities from that privacy check; it is not
// an allowlist of people who may contribute. Contributors choose their own Git
// attribution. Authentication and review belong to the repository's merge rules.
const publicIdentities = new Map([
  ["contributors@example.invalid", "Reach Contributors"],
  ["54943684+nalebc@users.noreply.github.com", "nalebc"],
  ["nassimlbd@gmail.com", "Nassim"], // the owner chose to keep this attribution (Oct 10, 2026)
  ["49699333+dependabot[bot]@users.noreply.github.com", "dependabot[bot]"],
  ["41898282+github-actions[bot]@users.noreply.github.com", "github-actions[bot]"],
]);
const patterns = [
  ["private key", new RegExp("-----BEGIN " + "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----")],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["GitHub credential", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ["Tailscale credential", /\btskey-(?:auth|client|api)-[A-Za-z0-9]{12,}-[A-Za-z0-9]{24,}\b/],
];
try {
  const commits = execFileSync("git", ["log", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce"], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
  for (const line of commits) {
    const [sha, author, authorEmail, committer, committerEmail] = line.split("\0");
    const where = `commit ${sha.slice(0, 12)}`;
    if (!author || !authorEmail || !committer || !committerEmail) {
      findings.push([where, "missing author or committer identity"]);
      continue;
    }
    const identities = [[author, authorEmail], [committer, committerEmail]];
    if (identities.some(pair => patterns.some(([, pattern]) => pair.some(value => pattern.test(value)))))
      findings.push([where, "credential in author or committer"]);
    if (identities.some(([name, email]) => publicIdentities.get(email.toLowerCase()) !== name &&
      privateWords.some(word => `${name}\n${email}`.toLowerCase().includes(word.toLowerCase()))))
      findings.push([where, "private identifier in author or committer"]);
  }
} catch { findings.push(["git history", "could not read commit identities"]); }
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
  // An identity approved above is public where it is spelled out in full: its
  // address, and its display name on the same line as that address. Everything
  // else is scanned as before, so a home path or a nickname built from the same
  // name is still reported.
  const outsideIdentities = text.split("\n").map((line) => {
    for (const [email, name] of publicIdentities) if (line.includes(email)) line = line.split(email).join(" ").split(name).join(" ");
    return line;
  }).join("\n").toLowerCase();
  for (const word of privateWords)
    if (outsideIdentities.includes(word.toLowerCase())) findings.push([file, "local personal identifier"]);
}
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (pkg.author !== "Reach Contributors") findings.push(["package.json", "use the project contributor identity"]);
if (fs.existsSync("tailnet/go.mod"))
  for (const reason of noticeVersionFindings()) findings.push(["docs/THIRD_PARTY_NOTICES.md", reason]);
if (findings.length) {
  for (const [file, reason] of findings) console.error(`${file}: ${reason}`);
  process.exitCode = 1;
} else console.log(`Release privacy checks passed (${files.length} files). This is a guardrail, not a complete secret audit.`);
