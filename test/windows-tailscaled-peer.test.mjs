import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { cscCandidates } from "../server/desktop-native.mjs";
import { parseNetstat, parseScQueryex, parseWhoamiGroups } from "./helpers/windows-oracle.mjs";

// The peer check against a real LocalSystem service on a real Windows runner
// (docs/parity/D-public-door.md §8, the spike): Tailscale's process shape
// (a service that babysits a `/subproc` child) stood in for by
// test/fixtures/windows/fake-tailscaled.cs, registered as "Tailscale"; Reach
// stood in for by test/fixtures/windows/peer-host.mjs, run as a standard user
// with an interactive logon; another standard user trying everything else.
// Windows' own netstat, sc and CIM are the second opinion, and
// test/fixtures/windows/peer-probe.cs names which of the helper's calls
// Windows refuses, for whom.
//
// Only on a disposable CI runner (it creates users and a service named
// Tailscale, refuses to start if one exists, and ends by installing
// Tailscale's own MSI): REACH_TEST_WINDOWS_PEER=1, CI=true.
// What it can't prove (real Serve and Funnel, the real service's DACL,
// tailscaled's own-machine listener, phones) is the owner's acceptance (§9).
const enabled = process.platform === "win32" && process.env.REACH_TEST_WINDOWS_PEER === "1" && process.env.CI === "true";
const skip = enabled ? false : "a real Windows CI runner only (REACH_TEST_WINDOWS_PEER=1, CI=true)";
const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const fixtures = path.join(here, "fixtures", "windows");
const SYSTEM32 = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
const CI_ROOT = "C:\\ReachPeerCI";
const SERVICE_DIR = path.win32.join(process.env.ProgramFiles || "C:\\Program Files", "ReachPeerCI");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, what, ms = 30000) => {
  for (const end = Date.now() + ms; ; ) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw Error(`timed out waiting: ${what}`);
    await sleep(200);
  }
};
// A Windows program: its output and exit code, never a throw.
const run = async (file, args, options = {}) => {
  try {
    const { stdout, stderr } = await exec(file, args, { windowsHide: true, maxBuffer: 8 << 20, timeout: 120000, ...options });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === "number" ? error.code : -1, stdout: error.stdout || "", stderr: error.stderr || String(error.message) };
  }
};
const system = (name) => path.win32.join(SYSTEM32, name);
const sc = (...args) => run(system("sc.exe"), args);
const netCmd = (...args) => run(system("net.exe"), args);
const icacls = (...args) => run(system("icacls.exe"), args);
const pwsh = (command) => run("pwsh", ["-NoProfile", "-NonInteractive", "-Command", command]);
// A script of several lines, whole: Windows' argument quoting can't touch it.
const pwshScript = (script) => run("pwsh", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : []);
const readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "(nothing written)");
const events = (results) => readLines(path.join(results, "events.jsonl")).map((line) => JSON.parse(line));
// The probe's lines where Windows said no: a Win32 error, or an NT status other than 0.
const refusals = (text) => text.split(/\r?\n/).filter((line) => / error \d+|status 0x(?!00000000)/.test(line));
// A group's attributes in the probe's "token groups" line: NaN if it isn't there.
const groupAttributes = (text, sid) => {
  const line = text.split(/\r?\n/).find((l) => l.startsWith("token groups ")) || "";
  const found = line.split(" ").find((part) => part.startsWith(`${sid}:`));
  return found ? parseInt(found.slice(sid.length + 1), 16) : NaN;
};

async function compile(source, out, references = []) {
  const csc = cscCandidates().find((candidate) => fs.existsSync(candidate));
  assert.ok(csc, "csc.exe");
  const framework = path.win32.dirname(csc);
  const built = await run(csc, ["/nologo", "/noconfig", "/target:exe", "/platform:anycpu", "/optimize+", `/out:${out}`,
    ...["System.dll", ...references].map((name) => `/reference:${path.win32.join(framework, name)}`), source]);
  assert.equal(built.code, 0, `${path.basename(source)}: ${built.stdout}${built.stderr}`);
}
const password = () => `${crypto.randomBytes(18).toString("base64").replace(/[^A-Za-z0-9]/g, "x")}Aa1!`;

test("the peer check against a real LocalSystem service: Tailscale's own child counts, nothing else does", { skip, timeout: 1500000 }, async (t) => {
  // Never on a computer with a real Tailscale service.
  const existing = await sc("query", "Tailscale");
  assert.equal(existing.code, 1060, "a real Tailscale service is installed; refusing to touch it");
  fs.mkdirSync(CI_ROOT, { recursive: true });
  fs.mkdirSync(SERVICE_DIR, { recursive: true });
  const bin = path.join(CI_ROOT, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const tailscaled = path.win32.join(SERVICE_DIR, "tailscaled.exe");
  const runAs = path.join(bin, "run-as.exe");
  const bindProbe = path.join(bin, "bind-probe.exe");
  const peerProbe = path.join(bin, "peer-probe.exe");
  // The helper itself, to run directly in each context (Reach builds its own).
  const helperCopy = path.join(bin, "tailscaled-peer.exe");
  await compile(path.join(fixtures, "fake-tailscaled.cs"), tailscaled, ["System.ServiceProcess.dll"]);
  await compile(path.join(fixtures, "run-as.cs"), runAs);
  await compile(path.join(fixtures, "bind-probe.cs"), bindProbe);
  await compile(path.join(fixtures, "peer-probe.cs"), peerProbe);
  await compile(path.join(repo, "scripts", "native", "tailscaled-peer.cs"), helperCopy);

  // Two standard users: reachci runs Reach, reachci2 is somebody else on the PC.
  const users = { reachci: password(), reachci2: password() };
  for (const [name, pw] of Object.entries(users)) {
    const added = await netCmd("user", name, pw, "/add", "/Y");
    assert.equal(added.code, 0, added.stderr);
  }
  const sids = {};
  for (const name of Object.keys(users)) sids[name] = (await run(runAs, ["sid", name])).stdout.trim();
  // The runner's own account, for its token without elevation.
  const runnerSid = (await run(runAs, ["sid", os.userInfo().username])).stdout.trim();
  const rightsAdded = new Set();
  let batchRight = false;
  t.after(async () => {
    await sc("stop", "Tailscale");
    await sc("delete", "Tailscale");
    await run(system("taskkill.exe"), ["/F", "/IM", "tailscaled.exe"]);
    await run(system("taskkill.exe"), ["/F", "/IM", "bind-probe.exe"]);
    for (const name of Object.keys(users)) {
      if (sids[name]) await run(runAs, ["desktop", "revoke", sids[name]]);
      if (rightsAdded.has(name)) await run(runAs, ["logon-right", "remove", name]);
      if (name === "reachci" && batchRight) await run(runAs, ["logon-right", "remove", name, "SeBatchLogonRight"]);
      await netCmd("user", name, "/delete");
    }
    if (runnerSid) await run(runAs, ["desktop", "revoke", runnerSid]);
    for (const task of ["ReachPeerCI", "ReachPeerProbe", "ReachPeerLaunch"]) await run(system("schtasks.exe"), ["/delete", "/tn", task, "/f"]);
  });
  for (const sid of [...Object.values(sids), runnerSid]) {
    const granted = await run(runAs, ["desktop", "grant", sid]);
    assert.equal(granted.code, 0, granted.stdout);
  }
  // Folders each user may write: reachci's results, reachci2's probe logs,
  // the service's log, and reachci's state (tightened by peer-host itself).
  // `results` and `state` are Reach's, as `reachMode` runs it (case 1).
  const folder = async (dir, ...grants) => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const set = await icacls(dir, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", ...grants.map((sid) => `*${sid}:(OI)(CI)F`), "/Q");
    assert.equal(set.code, 0, set.stdout);
    return dir;
  };
  const reachciResults = await folder(path.join(CI_ROOT, "results"), sids.reachci);
  const probes = await folder(path.join(CI_ROOT, "probes"), sids.reachci2);
  const serviceLog = path.join(await folder(path.join(CI_ROOT, "service")), "fake.log");
  const reachciState = await folder(path.join(CI_ROOT, "reachci-state"), sids.reachci);
  let results = reachciResults;
  let state = reachciState;
  // "session": reachci, interactive, in session 0 (Windows' CreateProcessAsUser,
  // from a SYSTEM task); "secondary": reachci in the runner's session (the
  // secondary logon service); "limited": the runner without elevation, in its
  // own session; "runner": the runner itself.
  let reachMode = "session";

  // As a user, interactively; logon right added if Windows Server lacks it.
  const asUser = async (name, commandLine, { wait = true, dir = CI_ROOT } = {}) => {
    let started = await run(runAs, ["run", name, users[name], dir, wait ? "wait" : "nowait", commandLine]);
    if (/error 1385/.test(started.stdout) && !rightsAdded.has(name)) {
      const right = await run(runAs, ["logon-right", "add", name]);
      assert.equal(right.code, 0, right.stdout);
      rightsAdded.add(name);
      started = await run(runAs, ["run", name, users[name], dir, wait ? "wait" : "nowait", commandLine]);
    }
    assert.equal(started.code, 0, `no interactive logon for ${name}: ${started.stdout}${started.stderr}`);
    return Number(/pid (\d+)/.exec(started.stdout)?.[1]);
  };
  const quote = (value) => `"${value}"`;
  const node = quote(process.execPath);
  const peerHostScript = quote(path.join(fixtures, "peer-host.mjs"));
  // Reach (peer-host) as reachci (or the runner), until `stop`.
  const startPeerHost = async (dir = results, code = "") => {
    for (const name of ["peer-host.json", "events.jsonl", "stop"]) fs.rmSync(path.join(dir, name), { force: true });
    // What it runs if its check won't start (peer-host.mjs).
    fs.copyFileSync(peerProbe, path.join(dir, "peer-probe.exe"));
    const command = `${node} ${peerHostScript} ${quote(dir)} ${quote(state)}${code ? ` ${quote(code)}` : ""}`;
    if (reachMode === "runner") spawn(process.execPath, [path.join(fixtures, "peer-host.mjs"), dir, state, ...(code ? [code] : [])], { cwd: repo, detached: true, stdio: "ignore", windowsHide: true }).unref();
    else if (reachMode === "limited") await run(runAs, ["filtered", repo, "nowait", command]);
    else if (reachMode === "session") {
      const said = await launch("reachci", command, { session: 0, wait: false, dir: repo });
      if (!/^pid \d+/.test(said)) throw Error(`the SYSTEM task said: ${said}`);
    }
    else await asUser("reachci", command, { wait: false, dir: repo });
    const ready = await until(() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, "peer-host.json"), "utf8"));
      } catch {
        return null;
      }
    }, "peer-host ready", 180000);
    t.diagnostic(`peer-host: ${JSON.stringify({ ...ready, key: ready.key ? "(set)" : undefined })}`);
    return ready;
  };
  const stopPeerHost = async (dir = results) => {
    fs.writeFileSync(path.join(dir, "stop"), "");
    await sleep(3000);
  };

  // The interactive token really is interactive.
  await asUser("reachci", `cmd.exe /c whoami /groups /fo csv > ${quote(path.join(reachciResults, "whoami.csv"))}`);
  const groups = parseWhoamiGroups(fs.readFileSync(path.join(reachciResults, "whoami.csv"), "utf8"));
  assert.ok(groups.includes("S-1-5-4"), `INTERACTIVE missing from reachci's token: ${groups.join(" ")}`);

  // The service: Tailscale's name, LocalSystem, its own process.
  const created = await sc("create", "Tailscale", "binPath=", quote(tailscaled), "type=", "own", "start=", "demand", "obj=", "LocalSystem");
  assert.equal(created.code, 0, created.stdout);
  const recorded = path.join(fixtures, "tailscale-service.sddl");
  if (fs.existsSync(recorded)) {
    const sdset = await sc("sdset", "Tailscale", fs.readFileSync(recorded, "utf8").trim());
    assert.equal(sdset.code, 0, sdset.stdout);
  }
  t.diagnostic(`sc sdshow Tailscale: ${(await sc("sdshow", "Tailscale")).stdout.trim()}`);
  t.diagnostic(`sc sdshow scmanager: ${(await sc("sdshow", "scmanager")).stdout.trim()}`);
  const serviceState = async () => parseScQueryex((await sc("queryex", "Tailscale")).stdout).state;
  // Stopped for good (1), not just stopping: only then does it start again.
  const stopService = async () => {
    await sc("stop", "Tailscale");
    await until(async () => (await serviceState()) === 1, "the service stopped");
  };
  // One mode at a time: whatever runs (idle, or an earlier case's mode) stops first.
  const startService = async (...args) => {
    if ((await serviceState()) !== 1) await stopService();
    fs.rmSync(serviceLog, { force: true });
    const started = await sc("start", "Tailscale", ...args);
    assert.equal(started.code, 0, started.stdout);
    await until(async () => (await serviceState()) === 4, "the service running");
  };
  // Running, as Tailscale's service is whenever Reach starts: idle until a
  // case starts it in its own mode.
  await startService();

  // As reachci, with LogonUser's interactive token, put in `session` by a
  // SYSTEM task (run-as system-run: Windows' CreateProcessAsUser, not the
  // secondary logon service): what it answered ("pid", "exit" or "error").
  const launchFile = path.join(CI_ROOT, "service", "launch.args");
  const launchTask = await run(system("schtasks.exe"), ["/create", "/tn", "ReachPeerLaunch", "/ru", "SYSTEM", "/sc", "once", "/st", "23:59", "/tr", `${runAs} system-run ${launchFile}`, "/f"]);
  assert.equal(launchTask.code, 0, launchTask.stdout + launchTask.stderr);
  const launch = async (name, commandLine, { session = 0, wait = true, dir = CI_ROOT } = {}) => {
    const answer = `${launchFile}.out`;
    fs.rmSync(answer, { force: true });
    fs.writeFileSync(launchFile, `${[name, users[name], session, dir, wait ? "wait" : "nowait", commandLine].join("\r\n")}\r\n`);
    await run(system("schtasks.exe"), ["/run", "/tn", "ReachPeerLaunch"]);
    await until(() => fs.existsSync(answer), "the SYSTEM task's launch", 120000).then(() => sleep(500), () => {});
    return readText(answer).replace(/\r?\n/g, ", ");
  };

  // What each of the helper's calls gives whom (peer-probe.cs), from the
  // service manager's descriptor down: the runner (an administrator); the
  // runner without elevation in its own session (as UAC gives a Terminal);
  // reachci, interactive, in session 0 and in the runner's session (put
  // there by Windows itself); reachci put in the runner's session by the
  // secondary logon service (run-as run); reachci with a batch token.
  t.diagnostic(`rpc filters: ${(await run(system("netsh.exe"), ["rpc", "filter", "show", "filter"])).stdout.trim()}`);
  t.diagnostic(`sessions:\n${(await run(system("qwinsta.exe"), [])).stdout.trim()}`);
  const saved = await pwsh(String.raw`try { $v = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\ServiceGroupOrder\Security' -ErrorAction Stop).Security; ([System.Security.AccessControl.RawSecurityDescriptor]::new([byte[]]$v, 0)).GetSddlForm('All') } catch { 'none: ' + $_.Exception.Message }`);
  t.diagnostic(`scmanager saved descriptor: ${saved.stdout.trim()}${saved.stderr.trim()}`);
  const probeDir = await folder(path.join(CI_ROOT, "as"), "S-1-1-0");
  const probeOut = (label) => path.join(probeDir, `${label}.txt`);
  const brief = (text) => text.split(/\r?\n/).filter((line) => /^(token (session|integrity|groups)|OpenSCManagerW|OpenServiceW|  QueryService|NtQuerySystemInformation 88|QueryDosDeviceW|exception)/.test(line)).join("\n");
  // The helper's own first line, run directly (stdin empty: it ends there).
  const helperLine = (label) => `cmd.exe /c ${helperCopy} < nul > ${quote(probeOut(`helper-${label}`))} 2>&1`;
  const helperSaid = (label) => readText(probeOut(`helper-${label}`)).replace(/\r?\n/g, " ");
  await run(peerProbe, [probeOut("runner")]);
  await run(system("cmd.exe"), ["/c", helperLine("runner").replace(/^cmd\.exe \/c /, "")], { windowsVerbatimArguments: true });
  const runnerProbed = readText(probeOut("runner"));
  t.diagnostic(`peer-probe as the runner (the helper says: ${helperSaid("runner")}):\n${runnerProbed}`);
  const runnerSession = Number(/^token session (\d+)$/m.exec(runnerProbed)?.[1] ?? NaN);
  const limitedRan = await run(runAs, ["filtered", CI_ROOT, "wait", `${quote(peerProbe)} ${quote(probeOut("limited"))}`]);
  await run(runAs, ["filtered", CI_ROOT, "wait", helperLine("limited")]);
  t.diagnostic(`peer-probe as the runner without elevation (${`${limitedRan.stdout}${limitedRan.stderr}`.trim().replace(/\r?\n/g, ", ")}; the helper says: ${helperSaid("limited")}):\n${brief(readText(probeOut("limited")))}`);
  for (const session of new Set([0, runnerSession])) {
    const label = `reachci-session-${session}`;
    const said = await launch("reachci", `${quote(peerProbe)} ${quote(probeOut(label))}`, { session });
    await launch("reachci", helperLine(label), { session });
    t.diagnostic(`peer-probe as reachci, interactive, in session ${session} (${said}; the helper says: ${helperSaid(label)}):\n${brief(readText(probeOut(label)))}`);
  }
  const reachciProbe = path.join(reachciResults, "probe-reachci.txt");
  await asUser("reachci", `${quote(peerProbe)} ${quote(reachciProbe)}`);
  const probed = readText(reachciProbe);
  await asUser("reachci", helperLine("secondary"));
  t.diagnostic(`peer-probe as reachci, put in the runner's session by the secondary logon service (the helper says: ${helperSaid("secondary")}):\n${probed}`);
  const scQc = path.join(reachciResults, "sc-qc.txt");
  await asUser("reachci", `cmd.exe /c ${system("sc.exe")} qc Tailscale > ${quote(scQc)} 2>&1`);
  t.diagnostic(`sc qc Tailscale, the same way: ${readText(scQc).replace(/\r?\n\s*/g, " ")}`);
  // reachci with a batch token: a scheduled task with its password, once
  // reachci may log on as a batch job (Windows Server doesn't let Users).
  const batchGranted = await run(runAs, ["logon-right", "add", "reachci", "SeBatchLogonRight"]);
  batchRight = batchGranted.code === 0;
  assert.ok(batchRight, `SeBatchLogonRight for reachci: ${batchGranted.stdout}`);
  const batchProbe = path.join(reachciResults, "probe-batch.txt");
  const task = await run(system("schtasks.exe"), ["/create", "/tn", "ReachPeerProbe", "/ru", "reachci", "/rp", users.reachci, "/sc", "once", "/st", "23:59", "/tr", `${peerProbe} ${batchProbe}`, "/f"]);
  if (task.code === 0) {
    await run(system("schtasks.exe"), ["/run", "/tn", "ReachPeerProbe"]);
    await until(() => fs.existsSync(batchProbe), "the batch probe", 60000).then(() => sleep(1000), () => {});
  }
  t.diagnostic(`peer-probe as reachci with a batch token:\n${task.code ? `${task.stdout}${task.stderr}` : brief(readText(batchProbe))}`);
  await run(system("schtasks.exe"), ["/delete", "/tn", "ReachPeerProbe", "/f"]);

  // 1. Ready without elevation: the service manager, the TCP table and the
  // process list all answer, with the reason in words when they don't.
  // Each way Reach can be run here, one at a time; the first that's ready
  // (reachci's, if Windows lets it) serves the cases after.
  const limitedResults = await folder(path.join(CI_ROOT, "results-limited"), runnerSid);
  const limitedState = await folder(path.join(CI_ROOT, "limited-state"), runnerSid);
  const tryReach = async (mode, dir, stateDir) => {
    reachMode = mode;
    results = dir;
    state = stateDir;
    let ready;
    try {
      ready = await startPeerHost(dir);
    } catch (error) {
      ready = { ready: { ok: false, reason: `peer-host didn't start: ${error.message}` } };
    }
    if (!ready.ready.ok) t.diagnostic(`${mode}: peer-probe from its own Node: ${brief(readText(path.join(dir, "peer-probe-node.txt")))}`);
    return ready;
  };
  const limited = await tryReach("limited", limitedResults, limitedState);
  if (limited.ready.ok) await stopPeerHost(limitedResults);
  const secondary = await tryReach("secondary", reachciResults, reachciState);
  if (secondary.ready.ok) await stopPeerHost(reachciResults);
  // Why session 0: on this runner the service manager refuses any non-admin
  // program in the runner's own session 2, whatever its token (run 4,
  // validation/door-proof-45c8321f: reachci's interactive token connects in
  // session 0 and is refused in session 2, put there by SYSTEM's
  // CreateProcessAsUser or by the secondary logon service alike). reachci has
  // no session of its own here; 1a is a non-elevated user in its own one.
  const own = await tryReach("session", reachciResults, reachciState);
  await t.test("1. a standard user with an interactive token (reachci, started by Windows in session 0): ready", () => {
    // INTERACTIVE is there and enabled (4), not deny-only (0x10).
    const interactive = groupAttributes(readText(probeOut("reachci-session-0")), "S-1-5-4");
    assert.ok((interactive & 0x4) && !(interactive & 0x10), `INTERACTIVE in reachci's token: ${interactive.toString(16)}`);
    assert.deepEqual(own.ready, { ok: true }, `refused for reachci: ${refusals(readText(probeOut("reachci-session-0"))).join("; ") || "nothing the probe saw"}`);
  });
  await t.test("1a. this PC's own user without elevation, in its own session (UAC's limited token, as a Terminal gets it): ready", () => {
    assert.deepEqual(limited.ready, { ok: true }, `refused: ${refusals(readText(probeOut("limited"))).join("; ") || "nothing the probe saw"}`);
  });
  await t.test("1c. a standard user's program the secondary logon service puts in another user's session: ready, or refused in words", () => {
    t.diagnostic(`secondary logon: ${JSON.stringify(secondary.ready)} (${refusals(probed).join("; ") || "no refusals"})`);
    if (!secondary.ready.ok)
      assert.match(secondary.ready.reason, /^Windows didn't let Reach read Tailscale's service settings\. This happens when Reach runs outside a signed-in Windows session/);
  });
  // The Reach the cases below run against.
  let host = own;
  if (!own.ready.ok && limited.ready.ok) host = await tryReach("limited", limitedResults, limitedState);
  else if (!own.ready.ok) host = await tryReach("runner", await folder(path.join(CI_ROOT, "results-runner")), await folder(path.join(CI_ROOT, "runner-state")));
  t.diagnostic(`the cases below run against Reach as: ${reachMode}`);
  assert.deepEqual(host.ready, { ok: true }, `Reach as ${reachMode}`);
  const url = `http://127.0.0.1:${host.port}/r-${host.key}`;
  const Q = host.port;

  await t.test("1b. a batch logon (a scheduled task): ready, or refused in words", async () => {
    const batch = await folder(path.join(CI_ROOT, "results-batch"), sids.reachci);
    fs.copyFileSync(peerProbe, path.join(batch, "peer-probe.exe"));
    const script = path.join(CI_ROOT, "bin", "batch.cmd");
    fs.writeFileSync(script, `@${node} ${peerHostScript} ${quote(batch)} ${quote(reachciState)}\r\n`);
    const made = await run(system("schtasks.exe"), ["/create", "/tn", "ReachPeerCI", "/ru", "reachci", "/rp", users.reachci, "/sc", "once", "/st", "23:59", "/tr", script, "/f"]);
    assert.equal(made.code, 0, made.stdout + made.stderr);
    await run(system("schtasks.exe"), ["/run", "/tn", "ReachPeerCI"]);
    const answer = await until(() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(batch, "peer-host.json"), "utf8"));
      } catch {
        return null;
      }
    }, "the batch peer-host", 180000);
    t.diagnostic(`batch logon: ${JSON.stringify(answer.ready)}`);
    if (!answer.ready.ok) t.diagnostic(`peer-probe with the batch token:\n${readText(path.join(batch, "peer-probe-node.txt"))}`);
    if (!answer.ready.ok)
      assert.match(answer.ready.reason, /^Windows didn't let Reach read Tailscale's service settings\. This happens when Reach runs outside a signed-in Windows session/);
    await stopPeerHost(batch);
  });

  await t.test("2. Tailscale's /subproc child: both probes on one connection, one check, and Windows agrees", async () => {
    await startService("subproc", url, serviceLog);
    await until(() => readLines(serviceLog).length >= 2, "the child's probes");
    assert.deepEqual(readLines(serviceLog), ["child /probe1 200", "child /probe2 200"]);
    const seen = events(results);
    const requests = seen.filter((e) => e.request);
    assert.deepEqual(requests.map((e) => e.request), ["/probe1", "/probe2"]);
    assert.equal(new Set(requests.map((e) => e.port)).size, 1, "one connection");
    const answers = seen.filter((e) => e.answer && e.answer.port === requests[0].port);
    assert.equal(answers.length, 1, "one helper query for it");
    const [{ answer }] = answers;
    t.diagnostic(`createdMs ${answer.createdMs}, acceptedAt ${answer.acceptedAt}`);
    assert.equal(answer.value, "t");
    assert.ok(answer.createdMs > 0 && answer.createdMs <= answer.acceptedAt + 20);
    // Windows' own tools: the connection's owner is the child, whose parent is the service.
    const row = parseNetstat((await run(system("netstat.exe"), ["-ano", "-p", "tcp"])).stdout)
      .find((r) => r.local.address === "127.0.0.1" && r.local.port === requests[0].port && r.remote.port === Q);
    assert.ok(row, "netstat lists the connection");
    const service = parseScQueryex((await sc("queryex", "Tailscale")).stdout);
    assert.notEqual(row.pid, service.pid);
    const parent = Number((await pwsh(`(Get-CimInstance Win32_Process -Filter 'ProcessId=${row.pid}').ParentProcessId`)).stdout.trim());
    assert.equal(parent, service.pid);
    await stopService();
  });

  await t.test("3. the service process itself", async () => {
    await startService("self", url, serviceLog);
    await until(() => readLines(serviceLog).length >= 2, "its probes");
    assert.deepEqual(readLines(serviceLog), ["self /probe1 200", "self /probe2 200"]);
    await stopService();
  });

  await t.test("4-5. the same program started by anyone else, or in session 0 through WMI: refused", async () => {
    // With the service up, so each is refused as another process's (o), not
    // because Tailscale's service is down (n).
    await startService();
    const before = events(results).length;
    const direct = path.join(probes, "direct.log");
    await run(tailscaled, ["/direct", url, direct]);
    assert.ok(readLines(direct).every((line) => / error /.test(line)), readLines(direct).join("\n"));
    const wmi = path.join(CI_ROOT, "service", "wmi.log");
    fs.rmSync(wmi, { force: true });
    await pwsh(`Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '"${tailscaled}" /direct ${url} "${wmi}"' } | Out-Null`);
    await until(() => readLines(wmi).length >= 2, "the WMI process's probes");
    assert.ok(readLines(wmi).every((line) => / error /.test(line)), readLines(wmi).join("\n"));
    assert.ok(events(results).some((e) => e.refused === "peer"));
    const answers = events(results).slice(before).filter((e) => e.answer).map((e) => e.answer.value);
    t.diagnostic(`answers: ${answers.join(" ")}`);
    assert.ok(answers.length >= 2 && answers.every((value) => value === "o"), `each refused as another process's: ${answers.join(" ")}`);
    await stopService();
  });

  await t.test("6. an orphan of a stopped service, and after the service starts again: refused", async () => {
    await startService("linger", url, serviceLog);
    await until(() => readLines(serviceLog).some((line) => line === "child /linger 200"), "accepted while the service runs");
    await stopService();
    const stoppedAt = readLines(serviceLog).length;
    await until(() => readLines(serviceLog).length >= stoppedAt + 2, "the orphan asking again", 20000);
    assert.ok(readLines(serviceLog).slice(stoppedAt).every((line) => / error /.test(line)), "refused once the service stopped");
    assert.ok(events(results).some((e) => e.answer?.value === "n"));
    await sc("start", "Tailscale", "idle");
    const restartedAt = readLines(serviceLog).length;
    await until(() => readLines(serviceLog).length >= restartedAt + 2, "the orphan asking the new service", 20000);
    assert.ok(readLines(serviceLog).slice(restartedAt).every((line) => / error /.test(line)), "refused: not the new service's child");
    assert.ok(events(results).some((e) => e.answer?.value === "o"));
    await stopService();
    await run(system("taskkill.exe"), ["/F", "/IM", "tailscaled.exe"]);
  });

  await t.test("7. the service's child without the key: 404, and the helper never asked", async () => {
    const before = events(results).filter((e) => e.answer).length;
    await startService("nokey", `http://127.0.0.1:${Q}/api/health`, serviceLog);
    await until(() => readLines(serviceLog).length >= 1, "its request");
    // Also D5's evidence: what Tailscale forwards to the port (an exit node's
    // traffic, a TCP forward) arrives from Tailscale's process without the key.
    assert.deepEqual(readLines(serviceLog), ["child  404"]);
    assert.equal(events(results).filter((e) => e.answer).length, before);
    await stopService();
  });

  // Straight to the keyed port from the runner (an administrator, but not Tailscale).
  const direct = (text) =>
    new Promise((resolve) => {
      const socket = net.connect(Q, "127.0.0.1");
      const chunks = [];
      let done = false;
      const finish = (how) => {
        if (done) return;
        done = true;
        socket.destroy();
        resolve({ how, text: Buffer.concat(chunks).toString("latin1") });
      };
      socket.on("data", (chunk) => chunks.push(chunk));
      socket.on("close", () => finish("closed"));
      socket.on("error", () => finish("closed"));
      setTimeout(() => finish("open"), 5000);
      socket.write(text);
    });

  await t.test("8. from another process: a wrong key gets 404; the right key with forged headers gets nothing", async () => {
    const wrong = await direct(`GET /r-${"A".repeat(43)}/api/health HTTP/1.1\r\nHost: x\r\n\r\n`);
    assert.equal(wrong.how, "closed");
    assert.match(wrong.text, /^HTTP\/1\.1 404 /);
    const forged = await direct(`GET /r-${host.key}/api/health HTTP/1.1\r\nHost: x\r\nTailscale-User-Login: owner@example.test\r\nX-Forwarded-For: 100.64.0.20\r\n\r\n`);
    assert.deepEqual(forged, { how: "closed", text: "" });
  });

  await t.test("9. another user binding Reach's port: refused on 127.0.0.1; a wildcard bind gets nothing while Reach listens", async () => {
    const probe = async (name, args, { hold = 0 } = {}) => {
      const log = path.join(probes, `${name}.log`);
      fs.rmSync(log, { force: true });
      await asUser("reachci2", `${quote(bindProbe)} ${args.join(" ")} ${quote(log)}${hold ? ` hold ${hold}` : ""}`, { wait: !hold });
      await until(() => readLines(log).length >= 1, `${name}'s bind`, 30000);
      return log;
    };
    const plain = readLines(await probe("plain", ["127.0.0.1", Q, "plain"]));
    const reuse = readLines(await probe("reuse", ["127.0.0.1", Q, "reuse"]));
    t.diagnostic(`127.0.0.1 plain: ${plain}; reuse: ${reuse}`);
    assert.deepEqual(plain, ["refused 10048"], "D is blocked if another user can bind 127.0.0.1:Q");
    assert.deepEqual(reuse, ["refused 10013"], "D is blocked if another user can bind 127.0.0.1:Q");
    for (const [name, args] of [["any-plain", ["0.0.0.0", Q, "plain"]], ["any-reuse", ["0.0.0.0", Q, "reuse"]], ["v6-plain", ["[::]", Q, "plain"]]]) {
      const log = await probe(name, args, { hold: 30 });
      const [bound] = readLines(log);
      t.diagnostic(`${name}: ${bound}`);
      if (bound !== "bound") continue;
      // While it holds: Tailscale's child and this runner still reach Reach, and the probe nothing.
      const before = events(results).filter((e) => e.request).length;
      await startService("subproc", url, serviceLog);
      await until(() => readLines(serviceLog).length >= 2, "the child's probes");
      assert.deepEqual(readLines(serviceLog), ["child /probe1 200", "child /probe2 200"]);
      assert.equal(events(results).filter((e) => e.request).length, before + 2);
      const forged = await direct(`GET /r-${host.key}/api/health HTTP/1.1\r\nHost: x\r\nTailscale-User-Login: owner@example.test\r\n\r\n`);
      assert.deepEqual(forged, { how: "closed", text: "" });
      await stopService();
      assert.ok(!readLines(log).some((line) => line.startsWith("accepted")), `D is blocked: ${name} got a connection meant for Reach`);
    }
    await run(system("taskkill.exe"), ["/F", "/IM", "bind-probe.exe"]);
  });

  await t.test("12. a helper changed on disk after its build: never started again", async () => {
    const native = path.join(state, "native");
    const helper = fs.readdirSync(native).find((name) => /^reach-tailscaled-peer-[0-9a-f]{12}\.exe$/.test(name));
    assert.ok(helper, "the cached helper");
    // Windows won't overwrite a running program; moved aside, replaced, and the running one ended.
    fs.renameSync(path.join(native, helper), path.join(native, `${helper}.old`));
    fs.copyFileSync(tailscaled, path.join(native, helper));
    await run(system("taskkill.exe"), ["/F", "/IM", helper]);
    await until(() => events(results).some((e) => e.problem === "Reach's Tailscale check couldn't start (it changed on disk)."), "the swap refused", 30000);
    await stopPeerHost();
  });

  await t.test("10. no Tailscale service at all: pairing codes, with the reason", async () => {
    await stopService();
    await sc("delete", "Tailscale");
    // A fresh build of the helper (the swapped one was set aside).
    fs.rmSync(path.join(state, "native"), { recursive: true, force: true });
    const fresh = await startPeerHost();
    assert.deepEqual(fresh.ready, { ok: false, reason: "Tailscale isn't installed as a Windows service here." });
  });

  await t.test("11. Reach's folders: another user's file or a code folder others can change refuses; private ones pass, and stay private", async () => {
    const open = path.join(CI_ROOT, "open");
    fs.rmSync(open, { recursive: true, force: true });
    fs.mkdirSync(open);
    // Under C:\ it inherits Authenticated Users: Modify, as a checkout there does.
    await icacls(open, "/reset", "/Q");
    const reach = path.join(open, ".reach");
    const quick = path.join(reach, "quick");
    const checker = path.join(fixtures, "private-check.mjs");
    const check = async (code, out) => {
      fs.rmSync(out, { force: true });
      await asUser("reachci", `${node} ${quote(checker)} ${quote(out)} ${quote(reach)} ${quote(quick)} ${quote(code)}`, { dir: repo });
      return JSON.parse(fs.readFileSync(out, "utf8"));
    };
    await asUser("reachci", `cmd.exe /c mkdir ${quote(quick)}`);
    await asUser("reachci2", `cmd.exe /c echo planted> ${quote(path.join(quick, "x.json"))}`);
    const planted = await check(open, path.join(reachciResults, "planted.json"));
    t.diagnostic(`planted: ${JSON.stringify(planted)}`);
    assert.equal(planted.ok, false);
    fs.rmSync(path.join(quick, "x.json"), { force: true });
    const shared = await check(open, path.join(reachciResults, "shared.json"));
    t.diagnostic(`code under C:\\: ${JSON.stringify(shared)}`);
    assert.equal(shared.ok, false);
    assert.match(shared.reason, /can be changed by other people on this PC/);
    const own = `C:\\Users\\reachci\\code`;
    await asUser("reachci", `cmd.exe /c mkdir ${quote(own)}`);
    const fine = await check(own, path.join(reachciResults, "fine.json"));
    assert.deepEqual(fine, { ok: true });
    const secret = path.join(quick, "tailscale-oauth.json");
    await asUser("reachci", `cmd.exe /c echo {}> ${quote(secret)}`);
    const typed = path.join(probes, "type.txt");
    await asUser("reachci2", `cmd.exe /c type ${quote(secret)} > ${quote(typed)} 2>&1`);
    assert.doesNotMatch(fs.readFileSync(typed, "utf8"), /^\{\}/, "reachci2 read Reach's OAuth client");
  });

  await t.test("13. Tailscale's own MSI: its service is what the helper expects, its daemon is the service's child, and Reach is ready against it", async () => {
    // Tailscale's signed installer, on this disposable runner (the stand-in
    // is gone since case 10).
    const index = await (await fetch("https://pkgs.tailscale.com/stable/?mode=json")).json();
    const name = String(index.MSIs?.amd64 || "");
    assert.match(name, /^tailscale-setup-[0-9.]+-amd64\.msi$/);
    const msi = path.join(CI_ROOT, name);
    fs.writeFileSync(msi, Buffer.from(await (await fetch(`https://pkgs.tailscale.com/stable/${name}`)).arrayBuffer()));
    const signature = await pwsh(`$s = Get-AuthenticodeSignature -LiteralPath '${msi}'; '' + $s.Status + ' ' + $s.SignerCertificate.Subject`);
    t.diagnostic(`${name}: ${signature.stdout.trim()}`);
    assert.match(signature.stdout.trim(), /^Valid .*Tailscale/);
    // What it declares about its service before it's installed: no
    // permissions of its own means the service manager's default DACL.
    const tables = await pwshScript(String.raw`$i = New-Object -ComObject WindowsInstaller.Installer
$db = $i.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $i, @('MSI_PATH', 0))
function Rows([string]$query) {
  try {
    $v = $db.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $db, @($query))
    [void]$v.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $v, $null)
    $out = @()
    while ($true) {
      $r = $v.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $v, $null)
      if ($null -eq $r) { break }
      $n = $r.GetType().InvokeMember('FieldCount', 'GetProperty', $null, $r, $null)
      $f = @(); for ($k = 1; $k -le $n; $k++) { $f += $r.GetType().InvokeMember('StringData', 'GetProperty', $null, $r, @($k)) }
      $out += ($f -join ' | ')
    }
    if ($out.Count) { $out -join ' || ' } else { '(none)' }
  } catch { '(no such table)' }
}
'tables: ' + (Rows 'SELECT Name FROM _Tables')
foreach ($t in @('ServiceInstall', 'ServiceControl', 'MsiServiceConfig', 'LockPermissions', 'MsiLockPermissionsEx')) { $t + ': ' + (Rows ('SELECT * FROM ' + $t)) }
'CustomAction: ' + (Rows 'SELECT Action, Type, Source FROM CustomAction')`.replace("MSI_PATH", msi));
    t.diagnostic(`${name}:\n${tables.stdout.trim()}${tables.stderr.trim()}`);
    const installed = await run(system("msiexec.exe"), ["/i", msi, "/qn", "/norestart", "/l*v", path.join(CI_ROOT, "tailscale-msi.log")], { timeout: 600000 });
    assert.ok([0, 1641, 3010].includes(installed.code), `msiexec ${installed.code}`);
    await until(async () => (await serviceState()) === 4, "Tailscale's service running", 120000);
    t.diagnostic(`sc sdshow Tailscale, as Tailscale's MSI installs it: ${(await sc("sdshow", "Tailscale")).stdout.trim()}`);
    t.diagnostic(`sc qc Tailscale: ${(await sc("qc", "Tailscale")).stdout.trim().replace(/\r?\n\s*/g, " | ")}`);
    // Its daemon: the service's /subproc child, as the helper accepts one.
    const seen = probeOut("tailscale");
    await until(async () => {
      await run(peerProbe, [seen]);
      return /^child .*image tailscaled\.exe/im.test(readText(seen));
    }, "Tailscale's daemon", 60000);
    const lines = readText(seen).split(/\r?\n/);
    t.diagnostic(`peer-probe against Tailscale's service:\n${lines.filter((line) => /^(  Query|NtQuerySystemInformation 5|NtQuerySystemInformation 88 service|child |QueryDosDeviceW)/.test(line)).join("\n")}`);
    assert.ok(lines.some((line) => /^  QueryServiceStatusEx ok type 0x10 state 4 /.test(line)), "its own process, running");
    assert.ok(lines.some((line) => /^  QueryServiceConfigW ok .* account LocalSystem binary "[A-Z]:\\[^"]*\\tailscaled\.exe"/i.test(line)), "LocalSystem, a quoted path to tailscaled.exe");
    const servicePath = /^NtQuerySystemInformation 88 service ok (.+)$/m.exec(readText(seen))?.[1];
    assert.ok(servicePath, "the service's program");
    assert.ok(lines.some((line) => line.startsWith("child ") && /image tailscaled\.exe/i.test(line) && / session 0 /.test(line) && / after-service True /.test(line) && line.toLowerCase().endsWith(` path ok ${servicePath}`.toLowerCase())), "a child the helper accepts: tailscaled.exe, session 0, made after the service, the same program");
    // Reach, as it ran for the cases above, is ready against it.
    const fresh = await startPeerHost();
    assert.deepEqual(fresh.ready, { ok: true }, `Reach as ${reachMode}`);
    await stopPeerHost();
  });
});
