// OpenClaw on Windows, natively, as its makers document it
// (docs.openclaw.ai/platforms/windows): its CLI and Gateway run on Node,
// installed with npm, the Gateway kept by a Scheduled Task. No login shell
// here: npm's openclaw.cmd is found as the openclaw.mjs it runs
// (agent-cli.mjs) and started with a Node OpenClaw accepts, its arguments
// fixed and no shell between (cmd would read a token's & or % as commands). A secret is never an argument: it's the variable OpenClaw reads,
// set in the child's own environment, or its stdin.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { envValue, findWindowsCli, windowsCliDirs } from "./agent-cli.mjs";
import { accountSid } from "./windows-private-folder.mjs";

const exec = promisify(execFile);

// The Node OpenClaw runs on: 24.16 or newer on 24, 26.1 or newer, anything
// after 26 (its engines, ">=24.16.0 <25 || >=26.1.0", and its installer's
// Test-NodeVersionSupported).
export const NODE_NEEDED = "24.16";
export function supportedNode(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? "").trim());
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major === 24 ? minor >= 16 : major === 26 ? minor >= 1 : major > 26;
}

// OpenClaw's own Node, for OpenClaw only: where its installer's -NodeOnly and
// its "Update NodeJS" offer put it, and where its launcher looks first when
// the Node it was started with is too old (node-runtime-update.mjs).
export const privateNodeDir = ({ env = process.env, home = os.homedir() } = {}) =>
  path.join(envValue(env, "OPENCLAW_HOME")?.trim() || home, ".openclaw", "tools", "cli-node", "tools", "node");
// Where OpenClaw's installer puts a Node of its own when the PC has none it
// can use (install.ps1's portable fallback); npm's global commands land
// beside it then.
export const portableNodeDir = ({ env = process.env, home = os.homedir() } = {}) =>
  path.join(envValue(env, "LOCALAPPDATA") || path.join(home, "AppData", "Local"), "OpenClaw", "deps", "portable-node");
// Reach's PATH is the one it started with: an install made since (npm's
// folder, OpenClaw's installer's Node) is looked for where it goes.
export const openClawDirs = ({ env = process.env, home = os.homedir() } = {}) =>
  [...windowsCliDirs(env, home), portableNodeDir({ env, home })];

// What the owner types at the PC: openclaw.cmd, as PowerShell would run
// npm's openclaw.ps1 for a bare `openclaw`, which Windows' default policy
// refuses ("running scripts is disabled"); cmd takes either.
export const typedCli = (platform = process.platform) => (platform === "win32" ? "openclaw.cmd" : "openclaw");

// openclaw.mjs, as npm's openclaw.cmd runs it (or an openclaw.exe); null when
// Reach can't find one it can start.
export const findOpenClaw = ({ env = process.env, home = os.homedir(), find = findWindowsCli, ...files } = {}) =>
  find("openclaw", { env, home, dirs: openClawDirs({ env, home }), ...files });

const fileAt = async (file) => {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
};
// A Node's version, read once per build of it (`node -p`), or null.
const versions = new Map();
export async function nodeVersion(file, { run = exec, stat = fs.stat } = {}) {
  let key;
  try {
    const s = await stat(file);
    key = `${s.size}:${s.mtimeMs}`;
  } catch {
    return null;
  }
  const kept = versions.get(file);
  if (kept?.key === key) return kept.version;
  let version = null;
  try {
    version = String((await run(file, ["-p", "process.versions.node"], { timeout: 15000, windowsHide: true })).stdout).trim();
  } catch {}
  if (!/^\d+\.\d+\.\d+/.test(version || "")) version = null;
  versions.set(file, { key, version });
  return version;
}

const pathDirs = (env) =>
  (envValue(env, "PATH") || "").split(";").map((dir) => dir.trim().replace(/^"(.*)"$/, "$1")).filter((dir) => dir && path.isAbsolute(dir));

// The Node that runs openclaw.mjs: the one npm's openclaw.cmd would run
// (node.exe beside it, else the first on PATH) when OpenClaw accepts it.
// Otherwise, in the order OpenClaw's own launcher looks: its own Node, the
// rest of PATH, then where Windows' Node installers put one. None it
// accepts: that first one all the same, so OpenClaw itself says why (setup
// reads that as "needs Node 24.16"). Null when there's no Node at all.
export async function openClawNode({ env = process.env, home = os.homedir(), script, version = nodeVersion, isFile = fileAt } = {}) {
  const onPath = pathDirs(env).map((dir) => path.join(dir, "node.exe"));
  // npm's global layout: <prefix>\node_modules\openclaw\openclaw.mjs, its
  // .cmd in <prefix>.
  const beside = script ? path.join(path.dirname(script), "..", "..", "node.exe") : null;
  let first = null;
  for (const file of [beside, ...onPath].filter(Boolean))
    if (await isFile(file)) {
      first = file;
      break;
    }
  if (first && supportedNode(await version(first))) return first;
  const programFiles = envValue(env, "PROGRAMW6432") || envValue(env, "PROGRAMFILES") || "C:\\Program Files";
  const seen = new Set([first?.toLowerCase()]);
  for (const file of [path.join(privateNodeDir({ env, home }), "node.exe"), ...onPath, path.join(programFiles, "nodejs", "node.exe"), path.join(portableNodeDir({ env, home }), "node.exe")]) {
    if (seen.has(file.toLowerCase())) continue;
    seen.add(file.toLowerCase());
    if ((await isFile(file)) && supportedNode(await version(file))) return file;
  }
  return first;
}

// The Node a Reach terminal would find first (what OpenClaw's installer
// checks), and whether OpenClaw's own Node is there already: what installing
// OpenClaw needs first (agent-install.mjs). `version` is the PC's own Node,
// for the phone: Reach's private one (.reach\runtime, scripts/bootstrap.ps1,
// first on PATH when the PC has none it can use) isn't the PC's.
const REACH_NODE = /[\\/]\.reach[\\/]runtime[\\/]node-v[^\\/]+[\\/]node\.exe$/i;
export async function installNode({ env = process.env, home = os.homedir(), version = nodeVersion, isFile = fileAt } = {}) {
  const found = [];
  for (const file of pathDirs(env).map((dir) => path.join(dir, "node.exe")))
    if (await isFile(file)) found.push(file);
  const first = found[0] ? await version(found[0]) : null;
  const pcs = found.find((file) => !REACH_NODE.test(file));
  const dir = privateNodeDir({ env, home });
  const own = path.join(dir, "node.exe");
  return {
    version: pcs ? (pcs === found[0] ? first : await version(pcs)) : null,
    supported: supportedNode(first),
    dir,
    privateReady: (await isFile(own)) && supportedNode(await version(own)),
  };
}

// The Node's folder first on the child's PATH, as runtimePath does on a Mac:
// what OpenClaw starts from there (npm, the Gateway it installs) runs on the
// same Node. Windows names variables in any case: one PATH, kept as spelled.
export function leadPath(env, dir) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") || "Path";
  const rest = String(env[key] || "").split(";").filter((entry) => entry && entry.toLowerCase() !== dir.toLowerCase());
  return { ...env, [key]: [dir, ...rest].join(";") };
}

// [file, argv, env] for one openclaw run: Node, openclaw.mjs and the fixed
// arguments. `runtime`: a Node chosen already (OpenClaw's own, for an
// update). Missing: ENOENT, as a missing program reads everywhere else.
// Run on another Node than the one beside it, npm (OpenClaw's updater uses
// it) is told where OpenClaw is installed: a Node from a zip, OpenClaw's own
// among them, would otherwise name its own folder as npm's global one.
export async function windowsOpenClaw(args, { env = process.env, home = os.homedir(), runtime, find = findOpenClaw, pick = openClawNode, node = process.execPath, isFile = fileAt } = {}) {
  const found = await find({ env, home });
  if (!found) throw Object.assign(new Error("OpenClaw isn't installed on this computer."), { code: "ENOENT" });
  if (/\.(exe|com)$/i.test(found)) return [found, [...args], env];
  const file = runtime || (await pick({ env, home, script: found })) || node;
  let child = leadPath(env, path.win32.dirname(file));
  // npm's global layout: <prefix>\node_modules\openclaw\openclaw.mjs, with
  // its openclaw.cmd in <prefix> (pnpm's isn't, and is left alone).
  const prefix = path.dirname(path.dirname(path.dirname(found)));
  if (/[\\/]node_modules[\\/]openclaw[\\/]openclaw\.mjs$/i.test(found) && path.win32.dirname(file).toLowerCase() !== prefix.toLowerCase() && (await isFile(path.join(prefix, "openclaw.cmd"))))
    child = withVariable(child, "NPM_CONFIG_PREFIX", prefix);
  return [file, [found, ...args], child];
}

// One variable, any other spelling of its name dropped first (Windows names
// are case-insensitive).
const withVariable = (env, name, value) => ({
  ...Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== name.toUpperCase())),
  [name]: value,
});
// The variable OpenClaw reads, set directly (no shell to move it there, as
// REACH_SECRET is on a Mac).
export const withSecret = (env, name, value) =>
  withVariable(Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== "REACH_SECRET")), name, value);

// execFile's timeout ends only the process it started, and Windows doesn't
// end children with their parent: OpenClaw's launcher may have started
// itself again under another Node (its runtime recovery). The whole tree
// goes, as jobs.mjs ends a job. The error carries what execFile's would
// (code, killed, signal, output), never the command line: it can hold a token.
export const killTree = (pid) => {
  if (pid) execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
};
export function runTree(file, args, { timeout = 0, ...options } = {}, { start = execFile, kill = killTree } = {}) {
  return new Promise((resolve, reject) => {
    let timer = null, killed = false;
    const child = start(file, args, { ...options, windowsHide: true }, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (!error && !killed) return resolve({ stdout, stderr });
      reject(Object.assign(new Error("OpenClaw didn't finish."), {
        code: error?.code, signal: error?.signal ?? null, killed: killed || error?.killed === true, stdout, stderr,
      }));
    });
    if (timeout > 0)
      timer = setTimeout(() => {
        killed = true;
        kill(child.pid);
      }, timeout);
  });
}

// A secret file only this account, SYSTEM and Administrators can open, as
// chmod 600 makes it on a Mac (and Reach's own folders are made:
// windows-private-folder.mjs): inherited access removed, SIDs only (names
// are localized). Anything not confirmed throws.
const system32 = (env) => {
  const root = envValue(env, "SYSTEMROOT") || envValue(env, "WINDIR");
  return root && /^[A-Za-z]:\\/.test(root) ? path.win32.join(root, "System32") : "";
};
export async function ownerOnlyFile(file, { run = exec, env = process.env } = {}) {
  const system = system32(env);
  if (!system) throw new Error("no Windows folder");
  const { stdout } = await run(path.win32.join(system, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { timeout: 10000, windowsHide: true });
  const sid = accountSid(stdout);
  if (!sid) throw new Error("no account");
  await run(path.win32.join(system, "icacls.exe"), [file, "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F", `*${sid}:F`, "/Q"], { timeout: 30000, windowsHide: true });
}
