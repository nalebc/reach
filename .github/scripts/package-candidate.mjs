// Handoff copies only archives whose exact bytes passed installation smoke.
// It never rebuilds or repacks a portable directory after verification.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) throw Error("Invalid release version.");
if (pkg.name !== "@nalebc/reach") throw Error("Unexpected release package identity.");
const tarballs = fs.readdirSync("release").filter(name => name.endsWith(".tgz"));
if (tarballs.length !== 1 || tarballs[0] !== `nalebc-reach-${pkg.version}.tgz`) throw Error("Expected exactly the verified npm tarball for this version.");
const npm = tarballs[0], portable = `reach-${pkg.version}-portable.tar.gz`;
for (const file of [npm, portable]) if (!fs.lstatSync(path.join("release", file)).isFile()) throw Error("Release archives must be regular files, never links.");
const verification = JSON.parse(fs.readFileSync("release/package-verification.json", "utf8"));
const hash = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
if (verification.filename !== tarballs[0] || verification.package !== pkg.name || verification.version !== pkg.version || verification.commit !== (process.env.GITHUB_SHA || "local") || verification.sha256 !== hash(path.join("release", tarballs[0]))) throw Error("The npm artifact has not passed verification at this commit, or changed after verification.");
if (verification.portable?.filename !== portable || verification.portable.sha256 !== hash(path.join("release", portable))) throw Error("The portable archive has not passed verification or changed after verification.");
const output = path.join("release", "candidate");
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const [file, expected] of [[npm, verification.sha256], [portable, verification.portable.sha256]]) {
  fs.copyFileSync(path.join("release", file), path.join(output, file));
  if (hash(path.join(output, file)) !== expected) throw Error("An archive changed while the release candidate was copied.");
}
const files = [npm, portable];
const checksums = files.map(name => `${hash(path.join(output, name))}  ${name}`);
fs.writeFileSync(path.join(output, "SHA256SUMS"), `${checksums.join("\n")}\n`);
fs.writeFileSync(path.join(output, "candidate.json"), `${JSON.stringify({
  version: pkg.version, package: pkg.name, commit: process.env.GITHUB_SHA || "local",
  npm, portable, platform: process.platform, architecture: process.arch,
}, null, 2)}\n`);
console.log(`Candidate archives and checksums written to ${output}.`);
