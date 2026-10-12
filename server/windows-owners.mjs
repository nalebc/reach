// Reach's owner checks on Windows, where a Mac reads a socket's owner and
// folder and asks lsof (agent-sessions/trusted-socket.mjs, codex.mjs): who
// serves a named pipe, and which processes hold a file open. One small C#
// helper (scripts/native/owners.cs), built on first use into the data folder
// (desktop-native.mjs windowsBinary); one JSON line per question, and
// anything else is no answer.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsBinary } from "./desktop-native.mjs";

const exec = promisify(execFile);

// A Windows named pipe (\\.\pipe\name or \\?\pipe\name), the only local
// endpoint Node can open there. One name, as Windows documents it: no
// slashes and not only dots, so it can't turn into a path to something else.
export const PIPE = /^\\\\[.?]\\pipe\\(?!\.+$)[^\\/\0-\x1f]{1,256}$/i;

// The data folder the helper is built into: Reach's own, from its start
// (agent-sessions/index.mjs), or a team lead's bridge's (scripts/team-mcp.mjs).
let folder = null;
export const useOwnersFolder = (dir) => {
  folder = dir || null;
};

export async function askOwners(verb, target, { dataDir = folder, run = exec, binary = windowsBinary } = {}) {
  // A pipe, or a file on a drive (never a share): nothing else is asked about.
  if (typeof target !== "string" || !(verb === "pipe" ? PIPE.test(target) : verb === "holders" && /^[A-Za-z]:\\[^\0-\x1f]*$/.test(target)))
    throw new Error("Not something Reach checks.");
  if (!dataDir) throw new Error("Reach's data folder isn't known here.");
  const file = await binary({ dataDir }, "owners");
  const { stdout } = await run(file, [verb, target], { timeout: 15000, maxBuffer: 1 << 20, windowsHide: true });
  const lines = String(stdout).split(/\r?\n/).filter(Boolean);
  const answer = lines.length === 1 ? JSON.parse(lines[0]) : null;
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error("The owner check answered something Reach can't read.");
  return answer;
}
export const pipeOwner = (pipe, options) => askOwners("pipe", pipe, options);
// Built ahead (csc takes seconds, longer under an antivirus), not by the
// first Codex connection or team call that needs it.
export const prepareOwners = (dataDir, { binary = windowsBinary } = {}) => binary({ dataDir }, "owners");
export const fileHolders = (file, options) => askOwners("holders", file, options);
