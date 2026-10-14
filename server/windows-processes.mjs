// Every process on a Windows PC, as `ps` lists them on a Mac: its id, its
// parent's, its program (file name and full path), its command line and when
// it started. Reach's one Reach per computer reads it (scripts/instances.mjs),
// and so can anything else that finds a program by what it runs. One small C#
// helper (scripts/native/processes.cs, whose header documents what it says),
// built on first use into `nativeDir` as every Windows helper is
// (desktop-native.mjs windowsBinary), cached by its source's hash. What
// Windows won't say (another account's process, a protected one) is null,
// never guessed.
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsBinary } from "./desktop-native.mjs";

const exec = promisify(execFile);

const count = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value) => value === null || typeof value === "string";
// One row as the helper wrote it, or nothing: a row Reach can't read makes
// the whole list unknown (never "no such process").
function row(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { pid, ppid, image, path, commandLine, startedAt } = value;
  if (!count(pid) || !count(ppid) || typeof image !== "string" || !text(path) || !text(commandLine)) return null;
  if (!(startedAt === null || (Number.isFinite(startedAt) && startedAt > 0))) return null;
  return { pid, ppid, image, path, commandLine, startedAt };
}

/** The helper's one line, as rows; throws when it isn't a list Reach can read. */
export function parseProcesses(stdout) {
  const lines = String(stdout).split(/\r?\n/).filter((line) => line.trim());
  let answer = null;
  try {
    answer = lines.length === 1 ? JSON.parse(lines[0]) : null;
  } catch {}
  if (answer && typeof answer.error === "string")
    throw Object.assign(new Error(`Windows wouldn't list its processes (${Number(answer.code) || 0}).`), { code: "REACH_PROCESSES_UNCHECKED" });
  const rows = Array.isArray(answer?.processes) ? answer.processes.map(row) : null;
  if (!rows || rows.some((r) => !r)) throw Object.assign(new Error("The process list said something Reach can't read."), { code: "REACH_PROCESSES_UNREADABLE" });
  return rows;
}

/**
 * Every process now: [{ pid, ppid, image, path, commandLine, startedAt }].
 * `image` is the program's file name ("node.exe"), `path` its full path,
 * `startedAt` ms since 1970; path, commandLine and startedAt are null when
 * Windows won't say. A parent is one only if it started before its child
 * (Windows hands ids out again). `nativeDir`: where the helper is built.
 */
export async function windowsProcesses({ run = exec, nativeDir, build = windowsBinary, platform = process.platform, signal } = {}) {
  if (platform !== "win32") throw Object.assign(new Error("Reading the process list this way is for Windows."), { status: 501 });
  // Tests only: a Reach started on a Mac as Windows (test/helpers/as-windows.mjs)
  // reads this list instead (one helper line in a file).
  if (process.env.REACH_TEST_WINDOWS_PROCESSES) return parseProcesses(fs.readFileSync(process.env.REACH_TEST_WINDOWS_PROCESSES, "utf8"));
  if (!nativeDir) throw new Error("Reach's folder for its helpers isn't known here.");
  fs.mkdirSync(nativeDir, { recursive: true, mode: 0o700 });
  const file = await build({ dataDir: nativeDir }, "processes", { dir: nativeDir, platform, signal });
  const { stdout } = await run(file, [], { timeout: 15000, maxBuffer: 64 << 20, windowsHide: true, ...(signal ? { signal } : {}) });
  return parseProcesses(stdout);
}
