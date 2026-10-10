import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fail, isPlainRecord } from "./core.mjs";
import { commandRefusal, hiddenControls } from "./agent-guard.mjs";

// The shell for Full control: one command at a time per agent, as the owner's
// account, from a folder the agent may use, with a clean environment (none of
// Reach's own variables), a time and output limit, and the deny list from
// agent-guard.mjs checked first. Every attempt is logged for the owner.
const controls = hiddenControls;
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
// The macOS sandbox every agent command runs in: Reach's own things stay out
// of reach at the operating-system level, however a command spells them (the
// deny list above only reads the command's text). Its socket and Tailscale's
// can't be connected to, its data (credentials) can't be read or written, its
// code can't be changed, and no other app is asked to run something outside
// the sandbox (Apple Events, open, osascript). Everything else stays as the
// owner's account allows: Full control is still full control.
const quote = (value) => `"${String(value).replace(/["\\]/g, (char) => `\\${char}`)}"`;
export function shellSandboxProfile({ readDeny = [], writeDeny = [], socketDeny = [], ports = [] } = {}) {
  const subpaths = (list) => list.map((item) => `(subpath ${quote(item)})`).join(" ");
  return [
    "(version 1)",
    "(allow default)",
    readDeny.length ? `(deny file-read* ${subpaths(readDeny)})` : "",
    writeDeny.length ? `(deny file-write* ${subpaths(writeDeny)})` : "",
    socketDeny.length ? `(deny network-outbound ${socketDeny.map((item) => `(remote unix-socket (subpath ${quote(item)}))`).join(" ")})` : "",
    ports.length ? `(deny network-outbound ${ports.map((port) => `(remote ip "localhost:${Number(port)}")`).join(" ")})` : "",
    "(deny appleevent-send)",
    '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript"))',
  ].filter(Boolean).join("\n");
}
export function createAgentShell({
  commandLog = null,
  hosts = () => [],
  protectedPaths = () => [],
  protectedPids = () => [process.pid, process.ppid],
  home = os.homedir(),
  record = () => {},
  now = Date.now,
  run = null,            // test override: ({ command, cwd, env, timeoutMs, maxOutput, signal }) => { output, exitCode, timedOut }
  // What the sandbox denies ({readDeny, writeDeny, socketDeny, ports}); null
  // off macOS. On macOS without sandbox-exec, commands are refused.
  sandbox = () => null,
  timeoutMs = 60000,
  maxOutput = 256 * 1024,
  maxConcurrent = 4,
} = {}) {
  const busy = new Set();
  const execute = run || (({ command, cwd, env, signal }) => new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const rules = sandbox();
    if (rules && !fs.existsSync(SANDBOX_EXEC))
      return reject(Object.assign(new Error("This Mac can't sandbox agent commands, so none run."), { status: 503 }));
    const child = rules
      ? spawn(SANDBOX_EXEC, ["-p", shellSandboxProfile(rules), "/bin/zsh", "-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true })
      : spawn("/bin/zsh", ["-c", command], { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const chunks = []; let size = 0, truncated = false, timedOut = false, finished = false;
    const collect = (chunk) => {
      if (size >= maxOutput) { truncated = true; return; }
      const slice = chunk.subarray(0, maxOutput - size);
      chunks.push(slice); size += slice.length;
      if (slice.length < chunk.length) truncated = true;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const stop = (signal) => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } } };
    const abort = () => stop("SIGKILL");
    signal.addEventListener("abort", abort, { once: true });
    let killTimer;
    const timer = setTimeout(() => { timedOut = true; stop("SIGTERM"); killTimer = setTimeout(() => { if (!finished) stop("SIGKILL"); }, 2000); killTimer.unref(); }, timeoutMs);
    const done = (exitCode) => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener("abort", abort);
      resolve({ output: Buffer.concat(chunks).toString("utf8") + (truncated ? "\n[Output truncated]" : ""), exitCode, timedOut });
    };
    child.on("error", () => done(null));
    child.on("close", (code) => done(code));
  }));
  const save = async (item) => { if (commandLog) await commandLog.append(item); };
  return {
    /** Run one command for a Full control agent. Returns the log record, with its output. */
    async run(client, input, { resolve, authorize }) {
      if (!commandLog) throw fail(503, "Command logging is unavailable. Nothing can run.");
      if (!isPlainRecord(input) || Object.keys(input).some((key) => !["command", "root", "cwd"].includes(key)))
        throw fail(400, "Send one command, its folder index and a working folder.");
      const { command, root = 0, cwd = "" } = input;
      if (typeof command !== "string" || !command.trim() || command.length > 4000 || controls.test(command))
        throw fail(400, "Enter a command without hidden controls, up to 4,000 characters.");
      if (!Number.isSafeInteger(root) || root < 0 || typeof cwd !== "string" || cwd.length > 4096 || controls.test(cwd))
        throw fail(400, "Choose a shared folder and a working folder inside it.");
      const latest = authorize();
      if (latest.policy?.preset !== "full" || !latest.scopes?.includes("browser:shell")) throw fail(403, "Commands need the Full control preset.");
      if (!latest.agentRoots?.[root]) throw fail(403, "Choose one of this session's shared folders.");
      const folder = resolve(root, cwd, latest);
      const check = () => {
        const current = authorize();
        if (current?.id !== latest.id || current.policy?.preset !== "full" ||
            !current.scopes?.includes("browser:shell") || current.agentRoots?.[root] !== latest.agentRoots[root] ||
            resolve(root, cwd, current) !== folder)
          throw fail(403, "Command access changed. The command was stopped.");
        return current;
      };
      const item = {
        id: crypto.randomUUID(), clientId: latest.id, name: String(latest.name).slice(0, 80),
        action: { type: "shell", command, root, cwd: cwd.slice(0, 4096) },
        reason: "Run a command for the agent.", approval: "automatic",
        status: "pending", createdAt: now(), expiresAt: latest.expiresAt, folder,
      };
      const refused = commandRefusal(command, { protectedPaths: protectedPaths(), home, hosts: hosts() }) ||
        (/\bkill\b/i.test(command) && protectedPids().some((pid) => new RegExp(`(^|[^0-9])${pid}([^0-9]|$)`).test(command))
          ? "That would stop Reach. The agent can't change what keeps your phone connected." : null);
      if (refused) {
        const blocked = { ...item, status: "blocked", error: refused, completedAt: now() };
        await save(blocked);
        return blocked;
      }
      if (busy.has(latest.id)) throw fail(429, "Wait for the agent's previous command to finish.");
      if (busy.size >= maxConcurrent) throw fail(429, "Too many agent commands are running. Try again shortly.");
      busy.add(latest.id);
      const controller = new AbortController();
      let watch;
      try {
        await save({ ...item, status: "executing" });
        check();
        const started = now();
        const env = {
          PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: home, USER: os.userInfo().username,
          LOGNAME: os.userInfo().username, SHELL: "/bin/zsh", LANG: "en_US.UTF-8", TERM: "dumb", TMPDIR: os.tmpdir(), REACH_AGENT: "1",
        };
        watch = setInterval(() => {
          try { check(); }
          catch (error) { controller.abort(error); }
        }, 50);
        watch.unref();
        const result = await execute({ command, cwd: folder, env, timeoutMs, maxOutput, signal: controller.signal });
        clearInterval(watch);
        if (controller.signal.aborted) throw controller.signal.reason;
        check();
        const finished = {
          ...item, status: result.timedOut ? "failed" : "executed", output: result.output, exitCode: result.exitCode ?? null,
          directory: folder, completedAt: now(),
          ...(result.timedOut ? { error: `Stopped after ${Math.round(timeoutMs / 1000)} seconds.` } : {}),
        };
        await save(finished);
        record("agent", `${latest.name} ran a command in ${path.basename(folder) || folder} (${Math.round((now() - started) / 100) / 10}s)`);
        return finished;
      } catch (error) {
        await save({ ...item, status: [401, 403].includes(error?.status) ? "revoked" : "failed",
          error: error?.status ? error.message : "The command could not complete.", completedAt: now() }).catch(() => {});
        throw error;
      } finally { clearInterval(watch); busy.delete(latest.id); }
    },
    async history(client, limit = 100) {
      if (!commandLog) return [];
      return commandLog.history({ clientId: client.id, limit });
    },
  };
}
