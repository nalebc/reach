import { spawn } from "node:child_process";

// A command whose pipes may stay open after it is stopped (simctl on CI).
// `progress` is independent evidence that the requested operation happened,
// such as the copied app requesting its isolated test page. It stops only
// this launcher; the test must still check the operation's actual result.
export function boundedCommand(command, args, limit, { progress, requireProgress = false, captureLifecycle = false } = {}) {
  return new Promise((resolve, reject) => {
    const began = performance.now();
    const commandEvidence = captureLifecycle ? {
      command: String(command).slice(0, 1024), args: args.slice(0, 32).map(arg => String(arg).slice(0, 1024)),
      argumentsTruncated: args.length > 32 || args.some(arg => String(arg).length > 1024),
      options: { stdio: ["ignore", "pipe", "pipe"], limitMs: limit, requireProgress, hasProgress: !!progress },
      startedAt: new Date().toISOString(), events: [], stdoutDecodedUtf8Bytes: 0, stderrDecodedUtf8Bytes: 0,
      outputRetention: { units: "UTF-16 code units", stdout: 2 << 20, stderr: 1 << 16 },
    } : undefined;
    const record = (event, extra = {}) => {
      if (!commandEvidence) return;
      if (commandEvidence.events.length < 32) commandEvidence.events.push({ event, elapsedMs: Math.round(performance.now() - began), ...extra });
      else commandEvidence.eventsTruncated = true;
    };
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    // Register before touching pipes: a spawn failure is evidence too.
    child.on("error", error => { record("error", { error: String(error.message).slice(0, 1000) }); finish(error); });
    let stdout = "", stderr = "", settled = false, force;
    child.stdout?.setEncoding("utf8").on("data", chunk => {
      if (commandEvidence) { if (!commandEvidence.stdoutDecodedUtf8Bytes) record("stdout-first-data"); commandEvidence.stdoutDecodedUtf8Bytes += Buffer.byteLength(chunk); }
      stdout += chunk.slice(0, Math.max(0, (2 << 20) - stdout.length));
    });
    child.stderr?.setEncoding("utf8").on("data", chunk => {
      if (commandEvidence) { if (!commandEvidence.stderrDecodedUtf8Bytes) record("stderr-first-data"); commandEvidence.stderrDecodedUtf8Bytes += Buffer.byteLength(chunk); }
      stderr += chunk.slice(0, Math.max(0, (1 << 16) - stderr.length));
    });
    if (commandEvidence) {
      child.once("spawn", () => { commandEvidence.pid = child.pid; record("spawn"); });
      child.once("exit", (code, signal) => record("exit", { code, signal }));
      for (const [name, stream] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
        stream?.once("end", () => record(`${name}-end`));
        stream?.once("close", () => record(`${name}-close`));
      }
    }
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) {
        record("kill-request", { signal: "SIGTERM" });
        child.kill("SIGTERM");
        force = setTimeout(() => { record("kill-request", { signal: "SIGKILL" }); child.kill("SIGKILL"); }, 5000);
        force.unref();
      }
      record("destroy-pipes", { exitCode: child.exitCode, signalCode: child.signalCode });
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const finish = (error, observed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      record("settle", { ok: !error, observed });
      // A stalled launch can explain itself before its pipes close. Preserve
      // that bounded evidence while retaining the original failure/deadline.
      // Keep the same evidence object: late exit/close events can still be
      // distinguished when the caller later serializes its failure report.
      const diagnostic = commandEvidence ? { commandEvidence } : {};
      if (error) reject(Object.assign(error instanceof Error ? error : Error(String(error)), { stdout, stderr, ...diagnostic }));
      else resolve({ stdout, stderr, ...(observed ? { observed: true } : {}), ...diagnostic });
    };
    const timer = setTimeout(() => {
      record("deadline", { exitCode: child.exitCode, signalCode: child.signalCode });
      stop();
      finish(Error(`did not finish within ${limit / 1000} s`));
    }, limit);
    child.on("close", (code, signal) => {
      record("close", { code, signal });
      clearTimeout(force);
      // A launcher exiting successfully does not prove a required native
      // transition. Keep the same deadline until its own evidence arrives.
      if (code === 0 && requireProgress) return;
      finish(code === 0 ? null : Error(`exited with ${signal || code}${stderr.trim() ? `: ${stderr.trim().slice(-400)}` : ""}`));
    });
    if (progress) Promise.resolve(progress).then(() => {
      if (settled) return;
      record("progress");
      stop();
      finish(null, true);
    }, error => {
      if (settled) return;
      record("progress-error");
      stop();
      finish(error);
    });
  });
}
