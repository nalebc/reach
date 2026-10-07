import fs from "node:fs";
import path from "node:path";

// Reach's own files stay small for as long as it runs on a Mac: logs keep
// their latest part, and only the newest build of each native helper stays
// (each edit of a helper's source built a new copy, never removed: 36 here).
export function trimLog(file, { max = 1024 * 1024, keep = 256 * 1024 } = {}) {
  try {
    const { size } = fs.statSync(file);
    if (size <= max) return false;
    const fd = fs.openSync(file, "r");
    const tail = Buffer.alloc(keep);
    fs.readSync(fd, tail, 0, keep, size - keep);
    fs.closeSync(fd);
    // From the first whole line on.
    const start = tail.indexOf(10) + 1;
    fs.writeFileSync(file, Buffer.concat([Buffer.from("… (earlier lines removed)\n"), tail.subarray(start)]), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// reach-<kind>-<12 hex>: the newest of each kind is the one in use.
export function pruneHelpers(dir) {
  const removed = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  const kinds = new Map();
  for (const name of names) {
    const match = /^(reach-[a-z0-9-]+?)-[0-9a-f]{12}$/.exec(name);
    if (!match) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
    } catch {
      continue;
    }
    const list = kinds.get(match[1]) || [];
    list.push({ name, mtimeMs });
    kinds.set(match[1], list);
  }
  for (const list of kinds.values()) {
    list.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { name } of list.slice(1)) {
      try {
        fs.rmSync(path.join(dir, name), { force: true });
        removed.push(name);
      } catch {}
    }
  }
  // Temporary files of builds that never finished.
  for (const name of names)
    if (/^reach-.+\.tmp$/.test(name))
      try {
        const file = path.join(dir, name);
        if (Date.now() - fs.statSync(file).mtimeMs > 10 * 60 * 1000) fs.rmSync(file, { force: true });
      } catch {}
  return removed;
}

export function housekeeping(state, { logDirs = [] } = {}) {
  for (const file of [path.join(state, "setup.log"), path.join(state, "quick", "tailscale.log")]) trimLog(file);
  for (const dir of logDirs) for (const name of ["companion.log", "companion-error.log"]) trimLog(path.join(dir, name));
  return pruneHelpers(path.join(state, "quick"));
}
