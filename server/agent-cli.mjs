// Agent CLIs on Windows, found as something Node can start without a shell.
// Node won't start a .cmd or .bat by itself (EINVAL since CVE-2024-27980), a
// shell would read prompt text as commands, and the extensionless file npm
// writes beside its .cmd is a POSIX sh script. So an npm shim counts as what
// it runs: a native .exe, else its JS entry script, started with Node.
// Everywhere else nothing here applies: spawnable() hands a path back as is.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const EXE = /\.(exe|com)$/i;
const SCRIPT = /\.[cm]?js$/i;

// What to start for a CLI found at `file`, as spawn's file and leading
// arguments: itself, but on Windows a JS entry script runs under Node
// (Reach's own, where npm's shim would take node from PATH).
export function spawnable(file, { platform = process.platform, node = process.execPath } = {}) {
  return platform === "win32" && SCRIPT.test(file) ? { file: node, args: [file] } : { file, args: [] };
}

// Windows names environment variables case-insensitively (Path, PathExt).
export const envValue = (env, name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];

const fileAt = async (file) => {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
};

// What an npm .cmd shim (cmd-shim) runs, from the paths it names after %dp0%
// (%~dp0 in older npm): a native .exe alone, or node.exe and then a script.
//   "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
//   ... "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
// Anything else (an sh or PowerShell target, a hand-written .cmd): null.
export async function shimTarget(shim, { readFile = fs.readFile } = {}) {
  let text;
  try {
    text = String(await readFile(shim, "utf8"));
  } catch {
    return null;
  }
  if (text.length > 16384) return null;
  const named = [...new Set([...text.matchAll(/"%(?:~dp0|dp0%)\\([^"%\r\n]+)"/gi)].map((m) => m[1]))];
  const at = (relative) => path.resolve(path.dirname(shim), ...relative.split(/[\\/]/));
  if (named.length === 1 && EXE.test(named[0])) return at(named[0]);
  if (named.length === 2 && /^node\.exe$/i.test(named[0]) && SCRIPT.test(named[1])) return at(named[1]);
  return null;
}

// The Codex CLI's npm package only starts a native codex.exe from its
// platform package, found here as its bin/codex.js finds it. Started
// directly: Windows doesn't end a killed Node's child with it, and a Codex
// left behind would hold Reach's pipes.
export async function codexNative(script, { arch = process.arch, isFile = fileAt } = {}) {
  const triple = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" }[arch];
  if (!triple || !/[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js$/i.test(script)) return null;
  let vendor;
  try {
    vendor = path.join(path.dirname(createRequire(script).resolve(`@openai/codex-win32-${arch}/package.json`)), "vendor");
  } catch {
    vendor = path.join(path.dirname(script), "..", "vendor");
  }
  const file = path.join(vendor, triple, "bin", "codex.exe");
  return (await isFile(file)) ? file : null;
}

// Where installers put agent CLIs when Reach's PATH lacks them (a service
// or a start before the install): Claude Code's native installer, npm's
// global folder.
export const windowsCliDirs = (env = process.env, home = os.homedir()) =>
  [path.join(envValue(env, "USERPROFILE") || home, ".local", "bin"), envValue(env, "APPDATA") && path.join(envValue(env, "APPDATA"), "npm")].filter(Boolean);

// `command` as Node can start it on Windows: each folder on PATH, then
// `dirs`, PATHEXT's order within one, shims as what they run. A native .exe
// wins over a script found before it (`native` gives a script's own .exe);
// a script is started with Node only when there's no .exe. Null when none.
export async function findWindowsCli(command, {
  env = process.env,
  home = os.homedir(),
  dirs = windowsCliDirs(env, home),
  isFile = fileAt,
  readFile = fs.readFile,
  native = async () => null,
} = {}) {
  const exts = (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((ext) => ext.toLowerCase());
  const named = (file) => (path.extname(file) ? [file] : exts.map((ext) => file + ext));
  // A script is taken as itself only when named outright (REACH_CODEX): a
  // .js PATHEXT finds on PATH is one Windows would give to its script host.
  const explicit = /[/\\]/.test(command);
  const candidates = explicit
    ? named(command)
    : [...(envValue(env, "PATH") || "").split(";"), ...dirs]
        .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
        .filter(Boolean)
        .flatMap((dir) => named(path.join(dir, command)));
  let script = null;
  for (const file of new Set(candidates)) {
    if (!(await isFile(file))) continue;
    const ext = path.extname(file);
    const target = EXE.test(ext) || (explicit && SCRIPT.test(ext)) ? file : /^\.(cmd|bat)$/i.test(ext) ? await shimTarget(file, { readFile }) : null;
    if (!target || (target !== file && !(await isFile(target)))) continue;
    if (EXE.test(target)) return target;
    const exe = await native(target);
    if (exe) return exe;
    script ??= target;
  }
  return script;
}
