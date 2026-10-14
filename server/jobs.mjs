import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { id, fail, loadJson, atomicJson } from "./core.mjs";
import { shellSandboxProfile } from "./agent-shell.mjs";
import { spawnVerified } from "./desktop-native.mjs";
import { encodeSandboxRequest, createSandboxFrameReader, jobRequestEntries } from "./windows-sandbox.mjs";

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
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
  // `sandbox`: on a Mac, what the sandbox denies (server/browser-private-paths.mjs
  // agentShellSandbox), for anyone but your own devices: an agent's job can't
  // read Reach's credentials or reach its private socket (connections audit,
  // Oct 10). Without sandbox-exec, such a job doesn't run. On Windows it's the
  // AppContainer descriptor from server/windows-sandbox.mjs (`mode: "jobs"`),
  // run through the hash-verified helper (`helper`); `spawnHelper` is a test seam.
  start({ command, cwd, timeoutMs = 60000 }, clientId, { sandbox = null, sandboxExec = SANDBOX_EXEC, helper = null, spawnHelper = null } = {}) {
    // A Windows AppContainer job: the descriptor carries `mode`, so the Mac's
    // sandbox-exec presence check never applies to it.
    const framed = process.platform === "win32" && !!sandbox && sandbox.mode === "jobs";
    if (sandbox && !framed && !fs.existsSync(sandboxExec))
      throw fail(503, "This Mac can't sandbox agent commands, so none run.");
    if (framed && !helper)
      throw fail(503, "Reach's command sandbox isn't ready on this PC, so the command didn't run.");
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
    const child = framed
      ? // An agent's or invited person's job: the AppContainer + Job Object
        // helper (scripts/native/sandbox.cs) runs cmd.exe /d /s /c inside its
        // grant. The request is framed on stdin, which then stays open as the
        // end-of-input lifeline; its answers come back as frames (below).
        (spawnHelper || ((file, sha256, options) => spawnVerified(file, sha256, ["run"], options)))(
          helper.file, helper.sha256,
          { cwd, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
        )
      : process.platform === "win32"
        ? spawn(
            "powershell.exe",
            // Windows PowerShell writes to a pipe in the PC's old OEM code
            // page; Reach reads UTF-8 (é came back as ‚). Its own output, and
            // what it hands programs, in UTF-8 instead: quietly skipped where
            // policy forbids it (Constrained Language Mode), and never ahead
            // of what must come first (`using`, `param`).
            ["-NoProfile", "-NonInteractive", "-Command", /^\s*(?:using\s|param\s*\()/i.test(command) ? command : `try { [Console]::OutputEncoding = $OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}\n${command}`],
            { cwd, env, windowsHide: true },
          )
        : sandbox
          ? spawn(sandboxExec, ["-p", shellSandboxProfile(sandbox), process.env.SHELL || "/bin/sh", "-lc", command], {
              cwd,
              env,
              detached: true,
            })
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
    if (framed) {
      // The helper reports the main process's exit in an 'X' frame; its own
      // process stays alive to reap survivors until the deadline, so the 1 s
      // grace runs off that frame (as the Mac's does off the shell's exit),
      // keeping the jobs.test.mjs:25 background contract (finding 13). A child's
      // bytes can only arrive as 'O'/'E' data frames, never a forged 'X'/'F'.
      let framedExit = null;
      const read = createSandboxFrameReader({
        onStdout: append, onStderr: append,
        onExit: (code) => { framedExit = code; const grace = setTimeout(() => end(code), 1000); grace.unref(); },
        onRefused: ({ message }) => { append(message); if (job.status === "running") job.status = "failed"; },
        onError: () => { if (job.status === "running") job.status = "failed"; },
      });
      child.stdout.on("data", read);
      child.on("error", (e) => { append(e.message); job.status = "failed"; });
      child.on("close", () => { clearTimeout(timer); end(framedExit); });
      try { child.stdin.write(encodeSandboxRequest(jobRequestEntries(sandbox, { command, cwd, timeoutMs }))); } catch {}
    } else {
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
    }
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
