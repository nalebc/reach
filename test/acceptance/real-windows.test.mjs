import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import WebSocket from "ws";
import { findCodexExecutable } from "../../server/capabilities.mjs";
import { createCodexDaemon } from "../../server/agent-sessions/codex-daemon.mjs";
import { loadPty, releaseExitedPty } from "../../server/pty-helper.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quotePS = (value) => `'${String(value).replaceAll("'", "''")}'`;
const encoded = (script) => Buffer.from(script, "utf16le").toString("base64");
const optedIn = process.platform === "win32" && process.env.REACH_REAL_WINDOWS_ACCEPTANCE === "1";
const redact = (value) => String(value)
  .replace(/Pairing\s+code:\s*\d{4}\s*\d{4}/gi, "Pairing code: [redacted]")
  .replace(/\bBearer\s+\S+|\b(?:tskey-[\w-]+|sk-[\w-]+)/gi, "[redacted credential]")
  .replace(/https:\/\/(?:login|console)\.tailscale\.com\/\S+/gi, "[redacted login URL]")
  .replace(/([?&#](?:token|secret|pair|invite|key)=)[^\s&#"']+/gi, "$1[redacted]");
const run = async (file, args, options = {}) => {
  try {
    return { ok: true, ...(await exec(file, args, { timeout: 60000, maxBuffer: 1024 * 1024, windowsHide: true, ...options })) };
  } catch (error) {
    return { ok: false, stdout: String(error.stdout || ""), stderr: String(error.stderr || ""), error: redact(error.message) };
  }
};
const lastJSON = (text) => JSON.parse(String(text).replace(/^\uFEFF/, "").trim().split(/\r?\n/).pop());
async function until(check, label, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= end) throw Error(`Timed out waiting for ${label}.`);
    await sleep(500);
  }
}

test("real Windows vendor/local acceptance; complete device qualification is reported separately", {
  skip: !optedIn && "requires the explicit disposable Windows acceptance lane",
  timeout: 850000,
}, async (t) => {
  assert.equal(process.env.GITHUB_ACTIONS, "true", "never install/start on an owner's PC");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "a disposable hosted runner is required");
  assert.equal(process.env.RUNNER_OS, "Windows");
  for (const key of Object.keys(process.env)) {
    assert.ok(!/^REACH_TEST_|^REACH_TAILSCALE$|^REACH_CODEX$/.test(key), `the real lane must not inherit a test executable/transport override (${key})`);
  }
  const reportDir = path.join(repo, "reports", "real-windows-acceptance");
  fs.mkdirSync(reportDir, { recursive: true });
  const report = {
    schema: 1, startedAt: new Date().toISOString(), platform: process.platform,
    osRelease: os.release(), node: process.version,
    commit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
    execution: "actual GitHub-hosted Windows; vendor processes and real local HTTP; no simulated transports",
    physicalDevicesValidated: [], fullDeviceQualification: false,
    overall: "BLOCKED", qualification: "INCOMPLETE: authenticated network and physical-device prerequisites are absent",
    cases: [],
  };
  const blocked = (id, prerequisite) => report.cases.push({ id, status: "BLOCKED", prerequisite });
  const networkPrerequisite = "Approved real Tailscale host/client identities and HTTPS/Serve/Funnel configuration; no credentials are provided to PR jobs. No enrollment was attempted.";
  for (const id of ["private-native-route", "private-browser-cross-port-boundaries", "authenticated-public-agent-fallback", "private-fallback-private-recovery", "unavailable-and-unapproved-alternatives", "concurrent-requests-and-held-work", "public-owner-api-and-websocket-boundaries"])
    blocked(id, networkPrerequisite);
  blocked("provider-sign-in-and-inference", "A disposable signed-in provider account is required. CLI installation, daemon initialization and thread listing do not prove inference.");
  for (const device of ["iPhone", "iPad", "Android"])
    blocked(`physical-${device}`, `An authorized physical ${device} with its own approved device identity is required. No mirroring or user-agent emulation substitutes for this case.`);
  const write = () => {
    report.overall = report.cases.some((c) => c.status === "FAIL") ? "FAIL" : "BLOCKED";
    fs.writeFileSync(path.join(reportDir, "acceptance.json"), redact(JSON.stringify(report, null, 2)) + "\n");
  };
  const caseTest = (id, check) => t.test(id, async () => {
    const one = { id, status: "RUNNING", execution: "actual Windows" };
    report.cases.push(one);
    write();
    try {
      one.evidence = await check();
      one.status = "PASS";
    } catch (error) {
      one.status = "FAIL";
      one.error = redact(error.message);
      throw Error(one.error);
    } finally { write(); }
  });
  write();
  const finalize = () => {
    for (const one of report.cases) if (one.status === "RUNNING") {
      one.status = "FAIL";
      one.error = "The actual probe did not finish before the test ended.";
    }
    report.finishedAt = new Date().toISOString();
    write();
    const summary = ["## Real Windows acceptance: " + report.overall,
      "", "**Overall real-device qualification is incomplete.** Local mode does not qualify private Tailscale or Funnel. No provider inference or physical-device pass is claimed.",
      "", "| Case | Result | Evidence or prerequisite |", "| --- | --- | --- |",
      ...report.cases.map((c) => `| ${c.id} | ${c.status} | ${redact(c.error || c.prerequisite || "Real execution; see acceptance.json").replaceAll("|", "\\|").replaceAll("\n", " ")} |`), ""].join("\n");
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
    console.log("::warning title=Real-device qualification incomplete::Authenticated Tailscale/Funnel, provider inference, and physical iPhone/iPad/Android cases remain BLOCKED. Local probes cannot qualify them.");
    console.log(`Real Windows probes: ${report.overall}. Overall real-device qualification INCOMPLETE; ${report.cases.filter((c) => c.status === "BLOCKED").length} required cases BLOCKED. See redacted acceptance.json.`);
  };
  let vendors = {};
  await caseTest("official-vendor-installation", async () => {
    vendors = JSON.parse(fs.readFileSync(path.join(reportDir, "vendors.json"), "utf8").replace(/^\uFEFF/, ""));
    assert.equal(vendors.codex?.status, "PASS", vendors.codex?.reason);
    assert.equal(vendors.tailscale?.status, "PASS", vendors.tailscale?.reason);
    return { codexVersion: vendors.codex.version, tailscaleSource: vendors.tailscale.source, tailscaleService: vendors.tailscale.serviceStatus };
  });
  await caseTest("real-tailscale-service-status", async () => {
    const binary = vendors.tailscale?.executable || path.join(process.env.ProgramFiles, "Tailscale", "tailscale.exe");
    const version = await run(binary, ["version", "--json", "--daemon"]);
    assert.ok(version.ok, version.error);
    const status = await run(binary, ["status", "--json"]);
    // Read only selected fields; status can contain enrollment URLs/identity.
    const value = JSON.parse(status.stdout);
    assert.equal(typeof value.BackendState, "string");
    assert.ok(!value.CurrentTailnet, "this unauthenticated PR lane must not inherit an enrolled tailnet");
    const release = JSON.parse(version.stdout);
    assert.equal(release.short, "1.104.1");
    assert.match(release.daemonLong, /^1\.104\.1(?:-|$)/);
    return { version: { short: release.short, long: release.long, daemonLong: release.daemonLong }, statusExitSuccessful: status.ok, backendState: value.BackendState, authenticated: false, enrollmentAttempted: false };
  });
  let codex;
  await caseTest("real-codex-daemon-start-and-endpoint", async () => {
    codex = await findCodexExecutable();
    assert.ok(codex, "Reach must discover the installed real Codex CLI");
    assert.equal(path.resolve(codex).toLowerCase(), path.resolve(vendors.codex.executable).toLowerCase());
    assert.equal(createHash("sha256").update(fs.readFileSync(codex)).digest("hex"), vendors.codex.sha256);
    const version = await run(codex, ["--version"]);
    assert.ok(version.ok, version.error);
    const started = await run(codex, ["app-server", "daemon", "start"]);
    assert.ok(started.ok, started.error);
    const status = lastJSON(started.stdout);
    assert.equal(typeof status.socketPath, "string", "record the vendor's actual endpoint, without converting it");
    const daemonVersion = await run(codex, ["app-server", "daemon", "version"]);
    const release = daemonVersion.ok ? lastJSON(daemonVersion.stdout) : null;
    report.codex = {
      version: version.stdout.trim(), socketPath: status.socketPath,
      endpointKind: /^\\\\[.?]\\pipe\\/i.test(status.socketPath) ? "named-pipe" : "filesystem-or-other",
      startStatusShape: Object.fromEntries(Object.entries(status).map(([key, value]) => [key, value === null ? "null" : typeof value])),
      daemonVersion: release ? { cliVersion: release.cliVersion, managedCodexVersion: release.managedCodexVersion, appServerVersion: release.appServerVersion } : { error: daemonVersion.error },
    };
    return report.codex;
  });
  await caseTest("reach-real-codex-initialize-and-thread-list", async () => {
    // Deliberately zero injection: real executable discovery, exec, owner
    // checks, socket connection and initialization are production defaults.
    const daemon = createCodexDaemon();
    try {
      const result = await daemon.rpc("thread/list", { limit: 1 });
      assert.ok(Array.isArray(result.data));
      return { initialized: true, threadsReturned: result.data.length, compatibility: await daemon.compatibility(), inferenceAttempted: false };
    } finally { daemon.close(); }
  });

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "reach-real-acceptance-"));
  const shared = path.join(temp, "shared");
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, "acceptance.txt"), "real Windows read\n");
  const env = { ...process.env, REACH_HOME: path.join(temp, "state"), REACH_DATA: path.join(temp, "data"), REACH_SCREEN: "1" };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  const powershell = (script, options) => run("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded(script)], { env, ...options });
  const cli = (args) => powershell(`& ${quotePS(path.join(repo, "reach.cmd"))} ${args.map(quotePS).join(" ")}; exit $LASTEXITCODE`);
  const stopInConsole = () => new Promise((resolve, reject) => {
    const term = loadPty().spawn(process.env.ComSpec, ["/d", "/c", "reach.cmd", "stop"], {
      cwd: repo, env, cols: 180, rows: 50, name: "xterm-256color", useConptyDll: true,
    });
    let output = "", answered = false;
    const timer = setTimeout(() => {
      try { term.kill(); } catch {}
      releaseExitedPty(term);
      reject(Error("Interactive Reach stop did not finish in 90 seconds."));
    }, 90000);
    term.onData((chunk) => {
      output = (output + chunk).slice(-16000);
      const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      if (!answered && /Stop Reach(?: anyway)?\?[\s\S]*\[y\/N\]/i.test(plain)) {
        answered = true;
        // Only this hosted runner's owned disposable Reach was started;
        // answer its actual interactive prompt. Never pass --yes.
        term.write("y\r");
      }
    });
    term.onExit(({ exitCode }) => {
      clearTimeout(timer);
      releaseExitedPty(term);
      resolve({ ok: exitCode === 0, output: redact(output), confirmed: answered });
    });
  });
  let startedLocal = false, origin, code, token, terminalId;
  const request = async (route, { method = "GET", body } = {}) => {
    const response = await fetch(origin + route, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: "error",
    });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => {
    try {
      if (terminalId && token) await request(`/api/terminals/${encodeURIComponent(terminalId)}`, { method: "DELETE" }).catch(() => {});
      if (startedLocal) {
        const stopped = await stopInConsole();
        if (stopped.ok) {
          const after = await cli(["status"]);
          assert.ok(after.ok, after.error);
          assert.match(after.stdout, /^Reach isn't running\./, "the real CLI must confirm its owned acceptance Reach stopped");
        }
        report.cases.push({ id: "local-cli-cleanup", status: stopped.ok ? "PASS" : "FAIL", evidence: { interactiveCLI: true, confirmationPromptAnswered: stopped.confirmed }, ...(stopped.ok ? {} : { error: stopped.output }) });
        if (!stopped.ok) throw Error(`Acceptance Reach CLI cleanup failed: ${stopped.output}`);
      }
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    } catch (error) {
      if (!report.cases.some((one) => one.id === "local-cli-cleanup" && one.status === "FAIL"))
        report.cases.push({ id: "local-cli-cleanup", status: "FAIL", error: redact(error.message) });
      throw Error(redact(error.message));
    } finally {
      finalize();
    }
  });
  await caseTest("real-visible-console-local-cli", async () => {
    const before = await cli(["status"]);
    assert.ok(before.ok, before.error);
    assert.match(before.stdout, /^Reach isn't running\./, "never start a second Reach; unreadable process inventories are not sufficient");
    const script = path.join(temp, "start-local.cmd");
    // The one-shot launcher exits before Reach inventories its real parents.
    // The long-running cmd has a visible native console; stdout stays there.
    fs.writeFileSync(script, ["@echo off", "title Reach real acceptance", "ping -n 5 127.0.0.1 >nul",
      `call "${path.join(repo, "reach.cmd")}" --local --no-stay-awake --folder "${shared}"`, ""].join("\r\n"));
    const opened = await powershell(`$p = Start-Process -FilePath $env:ComSpec -ArgumentList ${quotePS(`/d /s /c ""${script}""`)} -WorkingDirectory ${quotePS(temp)} -WindowStyle Normal -PassThru; $p.Id`);
    assert.ok(opened.ok, opened.error);
    startedLocal = true;
    const consolePid = Number(opened.stdout.trim());
    assert.ok(Number.isInteger(consolePid) && consolePid > 0);
    let last = "";
    try {
      await until(async () => {
        const read = await run("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(repo, "test", "acceptance", "read-windows-console.ps1"), "-ConsoleProcessId", String(consolePid)], { env });
        if (!read.ok) { last = read.error; return false; }
        const buffer = lastJSON(read.stdout);
        assert.equal(buffer.visible, true);
        last = buffer.text;
        origin = /http:\/\/127\.0\.0\.1:\d+/.exec(last)?.[0];
        const paired = /Pairing\s+code:\s*(\d{4})\s*(\d{4})/i.exec(last);
        if (paired) code = paired[1] + paired[2];
        return origin && code;
      }, "the real visible CLI's local URL and pairing code", 300000);
    } catch (error) { throw Error(`${error.message} Console: ${redact(last).slice(-2000)}`); }
    const status = await cli(["status"]);
    assert.ok(status.ok, status.error);
    assert.match(status.stdout, /in a terminal window/);
    assert.ok(!status.stdout.includes("inside Runner"), "the actual CLI must have a console of its own");
    return { command: ".\\reach.cmd --local --no-stay-awake --folder <disposable>", consolePid, consoleVisible: true, consoleBufferRead: true, localOrigin: origin, normalCLIStatus: redact(status.stdout.trim()) };
  });
  if (!origin || !code) {
    for (const id of ["real-chrome-local-page", "real-http-files", "real-native-terminal", "real-native-screen-frame"])
      blocked(id, "The actual local CLI did not start; see its FAIL evidence. No replacement server was created.");
    write();
    return;
  }
  await caseTest("real-chrome-local-page", async () => {
    const browser = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean)
      .flatMap((base) => [path.join(base, "Google", "Chrome", "Application", "chrome.exe"), path.join(base, "Microsoft", "Edge", "Application", "msedge.exe")])
      .find((file) => fs.existsSync(file));
    assert.ok(browser, "a real vendor Chrome or Edge executable is required");
    const page = await run(browser, ["--headless=new", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${path.join(temp, "browser-profile")}`, "--dump-dom", "--virtual-time-budget=5000", origin], { timeout: 90000 });
    assert.ok(page.ok, page.error);
    assert.match(page.stdout, /<title>Reach/);
    assert.match(page.stdout, /<button[\s>]/, "React must render the actual served app");
    return { binary: browser, mode: "real headless vendor browser", appRendered: true, transport: "loopback HTTP only; private cross-origin boundaries remain BLOCKED" };
  });
  await caseTest("real-http-files", async () => {
    const denied = await request("/api/files/text?root=0&path=acceptance.txt");
    assert.ok([401, 403].includes(denied.status));
    const paired = await request("/api/pair", { method: "POST", body: { code, name: "Disposable Windows acceptance HTTP client" } });
    assert.equal(paired.status, 200);
    assert.equal(typeof paired.body.token, "string");
    token = paired.body.token;
    code = null;
    const read = await request("/api/files/text?root=0&path=acceptance.txt");
    assert.equal(read.status, 200);
    assert.equal(read.body.text, "real Windows read\n");
    const edited = await request("/api/files/text?root=0&path=acceptance.txt", { method: "PUT", body: { text: "real Windows write\n", sha256: read.body.sha256 } });
    assert.equal(edited.status, 200);
    assert.equal(fs.readFileSync(path.join(shared, "acceptance.txt"), "utf8"), "real Windows write\n");
    return { unpairedReadDenied: true, pairedUsingActualConsoleCode: true, actualFileReadAndWrite: true };
  });
  if (!token) {
    for (const id of ["real-native-terminal", "real-native-screen-frame"]) blocked(id, "Actual HTTP pairing did not complete; see FAIL evidence.");
    write();
    return;
  }
  await caseTest("real-native-terminal", async () => {
    const created = await request("/api/terminals", { method: "POST", body: { root: 0, name: "Disposable acceptance terminal", input: 'node -e "require(\'node:fs\').writeFileSync(\'terminal-receipt.txt\',\'native-terminal-ok\')"' } });
    assert.equal(created.status, 200);
    terminalId = created.body.id;
    assert.equal(typeof terminalId, "string");
    await until(() => fs.existsSync(path.join(shared, "terminal-receipt.txt")), "the real ConPTY shell's disposable file");
    assert.equal(fs.readFileSync(path.join(shared, "terminal-receipt.txt"), "utf8"), "native-terminal-ok");
    assert.equal((await request(`/api/terminals/${encodeURIComponent(terminalId)}`, { method: "DELETE" })).status, 200);
    terminalId = null;
    return { actualConPTYCommandCreatedFile: true, closedThroughReachAPI: true };
  });
  await caseTest("real-native-screen-frame", async () => {
    const displays = await request("/api/screen/displays");
    assert.equal(displays.status, 200);
    assert.ok(displays.body.displays.length > 0);
    const ws = new WebSocket(origin.replace("http:", "ws:") + "/ws/screen");
    try {
      const frame = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error("The real native screen helper did not deliver a frame.")), 120000);
        const finish = (fn, value) => { clearTimeout(timer); fn(value); };
        ws.on("error", (error) => finish(reject, error));
        ws.on("open", () => ws.send(JSON.stringify({ type: "auth", token, protocol: 2, display: "primary", format: "jpeg", quality: "saver" })));
        ws.on("message", (data, binary) => {
          if (binary) finish(resolve, data);
          else { const message = JSON.parse(String(data)); if (message.type === "error") finish(reject, Error(message.error || message.message || "Native screen error")); }
        });
      });
      assert.deepEqual([...frame.subarray(4, 6)], [0xff, 0xd8]);
      return { actualWindowsDisplays: displays.body.displays.length, nativeJPEGFrameBytes: frame.length - 4, imageUploaded: false, screenInputValidated: false };
    } finally { ws.terminate(); }
  });
});
