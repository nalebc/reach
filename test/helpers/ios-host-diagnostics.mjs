import { spawn } from "node:child_process";

// Observations only: no launch, recovery, pressure generation or toolchain
// change. These records test a hypothesis; absence does not establish a cause.
export const iosHostPredicate = 'process == "simdiskimaged" OR (process == "kernel" AND eventMessage CONTAINS[c] "simdiskimaged")';
export function startIosHostDiagnostics({ run, deadline, start = spawn, now = Date.now }) {
  const evidence = { scope: "host simdiskimaged and CoreSimulatorService process metadata; simdiskimaged unified log; vm_stat counters", startedAt: new Date(now()).toISOString(),
    logs: { command: "/usr/bin/log", args: ["stream", "--style", "compact", "--level", "info", "--predicate", iosHostPredicate], stdout: "", stderr: "", events: [], retentionUnits: "UTF-16 code units" }, samples: [] };
  const began = performance.now();
  let child, timer, force, stopped = false;
  const record = (event, extra = {}) => {
    if (evidence.logs.events.length < 20) evidence.logs.events.push({ event, elapsedMs: Math.round(performance.now() - began), ...extra });
    else evidence.logs.eventsTruncated = true;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    record("stop");
    if (child && child.exitCode === null && child.signalCode === null) {
      try { record("kill-request", { signal: "SIGTERM" }); child.kill("SIGTERM"); } catch (error) { evidence.logs.error = String(error.message).slice(0, 1000); }
      force = setTimeout(() => { try { record("kill-request", { signal: "SIGKILL" }); child.kill("SIGKILL"); } catch { /* Evidence cleanup only. */ } }, 5000);
      force.unref();
    }
    child?.stdout?.destroy(); child?.stderr?.destroy();
  };
  const remaining = Math.min(570000, deadline - now());
  if (Number.isFinite(remaining) && remaining > 0) {
    try {
      child = start(evidence.logs.command, evidence.logs.args, { stdio: ["ignore", "pipe", "pipe"] });
      child.once("spawn", () => record("spawn", { pid: child.pid }));
      child.once("exit", (code, signal) => record("exit", { code, signal }));
      child.once("close", (code, signal) => { clearTimeout(force); record("close", { code, signal }); stop(); });
      child.once("error", error => { evidence.logs.error = String(error.message).slice(0, 1000); record("error"); stop(); });
      for (const [field, maximum] of [["stdout", 32768], ["stderr", 4096]]) {
        child[field]?.setEncoding("utf8").on("data", chunk => {
          evidence.logs.truncated ||= evidence.logs[field].length + chunk.length > maximum;
          evidence.logs[field] = (evidence.logs[field] + chunk).slice(-maximum);
        });
      }
      timer = setTimeout(stop, remaining); timer.unref();
    } catch (error) { evidence.logs.error = String(error.message).slice(0, 1000); stop(); }
  } else evidence.logs.skipped = "No diagnostic time remains in the existing work budget.";
  const sample = async label => {
    if (evidence.samples.length >= 2) return;
    const allowed = Math.min(2000, deadline - now());
    const item = { label: String(label).slice(0, 80), at: new Date(now()).toISOString() };
    evidence.samples.push(item);
    if (!Number.isFinite(allowed) || allowed <= 0) { item.skipped = "No diagnostic time remains in the existing work budget."; return; }
    const capture = async (command, args, project) => {
      try {
        const result = await run(command, args, allowed, { captureLifecycle: true });
        return { ok: true, stdout: project(result.stdout), commandEvidence: result.commandEvidence };
      } catch (error) {
        return { error: String(error.message).slice(0, 1000), stdout: project(error.stdout), commandEvidence: error.commandEvidence };
      }
    };
    [item.processes, item.memory] = await Promise.all([
      capture("/bin/ps", ["-A", "-o", "pid=,ppid=,stat=,etime=,%cpu=,rss=,comm="], value => String(value || "").split("\n")
        .filter(line => /(?:^|[\s/])(?:simdiskimaged|(?:com\.apple\.CoreSimulator\.)?CoreSimulatorService)$/.test(line.trim())).slice(0, 20).join("\n").slice(-8192)),
      capture("/usr/bin/vm_stat", [], value => String(value || "").slice(0, 8192)),
    ]);
  };
  return { sample, stop, snapshot: () => evidence };
}
