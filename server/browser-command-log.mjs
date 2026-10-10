import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fail } from "./core.mjs";

const ACTIVE = new Set(["pending", "executing"]);
const STATUSES = new Set(["pending", "executing", "executed", "denied", "cancelled", "failed", "expired", "revoked", "interrupted", "blocked"]);
const RESERVED_BYTES = 192 * 1024; // Worst bounded final record, including JSON escaping.
const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const short = (value, size, label) => {
  if (typeof value !== "string" || value.length > size) throw fail(400, `Invalid command history ${label}.`);
  return value;
};
const id = (value, label) => { const valueString = short(value, 160, label); if (!valueString || !/^[A-Za-z0-9_:-]+$/.test(valueString)) throw fail(400, `Invalid command history ${label}.`); return valueString; };
const outputText = (value) => {
  let text = stripVTControlCharacters(String(value)).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
  if (Buffer.byteLength(text) > 65536) {
    while (Buffer.byteLength(text) > 65000) text = text.slice(0, Math.max(0, text.length - 1024));
    text += "\n[Output truncated]";
  }
  return text;
};
function normalize(input, previous, now) {
  if (!plain(input)) throw fail(400, "Invalid command history record.");
  const record = previous ? { ...previous, action: { ...previous.action } } : {};
  record.id = id(input.id, "ID");
  if (input.clientId !== undefined || !previous) record.clientId = id(input.clientId, "client ID");
  if (input.action !== undefined || !previous) {
    const action = input.action;
    if (!plain(action) || !["terminal", "terminal-change", "terminal-script", "shell"].includes(action.type) || !Number.isSafeInteger(action.root) || action.root < 0) throw fail(400, "Invalid command history action.");
    record.action = { type: action.type, command: short(action.command, 4000, "command"), root: action.root, ...(action.cwd !== undefined ? { cwd: short(action.cwd, 4096, "working directory") } : {}) };
  }
  for (const [key, max] of [["name", 80], ["reason", 1000], ["folder", 4096], ["directory", 4096], ["error", 1000]])
    if (input[key] !== undefined) record[key] = short(input[key], max, key);
  for (const key of ["createdAt", "expiresAt", "completedAt"])
    if (input[key] !== undefined) { if (!Number.isFinite(input[key]) || input[key] < 0) throw fail(400, `Invalid command history ${key}.`); record[key] = input[key]; }
  if (!record.createdAt) record.createdAt = now;
  if (input.output !== undefined) record.output = outputText(input.output);
  if (input.exitCode !== undefined) { if (input.exitCode !== null && !Number.isInteger(input.exitCode)) throw fail(400, "Invalid command exit code."); record.exitCode = input.exitCode; }
  if (input.approval !== undefined) { if (!["automatic", "owner", "session"].includes(input.approval)) throw fail(400, "Invalid command approval mode."); record.approval = input.approval; }
  if (!STATUSES.has(input.status)) throw fail(400, "Invalid command history status.");
  record.status = input.status;
  if (previous) {
    for (const key of ["clientId", "action", "createdAt", "expiresAt", "name", "reason", "approval"])
      if (previous[key] !== undefined && JSON.stringify(previous[key]) !== JSON.stringify(record[key])) throw fail(409, "An existing command history record cannot change its approved command or identity.");
    if (previous.folder !== undefined && record.folder !== previous.folder) throw fail(409, "An existing command's original folder cannot change.");
    if (!ACTIVE.has(previous.status) && ACTIVE.has(record.status)) throw fail(409, "A completed command cannot be restarted through history.");
    if (previous.status === "executing" && record.status === "pending") throw fail(409, "An executing command cannot return to pending.");
  }
  record.updatedAt = now;
  return record;
}

const LOG = "commands.jsonl";
const ARCHIVE = /^commands-[\w-]+\.jsonl$/;
const OPEN = constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | (constants.O_NOFOLLOW || 0);

/** Earlier histories (commands-<when>.jsonl, set aside when the log filled or
 * couldn't be read): the newest `keep` stay, none older than `days`. */
export async function pruneCommandArchives(dir, { keep = 5, days = 30, now = Date.now } = {}) {
  let names = [];
  try { names = (await fs.readdir(dir)).filter((name) => ARCHIVE.test(name)); } catch { return []; }
  const listed = [];
  for (const name of names) {
    try { const stat = await fs.lstat(path.join(dir, name)); if (stat.isFile()) listed.push({ name, at: stat.mtimeMs }); } catch { /* gone */ }
  }
  listed.sort((a, b) => b.at - a.at);
  const removed = listed.filter(({ at }, i) => i >= keep || now() - at > days * 86400000).map(({ name }) => name);
  for (const name of removed) await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
  return removed;
}

/** Durable, credential-free metadata; callers must await append before doing work.
 * Never full for good (reliability audit, Oct 10): a full log is set aside as
 * commands-<when>.jsonl (the newest five kept, 30 days) and a new one starts
 * with the commands still running. A crash mid-write leaves part of a line:
 * that command never began, so the line is cut back. A write that failed (a
 * full disk) blocks commands until the next one can be written. A log changed
 * outside Reach, a link or loose permissions still block them. */
export async function createBrowserCommandLog({ dir, maxBytes = 8 * 1024 * 1024, maxEntries = 5000, now = Date.now, keepArchives = 5, archiveDays = 30,
  // Tests: a write that fails (a full disk) throws here.
  beforeWrite = () => {} } = {}) {
  if (typeof dir !== "string" || !path.isAbsolute(dir) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) throw fail(500, "Invalid command history configuration.");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const folder = await fs.lstat(dir);
  const owned = (stat) => process.platform === "win32" || stat.uid === process.getuid();
  const privateMode = (stat) => process.platform === "win32" || !(stat.mode & 0o077);
  if (!folder.isDirectory() || folder.isSymbolicLink() || !owned(folder) || !privateMode(folder)) throw fail(500, "Command history requires a private owned directory.");
  const file = path.join(dir, LOG);
  let handle = await fs.open(file, OPEN, 0o600);
  let size = 0, entries = 0, closed = false;
  // Why commands are blocked: "write" (a write failed; the next append cuts
  // back what it left and goes on) or "outside" (changed outside Reach; stays).
  let poisoned = null;
  let records = new Map();
  let tail = Promise.resolve();
  const serialize = (operation) => { const next = tail.then(operation); tail = next.catch(() => {}); return next; };
  const verifyFile = async () => {
    const [opened, current, directory] = await Promise.all([handle.stat(), fs.lstat(file), fs.lstat(dir)]);
    if (!opened.isFile() || opened.nlink !== 1 || !current.isFile() || current.isSymbolicLink() || opened.ino !== current.ino || opened.dev !== current.dev || !owned(opened) || !privateMode(opened) || !directory.isDirectory() || directory.isSymbolicLink() || directory.ino !== folder.ino || directory.dev !== folder.dev || !owned(directory) || !privateMode(directory)) throw fail(500, "Command history is no longer a private owned file.");
    return opened;
  };
  const syncDir = async () => {
    if (process.platform === "win32") return;
    const directoryHandle = await fs.open(dir, constants.O_RDONLY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
  };
  // The log becomes commands-<when><why>.jsonl and an empty one takes its place.
  const archive = async (why = "") => {
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
    let target = path.join(dir, `commands-${stamp}${why}.jsonl`);
    for (let n = 2; await fs.lstat(target).then(() => true, () => false); n++) target = path.join(dir, `commands-${stamp}${why}-${n}.jsonl`);
    await fs.rename(file, target);
    let next;
    try { next = await fs.open(file, OPEN | constants.O_EXCL, 0o600); }
    catch (error) { await fs.rename(target, file).catch(() => {}); throw error; }
    const previous = handle;
    handle = next;
    await previous.close().catch(() => {});
    size = 0; entries = 0;
    await syncDir().catch(() => {});
    await pruneCommandArchives(dir, { keep: keepArchives, days: archiveDays, now });
    return target;
  };
  const write = async (line) => {
    try { await beforeWrite(file); await handle.writeFile(line, "utf8"); await handle.sync(); } catch (error) { poisoned = "write"; throw error; }
    size += Buffer.byteLength(line); entries++;
  };
  // Full: set aside, the commands still running carried into the new one.
  const rotate = async () => {
    const running = [...records.values()].filter((record) => ACTIVE.has(record.status));
    await archive();
    records = new Map();
    for (const record of running) { await write(JSON.stringify(record) + "\n"); records.set(record.id, record); }
  };
  // After a failed write: what it left is cut back to what Reach knows it wrote.
  const heal = async () => {
    try {
      const stat = await verifyFile();
      if (stat.size < size) { poisoned = "outside"; return; }
      if (stat.size > size) { await handle.truncate(size); await handle.sync(); }
      poisoned = null;
    } catch { /* still can't: commands stay blocked */ }
  };
  const appendInternal = async (input) => {
    if (closed) throw fail(503, "Command history is unavailable; execution is blocked.");
    if (poisoned === "write") await heal();
    if (poisoned) throw fail(503, "Command history is unavailable; execution is blocked.");
    const previous = records.get(input?.id);
    const record = normalize(input, previous, now());
    const semantic = (value) => { const copy = { ...value }; delete copy.updatedAt; return JSON.stringify(copy); };
    if (previous && semantic(previous) === semantic(record)) return JSON.parse(JSON.stringify(previous));
    const line = JSON.stringify(record) + "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > RESERVED_BYTES) throw fail(413, "This command history record is too large.");
    // Every command still running keeps room for its final outcome.
    let active = 0, runningBytes = 0, running = 0;
    for (const [key, value] of records) {
      if (!ACTIVE.has(value.status)) continue;
      running++;
      runningBytes += Buffer.byteLength(JSON.stringify(value)) + 1;
      if (key !== record.id) active++;
    }
    if (ACTIVE.has(record.status)) active++;
    const fits = (used, lines) => used + bytes + active * RESERVED_BYTES <= maxBytes && lines + 1 + active <= maxEntries;
    // Checked before anything else, a full log's setting aside included: a
    // change from outside must never be filed away unnoticed.
    const unchanged = async () => {
      let stat;
      try { stat = await verifyFile(); } catch (error) { poisoned = "outside"; throw error; }
      if (stat.size !== size) { poisoned = "outside"; throw fail(500, "Command history changed outside Reach; execution is blocked."); }
    };
    await unchanged();
    if (!fits(size, entries)) {
      // Setting the log aside helps only when it holds finished commands.
      if (!fits(runningBytes, running)) throw fail(507, "Too many agent commands are waiting or running at once. New ones can start when one finishes.");
      await rotate();
      await unchanged();
    }
    await write(line);
    records.set(record.id, record);
    return JSON.parse(JSON.stringify(record));
  };
  try {
    const stat = await verifyFile();
    // Far past its limit (written by something else): kept aside unread.
    if (stat.size > maxBytes * 4) await archive("-oversized");
    else {
      let raw = await handle.readFile();
      // Reach stopped mid-write: the unfinished line's command never began.
      if (raw.length && raw[raw.length - 1] !== 10) {
        const cut = raw.lastIndexOf(10) + 1;
        await handle.truncate(cut);
        await handle.sync();
        raw = raw.subarray(0, cut);
        console.warn("Reach: the agent command history ended in an unfinished line (Reach stopped mid-write); it was cut back.");
      }
      size = raw.length;
      try {
        for (const line of raw.toString("utf8").split("\n").filter(Boolean)) {
          entries++;
          const input = JSON.parse(line);
          const record = normalize(input, records.get(input.id), input.updatedAt ?? input.createdAt ?? now());
          records.set(record.id, record);
        }
      } catch {
        // Unreadable: kept aside as it is, and a new history starts (nothing
        // in it runs again: commands left running there never resume).
        records = new Map();
        const kept = await archive("-unreadable");
        console.warn(`Reach: the agent command history couldn't be read; it's kept as ${path.basename(kept)} and a new one started.`);
      }
    }
    // Persist recovery too. The reserved final slot makes a crash recoverable.
    for (const record of [...records.values()]) if (ACTIVE.has(record.status))
      await appendInternal({ ...record, status: "interrupted", error: "Reach restarted before this command was confirmed complete.", completedAt: now() });
    // Persist creation of the log's directory entry before allowing commands.
    await syncDir();
  } catch (error) { await handle.close(); throw error; }
  return {
    append: (record) => serialize(() => appendInternal(record)),
    history: ({ clientId, limit = 100 } = {}) => serialize(async () => {
      if (closed || poisoned === "outside") throw fail(503, "Command history is unavailable.");
      if (clientId !== undefined) id(clientId, "client ID");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail(400, "Choose 1 to 1,000 history entries.");
      await verifyFile();
      return [...records.values()].filter((record) => clientId === undefined || record.clientId === clientId)
        .sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt).slice(0, limit).map((record) => JSON.parse(JSON.stringify(record)));
    }),
    close: () => serialize(async () => { if (!closed) { closed = true; await handle.close(); } }),
  };
}
