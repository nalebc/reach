import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

// Check the files that could be committed, including new work but not ignored
// local state. Print only paths/reasons, never the matching secret.
const files = [...new Set(execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean))];
const findings = [];
const username = os.userInfo().username;
const privateWords = (process.env.REACH_PRIVATE_IDENTIFIERS || "").split(",").filter(Boolean);
if (!process.env.CI && username.length >= 4) privateWords.push(username);
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
