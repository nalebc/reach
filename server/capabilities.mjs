import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codexNative, findWindowsCli } from "./agent-cli.mjs";

const exec = promisify(execFile);

const APP_ROOTS = ["/Applications/ChatGPT.app", "/Applications/Codex.app"];
// The desktop apps bundle the CLI; its location has moved between versions.
export const BUNDLED_CODEX = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];
// Bundled CLIs, most likely first: the app's own package manifest names its
// entry point (codex-cli/codex-package.json); the known paths follow.
export async function bundledCodexPaths({ readFile = fs.readFile, home = os.homedir() } = {}) {
  const found = [];
  // These describe macOS bundles even when discovery is tested on another OS.
  const paths = path.posix;
  const userApps = APP_ROOTS.map(app => paths.join(home, app.slice(1)));
  for (const app of [...APP_ROOTS, ...userApps]) {
    const dir = paths.join(app, "Contents/Resources/codex-cli");
    try {
      const { entrypoint } = JSON.parse(await readFile(paths.join(dir, "codex-package.json"), "utf8"));
      const file = typeof entrypoint === "string" && paths.resolve(dir, entrypoint);
      if (file && !paths.isAbsolute(entrypoint) && file.startsWith(dir + paths.sep)) found.push(file);
    } catch {}
  }
  const userPaths = BUNDLED_CODEX.map(file => paths.join(home, file.slice(1)));
  return [...new Set([...found, ...BUNDLED_CODEX, ...userPaths])];
}

// Inspect executable paths only; the fallback asks the login shell where the
// command lives. Discovery never runs Codex or starts an AI session.
// REACH_CODEX first, then the CLI bundled with the desktop app (the one its
// own daemon runs: a stale codex on PATH would talk to it across versions),
// then PATH.
export async function findCodexExecutable({
  platform = process.platform,
  env = process.env,
  home = env.HOME || os.homedir(),
  access = fs.access,
  stat = fs.stat,
  bundled = bundledCodexPaths,
  extraPaths = [path.join(home, ".local/bin"), path.join(home, ".npm-global/bin"), path.join(home, ".volta/bin"), "/opt/homebrew/bin", "/usr/local/bin"],
  run = exec,
} = {}) {
  const windows = platform === "win32";
  const usable = async (file) => {
    try {
      await access(file, windows ? constants.F_OK : constants.X_OK);
      return (await stat(file)).isFile();
    } catch {
      return false;
    }
  };
  const command = env.REACH_CODEX || "codex";
  if (!env.REACH_CODEX && platform === "darwin")
    for (const file of await bundled({ home })) if (await usable(file)) return file;
  // Windows: what Node can start without a shell, never npm's extensionless
  // sh shim; an npm install as its native codex.exe (agent-cli.mjs).
  if (windows)
    return findWindowsCli(command, { env, home, isFile: usable, native: (script) => codexNative(script, { isFile: usable }) });
  const candidates = /[/\\]/.test(command)
    ? [command]
    : (env.PATH || "")
        .split(":")
        .filter(Boolean)
        .map((dir) => path.join(dir, command));
  for (const file of candidates) if (await usable(file)) return file;
  if (!env.REACH_CODEX) {
    for (const dir of extraPaths) {
      const file = path.join(dir, "codex");
      if (await usable(file)) return file;
    }
    // Services and GUI launches often inherit less PATH than Terminal. npm
    // prefixes and Node version managers can also live outside known paths.
    try {
      const { stdout } = await run(env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh"), ["-lc", "command -v codex"], { env, timeout: 5000, maxBuffer: 64 * 1024 });
      const file = stdout.trim();
      if (path.isAbsolute(file) && !/[\0\r\n]/.test(file) && await usable(file)) return file;
    } catch { /* A missing command or broken shell is an unavailable tool. */ }
  }
  return null;
}

export function createToolDetector({
  find = findCodexExecutable,
  now = Date.now,
  ttl = 30000,
} = {}) {
  let value,
    checked = -Infinity,
    pending;
  return async () => {
    if (value && now() - checked < ttl) return value;
    if (!pending)
      pending = Promise.resolve()
        .then(find)
        .then((executable) => {
          value = { codex: { installed: !!executable } };
          checked = now();
          return value;
        })
        .finally(() => {
          pending = null;
        });
    return pending;
  };
}

export function deviceCapabilities({
  platform,
  scopes,
  screen,
  codexInstalled,
}) {
  const desktop = ["darwin", "win32"].includes(platform);
  return {
    terminal: scopes.includes("terminal"),
    files: scopes.some((s) => ["files", "files:read"].includes(s)),
    // "apps:open": an invitation to watch chosen apps' windows.
    apps: desktop && (scopes.includes("apps") || scopes.includes("apps:open")),
    screen: desktop && scopes.includes("screen") && screen === true,
    screenSupported: desktop && scopes.includes("screen"),
    codex: scopes.includes("codex") && codexInstalled === true,
  };
}
