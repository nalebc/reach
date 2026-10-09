import { spawn, execFile } from "node:child_process";
import path from "node:path";
import { id, fail, loadJson, atomicJson } from "./core.mjs";
export class Jobs {
  constructor(config) {
    this.file = path.join(config.dataDir, "jobs.json");
    this.jobs = loadJson(this.file, []).map((j) => ({
      ...j,
      status: j.status === "running" ? "interrupted" : j.status,
    }));
    this.running = new Map();
  }
  list() {
    return this.jobs.slice().reverse();
  }
  get(jobId) {
    const j = this.jobs.find((j) => j.id === jobId);
    if (!j) throw fail(404, "Job not found.");
    return j;
  }
  save() {
    atomicJson(this.file, this.jobs);
  }
  start({ command, cwd, timeoutMs = 60000 }, clientId) {
    if (
      typeof command !== "string" ||
      !command.trim() ||
      command.length > 16000
    )
      throw fail(400, "Enter a command of up to 16,000 characters.");
    if (this.running.size >= 8)
      throw fail(
        409,
        "Eight jobs are already running. Wait for one to finish.",
      );
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000)
      throw fail(400, "timeoutMs must be between 1,000 and 3,600,000.");
    const job = {
      id: id(),
      clientId,
      command,
      cwd,
      status: "running",
      createdAt: new Date().toISOString(),
      output: "",
      exitCode: null,
      timeoutMs,
    };
    const env = { ...process.env };
    for (const key of Object.keys(env))
      if (key.startsWith("REACH_")) delete env[key];
    const child =
      process.platform === "win32"
        ? spawn(
            "powershell.exe",
            ["-NoProfile", "-NonInteractive", "-Command", command],
            { cwd, env, windowsHide: true },
          )
        : spawn(process.env.SHELL || "/bin/sh", ["-lc", command], {
            cwd,
            env,
            detached: true,
          });
    // At the deadline: a job still running times out. One already finished
    // (its shell exited) only has whatever it left in the background ended.
    const timer = setTimeout(() => {
      this.kill(child);
      if (job.status !== "running") return;
      job.status = "timed_out";
      this.save();
    }, timeoutMs);
    timer.unref();
    this.running.set(job.id, child);
    this.jobs.push(job);
    if (this.jobs.length > 200)
      this.jobs = this.jobs
        .filter((j) => j.status === "running")
        .concat(this.jobs.filter((j) => j.status !== "running").slice(-190));
    this.save();
    let ended = false;
    const end = (code) => {
      if (ended) return;
      ended = true;
      job.exitCode = code;
      job.finishedAt = new Date().toISOString();
      if (job.status === "running")
        job.status = code === 0 ? "completed" : "failed";
      this.running.delete(job.id);
      this.save();
    };
    const append = (data) => {
      if (ended) return;
      job.output = (job.output + data.toString()).slice(-262144);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (e) => {
      append(e.message);
      job.status = "failed";
    });
    // The shell exited, but something it started in the background (`cmd &`)
    // still holds its output: the job is done all the same, after a moment
    // for the last output to arrive.
    child.on("exit", (code) => {
      const grace = setTimeout(() => end(code), 1000);
      grace.unref();
    });
    // Everything holding its output ended: nothing is left to end later.
    child.on("close", (code) => {
      clearTimeout(timer);
      end(code);
    });
    return job;
  }
  kill(child) {
    if (!child.pid) return;
    if (process.platform === "win32")
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
    else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      const t = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 1000);
      t.unref();
    }
  }
  cancel(jobId) {
    const j = this.get(jobId),
      child = this.running.get(jobId);
    if (child) {
      j.status = "cancelled";
      this.kill(child);
      this.save();
    }
    return j;
  }
  dispose() {
    for (const j of this.jobs) if (this.running.has(j.id)) this.cancel(j.id);
  }
}
