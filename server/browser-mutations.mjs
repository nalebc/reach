import fs from "node:fs";
import path from "node:path";
import { fail } from "./core.mjs";

const MAX_FILE = 1024 * 1024;
const invalid = () => fail(400, "Supported file changes are mkdir, touch, cp and rm, without flags. Shells, scripts, sudo, links, recursive operations and paths outside shared folders are blocked.");
const safeRelative = (value, empty = false) => typeof value === "string" && (empty || !!value) && value.length <= 4096 &&
  !value.startsWith("/") && !value.startsWith("~") && !value.startsWith("-") &&
  !value.split("/").some((part) => part === "..") &&
  !/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069;&|><$`()\\:*?\[\]{}]/u.test(value);
export function parseBrowserMutation(command) {
  if (typeof command !== "string" || !command.trim() || command.length > 2000 || /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069;&|><$`()\\]/u.test(command)) throw invalid();
  const words = []; let word = "", quote = "", started = false;
  for (const char of command.trim()) {
    if (quote) { if (char === quote) quote = ""; else word += char; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === " ") { if (started) { words.push(word); word = ""; started = false; } }
    else { word += char; started = true; }
  }
  if (quote) throw invalid();
  if (started) words.push(word);
  const [name, ...paths] = words;
  if (!["mkdir", "touch", "cp", "rm"].includes(name) || paths.length !== (name === "cp" ? 2 : 1) || paths.some((item) => !safeRelative(item) || path.posix.normalize(item) === ".")) throw invalid();
  return Object.freeze({ name, paths: Object.freeze(paths) });
}
const regular = (stat) => stat.isFile() && stat.nlink === 1 && stat.size <= MAX_FILE;

// Synchronous checks and operations keep concurrent agent requests from
// changing path components between validation and mutation in this process.
// Commands cannot create links or rename/delete directories. No command is
// passed to a shell, subprocess, interpreter or project executable.
export function validateBrowserMutation(action, authorize, { resolve } = {}) {
  if (process.platform === "win32") throw fail(403, "Approved file changes are not supported on Windows.");
  if (action?.type !== "terminal-change" || !Number.isSafeInteger(action.root) || action.root < 0 || !safeRelative(action.cwd ?? "", true) || typeof authorize !== "function" || typeof resolve !== "function") throw invalid();
  const spec = parseBrowserMutation(action.command);
  const client = authorize();
  if (client?.kind !== "agent" || !client.policy?.browser || client.policy.terminalApproval !== true || !client.agentRoots?.[action.root]) throw fail(403, "This invitation does not allow approved file changes.");
  const base = path.resolve(client.agentRoots[action.root]);
  const baseStat = fs.lstatSync(base);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw fail(403, "Symbolic links are not allowed in command paths.");
  if (resolve(action.root, "", client) !== base) throw fail(403, "The shared folder changed.");
  const inspect = (relative, allowMissing = false) => {
    const full = path.join(base, relative);
    const components = relative.split("/").filter((part) => part && part !== ".");
    let current = base, stat = baseStat;
    for (const [index, part] of components.entries()) {
      current = path.join(current, part);
      try { stat = fs.lstatSync(current); }
      catch (error) {
        if (allowMissing && index === components.length - 1 && error.code === "ENOENT") {
          // The host must authorize this exact new leaf too: checking only
          // its parent could miss a configured private path not yet created.
          if (resolve(action.root, relative, client, { allowMissing: true }) !== full) throw fail(403, "The destination is not shared.");
          return { full, stat: null };
        }
        throw error;
      }
      if (stat.isSymbolicLink()) throw fail(403, "Symbolic links are not allowed in command paths.");
      if (index < components.length - 1 && !stat.isDirectory()) throw fail(400, "Choose an existing working folder.");
    }
    // The resolver also enforces private-data exclusions.
    if (resolve(action.root, relative, client) !== full) throw fail(403, "The command path changed.");
    return { full, stat };
  };
  const cwd = path.posix.normalize(action.cwd || ".");
  if (!inspect(cwd).stat.isDirectory()) throw fail(400, "Choose an existing working folder.");
  const targets = spec.paths.map((item, index) => {
    const relative = path.posix.normalize(path.posix.join(cwd, item));
    const parent = path.posix.dirname(relative);
    if (!inspect(parent).stat.isDirectory()) throw fail(400, "Choose an existing destination folder.");
    const mustExist = spec.name === "rm" || (spec.name === "cp" && index === 0);
    const target = inspect(relative, !mustExist);
    if (target.stat && !regular(target.stat)) throw fail(400, "Choose a regular file no larger than 1 MiB with no extra hard links.");
    if ((spec.name === "mkdir" || (spec.name === "cp" && index === 1)) && target.stat) throw fail(409, "The destination already exists. Choose a new name.");
    return { ...target, relative };
  });
  return { spec, targets, client, base };
}

export async function runBrowserMutation(action, authorize, { resolve } = {}) {
  const plan = validateBrowserMutation(action, authorize, { resolve });
  const recheck = () => {
    const next = validateBrowserMutation(action, authorize, { resolve });
    if (next.base !== plan.base || next.targets.some((target, i) => target.full !== plan.targets[i].full || target.stat?.ino !== plan.targets[i].stat?.ino || target.stat?.dev !== plan.targets[i].stat?.dev)) throw fail(409, "A command path changed. Request approval again.");
    return next;
  };
  const target = plan.targets[0];
  if (plan.spec.name === "mkdir") {
    recheck(); fs.mkdirSync(target.full, { mode: 0o700 });
    return `Created folder ${target.relative}`;
  }
  if (plan.spec.name === "touch") {
    recheck();
    const fd = fs.openSync(target.full, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | (target.stat ? 0 : fs.constants.O_CREAT | fs.constants.O_EXCL), 0o600);
    try {
      const stat = fs.fstatSync(fd);
      if (!regular(stat) || (target.stat && (stat.ino !== target.stat.ino || stat.dev !== target.stat.dev))) throw fail(409, "The file changed. Request approval again.");
      authorize(); const at = new Date(); fs.futimesSync(fd, at, at); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    return `Touched file ${target.relative}`;
  }
  if (plan.spec.name === "rm") {
    recheck(); fs.unlinkSync(target.full);
    return `Removed file ${target.relative}`;
  }
  const source = fs.openSync(target.full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(source);
    if (!regular(stat) || stat.ino !== target.stat.ino || stat.dev !== target.stat.dev) throw fail(409, "The source changed. Request approval again.");
    const content = Buffer.alloc(MAX_FILE + 1);
    let size = 0;
    while (size < content.length) { authorize(); const read = fs.readSync(source, content, size, content.length - size, size); if (!read) break; size += read; }
    if (size > MAX_FILE) throw fail(400, "Copy a regular file no larger than 1 MiB.");
    recheck();
    const destination = fs.openSync(plan.targets[1].full, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(destination, content.subarray(0, size)); fs.fsyncSync(destination); }
    finally { fs.closeSync(destination); }
    return `Copied ${target.relative} to ${plan.targets[1].relative}`;
  } finally { fs.closeSync(source); }
}
