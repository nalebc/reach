import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const checker = new URL("../scripts/check-release.mjs", import.meta.url);
function fixture(t, { name = "nalebc", email = "54943684+nalebc@users.noreply.github.com", committerName = name, committerEmail = email, content = "A public source file.\n", privateWords = "FixturePrivatePerson" } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reach-release-privacy-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  // Git for Windows cannot use Node's null-device path as a hooks/config path.
  const hooks = path.join(cwd, "empty-hooks"), config = path.join(cwd, "empty-git-config");
  fs.mkdirSync(hooks);
  fs.writeFileSync(config, "");
  const env = { ...process.env, CI: "1", REACH_PRIVATE_IDENTIFIERS: privateWords, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_SYSTEM: config,
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: committerName, GIT_COMMITTER_EMAIL: committerEmail };
  const git = (...args) => execFileSync("git", ["-c", `core.hooksPath=${hooks}`, ...args], { cwd, env, stdio: "pipe" });
  git("init", "-q");
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ author: "Reach Contributors" }));
  fs.writeFileSync(path.join(cwd, "source.txt"), content);
  git("add", "package.json", "source.txt");
  git("commit", "-qm", "Privacy fixture");
  return spawnSync(process.execPath, [fileURLToPath(checker)], { cwd, env, encoding: "utf8" });
}

test("release privacy accepts the verified owner's noreply identity and retains bot attribution", (t) => {
  for (const identity of [
    {},
    { name: "Reach Contributors", email: "contributors@example.invalid" },
    { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" },
    { name: "github-actions[bot]", email: "41898282+github-actions[bot]@users.noreply.github.com" },
  ]) {
    const result = fixture(t, identity);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Release privacy checks passed/);
  }
});

test("release privacy accepts contributor-chosen attribution without an owner allowlist", (t) => {
  for (const identity of [
    { name: "New Contributor", email: "contributor@example.invalid" },
    { name: "New Contributor", email: "1234+contributor@users.noreply.github.com" },
    { committerName: "Integration Bot", committerEmail: "integration@example.invalid" },
  ]) {
    const result = fixture(t, identity);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("release privacy rejects configured private metadata without echoing it", (t) => {
  for (const identity of [
    { email: "FixturePrivatePerson@example.invalid" },
    { committerEmail: "FixturePrivatePerson@example.invalid" },
    { name: "FixturePrivatePerson" },
  ]) {
    const result = fixture(t, identity);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private identifier in author or committer/);
    assert.doesNotMatch(result.stderr, /FixturePrivatePerson|example\.invalid|1234\+nalebc/);
  }
});

test("release privacy rejects credentials in commit attribution without echoing them", (t) => {
  const credential = "ghp_" + "b".repeat(36);
  const result = fixture(t, { name: credential, email: "contributor@example.invalid" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /credential in author or committer/);
  assert.ok(!result.stderr.includes(credential));
});

test("public attribution does not bypass private-content or credential checks", (t) => {
  const secret = "ghp_" + "a".repeat(36);
  const result = fixture(t, { content: `FixturePrivatePerson\n${secret}\n` });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local personal identifier/);
  assert.match(result.stderr, /GitHub credential/);
  assert.ok(!result.stderr.includes(secret));
  assert.doesNotMatch(result.stderr, /FixturePrivatePerson/);
});

test("an approved identity spelled out in full is public, but a private word built from it is still reported", (t) => {
  // The approved owner login doubles as a private word (it is also the Mac username outside CI).
  const inFull = fixture(t, { privateWords: "nalebc", content: "Maintainer: nalebc <54943684+nalebc@users.noreply.github.com>\n" });
  assert.equal(inFull.status, 0, inFull.stderr);
  const elsewhere = fixture(t, { privateWords: "nalebc", content: 'const home = "/Users/nalebc/reach";\n' });
  assert.equal(elsewhere.status, 1);
  assert.match(elsewhere.stderr, /local personal identifier/);
});
