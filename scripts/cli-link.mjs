// `./reach cli`: a `reach` command in every Terminal, like an installed CLI.
// A link to this folder's ./reach goes into a folder already on PATH that's
// yours to write (no sudo, no shell profile edits); `reach`, `reach status`,
// `reach stop` and `reach restart` then work from anywhere.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Where the link may go, in order, when the folder is on PATH and writable.
const places = (home) => [path.join(home, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"];

const writable = (dir, files) => {
  try {
    files.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

// Another Reach folder's launcher (an older checkout): fine to point elsewhere.
const isReachLauncher = (file, files) => {
  try {
    const real = files.realpathSync(file);
    return path.basename(real) === "reach" && files.existsSync(path.join(path.dirname(real), "scripts/bootstrap.mjs"));
  } catch {
    return false;
  }
};

export function linkCli({ script, env = process.env, home = os.homedir(), files = fs, platform = process.platform } = {}) {
  if (platform === "win32") return windowsCli({ root: path.win32.dirname(script), env, home, files });
  const dirs = String(env.PATH || "").split(path.delimiter).filter(Boolean).map((d) => path.resolve(d));
  const real = files.realpathSync(script);
  // Already done: the first `reach` on PATH is this folder's.
  for (const dir of dirs) {
    const at = path.join(dir, "reach");
    if (!files.existsSync(at)) continue;
    if (files.realpathSync(at) === real) return { ok: true, at, already: true, text: `reach already runs this Reach (${at}).` };
    break;
  }
  const dir = places(home).find((d) => dirs.includes(d) && files.existsSync(d) && writable(d, files));
  if (!dir)
    return {
      ok: false,
      text: `No folder on your PATH is yours to write. Add this line to ~/.zshrc, open a new Terminal, then run ./reach cli again:\n  export PATH="$HOME/.local/bin:$PATH"\nand first: mkdir -p ~/.local/bin`,
    };
  const at = path.join(dir, "reach");
  let replaced = "";
  if (files.existsSync(at) || isLink(at, files)) {
    if (!isLink(at, files) || (files.existsSync(at) && !isReachLauncher(at, files)))
      return { ok: false, text: `${at} is something else, not Reach. Reach left it alone; remove it first if you want reach there.` };
    replaced = safeReadlink(at, files);
    files.unlinkSync(at);
  }
  files.symlinkSync(real, at);
  // A different `reach` earlier on PATH would still win.
  const first = dirs.find((d) => files.existsSync(path.join(d, "reach")));
  const shadow = first && first !== dir ? path.join(first, "reach") : "";
  return {
    ok: true,
    at,
    text: [
      `reach now works in any Terminal (${at} → ${real}).`,
      ...(replaced ? [`It pointed to ${replaced} before.`] : []),
      ...(shadow ? [`But ${shadow} comes first on your PATH; remove it, or reach runs that one.`] : []),
      "Try: reach status",
    ].join("\n"),
  };
}

function isLink(file, files) {
  try {
    return files.lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}
function safeReadlink(file, files) {
  try {
    return files.readlinkSync(file);
  } catch {
    return "";
  }
}

// Windows: no links (a symlink needs Developer Mode, and cmd and PowerShell
// wouldn't run the sh launcher anyway). A small reach.cmd that starts this
// folder's goes into a folder on PATH that's yours: ~\.local\bin (Claude
// Code's installer puts it on PATH), else WindowsApps (on every user's PATH).
const SHIM = /^@echo off\r?\n"(.+\\reach\.cmd)" %\*\r?\n?$/;
function windowsCli({ root, env, home, files }) {
  const win = path.win32;
  const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH");
  const dirs = String((key && env[key]) || "").split(";").filter(Boolean).map((d) => win.resolve(d));
  const has = (dir) => dirs.some((d) => d.toLowerCase() === dir.toLowerCase());
  const target = win.join(root, "reach.cmd");
  const content = `@echo off\r\n"${target}" %*\r\n`;
  const points = (file) => {
    try {
      return SHIM.exec(files.readFileSync(file, "utf8"))?.[1] || null;
    } catch {
      return null;
    }
  };
  // Already done: the first reach.cmd on PATH starts this folder's.
  for (const dir of dirs) {
    const at = win.join(dir, "reach.cmd");
    if (!files.existsSync(at)) continue;
    if (points(at)?.toLowerCase() === target.toLowerCase()) return { ok: true, at, already: true, text: `reach already runs this Reach (${at}).` };
    break;
  }
  const local = env.LOCALAPPDATA || env.localappdata;
  const dir = [win.join(home, ".local", "bin"), ...(local ? [win.join(local, "Microsoft", "WindowsApps")] : [])].find(
    (d) => has(d) && files.existsSync(d) && writable(d, files),
  );
  if (!dir)
    return {
      ok: false,
      text: `No folder on your PATH is yours to write. In PowerShell, run these two lines, open a new window, then run .\\reach.cmd cli again:\n  New-Item -ItemType Directory -Force "$env:USERPROFILE\\.local\\bin" | Out-Null\n  [Environment]::SetEnvironmentVariable("Path", "$env:USERPROFILE\\.local\\bin;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")`,
    };
  const at = win.join(dir, "reach.cmd");
  let replaced = "";
  if (files.existsSync(at)) {
    const before = points(at);
    // Another Reach folder's (an older checkout): fine to point elsewhere.
    if (!before || !files.existsSync(win.join(win.dirname(before), "scripts", "bootstrap.mjs")))
      return { ok: false, text: `${at} is something else, not Reach. Reach left it alone; remove it first if you want reach there.` };
    replaced = before;
  }
  files.writeFileSync(at, content);
  const first = dirs.find((d) => files.existsSync(win.join(d, "reach.cmd")));
  const shadow = first && first.toLowerCase() !== dir.toLowerCase() ? win.join(first, "reach.cmd") : "";
  return {
    ok: true,
    at,
    text: [
      `reach now works in any PowerShell or Command Prompt window (${at} starts ${target}).`,
      ...(replaced ? [`It started ${replaced} before.`] : []),
      ...(shadow ? [`But ${shadow} comes first on your PATH; remove it, or reach runs that one.`] : []),
      "Open a new window and try: reach status",
    ].join("\n"),
  };
}
