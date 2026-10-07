import fs from "node:fs";
import path from "node:path";
import { fail } from "./core.mjs";
import { browserFileOperation } from "./browser-file-boundary.mjs";
import { browserOperationCoordinator } from "./browser-operation-coordinator.mjs";

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

// Validation provides the owner review and private-data exclusions. Execution
// uses descriptor-relative native I/O: repeated pathname checks alone cannot
// prevent another process from swapping parent directories for symbolic links.
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

export async function runBrowserMutation(action, authorize, { resolve, coordinator = browserOperationCoordinator, ...options } = {}) {
  const queued = validateBrowserMutation(action, authorize, { resolve });
  return await coordinator.run({ clientId: queued.client.id, root: queued.base, kind: 'file-change', authorize }, async ({ authorize: current }) => {
    // Another writer may have changed the target while this request waited.
    const plan = validateBrowserMutation(action, current, { resolve });
    if (plan.base !== queued.base) throw fail(409, "The shared folder changed. Request approval again.");
    await browserFileOperation({ op: plan.spec.name, root: plan.base, path: plan.targets[0].relative,
      ...(plan.targets[1] ? { to: plan.targets[1].relative } : {}), maxBytes: MAX_FILE,
      privatePaths: options.privatePaths || [] }, current, options);
    const target = plan.targets[0];
    return plan.spec.name === "mkdir" ? `Created folder ${target.relative}`
      : plan.spec.name === "touch" ? `Touched file ${target.relative}`
      : plan.spec.name === "rm" ? `Removed file ${target.relative}`
      : `Copied ${target.relative} to ${plan.targets[1].relative}`;
  });
}
