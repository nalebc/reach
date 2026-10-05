import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  claudeAppAccess,
  claudeAppRunning,
  claudeAppShown,
  claudeAppStartedAt,
  createClaudeImports,
  createClaudeRefresh,
  idleSeconds,
  inClaudeApp,
  reloadClaudeWindow,
} from "../server/agent-sessions/claude-import.mjs";

const A = "1fa82f5d-07e5-459c-a5fd-61368b3423c5";
const B = "8f3a3707-0000-4000-8000-000000000001";
const C = "9face8d1-0000-4000-8000-000000000002";
const settle = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const link = (id) => [`claude://resume?session=${id}`, { background: true }];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "reach-imports-"));

test("a session started from Reach joins the Claude app only while nobody is at the Mac and the app is open", async () => {
  const file = path.join(tmp(), "claude-imports.json");
  const mac = { idle: 5, running: true, inApp: new Set() };
  const opened = [];
  const imports = createClaudeImports({
    file,
    open: async (...args) => opened.push(args),
    idle: async () => mac.idle,
    appRunning: async () => mac.running,
    imported: (id) => mac.inApp.has(id),
    everyMs: 15,
    resume: false,
  });
  // In use: it waits, and is written down.
  await imports.add(A);
  assert.deepEqual(opened, []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [A]);
  // Away, but the app is closed: Reach never opens it.
  mac.idle = 600;
  mac.running = false;
  await imports.check();
  assert.deepEqual(opened, []);
  // Away and open: imported on the next round, once.
  mac.running = true;
  await settle(60);
  assert.deepEqual(opened, [link(A)]);
  assert.deepEqual(imports.pending(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), []);
  // One the app already lists is dropped without opening anything.
  mac.idle = 5;
  mac.inApp.add(B);
  await imports.add(B);
  assert.deepEqual(imports.pending(), []);
  assert.deepEqual(opened, [link(A)]);
  // Not a session id: ignored.
  await imports.add("../../etc");
  assert.deepEqual(imports.pending(), []);
  imports.close();
});

test("waiting imports survive a restart, and stop when Reach quits", async () => {
  const file = path.join(tmp(), "claude-imports.json");
  fs.writeFileSync(file, JSON.stringify([C, "not-an-id"]));
  const opened = [];
  const imports = createClaudeImports({
    file,
    open: async (...args) => opened.push(args),
    idle: async () => 600,
    appRunning: async () => true,
    imported: () => false,
  });
  await settle(20);
  assert.deepEqual(opened, [link(C)]);
  imports.close();

  fs.writeFileSync(file, JSON.stringify([C]));
  let looks = 0;
  const quitting = createClaudeImports({
    file,
    open: async () => assert.fail("opened after quitting"),
    idle: async () => (looks++, 5),
    appRunning: async () => true,
    imported: () => false,
    everyMs: 5,
  });
  quitting.close();
  await settle(30);
  assert.equal(looks, 0);
});

test("the Mac's idle time, the Claude app, and the app's own list are read as macOS gives them", async () => {
  const ioreg = async () => ({ stdout: '  |   "HIDIdleTime" = 308700085791\n  |   "HIDIdleTimeDelta" = 1\n' });
  assert.equal(await idleSeconds(ioreg), 308.700085791);
  assert.equal(await idleSeconds(async () => ({ stdout: "" })), null);

  const ps = (lines) => async () => ({ stdout: lines.join("\n") });
  assert.equal(
    await claudeAppRunning(ps(["/Applications/Claude.app/Contents/MacOS/Claude", "/usr/sbin/cfprefsd"])),
    true,
  );
  // Claude Code processes (the app's own copy, the CLI) aren't the app.
  assert.equal(
    await claudeAppRunning(
      ps(["/Users/me/Library/Application Support/Claude/claude-code/2.1.286/x/claude.app/Contents/MacOS/claude", "/Users/me/.local/bin/claude"]),
    ),
    false,
  );
  assert.equal(await claudeAppRunning(async () => Promise.reject(new Error("ps failed"))), false);

  const records = tmp();
  fs.mkdirSync(path.join(records, "account", "org"), { recursive: true });
  fs.writeFileSync(path.join(records, "account", "org", `local_${A}.json`), "{}");
  assert.equal(inClaudeApp(A, records), true);
  assert.equal(inClaudeApp(B, records), false);
  assert.equal(inClaudeApp(A, path.join(records, "missing")), false);
});

test("the Claude app's own sign-in is read from what it does, never from its credentials", async () => {
  const dir = tmp();
  const app = path.join(dir, "Claude.app");
  const records = path.join(dir, "claude-code-sessions");
  const now = Date.now();
  assert.deepEqual(await claudeAppAccess({ app, records }), { installed: false, signedIn: false });
  fs.mkdirSync(app);
  // Installed, never used: not signed in.
  assert.deepEqual(await claudeAppAccess({ app, records }), { installed: true, signedIn: false });
  // Running its own Claude Code sessions: signed in.
  const registry = () => new Map([["s1", { where: "claude-app", pid: 1 }]]);
  assert.deepEqual(await claudeAppAccess({ app, records, registry }), { installed: true, signedIn: true });
  // An account's session folder used lately: signed in; one left for months: not.
  fs.mkdirSync(path.join(records, "account-1"), { recursive: true });
  assert.deepEqual(await claudeAppAccess({ app, records, now: () => now }), { installed: true, signedIn: true });
  assert.deepEqual(await claudeAppAccess({ app, records, now: () => now + 60 * 86400000 }), { installed: true, signedIn: false });
});

// The Claude app's own list: when it opened, and when each session was last on screen.
const appState = (shown) => ({
  startedAt: async () => 1000,
  shown: () => shown.map(([id, at]) => ({ id, session: `local_${id}`, at })),
});

test("after Reach replies in a session the Claude app has shown, its window reloads once nobody is at the Mac, back on the session it showed", async () => {
  const file = path.join(tmp(), "claude-refresh.json");
  const mac = { idle: 5, asking: false };
  // B is on screen; A was shown earlier, since the app opened.
  let shown = [
    [B, 3000],
    [A, 2000],
  ];
  const reloads = [];
  const opened = [];
  const refresh = createClaudeRefresh({
    file,
    open: async (...args) => opened.push(args),
    idle: async () => mac.idle,
    ...appState([]),
    shown: () => appState(shown).shown(),
    asking: () => mac.asking,
    // The reload opens a session of its own choosing.
    reload: async () => {
      reloads.push(Date.now());
      shown = [[C, 4000], ...shown];
    },
    settleMs: 5,
    everyMs: 15,
    resume: false,
  });
  // In use: it waits, and is written down.
  await refresh.add(A);
  assert.equal(reloads.length, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [A]);
  // Away, but the app is asking something: not now.
  mac.idle = 600;
  mac.asking = true;
  await refresh.check();
  assert.equal(reloads.length, 0);
  // Away: reloaded once, then put back on the session it was showing.
  mac.asking = false;
  await settle(60);
  assert.equal(reloads.length, 1);
  assert.deepEqual(opened, [[`claude://code/continue?session=local_${B}`]]);
  assert.deepEqual(refresh.pending(), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), []);
  await settle(40);
  assert.equal(reloads.length, 1, "once");
  refresh.close();

  // A reload that keeps the session on screen opens nothing.
  const still = createClaudeRefresh({
    file: path.join(tmp(), "claude-refresh.json"),
    open: async () => assert.fail("opened a session"),
    idle: async () => 600,
    ...appState([[A, 2000]]),
    reload: async () => reloads.push(Date.now()),
    settleMs: 5,
    resume: false,
  });
  await still.add(A);
  assert.equal(reloads.length, 2);
  still.close();
});

test("the Claude app's window is left alone when it hasn't shown the session since it opened, or is closed", async () => {
  const reload = async () => assert.fail("reloaded");
  const quiet = (options) =>
    createClaudeRefresh({
      file: path.join(tmp(), "claude-refresh.json"),
      open: async () => assert.fail("opened"),
      idle: async () => 600,
      reload,
      settleMs: 5,
      resume: false,
      ...options,
    });
  // Shown before the app opened (it reads it afresh when it shows it again).
  const before = quiet(appState([[A, 500]]));
  await before.add(A);
  assert.deepEqual(before.pending(), []);
  // Not in the app's list at all.
  const unknown = quiet(appState([[B, 2000]]));
  await unknown.add(A);
  assert.deepEqual(unknown.pending(), []);
  // The app is closed: it reads everything when it opens.
  const closed = quiet({ ...appState([[A, 2000]]), startedAt: async () => null });
  await closed.add(A);
  assert.deepEqual(closed.pending(), []);
  // Not a session id: ignored.
  await closed.add("../../etc");
  assert.deepEqual(closed.pending(), []);
});

test("a window reload waiting at a restart happens after it, and none after Reach quits", async () => {
  const file = path.join(tmp(), "claude-refresh.json");
  fs.writeFileSync(file, JSON.stringify([A, "not-an-id"]));
  let reloads = 0;
  const refresh = createClaudeRefresh({
    file,
    open: async () => {},
    idle: async () => 600,
    ...appState([[A, 2000]]),
    reload: async () => reloads++,
    settleMs: 5,
  });
  await settle(30);
  assert.equal(reloads, 1);
  refresh.close();

  fs.writeFileSync(file, JSON.stringify([A]));
  const quitting = createClaudeRefresh({
    file,
    open: async () => {},
    idle: async () => 600,
    ...appState([[A, 2000]]),
    reload: async () => assert.fail("reloaded after quitting"),
    everyMs: 5,
  });
  quitting.close();
  await settle(30);
});

test("the Claude app's opening time, its sessions on screen, and its Reload are read and pressed as macOS gives them", async () => {
  const ps = async () => ({
    stdout: [
      "Mon Oct  5 03:29:13 2026     /Applications/Claude.app/Contents/MacOS/Claude",
      "Mon Oct  5 07:28:15 2026     /Users/me/Library/Application Support/Claude/claude-code/2.1.286/x/claude.app/Contents/MacOS/claude",
    ].join("\n"),
  });
  assert.equal(await claudeAppStartedAt(ps), new Date(2026, 9, 5, 3, 29, 13).getTime());
  assert.equal(await claudeAppStartedAt(async () => ({ stdout: "Mon Oct  5 07:28:15 2026     /Users/me/.local/bin/claude\n" })), null);
  assert.equal(await claudeAppStartedAt(async () => Promise.reject(new Error("ps failed"))), null);

  const records = tmp();
  const org = path.join(records, "account", "org");
  fs.mkdirSync(org, { recursive: true });
  const record = (id, at) =>
    fs.writeFileSync(path.join(org, `local_${id}.json`), JSON.stringify({ sessionId: `local_${id}`, cliSessionId: id, lastFocusedAt: at }));
  record(A, 2000);
  record(B, 3000);
  record(C, undefined);
  fs.writeFileSync(path.join(org, "local_broken.json"), "{");
  assert.deepEqual(claudeAppShown(records), [
    { id: B, session: `local_${B}`, at: 3000 },
    { id: A, session: `local_${A}`, at: 2000 },
    { id: C, session: `local_${C}`, at: 0 },
  ]);
  assert.deepEqual(claudeAppShown(path.join(records, "missing")), []);

  const runs = [];
  await reloadClaudeWindow(async (...args) => (runs.push(args), { stdout: "" }));
  assert.equal(runs[0][0], "/usr/bin/osascript");
  assert.match(runs[0][1][1], /bundle identifier is "com\.anthropic\.claudefordesktop"/);
  assert.match(runs[0][1][1], /click menu item "Reload" of menu 1 of menu bar item "View"/);
});
