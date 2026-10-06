import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fail } from "./core.mjs";

export const TERMINAL_COMMANDS = ["pwd", "cd", "ls", "cat", "head", "tail", "wc", "grep"];
const MAX_FILE = 1024 * 1024;
const MAX_OUTPUT = 64000;
const invalid = () => fail(400, "Use pwd, cd, ls, cat, head, tail, wc, or grep. Shell syntax, scripts, sudo, and file changes are not allowed.");

// This is a small read-only command language, not a shell or PTY. Never pass
// these strings to exec/spawn, a terminal, an interpreter, or a project script.
export function parseTerminalCommand(command) {
  if (typeof command !== "string" || !command.trim() || command.length > 2000 ||
      /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069;&|><$`()\\]/u.test(command)) throw invalid();
  const words = [];
  let word = "", quote = "", started = false;
  for (const c of command.trim()) {
    if (quote) {
      if (c === quote) quote = "";
      else word += c;
    } else if (c === '"' || c === "'") { quote = c; started = true; }
    else if (c === " ") {
      if (started) { words.push(word); word = ""; started = false; }
    } else { word += c; started = true; }
  }
  if (quote) throw invalid();
  if (started) words.push(word);
  const [name, ...args] = words;
  if (!TERMINAL_COMMANDS.includes(name)) throw invalid();
  let target = ".", count = 10, mode = "", pattern = "";
  if (name === "pwd") {
    if (args.length) throw invalid();
  } else if (name === "ls" || name === "cd") {
    if (args.length > 1) throw invalid();
    target = args[0] ?? ".";
  } else if (name === "head" || name === "tail") {
    if (args[0] === "-n") {
      if (!/^[1-9][0-9]{0,3}$/.test(args[1] || "") || Number(args[1]) > 1000) throw invalid();
      count = Number(args[1]); args.splice(0, 2);
    }
    if (args.length !== 1) throw invalid();
    target = args[0];
  } else if (name === "wc") {
    if (["-l", "-w", "-c"].includes(args[0])) mode = args.shift();
    if (args.length !== 1) throw invalid();
    target = args[0];
  } else if (name === "grep") {
    if (args.length !== 2 || !args[0] || args[0].startsWith("-")) throw invalid();
    [pattern, target] = args;
  } else {
    if (args.length !== 1) throw invalid();
    target = args[0];
  }
  if (!target || target.startsWith("-") || target.startsWith("/") || target.startsWith("~") ||
      (name !== "cd" && target.split("/").includes("..")) || /[*?\[\]{}:]/.test(target)) throw invalid();
  return Object.freeze({ name, target, count, mode, pattern });
}

// Every approved action carries its own working directory. Another cd cannot
// change the meaning of an action that is already waiting for approval.
export function terminalLocation(action) {
  const spec = parseTerminalCommand(action.command);
  const cwd = action.cwd === undefined ? "" : action.cwd;
  if (typeof cwd !== "string" || cwd.length > 4096 ||
      /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\\:]/u.test(cwd) ||
      path.posix.isAbsolute(cwd) || cwd.split("/").includes("..")) throw invalid();
  const relative = path.posix.normalize(path.posix.join(cwd, spec.target));
  if (relative === ".." || relative.startsWith("../"))
    throw fail(403, "Stay inside the selected shared folder.");
  return { spec, cwd, relative };
}

// `resolve` applies Reach's shared-folder and private-data rules on every use.
// Bounds avoid unbounded files, directory output, device nodes and named pipes.
export async function runTerminalCommand(action, authorize, resolve) {
  const { spec, cwd, relative } = terminalLocation(action);
  const check = () => {
    const client = authorize();
    if (client?.policy?.restrictedTerminal !== true || !Number.isSafeInteger(action.root) ||
        action.root < 0 || !client.agentRoots?.[action.root])
      throw fail(403, "This session does not have restricted terminal access to that folder.");
    return client;
  };
  const target = () => {
    const client = check();
    resolve(action.root, cwd, client);
    return resolve(action.root, relative, client);
  };
  const full = target();
  let output = "";
  if (spec.name === "pwd" || spec.name === "cd") {
    if (!(await fs.stat(full)).isDirectory()) throw fail(400, "Choose a folder, not a file.");
    output = full;
  }
  else if (spec.name === "ls") {
    const directory = await fs.opendir(full);
    const names = [];
    try {
      for await (const entry of directory) {
        target();
        if (names.length >= 1000) { names.push("[Listing limited to 1,000 entries]"); break; }
        names.push(entry.name + (entry.isDirectory() ? "/" : entry.isSymbolicLink() ? " [link]" : ""));
      }
    } finally { await directory.close().catch(() => {}); }
    output = names.sort().join("\n");
  } else {
    const expected = await fs.stat(full);
    if (!expected.isFile() || expected.nlink !== 1 || expected.size > MAX_FILE)
      throw fail(400, "Read a regular file no larger than 1 MiB without extra hard links.");
    target();
    const file = await fs.open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const actual = await file.stat();
      if (!actual.isFile() || actual.nlink !== 1 || actual.size > MAX_FILE || actual.ino !== expected.ino || actual.dev !== expected.dev)
        throw fail(409, "The file changed. Request it again.");
      target();
      const buffer = Buffer.alloc(MAX_FILE + 1);
      let length = 0;
      while (length < buffer.length) {
        check();
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_FILE) throw fail(400, "Read a regular file no larger than 1 MiB without extra hard links.");
      const text = buffer.subarray(0, length).toString("utf8");
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      if (spec.name === "head") output = lines.slice(0, spec.count).join("\n");
      else if (spec.name === "tail") output = lines.slice(-spec.count).join("\n");
      else if (spec.name === "grep") output = lines.flatMap((line, i) => line.includes(spec.pattern) ? [`${i + 1}:${line}`] : []).join("\n");
      else if (spec.name === "wc") {
        const counts = { "-l": (text.match(/\n/g) || []).length, "-w": text.trim() ? text.trim().split(/\s+/).length : 0, "-c": length };
        output = `${spec.mode ? counts[spec.mode] : Object.values(counts).join(" ")} ${spec.target}`;
      } else output = text;
    } finally { await file.close(); }
  }
  target();
  // Never emit terminal escape sequences or visual text-reordering controls.
  output = output.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return output.length > MAX_OUTPUT ? output.slice(0, MAX_OUTPUT) + "\n[Output truncated]" : output;
}
