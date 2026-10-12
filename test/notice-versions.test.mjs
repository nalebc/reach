import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Notices describe only the bundled subset, but every named version must
// match its lock and regeneration must follow any lock change.
test("committed notices match npm, Go modules and the Go runtime", async () => {
  const { noticeVersionFindings } = await import("../scripts/notice-versions.mjs");
  assert.deepEqual(noticeVersionFindings(), []);
  const notices = fs.readFileSync("docs/THIRD_PARTY_NOTICES.md", "utf8");
  const go = fs.readFileSync("tailnet/go.mod", "utf8");
  const version = go.match(/^go (\S+)/m)[1];
  assert.ok(notices.includes(`## Go runtime (go${version})`), "regenerate notices for the locked Go runtime");
  for (const [, name, version] of go.matchAll(/^\s*(\S+) (v\S+)(?:\s|$)/gm)) {
    if (notices.includes(`## ${name} `)) assert.ok(notices.includes(`## ${name} ${version}\n`), `stale notice: ${name}`);
  }
});

test("release notice validation catches missing notices and changes to either lock", async t => {
  const { noticeVersionFindings, noticeLockHash } = await import("../scripts/notice-versions.mjs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-notices-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "tailnet"));
  fs.mkdirSync(path.join(root, "docs"));
  const lock = { packages: { "node_modules/react": { version: "19.1.0" } } };
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
  fs.writeFileSync(path.join(root, "tailnet/go.mod"), "module fixture\n\ngo 1.27.2\n\nrequire golang.org/x/net v0.60.0\n");
  fs.writeFileSync(path.join(root, "tailnet/go.sum"), "fixture checksums\n");
  const notices = path.join(root, "docs/THIRD_PARTY_NOTICES.md");
  const write = () => fs.writeFileSync(notices, `Dependency locks: \`${noticeLockHash(root)}\`.\n\n## react 19.1.0\n\n## golang.org/x/net v0.60.0\n\n## Go runtime (go1.27.2)\n`);
  assert.ok(noticeVersionFindings(root).length > 0);
  write();
  assert.deepEqual(noticeVersionFindings(root), []);
  const hash = noticeLockHash(root);
  for (const file of ["package-lock.json", "tailnet/go.mod", "tailnet/go.sum", "docs/THIRD_PARTY_NOTICES.md"]) {
    const target = path.join(root, file);
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(/\n/g, "\r\n"));
  }
  assert.equal(noticeLockHash(root), hash, "Windows checkout line endings must not change dependency identity");
  assert.deepEqual(noticeVersionFindings(root), []);
  for (const [from, to] of [["react 19.1.0", "react 19.0.0"], ["v0.60.0", "v0.59.0"], ["go1.27.2", "go1.27.1"]]) {
    write();
    fs.writeFileSync(notices, fs.readFileSync(notices, "utf8").replace(from, to));
    assert.ok(noticeVersionFindings(root).length > 0, from);
  }
  write();
  lock.packages["node_modules/react"].version = "19.2.0";
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
  assert.ok(noticeVersionFindings(root).some(finding => /lock/.test(finding)));
  write();
  fs.appendFileSync(path.join(root, "tailnet/go.mod"), "require example.org/new v1.0.0\n");
  assert.ok(noticeVersionFindings(root).some(finding => /lock/.test(finding)));
  // Exercise the release gate itself. Git history is irrelevant to this
  // fixture; stub its two read-only queries without making any commits.
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ author: "Reach Contributors" }));
  const preload = "data:text/javascript," + encodeURIComponent(`
    import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
    const run = cp.execFileSync;
    cp.execFileSync = (file, ...args) => file === 'git' ? '' : run(file, ...args);
    syncBuiltinESMExports();
  `);
  const result = spawnSync(process.execPath, ["--import", preload, fileURLToPath(new URL("../scripts/check-release.mjs", import.meta.url))], {
    cwd: root, env: { ...process.env, CI: "1", REACH_PRIVATE_IDENTIFIERS: "" }, encoding: "utf8", timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /THIRD_PARTY_NOTICES.*dependency locks changed/);
});
