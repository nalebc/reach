// Every `openclaw` Reach starts on macOS and Linux: through the owner's
// login shell (their PATH), as exec (a timeout kills openclaw itself, not
// just the shell), with Homebrew's node@24 and bin first when they're there.
// OpenClaw 2026.9 refuses Node older than 24.16, and as a service Reach's
// own Node 22 leads PATH (scripts/bootstrap.mjs). "$@": every value is an
// argument, never shell text. A secret is never an argument: `secret` names
// the variable OpenClaw reads, set from REACH_SECRET in the env, then unset.
// On Windows (openclaw-windows.mjs): Node and openclaw.mjs, no shell at all.
import path from "node:path/posix";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { availableUpdateRuntime } from "./openclaw-update-recovery.mjs";
import { runTree, windowsOpenClaw, withSecret } from "./openclaw-windows.mjs";

const quote = (value) => "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
// "$@", export and unset need a POSIX shell (fish and nu have neither).
const POSIX = /(?:^|\/)(?:ba|z|k|da|)sh$/;
export const loginShell = (env = process.env, platform = process.platform) =>
  POSIX.test(env.SHELL || "") ? env.SHELL : platform === "darwin" ? "/bin/zsh" : "/bin/sh";

// Shell text that puts node@24's bin and Homebrew's bin first on PATH, or
// nothing without that runtime. Also used for `npm install -g openclaw`
// (agent-install.mjs), so OpenClaw installs under the Node it runs on.
export function runtimePath(runtime) {
  if (!runtime) return "";
  const lead = [path.dirname(runtime), path.join(path.dirname(path.dirname(path.dirname(path.dirname(runtime)))), "bin")];
  return `export PATH=${quote(lead.join(":"))}:"$PATH"`;
}

// [file, argv] for one run; on Windows [file, argv, env], the env the child
// gets (its Node's folder first on PATH).
export async function openClawShell(args, {
  env = process.env, platform = process.platform, secret = "",
  runtime, findRuntime = availableUpdateRuntime, ...windows
} = {}) {
  if (secret && !/^[A-Z][A-Z0-9_]{1,63}$/.test(secret)) throw new Error("bad variable");
  runtime ??= await findRuntime({ platform }).catch(() => null);
  if (platform === "win32") return windowsOpenClaw(args, { env, runtime, ...windows });
  const script = [
    runtimePath(runtime),
    secret ? `export ${secret}="$REACH_SECRET"; unset REACH_SECRET` : "",
    'exec openclaw "$@"',
  ].filter(Boolean).join("; ");
  return [loginShell(env, platform), ["-lc", script, "openclaw", ...args]];
}

// The env for a run that carries a secret: REACH_SECRET, which the login
// shell moves into `secret` and unsets; on Windows `secret` itself.
export const secretEnv = (env, { platform = process.platform, secret, value }) =>
  platform === "win32" ? withSecret(env, secret, value) : { ...env, REACH_SECRET: value };

// How Reach runs it: execFile, or on Windows the same with the whole process
// tree ended at the timeout.
const execFileAsync = promisify(execFile);
export const runOpenClaw = (file, args, options) =>
  process.platform === "win32" ? runTree(file, args, options) : execFileAsync(file, args, options);
