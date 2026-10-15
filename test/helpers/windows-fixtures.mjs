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

export function windowsFixture(name, references = []) {
  if (process.platform !== "win32") throw Error("Windows fixtures are built on Windows.");
  if (!built.has(name))
    built.set(name, (async () => {
      const { cscCandidates } = await import("../../server/desktop-native.mjs");
      const csc = cscCandidates().find((candidate) => fs.existsSync(candidate));
      if (!csc) throw Error("csc.exe isn't on this PC.");
      if (!dir) {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-fixtures-"));
        process.once("exit", () => {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {}
        });
      }
      const out = path.join(dir, `${name}.exe`);
      const framework = path.win32.dirname(csc);
      try {
        await exec(csc, ["/nologo", "/noconfig", "/target:exe", "/platform:anycpu", "/optimize+", `/out:${out}`,
          ...["System.dll", ...references].map((file) => `/reference:${path.win32.join(framework, file)}`),
          path.join(fixtures, `${name}.cs`)], { windowsHide: true, timeout: 120000 });
      } catch (error) {
        throw Error(`${name}.cs didn't build: ${error.stdout || ""}${error.stderr || error.message}`);
      }
      return out;
    })());
  return built.get(name);
}
