// Files in a chat's folder for "@" in its composer, as both apps offer:
// Codex's own fuzzyFileSearch for Codex; for Claude Code, the folder's files
// as git lists them (tracked and new, ignored ones left out), or a short walk
// outside a repository. Paths are the folder's own, relative to it.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const SKIP = new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "__pycache__", ".cache", "Pods", "DerivedData"]);

// How well a path matches what's typed: its letters in order, the file's
// own name and a matching start counting most; null when it doesn't.
export function fuzzyScore(file, query) {
  const q = String(query || "").toLowerCase();
  if (!q) return 1;
  const p = file.toLowerCase();
  const base = path.basename(p);
  if (base.startsWith(q)) return 1000 - base.length;
  if (base.includes(q)) return 800 - base.length;
  if (p.includes(q)) return 600 - p.length;
  let at = 0;
  for (const c of q) {
    at = p.indexOf(c, at);
    if (at < 0) return null;
    at++;
  }
  return 300 - p.length;
}

async function walk(root, limit = 20000) {
  const out = [];
  const queue = [""];
  while (queue.length && out.length < limit) {
    const dir = queue.shift();
    let entries = [];
    try {
      entries = await fs.readdir(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name) && rel.split("/").length < 8) queue.push(rel);
      } else if (e.isFile()) out.push(rel);
    }
  }
  return out;
}

export function createFileSearch({ run = exec, now = Date.now, keepMs = 30000 } = {}) {
  const lists = new Map(); // folder -> { at, files }
  async function filesIn(cwd) {
    const kept = lists.get(cwd);
    if (kept && now() - kept.at < keepMs) return kept.files;
    let files;
    try {
      const { stdout } = await run("git", ["-C", cwd, "ls-files", "-co", "--exclude-standard"], { timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
      files = String(stdout).split("\n").filter(Boolean);
    } catch {
      files = await walk(cwd);
    }
    lists.set(cwd, { at: now(), files });
    if (lists.size > 20) lists.delete(lists.keys().next().value);
    return files;
  }
  return {
    // [{ path, name }] best first, for a folder the chat runs in.
    async search(cwd, query, { limit = 30 } = {}) {
      if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return [];
      const scored = [];
      for (const file of await filesIn(cwd)) {
        const score = fuzzyScore(file, query);
        if (score !== null) scored.push([score, file]);
      }
      return scored
        .sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]))
        .slice(0, limit)
        .map(([, file]) => ({ path: file, name: path.basename(file) }));
    },
  };
}
