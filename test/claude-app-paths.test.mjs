import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAppData, claudeAppDataDirs, claudeAppInstalled, claudeAppRecords } from "../server/agent-sessions/claude-app-paths.mjs";
import { claudeAppAccess, claudeAppMain, claudeAppRunning, claudeAppShown, claudeAppStartedAt, createClaudeRefresh, inClaudeApp, writeClaudeRecord } from "../server/agent-sessions/claude-import.mjs";
import { useProcessesFolder, windowsProcesses } from "../server/windows-processes.mjs";
import { windowsStart } from "../server/agent-sessions/processes.mjs";

// Where the Claude desktop app keeps its chat records: a Mac's Application
// Support, and on Windows its installer's %APPDATA%\Claude or, packaged
// (MSIX), the package's own copy, which is what that app reads.
const HOME = "C:\\Users\\me";
const ENV = { APPDATA: `${HOME}\\AppData\\Roaming`, LOCALAPPDATA: `${HOME}\\AppData\\Local` };
const PKG = `${HOME}\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude`;
const listing = (tree) => (dir) => {
  if (!tree[dir]) throw Object.assign(Error("ENOENT"), { code: "ENOENT" });
  return tree[dir];
};

test("a Mac: Application Support, as before", () => {
  assert.deepEqual(claudeAppDataDirs({ platform: "darwin", home: "/Users/me" }), ["/Users/me/Library/Application Support/Claude"]);
  assert.equal(claudeAppRecords({ platform: "darwin", home: "/Users/me", exists: () => false }), "/Users/me/Library/Application Support/Claude/claude-code-sessions");
  assert.equal(claudeAppInstalled({ platform: "darwin", exists: (f) => f === "/Applications/Claude.app" }), true);
  assert.equal(claudeAppInstalled({ platform: "darwin", exists: () => false }), false);
});

test("Windows: the installer's %APPDATA%\\Claude, or the packaged app's own copy when it has one", () => {
  const plain = { platform: "win32", env: ENV, home: HOME, readdir: listing({}) };
  assert.deepEqual(claudeAppDataDirs(plain), [`${HOME}\\AppData\\Roaming\\Claude`]);
  assert.equal(claudeAppRecords({ ...plain, exists: () => false }), `${HOME}\\AppData\\Roaming\\Claude\\claude-code-sessions`, "where the installer would put it");
  // Packaged: Windows keeps the app's writes to %APPDATA% in its package's folder.
  const packaged = { ...plain, readdir: listing({ [`${HOME}\\AppData\\Local\\Packages`]: ["Microsoft.WindowsTerminal_8wekyb3d8bbwe", "Claude_pzs8sxrjxfjjc", "Claude_short", "ClaudeHelper_pzs8sxrjxfjjc"] }) };
  assert.deepEqual(claudeAppDataDirs(packaged), [PKG, `${HOME}\\AppData\\Roaming\\Claude`]);
  assert.equal(claudeAppData({ ...packaged, exists: (dir) => dir === PKG || dir === `${HOME}\\AppData\\Roaming\\Claude` }), PKG, "the package's copy is the app's");
  assert.equal(claudeAppRecords({ ...packaged, exists: (dir) => dir === PKG }), `${PKG}\\claude-code-sessions`);
  // A package folder without the app's data yet: the installer's, if it has one.
  assert.equal(claudeAppData({ ...packaged, exists: (dir) => dir === `${HOME}\\AppData\\Roaming\\Claude` }), `${HOME}\\AppData\\Roaming\\Claude`);
  // %APPDATA% unset: under the home folder; any case of the variable's name.
  assert.deepEqual(claudeAppDataDirs({ platform: "win32", env: {}, home: HOME, readdir: listing({}) }), [`${HOME}\\AppData\\Roaming\\Claude`]);
  assert.deepEqual(claudeAppDataDirs({ platform: "win32", env: { AppData: "D:\\Roam" }, home: HOME, readdir: listing({}) }), ["D:\\Roam\\Claude"]);
});

test("Windows: installed by its installer (%LOCALAPPDATA%\\AnthropicClaude) or as a package; neither, not installed", () => {
  const base = { platform: "win32", env: ENV, home: HOME };
  assert.equal(claudeAppInstalled({ ...base, exists: (f) => f === `${HOME}\\AppData\\Local\\AnthropicClaude`, readdir: listing({}) }), true);
  assert.equal(claudeAppInstalled({ ...base, exists: () => false, readdir: listing({ [`${HOME}\\AppData\\Local\\Packages`]: ["Claude_pzs8sxrjxfjjc"] }) }), true);
  assert.equal(claudeAppInstalled({ ...base, exists: () => false, readdir: listing({ [`${HOME}\\AppData\\Local\\Packages`]: ["Microsoft.Paint_8wekyb3d8bbwe"] }) }), false);
  assert.equal(claudeAppInstalled({ ...base, exists: () => false, readdir: listing({}) }), false);
});

test("the app's records read and written the same wherever they live", async (t) => {
  const records = fs.mkdtempSync(path.join(os.tmpdir(), "reach-claude-records-"));
  t.after(() => fs.rmSync(records, { recursive: true, force: true }));
  const org = path.join(records, "acct-1", "org-1");
  fs.mkdirSync(org, { recursive: true });
  const id = "11111111-2222-4333-8444-555555555555";
  const other = "66666666-7777-4888-8999-aaaaaaaaaaaa";
  const sample = { sessionId: `local_${other}`, cliSessionId: other, cwd: "C:\\Users\\me\\proj", createdAt: 1, lastActivityAt: 2, isArchived: false, permissionMode: "default", lastFocusedAt: 5 };
  fs.writeFileSync(path.join(org, `local_${other}.json`), JSON.stringify(sample));
  assert.equal(inClaudeApp(id, records), false);
  // The chat's folder as this computer writes one.
  assert.equal(writeClaudeRecord(id, { cwd: process.platform === "win32" ? "C:\\Users\\me\\proj" : "/Users/me/proj", title: "Fix the build" }, { records }), true);
  assert.equal(inClaudeApp(id, records), true);
  assert.deepEqual(claudeAppShown(records).map((s) => s.id), [other, id]);
  // Installed and used in the last month: signed in.
  const access = await claudeAppAccess({ records, installed: () => true });
  assert.deepEqual(access, { installed: true, signedIn: true });
  assert.deepEqual(await claudeAppAccess({ records, installed: () => false }), { installed: false, signedIn: false });
});

// Whether the Claude app runs on a Windows PC, and since when, from the PC's
// process list (windows-processes.mjs), as a Mac asks macOS for the app's own
// program: its path, never the name. Claude Code is claude.exe too, and so
// is each of the app's Electron helpers (audit #9).
const LOCAL = `${HOME}\\AppData\\Local`;
const APP = `${LOCAL}\\AnthropicClaude\\app-1.4.0\\claude.exe`;
const PACKAGED = "C:\\Program Files\\WindowsApps\\Claude_1.4.0.0_x64__pzs8sxrjxfjjc\\app\\Claude.exe";
const row = (pid, file, commandLine, startedAt) => ({ pid, ppid: 4, image: file ? path.win32.basename(file) : "claude.exe", path: file, commandLine, startedAt });
const DECOYS = [
  // Claude Code from its own installer, the app's copy of it in its data
  // folder (either install's), and Electron's helpers of the app itself.
  row(10, `${HOME}\\.local\\bin\\claude.exe`, `"${HOME}\\.local\\bin\\claude.exe" -p`, 1000),
  row(11, `${HOME}\\AppData\\Roaming\\Claude\\claude-code\\2.1.0\\claude.exe`, "claude.exe --output-format stream-json", 1100),
  row(12, `${LOCAL}\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude-code\\2.1.0\\claude.exe`, "claude.exe", 1150),
  row(13, APP, `"${APP}" --type=renderer --lang=en-US`, 900),
  row(14, APP, `"${APP}" --type=gpu-process`, 900),
  // Another account's: Windows won't say its path.
  row(15, null, null, null),
  // The installer's updater, and a folder of the same name somewhere else.
  row(16, `${LOCAL}\\AnthropicClaude\\Update.exe`, "Update.exe --processStart claude.exe", 700),
  row(17, "C:\\Tools\\AnthropicClaude\\claude.exe", "claude.exe", 600),
];

test("Windows: the Claude app is its installer's or its package's program, never Claude Code's claude.exe or an Electron helper", () => {
  const env = { LOCALAPPDATA: LOCAL };
  assert.deepEqual(claudeAppMain(DECOYS, { env }), [], "only lookalikes: not running");
  assert.deepEqual(claudeAppMain([...DECOYS, row(20, APP, `"${APP}"`, 2000)], { env }).map((p) => p.pid), [20]);
  assert.deepEqual(claudeAppMain([...DECOYS, row(21, PACKAGED, `"${PACKAGED}"`, 3000)], { env }).map((p) => p.pid), [21], "packaged (Microsoft Store, WinGet)");
  // The variable in any case, with a trailing backslash; unset, under the home folder.
  assert.deepEqual(claudeAppMain([row(20, APP, null, 2000)], { env: { localappdata: `${LOCAL}\\` } }).map((p) => p.pid), [20]);
  assert.deepEqual(claudeAppMain([row(20, APP, `"${APP}"`, 2000)], { env: {}, home: HOME }).map((p) => p.pid), [20]);
  // A package of another name isn't the app's.
  assert.deepEqual(claudeAppMain([row(22, "C:\\Program Files\\WindowsApps\\ClaudeHelper_1.0.0.0_x64__pzs8sxrjxfjjc\\claude.exe", "claude.exe", 1)], { env }), []);
});

test("Windows: running and its start from one process list; an unreadable list reads as closed, as a Mac's failed ps does", async () => {
  const open = async () => [...DECOYS, row(20, APP, `"${APP}"`, 2000)];
  const env = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = LOCAL;
  try {
    assert.equal(await claudeAppRunning(undefined, { platform: "win32", processes: open }), true);
    assert.equal(await claudeAppStartedAt(undefined, { platform: "win32", processes: open }), 2000, "the app's own start, not a helper's");
    assert.equal(await claudeAppRunning(undefined, { platform: "win32", processes: async () => DECOYS }), false);
    assert.equal(await claudeAppStartedAt(undefined, { platform: "win32", processes: async () => DECOYS }), null);
    const unreadable = async () => {
      throw Object.assign(new Error("Windows wouldn't list its processes (5)."), { code: "REACH_PROCESSES_UNCHECKED" });
    };
    assert.equal(await claudeAppRunning(undefined, { platform: "win32", processes: unreadable }), false);
    assert.equal(await claudeAppStartedAt(undefined, { platform: "win32", processes: unreadable }), null);
    // Its start not said: not known, never guessed.
    assert.equal(await claudeAppStartedAt(undefined, { platform: "win32", processes: async () => [row(20, APP, `"${APP}"`, null)] }), null);
  } finally {
    if (env === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = env;
  }
});

// The Mac reloads the app's window (View > Reload) so it shows Reach's
// replies; a PC has nothing to reload it with yet, so the request is let go
// at once, never tried again every round.
test("a refresh with nothing to reload the app's window with is let go at once", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-claude-refresh-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "claude-refresh.json");
  let asked = 0;
  const refresh = createClaudeRefresh({
    file,
    open: async () => assert.fail("opened a chat"),
    reload: null,
    startedAt: async () => (asked++, 1),
    shown: () => [{ id: "11111111-2222-4333-8444-555555555555", session: "local_11111111-2222-4333-8444-555555555555", at: 2 }],
    idle: async () => 600,
    resume: false,
  });
  t.after(() => refresh.close());
  await refresh.add("11111111-2222-4333-8444-555555555555");
  assert.deepEqual(refresh.pending(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), []);
  assert.equal(asked, 0, "the app isn't even asked about");
});

const realWindows = process.platform === "win32" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1";
test("on real Windows, the PC's own list tells the app from Claude Code and the app's helpers", { skip: !realWindows && "needs a real Windows PC (REACH_TEST_WINDOWS_DESKTOP=1)", timeout: 240000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach claude app-"));
  const local = path.join(root, "Local");
  // Node, copied where each would be and named as each is.
  const app = path.join(local, "AnthropicClaude", "app-1.4.0", "claude.exe");
  const cli = path.join(root, ".local", "bin", "claude.exe");
  for (const file of [app, cli]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(process.execPath, file);
  }
  const before = Date.now();
  const idle = ["-e", "setTimeout(() => {}, 120000)"];
  const children = [spawn(app, idle), spawn(app, [...idle, "--type=renderer"]), spawn(cli, idle)].map((child) => child);
  t.after(async () => {
    for (const child of children) child.kill();
    await Promise.all(children.map((child) => (child.exitCode === null && child.signalCode === null ? once(child, "exit") : null)));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await Promise.all(children.map((child) => once(child, "spawn")));
  const nativeDir = path.join(root, "native");
  const rows = await windowsProcesses({ nativeDir });
  const main = claudeAppMain(rows, { env: { LOCALAPPDATA: local } });
  assert.deepEqual(main.map((p) => p.pid), [children[0].pid], JSON.stringify(rows.filter((r) => /claude/i.test(r.image))));
  assert.ok(main[0].startedAt >= before - 5000 && main[0].startedAt <= Date.now() + 5000, `started when it was (${main[0].startedAt} vs ${before})`);
  // The server's own reading builds its helper in the folder it's given, and
  // this runner has no Claude app.
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  useProcessesFolder(dataDir);
  t.after(() => useProcessesFolder(null));
  assert.equal(await claudeAppRunning(), false);
  assert.equal(await claudeAppStartedAt(), null);
  assert.ok(fs.readdirSync(dataDir).some((name) => /^reach-processes-[0-9a-f]{12}\.exe$/.test(name)), "the list was read, not refused");
});

// Claude Code on Windows notes its process's start as Windows keeps it
// (GetProcessTimes, 100 ns since 1601: procStartFt); Reach's list gives ms
// since 1970. The same moment, to the millisecond, or a live chat would read
// as let go (processes.mjs liveClaudeSessions).
test("on real Windows, a start as Claude Code notes it is the PC's list's start to the millisecond", { skip: !realWindows && "needs a real Windows PC (REACH_TEST_WINDOWS_DESKTOP=1)", timeout: 240000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach claude start-"));
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore", windowsHide: true });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    fs.rmSync(root, { recursive: true, force: true });
  });
  await once(child, "spawn");
  const { execFile } = await import("node:child_process");
  const ticks = await new Promise((resolve, reject) =>
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${child.pid}).StartTime.ToFileTimeUtc()`], { windowsHide: true, timeout: 60000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout).trim()))),
  );
  assert.match(ticks, /^\d{17,18}$/);
  const listed = (await windowsProcesses({ nativeDir: path.join(root, "native") })).find((p) => p.pid === child.pid);
  assert.ok(listed, "the child is listed");
  assert.equal(windowsStart(ticks), listed.startedAt);
});
