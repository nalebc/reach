import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeAppRunning, createClaudeImports, idleSeconds, inClaudeApp } from "../server/agent-sessions/claude-import.mjs";

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
