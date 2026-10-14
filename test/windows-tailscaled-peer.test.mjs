import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
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
// Tailscale, and refuses if one exists): REACH_TEST_WINDOWS_PEER=1, CI=true.
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
  await compile(path.join(fixtures, "fake-tailscaled.cs"), tailscaled, ["System.ServiceProcess.dll"]);
  await compile(path.join(fixtures, "run-as.cs"), runAs);
  await compile(path.join(fixtures, "bind-probe.cs"), bindProbe);
  await compile(path.join(fixtures, "peer-probe.cs"), peerProbe);

  // Two standard users: reachci runs Reach, reachci2 is somebody else on the PC.
  const users = { reachci: password(), reachci2: password() };
  for (const [name, pw] of Object.entries(users)) {
    const added = await netCmd("user", name, pw, "/add", "/Y");
    assert.equal(added.code, 0, added.stderr);
  }
  const sids = {};
  for (const name of Object.keys(users)) sids[name] = (await run(runAs, ["sid", name])).stdout.trim();
  const rightsAdded = new Set();
  t.after(async () => {
    await sc("stop", "Tailscale");
    await sc("delete", "Tailscale");
    await run(system("taskkill.exe"), ["/F", "/IM", "tailscaled.exe"]);
    await run(system("taskkill.exe"), ["/F", "/IM", "bind-probe.exe"]);
    for (const name of Object.keys(users)) {
      if (sids[name]) await run(runAs, ["desktop", "revoke", sids[name]]);
      if (rightsAdded.has(name)) await run(runAs, ["logon-right", "remove", name]);
      await netCmd("user", name, "/delete");
    }
    await run(system("schtasks.exe"), ["/delete", "/tn", "ReachPeerCI", "/f"]);
    await run(system("schtasks.exe"), ["/delete", "/tn", "ReachPeerProbe", "/f"]);
  });
  for (const name of Object.keys(users)) {
    const granted = await run(runAs, ["desktop", "grant", sids[name]]);
    assert.equal(granted.code, 0, granted.stdout);
  }
  // Folders each user may write: reachci's results, reachci2's probe logs,
  // the service's log, and reachci's state (tightened by peer-host itself).
  const folder = async (dir, ...grants) => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const set = await icacls(dir, "/inheritance:r", "/grant:r", "*S-1-5-18:(OI)(CI)F", "*S-1-5-32-544:(OI)(CI)F", ...grants.map((sid) => `*${sid}:(OI)(CI)F`), "/Q");
    assert.equal(set.code, 0, set.stdout);
    return dir;
  };
  const results = await folder(path.join(CI_ROOT, "results"), sids.reachci);
  const probes = await folder(path.join(CI_ROOT, "probes"), sids.reachci2);
  const serviceLog = path.join(await folder(path.join(CI_ROOT, "service")), "fake.log");
  const state = await folder(path.join(CI_ROOT, "reachci-state"), sids.reachci);

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
  // Reach (peer-host) as reachci, until `stop`.
  const startPeerHost = async (dir = results, code = "") => {
    for (const name of ["peer-host.json", "events.jsonl", "stop"]) fs.rmSync(path.join(dir, name), { force: true });
    // What it runs if its check won't start (peer-host.mjs).
    fs.copyFileSync(peerProbe, path.join(dir, "peer-probe.exe"));
    await asUser("reachci", `${node} ${peerHostScript} ${quote(dir)} ${quote(state)}${code ? ` ${quote(code)}` : ""}`, { wait: false, dir: repo });
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
  await asUser("reachci", `cmd.exe /c whoami /groups /fo csv > ${quote(path.join(results, "whoami.csv"))}`);
  const groups = parseWhoamiGroups(fs.readFileSync(path.join(results, "whoami.csv"), "utf8"));
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

  // What each of the helper's calls gives the runner (an administrator), then
  // reachci (its interactive token), with Windows' own sc and whoami beside it.
  const runnerProbe = path.join(CI_ROOT, "service", "probe-runner.txt");
  await run(peerProbe, [runnerProbe]);
  t.diagnostic(`peer-probe as the runner:\n${readText(runnerProbe)}`);
  // A refusal pinned to what it depends on: the runner's own token narrowed
  // (Medium integrity; Administrators, then LOCAL too, deny-only).
  const narrowed = await folder(path.join(CI_ROOT, "as"), "S-1-1-0");
  for (const variant of ["medium", "no-admin", "no-admin-medium", "no-admin-no-local"]) {
    const out = path.join(narrowed, `${variant}.txt`);
    await run(peerProbe, [out, "as", variant]);
    const lines = readText(out).split(/\r?\n/).filter((line) => /^(token (integrity|groups)|OpenSCManagerW|OpenServiceW|as |exception)/.test(line));
    t.diagnostic(`peer-probe as the runner, ${variant}:\n${lines.join("\n")}`);
  }
  // Windows' RPC filters, the service manager's saved descriptor (labels
  // included) and settings, and UAC's.
  t.diagnostic(`rpc filters: ${(await run(system("netsh.exe"), ["rpc", "filter", "show", "filter"])).stdout.trim()}`);
  const saved = await pwsh(String.raw`try { $v = (Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\ServiceGroupOrder\Security' -ErrorAction Stop).Security; ([System.Security.AccessControl.RawSecurityDescriptor]::new([byte[]]$v, 0)).GetSddlForm('All') } catch { 'none: ' + $_.Exception.Message }`);
  t.diagnostic(`scmanager saved descriptor: ${saved.stdout.trim()}${saved.stderr.trim()}`);
  t.diagnostic(`SCMConfig: ${(await run(system("reg.exe"), ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\SCMConfig", "/s"])).stdout.trim()}`);
  t.diagnostic(`system policies: ${(await run(system("reg.exe"), ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System"])).stdout.trim()}`);
  const reachciProbe = path.join(results, "probe-reachci.txt");
  await asUser("reachci", `${quote(peerProbe)} ${quote(reachciProbe)}`);
  const probed = readText(reachciProbe);
  t.diagnostic(`peer-probe as reachci:\n${probed}`);
  // reachci with a batch token (a scheduled task with its password).
  const batchProbe = path.join(results, "probe-batch.txt");
  const task = await run(system("schtasks.exe"), ["/create", "/tn", "ReachPeerProbe", "/ru", "reachci", "/rp", users.reachci, "/sc", "once", "/st", "23:59", "/tr", `${peerProbe} ${batchProbe}`, "/f"]);
  if (task.code === 0) {
    await run(system("schtasks.exe"), ["/run", "/tn", "ReachPeerProbe"]);
    await until(() => fs.existsSync(batchProbe), "the batch probe", 60000).then(() => sleep(1000), () => {});
  }
  t.diagnostic(`peer-probe as reachci with a batch token:\n${task.code ? `${task.stdout}${task.stderr}` : readText(batchProbe)}`);
  await run(system("schtasks.exe"), ["/delete", "/tn", "ReachPeerProbe", "/f"]);
  for (const [name, command] of [["sc-qc", `${system("sc.exe")} qc Tailscale`], ["sc-queryex", `${system("sc.exe")} queryex Tailscale`], ["whoami-all", `${system("whoami.exe")} /all`]]) {
    const out = path.join(results, `${name}.txt`);
    await asUser("reachci", `cmd.exe /c ${command} > ${quote(out)} 2>&1`);
    t.diagnostic(`${name} as reachci:\n${readText(out)}`);
  }

  // 1. Ready as the interactive standard user: the service manager, the TCP
  // table and the process list all answer without elevation.
  const host = await startPeerHost();
  if (!host.ready.ok) {
    // The real helper as reachci outside Node, and what Node's own process got.
    const native = path.join(state, "native");
    const helper = fs.existsSync(native) && fs.readdirSync(native).find((name) => /^reach-tailscaled-peer-[0-9a-f]{12}\.exe$/.test(name));
    if (helper) {
      const out = path.join(results, "helper-direct.txt");
      await asUser("reachci", `cmd.exe /c ${path.join(native, helper)} < nul > ${quote(out)} 2>&1`);
      t.diagnostic(`the helper itself, run as reachci from cmd: ${readText(out)}`);
    }
    t.diagnostic(`peer-probe from peer-host (Node, as reachci):\n${readText(path.join(results, "peer-probe-node.txt"))}`);
    t.diagnostic(`whoami /groups from peer-host:\n${readText(path.join(results, "peer-host-whoami.csv"))}`);
  }
  // INTERACTIVE is there and enabled (4), not deny-only (0x10).
  const interactive = groupAttributes(probed, "S-1-5-4");
  assert.ok((interactive & 0x4) && !(interactive & 0x10), `INTERACTIVE in reachci's token: ${interactive.toString(16)}`);
  assert.deepEqual(host.ready, { ok: true }, `refused for reachci: ${refusals(probed).join("; ") || "nothing the probe saw"}`);
  const url = `http://127.0.0.1:${host.port}/r-${host.key}`;
  const Q = host.port;

  await t.test("1b. a batch logon (a scheduled task): ready, or refused in words", async () => {
    const batch = await folder(path.join(CI_ROOT, "results-batch"), sids.reachci);
    fs.copyFileSync(peerProbe, path.join(batch, "peer-probe.exe"));
    const script = path.join(CI_ROOT, "bin", "batch.cmd");
    fs.writeFileSync(script, `@${node} ${peerHostScript} ${quote(batch)} ${quote(state)}\r\n`);
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
    const planted = await check(open, path.join(results, "planted.json"));
    t.diagnostic(`planted: ${JSON.stringify(planted)}`);
    assert.equal(planted.ok, false);
    fs.rmSync(path.join(quick, "x.json"), { force: true });
    const shared = await check(open, path.join(results, "shared.json"));
    t.diagnostic(`code under C:\\: ${JSON.stringify(shared)}`);
    assert.equal(shared.ok, false);
    assert.match(shared.reason, /can be changed by other people on this PC/);
    const own = `C:\\Users\\reachci\\code`;
    await asUser("reachci", `cmd.exe /c mkdir ${quote(own)}`);
    const fine = await check(own, path.join(results, "fine.json"));
    assert.deepEqual(fine, { ok: true });
    const secret = path.join(quick, "tailscale-oauth.json");
    await asUser("reachci", `cmd.exe /c echo {}> ${quote(secret)}`);
    const typed = path.join(probes, "type.txt");
    await asUser("reachci2", `cmd.exe /c type ${quote(secret)} > ${quote(typed)} 2>&1`);
    assert.doesNotMatch(fs.readFileSync(typed, "utf8"), /^\{\}/, "reachci2 read Reach's OAuth client");
  });
});
