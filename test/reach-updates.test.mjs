import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PACKAGE, createReachUpdates, installCommand, latestRelease, reachInstall, updateNotification } from "../server/reach-updates.mjs";
import { sealNotification } from "../server/notification-items.mjs";

// Reach's own updates: a newer @nalebc/reach, installed exactly as confirmed
// into the folder npm put this Reach in, then Reach restarts. Nothing here
// touches npm, the network or this Mac's Reach.
const pkg = (version = "0.1.0", name = PACKAGE) => JSON.stringify({ name, version });
const layout = (real, { files = {}, writable = true, platform = "darwin" } = {}) => ({
  platform,
  realpath: () => real,
  exists: (file) => Object.hasOwn(files, file),
  readFile: (file) => { if (file.endsWith("package.json")) return files.pkg ?? pkg(); throw Error("missing"); },
  writable: () => writable,
});

test("where this Reach lives: an npm install's prefix, a checkout, or something to update by hand", () => {
  const root = "/opt/homebrew/lib/node_modules/@nalebc/reach";
  const npm = "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js";
  assert.deepEqual(reachInstall(root, layout(root, { files: { [npm]: 1 } })),
    { source: false, version: "0.1.0", name: PACKAGE, prefix: "/opt/homebrew", npm });
  const nvm = "/Users/me/.nvm/versions/node/v22.1.0/lib/node_modules/@nalebc/reach";
  assert.equal(reachInstall("/link", layout(nvm)).prefix, "/Users/me/.nvm/versions/node/v22.1.0", "the real folder, not a link to it");
  assert.equal(reachInstall("/link", layout(nvm)).npm, null, "no npm beside it: any npm, with --prefix");
  const win = "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@nalebc\\reach";
  assert.equal(reachInstall(win, layout(win, { platform: "win32" })).prefix, "C:\\Users\\me\\AppData\\Roaming\\npm");
  // A checkout: git's job.
  assert.deepEqual(reachInstall("/src/reach", layout("/src/reach", { files: { "/src/reach/src/main.tsx": 1, "/src/reach/.git": 1 } })), { source: true, version: "0.1.0", name: PACKAGE });
  // Elsewhere, unwritable, or not Reach's package: the command, nothing run.
  assert.equal(reachInstall("/apps/reach", layout("/apps/reach")).reason, "layout");
  const locked = reachInstall(root, layout(root, { writable: false }));
  assert.equal(locked.reason, "permission");
  assert.match(locked.manual, /permission.*ownership.*prefix/i);
  assert.match(locked.manual, /user-owned prefix/i);
  assert.doesNotMatch(locked.manual, /^npm install/);
  assert.doesNotMatch(locked.manual, /sudo/);
  assert.equal(reachInstall(root, layout(root, { files: { pkg: pkg("0.1.0", "other") } })).reason, "unknown");
  assert.equal(reachInstall(root, layout(root, { files: { pkg: pkg("not-a-version") } })).reason, "unknown");
});

test("the install is exactly the confirmed version, into that prefix", () => {
  const install = { prefix: "/opt/homebrew", npm: "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js" };
  const plan = installCommand(install, "0.2.0", { platform: "darwin" });
  assert.deepEqual(plan.args, ["install", "--global", "--prefix", "/opt/homebrew", "--no-fund", "--no-audit", `${PACKAGE}@0.2.0`]);
  assert.equal(plan.display, `npm install --global --prefix '/opt/homebrew' ${PACKAGE}@0.2.0`);
  for (const bad of ["latest", "0.2", "0.2.0; rm -rf ~", "", undefined]) assert.equal(installCommand(install, bad), null, String(bad));
  assert.equal(installCommand({ prefix: null, npm: "x" }, "0.2.0"), null);
});

test("the newest release: found, nothing published yet, or unknown", async () => {
  const answer = (status, body) => async (url) => {
    assert.equal(url, `https://registry.npmjs.org/-/package/${PACKAGE}/dist-tags`);
    return { status, ok: status >= 200 && status < 300, text: async () => body };
  };
  assert.deepEqual(await latestRelease({ fetch: answer(200, '{"latest":"0.2.0","next":"0.3.0-beta.1"}') }), { state: "found", version: "0.2.0" });
  assert.deepEqual(await latestRelease({ fetch: answer(404, '{"error":"Not found"}') }), { state: "unpublished" });
  assert.deepEqual(await latestRelease({ fetch: answer(401, '"Unauthorized"') }), { state: "unpublished" }, "what npm says for a scoped package it doesn't have");
  assert.deepEqual(await latestRelease({ fetch: answer(503, "") }), { state: "offline" });
  assert.deepEqual(await latestRelease({ fetch: answer(200, '{"latest":"soon"}') }), { state: "offline" });
  assert.deepEqual(await latestRelease({ fetch: async () => { throw Error("offline"); } }), { state: "offline" });
});

// A stand-in npm: answers when told to.
function fakeNpm() {
  const runs = [];
  const spawn = (file, args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill() {} });
    runs.push({ file, args, child });
    return child;
  };
  return { runs, spawn };
}
const feed = (version) => async () => ({ status: version ? 200 : 404, ok: !!version, text: async () => JSON.stringify({ latest: version }) });
const npmInstall = { source: false, version: "0.1.0", name: PACKAGE, prefix: "/opt/homebrew", npm: "/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js" };

test("an update is offered once per version, installed as confirmed, and Reach restarts on it", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-update-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const npm = fakeNpm();
  let restarted = 0, installed = "0.1.0", changes = 0;
  const make = (latest = "0.2.0") => createReachUpdates({ root: "/x", dataDir, install: npmInstall, fetch: feed(latest), spawn: npm.spawn,
    restart: () => restarted++, readVersion: () => installed, onChange: () => changes++, platform: "darwin" });
  const updates = make();
  assert.equal((await updates.check()).state, "available");
  assert.deepEqual(updates.offer(), { from: "0.1.0", to: "0.2.0" });
  assert.equal(updates.status().command, `npm install --global --prefix '/opt/homebrew' ${PACKAGE}@0.2.0`);

  // Not now: not offered again for that version, even after a restart...
  updates.dismiss("0.2.0");
  assert.equal(updates.offer(), null);
  assert.equal(updates.status().state, "available", "still in Settings");
  const later = make();
  await later.check();
  assert.equal(later.offer(), null);
  // ...but a newer one is.
  const newer = make("0.3.0");
  await newer.check();
  assert.deepEqual(newer.offer(), { from: "0.1.0", to: "0.3.0" });

  // Only the version offered now installs.
  assert.throws(() => updates.start("0.3.0"), (e) => e.status === 409);
  assert.throws(() => updates.start("latest"), (e) => e.status === 409);
  const before = changes;
  assert.equal(updates.start("0.2.0").state, "installing");
  assert.ok(changes > before);
  assert.equal(updates.busy(), true, "agents aren't told about the new runtime meanwhile");
  assert.equal(updates.offer(), null);
  assert.throws(() => updates.start("0.2.0"), /already being installed/);
  const run = npm.runs.at(-1);
  assert.equal(run.file, process.execPath);
  assert.deepEqual(run.args, [npmInstall.npm, "install", "--global", "--prefix", "/opt/homebrew", "--no-fund", "--no-audit", `${PACKAGE}@0.2.0`]);
  installed = "0.2.0";
  run.child.stdout.emit("data", "added 1 package\n");
  run.child.emit("exit", 0);
  assert.equal(updates.status().state, "restarting");
  assert.equal(restarted, 1);
  assert.equal(updates.busy(), true);
  assert.match(fs.readFileSync(path.join(dataDir, "update.log"), "utf8"), /@0\.2\.0[\s\S]*added 1 package/);
});

test("fails closed: npm failing, or finishing without the new version, is said and can be tried again", async () => {
  const npm = fakeNpm();
  let restarted = 0;
  const updates = createReachUpdates({ root: "/x", install: npmInstall, fetch: feed("0.2.0"), spawn: npm.spawn, restart: () => restarted++, readVersion: () => "0.1.0" });
  await updates.check();
  updates.start("0.2.0");
  npm.runs.at(-1).child.emit("exit", 1);
  assert.deepEqual([updates.status().state, updates.status().error], ["failed", "npm stopped with exit code 1."]);
  assert.equal(updates.busy(), false);
  updates.reset();
  assert.equal(updates.status().state, "available");
  updates.start("0.2.0");
  npm.runs.at(-1).child.emit("exit", 0);
  assert.equal(updates.status().state, "failed", "npm said yes, but 0.1.0 is still in place");
  assert.equal(restarted, 0);
});

test("without a way to restart here, it says to restart Reach to finish", async () => {
  const npm = fakeNpm();
  const updates = createReachUpdates({ root: "/x", install: npmInstall, fetch: feed("0.2.0"), spawn: npm.spawn, restart: null, readVersion: () => "0.2.0" });
  await updates.check();
  updates.start("0.2.0");
  npm.runs.at(-1).child.emit("exit", 0);
  assert.deepEqual([updates.status().state, updates.status().error], ["installed", "Restart Reach to finish."]);
  assert.equal(updates.busy(), true, "the files are newer than this server until it restarts");
});

test("never offered for a checkout, before anything is published, offline, or when it can't install here", async () => {
  const quiet = async (options) => {
    const updates = createReachUpdates({ root: "/x", spawn: () => assert.fail("never runs npm"), ...options });
    await updates.check();
    return updates;
  };
  const source = await quiet({ install: { source: true, version: "0.1.0" }, fetch: () => assert.fail("a checkout asks nobody") });
  assert.deepEqual([source.status().state, source.offer()], ["source", null]);
  assert.equal((await quiet({ install: npmInstall, fetch: feed(null) })).status().state, "unpublished");
  const offline = await quiet({ install: npmInstall, fetch: async () => { throw Error("offline"); } });
  assert.deepEqual([offline.status().state, offline.offer()], ["offline", null]);
  assert.equal((await quiet({ install: npmInstall, fetch: feed("0.1.0") })).status().state, "current");
  const manual = await quiet({ install: { ...npmInstall, reason: "permission", manual: `npm install --global --prefix '/usr/local' ${PACKAGE}@latest` }, fetch: feed("0.2.0") });
  assert.deepEqual(manual.status(), { version: "0.1.0", state: "manual", to: "0.2.0", reason: "permission", command: `npm install --global --prefix '/usr/local' ${PACKAGE}@0.2.0` });
  assert.equal(manual.offer(), null);
  assert.throws(() => manual.start("0.2.0"), (e) => e.status === 409);
});

test("the Needs you card: Update or Not now, sealed to that version", () => {
  const item = updateNotification({ from: "0.1.0", to: "0.2.0" }, sealNotification);
  assert.equal(item.id, "update:0.2.0");
  assert.equal(item.source, "update");
  assert.deepEqual(item.actions.map((a) => a.id), ["update", "deny"]);
  assert.deepEqual(item._binding, { type: "update", version: "0.2.0" });
  assert.match(item.summary, /terminals and live screens end/);
  assert.deepEqual(item.target, { page: "overview", needs: "update:0.2.0" });
});

test("a restart that never happens is said, not left at Restarting…", async () => {
  const npm = fakeNpm();
  let restarted = 0;
  const updates = createReachUpdates({ root: "/x", install: npmInstall, fetch: feed("0.2.0"), spawn: npm.spawn, restart: () => restarted++, readVersion: () => "0.2.0", restartGraceMs: 30 });
  await updates.check();
  updates.start("0.2.0");
  npm.runs.at(-1).child.emit("exit", 0);
  assert.equal(updates.status().state, "restarting");
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual([updates.status().state, updates.status().error], ["installed", "Reach didn't restart. Restart it to finish."]);
  assert.equal(updates.busy(), true, "agents still wait for the new server");
  assert.equal(restarted, 1, "asked once, not again and again");
});


test("a portable archive with sources but no git points to the next archive without installing npm", async () => {
  const install = reachInstall("/apps/reach", layout("/apps/reach", { files: { "/apps/reach/src/main.tsx": 1 } }));
  assert.equal(install.source, false);
  assert.equal(install.reason, "portable");
  assert.match(install.manual, /portable archive/i);
  assert.ok(install.manual.includes("https://github.com/nalebc/reach/releases"), install.manual);
  assert.doesNotMatch(install.manual, /git pull/);
  const updates = createReachUpdates({ root: "/apps/reach", install, fetch: feed("0.2.0"), spawn: () => assert.fail("portable updates must remain manual") });
  const status = await updates.check();
  assert.equal(status.state, "manual");
  assert.equal(status.reason, "portable");
  assert.equal(status.command, install.manual);
  assert.equal(updates.offer(), null);
  assert.throws(() => updates.start("0.2.0"), error => error.status === 409);
});
