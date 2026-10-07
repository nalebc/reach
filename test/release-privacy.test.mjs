import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const checker = new URL("../scripts/check-release.mjs", import.meta.url);
function fixture(t, { name = "nalebc", email = "54943684+nalebc@users.noreply.github.com", committerName = name, committerEmail = email, content = "A public source file.\n" } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reach-release-privacy-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const env = { ...process.env, CI: "1", REACH_PRIVATE_IDENTIFIERS: "FixturePrivatePerson", GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull,
    GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: committerName, GIT_COMMITTER_EMAIL: committerEmail };
  const git = (...args) => execFileSync("git", ["-c", `core.hooksPath=${os.devNull}`, ...args], { cwd, env, stdio: "pipe" });
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

test("release privacy rejects private or unverified metadata without echoing it", (t) => {
  for (const identity of [
    { email: "FixturePrivatePerson@example.invalid" },
    { committerEmail: "FixturePrivatePerson@example.invalid" },
    { name: "FixturePrivatePerson" },
    { email: "1234+nalebc@users.noreply.github.com" },
  ]) {
    const result = fixture(t, identity);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not an approved public identity/);
    assert.doesNotMatch(result.stderr, /FixturePrivatePerson|example\.invalid|1234\+nalebc/);
  }
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
