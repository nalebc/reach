import fs from "node:fs";
import path from "node:path";
import { trimLog } from "../scripts/housekeeping.mjs";
import { pruneCommandArchives } from "./browser-command-log.mjs";

// Reach's own files stay small for as long as it runs (reliability audit,
// Oct 10): at start and every 6 hours, not only when ./reach starts.
// - Logs over 1 MB keep their latest 256 KB (crash.log: 256 KB, its last 64).
// - Agent command histories set aside: the newest 5, none older than 30 days.
// - Files sent from the phone (up to 200 MB each), only when the disk runs
//   low (under 5 GB free: a full disk is what stops Reach), those older than
//   30 days that nothing Reach keeps (a message waiting to go, a draft) names.
//   Pictures stay: chats' histories show them from here (Codex keeps their
//   path), and each is kept once however often it's sent.
export const TIDY_EVERY_MS = 6 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const LOW_DISK = 5 * 1024 * 1024 * 1024;
const freeBytes = (dir) => {
  try {
    const stat = fs.statfsSync(dir);
    return stat.bavail * stat.bsize;
  } catch {
    return Infinity;
  }
};
const LOGS = ["tailscale.log", "claude-box-kept.jsonl", "companion.log", "companion-error.log"];

// What Reach's saved state names: an upload named there stays. The list of
// pictures a chat already has (image-repeats.json) doesn't count: a picture
// sent again is uploaded again.
function namedInState(dataDir) {
  let text = "";
  let names = [];
  try {
    names = fs.readdirSync(dataDir);
  } catch {
    return "";
  }
  for (const name of names) {
    if (!/\.jsonl?$/.test(name) || name === "image-repeats.json") continue;
    try {
      const file = path.join(dataDir, name);
      const stat = fs.statSync(file);
      if (stat.isFile() && stat.size <= 8 * 1024 * 1024) text += fs.readFileSync(file, "utf8");
    } catch {}
  }
  return text;
}

export function pruneUploads(dataDir, { days = 30, now = Date.now, free = freeBytes } = {}) {
  const removed = [];
  if (free(dataDir) >= LOW_DISK) return removed;
  const named = namedInState(dataDir);
  const old = (file) => {
    try {
      return now() - fs.statSync(file).mtimeMs > days * DAY;
    } catch {
      return false;
    }
  };
  const dir = path.join(dataDir, "agent-files");
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  // Each file is in a folder named by its id.
  for (const id of entries) {
    if (!/^[0-9a-f-]{36}$/i.test(id) || named.includes(id)) continue;
    const file = path.join(dir, id);
    if (!old(file)) continue;
    try {
      fs.rmSync(file, { recursive: true, force: true });
      removed.push(`agent-files/${id}`);
    } catch {}
  }
  return removed;
}

export async function tidyData({ dataDir, logFiles = [], logDirs = [], now = Date.now, days = 30, free } = {}) {
  const trimmed = [];
  for (const file of [...LOGS.map((name) => path.join(dataDir, name)), ...logFiles, ...logDirs.flatMap((dir) => LOGS.map((name) => path.join(dir, name)))])
    if (trimLog(file)) trimmed.push(file);
  if (trimLog(path.join(dataDir, "crash.log"), { max: 256 * 1024, keep: 64 * 1024 })) trimmed.push(path.join(dataDir, "crash.log"));
  const archives = await pruneCommandArchives(path.join(dataDir, "browser-commands"), { now }).catch(() => []);
  const uploads = pruneUploads(dataDir, { days, now, ...(free ? { free } : {}) });
  return { trimmed, archives, uploads };
}

// At start (after a minute: never in the way of starting) and every 6 hours.
export function startTidying(options, { every = TIDY_EVERY_MS, first = 60000 } = {}) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const { trimmed, archives, uploads } = await tidyData(options);
      const said = [
        trimmed.length && `${trimmed.length} log${trimmed.length === 1 ? "" : "s"} trimmed`,
        archives.length && `${archives.length} old command histor${archives.length === 1 ? "y" : "ies"} removed`,
        uploads.length && `the disk is low, so ${uploads.length} file${uploads.length === 1 ? "" : "s"} sent over 30 days ago removed`,
      ].filter(Boolean);
      if (said.length) console.log(`Reach: tidied up: ${said.join(", ")}.`);
    } catch (error) {
      console.warn(`Reach: couldn't tidy its files (${error.message}).`);
    } finally {
      running = false;
    }
  };
  const firstTimer = setTimeout(run, first);
  const timer = setInterval(run, every);
  firstTimer.unref?.();
  timer.unref?.();
  return { run, stop: () => { clearTimeout(firstTimer); clearInterval(timer); } };
}
