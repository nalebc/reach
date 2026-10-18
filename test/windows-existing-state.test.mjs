import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cscCandidates } from "../server/desktop-native.mjs";
import { accountSid, ensurePrivateFolders } from "../server/windows-private-folder.mjs";

const exec = promisify(execFile);
const enabled = process.platform === "win32" && process.env.CI === "true" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1"
  && process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted";
// Actual NTFS permissions and unmodified production whoami/icacls/compiler/
// checker. Controlled synthetic state, not a friend's ACL or a browser login.
test("actual Windows existing-state ACL regression and refusal baselines", {
  skip: enabled ? false : "disposable GitHub-hosted Windows runner only",
  timeout: 300000,
}, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-existing-state-"));
  const report = { schema: 1, head: process.env.GITHUB_SHA || null, actualWindows: true, physicalDevice: false, node: process.version,
    production: Object.fromEntries(["server/windows-private-folder.mjs", "scripts/native/private-folder.cs"].map(file => [file, crypto.createHash("sha256").update(readFileSync(file)).digest("hex")])), cases: [] };
  const system = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
  const user = `ReachAcl${crypto.randomBytes(4).toString("hex")}`;
  let createdUser = false;
  const run = async (file, args, options = {}) => {
    try { return await exec(file, args, { windowsHide: true, timeout: 60000, maxBuffer: 4 << 20, ...options }); }
    catch (error) {
      // The disposable account password must never reach a test failure log.
      throw new Error(`${path.basename(file)} failed (${error.code}): ${error.stdout || ""}${error.stderr || ""}`);
    }
  };
  t.after(async () => {
    await fs.mkdir("reports", { recursive: true });
    await fs.writeFile("reports/windows-existing-state.json", `${JSON.stringify(report, null, 2)}\n`);
    try {
      if (createdUser) await run(path.win32.join(system, "net.exe"), ["user", user, "/delete"]);
    } finally {
      for (const item of report.cases) if (item.junction) await fs.unlink(item.junction).catch(() => {});
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  const compiler = cscCandidates().find(file => existsSync(file));
  assert.ok(compiler, "actual Windows .NET Framework compiler exists");
  const fixture = path.join(root, "acl-fixture.exe");
  await run(compiler, ["/nologo", "/noconfig", "/target:exe", "/platform:anycpu", `/out:${fixture}`,
    `/reference:${path.join(path.dirname(compiler), "System.dll")}`, `/reference:${path.join(path.dirname(compiler), "System.Web.Extensions.dll")}`,
    path.resolve("test/fixtures/windows/existing-state-acl.cs")]);
  const currentSid = accountSid((await run(path.win32.join(system, "whoami.exe"), ["/user", "/fo", "csv", "/nh"])).stdout);
  assert.match(currentSid, /^S-1-5-21-/);
  const password = `${crypto.randomBytes(24).toString("hex")}Aa1!`;
  await run(path.win32.join(system, "net.exe"), ["user", user, password, "/add", "/Y"]);
  createdUser = true;
  const foreignSid = (await run(fixture, ["sid", user])).stdout.trim();
  assert.match(foreignSid, /^S-1-5-21-/);
  assert.notEqual(foreignSid, currentSid);
  report.account = { currentSid, disposableForeignSid: foreignSid };
  const cases = [
    ["fresh", true], ["private", true], ["inherited", true], ["creator-owner", true],
    ["file-explicit", true], ["file-protected", true], ["directory-explicit", true], ["directory-protected", true],
    ["foreign-owner", false, /belongs to another account/], ["foreign-ace", false, /can be read or changed/],
    ["junction", false, /link or junction/],
    // Diagnostics only: current-owner-only OWNER RIGHTS is distinct from a
    // genuinely broad or foreign-user ACE. Do not relax production on this
    // evidence alone; actual access semantics need separate verification.
    ["owner-rights-file", false, /can be read or changed/], ["owner-rights-directory", false, /can be read or changed/],
  ];
  for (const [mode, expected, refusal] of cases) await t.test(mode, { timeout: 120000 }, async () => {
    // The fixture refuses non-generated roots; each case has its own root.
    const generated = await fs.mkdtemp(path.join(root, "reach-existing-state-"));
    const item = { mode, expected, root: generated };
    report.cases.push(item);
    await run(fixture, ["setup", generated, mode, foreignSid]);
    const state = path.join(generated, "state"), data = path.join(state, "quick"), nativeDir = path.join(state, "native");
    const legacy = path.join(state, "history", "legacy.json");
    if (mode === "foreign-owner") await run(path.win32.join(system, "icacls.exe"), [legacy, "/setowner", `*${foreignSid}`, "/Q"]);
    if (mode === "junction") {
      item.junction = path.join(state, "outside-link");
      await fs.symlink(path.join(generated, "outside"), item.junction, "junction");
    }
    item.before = JSON.parse((await run(fixture, ["snapshot", generated])).stdout);
    assert.equal(item.before.sid, currentSid);
    if (mode !== "fresh") {
      const old = item.before.entries.find(entry => entry.path === legacy);
      assert.ok(old, "actual existing synthetic state was created");
      assert.equal(old.owner, mode === "foreign-owner" ? foreignSid : currentSid, "fixture ownership is real");
      if (mode === "file-explicit" || mode === "file-protected") {
        assert.equal(old.protected, mode === "file-protected");
        assert.ok(old.rules.some(rule => rule.sid === "S-1-1-0" && rule.type === "Allow" && !rule.inherited), "actual explicit broad file ACE exists before production");
      }
      if (mode === "inherited") assert.ok(old.rules.some(rule => rule.sid === "S-1-1-0" && rule.type === "Allow" && rule.inherited), "actual inherited broad file ACE exists before production");
      const history = item.before.entries.find(entry => entry.path === path.dirname(legacy));
      if (mode === "directory-explicit" || mode === "directory-protected") {
        assert.equal(history.protected, mode === "directory-protected");
        assert.ok(history.rules.some(rule => rule.sid === "S-1-1-0" && rule.type === "Allow" && !rule.inherited), "actual explicit broad directory ACE exists before production");
      }
      if (mode === "owner-rights-file" || mode === "owner-rights-directory") {
        const ownerRights = mode === "owner-rights-file" ? old : history;
        assert.equal(ownerRights.owner, currentSid);
        assert.ok(ownerRights.rules.some(rule => rule.sid === "S-1-3-4" && rule.type === "Allow" && !rule.inherited && rule.propagation === "None"), "actual explicit OWNER RIGHTS read ACE exists before production");
      }
      if (mode === "foreign-ace") assert.ok(old.rules.some(rule => rule.sid === foreignSid && rule.type === "Allow" && !rule.inherited), "actual foreign-account read ACE exists before production");
    }
    item.result = await ensurePrivateFolders({ protect: [state, data], check: [], nativeDir, helpers: [] });
    item.after = JSON.parse((await run(fixture, ["snapshot", generated])).stdout);
    item.stateBytesPreserved = mode === "fresh" || await fs.readFile(legacy, "utf8") === "Existing synthetic state. Keep exactly.\n";
    assert.equal(item.stateBytesPreserved, true);
    if (mode === "junction") {
      const outside = path.join(generated, "outside");
      assert.deepEqual(item.after.entries.filter(entry => entry.path === outside || entry.path.startsWith(`${outside}${path.sep}`)),
        item.before.entries.filter(entry => entry.path === outside || entry.path.startsWith(`${outside}${path.sep}`)), "outside disposable target was not repaired or traversed");
      assert.equal(await fs.readFile(path.join(outside, "keep.txt"), "utf8"), "Outside disposable target.\n");
    }
    console.info(`${mode}: ${JSON.stringify({ result: item.result, administratorToken: item.before.administratorToken, windows: item.before.windows })}`);
    assert.equal(item.result.ok, expected, item.result.reason || mode);
    if (refusal) assert.match(item.result.reason, refusal);
    if (mode === "foreign-owner") assert.equal(item.after.entries.find(entry => entry.path === legacy).owner, foreignSid, "foreign ownership was not rewritten");
  });
});
