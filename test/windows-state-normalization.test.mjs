import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { accountSid } from "../server/windows-private-folder.mjs";
import { assertUnchanged, cscCandidates, windowsHelper } from "../server/desktop-native.mjs";
import { createWindowsPrivateStage } from "../server/windows-private-stage.mjs";

const exec = promisify(execFile);
const enabled = process.platform === "win32" && process.env.CI === "true" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1"
  && process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted";

// Genuine hosted NTFS, PowerShell/.NET bootstrap and native production core.
// The older tree and foreign account are controlled disposable fixtures. This
// does not identify a friend's ACL or qualify an authenticated browser login.
test("actual Windows retained-handle state normalization", {
  skip: enabled ? false : "disposable GitHub-hosted Windows runner only", timeout: 300000,
}, async (t) => {
  const system = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const powershell = path.win32.join(system, "WindowsPowerShell", "v1.0", "powershell.exe");
  const report = { schema: 1, head: process.env.GITHUB_SHA || null, actualWindows: true, physicalDevice: false, node: process.version,
    scope: "Controlled actual NTFS component regression; not an installed upgrade or authenticated browser acceptance",
    production: Object.fromEntries(["scripts/native/private-state.cs", "scripts/native/private-folder.cs", "server/windows-private-stage.mjs"].map(file =>
      [file, crypto.createHash("sha256").update(readFileSync(file)).digest("hex")])), cases: [] };
  const run = async (file, args, options = {}) => {
    try { return await exec(file, args, { timeout: 120000, maxBuffer: 4 << 20, windowsHide: true, ...options }); }
    catch (error) { throw new Error(`${path.basename(file)} failed (${error.code}): ${error.stdout || ""}${error.stderr || ""}`); }
  };
  const sid = accountSid((await run(path.win32.join(system, "whoami.exe"), ["/user", "/fo", "csv", "/nh"])).stdout);
  assert.match(sid, /^S-1-5-21-/);
  const profile = (await run(powershell, ["-NoProfile", "-NonInteractive", "-Command", "[Console]::Out.WriteLine([Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile))"])).stdout.trim();
  assert.ok(!/~\d/.test(profile), "actual KnownFolder long path, not RUNNER~1 temp alias");
  const root = await fs.mkdtemp(path.join(profile, "reach-existing-state-"));
  const stages = [], junctions = [];
  const user = `ReachAcl${crypto.randomBytes(4).toString("hex")}`;
  let createdUser = false;
  t.after(async () => {
    try {
      if (createdUser) await run(path.win32.join(system, "net.exe"), ["user", user, "/delete"]);
      for (const junction of junctions) await fs.unlink(junction).catch(() => {});
      for (const stage of stages) await fs.rm(stage, { recursive: true, force: true, maxRetries: 5 });
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
      report.cleanup = { ok: true };
    } catch (error) { report.cleanup = { ok: false, message: error.message }; throw error; }
    finally { await fs.mkdir("reports", { recursive: true }); await fs.writeFile("reports/windows-state-normalization.json", `${JSON.stringify(report, null, 2)}\n`); }
  });
  const stage = await createWindowsPrivateStage({ sid });
  stages.push(stage.dir); report.stage = stage;
  const core = await windowsHelper("private-state", { dir: stage.dir, fresh: true });
  const checker = await windowsHelper("private-folder", { dir: stage.dir, fresh: true });
  const compiler = cscCandidates().find(file => existsSync(file));
  assert.ok(compiler);
  const fixture = path.join(stage.dir, "acl-fixture.exe");
  await run(compiler, ["/nologo", "/noconfig", "/target:exe", "/platform:anycpu", `/out:${fixture}`,
    `/reference:${path.join(path.dirname(compiler), "System.dll")}`, `/reference:${path.join(path.dirname(compiler), "System.Web.Extensions.dll")}`,
    path.resolve("test/fixtures/windows/existing-state-acl.cs")]);
  const password = `${crypto.randomBytes(24).toString("hex")}Aa1!`;
  await run(path.win32.join(system, "net.exe"), ["user", user, password, "/add", "/Y"]); createdUser = true;
  const foreignSid = (await run(fixture, ["sid", user])).stdout.trim();
  assert.match(foreignSid, /^S-1-5-21-/); assert.notEqual(foreignSid, sid);
  report.account = { sid, foreignSid };
  const check = async (...roots) => {
    assertUnchanged(checker.file, checker.sha256);
    return (await run(checker.file, [sid, "state", ...roots])).stdout.trim();
  };
  assert.equal(await check(stage.dir), "ok", "real freshly built read-only checker accepts the bootstrap stage");
  const snapshot = async generated => JSON.parse((await run(fixture, ["snapshot", generated])).stdout);
  for (const [mode, expected] of [["private-parent", true], ["private-deny-parent", true], ["foreign-parent-owner", false],
    ["broad-write-parent", false], ["parent-junction", false], ["ancestor-junction", false]]) await t.test(`staging ${mode}`, async () => {
    const generated = await fs.mkdtemp(path.join(root, "reach-existing-state-"));
    const fixtureMode = mode === "broad-write-parent" ? "broad-directory-write" : mode === "private-deny-parent" ? "private-directory-deny" : "private";
    await run(fixture, ["setup", generated, fixtureMode, foreignSid]);
    let parent = path.join(generated, "state");
    if (mode === "foreign-parent-owner") await run(path.win32.join(system, "icacls.exe"), [parent, "/setowner", `*${foreignSid}`, "/Q"]);
    if (mode === "parent-junction" || mode === "ancestor-junction") {
      const target = path.join(generated, "outside"), junction = path.join(generated, "staging-link");
      await fs.mkdir(path.join(target, "nested"));
      await run(path.win32.join(system, "icacls.exe"), [target, "/setowner", `*${foreignSid}`, "/Q"]);
      await fs.symlink(target, junction, "junction"); junctions.push(junction);
      parent = mode === "parent-junction" ? junction : path.join(junction, "nested");
    }
    const before = await snapshot(generated);
    const item = { mode: `staging-${mode}`, expected, before }; report.cases.push(item);
    let made;
    if (expected) { made = await createWindowsPrivateStage({ sid, parent }); stages.push(made.dir); item.stage = made; assert.equal(await check(made.dir), "ok"); }
    else await assert.rejects(createWindowsPrivateStage({ sid, parent }), { code: "EPRIVATESTAGE" });
    item.after = await snapshot(generated);
    for (const entry of before.entries) assert.equal(item.after.entries.find(candidate => candidate.path === entry.path)?.sddl, entry.sddl, "bootstrap never changes existing ACLs");
    item.passed = true;
  });
  const cases = [["fresh", true], ["private", true], ["inherited", true], ["file-explicit", true], ["file-protected", true],
    ["directory-explicit", true], ["directory-protected", true], ["owner-rights-file", true], ["owner-rights-directory", true],
    ["private-deny", true], ["foreign-owner-rights", false, "owner"], ["foreign-ace", false, "ace"],
    ["broad-write", false, "write"], ["broad-deny", false, "deny"], ["hardlink", false, "hardlink"],
    ["junction", false, "reparse"], ["native-junction", false, "reparse"], ["root-junction", false, "reparse"]];
  for (const [mode, expected, reason] of cases) await t.test(mode, { timeout: 120000 }, async () => {
    const generated = await fs.mkdtemp(path.join(root, "reach-existing-state-"));
    const item = { mode, expected, root: generated }; report.cases.push(item);
    await run(fixture, ["setup", generated, mode, foreignSid]);
    const state = path.join(generated, "state"), data = path.join(state, "quick"), legacy = path.join(state, "history", "legacy.json");
    if (mode === "foreign-owner-rights") {
      await run(path.win32.join(system, "icacls.exe"), [legacy, "/setowner", `*${foreignSid}`, "/Q"]);
      await run(fixture, ["owner-rights", generated]);
    }
    if (mode === "hardlink") await fs.link(path.join(generated, "outside", "keep.txt"), path.join(state, "history", "outside-hardlink"));
    if (["junction", "native-junction", "root-junction"].includes(mode)) {
      const junction = mode === "native-junction" ? path.join(state, "native") : mode === "root-junction" ? state : path.join(state, "outside-link");
      if (mode === "root-junction") await fs.rm(state, { recursive: true });
      await fs.symlink(path.join(generated, "outside"), junction, "junction"); junctions.push(junction); item.junction = junction;
    }
    item.before = await snapshot(generated);
    const old = item.before.entries.find(entry => entry.path === legacy);
    if (mode === "foreign-owner-rights") {
      assert.equal(old.owner, foreignSid);
      assert.ok(old.rules.some(rule => rule.sid === "S-1-3-4" && rule.type === "Allow" && !rule.inherited));
    } else if (old) assert.equal(old.owner, sid);
    if (mode === "private-deny") {
      assert.ok(old.rules.some(rule => rule.sid === "S-1-3-4" && rule.type === "Allow" && rule.propagation === "None"));
      assert.deepEqual(old.readControlAccess, { ok: true, error: 0 }, "actual READ_CONTROL open succeeds");
      assert.deepEqual(old.writeDacAccess, { ok: false, error: 5 }, "actual WRITE_DAC open denied, including owner's implicit-access handling");
    }
    const oldBytes = await fs.readFile(legacy).catch(() => null), outside = path.join(generated, "outside", "keep.txt"), outsideBytes = await fs.readFile(outside);
    assertUnchanged(core.file, core.sha256);
    item.answer = (await run(core.file, [sid, state, data])).stdout.trim();
    item.after = await snapshot(generated);
    assert.equal(item.answer === "ok", expected, JSON.stringify(item));
    if (reason) assert.match(item.answer, new RegExp(`^open [01] ${reason} `));
    if (expected) {
      assert.equal(await check(state, data), "ok", "independent fresh production recursive checker after normalization");
      assert.equal((await fs.stat(state)).isDirectory(), true); assert.equal((await fs.stat(data)).isDirectory(), true);
      const roots = item.after.entries.filter(entry => entry.path === state || entry.path === data);
      assert.equal(roots.length, 2, "both requested roots exist");
      assert.ok(roots.every(entry => entry.protected), "ordinary requested roots retain inheritance barriers");
    } else {
      for (const entry of item.before.entries) {
        const after = item.after.entries.find(candidate => candidate.path === entry.path);
        assert.equal(after?.sddl, entry.sddl, "whole-forest refusal changes no existing descriptor");
      }
    }
    if (mode === "private-deny") {
      const after = item.after.entries.find(entry => entry.path === legacy);
      assert.equal(after.sddl, old.sddl, "private DENY object is untouched and verifies without WRITE_DAC");
    }
    if (oldBytes) assert.deepEqual(await fs.readFile(legacy), oldBytes);
    assert.deepEqual(await fs.readFile(outside), outsideBytes);
    for (const entry of item.before.entries.filter(entry => entry.path === outside || entry.path === path.dirname(outside)))
      assert.equal(item.after.entries.find(candidate => candidate.path === entry.path)?.sddl, entry.sddl, "outside target ACL untouched");
    item.bytesPreserved = true;
    console.log(`${mode}: ${item.answer}`);
  });
});
