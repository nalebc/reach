import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { windowsFixture } from "./helpers/windows-fixtures.mjs";
import { findChrome } from "./helpers/headless-chrome.mjs";

// An explicit baseline module lets a disposable Windows validation job retain
// the old helper's actual RED result before checking the corrected helper GREEN.
// Normal CI always uses the current helper. No process/tree operation is mocked.
const baseline = process.env.REACH_TEST_BROWSER_LIFETIME_HELPER;
const helper = await import(baseline ? pathToFileURL(path.resolve(baseline)).href : "./helpers/headless-chrome.mjs");
const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const enabled = process.platform === "win32" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1";
const skip = !enabled && "actual Windows process/job/handle execution (REACH_TEST_WINDOWS_DESKTOP=1)";
const observations = [];

async function record(t, value) {
  const row = { platform: process.platform, architecture: process.arch, node: process.versions.node, helper: baseline ? "explicit-baseline" : "current", ...value };
  observations.push(row);
  t.diagnostic(JSON.stringify(row));
  await fs.mkdir(path.join(repo, "reports"), { recursive: true });
  await fs.writeFile(path.join(repo, "reports", "windows-browser-lifetime.json"), JSON.stringify({ schema: 1, scope: "actual Windows OS processes, inherited pipes and kernel Job Object", observations }, null, 2));
}

async function waitJSON(file) {
  const end = Date.now() + 5000;
  for (;;) {
    try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) { if (Date.now() > end) throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function probe(binary, identity, terminate = false) {
  const { stdout } = await exec(binary, [terminate ? "--terminate" : "--probe", String(identity.pid), identity.creationTime], { windowsHide: true, timeout: 5000 });
  return JSON.parse(stdout.trim());
}

function assertOwnedStopped(browser, { parent, orphan = false } = {}) {
  const result = browser.lifetime();
  assert.equal(result.hasClosed, true);
  assert.equal(result.profileRemoved, true);
  assert.equal(result.ownedTree.owner, "windows-job");
  assert.equal(result.ownedTree.protocolError, null);
  const started = result.ownedTree.events.find(event => event.kind === "started");
  const empty = result.ownedTree.events.find(event => event.kind === "empty");
  assert.equal(started.assignedBeforeResume, true);
  assert.equal(empty.active, 0);
  if (parent) {
    assert.equal(started.pid, parent.pid);
    assert.equal(started.creationTime, parent.creationTime);
    assert.ok(empty.total >= 2, "the real inherited-pipe descendant belonged to the owned job");
    assert.equal(empty.terminated, true);
  }
  if (orphan) assert.ok(result.ownedTree.events.some(event => event.kind === "parent-exit" && event.exitCode === 0 && event.active >= 1), "the original parent exited while its descendant still belonged to the job");
  return result;
}

async function fixtureCase(t, mode) {
  const binary = await windowsFixture("browser-lifetime", ["System.Web.Extensions.dll"]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-browser-lifetime-"));
  const canaryFile = path.join(dir, "canary.json");
  const canaryBegan = performance.now();
  let canaryChild;
  let canarySpawned = false, canarySpawnError = null, canaryStderr = Buffer.alloc(0), canaryStderrBytes = 0, canaryStderrError = null;
  let canaryReady = false, canaryReadinessElapsedMs = null;
  const canaryEvents = [];
  const canaryEvent = (kind, details = {}) => {
    if (canaryEvents.length < 8) canaryEvents.push({ kind, ...details, elapsedMs: Math.round(performance.now() - canaryBegan) });
  };
  const canaryError = caught => {
    canarySpawnError ||= { code: caught.code || null, errno: caught.errno ?? null, syscall: caught.syscall || null, message: caught.message.slice(0, 512) };
    canaryEvent("error", { code: caught.code || null });
  };
  const startCanary = () => {
    try { canaryChild = spawn(binary, ["--canary", canaryFile], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }); }
    catch (caught) { canaryError(caught); throw caught; }
    canaryChild.once("spawn", () => { canarySpawned = true; canaryEvent("spawn"); });
    canaryChild.on("error", canaryError);
    canaryChild.once("exit", (code, signal) => canaryEvent("exit", { code, signal }));
    canaryChild.once("close", (code, signal) => canaryEvent("close", { code, signal }));
    // EMFILE/ENFILE can return a ChildProcess without any stdio streams.
    canaryChild.stderr?.on("data", chunk => {
      canaryStderrBytes += chunk.length;
      if (canaryStderr.length < 4096) canaryStderr = Buffer.concat([canaryStderr, chunk.subarray(0, 4096 - canaryStderr.length)]);
    });
    canaryChild.stderr?.on("error", caught => {
      canaryStderrError = { code: caught.code || null, message: caught.message.slice(0, 512) };
      canaryEvent("stderr-error", { code: caught.code || null });
    });
  };
  let canary, identities, browser, result, error, closeElapsedMs;
  let phase = "canary-start";
  try {
    try { startCanary(); canary = await waitJSON(canaryFile); canaryReady = true; }
    finally { canaryReadinessElapsedMs = Math.round(performance.now() - canaryBegan); }
    assert.deepEqual(await probe(binary, canary), { alive: true, creationMatches: true });
    const state = path.join(dir, "browser.json");
    phase = "browser-launch";
    browser = await helper.launchChrome(t, { binary, args: [`--fixture-mode=${mode}`, `--fixture-state=${state}`] });
    phase = "inherited-pipe-descendant";
    identities = await waitJSON(state);
    assert.ok(path.basename(identities.profile).startsWith("reach-chrome-"));
    await fs.stat(path.join(identities.profile, "Default", "held"));
    assert.deepEqual(await probe(binary, identities.descendant), { alive: true, creationMatches: true });
    phase = "browser-close";
    const closingAt = performance.now();
    try { await browser.close(); } finally { closeElapsedMs = Math.round(performance.now() - closingAt); }
    phase = "owned-tree-confirmation";
    result = assertOwnedStopped(browser, { parent: identities.parent, orphan: mode === "orphan" });
    for (const identity of [identities.parent, identities.descendant]) {
      const state = await probe(binary, identity);
      assert.ok(!state.alive || !state.creationMatches, "the exact owned process must be stopped, even if Windows reuses its PID");
    }
    assert.deepEqual(await probe(binary, canary), { alive: true, creationMatches: true }, "an unrelated process using the very same executable stays alive");
    await assert.rejects(fs.stat(identities.profile), { code: "ENOENT" });
    phase = "complete";
  } catch (caught) { error = caught; throw caught; }
  finally {
    // Capture startup before any manual kill can replace the original exit
    // state. This observes the existing five-second readiness bound unchanged.
    const canaryStartup = {
      pid: canaryChild?.pid ?? null, spawned: canarySpawned, spawnError: canarySpawnError,
      exitCode: canaryChild?.exitCode ?? null, signalCode: canaryChild?.signalCode ?? null,
      readiness: { boundMs: 5000, elapsedMs: canaryReadinessElapsedMs, ready: canaryReady },
      observedElapsedMs: Math.round(performance.now() - canaryBegan),
      events: canaryEvents.map(event => ({ ...event })),
      stderrAvailable: Boolean(canaryChild?.stderr), stderrPrefix: canaryStderr.toString("utf8"), stderrBytes: canaryStderrBytes,
      stderrRetainedBytes: canaryStderr.length, stderrTruncated: canaryStderrBytes > canaryStderr.length,
      stderrError: canaryStderrError,
    };
    const cleanupErrors = [];
    const beforeCleanup = [];
    for (const identity of [identities?.parent, identities?.descendant, canary].filter(Boolean)) {
      try { beforeCleanup.push({ identity, ...await probe(binary, identity) }); }
      catch (caught) { cleanupErrors.push(caught); }
    }
    // A RED baseline must not leave its deliberately orphaned fixture behind.
    // Every cleanup opens and checks the exact creation identity before killing.
    const cleanup = [];
    for (const identity of [identities?.parent, identities?.descendant, canary].filter(Boolean))
      await probe(binary, identity, true).then(state => cleanup.push({ identity, ...state }), caught => cleanupErrors.push(caught));
    if (!canary) canaryChild?.kill("SIGKILL");
    if (identities?.profile && path.basename(identities.profile).startsWith("reach-chrome-"))
      await fs.rm(identities.profile, { recursive: true, force: true }).catch(caught => cleanupErrors.push(caught));
    await fs.rm(dir, { recursive: true, force: true }).catch(caught => cleanupErrors.push(caught));
    try { await record(t, { mode, phase, closeElapsedMs, outcome: error || cleanupErrors.length ? "failed" : "passed", error: error?.message || null,
      identities: identities ? { parent: identities.parent, descendant: identities.descendant } : null,
      canary: canary || null, canaryStartup, beforeCleanup, cleanup, cleanupErrors: cleanupErrors.map(caught => caught.message),
      lifetime: result || browser?.lifetime?.() || null }); }
    catch (caught) { cleanupErrors.push(caught); }
    if (cleanupErrors.length) {
      for (const cleanup of cleanupErrors) t.diagnostic(`fixture cleanup failed: ${cleanup.message}`);
      if (!error) throw new AggregateError(cleanupErrors, "Windows browser fixture cleanup failed");
    }
  }
}

test("Windows browser lifetime: parent exit cannot abandon inherited pipes and a locked profile", { skip, timeout: 60000 }, async t => {
  await fixtureCase(t, "orphan");
});

test("Windows browser lifetime: an unresponsive parent and descendant stop without touching a canary", { skip, timeout: 60000 }, async t => {
  await fixtureCase(t, "unresponsive");
});

test("Windows browser lifetime: real Chrome closes its owned job before its profile is removed", { skip, timeout: 60000 }, async t => {
  let browser, version, lifetime, error;
  let phase = "browser-launch";
  try {
    const binary = findChrome();
    assert.ok(binary, "the actual Windows lane requires its installed Chrome");
    browser = await helper.launchChrome(t, { binary });
    version = await browser.send("Browser.getVersion");
    phase = "browser-close";
    await browser.close();
    phase = "owned-tree-confirmation";
    lifetime = assertOwnedStopped(browser);
    phase = "complete";
  } catch (caught) { error = caught; throw caught; }
  finally {
    try { await record(t, { mode: "real-chrome", phase, outcome: error ? "failed" : "passed", error: error?.message || null,
      chrome: version?.product || null, lifetime: lifetime || browser?.lifetime?.() || null }); }
    catch (caught) { if (error) t.diagnostic(`lifetime report failed: ${caught.message}`); else throw caught; }
  }
});
