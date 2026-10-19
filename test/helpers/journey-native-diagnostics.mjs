import fs from "node:fs";
import path from "node:path";

const TOOLS = new Set(["apps", "file-icons", "app-open"]);
const CODES = new Set(["PENDING", "OK", "EXIT_NONZERO", "ETIMEDOUT", "ENOENT", "EACCES", "EPERM", "ENOBUFS", "ABORT_ERR", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "CHILD_FAILED"]);
const SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGBREAK"]);
const EVENTS = 24, BYTES = 8192;
export const fixedSignal = value => SIGNALS.has(value) ? value : null;
const finite = value => Number.isFinite(value) ? value : null;

// Classification reads trusted command text in memory. None of that text,
// its arguments, environment, output, or filesystem paths enter the record.
export function journeyNativeTool(file, args) {
  if (typeof file !== "string" || !Array.isArray(args)) return null;
  const name = file.replaceAll("\\", "/").split("/").at(-1).toLowerCase();
  if (/^reach-app-icons-[0-9a-f]{12}(?:-[0-9a-f]{8})?\.exe$/.test(name)) {
    if (args.length === 1 && args[0] === "apps") return "apps";
    if (args.length >= 2 && args.length <= 65 && args[0] === "types" && args.slice(1).every(value => typeof value === "string" && /^(?:folder|file|[a-z0-9]{1,16})$/.test(value))) return "file-icons";
    if (args.length === 2 && args[0] === "open" && typeof args[1] === "string" && args[1] && !args[1].includes("\0")) return "app-open";
    return null;
  }
  if (name !== "powershell.exe") return null;
  const command = args.findIndex(value => String(value).toLowerCase() === "-command");
  if (command >= 0 && args[command + 1] === "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress") return "apps";
  const encoded = args.findIndex(value => String(value).toLowerCase() === "-encodedcommand");
  if (encoded < 0 || typeof args[encoded + 1] !== "string" || args[encoded + 1].length > 32768) return null;
  const text = Buffer.from(args[encoded + 1], "base64").toString("utf16le");
  const newline = text.indexOf("\n");
  if (newline < 0 || !/^\$types = @\((?:'(?:folder|file|[a-z0-9]{1,16})'(?:,'(?:folder|file|[a-z0-9]{1,16})')*)?\)$/.test(text.slice(0, newline))) return null;
  const source = fs.readFileSync(new URL("../../scripts/native/file-icons.ps1", import.meta.url), "utf8");
  return text.slice(newline + 1) === source ? "file-icons" : null;
}

export function safeNativeCall(value) {
  if (!value || !TOOLS.has(value.tool) || !["started", "settled"].includes(value.phase) || !CODES.has(value.code)) return null;
  return { tool: value.tool, phase: value.phase, elapsedMs: finite(value.elapsedMs), code: value.code,
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
    signal: fixedSignal(value.signal), killed: value.killed === true };
}

// Keep the real custom promisifier's exact Promise and .child. Observers do
// not alter its arguments, callback, output, errors, cancellation or deadline.
export function observeJourneyNativeExec(original, record, { classify = journeyNativeTool, now = () => performance.now() } = {}) {
  const clock = () => { try { const value = now(); return Number.isFinite(value) ? value : 0; } catch { return 0; } };
  return function (file, ...args) {
    let tool;
    try { tool = classify(file, args[0]); } catch { /* Diagnostics never prevent a real call. */ }
    if (!TOOLS.has(tool)) return Reflect.apply(original, this, [file, ...args]);
    const started = clock();
    const emit = value => { try { record(safeNativeCall(value)); } catch { /* Preserve the original result. */ } };
    emit({ tool, phase: "started", elapsedMs: 0, code: "PENDING" });
    let pending;
    const settled = error => {
      try {
        const nativeCode = error?.code;
        const code = !error ? "OK" : typeof nativeCode === "number" ? "EXIT_NONZERO" : CODES.has(nativeCode) ? nativeCode : "CHILD_FAILED";
        emit({ tool, phase: "settled", elapsedMs: Math.max(0, Math.round(clock() - started)), code,
          exitCode: typeof nativeCode === "number" ? nativeCode : pending?.child?.exitCode,
          signal: error?.signal || pending?.child?.signalCode, killed: error?.killed || pending?.child?.killed });
      } catch { /* Even an unreadable diagnostic property cannot change delivery. */ }
    };
    try { pending = Reflect.apply(original, this, [file, ...args]); }
    catch (error) { settled(error); throw error; }
    // Both handlers return normally; the diagnostic branch cannot create an
    // unhandled rejection or replace the Promise returned to the real caller.
    pending.then(() => settled(null), settled);
    return pending;
  };
}

export function createNativeCallRecorder(file) {
  const events = [];
  return value => {
    const safe = safeNativeCall(value);
    if (!safe || events.length >= EVENTS) return;
    events.push(safe);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const body = JSON.stringify(events) + "\n";
      if (Buffer.byteLength(body) <= BYTES) fs.writeFileSync(file, body);
    } catch { /* Evidence is optional; the actual operation is unchanged. */ }
  };
}

// Pin one regular file before inspecting it. The extra sentinel byte caps
// memory even if it grows after fstat; path replacement cannot change the
// opened object. The caller gets no data from a changing/oversized report.
export function readBoundedDiagnosticFile(file, maxBytes = BYTES) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 16384) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const before = fs.fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) return null;
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes) return null;
    const after = fs.fstatSync(fd, { bigint: true });
    if (!after.isFile() || after.size > BigInt(maxBytes) || BigInt(length) !== after.size ||
        !["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => before[key] === after[key])) return null;
    return bytes.subarray(0, length);
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function readNativeCallReports(prefix) {
  if (!prefix) return [];
  try {
    const directory = path.dirname(prefix), name = path.basename(prefix);
    return fs.readdirSync(directory).filter(file => file.startsWith(name + "-") && /^\d+\.json$/.test(file.slice(name.length + 1))).sort().slice(0, 4).flatMap(file => {
      try {
        const bytes = readBoundedDiagnosticFile(path.join(directory, file));
        if (!bytes) return [];
        const values = JSON.parse(bytes.toString("utf8"));
        return Array.isArray(values) ? values.slice(0, EVENTS).map(safeNativeCall).filter(Boolean) : [];
      } catch { return []; }
    }).slice(0, 32);
  } catch { return []; }
}

export function safeFailureExtra(extra = {}) {
  const sample = extra.sample ? Object.fromEntries(["x", "y", "width", "height", "r", "g", "b"].map(key => [key, finite(extra.sample[key])])) : null;
  const target = extra.target ? {
    ageMs: finite(extra.target.ageMs), alive: typeof extra.target.alive === "boolean" ? extra.target.alive : null,
    exitCode: finite(extra.target.exitCode), signalCode: fixedSignal(extra.target.signalCode),
    clicks: finite(extra.target.clicks), lifetimeMs: finite(extra.target.lifetimeMs),
  } : null;
  return { sample, target };
}
