import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { COLD_START_MS, SCRIPT_BLOCKED, cleanPowerShellEnv, powershellFile, scriptBlocked, windowsPowerShellModulePath } from "../server/powershell.mjs";
import { desktopDisplays } from "../server/desktop-native.mjs";
import { screenTrouble } from "../server/remote-screen.mjs";
import { NativeScreenSource } from "../server/screen-stream.mjs";

// Oct 11: a first Windows user's live screen never loaded. Windows' default
// policy refuses scripts unless Reach was started by .\reach.cmd, a cold
// helper compiles before it answers, and nothing said why on the PC.

test("every Windows helper asks for its own script bypass, -STA where it needs it", () => {
  assert.deepEqual(powershellFile("C:\\r\\screen-stream.ps1", ["DISPLAY1", "1600"]), [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\r\\screen-stream.ps1", "DISPLAY1", "1600",
  ]);
  assert.deepEqual(powershellFile("x.ps1", ["--list"], { sta: true }), [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", "x.ps1", "--list",
  ]);
});

test("no PowerShell script starts without that bypass", () => {
  // A new helper written with a bare -File would work on GitHub's runners
  // (scripts allowed) and fail on a normal PC: only powershell.mjs says -File.
  const offenders = fs.readdirSync("server", { recursive: true })
    .filter((name) => name.endsWith(".mjs") && name !== "powershell.mjs")
    .filter((name) => /["']-File["']/.test(fs.readFileSync(path.join("server", name), "utf8")));
  assert.deepEqual(offenders, []);
});

test("PowerShell's policy refusals are recognized; ordinary errors are not", () => {
  for (const said of [
    "File C:\\Reach\\scripts\\native\\screen-stream.ps1 cannot be loaded because running scripts is disabled on this system. For more information, see about_Execution_Policies.\r\n    + CategoryInfo          : SecurityError: (:) [], PSSecurityException\r\n    + FullyQualifiedErrorId : UnauthorizedAccess",
    "File C:\\Reach\\scripts\\native\\desktop-input.ps1 cannot be loaded. The file is not digitally signed. You cannot run this script on the current system.",
    "Add-Type : Cannot add type. Definition of new types is not supported in this language mode.",
  ])
    assert.equal(scriptBlocked(said), true, said);
  for (const said of ["Display disconnected", "Windows could not stream the desktop.", "", undefined])
    assert.equal(scriptBlocked(said), false, String(said));
});

test("Windows lists its displays with time for a cold start, and says plainly why it couldn't", async () => {
  const calls = [];
  const list = await desktopDisplays({}, {
    platform: "win32",
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      return { stdout: '[{"id":"DISPLAY1","name":"\\\\\\\\.\\\\DISPLAY1","primary":true,"width":1920,"height":1080,"x":0,"y":0}]' };
    },
  });
  assert.equal(list[0].id, "DISPLAY1");
  assert.equal(calls[0].file, "powershell.exe");
  assert.deepEqual(calls[0].args.slice(0, 4), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-STA"]);
  assert.equal(calls[0].options.timeout, COLD_START_MS);

  const refused = (stderr, extra = {}) => desktopDisplays({}, {
    platform: "win32",
    run: async () => { throw Object.assign(Error("Command failed: powershell.exe -NoProfile …"), { stderr, ...extra }); },
  });
  await assert.rejects(
    refused("File C:\\Reach\\scripts\\native\\desktop-input.ps1 cannot be loaded because running scripts is disabled on this system."),
    (e) => e.message === SCRIPT_BLOCKED && e.permanent === true && e.status === 503,
  );
  await assert.rejects(refused("", { killed: true }), /took too long to list its displays/);
  await assert.rejects(
    refused("Exception calling \"AllScreens\"\r\nat line 32"),
    (e) => e.message.startsWith("Windows couldn't list its displays: Exception calling") && !e.message.includes("Command failed"),
  );
});

test("the computer's window names each screen failure once a minute, not once per retry", () => {
  const lines = [];
  let now = 1_000;
  const say = (message) => screenTrouble(message, { now: () => now, log: (line) => lines.push(line) });
  assert.equal(say("Windows took too long to list its displays.\u001b[2J"), true);
  assert.equal(say("Windows took too long to list its displays.\u001b[2J"), false);
  now += 59_000;
  assert.equal(say("Windows took too long to list its displays.\u001b[2J"), false);
  assert.equal(say("Display disconnected"), true);
  now += 2_000;
  assert.equal(say("Windows took too long to list its displays.\u001b[2J"), true);
  assert.equal(say(""), false);
  assert.deepEqual(lines, [
    "Reach: live screen: Windows took too long to list its displays. [2J",
    "Reach: live screen: Display disconnected",
    "Reach: live screen: Windows took too long to list its displays. [2J",
  ]);
});

test("a cold Windows helper gets a minute for its first picture, then the usual 15 seconds", async (t) => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  t.after(() => Object.defineProperty(process, "platform", platform));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // A helper that never answers: only the timers decide.
  const silent = ["-e", "process.stdin.resume()"];
  const expectWait = async (win, ms) => {
    Object.defineProperty(process, "platform", { value: win ? "win32" : "darwin" });
    const source = new NativeScreenSource(process.execPath, silent);
    t.after(() => source.stop());
    const frame = source.next();
    frame.catch(() => {});
    t.mock.timers.tick(ms - 1);
    assert.equal(source.failure, null, `still waiting at ${ms - 1} ms`);
    t.mock.timers.tick(1);
    assert.match(source.failure?.message || "", /didn’t answer in time/);
    await assert.rejects(frame);
  };
  await expectWait(true, COLD_START_MS);
  await expectWait(false, 15000);
});

test("Windows PowerShell gets its own modules, never PowerShell 7's", () => {
  // Oct 12: started from a PowerShell 7 window (Windows Terminal's default),
  // Windows PowerShell found 7's copies of its modules first and couldn't
  // load them; Get-ExecutionPolicy and Add-Type failed, the screen never came.
  const env = { USERPROFILE: "C:\\Users\\Sam", ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows" };
  const inherited = [
    "C:\\Users\\Sam\\Documents\\PowerShell\\Modules",
    "C:\\Program Files\\PowerShell\\Modules",
    "c:\\program files\\powershell\\7\\Modules",
    "C:\\Program Files\\PowerShell\\7-preview\\Modules\\",
    "C:\\Program Files\\WindowsPowerShell\\Modules",
    "C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules",
    "D:\\Team\\Modules",
  ].join(";");
  assert.deepEqual(windowsPowerShellModulePath(inherited, env).split(";"), [
    "C:\\Program Files\\WindowsPowerShell\\Modules",
    "C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules",
    "D:\\Team\\Modules",
    "C:\\Users\\Sam\\Documents\\WindowsPowerShell\\Modules",
  ], "7's folders dropped, the owner's own kept, Windows PowerShell's defaults present");
  assert.equal(windowsPowerShellModulePath("", env).split(";").length, 3, "nothing inherited: the defaults");
  // Changes this process's environment (so every child's) on Windows only,
  // whatever case the variable's name has there.
  const win = { ...env, PSMODULEPATH: "C:\\Program Files\\PowerShell\\7\\Modules" };
  cleanPowerShellEnv(win, "win32");
  assert.deepEqual(Object.keys(win).filter((k) => k.toUpperCase() === "PSMODULEPATH"), ["PSMODULEPATH"]);
  assert.doesNotMatch(win.PSMODULEPATH, /\\PowerShell\\7\\/i);
  const mac = { PSModulePath: "C:\\Program Files\\PowerShell\\7\\Modules" };
  cleanPowerShellEnv(mac, "darwin");
  assert.equal(mac.PSModulePath, "C:\\Program Files\\PowerShell\\7\\Modules");
});
