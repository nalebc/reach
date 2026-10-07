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

/** Durable, credential-free metadata; callers must await append before doing work. */
export async function createBrowserCommandLog({ dir, maxBytes = 8 * 1024 * 1024, maxEntries = 5000, now = Date.now } = {}) {
  if (typeof dir !== "string" || !path.isAbsolute(dir) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxEntries) || maxEntries < 1) throw fail(500, "Invalid command history configuration.");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const folder = await fs.lstat(dir);
  const owned = (stat) => process.platform === "win32" || stat.uid === process.getuid();
  const privateMode = (stat) => process.platform === "win32" || !(stat.mode & 0o077);
  if (!folder.isDirectory() || folder.isSymbolicLink() || !owned(folder) || !privateMode(folder)) throw fail(500, "Command history requires a private owned directory.");
  const file = path.join(dir, "commands.jsonl");
  const handle = await fs.open(file, constants.O_CREAT | constants.O_APPEND | constants.O_RDWR | (constants.O_NOFOLLOW || 0), 0o600);
  let size = 0, entries = 0, closed = false, poisoned = false;
  const records = new Map();
  let tail = Promise.resolve();
  const serialize = (operation) => { const next = tail.then(operation); tail = next.catch(() => {}); return next; };
  const verifyFile = async () => {
    const [opened, current, directory] = await Promise.all([handle.stat(), fs.lstat(file), fs.lstat(dir)]);
    if (!opened.isFile() || opened.nlink !== 1 || !current.isFile() || current.isSymbolicLink() || opened.ino !== current.ino || opened.dev !== current.dev || !owned(opened) || !privateMode(opened) || !directory.isDirectory() || directory.isSymbolicLink() || directory.ino !== folder.ino || directory.dev !== folder.dev || !owned(directory) || !privateMode(directory)) throw fail(500, "Command history is no longer a private owned file.");
    return opened;
  };
  const appendInternal = async (input) => {
    if (closed || poisoned) throw fail(503, "Command history is unavailable; execution is blocked.");
    const previous = records.get(input?.id);
    const record = normalize(input, previous, now());
    const semantic = (value) => { const copy = { ...value }; delete copy.updatedAt; return JSON.stringify(copy); };
    if (previous && semantic(previous) === semantic(record)) return JSON.parse(JSON.stringify(previous));
    const line = JSON.stringify(record) + "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > RESERVED_BYTES) throw fail(413, "This command history record is too large.");
    let active = 0;
    for (const [key, value] of records) if (key !== record.id && ACTIVE.has(value.status)) active++;
    if (ACTIVE.has(record.status)) active++;
    if (size + bytes + active * RESERVED_BYTES > maxBytes || entries + 1 + active > maxEntries) throw fail(507, "Command history is full. New commands are blocked; keep or archive the private history before continuing.");
    try {
      const stat = await verifyFile();
      if (stat.size !== size) throw fail(500, "Command history changed outside Reach; execution is blocked.");
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } catch (error) { poisoned = true; throw error; }
    size += bytes; entries++;
    records.set(record.id, record);
    return JSON.parse(JSON.stringify(record));
  };
  try {
    const stat = await verifyFile();
    if (stat.size > maxBytes) throw fail(507, "Command history exceeds its configured limit.");
    const text = await handle.readFile("utf8");
    size = Buffer.byteLength(text);
    if (text && !text.endsWith("\n")) throw fail(500, "Command history contains an incomplete record; execution is blocked.");
    for (const line of text.split("\n").filter(Boolean)) {
      if (++entries > maxEntries) throw fail(507, "Command history exceeds its configured entry limit.");
      const input = JSON.parse(line);
      const record = normalize(input, records.get(input.id), input.updatedAt ?? input.createdAt ?? now());
      records.set(record.id, record);
    }
    // Persist recovery too. The reserved final slot makes a crash recoverable.
    for (const record of [...records.values()]) if (ACTIVE.has(record.status))
      await appendInternal({ ...record, status: "interrupted", error: "Reach restarted before this command was confirmed complete.", completedAt: now() });
    // Persist creation of the log's directory entry before allowing commands.
    if (process.platform !== "win32") { const directoryHandle = await fs.open(dir, constants.O_RDONLY); try { await directoryHandle.sync(); } finally { await directoryHandle.close(); } }
  } catch (error) { await handle.close(); throw error; }
  return {
    append: (record) => serialize(() => appendInternal(record)),
    history: ({ clientId, limit = 100 } = {}) => serialize(async () => {
      if (closed || poisoned) throw fail(503, "Command history is unavailable.");
      if (clientId !== undefined) id(clientId, "client ID");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw fail(400, "Choose 1 to 1,000 history entries.");
      await verifyFile();
      return [...records.values()].filter((record) => clientId === undefined || record.clientId === clientId)
        .sort((a, b) => b.createdAt - a.createdAt || b.updatedAt - a.updatedAt).slice(0, limit).map((record) => JSON.parse(JSON.stringify(record)));
    }),
    close: () => serialize(async () => { if (!closed) { closed = true; await handle.close(); } }),
  };
}
