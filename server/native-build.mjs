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
export async function developerTools({ run = exec, now = Date.now, signal } = {}) {
  signal?.throwIfAborted();
  if (process.platform !== "darwin") return false;
  if (tools?.ok || (tools && now() - tools.at < 60000)) return tools.ok;
  let ok = false;
  try {
    const { stdout } = await run("/usr/bin/xcode-select", ["-p"], { timeout: 5000, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    ok = !!stdout.trim() && existsSync(stdout.trim());
  } catch {
    signal?.throwIfAborted();
    ok = false;
  }
  tools = { at: now(), ok };
  return ok;
}
export const resetDeveloperTools = () => {
  tools = null;
};

const building = new Map(); // output file -> build and its current callers

// Each caller owns only its wait. Quitting one session must not cancel a
// shared compile another live session still needs; the compiler is stopped
// only after its final caller lets go.
function waitForBuild(build, signal) {
  const caller = {};
  build.callers.add(caller);
  return new Promise((resolve, reject) => {
    const detach = () => {
      signal?.removeEventListener("abort", abort);
      build.callers.delete(caller);
    };
    const abort = () => {
      detach();
      if (!build.callers.size) build.controller.abort();
      reject(signal.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    build.promise.then(
      (file) => { detach(); resolve(file); },
      (error) => { detach(); reject(error); },
    );
    if (signal?.aborted) abort();
  });
}

// Builds `file` with `/usr/bin/xcrun <args… -o tmp>` unless it's there. The
// temporary file is this build's own; the result appears whole or not at all.
export function buildNative(file, args, { timeout = 120000, signal, missing, run = exec, prune = true } = {}) {
  return buildOnce(file, { signal, prune,
    prepare: async (compiling) => {
      if (!(await developerTools({ run, signal: compiling }))) {
        throw Object.assign(
          new Error(missing || "This needs Apple Command Line Tools. Run xcode-select --install on your Mac."),
          { status: 503, developerTools: false },
        );
      }
    },
    compile: (tmp, compiling) => run("/usr/bin/xcrun", [...args, "-o", tmp], { timeout, maxBuffer: 1024 * 1024, signal: compiling }),
  });
}

// Builds `file` with Windows' C# compiler, csc.exe, which `compiler()` finds
// (its full path, or null when this PC has none): `args(tmp)` are its
// arguments for writing the temporary file. Windows runs a program only by
// its extension, so the temporary file ends in .exe too. Same rules as above:
// one build per file at a time, whole or not at all, older builds removed.
export function buildWindowsNative(file, { compiler, args, timeout = 120000, signal, run = exec, prune = true }) {
  return buildOnce(file, { signal, prune, suffix: ".tmp.exe",
    prepare: async () => {
      const found = await compiler();
      if (!found) throw Object.assign(new Error("Windows' C# compiler (csc.exe) isn't on this PC."), { status: 503, compiler: false });
      return found;
    },
    compile: (tmp, compiling, csc) => run(csc, args(tmp), { timeout, maxBuffer: 1024 * 1024, signal: compiling, windowsHide: true }),
  });
}

// One build of `file` at a time across every caller: `prepare` checks the
// compiler is there (its answer goes to `compile`), `compile` writes the
// temporary file, which then takes the file's name in one rename.
function buildOnce(file, { signal, prepare, compile, prune = true, suffix = ".tmp" }) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  if (existsSync(file)) return Promise.resolve(file);
  let build = building.get(file);
  if (!build || build.controller.signal.aborted) {
    build = { controller: new AbortController(), callers: new Set() };
    const current = build;
    const compiling = build.controller.signal;
    build.promise = (async () => {
      const prepared = await prepare(compiling);
      compiling.throwIfAborted();
      const tmp = `${file}-${process.pid}-${crypto.randomBytes(4).toString("hex")}${suffix}`;
      try {
        await compile(tmp, compiling, prepared);
        compiling.throwIfAborted();
        await fs.chmod(tmp, 0o700);
        compiling.throwIfAborted();
        await fs.rename(tmp, file);
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
      if (prune) await pruneOlder(file);
      return file;
    })().finally(() => {
      if (building.get(file) === current) building.delete(file);
    });
    building.set(file, build);
  }
  return waitForBuild(build, signal);
}

// reach-<kind>-<hash> (reach-<kind>-<hash>.exe on Windows): the builds of
// one helper differ only in their hash. Deleting a binary a process still
// runs is safe on macOS; on Windows that build stays until it's free.
export async function pruneOlder(file) {
  const dir = path.dirname(file);
  const match = /^(reach-[a-z0-9-]+?)-([0-9a-f]{12})(\.exe)?$/.exec(path.basename(file));
  if (!match) return;
  const [, kind, , exe = ""] = match;
  const names = await fs.readdir(dir).catch(() => []);
  await Promise.all(
    names
      .filter((name) => name !== path.basename(file) && new RegExp(`^${kind}-[0-9a-f]{12}${exe ? "\\.exe" : ""}$`).test(name))
      .map((name) => fs.rm(path.join(dir, name), { force: true }).catch(() => {})),
  );
}
