import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowsPresence } from "../server/windows-presence.mjs";
import { idleSeconds, screenLocked } from "../server/agent-sessions/claude-import.mjs";

// A Windows PC's idle time and lock state (scripts/native/presence.cs), the
// twins of the Mac's ioreg readings: what Reach asks before switching the
// Claude app's window while nobody is at the computer.
const fake = (stdout) => ({
  build: async ({ dataDir }, kind) => {
    assert.equal(kind, "presence");
    return path.join(dataDir, "reach-presence-abc.exe");
  },
  run: async (file, args, options) => {
    assert.deepEqual(args, []);
    assert.equal(options.windowsHide, true);
    return { stdout };
  },
});

test("its line read as seconds and a lock state; what Windows didn't say stays null", async () => {
  assert.deepEqual(await windowsPresence({ dataDir: "C:\\r", ...fake('{"idleMs":125000,"locked":false}\r\n') }), { idleSeconds: 125, locked: false });
  assert.deepEqual(await windowsPresence({ dataDir: "C:\\r", ...fake('{"idleMs":null,"locked":null}\n') }), { idleSeconds: null, locked: null });
  assert.deepEqual(await windowsPresence({ dataDir: "C:\\r", ...fake('{"idleMs":-5,"locked":"yes"}\n') }), { idleSeconds: null, locked: null });
  await assert.rejects(windowsPresence({ dataDir: "C:\\r", ...fake("not json") }));
  await assert.rejects(windowsPresence({ dataDir: null, ...fake("{}") }), /data folder/);
});

test("the Claude app's idle and lock checks use it on Windows, ioreg on a Mac", async () => {
  const presence = async () => ({ idleSeconds: 42, locked: true });
  assert.equal(await idleSeconds(undefined, { platform: "win32", presence }), 42);
  assert.equal(await screenLocked(undefined, { platform: "win32", presence }), true);
  const ioreg = async (file) => {
    assert.equal(file, "/usr/sbin/ioreg");
    return { stdout: '"HIDIdleTime" = 3000000000\n"CGSSessionScreenIsLocked"=No' };
  };
  assert.equal(await idleSeconds(ioreg, { platform: "darwin", presence: () => assert.fail("not on a Mac") }), 3);
  assert.equal(await screenLocked(ioreg, { platform: "darwin", presence: () => assert.fail("not on a Mac") }), false);
  // Windows wouldn't say: unknown, which never counts as "nobody's here".
  assert.equal(await idleSeconds(undefined, { platform: "win32", presence: async () => ({ idleSeconds: null, locked: null }) }), null);
});

test("on a real Windows PC: built with its own C# compiler, it answers", { skip: process.platform !== "win32", timeout: 180000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-presence-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const first = await windowsPresence({ dataDir });
  assert.ok(Number.isFinite(first.idleSeconds) && first.idleSeconds >= 0, JSON.stringify(first));
  assert.ok(first.locked === false || first.locked === null, `an unattended runner isn't locked: ${JSON.stringify(first)}`);
  // Built once: the next reading uses the same helper.
  const built = fs.readdirSync(dataDir).filter((f) => /^reach-presence-[0-9a-f]{12}\.exe$/.test(f));
  assert.equal(built.length, 1);
  const second = await windowsPresence({ dataDir });
  assert.ok(second.idleSeconds >= 0);
  assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith(".exe")), built);
});
