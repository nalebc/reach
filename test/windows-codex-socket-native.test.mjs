import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { assertUnchanged, windowsHelper } from "../server/desktop-native.mjs";
import { accountSid } from "../server/windows-private-folder.mjs";
import { windowsHelperEnv, systemRoot } from "../server/windows-helper-launch.mjs";
import { COLD_START_MS, cleanPowerShellEnv, powershellFile } from "../server/powershell.mjs";

const exec = promisify(execFile);
// These are actual Windows filesystem/security API checks, without injected
// ACL answers or a fabricated platform. They are not actual Codex peer or
// browser/device validation. Other operating systems explicitly skip them.
test("native Windows Codex bridge refuses real unsafe NTFS rendezvous directories without repairing them", {
  skip: process.platform !== "win32" && "requires actual Windows NTFS and .NET Framework",
  timeout: 120000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rcx-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const system = path.win32.join(systemRoot(), "System32");
  const { stdout } = await exec(path.win32.join(system, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], { windowsHide: true, timeout: 10000 });
  const sid = accountSid(stdout);
  assert.match(sid, /^S-1-5-21-/u);
  const helper = await windowsHelper("codex-socket", { dir: root, fresh: true });
  assertUnchanged(helper.file, helper.sha256);
  const fixture = path.resolve("test/fixtures/windows/codex-socket-directory.ps1");
  const names = ["broad", "unprotected", "noninheritable", "readonly", "private", "valid"];
  for (const name of names) await fs.mkdir(path.join(root, name));
  const fixtureEnv = { ...process.env };
  cleanPowerShellEnv(fixtureEnv);
  const setupAt = performance.now();
  try {
    // The first genuine runner timed out before each native call: six separate
    // 20 s PowerShell starts. Batch setup once, refuse prompts, and use Reach's
    // existing bounded cold-start allowance, with actual phase diagnostics.
    const setup = await exec(path.win32.join(system, "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NonInteractive", ...powershellFile(fixture, ["-FixtureRoot", root, "-Sid", sid])],
      { env: fixtureEnv, windowsHide: true, timeout: COLD_START_MS, maxBuffer: 65536 });
    const actual = JSON.parse(setup.stdout.trim());
    assert.equal(actual.schema, 1);
    assert.deepEqual(Object.keys(actual.directories), names);
    for (const name of names) {
      assert.equal(actual.directories[name].owner, sid);
      assert.equal(actual.directories[name].protected, name !== "unprotected");
      assert.match(actual.directories[name].sddl, /^O:/u);
    }
    console.info(`Windows ACL fixture: ${Math.round(performance.now() - setupAt)} ms including process startup; ${actual.elapsedMs} ms inside fixture.`);
  } catch (error) {
    const phase = String(error.stderr || "no fixture phase reached").trim();
    throw new Error(`Windows ACL fixture setup failed before native checks after ${Math.round(performance.now() - setupAt)} ms (code ${error.code || "none"}, killed ${!!error.killed}, signal ${error.signal || "none"}): ${phase}`, { cause: error });
  }
  async function refusal(endpoint, reason) {
    assertUnchanged(helper.file, helper.sha256);
    await assert.rejects(exec(helper.file, [endpoint, String(process.pid)], { windowsHide: true, env: windowsHelperEnv(), timeout: 10000, maxBuffer: 65536 }), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "", "a refused helper emits no socket payload on stdout");
      assert.equal(error.stderr, `error ${reason}\n`);
      return true;
    });
  }
  for (const mode of ["broad", "unprotected", "noninheritable", "readonly"]) await t.test(`actual ${mode} directory ACL is rejected unchanged`, async () => {
    const directory = path.join(root, mode);
    const before = await exec(path.win32.join(system, "icacls.exe"), [directory], { windowsHide: true, timeout: 10000 });
    await refusal(path.join(directory, "s"), "acl");
    const after = await exec(path.win32.join(system, "icacls.exe"), [directory], { windowsHide: true, timeout: 10000 });
    assert.equal(after.stdout, before.stdout, "a refused daemon directory is never repaired");
  });
  await t.test("an actual final-directory junction is rejected before connection", async () => {
    const directory = path.join(root, "private"), junction = path.join(root, "junction");
    await fs.symlink(directory, junction, "junction");
    await refusal(path.join(junction, "s"), "reparse");
    assert.ok((await fs.lstat(junction)).isSymbolicLink());
  });
  await t.test("the exact private ACL passes directory validation but a missing actual socket still fails closed", async () => {
    const directory = path.join(root, "valid");
    // This expects only a connection failure, which distinguishes genuine
    // successful ACL validation from an unrelated elevated-token refusal.
    await refusal(path.join(directory, "s"), "connection");
  });
});
