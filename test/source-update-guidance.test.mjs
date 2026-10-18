import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { latestSourceRelease, sourceUpdateGuidance } from "../server/reach-updates.mjs";
import { suites } from "../.github/scripts/run-tests.mjs";

// Release replies are controlled fixtures; Git below runs in real disposable
// repositories on the host. This does not install or restart any Reach.
const published = { state: "found", version: "0.3.3", tag: "v0.3.3" };
const releaseRecord = { tag_name: "v0.3.3", draft: false, prerelease: false, published_at: "2026-10-18T16:49:43Z" };
const answer = (status, body) => async (url, options) => {
  assert.equal(url, "https://api.github.com/repos/nalebc/reach/releases/latest");
  assert.equal(options.redirect, "error");
  assert.equal(options.headers.accept, "application/vnd.github+json");
  assert.ok(options.signal instanceof AbortSignal);
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
};

test("source releases use an actual published GitHub tag rather than npm's version", async () => {
  assert.deepEqual(await latestSourceRelease({ fetch: answer(200, releaseRecord) }), published);
  assert.deepEqual(await latestSourceRelease({ fetch: answer(404, {}) }), { state: "unpublished" });
  for (const status of [401, 403, 429, 503])
    assert.deepEqual(await latestSourceRelease({ fetch: answer(status, {}) }), { state: "offline" });
  assert.deepEqual(await latestSourceRelease({ fetch: async () => { throw Error("offline"); } }), { state: "offline" });
  assert.deepEqual(await latestSourceRelease({ fetch: answer(200, "invalid JSON") }), { state: "offline" });
  assert.deepEqual(await latestSourceRelease({ fetch: answer(200, releaseRecord), maxBytes: 16 }), { state: "offline" });
});

test("source release metadata must identify a published release with an exact safe version tag", async () => {
  for (const patch of [
    { tag_name: "0.3.3" }, { tag_name: "v0.3.3; echo bad" }, { tag_name: "v0.3.3\n" },
    { tag_name: "v0.03.3" }, { tag_name: "--upload-pack=bad" },
    { draft: true }, { prerelease: true }, { published_at: null }, { published_at: 0 }, { published_at: "soon" },
  ])
    assert.deepEqual(await latestSourceRelease({ fetch: answer(200, { ...releaseRecord, ...patch }) }), { state: "offline" });
});

test("source update guidance uses the published tag and a checkout's own launcher on every host", async () => {
  for (const command of ["./reach", ".\\reach.cmd", "reach"]) {
    const message = await sourceUpdateGuidance("/unused", { version: "0.3.1", command, status: () => "", release: async () => published });
    assert.match(message, /^Reach was not updated\./);
    assert.match(message, /Latest published release: 0\.3\.3\nThis checkout reports: 0\.3\.1/);
    assert.ok(message.split("\n").includes("  git fetch https://github.com/nalebc/reach.git tag v0.3.3"));
    assert.ok(message.split("\n").includes("  git switch --detach refs/tags/v0.3.3"));
    assert.ok(message.split("\n").includes(`  ${command} restart`));
    assert.match(message, /Continue only if each command succeeds/);
    assert.match(message, /Restart ends Reach's terminals and live screens/);
    assert.doesNotMatch(message, /v<version>|origin|git pull|git stash|git reset|--yes/);
  }
  assert.ok(suites.windows.includes("source-update-guidance"), "the same Git/launcher cases run on Windows CI");
});

test("source update guidance with local edits or an unreadable status withholds release-switch commands", async () => {
  for (const status of [() => " M scripts/bootstrap.mjs\n", () => "?? notes.txt\n", () => { throw Error("git unavailable"); }]) {
    const message = await sourceUpdateGuidance("/unused", { version: "0.3.1", command: "./reach", status, release: async () => published });
    assert.match(message, /git status --short/);
    assert.match(message, /before switching releases/);
    assert.match(message, /Then run \.\/reach update again/);
    assert.doesNotMatch(message, /git fetch|git switch|git checkout|git stash|git reset|restart/);
  }
});

test("source update guidance never invents a tag when the release cannot be verified", async () => {
  for (const release of [
    async () => ({ state: "offline" }), async () => ({ state: "unpublished" }),
    async () => ({ state: "found", version: "0.3.3" }),
    async () => ({ ...published, tag: "v0.3.1" }),
    async () => ({ ...published, version: "0.3.3; echo bad", tag: "v0.3.3; echo bad" }),
    async () => { throw Error("offline"); },
  ]) {
    const message = await sourceUpdateGuidance("/unused", { version: "0.3.1", status: () => "", release });
    assert.match(message, /^Reach was not updated\./);
    assert.match(message, /https:\/\/github.com\/nalebc\/reach\/releases|No Reach release is published yet/);
    assert.doesNotMatch(message, /git fetch|git switch|v<version>|echo bad/);
  }
});

test("source update guidance reads actual Git state without changing tracked or untracked work, refs or index", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-source-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["--no-optional-locks", "-c", `core.hooksPath=${path.join(root, "no-hooks")}`, "-c", "core.autocrlf=false", "-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "--quiet");
  const file = path.join(root, "local-work.txt");
  fs.writeFileSync(file, "Committed work.\n");
  git("add", "local-work.txt");
  git("-c", "user.name=Reach test", "-c", "user.email=reach-test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
  const options = { version: "0.3.1", release: async () => published };
  const refs = git("show-ref", "--head");
  const index = fs.readFileSync(path.join(root, ".git", "index"));
  const clean = await sourceUpdateGuidance(root, options);
  const command = process.platform === "win32" ? ".\\reach.cmd" : "./reach";
  assert.ok(clean.split("\n").includes(`  ${command} restart`));
  assert.equal(git("status", "--porcelain"), "");
  assert.deepEqual(fs.readFileSync(path.join(root, ".git", "index")), index);
  for (const change of [
    () => fs.writeFileSync(file, "Keep this work.\n"),
    () => fs.writeFileSync(path.join(root, "untracked.txt"), "Keep this too.\n"),
  ]) {
    change();
    const before = git("status", "--porcelain");
    const dirty = await sourceUpdateGuidance(root, options);
    assert.match(dirty, /Local changes found/);
    assert.doesNotMatch(dirty, /git fetch|git switch|restart/);
    assert.equal(git("status", "--porcelain"), before);
    assert.equal(git("show-ref", "--head"), refs);
    assert.deepEqual(fs.readFileSync(path.join(root, ".git", "index")), index);
    assert.equal(fs.readFileSync(file, "utf8"), "Keep this work.\n");
  }
  assert.equal(fs.readFileSync(path.join(root, "untracked.txt"), "utf8"), "Keep this too.\n");
});

test("source update guidance handles an actual non-Git folder without suggesting a switch", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-no-git-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const message = await sourceUpdateGuidance(root, { release: async () => published });
  assert.match(message, /Couldn't check for local changes/);
  assert.doesNotMatch(message, /git fetch|git switch|restart/);
  assert.deepEqual(fs.readdirSync(root), []);
});
