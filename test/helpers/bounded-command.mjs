import { spawn } from "node:child_process";

// A command whose pipes may stay open after it is stopped (simctl on CI).
// `progress` is independent evidence that the requested operation happened,
// such as the copied app requesting its isolated test page. It stops only
// this launcher; the test must still check the operation's actual result.
export function boundedCommand(command, args, limit, { progress } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", settled = false, force;
    child.stdout.setEncoding("utf8").on("data", chunk => { if (stdout.length < 2 << 20) stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { if (stderr.length < 1 << 16) stderr += chunk; });
    const stop = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        force = setTimeout(() => child.kill("SIGKILL"), 5000);
        force.unref();
      }
      child.stdout.destroy();
      child.stderr.destroy();
    };
    const finish = (error, observed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout, stderr, ...(observed ? { observed: true } : {}) });
    };
    const timer = setTimeout(() => {
      stop();
      finish(Error(`did not finish within ${limit / 1000} s`));
    }, limit);
    child.on("error", error => finish(error));
    child.on("close", (code, signal) => {
      clearTimeout(force);
      finish(code === 0 ? null : Error(`exited with ${signal || code}${stderr.trim() ? `: ${stderr.trim().slice(-400)}` : ""}`));
    });
    if (progress) Promise.resolve(progress).then(() => {
      if (settled) return;
      stop();
      finish(null, true);
    }, error => {
      if (settled) return;
      stop();
      finish(error);
    });
  });
}
