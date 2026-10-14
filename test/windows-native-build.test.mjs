import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cscCandidates, windowsBinary } from "../server/desktop-native.mjs";

// Windows helpers are C#, built on first use with the csc.exe every Windows
// 10 and 11 has, cached by source hash in the data folder, whole or not at
// all (docs/WINDOWS_AGENT_PARITY.md, rule 3). Off Windows the compiler is a
// stand-in that records its arguments and writes the output; on a real
// Windows runner (REACH_TEST_WINDOWS_DESKTOP=1) the last test builds and runs
// scripts/native/hello.cs with the PC's own compiler.
const env = { SystemRoot: String.raw`C:\Windows` };
const fx64 = String.raw`C:\Windows\Microsoft.NET\Framework64\v4.0.30319`;
const fx86 = String.raw`C:\Windows\Microsoft.NET\Framework\v4.0.30319`;
const win = { platform: "win32", env };
// With a space, as most PCs' data folders have (C:\Users\First Last\…): the
// real build then proves csc's arguments are quoted.
const folder = async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach windows build-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};
// csc.exe as a stand-in: writes /out:, or fails as told.
const compiler = ({ fail, delay = 0 } = {}) => {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    if (fail) throw fail;
    await fs.writeFile(args.find((arg) => arg.startsWith("/out:")).slice(5), "MZ helper");
    return { stdout: "", stderr: "" };
  };
  return { run, calls };
};
const only = (...present) => (file) => present.some((dir) => file === path.win32.join(dir, "csc.exe"));

test("csc.exe is looked for in the Windows folder only: Framework64, then Framework", () => {
  assert.deepEqual(cscCandidates({ env }), [path.win32.join(fx64, "csc.exe"), path.win32.join(fx86, "csc.exe")]);
  assert.deepEqual(cscCandidates({ env: { windir: String.raw`D:\WINNT` } })[0], String.raw`D:\WINNT\Microsoft.NET\Framework64\v4.0.30319\csc.exe`);
  // A Windows folder that isn't one absolute path is no Windows folder.
  for (const bad of [{}, { SystemRoot: "Windows" }, { SystemRoot: String.raw`\\server\Windows` }, { SystemRoot: String.raw`C:\Windows\..\Temp` }, { SystemRoot: "/tmp" }])
    assert.deepEqual(cscCandidates({ env: bad }), [], JSON.stringify(bad));
});

test("a helper is built with the PC's own csc.exe into the data folder, named by its source's hash", async (t) => {
  const dataDir = await folder(t);
  const csc = compiler();
  const file = await windowsBinary({ dataDir }, "hello", { ...win, run: csc.run, exists: only(fx64, fx86) });
  assert.equal(path.dirname(file), dataDir);
  assert.match(path.basename(file), /^reach-hello-[0-9a-f]{12}\.exe$/);
  assert.equal(await fs.readFile(file, "utf8"), "MZ helper");
  assert.equal(csc.calls.length, 1);
  const { command, args, options } = csc.calls[0];
  assert.equal(command, path.win32.join(fx64, "csc.exe"), "Framework64 first");
  assert.equal(options.windowsHide, true);
  for (const flag of ["/nologo", "/noconfig", "/target:exe", "/optimize+", "/codepage:65001"]) assert.ok(args.includes(flag), flag);
  const out = args.find((arg) => arg.startsWith("/out:")).slice(5);
  assert.match(out, /\.tmp\.exe$/, "written to its own temporary .exe first");
  assert.equal(path.dirname(out), dataDir);
  assert.deepEqual(args.filter((arg) => arg.startsWith("/reference:")).map((arg) => arg.slice(11)), [
    "System.dll", "System.Core.dll", "System.Drawing.dll", "System.Windows.Forms.dll",
    String.raw`WPF\UIAutomationClient.dll`, String.raw`WPF\UIAutomationTypes.dll`, String.raw`WPF\WindowsBase.dll`,
  ].map((name) => path.win32.join(fx64, name)));
  assert.equal(args.at(-1), path.resolve("scripts/native/hello.cs"));
  assert.deepEqual((await fs.readdir(dataDir)).filter((name) => name.includes(".tmp")), []);
  // Built once: the next ask finds it.
  assert.equal(await windowsBinary({ dataDir }, "hello", { ...win, run: csc.run, exists: only(fx64) }), file);
  assert.equal(csc.calls.length, 1);
});

test("two asks at once build once; a newer build removes the older ones of the same helper only", async (t) => {
  const dataDir = await folder(t);
  for (const name of ["reach-hello-aaaaaaaaaaaa.exe", "reach-hello-bbbbbbbbbbbb.exe", "reach-other-cccccccccccc.exe", "reach-hello-dddddddddddd", "notes.txt"])
    await fs.writeFile(path.join(dataDir, name), "old");
  const csc = compiler({ delay: 30 });
  const [a, b] = await Promise.all([1, 2].map(() => windowsBinary({ dataDir }, "hello", { ...win, run: csc.run, exists: only(fx64) })));
  assert.equal(a, b);
  assert.equal(csc.calls.length, 1);
  assert.deepEqual((await fs.readdir(dataDir)).sort(), [path.basename(a), "notes.txt", "reach-hello-dddddddddddd", "reach-other-cccccccccccc.exe"].sort());
});

test("on 32-bit Windows, csc.exe comes from Framework", async (t) => {
  const dataDir = await folder(t);
  const csc = compiler();
  await windowsBinary({ dataDir }, "hello", { ...win, run: csc.run, exists: only(fx86) });
  assert.equal(csc.calls[0].command, path.win32.join(fx86, "csc.exe"));
  assert.ok(csc.calls[0].args.includes(`/reference:${path.win32.join(fx86, "WPF", "WindowsBase.dll")}`));
});

test("without csc.exe, or without a known Windows folder, nothing runs and the owner hears why", async (t) => {
  const dataDir = await folder(t);
  for (const options of [{ exists: only() }, { exists: () => true, env: {} }, { exists: () => true, env: { SystemRoot: "Windows" } }]) {
    const csc = compiler();
    await assert.rejects(windowsBinary({ dataDir }, "hello", { ...win, run: csc.run, ...options }),
      (error) => error.status === 503 && error.compiler === false && /csc\.exe/.test(error.message) && /\.NET Framework 4\.8/.test(error.message));
    assert.equal(csc.calls.length, 0);
  }
  assert.deepEqual(await fs.readdir(dataDir), []);
});

test("a compiler Windows refuses to start is named as application control, and nothing is left behind", async (t) => {
  const dataDir = await folder(t);
  for (const code of ["UNKNOWN", "EACCES", "EPERM"]) {
    const csc = compiler({ fail: Object.assign(new Error(`spawn ${code}`), { code, syscall: `spawn ${path.win32.join(fx64, "csc.exe")}` }) });
    await assert.rejects(windowsBinary({ dataDir }, "hello", { ...win, run: csc.run, exists: only(fx64) }),
      (error) => error.status === 503 && error.refused === true && /application control/i.test(error.message), code);
  }
  // Built, but its output couldn't be written (an antivirus, Controlled folder access).
  const blocked = compiler({ fail: Object.assign(new Error("Command failed"), { code: 1, stdout: "error CS0016: Could not write to output file 'x.exe' -- 'Access is denied.'" }) });
  await assert.rejects(windowsBinary({ dataDir }, "hello", { ...win, run: blocked.run, exists: only(fx64) }), (error) => error.refused === true && /Controlled folder access/.test(error.message));
  assert.deepEqual(await fs.readdir(dataDir), []);
});

test("a build that fails says so plainly, logs csc's first error, and leaves no partial helper", async (t) => {
  const dataDir = await folder(t);
  const warned = [];
  t.mock.method(console, "warn", (line) => warned.push(line));
  const csc = {
    calls: 0,
    run: async (command, args) => {
      csc.calls++;
      await fs.writeFile(args.find((arg) => arg.startsWith("/out:")).slice(5), "partial");
      throw Object.assign(new Error("Command failed"), { code: 1, stdout: "Microsoft (R) Visual C# Compiler\r\nhello.cs(3,1): error CS1002: ; expected\r\n" });
    },
  };
  await assert.rejects(windowsBinary({ dataDir }, "hello", { ...win, run: csc.run, exists: only(fx64) }), (error) => error.status === 503 && !error.refused && !("compiler" in error));
  assert.match(warned.join("\n"), /building hello failed: hello\.cs\(3,1\): error CS1002/);
  assert.deepEqual(await fs.readdir(dataDir), []);
});

test("only Windows builds Windows helpers, and only Reach's own", async (t) => {
  const dataDir = await folder(t);
  const csc = compiler();
  await assert.rejects(windowsBinary({ dataDir }, "hello", { ...win, platform: "darwin", run: csc.run, exists: () => true }), (error) => error.status === 501);
  for (const kind of ["../hello", "Hello", "hello.cs", "", "x".repeat(41)])
    await assert.rejects(windowsBinary({ dataDir }, kind, { ...win, run: csc.run, exists: () => true }), (error) => error.status === 400, kind);
  await assert.rejects(windowsBinary({ dataDir }, "no-such-helper", { ...win, run: csc.run, exists: () => true }), { code: "ENOENT" });
  assert.equal(csc.calls.length, 0);
});

test("a helper with a manifest beside it is built with it, and named by it too; one without is built as before", async (t) => {
  const dataDir = await folder(t);
  const csc = compiler();
  const file = await windowsBinary({ dataDir }, "agent-desktop", { ...win, run: csc.run, exists: only(fx64) });
  assert.match(path.basename(file), /^reach-agent-desktop-[0-9a-f]{12}\.exe$/);
  const manifest = csc.calls[0].args.filter((arg) => arg.startsWith("/win32manifest:"));
  assert.deepEqual(manifest, [`/win32manifest:${path.resolve("scripts/native/agent-desktop.manifest")}`]);
  assert.equal(csc.calls[0].args.at(-1), path.resolve("scripts/native/agent-desktop.cs"));
  // Its manifest: per-monitor DPI aware, never administrator rights.
  const text = await fs.readFile("scripts/native/agent-desktop.manifest", "utf8");
  assert.match(text, /<dpiAwareness[^>]*>PerMonitorV2<\/dpiAwareness>/);
  assert.match(text, /requestedExecutionLevel level="asInvoker" uiAccess="false"/);
  await windowsBinary({ dataDir }, "hello", { ...win, run: csc.run, exists: only(fx64) });
  assert.equal(csc.calls[1].args.some((arg) => arg.startsWith("/win32manifest:")), false, "hello.cs has none");
});

test("a build Windows' antivirus still holds is moved into place once it lets go; one that appeared meanwhile counts", async (t) => {
  const { renameScanned } = await import("../server/native-build.mjs");
  const dir = await folder(t);
  const tmp = path.join(dir, "build.tmp.exe"), file = path.join(dir, "reach-x-0123456789ab.exe");
  const waits = [];
  let tries = 0;
  const busy = (times, code = "EBUSY") => async (from, to) => {
    if (++tries <= times) throw Object.assign(Error(code), { code });
    await fs.rename(from, to);
  };
  await fs.writeFile(tmp, "MZ");
  await renameScanned(tmp, file, { rename: busy(3), wait: async (ms) => waits.push(ms) });
  assert.equal(await fs.readFile(file, "utf8"), "MZ");
  assert.deepEqual(waits, [100, 200, 400]);
  // Another caller's build appeared: this one's temporary file goes.
  await fs.writeFile(tmp, "MZ second");
  tries = 0;
  await renameScanned(tmp, file, { rename: busy(1, "EPERM"), wait: async () => {} });
  assert.equal(existsSync(tmp), false);
  assert.equal(await fs.readFile(file, "utf8"), "MZ");
  await fs.rm(file);
  // Eight tries at most, and only while Windows says the file is in use.
  await fs.writeFile(tmp, "MZ");
  tries = 0;
  waits.length = 0;
  await assert.rejects(renameScanned(tmp, file, { rename: busy(100, "EACCES"), wait: async (ms) => waits.push(ms) }), { code: "EACCES" });
  assert.deepEqual(waits, [100, 200, 400, 800, 1600, 1600, 1600, 1600]);
  tries = 0;
  await assert.rejects(renameScanned(tmp, file, { rename: busy(1, "ENOSPC"), wait: async () => assert.fail("not retried") }), { code: "ENOSPC" });
});

test("on real Windows, the PC's own csc.exe builds hello.cs and it runs", {
  skip: !(process.platform === "win32" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1"), timeout: 180000,
}, async (t) => {
  const dataDir = await folder(t);
  const started = Date.now();
  const file = await windowsBinary({ dataDir }, "hello");
  const buildMs = Date.now() - started;
  const { stdout } = await promisify(execFile)(file, [], { timeout: 30000, windowsHide: true });
  assert.deepEqual(JSON.parse(stdout), { ok: true, hello: "reach", types: 7 });
  await fs.mkdir("reports", { recursive: true });
  await fs.writeFile("reports/windows-native-build.json", JSON.stringify({ file: path.basename(file), buildMs, csc: cscCandidates().find((candidate) => existsSync(candidate)) }, null, 2));
});
