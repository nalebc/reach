import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

// Inspect local executables only. Device discovery must not start an AI session.
export async function findCodexExecutable({
  platform = process.platform,
  env = process.env,
  access = fs.access,
  stat = fs.stat,
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
  if (!env.REACH_CODEX && platform === "darwin") {
    // The desktop apps bundle the CLI; its location moved between versions.
    for (const embedded of [
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
      "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex",
      "/Applications/ChatGPT.app/Contents/Resources/codex",
      "/Applications/Codex.app/Contents/Resources/codex",
    ])
      if (await usable(embedded)) return embedded;
  }
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
    apps: desktop && scopes.includes("apps"),
    screen: desktop && scopes.includes("screen") && screen === true,
    screenSupported: desktop && scopes.includes("screen"),
    codex: scopes.includes("codex") && codexInstalled === true,
  };
}
