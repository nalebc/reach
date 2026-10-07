import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const exec = promisify(execFile);

// Reach's small Mac helpers are compiled on this Mac the first time they're
// needed. Three things every build shares:
// - Apple's developer tools are looked for first, with `xcode-select -p`,
//   which never asks anything: running xcrun without them made macOS pop
//   up "install developer tools" the instant Reach started.
// - One build per output file at a time, across every module that asks
//   (two compilers once wrote the same file at once).
// - Older builds of the same helper are removed once a new one is in place.

let tools = null; // { at, ok }
export async function developerTools({ run = exec, now = Date.now } = {}) {
  if (process.platform !== "darwin") return false;
  if (tools?.ok || (tools && now() - tools.at < 60000)) return tools.ok;
  let ok = false;
  try {
    const { stdout } = await run("/usr/bin/xcode-select", ["-p"], { timeout: 5000 });
    ok = !!stdout.trim() && existsSync(stdout.trim());
  } catch {
    ok = false;
  }
  tools = { at: now(), ok };
  return ok;
}
export const resetDeveloperTools = () => {
  tools = null;
};

const building = new Map(); // output file -> promise
// Builds `file` with `/usr/bin/xcrun <args… -o tmp>` unless it's there. The
// temporary file is this build's own; the result appears whole or not at all.
export function buildNative(file, args, { timeout = 120000, signal, missing, run = exec, prune = true } = {}) {
  if (existsSync(file)) return Promise.resolve(file);
  let build = building.get(file);
  if (!build) {
    build = (async () => {
      if (!(await developerTools({ run }))) {
        throw Object.assign(
          new Error(missing || "This needs Apple Command Line Tools. Run xcode-select --install on your Mac."),
          { status: 503, developerTools: false },
        );
      }
      const tmp = `${file}-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
      try {
        await run("/usr/bin/xcrun", [...args, "-o", tmp], { timeout, maxBuffer: 1024 * 1024, ...(signal ? { signal } : {}) });
        await fs.chmod(tmp, 0o700);
        await fs.rename(tmp, file);
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
      if (prune) await pruneOlder(file);
      return file;
    })().finally(() => {
      if (building.get(file) === build) building.delete(file);
    });
    building.set(file, build);
  }
  return build;
}

// reach-<kind>-<hash>: the builds of one helper differ only in their hash.
// Deleting a binary a process still runs is safe on macOS.
export async function pruneOlder(file) {
  const dir = path.dirname(file);
  const match = /^(reach-[a-z0-9-]+?)-([0-9a-f]{12})$/.exec(path.basename(file));
  if (!match) return;
  const [, kind] = match;
  const names = await fs.readdir(dir).catch(() => []);
  await Promise.all(
    names
      .filter((name) => name !== path.basename(file) && new RegExp(`^${kind}-[0-9a-f]{12}$`).test(name))
      .map((name) => fs.rm(path.join(dir, name), { force: true }).catch(() => {})),
  );
}
