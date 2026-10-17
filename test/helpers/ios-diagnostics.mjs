import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";

const tail = (value, limit) => typeof value === "string" ? value.slice(-limit) : "";
export const commandFailureOutput = error => ({
  stdout: tail(error?.stdout, 8192), stderr: tail(error?.stderr, 8192),
});
const failure = error => ({ error: String(error?.message || error).slice(0, 1000), ...commandFailureOutput(error) });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const bundleId = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;

// Read only UUID-scoped simulator folders, never the host's DiagnosticReports
// or another device's logs. Missing local crash reports do not rule out a crash.
async function crashEvidence({ home, device, bundle, until, now }) {
  const result = { reports: [], searched: [], errors: [] };
  const folders = [
    ["Library", "Developer", "CoreSimulator", "Devices", device, "data", "Library", "Logs", "CrashReporter"],
    ["Library", "Logs", "CoreSimulator", device],
    ["Library", "Logs", "CoreSimulator", device, "DiagnosticReports"],
  ];
  const base = await fs.realpath(home);
  for (const parts of folders) {
    if (now() >= until || result.reports.length >= 3) break;
    const folder = path.join(base, ...parts), label = parts.join("/");
    result.searched.push(label);
    try {
      // A symlink to a host-wide crash directory must not widen collection.
      if ((await fs.lstat(folder)).isSymbolicLink() || await fs.realpath(folder) !== folder) {
        result.errors.push({ folder: label, error: "Scoped crash folder is a symlink." });
        continue;
      }
      const entries = (await fs.readdir(folder, { withFileTypes: true }))
        .filter(entry => entry.isFile() && entry.name.endsWith(".ips")).slice(0, 32);
      for (const entry of entries) {
        if (now() >= until || result.reports.length >= 3) break;
        const file = await fs.open(path.join(folder, entry.name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        let raw;
        try {
          const stat = await file.stat();
          if (!stat.isFile() || stat.size > 512 * 1024) continue;
          const buffer = Buffer.alloc(stat.size + 1);
          let length = 0;
          while (length < buffer.length && now() < until) {
            const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
          }
          raw = buffer.subarray(0, length).toString("utf8");
        } finally { await file.close(); }
        try {
          const split = raw.indexOf("\n");
          const header = JSON.parse(raw.slice(0, split));
          const report = JSON.parse(raw.slice(split + 1));
          const identities = [header.bundleID, report.bundleInfo?.CFBundleIdentifier].filter(value => value !== undefined);
          if (!identities.length || !identities.every(value => value === bundle)) continue;
          const owned = report.coalitionName?.toLowerCase() === `com.apple.coresimulator.simdevice.${device.toLowerCase()}`
            || (typeof report.procPath === "string" && report.procPath.toLowerCase().includes(`/devices/${device.toLowerCase()}/data/`));
          if (!owned) continue;
          result.reports.push({ file: `${label}/${entry.name}`, content: raw.slice(0, 65536), truncated: raw.length > 65536 });
        } catch { /* An incomplete or unrelated report is not attributable. */ }
      }
    } catch (error) { result.errors.push({ folder: label, error: String(error.message).slice(0, 1000) }); }
  }
  return result;
}

// Failure evidence only: no recovery, launch, host log query, or diagnose call.
// All work shares at most 10 s of the smoke test's EXISTING work budget. A
// broken diagnostics command cannot replace the failure that triggered it.
export async function collectIosFailureDiagnostics({ device, bundle, deadline, run, home = os.homedir(), now = Date.now }) {
  if (!uuid.test(device || "") || !bundleId.test(bundle || "")) return { skipped: "Disposable simulator or bundle identity unavailable." };
  const until = Math.min(deadline, now() + 10000);
  if (!Number.isFinite(until) || until <= now()) return { skipped: "No diagnostic time remains in the existing work budget." };
  const result = { device, bundle, logs: { pending: true }, processes: { pending: true }, crashes: { pending: true } };
  const capture = async (args, project) => {
    const remaining = Math.max(0, until - now());
    if (!remaining) return { skipped: "Diagnostic budget exhausted." };
    try { return { ok: true, stdout: project((await run("xcrun", ["simctl", ...args], remaining)).stdout) }; }
    catch (error) { return failure(error); }
  };
  let timer, timedOut = false;
  const commands = [
    capture(["spawn", device, "log", "show", "--last", "10m", "--style", "compact", "--predicate", `eventMessage CONTAINS[c] "${bundle}"`], value => tail(value, 65536))
      .then(value => { result.logs = value; }),
    capture(["spawn", device, "launchctl", "list"], value => tail(String(value || "").split("\n").filter(line => line.includes(bundle)).slice(0, 20).join("\n"), 8192))
      .then(value => { result.processes = value; }),
    crashEvidence({ home, device, bundle, until, now }).catch(failure)
      .then(value => { result.crashes = value; }),
  ];
  try {
    await Promise.race([Promise.all(commands), new Promise(resolve => {
      timer = setTimeout(() => { timedOut = true; resolve(); }, Math.max(0, until - now()));
    })]);
  } finally { clearTimeout(timer); }
  return { ...result, ...(timedOut ? { timedOut: true } : {}) };
}
