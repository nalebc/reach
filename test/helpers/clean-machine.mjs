import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

// A computer with none of Reach's optional tools: no Codex (CLI or app), no
// Claude Code or Claude app, no Gemini, OpenClaw, Cursor or Antigravity, no
// Homebrew or npm on the login shell, no Apple Command Line Tools.
//
// An emptied PATH isn't enough to get there: detection asks the login shell
// (`$SHELL -lc "command -v …"`, which reads the shell's own profile and
// path_helper) and looks at fixed /Applications paths. So this replaces the
// login shell with one that finds nothing, hides the apps a fresh Mac doesn't
// come with (Safari stays), and answers the developer-tools and Spotlight
// probes as a fresh Mac does.
export const cleanPreload = "data:text/javascript," + encodeURIComponent(`
  import fs from "node:fs";
  import cp from "node:child_process";
  import { syncBuiltinESMExports } from "node:module";
  import { promisify } from "node:util";
  const apps = ["Claude", "ChatGPT", "Codex", "Cursor", "Antigravity", "Google Chrome", "Tailscale"].map((name) => "/Applications/" + name + ".app");
  const hidden = (p) => {
    const file = typeof p === "string" ? p : p instanceof URL ? p.pathname : "";
    return apps.some((app) => file === app || file.startsWith(app + "/"));
  };
  const missing = (p) => Object.assign(new Error("ENOENT: no such file or directory, '" + p + "'"), { code: "ENOENT", errno: -2, path: String(p) });
  const existsSync = fs.existsSync;
  fs.existsSync = (p) => (hidden(p) ? false : existsSync(p));
  for (const name of ["statSync", "lstatSync", "accessSync", "readdirSync", "readFileSync"]) {
    const original = fs[name];
    fs[name] = function (p, ...rest) {
      if (!hidden(p)) return original.call(this, p, ...rest);
      if (rest[0]?.throwIfNoEntry === false) return undefined;
      throw missing(p);
    };
  }
  for (const name of ["stat", "lstat", "access", "readdir", "readFile"]) {
    const original = fs[name];
    fs[name] = function (p, ...rest) {
      if (!hidden(p)) return original.call(this, p, ...rest);
      process.nextTick(rest.at(-1), missing(p));
    };
    const promised = fs.promises[name];
    fs.promises[name] = function (p, ...rest) {
      return hidden(p) ? Promise.reject(missing(p)) : promised.call(this, p, ...rest);
    };
  }
  // No Command Line Tools: xcode-select has no developer directory, and
  // Spotlight knows no agent apps.
  const noTools = Object.assign(new Error("xcode-select: error: unable to get active developer directory"), { code: 2 });
  const answers = {
    "/usr/bin/xcode-select": { error: noTools },
    "/usr/bin/xcrun": { error: noTools },
    "/usr/bin/mdfind": { stdout: "" },
    "/usr/bin/lsappinfo": { stdout: "" },
  };
  const execFile = cp.execFile;
  cp.execFile = function (command, args, options, callback) {
    const answer = answers[command];
    if (!answer) return execFile.apply(this, arguments);
    const done = [args, options, callback].find((a) => typeof a === "function");
    // Run something real, so the caller still gets a child process.
    const child = execFile(process.execPath, ["-e", ""], () =>
      done?.(answer.error || null, answer.stdout ?? "", answer.error?.message ?? ""),
    );
    return child;
  };
  cp.execFile[promisify.custom] = (...args) => {
    let child;
    const result = new Promise((resolve, reject) => {
      child = cp.execFile(...args, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })));
    });
    result.child = child;
    return result;
  };
  const execFileSync = cp.execFileSync;
  cp.execFileSync = function (command, ...rest) {
    const answer = answers[command];
    if (!answer) return execFileSync.call(this, command, ...rest);
    if (answer.error) throw answer.error;
    return answer.stdout;
  };
  syncBuiltinESMExports();
`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reach in the foreground as ./reach --local runs it, on that computer, with
// its own temporary home: nothing it reads or writes is this computer's.
// `prepare(root, home)` runs before it starts (settings, a fake Tailscale);
// `preloads` add to what it starts with; `ready` is the line it waits for;
// `pair: false` leaves the phone out (Tailscale mode has no pairing code).
// `launchCode`: more launch options, as source evaluated in Reach's process
// (code-only options such as a stand-in peer check), `prepare` may add some.
export async function startCleanReach(
  t,
  { args = {}, env: extra = {}, prepare, preloads = [], ready = /Pairing code: \d{4} \d{4}/, pair = true, launchCode = "" } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-clean-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await fs.mkdir(home);
  await fs.mkdir(bin);
  const prepared = (await prepare?.(root, home)) || {};
  // The login shell that finds nothing: every `$SHELL -lc "command -v x"`.
  const shell = path.join(bin, "no-shell");
  await fs.writeFile(shell, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const env = {
    ...process.env,
    HOME: home,
    SHELL: shell,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    REACH_CODEX: path.join(root, "no-codex"),
    ...extra,
    ...prepared.env,
  };
  const keep = new Set(["REACH_CODEX", ...Object.keys(extra), ...Object.keys(prepared.env || {})]);
  for (const key of Object.keys(env)) if (key.startsWith("REACH_") && !keep.has(key)) delete env[key];
  delete env.NODE_TEST_CONTEXT;
  const entry = pathToFileURL(path.resolve("scripts/launch.mjs")).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      cleanPreload,
      ...[...preloads, ...(prepared.preloads || [])].flatMap((p) => ["--import", p]),
      "--input-type=module",
      "-e",
      // Stops itself if the test runner dies.
      `setInterval(() => process.ppid === 1 && process.kill(process.pid, "SIGTERM"), 500).unref(); import { launch } from ${JSON.stringify(entry)}; await launch({ ...${JSON.stringify({ local: true, folders: [home], port: 0, ...args })}, ${[launchCode, prepared.launchCode].filter(Boolean).join(", ")} }, ${JSON.stringify(root)});`,
    ],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    // Its Funnel janitor (scripts/funnel-lease-worker.mjs) sees it gone and
    // switches the route off through the stand-in, writing here meanwhile.
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const deadline = Date.now() + 30000;
  while (!ready.test(output)) {
    if (child.exitCode !== null || Date.now() > deadline)
      throw Error(`Reach did not start:\n${output}`);
    await sleep(30);
  }
  if (!pair) return { child, exited, root, home, output: () => output, stdin: child.stdin };
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
  const [, a, b] = output.match(/Pairing code: (\d{4}) (\d{4})/);
  const paired = await fetch(url + "/api/pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: a + b, name: "test phone" }),
  });
  const { token } = await paired.json();
  const get = async (route) => {
    const response = await fetch(url + route, { headers: { Authorization: `Bearer ${token}` } });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: response.status, json, text };
  };
  return { child, exited, root, home, url, token, get, output: () => output };
}

// The same computer, in this process: Reach's real Chat adapter with every
// provider's own code, each finding nothing. Its list() and health() are what
// a phone receives from a clean computer, for interface tests to render.
export async function cleanSessions(dir, { platform = "darwin" } = {}) {
  const { createAgentSessions, detectAgents } = await import("../../server/agent-sessions/index.mjs");
  const { createCodexDaemon } = await import("../../server/agent-sessions/codex-daemon.mjs");
  const { createCodexSessions } = await import("../../server/agent-sessions/codex.mjs");
  const { createCodexDesktop } = await import("../../server/agent-sessions/codex-desktop.mjs");
  const { createClaudeSessions } = await import("../../server/agent-sessions/claude.mjs");
  const { createGeminiSessions } = await import("../../server/agent-sessions/gemini.mjs");
  const { claudeAppAccess } = await import("../../server/agent-sessions/claude-import.mjs");
  const absent = async () => {
    throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  };
  const daemon = createCodexDaemon({ locate: async () => null, run: absent, platform });
  return createAgentSessions({
    dataDir: dir,
    daemon,
    codex: createCodexSessions({ daemon }),
    codexDesktop: createCodexDesktop({ home: path.join(dir, "codex") }),
    claude: createClaudeSessions({
      projects: path.join(dir, "claude", "projects"),
      appRecords: path.join(dir, "claude", "app"),
      run: absent,
      env: {},
      locateCli: async () => null,
    }),
    gemini: createGeminiSessions({ home: path.join(dir, "gemini"), locate: async () => null }),
    claudeApp: () => claudeAppAccess({ app: path.join(dir, "Claude.app"), records: path.join(dir, "claude", "app") }),
    claudeOpen: async () => false,
    detect: (options = {}) => detectAgents({ ...options, run: absent, exists: () => false, env: {}, home: dir, platform }),
    platform,
  });
}
