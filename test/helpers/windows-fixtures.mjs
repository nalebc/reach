import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// The test-only C# programs of test/fixtures/windows, built on a real Windows
// runner with the PC's own csc.exe (as Reach builds its helpers), once per
// test process, into a folder of its own that goes when the process does.
const exec = promisify(execFile);
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "windows");
const built = new Map();
let dir = null;

// A runner's desktop cleared before a test puts windows on it (its console
// minimized, a shell surface in front dismissed); what was touched, by name.
export async function clearRunnerDesktop() {
  const { stdout } = await exec(await windowsFixture("runner-desktop"), [], { windowsHide: true, timeout: 30000 });
  return JSON.parse(stdout.trim());
}

// What shows on the runner's desktop, touching nothing: each window by class,
// program file name and place (never a title), the one in front, and the
// one at a point when asked: { front, at, shown }.
export async function lookAtRunnerDesktop(x, y) {
  const args = ["look", ...(Number.isFinite(x) && Number.isFinite(y) ? [String(Math.round(x)), String(Math.round(y))] : [])];
  const { stdout } = await exec(await windowsFixture("runner-desktop"), args, { windowsHide: true, timeout: 30000 });
  return JSON.parse(stdout.trim());
}

export function windowsFixture(name, references = [], { onStage, signal } = {}) {
  if (process.platform !== "win32") throw Error("Windows fixtures are built on Windows.");
  // Optional test diagnostics cannot change compilation or disclose paths/output.
  const mark = (stage, details = {}) => { try { onStage?.(stage, details); } catch {} };
  mark("fixture-request", { cacheHit: built.has(name) });
  if (!built.has(name))
    built.set(name, (async () => {
      mark("fixture-import-begin");
      const { cscCandidates } = await import("../../server/desktop-native.mjs");
      mark("fixture-import-end");
      mark("fixture-compiler-select-begin");
      const csc = cscCandidates().find((candidate) => fs.existsSync(candidate));
      if (!csc) {
        mark("fixture-compiler-unavailable");
        throw Error("csc.exe isn't on this PC.");
      }
      const category = path.win32.basename(path.win32.dirname(path.win32.dirname(csc)));
      mark("fixture-compiler-selected", { framework: ["Framework64", "Framework"].includes(category) ? category : "other" });
      if (!dir) {
        mark("fixture-directory-begin");
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-fixtures-"));
        mark("fixture-directory-created");
        process.once("exit", () => {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {}
        });
      }
      const out = path.join(dir, `${name}.exe`);
      const framework = path.win32.dirname(csc);
      try {
        signal?.throwIfAborted();
        mark("fixture-compile-begin");
        const compilation = exec(csc, ["/nologo", "/noconfig", "/target:exe", "/platform:anycpu", "/optimize+", `/out:${out}`,
          ...["System.dll", ...references].map((file) => `/reference:${path.win32.join(framework, file)}`),
          path.join(fixtures, `${name}.cs`)], { windowsHide: true, timeout: 120000, ...(signal ? { signal } : {}) });
        mark("fixture-compiler-spawned", { pid: Number.isInteger(compilation.child?.pid) ? compilation.child.pid : null });
        await compilation;
        mark("fixture-compile-complete", {
          exitCode: Number.isInteger(compilation.child?.exitCode) ? compilation.child.exitCode : null,
          signal: /^SIG[A-Z0-9]{1,16}$/.test(compilation.child?.signalCode || "") ? compilation.child.signalCode : null,
        });
      } catch (error) {
        mark("fixture-compile-error", {
          code: Number.isInteger(error.code) ? error.code : /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code || "") ? error.code : "unknown",
          signal: /^SIG[A-Z0-9]{1,16}$/.test(error.signal || "") ? error.signal : null,
          killed: error.killed === true,
        });
        throw Error(`${name}.cs didn't build: ${error.stdout || ""}${error.stderr || error.message}`);
      }
      mark("fixture-ready");
      return out;
    })());
  return built.get(name);
}
