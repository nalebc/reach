import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { renameScanned } from "./native-build.mjs";
import { systemRoot } from "./windows-helper-launch.mjs";

// Preparatory verifier for optional signed Windows helpers. Not yet selected
// by runtime builds; signing enrollment and the release pipeline are pending.
// Future release helpers (docs/CODE_SIGNING.md) must be built from
// this repository by GitHub Actions, signed through SignPath Foundation, and
// put in the npm package as dist/windows-helpers/ with a manifest. Reach runs
// one instead of building its own with the PC's csc.exe only when all of
// these hold, and otherwise builds it as before:
// - the manifest is this Reach's version;
// - it was built from exactly the sources, flags and references this Reach
//   would compile (the whole source digest of desktop-native.mjs helperPlan),
//   so an installation whose helper sources changed never runs an old binary;
// - its file has the SHA-256 the manifest records;
// - Windows says its Authenticode signature is Valid, from SignPath Foundation.
// It is then copied into the caller's folder (Reach's private folder for the
// helpers a security check runs), checked again there, and run from there.
const exec = promisify(execFile);
const HEX64 = /^[0-9a-f]{64}$/;
const KIND = /^[a-z0-9-]{1,40}$/;
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

/** Where a release's signed helpers are, beside Reach's own interface. */
export const SHIPPED_DIR = fileURLToPath(new URL("../dist/windows-helpers/", import.meta.url));
/** This installation's version: a signed helper of any other release is never used. */
export const REACH_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
/** The publisher (certificate CN) every shipped helper must be signed by. Only a test names another, explicitly. */
export const SIGNED_PUBLISHER = "SignPath Foundation";

/** A sealed release manifest, checked field by field; null for anything else. */
export function validManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || manifest.schema !== 1 || manifest.product !== "Reach") return null;
  if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) return null;
  if (typeof manifest.commit !== "string" || !/^(?:[0-9a-f]{40}|local)$/.test(manifest.commit)) return null;
  const { helpers } = manifest;
  if (!Array.isArray(helpers) || !helpers.length || helpers.length > 64) return null;
  const kinds = new Set();
  for (const entry of helpers) {
    if (!entry || typeof entry !== "object" || typeof entry.kind !== "string" || !KIND.test(entry.kind) || kinds.has(entry.kind)) return null;
    kinds.add(entry.kind);
    if (!["exe", "winexe"].includes(entry.target) || entry.file !== `reach-${entry.kind}.exe`) return null;
    if (![entry.sha256, entry.unsignedSha256, entry.sourceSha256].every((value) => typeof value === "string" && HEX64.test(value))) return null;
    // Signing adds a signature: the same bytes as the unsigned build were never signed.
    if (entry.sha256 === entry.unsignedSha256) return null;
    if (typeof entry.signer !== "string" || !entry.signer || entry.signer.length > 512) return null;
  }
  return manifest;
}

function readManifest(dir) {
  try {
    return validManifest(JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")));
  } catch {
    return null;
  }
}

/** The shipped entry for this helper, read without running anything: null unless version, kind, target and source digest all match. */
export function shippedEntry({ kind, target, sourceSha256 }, { shipped = SHIPPED_DIR, version = REACH_VERSION } = {}) {
  if (!shipped || !existsSync(path.join(shipped, "manifest.json"))) return null;
  const manifest = readManifest(shipped);
  if (!manifest || manifest.version !== version) return null;
  const entry = manifest.helpers.find((helper) => helper.kind === kind);
  return entry && entry.target === target && entry.sourceSha256 === sourceSha256 ? entry : null;
}

/** The name a signed helper's copy takes: its sources' digest and its own, never a local build's name. */
export const signedCopyName = (kind, sourceSha256, signedSha256) => `reach-${kind}-${sourceSha256.slice(0, 12)}-s${signedSha256.slice(0, 8)}.exe`;

// Windows PowerShell's own Get-AuthenticodeSignature (WinVerifyTrust, the
// check Windows makes itself), run by full path, the files handed over in its
// environment, never in its command line: no helper is needed to check a
// helper, so a PC that refuses unsigned programs can still check a signed one.
const SIGNATURES = "$ErrorActionPreference = 'Stop'; $list = @(foreach ($p in ($env:REACH_SIGNED_FILES -split \"`n\")) { if ($p) { $s = Get-AuthenticodeSignature -LiteralPath $p; [pscustomobject]@{ path = $p; status = [string]$s.Status; publisher = $(if ($null -ne $s.SignerCertificate) { $s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) } else { '' }); subject = [string]$s.SignerCertificate.Subject } } }); ConvertTo-Json -InputObject $list -Compress";
/** Windows' verdict on each file's Authenticode signature: Map(file → { status, publisher, subject }). */
export async function authenticodeSignatures(files, { run = exec, env = process.env } = {}) {
  const powershell = path.win32.join(systemRoot(env), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { stdout } = await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", SIGNATURES],
    { env: { ...env, REACH_SIGNED_FILES: files.join("\n") }, timeout: 60000, maxBuffer: 1 << 20, windowsHide: true });
  const said = JSON.parse(String(stdout).trim() || "[]");
  const out = new Map();
  for (const item of Array.isArray(said) ? said : [said])
    if (item && typeof item.path === "string") out.set(item.path, { status: String(item.status ?? ""), publisher: String(item.publisher ?? ""), subject: String(item.subject ?? "") });
  return out;
}

// Each shipped folder's signatures are checked once per run, all files in one
// PowerShell: the set of SHA-256s that passed.
const checked = new Map();
const warned = new Set();
function warnOnce(warn, key, text) {
  if (warned.has(key)) return;
  warned.add(key);
  warn(`Reach: ${text}`);
}
function verifyShipped(shipped, manifest, { publisher, signatures, env, warn }) {
  const key = JSON.stringify([shipped, manifest.version, publisher]);
  if (checked.has(key)) return checked.get(key);
  const promise = (async () => {
    const files = new Map();
    for (const entry of manifest.helpers) {
      const file = path.join(shipped, entry.file);
      try {
        if (sha256(await fs.readFile(file)) === entry.sha256) files.set(file, entry);
      } catch {}
    }
    const passed = new Set();
    if (!files.size) return passed;
    let verdicts;
    try {
      verdicts = await signatures([...files.keys()], { env });
    } catch (error) {
      warnOnce(warn, `signatures ${shipped}`, `Windows couldn't check the signed helpers' signatures (${String(error?.message || error).split(/\r?\n/)[0].slice(0, 200)}); building them on this PC.`);
      return passed;
    }
    for (const [file, entry] of files) {
      const verdict = verdicts.get(file);
      let now = "";
      try {
        now = sha256(await fs.readFile(file));
      } catch {}
      if (verdict?.status === "Valid" && verdict.publisher === publisher && now === entry.sha256) passed.add(entry.sha256);
      else warnOnce(warn, `signature ${file}`, `the signed ${entry.kind} helper isn't validly signed by ${publisher} on this PC (${verdict?.status || "no answer"}); building it on this PC.`);
    }
    return passed;
  })();
  checked.set(key, promise);
  return promise;
}
/** Forget every signature verdict (tests). */
export const resetSignedHelpers = () => {
  checked.clear();
  warned.clear();
};

/**
 * The release's signed helper for this plan, copied into `dir` and checked
 * there: { file, sha256 }, or null when there is none to trust (the caller
 * then builds it on the PC). `fresh` copies it to the caller's own fresh
 * name (`freshFile`) every time, as a fresh build would be.
 */
export async function signedHelper({ kind, target, sourceSha256 }, {
  dir, fresh = false, freshFile, shipped = SHIPPED_DIR, version = REACH_VERSION, publisher = SIGNED_PUBLISHER,
  signatures = authenticodeSignatures, env = process.env, warn = console.warn,
} = {}) {
  if (!dir || !shipped || !existsSync(path.join(shipped, "manifest.json"))) return null;
  const manifest = readManifest(shipped);
  if (!manifest) return warnOnce(warn, `manifest ${shipped}`, "the signed helpers' manifest isn't valid; building them on this PC."), null;
  if (manifest.version !== version) return warnOnce(warn, `version ${shipped}`, `the signed helpers are for Reach ${manifest.version}, not ${version}; building them on this PC.`), null;
  const entry = shippedEntry({ kind, target, sourceSha256 }, { shipped, version });
  if (!entry) return warnOnce(warn, `entry ${shipped} ${kind}`, `no signed ${kind} helper matches this installation's sources; building it on this PC.`), null;
  const passed = await verifyShipped(shipped, manifest, { publisher, signatures, env, warn });
  if (!passed.has(entry.sha256)) return null;
  let bytes;
  try {
    bytes = await fs.readFile(path.join(shipped, entry.file));
  } catch {
    return null;
  }
  if (sha256(bytes) !== entry.sha256) return warnOnce(warn, `changed ${shipped} ${kind}`, `the signed ${kind} helper changed after it was checked; building it on this PC.`), null;
  const file = fresh ? freshFile : path.join(dir, signedCopyName(kind, sourceSha256, entry.sha256));
  if (!file || path.dirname(file) !== path.resolve(dir)) return null;
  const hashOf = async (name) => {
    try {
      return sha256(await fs.readFile(name));
    } catch {
      return "";
    }
  };
  if (!fresh && (await hashOf(file)) === entry.sha256) return { file, sha256: entry.sha256 };
  const tmp = `${file}-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp.exe`;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, bytes, { mode: 0o700, flag: "wx" });
    await renameScanned(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    warnOnce(warn, `copy ${dir} ${kind}`, `couldn't copy the signed ${kind} helper into Reach's folder (${error?.code || "error"}); building it on this PC.`);
    return null;
  }
  // What's in place now, read back: a copy someone changed meanwhile, or one
  // still held by a running helper, is not this one.
  if ((await hashOf(file)) !== entry.sha256) return null;
  if (!fresh) {
    const older = new RegExp(`^reach-${kind}-[0-9a-f]{12}-s[0-9a-f]{8}\\.(?:exe|sha256)$`);
    for (const name of await fs.readdir(dir).catch(() => []))
      if (older.test(name) && !name.startsWith(path.basename(file, ".exe")))
        await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
  }
  return { file, sha256: entry.sha256 };
}
