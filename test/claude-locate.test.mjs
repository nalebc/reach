import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeSessions } from "../server/agent-sessions/claude.mjs";
import { claudeInstallLocations, forgetClaudeMiss, locateClaude } from "../server/agent-sessions/index.mjs";

// The phone said "Claude Code isn't installed on this Mac" while it was: Reach
// had been started with a PATH without ~/.local/bin, and the check looked
// only there (Reach's own Claude runner already asked the login shell).
test("Claude Code found where the login shell finds it reads as installed, not missing", async () => {
  const ran = [];
  const missing = Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" });
  const run = async (file, args) => {
    ran.push(file);
    if (file === "claude") throw missing;
    if (args[0] === "auth") return { stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai" }) };
    return { stdout: "2.1.291 (Claude Code)" };
  };
  const health = await createClaudeSessions({ run, locateCli: async () => "/Users/me/.local/bin/claude", projects: "/nonexistent" }).health();
  assert.equal(health.installed, true);
  assert.deepEqual(ran.slice(0, 2), ["claude", "/Users/me/.local/bin/claude"]);
  // Not there either: not installed, as before.
  const none = await createClaudeSessions({ run: async () => { throw missing; }, locateCli: async () => null, projects: "/nonexistent" }).health();
  assert.deepEqual(none, { agent: "claude", installed: false, signedIn: false });
});

test("not on PATH: Claude Code is found where its installer and the Claude app put it", async () => {
  // Oct 12: a fresh install (~/.local/bin not on the shell's PATH yet) or the
  // Claude app alone read as "not installed".
  const tree = {
    "/Users/me/Library/Application Support/Claude/claude-code": ["2.1.293", "2.1.295", "notes"],
    "/Users/me/Library/Application Support/Claude/claude-code/2.1.295": ["9d64", "half"],
    "/Users/me/Library/Application Support/Claude/claude-code/2.1.293": ["8433"],
  };
  const verified = new Set([
    "/Users/me/Library/Application Support/Claude/claude-code/2.1.295/9d64/.verified",
    "/Users/me/Library/Application Support/Claude/claude-code/2.1.293/8433/.verified",
  ]);
  const readdir = (dir) => { if (!tree[dir]) throw Object.assign(Error("ENOENT"), { code: "ENOENT" }); return tree[dir]; };
  const mac = claudeInstallLocations({ platform: "darwin", env: {}, home: "/Users/me", readdir, exists: (f) => verified.has(f) });
  assert.deepEqual(mac, [
    "/Users/me/.local/bin/claude",
    "/Users/me/.claude/local/claude",
    "/Users/me/Library/Application Support/Claude/claude-code/2.1.295/9d64/claude.app/Contents/MacOS/claude",
    "/Users/me/Library/Application Support/Claude/claude-code/2.1.293/8433/claude.app/Contents/MacOS/claude",
  ], "the installer's folders, then the app's verified copies, newest first; an unverified one never");
  // The same on Windows (its installer's folder is on findWindowsCli's list).
  const winTree = { "C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code": ["2.1.295"], "C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code\\2.1.295": ["9d64"] };
  const win = claudeInstallLocations({ platform: "win32", env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, home: "C:\\Users\\me",
    readdir: (dir) => { if (!winTree[dir]) throw Error("ENOENT"); return winTree[dir]; },
    exists: (f) => f === "C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code\\2.1.295\\9d64\\.verified" });
  assert.deepEqual(win, ["C:\\Users\\me\\AppData\\Roaming\\Claude\\claude-code\\2.1.295\\9d64\\claude.exe"]);

  // The shell doesn't know it: the first location that runs is used.
  forgetClaudeMiss();
  const shell = async () => ({ stdout: "" });
  const found = await locateClaude(shell, { platform: "darwin", env: {}, home: "/Users/me", now: () => 1e12,
    locations: () => mac, isRunnable: (file) => file === mac[2] });
  assert.equal(found, mac[2]);
});
