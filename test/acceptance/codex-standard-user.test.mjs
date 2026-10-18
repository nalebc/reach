import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { findCodexExecutable } from "../../server/capabilities.mjs";
import { createCodexDaemon } from "../../server/agent-sessions/codex-daemon.mjs";
import { useOwnersFolder } from "../../server/windows-owners.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exec = promisify(execFile);
const optedIn = process.platform === "win32" && process.env.REACH_REAL_WINDOWS_CODEX_ACCEPTANCE === "1";
const redact = (value) => String(value)
  .replace(/\bBearer\s+\S+|\b(?:tskey-[\w-]+|sk-[\w-]+)/gi, "[redacted credential]")
  .replace(/([?&#](?:token|secret|pair|invite|key)=)[^\s&#"']+/gi, "$1[redacted]");
const lastJSON = (text) => JSON.parse(String(text).replace(/^\uFEFF/, "").trim().split(/\r?\n/).pop());
const run = async (file, args, timeout = 20000) => {
  try { return { ok: true, exitCode: 0, ...(await exec(file, args, { timeout, maxBuffer: 128 * 1024, windowsHide: true })) }; }
  catch (error) { return { ok: false, exitCode: error.code, stdout: String(error.stdout || ""), stderr: String(error.stderr || ""), error: redact(error.message) }; }
};
const shape = (status) => Object.fromEntries(Object.entries(status).map(([key, value]) => [key, value === null ? "null" : typeof value]));
async function endpointMetadata(endpoint) {
  const one = async (method) => {
    try {
      const value = await fs.promises[method](endpoint);
      return { available: true, isFile: value.isFile(), isSocket: value.isSocket(), isSymbolicLink: value.isSymbolicLink(), size: value.size };
    } catch (error) { return { available: false, errorCode: error.code }; }
  };
  // Never read the rendezvous/endpoint's contents, descriptors or credentials.
  return { lstat: await one("lstat"), stat: await one("stat") };
}

test("real Codex and Reach daemon client under a genuine standard Windows account", {
  skip: !optedIn && "requires the real disposable standard-user Windows harness",
  timeout: 165000,
}, async (t) => {
  const reportPath = process.env.REACH_ACCEPTANCE_CODEX_REPORT;
  assert.ok(reportPath && path.isAbsolute(reportPath));
  const report = {
    schema: 1, startedAt: new Date().toISOString(), platform: process.platform, osRelease: os.release(), node: process.version,
    checkoutCommit: process.env.REACH_ACCEPTANCE_CHECKOUT_COMMIT, prHeadCommit: process.env.REACH_ACCEPTANCE_PR_HEAD,
    execution: "real standard local account, LOGON_WITH_PROFILE, private test desktop; actual Codex CLI and unchanged Reach daemon client",
    scope: "local daemon compatibility only; no standard-user GUI/device parity or provider inference is claimed",
    overall: "RUNNING", fullDeviceQualification: false, providerInferenceAttempted: false, cases: [],
  };
  const write = () => {
    report.overall = report.cases.some((one) => one.status === "FAIL") ? "FAIL" : report.cases.some((one) => one.status === "RUNNING") ? "RUNNING" : "PASS";
    fs.writeFileSync(reportPath, redact(JSON.stringify(report, null, 2)) + "\n");
  };
  const check = (id, action) => t.test(id, async () => {
    const one = { id, status: "RUNNING", execution: "actual standard-user Windows process" };
    report.cases.push(one);
    write();
    try { one.evidence = await action(); one.status = "PASS"; }
    catch (error) { one.status = "FAIL"; one.error = redact(error.message); throw Error(one.error); }
    finally { write(); }
  });
  let ownersDir;
  t.after(() => {
    for (const one of report.cases) if (one.status === "RUNNING") {
      one.status = "FAIL";
      one.error = "The actual standard-user probe did not finish.";
    }
    report.finishedAt = new Date().toISOString();
    write();
    if (ownersDir) fs.rmSync(ownersDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let verifiedContext = false;
  await check("actual-standard-user-token-and-loaded-profile", async () => {
    for (const key of Object.keys(process.env)) assert.ok(!/^REACH_TEST_|^REACH_TAILSCALE$|^REACH_CODEX$|^NODE_OPTIONS$/.test(key), `no injected transport/runtime overrides (${key})`);
    const inspected = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(repo, "test", "acceptance", "read-process-token.ps1"), "-TargetProcessId", String(process.pid)]);
    assert.ok(inspected.ok, inspected.error);
    const state = lastJSON(inspected.stdout);
    assert.equal(state.processId, process.pid);
    assert.equal(state.userSid, process.env.REACH_ACCEPTANCE_EXPECTED_SID);
    assert.equal(state.inspectingUserSid, state.userSid);
    assert.equal(state.elevated, false);
    assert.equal(state.administratorRole, false);
    assert.equal(state.integritySid, "S-1-16-8192", "a real medium-integrity standard-user token");
    assert.equal(state.profileHiveLoaded, true, "the user's real registry profile must be loaded");
    assert.equal(path.resolve(os.homedir()).toLowerCase(), path.resolve(state.userProfile).toLowerCase());
    assert.equal(path.resolve(state.userProfile).toLowerCase(), path.resolve(state.nativeProfileDirectory).toLowerCase(), "the environment must match GetUserProfileDirectoryW for the actual worker token");
    assert.equal(path.resolve(state.nativeProfileDirectory).toLowerCase(), path.resolve(state.profileListDirectory).toLowerCase(), "the token profile must match Windows ProfileList for this actual SID");
    assert.notEqual(path.resolve(state.nativeProfileDirectory).toLowerCase(), path.resolve(process.env.REACH_ACCEPTANCE_RUNNER_PROFILE).toLowerCase(), "the worker must not reuse the administrator runner's profile");
    ownersDir = fs.mkdtempSync(path.join(os.homedir(), "reach-codex-acceptance-"));
    useOwnersFolder(ownersDir); // Normal production owner-check data folder; no injected check implementation.
    verifiedContext = true;
    report.token = state;
    return state;
  });
  if (!verifiedContext) return; // The actual failed context subtest keeps the test/run failed.
  let codex;
  await check("official-codex-discovery-version-and-help", async () => {
    const vendors = JSON.parse(fs.readFileSync(process.env.REACH_ACCEPTANCE_VENDOR_REPORT, "utf8").replace(/^\uFEFF/, ""));
    assert.equal(vendors.codex.status, "PASS");
    codex = await findCodexExecutable();
    assert.ok(codex, "production discovery must find the official installed CLI");
    assert.equal(path.resolve(codex).toLowerCase(), path.resolve(vendors.codex.executable).toLowerCase());
    assert.equal(createHash("sha256").update(fs.readFileSync(codex)).digest("hex"), vendors.codex.sha256);
    const version = await run(codex, ["--version"]);
    assert.ok(version.ok, version.error);
    report.codex = { version: version.stdout.trim(), packageVersion: vendors.codex.version, executableSHA256: vendors.codex.sha256 };
    report.vendorHelp = [];
    for (const args of [["app-server", "--help"], ["app-server", "daemon", "--help"]]) {
      const result = await run(codex, args);
      report.vendorHelp.push({ args, exitCode: result.exitCode, stdout: redact(result.stdout), stderr: redact(result.stderr) });
      write();
      assert.ok(result.ok, result.error);
    }
    return report.codex;
  });
  await check("real-standard-user-daemon-start-and-endpoint", async () => {
    assert.ok(codex, "the official executable must have been discovered");
    const started = await run(codex, ["app-server", "daemon", "start"], 45000);
    assert.ok(started.ok, started.error);
    const status = lastJSON(started.stdout);
    assert.equal(typeof status.socketPath, "string");
    const endpoint = { socketPath: status.socketPath, startStatusShape: shape(status), metadata: await endpointMetadata(status.socketPath) };
    report.endpoint = endpoint;
    write();
    const version = await run(codex, ["app-server", "daemon", "version"]);
    if (version.ok) {
      const value = lastJSON(version.stdout);
      report.daemonVersion = { cliVersion: value.cliVersion, managedCodexVersion: value.managedCodexVersion, appServerVersion: value.appServerVersion };
    } else report.daemonVersion = { error: version.error };
    return endpoint;
  });
  await check("reach-zero-injection-standard-user-initialize-and-thread-list", async () => {
    // No platform/process/transport/owner overrides and no alternate endpoint.
    // An unsupported real endpoint is an actual FAIL, never pass/skip.
    const daemon = createCodexDaemon();
    try {
      const threads = await daemon.rpc("thread/list", { limit: 1 });
      assert.ok(Array.isArray(threads.data));
      return { initialized: true, threadsReturned: threads.data.length, compatibility: await daemon.compatibility(), providerInferenceAttempted: false };
    } finally { daemon.close(); }
  });
});
