// Every `openclaw` Reach starts on macOS and Linux: through the owner's
// login shell (their PATH), as exec (a timeout kills openclaw itself, not
// just the shell), with Homebrew's node@24 and bin first when they're there.
// OpenClaw 2026.9 refuses Node older than 24.16, and as a service Reach's
// own Node 22 leads PATH (scripts/bootstrap.mjs). "$@": every value is an
// argument, never shell text. A secret is never an argument: `secret` names
// the variable OpenClaw reads, set from REACH_SECRET in the env, then unset.
import path from "node:path/posix";
import { availableUpdateRuntime } from "./openclaw-update-recovery.mjs";

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

export async function openClawShell(args, {
  env = process.env, platform = process.platform, secret = "",
  runtime, findRuntime = availableUpdateRuntime,
} = {}) {
  if (secret && !/^[A-Z][A-Z0-9_]{1,63}$/.test(secret)) throw new Error("bad variable");
  runtime ??= await findRuntime({ platform }).catch(() => null);
  const script = [
    runtimePath(runtime),
    secret ? `export ${secret}="$REACH_SECRET"; unset REACH_SECRET` : "",
    'exec openclaw "$@"',
  ].filter(Boolean).join("; ");
  return [loginShell(env, platform), ["-lc", script, "openclaw", ...args]];
}
