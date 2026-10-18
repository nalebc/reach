import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { loadPty, releaseExitedPty } from "../../server/pty-helper.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exec = promisify(execFile);
const worker = process.env.REACH_ACCEPTANCE_UPGRADE_WORKER === "1";
const hostedWindows = process.platform === "win32" && process.env.GITHUB_ACTIONS === "true"
  && process.env.RUNNER_ENVIRONMENT === "github-hosted" && process.env.RUNNER_OS === "Windows";
const quotePS = (value) => `'${String(value).replaceAll("'", "''")}'`;
const redact = (value) => String(value)
  .replace(/Pairing\s+code:\s*\d{4}\s*\d{4}/gi, "Pairing code: [redacted]")
  .replace(/\bBearer\s+\S+|\b(?:tskey-[\w-]+|sk-[\w-]+)/gi, "[redacted credential]")
  .replace(/([?&#](?:token|secret|pair|invite|key)=)[^\s&#"']+/gi, "$1[redacted]");
const json = (value) => JSON.parse(String(value).replace(/^\uFEFF/, "").trim());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function run(file, args, timeout = 60000, options = {}) {
  try { return { ok: true, ...(await exec(file, args, { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, ...options })) }; }
  catch (error) { return { ok: false, stdout: String(error.stdout || ""), stderr: String(error.stderr || ""), error: redact(error.message) }; }
}
function ps(script, timeout, options) {
  return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], timeout, options);
}

test("real installed Windows 0.3.1 to 0.3.3 upgrade preserves and protects default user state", {
  skip: !hostedWindows && "requires a disposable GitHub-hosted Windows VM",
  timeout: worker ? 900000 : 1170000,
}, async (t) => {
  const reportDir = path.join(repo, "reports", "windows-upgrade-state");
  fs.mkdirSync(reportDir, { recursive: true });
  if (!worker) {
    const result = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(repo, "test", "acceptance", "run-standard-user-upgrade.ps1"), "-RepoRoot", repo, "-NodeExecutable", process.execPath], 1140000);
    // A terminated worker cannot run its own after-hook. Preserve completed
    // evidence but make any unfinished phase explicitly fail in the artifact.
    const workerReport = path.join(reportDir, "upgrade.json");
    let recorded;
    try { recorded = json(fs.readFileSync(workerReport, "utf8")); } catch {}
    if (recorded) {
      for (const one of recorded.cases) if (one.status === "RUNNING") {
        one.status = "FAIL"; one.error = "The actual worker phase did not finish.";
      }
      if (recorded.cases.some((one) => one.status === "FAIL")) recorded.overall = "FAIL";
      fs.writeFileSync(workerReport, redact(JSON.stringify(recorded, null, 2)) + "\n");
    }
    let harness;
    try { harness = json(fs.readFileSync(path.join(reportDir, "harness.json"), "utf8")); } catch {}
    assert.equal(harness?.status, "PASS", `Actual account/profile/cleanup harness failed at ${harness?.stage || "an unreported stage"}; no upgrade conclusion follows.`);
    const report = json(fs.readFileSync(workerReport, "utf8"));
    assert.ok(result.ok, `Actual installed upgrade probes failed; see upgrade.json (${report.cases.filter((one) => one.status === "FAIL").map((one) => one.id).join(", ")}).`);
    assert.equal(report.overall, "BLOCKED", "all attempted upgrade/ACL cases must pass; configured-owner QR remains blocked");
    assert.equal(harness.cleanup, "PASS");
    return;
  }

  const reportPath = path.join(reportDir, "upgrade.json");
  const report = {
    schema: 1, startedAt: new Date().toISOString(), checkoutCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
    execution: "actual GitHub-hosted Windows VM, genuine standard local account and default loaded profile; official published npm packages and real NTFS/console",
    osRelease: os.release(), node: process.version, architecture: process.arch, fullDeviceQualification: false,
    cases: [{ id: "configured-owner-private-and-browser-QR", status: "BLOCKED", prerequisite: "A genuine authorized enrolled Tailscale host and CLI-created setup are absent. No enrollment, fabricated preferences or network fixture is used." }],
  };
  const write = () => {
    report.overall = report.cases.some((one) => one.status === "FAIL") ? "FAIL"
      : report.cases.some((one) => one.status === "RUNNING") ? "RUNNING" : "BLOCKED";
    fs.writeFileSync(reportPath, redact(JSON.stringify(report, null, 2)) + "\n");
  };
  async function check(id, action) {
    const one = { id, status: "RUNNING" };
    report.cases.push(one); write();
    await t.test(id, async () => {
      try { await action(one); one.status = "PASS"; }
      catch (error) { one.status = "FAIL"; one.error = redact(error.message); throw Error(one.error); }
      finally { write(); }
    });
    return one.status === "PASS";
  }
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  const scratch = path.join(os.homedir(), "ReachUpgradeAcceptance");
  const prefix = path.join(scratch, "npm");
  const shared = path.join(scratch, "shared");
  const state = path.join(os.homedir(), ".reach");
  const installed = path.join(prefix, "node_modules", "@nalebc", "reach");
  const launcher = path.join(prefix, "reach.cmd");
  const npm = path.join(path.dirname(process.execPath), "npm.cmd");
  const hash = (file, algorithm = "sha256") => createHash(algorithm).update(fs.readFileSync(file)).digest(algorithm === "sha512" ? "base64" : "hex");
  const cli = (args, timeout = 60000) => ps(`& ${quotePS(launcher)} ${args.map(quotePS).join(" ")}; exit $LASTEXITCODE`, timeout, { env });
  let started = false, fixture, checker, sid;

  async function stopOwned() {
    if (!started) return { attempted: false };
    const stopped = await new Promise((resolve, reject) => {
      const term = loadPty().spawn(process.env.ComSpec, ["/d", "/c", launcher, "stop"], { cwd: scratch, env, cols: 180, rows: 50, name: "xterm-256color", useConptyDll: true });
      let output = "", answered = false;
      const timer = setTimeout(() => { try { term.kill(); } catch {} releaseExitedPty(term); reject(Error("Owned interactive CLI stop exceeded 60 seconds.")); }, 60000);
      term.onData((chunk) => {
        output = (output + chunk).slice(-16000);
        if (!answered && /Stop Reach(?: anyway)?\?[\s\S]*\[y\/N\]/i.test(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""))) { answered = true; term.write("y\r"); }
      });
      term.onExit(({ exitCode }) => { clearTimeout(timer); releaseExitedPty(term); resolve({ exitCode, confirmed: answered, output: redact(output) }); });
    });
    assert.equal(stopped.exitCode, 0, stopped.output);
    const status = await cli(["status"]);
    assert.ok(status.ok, status.error);
    assert.match(status.stdout, /^Reach isn't running\./);
    started = false;
    return { actualInteractiveCLI: true, confirmed: stopped.confirmed, stopped: true };
  }
  t.after(async () => {
    try {
      report.cleanup = await stopOwned();
      fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      report.cleanup.status = "PASS";
    } catch (error) { report.cleanup = { status: "FAIL", error: redact(error.message) }; report.cases.push({ id: "owned-cli-cleanup", status: "FAIL", error: redact(error.message) }); throw error; }
    finally {
      for (const one of report.cases) if (one.status === "RUNNING") { one.status = "FAIL"; one.error = "The actual probe did not finish."; }
      report.finishedAt = new Date().toISOString(); write();
    }
  });
  if (!await check("actual-standard-user-default-profile", async (one) => {
    for (const key of Object.keys(process.env)) assert.ok(!/^REACH_TEST_|^REACH_(?:HOME|DATA|TAILSCALE|CODEX)$|^HOME$|^CODEX_HOME$|^NODE_OPTIONS$/i.test(key), `no profile/production override (${key})`);
    const inspected = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(repo, "test", "acceptance", "read-process-token.ps1"), "-TargetProcessId", String(process.pid)]);
    assert.ok(inspected.ok, inspected.error);
    const token = json(inspected.stdout);
    assert.equal(token.userSid, process.env.REACH_ACCEPTANCE_EXPECTED_SID);
    assert.equal(token.inspectingUserSid, token.userSid);
    assert.equal(token.elevated, false); assert.equal(token.administratorRole, false);
    assert.equal(token.integritySid, "S-1-16-8192"); assert.equal(token.profileHiveLoaded, true);
    for (const directory of [token.userProfile, token.nativeProfileDirectory, token.profileListDirectory]) assert.equal(path.resolve(directory).toLowerCase(), path.resolve(os.homedir()).toLowerCase());
    assert.notEqual(path.resolve(os.homedir()).toLowerCase(), path.resolve(process.env.REACH_ACCEPTANCE_RUNNER_PROFILE).toLowerCase());
    assert.equal(fs.existsSync(state), false, "the genuine new account must start without old Reach state");
    sid = token.userSid; report.token = token; report.defaultStatePath = state;
    fs.mkdirSync(shared, { recursive: true });
    one.evidence = token;
  })) return;

  async function compile(source, destination, web = false) {
    const candidates = ["Framework64", "Framework"].map((folder) => path.join(process.env.SystemRoot, "Microsoft.NET", folder, "v4.0.30319", "csc.exe"));
    const csc = candidates.find((file) => fs.existsSync(file));
    assert.ok(csc, "the actual Microsoft Framework compiler is required");
    const result = await run(csc, ["/nologo", "/target:exe", `/out:${destination}`, "/reference:System.dll", ...(web ? ["/reference:System.Web.Extensions.dll"] : []), source], 60000);
    assert.ok(result.ok, result.error);
    return { sourceSHA256: hash(source), executableSHA256: hash(destination), compiler: csc };
  }
  if (!await check("compile-read-only-native-ACL-fixture", async (one) => {
    fixture = path.join(scratch, "existing-state-acl.exe");
    one.evidence = await compile(path.join(repo, "test", "fixtures", "windows", "existing-state-acl.cs"), fixture, true);
  })) return;
  async function snapshot(target) {
    const value = await run(fixture, ["snapshot", target]); assert.ok(value.ok, value.error); return json(value.stdout);
  }
  async function inspectState() {
    const result = await run(checker, [sid, "state", state, path.join(state, "quick"), "code", installed], 120000);
    assert.ok(result.ok, result.error);
    return { checkerResult: result.stdout.trim(), acl: await snapshot(state) };
  }
  async function startAndInspect() {
    const before = await cli(["status"]); assert.ok(before.ok, before.error); assert.match(before.stdout, /^Reach isn't running\./);
    const script = path.join(scratch, "start-owned.cmd");
    for (const value of [launcher, script, scratch, shared]) assert.ok(!/[%"\r\n]/.test(value));
    fs.writeFileSync(script, ["@echo off", "title Reach installed-upgrade acceptance", "ping -n 5 127.0.0.1 >nul", `call "${launcher}" --local --no-stay-awake --folder "${shared}"`, ""].join("\r\n"));
    const opened = await ps(`$p = Start-Process -FilePath $env:ComSpec -ArgumentList ${quotePS(`/d /s /c ""${script}""`)} -WorkingDirectory ${quotePS(scratch)} -WindowStyle Normal -PassThru; $p.Id`, 60000, { env });
    assert.ok(opened.ok, opened.error); started = true;
    const consolePid = Number(opened.stdout.trim()); assert.ok(Number.isInteger(consolePid) && consolePid > 0);
    let last = "", ready = false;
    for (const end = Date.now() + 180000; Date.now() < end; await sleep(1000)) {
      const read = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(repo, "test", "acceptance", "read-windows-console.ps1"), "-ConsoleProcessId", String(consolePid)], 30000, { env });
      if (!read.ok) { last = read.error; continue; }
      const buffer = json(read.stdout); assert.equal(buffer.visible, true); last = buffer.text;
      if (/http:\/\/127\.0\.0\.1:\d+/.test(last) && /Pairing\s+code:\s*\d{4}\s*\d{4}/i.test(last)) { ready = true; break; }
    }
    assert.ok(ready, `Actual installed CLI did not produce its local URL/code. ${redact(last).slice(-2000)}`);
    const status = await cli(["status"]); assert.ok(status.ok, status.error); assert.match(status.stdout, /in a terminal window/);
    const inspected = await inspectState();
    return { consolePid, actualConsoleVisible: true, actualCLI: launcher, status: redact(status.stdout.trim()), ...inspected };
  }
  async function install(version, evidence) {
    const spec = `@nalebc/reach@${version}`;
    evidence.installation = { requestedVersion: version, prefix, phase: "registry-metadata" }; write();
    const view = await ps(`& ${quotePS(npm)} view ${quotePS(spec)} dist --json; exit $LASTEXITCODE`, 60000, { env }); assert.ok(view.ok, view.error);
    const dist = json(view.stdout); assert.match(dist.tarball, /^https:\/\/registry\.npmjs\.org\/@nalebc\/reach\/-\/reach-[0-9.]+\.tgz$/);
    Object.assign(evidence.installation, { source: dist.tarball, registryIntegrity: dist.integrity, phase: "official-package-download" }); write();
    const packed = await ps(`& ${quotePS(npm)} pack ${quotePS(spec)} --json --pack-destination ${quotePS(scratch)}; exit $LASTEXITCODE`, 120000, { env }); assert.ok(packed.ok, packed.error);
    const pack = json(packed.stdout)[0]; assert.equal(pack.version, version); assert.equal(pack.name, "@nalebc/reach");
    assert.equal(path.basename(pack.filename), pack.filename);
    const tarball = path.join(scratch, pack.filename); const integrity = `sha512-${hash(tarball, "sha512")}`;
    assert.equal(integrity, dist.integrity); assert.equal(pack.integrity, integrity);
    Object.assign(evidence.installation, { downloadedIntegrity: integrity, phase: "npm-global-install" }); write();
    const result = await ps(`& ${quotePS(npm)} install --global --prefix ${quotePS(prefix)} ${quotePS(tarball)}; exit $LASTEXITCODE`, 180000, { env }); assert.ok(result.ok, result.error);
    const actual = await cli(["--version"]); assert.ok(actual.ok, actual.error); assert.equal(actual.stdout.trim(), version);
    assert.equal(json(fs.readFileSync(path.join(installed, "package.json"), "utf8")).version, version);
    evidence.installation.phase = "installed-production-checker-compile"; write();
    checker = path.join(scratch, `private-folder-${version}.exe`);
    const checkerBuild = await compile(path.join(installed, "scripts", "native", "private-folder.cs"), checker);
    return { version, source: dist.tarball, integrity, prefix, checkerBuild };
  }

  // No fixture setup/ACL mutation occurs until BOTH ordinary installed versions
  // have launched and stopped with this exact unchanged default user profile.
  let baselineLaunchedAndStopped = true;
  for (const version of ["0.3.1", "0.3.3"]) {
    if (!baselineLaunchedAndStopped) {
      report.cases.push({ id: `unmodified-default-state-installed-${version}`, status: "BLOCKED", prerequisite: "The preceding actual baseline did not complete its installed CLI start/stop; its failure is retained." }); write();
      break;
    }
    let lifecycleComplete = false;
    await check(`unmodified-default-state-installed-${version}`, async (one) => {
      one.evidence = { classification: "ordinary installed upgrade; no injected ACL changes", defaultStatePath: state }; write();
      one.evidence.installation = await install(version, one.evidence); write();
      try { one.evidence.launch = await startAndInspect(); }
      finally { one.evidence.cleanup = await stopOwned(); write(); }
      lifecycleComplete = one.evidence.cleanup.stopped === true;
      assert.equal(one.evidence.launch.checkerResult, "ok", "the actual CLI launch must leave the retained state tree private; owner local access alone is insufficient");
    });
    baselineLaunchedAndStopped = lifecycleComplete;
  }
  if (!baselineLaunchedAndStopped || started || !fs.existsSync(checker) || !fs.existsSync(state)) {
    for (const mode of ["file-explicit", "directory-protected"]) report.cases.push({ id: `controlled-legacy-child-${mode}`, status: "BLOCKED", prerequisite: "The ordinary installed upgrade lifecycle did not complete; no ACL fixture was injected." });
    write(); return;
  }
  for (const mode of ["file-explicit", "directory-protected"]) {
    if (started) {
      report.cases.push({ id: `controlled-legacy-child-${mode}`, status: "BLOCKED", prerequisite: "The preceding owned Reach could not be stopped; its failure is retained and no second Reach is started." }); write();
      break;
    }
    await check(`controlled-legacy-child-${mode}`, async (one) => {
      const root = fs.mkdtempSync(path.join(state, "reach-existing-state-"));
      try {
        const setup = await run(fixture, ["setup", root, mode]); assert.ok(setup.ok, setup.error);
        const receipt = path.join(root, "state", "history", "legacy.json"); const beforeHash = hash(receipt);
        one.evidence = { classification: "controlled real NTFS ACL variant after ordinary upgrade baseline", mode, before: json(setup.stdout), beforeContentSHA256: beforeHash };
        write();
        try { one.evidence.launch = await startAndInspect(); }
        finally { one.evidence.cleanup = await stopOwned(); write(); }
        one.evidence.afterContentSHA256 = hash(receipt); assert.equal(hash(receipt), beforeHash);
        assert.equal(one.evidence.launch.checkerResult, "ok", "a same-owner legacy broad child ACL must be repaired by the actual launch, or this probe fails");
      } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
    });
  }
});
