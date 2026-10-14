import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Where the Claude desktop app keeps its own data (Electron's userData): its
// chat records (claude-code-sessions) and its own copy of Claude Code
// (claude-code). A Mac: ~/Library/Application Support/Claude. Windows: from
// its installer, %APPDATA%\Claude; packaged (MSIX, Microsoft Store or
// WinGet), Windows keeps the app's writes there in the package's own copy,
// %LOCALAPPDATA%\Packages\Claude_<id>\LocalCache\Roaming\Claude, and that
// is what the app reads. Both are looked for, never guessed: a package copy
// that exists is the app's (Windows removes it with the package).

// The package folder Windows names for the Claude app: its name, then the
// 13 characters its publisher's id hashes to.
const PACKAGE = /^Claude_[a-z0-9]{13}$/i;
const envOf = (env, name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
function windowsFolders({ env, home }) {
  const p = path.win32;
  return {
    roaming: envOf(env, "APPDATA") || p.join(home, "AppData", "Roaming"),
    local: envOf(env, "LOCALAPPDATA") || p.join(home, "AppData", "Local"),
  };
}
function packagesOf(local, readdir) {
  try {
    return readdir(path.win32.join(local, "Packages")).filter((name) => PACKAGE.test(name)).sort();
  } catch {
    return [];
  }
}

// Every place the app's data can be, the packaged copies first.
export function claudeAppDataDirs({ platform = process.platform, env = process.env, home = os.homedir(), readdir = (dir) => fs.readdirSync(dir) } = {}) {
  if (platform !== "win32") return [path.posix.join(home, "Library", "Application Support", "Claude")];
  const p = path.win32;
  const { roaming, local } = windowsFolders({ env, home });
  return [
    ...packagesOf(local, readdir).map((name) => p.join(local, "Packages", name, "LocalCache", "Roaming", "Claude")),
    p.join(roaming, "Claude"),
  ];
}

// The app's data folder in use: the first that exists, else where its
// installer would put it.
export function claudeAppData({ exists = fs.existsSync, ...options } = {}) {
  const dirs = claudeAppDataDirs(options);
  return dirs.find((dir) => exists(dir)) || dirs.at(-1);
}

// Its chat records, one folder per account and organization.
export const claudeAppRecords = (options = {}) =>
  ((options.platform || process.platform) === "win32" ? path.win32 : path.posix).join(claudeAppData(options), "claude-code-sessions");

// Whether the Claude app is installed here. A Mac: in Applications. Windows:
// its installer's folder (%LOCALAPPDATA%\AnthropicClaude), or its package's.
export function claudeAppInstalled({ platform = process.platform, env = process.env, home = os.homedir(), exists = fs.existsSync, readdir = (dir) => fs.readdirSync(dir), app = "/Applications/Claude.app" } = {}) {
  if (platform !== "win32") return exists(app);
  const { local } = windowsFolders({ env, home });
  return exists(path.win32.join(local, "AnthropicClaude")) || packagesOf(local, readdir).length > 0;
}
