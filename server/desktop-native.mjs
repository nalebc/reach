import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { fail } from "./core.mjs";
import { existsSync, readFileSync } from "node:fs";
import { buildNative, buildWindowsNative } from "./native-build.mjs";
import { COLD_START_MS, SCRIPT_BLOCKED, powershellFile, scriptBlocked } from "./powershell.mjs";
import { windowsPath } from "./app-identity.mjs";
const exec = promisify(execFile),
  native =fileURLToPath(new URL("../scripts/native/", import.meta.url));

// Windows helpers are C# (scripts/native/<kind>.cs), compiled on first use
// with the compiler every Windows 10 and 11 has: csc.exe of the .NET
// Framework 4.x, found from the Windows folder, never from PATH. 64-bit
// Windows (x64, and ARM64 through its x64 emulation) keeps it in Framework64;
// 32-bit Windows only in Framework: tried in that order, so a 32-bit Node or
// an emulated one can't pick the wrong one by its own architecture. That
// compiler takes C# 5. The assemblies the helpers use: UI Automation,
// System.Drawing, Windows Forms and WindowsBase (WPF's live in WPF\).
const FRAMEWORKS = ["Framework64", "Framework"];
const REFERENCES = ["System.dll", "System.Core.dll", "System.Drawing.dll", "System.Windows.Forms.dll",
  "WPF\\UIAutomationClient.dll", "WPF\\UIAutomationTypes.dll", "WPF\\WindowsBase.dll"];
const CSC_FLAGS = ["/nologo", "/noconfig", "/target:exe", "/platform:anycpu", "/optimize+", "/debug-", "/codepage:65001", "/utf8output"];
// Installed only after the Windows state check succeeds. Launch-owned builds
// for those roots use one newly created private staging directory and only
// this process's build/hash records, never a historical EXE plus digest note.
// Independent CLI/hook processes do not inherit this in-memory trust record.
const privateWindowsBuilds = new Set();
const buildRoot = (value) => path.win32.isAbsolute(value)
  ? path.win32.resolve(value).toLowerCase() : path.resolve(value);
const privateWindowsBuildFor = (dir) => {
  if (!dir) return null;
  const key = buildRoot(dir);
  for (const context of [...privateWindowsBuilds].reverse())
    if (context.roots.some((root) => key === root || key.startsWith(`${root}${path.win32.isAbsolute(root) ? "\\" : path.sep}`))) return context;
  return null;
};
const allowedWindowsBuild = (dir) => {
  const context = privateWindowsBuildFor(dir);
  if (context?.refusal) throw fail(503, context.refusal);
  return context;
};
export const windowsBuildDirectory = (dir, fallback = dir) => allowedWindowsBuild(dir)?.dir || fallback;
export function registerWindowsBuildDirectory({ roots, dir, refusal }) {
  if (!Array.isArray(roots) || !roots.length || roots.some((root) => typeof root !== "string" || !root)
    || (!(typeof dir === "string" && dir) && !(typeof refusal === "string" && refusal))) throw Error("A verified Windows build directory or refusal is required.");
  const context = { roots: [...new Set([...roots, ...(dir ? [dir] : [])].map(buildRoot))], dir, refusal, builds: new Map() };
  privateWindowsBuilds.add(context);
  return () => privateWindowsBuilds.delete(context);
}
// What one helper uses beyond those, so the rest aren't rebuilt for it:
// Windows' own speech recognizer for voice memos (agent-sessions/voice.mjs).
// Each is looked for beside WPF's assemblies, then in the assembly cache
// every .NET Framework 4 has (the runner had it in neither the framework's
// own folder, Oct 13).
const EXTRA_REFERENCES = { transcribe: ["System.Speech.dll"] };
// What one helper is built from beyond its own file, and which Main it runs:
// Windows' video helper paints a guest's private windows black with the
// agent desktop's own reading of them (scripts/native/screen-video.cs
// GuestView), so both decide alike from one copy of that code.
const EXTRA_SOURCES = { "screen-video": { sources: ["agent-desktop.cs"], main: "ReachVideo.ReachScreenVideo" } };
const extraCandidates = (framework, name, env) => {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR ?? "C:\\Windows";
  const assembly = name.replace(/\.dll$/i, "");
  return [
    path.win32.join(framework, "WPF", name),
    path.win32.join(framework, name),
    path.win32.join(root, "Microsoft.NET", "assembly", "GAC_MSIL", assembly, "v4.0_4.0.0.0__31bf3856ad364e35", name),
  ];
};
/** Where csc.exe can be on this PC, in the order tried: [] when the Windows folder isn't known. */
export function cscCandidates({ env = process.env } = {}) {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
  if (!windowsPath(root)) return [];
  return FRAMEWORKS.map((name) => path.win32.join(root, "Microsoft.NET", name, "v4.0.30319", "csc.exe"));
}
// What Windows says when it won't start a program: an application control
// policy (Smart App Control, App Control for Business, AppLocker) or an
// antivirus. Node reports those as access errors or UNKNOWN.
const refusedToStart = (error) => /^spawn/.test(error?.syscall || "") && ["EACCES", "EPERM", "UNKNOWN"].includes(error?.code);
// Where a helper of `kind` is built, and how: the source file, the csc flags
// and references, and the hashed output name. Shared by windowsBinary (which
// builds) and builtWindowsHelper (which only looks). Any change to the source
// or the build names a new file, so a stale one is never run.
function helperPlan(kind, { dir, target = "exe", fresh = false } = {}) {
  const built = EXTRA_SOURCES[kind];
  const flags = [...CSC_FLAGS.map((flag) => (flag === "/target:exe" ? `/target:${target}` : flag)), ...(built ? [`/main:${built.main}`] : [])];
  const sourceFiles = [path.join(native, `${kind}.cs`), ...(built?.sources || []).map((name) => path.join(native, name))];
  const extras = EXTRA_REFERENCES[kind] || [];
  // A helper may have a manifest beside it (scripts/native/<kind>.manifest:
  // its DPI awareness, never administrator rights), built into it and part
  // of its name. A helper without one is built and named exactly as before.
  const manifestFile = path.join(native, `${kind}.manifest`);
  let manifest = null;
  try {
    manifest = readFileSync(manifestFile);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const digest = crypto.createHash("sha256");
  for (const file of sourceFiles) digest.update(readFileSync(file));
  digest.update(JSON.stringify([flags, extras.length ? [...REFERENCES, ...extras] : REFERENCES]));
  if (manifest) digest.update(manifest);
  const hash = digest.digest("hex").slice(0, 12);
  const file = path.join(dir, `reach-${kind}-${hash}${fresh ? `-${crypto.randomBytes(4).toString("hex")}` : ""}.exe`);
  return { flags, sourceFiles, extras, manifest, manifestFile, file };
}
// A helper for a security check (windowsHelper), resolved without ever
// compiling: its path and noted SHA-256 when it's already built in `dir` and
// the note matches the file, else null. For a short-lived child like the
// callers that explicitly need legacy build discovery. Security boundaries
// use a freshly compiled helper and an in-memory digest; the Claude hook
// establishes its own private stage rather than authorizing this disk cache.
export function builtWindowsHelper(kind, { dir, exists = existsSync } = {}) {
  // A refused launch never consults old bytes/notes. An active stage uses
  // only its build provider's in-memory records, not this legacy discovery.
  if (allowedWindowsBuild(dir)) return null;
  if (!dir || typeof kind !== "string" || !/^[a-z0-9-]{1,40}$/.test(kind)) return null;
  let file;
  try {
    ({ file } = helperPlan(kind, { dir }));
  } catch {
    return null;
  }
  const note = file.replace(/\.exe$/, ".sha256");
  if (!exists(file) || !exists(note)) return null;
  let noted = "";
  let actual = "";
  try {
    noted = readFileSync(note, "utf8").trim();
    actual = crypto.createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
  return noted && noted === actual ? { file, sha256: actual } : null;
}
/** A Windows helper built from scripts/native/<kind>.cs into the data folder (or `dir`), named by its source's hash: its path. */
// `target: "winexe"`: a Windows program with no console window of its own
// (the background task's starter); every other helper is a console program.
export async function windowsBinary(config, kind, { signal, run = exec, exists = existsSync, env = process.env, platform = process.platform, dir = config.dataDir, fresh = false, rebuild = () => false, target = "exe", rename, _privateBuild = false } = {}) {
  signal?.throwIfAborted();
  if (platform !== "win32") throw fail(501, "Windows helpers are built on Windows.");
  if (typeof kind !== "string" || !/^[a-z0-9-]{1,40}$/.test(kind)) throw fail(400, "Unknown helper.");
  if (!["exe", "winexe"].includes(target)) throw fail(400, "Unknown helper.");
  const context = !_privateBuild && allowedWindowsBuild(dir);
  if (context) {
    // Preserve source/flags/manifest invalidation even within this process.
    const key = path.basename(helperPlan(kind, { dir: context.dir, target }).file);
    if (!context.builds.has(key)) context.builds.set(key, (async () => {
      const file = await windowsBinary(config, kind, { signal, run, exists, env, platform,
        dir: context.dir, fresh: true, target, rename, _privateBuild: true });
      return { file, sha256: await sha256Of(file) };
    })().catch((error) => { context.builds.delete(key); throw error; }));
    const built = await context.builds.get(key);
    signal?.throwIfAborted();
    assertUnchanged(built.file, built.sha256);
    return built.file;
  }
  // Its source and how it's built name it (helperPlan): any change to either
  // rebuilds it. `fresh` gives it a name no file has yet, never a cached build
  // (a checker compiled every launch: server/windows-private-folder.mjs).
  const { flags, sourceFiles, extras, manifest, manifestFile, file } = helperPlan(kind, { dir, target, fresh });
  // A cached build its caller no longer trusts (windowsHelper): built again.
  if (existsSync(file) && rebuild(file)) await fs.rm(file, { force: true });
  let framework = null;
  try {
    await buildWindowsNative(file, {
      signal, run, ...(rename ? { rename } : {}),
      compiler: () => {
        const found = cscCandidates({ env }).find((candidate) => exists(candidate));
        framework = found ? path.win32.dirname(found) : null;
        return found || null;
      },
      args: (tmp) => [
        ...flags,
        ...(manifest ? [`/win32manifest:${manifestFile}`] : []),
        `/out:${tmp}`,
        ...REFERENCES.map((name) => `/reference:${path.win32.join(framework, name)}`),
        ...extras.map((name) => `/reference:${extraCandidates(framework, name, env).find((file) => exists(file)) || path.win32.join(framework, name)}`),
        ...sourceFiles,
      ],
    });
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error.compiler === false)
      throw Object.assign(fail(503, "This needs Windows' C# compiler (csc.exe, part of the .NET Framework 4.8 that comes with Windows), and it isn't on this PC. Turn on .NET Framework 4.8 in Windows Features, then try again."), { compiler: false });
    if (refusedToStart(error))
      throw Object.assign(fail(503, "Windows refused to run its C# compiler (csc.exe) on this PC: an application control policy (Smart App Control, App Control for Business or AppLocker) or an antivirus blocks it. Reach can't prepare this until it's allowed."), { refused: true });
    const said = `${error.stdout || ""}\n${error.stderr || ""}`;
    if (/error CS0016\b/.test(said))
      throw Object.assign(fail(503, "Windows wouldn't let Reach write the helper it built (an antivirus or Controlled folder access blocks Reach's data folder)."), { refused: true });
    const first = said.split(/\r?\n/).find((line) => /error CS\d+/.test(line)) || error.message;
    console.warn(`Reach: building ${kind} failed: ${String(first).trim().slice(0, 300)}`);
    throw fail(503, "Reach couldn't prepare this on your PC. Try again; if it keeps failing, Reach's log says why.");
  }
  return file;
}
const sha256Of = async (file) => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
// A helper a security check runs (docs/parity/D-public-door.md §4.5): built in
// a folder Reach made private this launch, its SHA-256 noted beside it right
// after the build. A cached build is used again only while it still has the
// hash noted; one without a note, or changed since, is built again. Returns
// { file, sha256 }: what spawnVerified checks before every start.
export async function windowsHelper(kind, { dir, fresh = false, ...options } = {}) {
  if (!dir) throw Error("A helper for a security check is built only in Reach's private folder.");
  const context = allowedWindowsBuild(dir);
  await fs.mkdir(context?.dir || dir, { recursive: true });
  const noteOf = (file) => file.replace(/\.exe$/, ".sha256");
  const noted = (file) => {
    try {
      return readFileSync(noteOf(file), "utf8").trim();
    } catch {
      return "";
    }
  };
  const hashed = (file) => crypto.createHash("sha256").update(readFileSync(file)).digest("hex");
  const file = await windowsBinary({ dataDir: dir }, kind, { ...options, dir, fresh, rebuild: (cached) => !noted(cached) || noted(cached) !== hashed(cached) });
  const sha256 = await sha256Of(file);
  if (!fresh && !context && noted(file) !== sha256) await fs.writeFile(noteOf(file), `${sha256}\n`, { mode: 0o600 });
  return { file, sha256 };
}
// Run only while the file still has the hash Reach noted when it built it: a
// helper replaced on disk since is refused, restarts included.
export function assertUnchanged(file, sha256) {
  let actual = "";
  try {
    actual = crypto.createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {}
  if (typeof sha256 !== "string" || !sha256 || actual !== sha256)
    throw Object.assign(Error("Reach's helper changed on disk."), { code: "ECHANGED" });
}
export function spawnVerified(file, sha256, args = [], options = {}, { start = spawn } = {}) {
  assertUnchanged(file, sha256);
  return start(file, args, options);
}
export async function desktopBinary(config, kind, { signal } = {}) {
  signal?.throwIfAborted();
  // Name the cached build after its source, so any helper edit recompiles.
  const source = await fs.readFile(path.join(native, `${kind}.swift`));
  // Tests may share one folder of builds (REACH_TEST_NATIVE_DIR): each test's
  // own data folder rebuilt every helper, longer than a test lasts on a slow
  // Intel runner, and its cleanup removed the build mid-link (Oct 12).
  const file = path.join(
    process.env.REACH_TEST_NATIVE_DIR || config.dataDir,
    `reach-${kind}-${crypto.createHash("sha256").update(source).digest("hex").slice(0, 12)}`,
  );
  try {
    await buildNative(file, ["swiftc", "-parse-as-library", "-O", path.join(native, `${kind}.swift`)], { signal });
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted) throw error;
    // Said as the owner can act on it, without Reach's own part names.
    if (error.developerTools === false)
      throw Object.assign(
        fail(503, "This needs Apple's Command Line Tools. Run xcode-select --install on your Mac, then try again."),
        { developerTools: false },
      );
    console.warn(`Reach: building ${kind} failed: ${error.message}`);
    throw fail(503, "Reach couldn't prepare this on your Mac. Check macOS permissions, then try again.");
  }
  return file;
}
export async function desktopDisplays(config, { run = exec, platform = process.platform } = {}) {
  let result;
  if (platform === "darwin")
    result = await run(
      await desktopBinary(config, "screen-stream"),
      ["--list"],
      { timeout: 10000, maxBuffer: 65536 },
    );
  else if (platform === "win32")
    result = await run(
      "powershell.exe",
      powershellFile(path.join(native, "desktop-input.ps1"), ["-Display", "list"], { sta: true }),
      { timeout: COLD_START_MS, maxBuffer: 65536, windowsHide: true },
    ).catch((error) => {
      // Said in words, not as PowerShell's raw command line and stack.
      const said = String(error.stderr || "").trim();
      if (scriptBlocked(said)) throw Object.assign(fail(503, SCRIPT_BLOCKED), { permanent: true });
      throw fail(
        503,
        error.killed
          ? "Windows took too long to list its displays. Keep the PC signed in and unlocked, then reconnect."
          : `Windows couldn't list its displays${said ? `: ${said.split(/\r?\n/)[0].slice(0, 200)}` : "."} Keep the PC signed in and unlocked, and run Reach in your desktop session.`,
      );
    });
  else throw fail(501, "Remote desktop currently supports macOS and Windows.");
  const list = JSON.parse(result.stdout);
  if (!Array.isArray(list) || !list.length || list.length > 32)
    throw fail(503, "No desktop displays are available.");
  return list;
}
// One helper per control connection, never one process per pointer movement.
// The helper releases every held button on EOF, SIGTERM or its own watchdog.
export class DesktopInput {
  // coldStartMs: how long its first answer may take. A Windows helper
  // compiles its C# before it answers at all (server/powershell.mjs); every
  // answer after that, and a Mac's prebuilt helper, gets the usual 10 s.
  constructor(child, { coldStartMs = 0 } = {}) {
    this.child = child;
    this.pending = null;
    this.stopped = false;
    this.exited = false;
    this.coldStartMs = coldStartMs;
    this.answered = false;
    // Pending requests reject as soon as stop starts, but the native process
    // can still finish an action or release held buttons until it really exits.
    this.terminated = new Promise((resolve) => {
      const finished = () => { this.exited = true; resolve(); };
      child.once("exit", finished);
      child.once("error", () => { if (!child.pid) finished(); });
    });
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => this.stop());
    child.on("error", () => this.stop());
    child.on("exit", () => this.stop());
    child.stdout.on("data", (chunk) => {
      buffer += decoder.write(chunk);
      if (buffer.length > 3 * 1024 * 1024) return this.stop();
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const value = JSON.parse(line);
          const p = this.pending;
          if (!p) return this.stop();
          this.pending = null;
          this.answered = true;
          clearTimeout(p.timer);
          // refused: the helper turned down this one action (a typing target
          // that moved, a key it doesn't know); control goes on.
          value.error
            ? p.reject(Object.assign(fail(403, value.error), value.fatal ? {} : { refused: true }))
            : p.resolve(value);
        } catch {
          this.stop();
        }
      }
    });
  }
  static async create(config, display) {
    let executable, args, coldStartMs = 0;
    if (config.desktopInputCommand) {
      [executable, ...args] = config.desktopInputCommand;
    } else if (process.platform === "darwin") {
      executable = await desktopBinary(config, "desktop-input");
      args = [display];
    } else if (process.platform === "win32") {
      executable = "powershell.exe";
      args = powershellFile(path.join(native, "desktop-input.ps1"), [display], { sta: true });
      coldStartMs = COLD_START_MS;
    } else throw fail(501, "Desktop input supports macOS and Windows.");
    return new DesktopInput(
      spawn(executable, args, {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      }),
      { coldStartMs },
    );
  }
  send(action) {
    if (this.stopped)
      return Promise.reject(
        fail(403, "Desktop input disconnected. Enable control again."),
      );
    if (this.pending)
      return Promise.reject(fail(429, "Wait for the previous desktop action."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.stop(), !this.answered && this.coldStartMs ? this.coldStartMs : 10000);
      this.pending = { resolve, reject, timer };
      this.child.stdin.write(JSON.stringify(action) + "\n");
    });
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(fail(403, "Desktop input disconnected."));
      this.pending = null;
    }
    try { this.child.stdin.end(); } catch { /* already closed */ }
    const child = this.child;
    if (this.exited || !child.pid) return;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      if (this.exited) return;
      const force = setTimeout(() => child.kill("SIGKILL"), 1000);
      force.unref();
      child.once("exit", () => clearTimeout(force));
    }, 500);
    timer.unref();
    child.once("exit", () => clearTimeout(timer));
  }
}
