// The Node OpenClaw runs on, the same on a Mac and a Windows PC. When the
// computer's own Node is older than OpenClaw takes, Reach adds OpenClaw's
// own Node beside it, for OpenClaw only, with OpenClaw's own installer in
// its Node-only mode (install-cli.sh --node-only, install.ps1 -NodeOnly),
// where OpenClaw's launcher looks first (node-runtime-update.mjs). The
// computer's own Node is never replaced.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
// Windows names variables in any case (Path, PathExt).
const envValue = (env, name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];

// 24.16 or newer on 24, 26.1 or newer, anything after 26 (its engines,
// ">=24.16.0 <25 || >=26.1.0", and its installers' version checks).
export const NODE_NEEDED = "24.16";
export function supportedNode(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? "").trim());
  if (!m) return false;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major === 24 ? minor >= 16 : major === 26 ? minor >= 1 : major > 26;
}

// Whether a Node version is in a range OpenClaw names, read as its engines
// write it ("<25 || >=26.1.0") or as its launcher says it ("<25, or
// >=26.1.0"). Null for a range in any other shape: nothing is installed for
// one Reach can't read.
const RANGE = /^>=24\.(\d+)\.(\d+)\s+<25(?:(?:\s*\|\||,\s*or)\s*>=26\.(\d+)\.(\d+))?$/;
export function nodeRange(required) {
  const m = RANGE.exec(String(required ?? "").trim());
  if (!m) return null;
  const [lo24, lo26] = [[24, Number(m[1]), Number(m[2])], m[3] === undefined ? null : [26, Number(m[3]), Number(m[4])]];
  const atLeast = (v, lo) => v[1] > lo[1] || (v[1] === lo[1] && v[2] >= lo[2]);
  return (version) => {
    const v = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? "").trim())?.slice(1).map(Number);
    if (!v) return false;
    return (v[0] === 24 && atLeast(v, lo24)) || (!!lo26 && v[0] === 26 && atLeast(v, lo26));
  };
}

// OpenClaw's own Node: <home>/.openclaw/tools/cli-node/tools/node (its
// installers' --prefix is <home>/.openclaw/tools/cli-node).
export const privateNodePrefix = ({ env = process.env, home = os.homedir() } = {}) =>
  path.join(envValue(env, "OPENCLAW_HOME")?.trim() || home, ".openclaw", "tools", "cli-node");
export const privateNodeDir = (options = {}) => path.join(privateNodePrefix(options), "tools", "node");
export const privateNode = ({ platform = process.platform, ...options } = {}) =>
  platform === "win32" ? path.join(privateNodeDir(options), "node.exe") : path.join(privateNodeDir(options), "bin", "node");

// The private Node Reach itself runs on when the computer has none it can
// use (scripts/bootstrap.ps1, ./reach): <reach>/.reach/runtime/node-v…. It's
// Reach's, not the computer's own.
export const REACH_NODE = /[\\/]\.reach[\\/]runtime[\\/]node-v[^\\/]+[\\/]/i;

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

// What the phone says before Install, in the same words on every computer.
export const nodeNote = ({ version, word }) =>
  `OpenClaw needs Node ${NODE_NEEDED} or newer${version ? `, and this ${word} has Node ${version}` : ""}. Reach adds a Node for OpenClaw only first, with OpenClaw's own installer, and keeps this ${word}'s Node as it is.`;
