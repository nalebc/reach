import fs from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const tail = (value, limit) => typeof value === "string" ? value.slice(-limit) : "";
export const commandFailureOutput = error => ({
  stdout: tail(error?.stdout, 8192), stderr: tail(error?.stderr, 8192),
  ...(error?.commandEvidence ? { commandEvidence: error.commandEvidence } : {}),
});
const failure = error => ({ error: String(error?.message || error).slice(0, 1000), ...commandFailureOutput(error) });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const bundleId = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/;
const launchLogs = new Map();
export const iosLaunchPredicate = bundle => `eventMessage CONTAINS[c] "${bundle}" OR process IN {"launchd", "runningboardd", "SpringBoard", "installd", "lsd"}`;

// Capture launch errors before a stalled simulator stops answering `log show`.
// Scope both the device and predicate. Host runtime observations are a separate,
// explicitly narrow collector, never a host-wide bundle-string log query.
// This observer does not launch/recover the app or decide whether it passed.
export function startIosLaunchLogs({ device, bundle, start = spawn, limit = 570000 }) {
  if (!uuid.test(device || "") || !bundleId.test(bundle || "")) return { stop() {} };
  const key = `${device}:${bundle}`;
  const previous = launchLogs.get(key);
  launchLogs.delete(key);
  const evidence = { stdout: previous?.stdout || "", stderr: previous?.stderr || "", truncated: previous?.truncated || false,
    captures: (previous?.captures || 0) + 1, sessions: (previous?.sessions || []).slice(-2), retentionUnits: "UTF-16 code units",
    ...(previous?.error ? { error: previous.error } : {}) };
  const began = performance.now(), session = { startedAt: new Date().toISOString(), events: [], stdoutFirst: "", stdoutTail: "", stderrTail: "", stdoutUnits: 0, stderrUnits: 0 };
  evidence.sessions.push(session);
  const record = (event, extra = {}) => {
    if (session.events.length < 20) session.events.push({ event, elapsedMs: Math.round(performance.now() - began), ...extra });
    else session.eventsTruncated = true;
  };
  let child, timer, force, stopped = false;
  const append = (field, chunk, maximum) => {
    const value = String(chunk);
    evidence.truncated ||= evidence[field].length + value.length > maximum;
    evidence[field] = tail(evidence[field] + value, maximum);
    // Three existing attempts at most: preserve an early prefix and late tail
    // per stream, even if later service messages displace aggregate history.
    session[`${field}Units`] += value.length;
    if (field === "stdout") {
      session.stdoutFirst += value.slice(0, Math.max(0, 8192 - session.stdoutFirst.length));
      session.stdoutTail = tail(session.stdoutTail + value, 16384);
    } else session.stderrTail = tail(session.stderrTail + value, 4096);
  };
  const stop = ({ retain = false, timedOut = false } = {}) => {
    if (!stopped) {
      stopped = true;
      clearTimeout(timer);
      evidence.stopped = true;
      record("stop", { timedOut });
      if (timedOut) evidence.timedOut = true;
      if (child && child.exitCode === null && child.signalCode === null) {
        try { record("kill-request", { signal: "SIGTERM" }); child.kill("SIGTERM"); } catch (error) { evidence.error = String(error.message).slice(0, 1000); }
        force = setTimeout(() => { try { record("kill-request", { signal: "SIGKILL" }); child.kill("SIGKILL"); } catch { /* Diagnostic cleanup cannot change the launch result. */ } }, 5000);
        force.unref();
      }
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    }
    if (retain) {
      // Only failed launches need later collection; bound even that cache.
      if (launchLogs.size >= 4) launchLogs.delete(launchLogs.keys().next().value);
      launchLogs.set(key, evidence);
    }
  };
  try {
    session.command = "xcrun";
    session.args = ["simctl", "spawn", device, "log", "stream", "--style", "compact", "--level", "info", "--predicate", iosLaunchPredicate(bundle)];
    child = start(session.command, session.args, { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", error => { evidence.error = String(error.message).slice(0, 1000); record("error", { error: evidence.error }); stop(); });
    child.once("spawn", () => record("spawn", { pid: child.pid }));
    child.once("exit", (code, signal) => record("exit", { code, signal }));
    for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
      stream?.once("end", () => record(`${name}-end`));
      stream?.once("close", () => record(`${name}-close`));
    }
    child.stdout?.setEncoding("utf8").on("data", chunk => append("stdout", chunk, 65536));
    child.stderr?.setEncoding("utf8").on("data", chunk => append("stderr", chunk, 8192));
    child.on("close", (code, signal) => { clearTimeout(force); evidence.exitCode = code; evidence.signal = signal; record("close", { code, signal }); stop(); });
    timer = setTimeout(() => stop({ timedOut: true }), Math.min(570000, Math.max(1, limit)));
    timer.unref();
  } catch (error) { evidence.error = String(error.message).slice(0, 1000); stop(); }
  return { stop, snapshot: () => evidence };
}

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
  const key = `${device}:${bundle}`, liveLogs = launchLogs.get(key);
  launchLogs.delete(key);
  const until = Math.min(deadline, now() + 10000);
  if (!Number.isFinite(until) || until <= now()) return { skipped: "No diagnostic time remains in the existing work budget.", ...(liveLogs ? { liveLogs } : {}) };
  const result = { device, bundle, ...(liveLogs ? { liveLogs } : {}), logs: { pending: true }, processes: { pending: true }, installedApp: { pending: true }, crashes: { pending: true } };
  const capture = async (args, project) => {
    const remaining = Math.max(0, until - now());
    if (!remaining) return { skipped: "Diagnostic budget exhausted." };
    try { return { ok: true, stdout: project((await run("xcrun", ["simctl", ...args], remaining)).stdout) }; }
    catch (error) { return failure(error); }
  };
  let timer, timedOut = false;
  const commands = [
    capture(["spawn", device, "log", "show", "--last", "10m", "--style", "compact", "--predicate", iosLaunchPredicate(bundle)], value => tail(value, 65536))
      .then(value => { result.logs = value; }),
    capture(["spawn", device, "launchctl", "list"], value => tail(String(value || "").split("\n").filter(line => line.includes(bundle) || /SpringBoard|runningboard|launchservices|installd/i.test(line)).slice(0, 40).join("\n"), 8192))
      .then(value => { result.processes = value; }),
    capture(["appinfo", device, bundle], value => tail(value, 16384))
      .then(value => { result.installedApp = value; }),
    crashEvidence({ home, device, bundle, until, now }).catch(failure)
      .then(value => { result.crashes = value; }),
  ];
  try {
    await Promise.race([Promise.all(commands), new Promise(resolve => {
      timer = setTimeout(() => { timedOut = true; resolve(); }, Math.max(0, until - now()));
    })]);
  } finally { clearTimeout(timer); }
  for (const field of ["logs", "processes", "installedApp", "crashes"]) {
    if (result[field].pending) result[field] = { timedOut: true, error: "Diagnostic collection did not finish within the existing time budget." };
  }
  return { ...result, ...(timedOut ? { timedOut: true } : {}) };
}
