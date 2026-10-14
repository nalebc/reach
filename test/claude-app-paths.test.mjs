import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAppData, claudeAppDataDirs, claudeAppInstalled, claudeAppRecords } from "../server/agent-sessions/claude-app-paths.mjs";
import { claudeAppAccess, claudeAppShown, inClaudeApp, writeClaudeRecord } from "../server/agent-sessions/claude-import.mjs";

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
