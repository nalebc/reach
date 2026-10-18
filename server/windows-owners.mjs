// Reach's owner checks on Windows, where a Mac reads a socket's owner and
// folder and asks lsof (agent-sessions/trusted-socket.mjs, codex.mjs): who
// serves a named pipe, and which processes hold a file open. One small C#
// helper (scripts/native/owners.cs), built into the data folder as every
// helper a security check runs is (desktop-native.mjs windowsHelper: its
// SHA-256 noted, and run only while it still has it); one JSON line per
// question, and anything else is no answer.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertUnchanged, windowsHelper } from "./desktop-native.mjs";

const exec = promisify(execFile);

// A Windows named pipe (\\.\pipe\name or \\?\pipe\name), the only local
// endpoint Node can open directly there. One name, as Windows documents it: no
// slashes and not only dots, so it can't turn into a path to something else.
export const PIPE = /^\\\\[.?]\\pipe\\(?!\.+$)[^\\/\0-\x1f]{1,256}$/i;

// The data folder the helper is built into: Reach's own, from its start
// (agent-sessions/index.mjs), or a team lead's bridge's (scripts/team-mcp.mjs).
let folder = null;
export const useOwnersFolder = (dir) => {
  folder = dir || null;
};

// Built ahead (csc takes seconds, longer under an antivirus), not by the
// first Codex connection or team call that needs it; once per data folder,
// so two at start never undo each other's build.
const prepared = new Map();
export const prepareOwners = (dataDir, { build = windowsHelper } = {}) => {
  if (build !== windowsHelper) return build("owners", { dir: dataDir });
  if (!prepared.has(dataDir))
    prepared.set(dataDir, build("owners", { dir: dataDir }).catch((error) => {
      prepared.delete(dataDir);
      throw error;
    }));
  return prepared.get(dataDir);
};

export async function askOwners(verb, target, { dataDir = folder, run = exec, build = windowsHelper, unchanged = assertUnchanged } = {}) {
  // A pipe, or a file on a drive (never a share): nothing else is asked about.
  if (typeof target !== "string" || !(verb === "pipe" ? PIPE.test(target) : verb === "holders" && /^[A-Za-z]:\\[^\0-\x1f]*$/.test(target)))
    throw new Error("Not something Reach checks.");
  if (!dataDir) throw new Error("Reach's data folder isn't known here.");
  const { file, sha256 } = await prepareOwners(dataDir, { build });
  try {
    unchanged(file, sha256);
  } catch (error) {
    // Changed on disk since: never run, and built again next time.
    prepared.delete(dataDir);
    throw error;
  }
  const { stdout } = await run(file, [verb, target], { timeout: 15000, maxBuffer: 1 << 20, windowsHide: true });
  const lines = String(stdout).split(/\r?\n/).filter(Boolean);
  const answer = lines.length === 1 ? JSON.parse(lines[0]) : null;
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) throw new Error("The owner check answered something Reach can't read.");
  return answer;
}
export const pipeOwner = (pipe, options) => askOwners("pipe", pipe, options);
export const fileHolders = (file, options) => askOwners("holders", file, options);
