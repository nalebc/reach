import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cscCandidates } from "../server/desktop-native.mjs";

const exec = promisify(execFile);
test("real Windows grants and revocation never change a junction target or a hard-linked outside file", {
  skip: process.platform !== "win32" && "Windows ACLs and NT handles", timeout: 120000,
}, async t => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-grant-check-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const csc = cscCandidates().find(file => fs.existsSync(file));
  assert.ok(csc, "the PC's csc.exe");
  const fixture = path.join(dir, "grant-checks.exe");
  await exec(csc, ["/nologo", "/noconfig", "/target:exe", "/main:GrantChecks", `/out:${fixture}`,
    ...["System.dll", "System.Core.dll"].map(name => `/reference:${path.join(path.dirname(csc), name)}`),
    path.resolve("scripts/native/sandbox.cs"), path.resolve("test/fixtures/windows/grant-checks.cs")], { windowsHide: true, timeout: 60000 });
  const run = async (...args) => (await exec(fixture, args, { windowsHide: true, timeout: 15000 })).stdout.trim();
  const shared = path.join(dir, "shared"), outside = path.join(dir, "outside");
  fs.mkdirSync(shared); fs.mkdirSync(outside);
  const secret = path.join(outside, "secret.txt"), safe = path.join(shared, "safe.txt");
  fs.writeFileSync(secret, "outside secret"); fs.writeFileSync(safe, "shared file");
  const before = { folder: await run("acl", outside), file: await run("acl", secret) };
  const junction = path.join(shared, "escape");
  fs.mkdirSync(path.join(outside, "inside"));
  fs.symlinkSync(outside, junction, "junction");
  await assert.rejects(run("root", junction), "the broker refuses a reparse root itself");
  await assert.rejects(run("root", path.join(junction, "inside")), "the broker refuses a reparse ancestor of its root");
  const nested = path.join(shared, "nested");
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, "safe.txt"), "original");
  assert.equal(await run("pin", shared), "pinned", "live handles prevent root/parent/file rename and concurrent writes");
  assert.equal(fs.readFileSync(path.join(nested, "safe.txt"), "utf8"), "original");
  fs.linkSync(secret, path.join(shared, "hard-link.txt"));
  await run("read", shared);
  assert.equal(await run("allowed", safe, shared), "yes", "the ordinary shared file gets its read grant");
  assert.equal(await run("acl", outside), before.folder);
  assert.equal(await run("acl", secret), before.file, "neither alias grants the outside secret");
  await run("read", junction);
  assert.equal(await run("acl", outside), before.folder, "a tool root that is a junction stays ungranted");
  await assert.rejects(run("grant", junction));
  await run("revoke", junction);
  assert.equal(await run("acl", secret), before.file, "revocation never follows the junction either");
  const privateFolder = path.join(shared, "private");
  fs.mkdirSync(privateFolder);
  fs.writeFileSync(path.join(privateFolder, "key.txt"), "private");
  await run("read", shared, privateFolder);
  assert.equal(await run("denied", path.join(privateFolder, "key.txt")), "yes", "the protected subtree denies every sandbox token even if it inherited a read grant");
});
