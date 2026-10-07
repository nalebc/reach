import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const APP_ROOTS = ["/Applications/ChatGPT.app", "/Applications/Codex.app"];
// The desktop apps bundle the CLI; its location has moved between versions.
export const BUNDLED_CODEX = [
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
  "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
];
// Bundled CLIs, most likely first: the app's own package manifest names its
// entry point (codex-cli/codex-package.json); the known paths follow.
export async function bundledCodexPaths({ readFile = fs.readFile } = {}) {
  const found = [];
  for (const app of APP_ROOTS) {
    const dir = path.join(app, "Contents/Resources/codex-cli");
    try {
      const { entrypoint } = JSON.parse(await readFile(path.join(dir, "codex-package.json"), "utf8"));
      const file = typeof entrypoint === "string" && path.resolve(dir, entrypoint);
      if (file && !path.isAbsolute(entrypoint) && file.startsWith(dir + path.sep)) found.push(file);
    } catch {}
  }
  return [...new Set([...found, ...BUNDLED_CODEX])];
}

// Inspect local executables only. Device discovery must not start an AI session.
// REACH_CODEX first, then the CLI bundled with the desktop app (the one its
// own daemon runs: a stale codex on PATH would talk to it across versions),
// then PATH.
export async function findCodexExecutable({
  platform = process.platform,
  env = process.env,
  access = fs.access,
  stat = fs.stat,
  bundled = bundledCodexPaths,
} = {}) {
  const windows = platform === "win32";
  const paths = windows ? path.win32 : path;
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
    for (const file of await bundled()) if (await usable(file)) return file;
  const candidates = /[/\\]/.test(command)
    ? [command]
    : (env.PATH || "")
        .split(windows ? ";" : ":")
        .filter(Boolean)
        .flatMap((dir) => {
          const file = paths.join(dir, command);
          return windows && !paths.extname(command)
            ? [
                file,
                ...(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
                  .split(";")
                  .map((ext) => file + ext.toLowerCase()),
              ]
            : [file];
        });
  for (const file of candidates) if (await usable(file)) return file;
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
