import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { loadPty, releaseExitedPty } from "../server/pty-helper.mjs";
import { cleanPowerShellEnv } from "../server/powershell.mjs";
import { setupStamp } from "../scripts/setup-stamp.mjs";
import { fakeTailscale, tailnetPreload, HOST } from "./helpers/fake-tailscale.mjs";
import { windowsFixture } from "./helpers/windows-fixtures.mjs";
import { privateWindowsInstall } from "./helpers/private-windows-install.mjs";

// Parity audit #18 and #20, in a real Windows console: `.\reach.cmd` as
// PowerShell runs it (through cmd), in a pseudoconsole (ConPTY, as Windows
// Terminal hosts one), through bootstrap.ps1, the supervisor (bin/reach.mjs,
// scripts/supervise.mjs) and Reach itself; keys typed and Ctrl+C pressed as a
// person would. Stand-ins only for what isn't this PC's to change: Tailscale
// (test/helpers/fake-tailscale.mjs, its tailscale.exe and its network for
// Reach's own address), the browser and Tailscale's app (recorded by
// test/fixtures/windows/opened.cs instead of opened), and the PC's process
// list, empty: on a runner it leads up to GitHub's runner service, which
// Reach rightly takes for another app (one Reach per PC and the window
// Reach opens then are windows-lifecycle's). Its state is a folder of its
// own (REACH_HOME); the code is a private byte-copy of CI's source-shaped
// build, its setup stamp written as bootstrap writes it, so nothing is installed.
// Read-only input to npm pack --ignore-scripts; never a launcher or cwd.
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const onWindows = { skip: (process.platform !== "win32" || process.env.REACH_TEST_WINDOWS_DESKTOP !== "1") && "the serial Windows desktop lane", timeout: 300000 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// What the console shows, as text: its escape sequences out, spaces as one.
const plain = (raw) =>
  raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ");
// Words looked for whatever spacing the console drew them with (it may move
// its cursor over a blank instead of writing it).
const squeezed = (text) => text.replace(/\s+/g, "");
const DOWN = "\x1b[B", UP = "\x1b[A", ENTER = "\r", CTRL_C = "\x03";

// This PC's environment for Reach, as a terminal would hand it: none of the
// test runner's own (npm's, node:test's, any REACH_ setting) and one PATH.
function consoleEnv(extra) {
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (!/^(REACH_|npm_|NODE_TEST_CONTEXT$|NODE_OPTIONS$|PATH$)/i.test(key)) env[key] = value;
  const PATH = Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] || "";
  return { ...env, Path: PATH, PORT: "0", ...extra };
}

// `launcher`: what's typed, run through cmd as PowerShell runs a .cmd
// (this checkout's reach.cmd, or npm's shim of an installed Reach).
function windowsConsole(t, env, { launcher = "reach.cmd", args = [], cwd } = {}) {
  assert.ok(cwd && path.isAbsolute(cwd), "the console must name its owned fixture working directory");
  // The console host Windows Terminal ships (node-pty's own ConPTY), as
  // Reach's terminals use it: it lets go of everything once its programs end.
  const term = loadPty().spawn(process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe", ["/d", "/c", launcher, ...args], {
    name: "xterm-256color",
    cols: 220,
    rows: 60,
    cwd,
    env,
    useConptyDll: true,
  });
  let raw = "";
  let code = null;
  term.onData((data) => (raw += data));
  const exited = new Promise((resolve) =>
    term.onExit(({ exitCode }) => {
      releaseExitedPty(term);
      resolve((code = exitCode));
    }),
  );
  // cmd asks after Ctrl+C whether to end its batch file: yes, as a person would.
  let answered = 0;
  const asking = setInterval(() => {
    const asks = plain(raw).split("Terminate batch job (Y/N)?").length - 1;
    if (asks > answered) {
      answered = asks;
      term.write(`Y${ENTER}`);
    }
  }, 200);
  t.after(async () => {
    clearInterval(asking);
    if (code === null)
      try {
        term.kill();
      } catch {}
    await Promise.race([exited, sleep(10000)]);
    // Whatever it ended on, its console's pipes go (they'd keep this test running).
    releaseExitedPty(term);
  });
  const waitFor = async (pattern, what, { from = 0, ms = 120000 } = {}) => {
    for (const end = Date.now() + ms; ; await sleep(100)) {
      const seen = plain(raw.slice(from));
      if (typeof pattern === "string" ? squeezed(seen).includes(squeezed(pattern)) : pattern.test(seen)) return seen;
      if (code !== null || Date.now() > end)
        throw Error(`${code !== null ? `the console ended (${code})` : "timed out"} waiting for ${what}. It shows:\n${plain(raw).slice(-6000)}`);
    }
  };
  const ended = async (ms = 60000) => {
    const result = await Promise.race([exited, sleep(ms).then(() => "still running")]);
    if (result === "still running") throw Error(`the console didn't end. It shows:\n${plain(raw).slice(-6000)}`);
    clearInterval(asking);
    return result;
  };
  return { write: (keys) => term.write(keys), waitFor, ended, at: () => raw.length, raw: () => raw, text: () => plain(raw) };
}

// A PC Reach has never run on, without Tailscale yet: the stand-in Tailscale
// (installed when `install()` says), Program Files where its app appears, the
// browser recording what it's asked to open, and a state folder of its own.
// `tailscale`: "missing" (installed later, by `install()`), or "on": installed,
// running, signed in, HTTPS on, as Tailscale names real nodes.
async function freshPC(t, { tailscale: start = "missing" } = {}) {
  const { root: repo, work } = await privateWindowsInstall();
  const stamp = setupStamp(repo);
  assert.ok(stamp.agent && fs.existsSync(path.join(repo, "dist", "index.html")), "a built checkout (npm run build:release)");
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(work, "reach-console-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }));
  const state = path.join(base, "state");
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, "setup.json"), JSON.stringify(stamp));
  const tailscale = path.join(base, "tailscale");
  fs.mkdirSync(tailscale);
  const fake = await fakeTailscale(tailscale, { version: "1.104.0" });
  const programFiles = path.join(base, "Program Files");
  fs.mkdirSync(path.join(programFiles, "Tailscale"), { recursive: true });
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  const recorder = await windowsFixture("opened");
  fs.copyFileSync(recorder, path.join(bin, "explorer.exe"));
  if (start === "missing") fs.renameSync(fake.cli, `${fake.cli}.later`);
  else {
    fs.copyFileSync(recorder, path.join(programFiles, "Tailscale", "tailscale-ipn.exe"));
    await fake.setStatus({ Self: { ID: "nX6k7CNTRL", UserID: 42, DNSName: `${HOST}.`, HostName: "mac", KeyExpiry: "0001-01-01T00:00:00Z", TailscaleIPs: ["100.64.0.10"] } });
  }
  const preload = path.join(base, "tailnet.mjs");
  const source = tailnetPreload(fake.state);
  fs.writeFileSync(preload, decodeURIComponent(source.slice(source.indexOf(",") + 1)));
  const processes = path.join(base, "processes.json");
  fs.writeFileSync(processes, JSON.stringify({ processes: [] }));
  // Windows gives every 64-bit program ProgramW6432 as its ProgramFiles.
  const env = consoleEnv({
    REACH_HOME: state,
    REACH_TAILSCALE: fake.cli,
    ProgramFiles: programFiles,
    ProgramW6432: programFiles,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    REACH_TEST_WINDOWS_PROCESSES: processes,
  });
  env.Path = `${bin};${env.Path}`;
  const opened = () =>
    [bin, path.join(programFiles, "Tailscale")].flatMap((dir) => {
      try {
        return fs.readFileSync(path.join(dir, "opened.log"), "utf8").split(/\r?\n/).filter(Boolean);
      } catch {
        return [];
      }
    });
  const until = async (check, what, ms = 60000) => {
    for (const end = Date.now() + ms; !check(); await sleep(100)) if (Date.now() > end) throw Error(`timed out waiting for ${what}: ${JSON.stringify(opened())}`);
  };
  // Installed, its service not started yet.
  const install = async () => {
    await fake.setStatus({ closed: true });
    fs.copyFileSync(recorder, path.join(programFiles, "Tailscale", "tailscale-ipn.exe"));
    fs.renameSync(`${fake.cli}.later`, fake.cli);
  };
  return { repo, base, state, fake, env, opened, until, install, lock: path.join(state, "launcher.lock") };
}

test("Windows console, first run: every Tailscale state, its menus by arrow keys, the right pages, then the QR and pairing code; Ctrl+C stops it for good", onWindows, async (t) => {
  const pc = await freshPC(t);
  // HTTPS certificates off, until the page that turns them on has opened;
  // this computer as Tailscale names its nodes (the stand-in's own "nMac" is
  // too short to be one, and gets the DNS page instead).
  const node = "nX6k7CNTRL";
  await pc.fake.setStatus({
    CertDomains: [],
    Self: { ID: node, UserID: 42, DNSName: `${HOST}.`, HostName: "mac", KeyExpiry: "0001-01-01T00:00:00Z", TailscaleIPs: ["100.64.0.10"] },
  });
  const reach = windowsConsole(t, pc.env, { cwd: pc.repo });
  await reach.waitFor("Welcome to Reach. 3 steps", "the first run's welcome");
  // 1. Not installed: its menu, the recommended choice first.
  await reach.waitFor("Tailscale isn't on this computer yet.", "Tailscale missing");
  await reach.waitFor("Install Tailscale to continue", "the install menu");
  await reach.waitFor("Open the Tailscale download page (Recommended)", "its first choice");
  reach.write(ENTER);
  await pc.until(() => pc.opened().includes("explorer.exe\thttps://tailscale.com/download/windows"), "the download page");
  await reach.waitFor("Reach: get it at https://tailscale.com/download/windows", "the page, said too");
  await reach.waitFor("waiting for Tailscale to be installed", "the wait");
  assert.ok(fs.existsSync(pc.lock), "the launcher holds its lock meanwhile");
  // 2. Installed, its service not running: its app opened, the service named.
  await pc.install();
  await reach.waitFor("Tailscale is installed but not running.", "Tailscale closed");
  await reach.waitFor("Reach: opening Tailscale…", "its app, found in Program Files");
  await reach.waitFor("If it still isn't running, start its service from a terminal opened as administrator: net start Tailscale", "how to start its service");
  await pc.until(() => pc.opened().includes("tailscale-ipn.exe\t"), "Tailscale's app");
  // 3. Signed out: the sign-in page, and its link said in case.
  await pc.fake.setStatus({ closed: false, BackendState: "NeedsLogin" });
  await reach.waitFor("Tailscale needs you to sign in on this computer.", "signed out");
  await pc.until(() => pc.opened().includes("explorer.exe\thttps://login.tailscale.com/a/fixture-login"), "the sign-in page");
  await reach.waitFor("If it doesn't open, visit: https://login.tailscale.com/a/fixture-login", "the sign-in link");
  // 4. Switched off: an arrow-key menu, moved down and back up.
  const menu = reach.at();
  await pc.fake.setStatus({ BackendState: "Stopped" });
  await reach.waitFor("Tailscale is switched off on this computer.", "switched off", { from: menu });
  await reach.waitFor("Turn Tailscale on?", "the switch-on menu", { from: menu });
  await reach.waitFor("↑/↓ to move · Enter to select · Esc to cancel", "an arrow-key menu, not a numbered one", { from: menu });
  const down = reach.at();
  reach.write(DOWN);
  await reach.waitFor("Not now - Exit Reach.", "the second choice, chosen by ↓", { from: down });
  const up = reach.at();
  reach.write(UP);
  await reach.waitFor("Turn it on", "the first choice again", { from: up });
  await sleep(300);
  reach.write(ENTER);
  await reach.waitFor("Reach: Tailscale is connected.", "Tailscale on");
  assert.ok((await pc.fake.read()).calls.some(([command]) => command === "up"), "turned on by tailscale up");
  // Its account, by Enter on the recommended choice.
  await reach.waitFor("Tailscale account: owner@example.test", "the account");
  await reach.waitFor("Which Tailscale account should Reach use?", "the account menu");
  reach.write(ENTER);
  // 5. HTTPS off: Tailscale's own page for this computer, then on.
  await pc.until(() => pc.opened().includes(`explorer.exe\thttps://login.tailscale.com/f/serve?node=${node}`), "the HTTPS page");
  await reach.waitFor(`Turn on HTTPS for your tailnet: press Enable on this page (opening it): https://login.tailscale.com/f/serve?node=${node}`, "the HTTPS step");
  await reach.waitFor("Waiting… (Ctrl+C to stop; .\\reach.cmd picks up here)", "the HTTPS wait, naming .\\reach.cmd");
  await pc.fake.setStatus({ CertDomains: [HOST] });
  await reach.waitFor(`✔ 2. Your private link — ${HOST}`, "the link step done");
  // 6. On: the phone. This PC can't hold the keyed route here (no
  // Tailscale service to check its connections). No browser QR is offered;
  // a phone already on the tailnet can explicitly request the private one.
  await reach.waitFor("▸ 3. Your phone", "the phone step");
  await reach.waitFor("Press Enter for a new pairing code. Type pause to pause. Ctrl+C stops sharing and Reach.", "the private fallback's input prompt", { ms: 180000 });
  assert.match(reach.text(), /Type private for its private QR/);
  assert.doesNotMatch(reach.text(), /Pairing code:/, "a private pairing QR is not an automatic browser handoff");
  reach.write(`private${ENTER}`);
  const phone = await reach.waitFor(/Pairing code: ?\d{4} ?\d{4}/, "the requested private pairing code", { ms: 30000 });
  assert.match(squeezed(phone), /Reach:browsersign-inisoffonthisPCfornow:.+Phonesjoinwithapairingcodeandneedthe(Tailscale)?app\./);
  assert.ok(squeezed(phone).includes(squeezed(`Open on your phone: https://${HOST}:8443 Pairing code:`)), phone.slice(-3000));
  await reach.waitFor("Scan with your phone camera, then tap Connect.", "the QR's line");
  const blocks = [...reach.raw()].filter((char) => "▀▄█".includes(char)).length;
  assert.ok(blocks > 100, `a QR code (${blocks} blocks)`);
  // Reach titles its own window, so it can be told from other consoles.
  assert.match(reach.raw(), /\x1b\]0;Reach(?:\x07|\x1b\\)/);
  assert.deepEqual(pc.opened().filter((line) => line.startsWith("explorer.exe")).map((line) => line.split("\t")[1]), [
    "https://tailscale.com/download/windows",
    "https://login.tailscale.com/a/fixture-login",
    `https://login.tailscale.com/f/serve?node=${node}`,
  ], "each page once, nothing else");
  const route = (await pc.fake.sessions()).find((s) => s.config.TCP?.[8443]);
  assert.ok(route, "its private route, held");
  assert.ok(fs.existsSync(path.join(pc.state, "host-status.json")));
  // Ctrl+C: Reach stops as asked, the supervisor doesn't start it again.
  const before = reach.at();
  reach.write(CTRL_C);
  const code = await reach.ended(90000);
  const after = plain(reach.raw().slice(before));
  assert.doesNotMatch(reach.text(), /starting again in/, "never started again");
  assert.equal(fs.existsSync(pc.lock), false, "its lock goes");
  assert.equal(fs.existsSync(path.join(pc.state, "host-status.json")), false, "its status goes");
  for (const until = Date.now() + 5000; (await pc.fake.sessions()).length && Date.now() < until; ) await sleep(100);
  assert.deepEqual(await pc.fake.sessions(), [], "its route ends with it");
  t.diagnostic(`after Ctrl+C (exit ${code}): ${after.slice(-800)}`);
});

test("Windows console: Ctrl+C while setup waits, at a menu or between, pauses it: said, the lock goes, nothing starts again", onWindows, async (t) => {
  const pc = await freshPC(t);
  // At the menu: the key itself (the menu reads keys one by one).
  const first = windowsConsole(t, pc.env, { cwd: pc.repo });
  await first.waitFor("Install Tailscale to continue", "the install menu");
  first.write(CTRL_C);
  await first.waitFor("Paused. Run .\\reach.cmd to continue your setup.", "the pause, at a menu");
  assert.equal(await first.ended(), 130);
  assert.equal(fs.existsSync(pc.lock), false, "its lock goes");
  assert.doesNotMatch(first.text(), /starting again in/);
  // While it waits: Windows' own Ctrl+C, to every program in the console.
  const second = windowsConsole(t, pc.env, { cwd: pc.repo });
  await second.waitFor("Install Tailscale to continue", "the install menu again");
  second.write(ENTER);
  await second.waitFor("waiting for Tailscale to be installed", "the wait");
  assert.ok(fs.existsSync(pc.lock));
  second.write(CTRL_C);
  await second.waitFor("Paused. Run .\\reach.cmd to continue your setup.", "the pause, while waiting");
  const code = await second.ended();
  t.diagnostic(`exit after Ctrl+C while waiting: ${code}`);
  assert.equal(fs.existsSync(pc.lock), false, "its lock goes");
  assert.doesNotMatch(second.text(), /starting again in/);
});

// The npm `reach` entry (audit #18): Reach as `npm install --global` leaves
// it, from this checkout's own package (npm pack, its dependencies from npm),
// npm's own reach.cmd shim run in a real console against Tailscale already
// on: its first run to the pairing code and QR, its hints naming `reach`,
// Ctrl+C stopping it for good. Then npm's reach-agent, and what typing
// `reach` does in Windows PowerShell under this PC's script policy (npm
// leaves a reach.ps1 beside reach.cmd).
test("Windows console, npm install: npm's reach.cmd runs the first run to the pairing code and QR, Ctrl+C stops it for good; reach-agent too", { ...onWindows, timeout: 600000 }, async (t) => {
  const pc = await freshPC(t, { tailscale: "on" });
  assert.ok(process.env.npm_execpath, "run through npm");
  const npmEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(REACH_|npm_config_|NODE_TEST_CONTEXT$|NODE_OPTIONS$)/i.test(key)));
  const npm = (args) =>
    new Promise((resolve, reject) =>
      execFile(process.execPath, [process.env.npm_execpath, ...args], { cwd: pc.base, env: { ...npmEnv, npm_config_update_notifier: "false" }, timeout: 300000, maxBuffer: 64 << 20, windowsHide: true }, (error, stdout, stderr) =>
        error ? reject(Object.assign(error, { message: `npm ${args[0]}: ${stderr || error.message}` })) : resolve({ stdout, stderr })));
  const [{ filename }] = JSON.parse((await npm(["pack", "--ignore-scripts", "--json", "--pack-destination", pc.base, checkout])).stdout);
  const prefix = path.join(pc.base, "npm");
  await npm(["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error", path.join(pc.base, filename)]);
  const installed = path.join(prefix, "node_modules", "@nalebc", "reach");
  assert.ok(fs.existsSync(path.join(installed, "bin", "reach.mjs")));
  assert.equal(fs.existsSync(path.join(installed, "src", "main.tsx")), false, "an installed package, not a checkout");
  for (const shim of ["reach.cmd", "reach.ps1", "reach-agent.cmd"]) assert.ok(fs.existsSync(path.join(prefix, shim)), shim);
  const env = { ...pc.env, Path: `${prefix};${pc.env.Path}` };
  const reach = windowsConsole(t, env, { launcher: path.join(prefix, "reach.cmd"), cwd: pc.base });
  await reach.waitFor('Reach: first run here. Moving from a Reach folder you ran before? Stop now (Ctrl+C) and run "reach import <that folder>"', "an installed Reach's first run");
  await reach.waitFor("Welcome to Reach. 3 steps, about 3 minutes. Ctrl+C stops; reach picks up here.", "the welcome, naming reach");
  await reach.waitFor("Which Tailscale account should Reach use?", "the account menu");
  reach.write(ENTER);
  await reach.waitFor(`✔ 2. Your private link — ${HOST}`, "the link step done");
  await reach.waitFor("Press Enter for a new pairing code. Type pause to pause. Ctrl+C stops sharing and Reach.", "the installed CLI's private fallback input prompt", { ms: 180000 });
  assert.match(reach.text(), /Type private for its private QR/);
  assert.doesNotMatch(reach.text(), /Pairing code:/, "an installed CLI also gates its browser QR");
  reach.write(`private${ENTER}`);
  const phone = await reach.waitFor(/Pairing code: ?\d{4} ?\d{4}/, "the requested private pairing code", { ms: 30000 });
  assert.ok(squeezed(phone).includes(squeezed(`Open on your phone: https://${HOST}:8443 Pairing code:`)), phone.slice(-3000));
  await reach.waitFor("Scan with your phone camera, then tap Connect.", "the QR's line");
  assert.ok([...reach.raw()].filter((char) => "▀▄█".includes(char)).length > 100, "a QR code");
  assert.doesNotMatch(reach.text(), /\.\\reach\.cmd|\.\/reach\b/, "an installed Reach names reach, never the checkout's launchers");
  reach.write(CTRL_C);
  await reach.ended(90000);
  assert.doesNotMatch(reach.text(), /starting again in/, "never started again");
  assert.equal(fs.existsSync(pc.lock), false, "its lock goes");
  for (const until = Date.now() + 5000; (await pc.fake.sessions()).length && Date.now() < until; ) await sleep(100);
  assert.deepEqual(await pc.fake.sessions(), [], "its route ends with it");
  // npm's reach-agent, as cmd (and so PowerShell) runs it.
  const project = path.join(pc.base, "a project");
  fs.mkdirSync(project);
  const policy = path.join(pc.base, "agent policy.json");
  const agent = await new Promise((resolve) =>
    execFile(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `""${path.join(prefix, "reach-agent.cmd")}" policy init --folder "${project}" --out "${policy}""`], { windowsVerbatimArguments: true, timeout: 60000, windowsHide: true }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr })));
  assert.equal(agent.code, 0, agent.stderr);
  assert.equal(JSON.parse(agent.stdout).policy, policy);
  // Typed in Windows PowerShell, under this PC's own script policy.
  const psEnv = { ...npmEnv, Path: `${prefix};${env.Path}` };
  cleanPowerShellEnv(psEnv, "win32");
  const typed = (command) =>
    new Promise((resolve) =>
      execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { env: psEnv, timeout: 60000, windowsHide: true }, (error, stdout, stderr) =>
        resolve({ code: error ? error.code : 0, stdout: String(stdout).trim(), stderr: String(stderr).trim() })));
  const version = JSON.parse(fs.readFileSync(path.join(checkout, "package.json"), "utf8")).version;
  const cmd = await typed("reach.cmd --version");
  assert.equal(cmd.stdout, version, cmd.stderr);
  const plainReach = await typed("reach --version");
  t.diagnostic(`plain \`reach\` in Windows PowerShell here: exit ${plainReach.code}: ${plainReach.stdout || plainReach.stderr.split(/\r?\n/)[0]}`);
  assert.ok(plainReach.stdout === version || /running scripts is disabled|cannot be loaded/i.test(plainReach.stderr), JSON.stringify(plainReach));
});

test("Windows console: Reach stopping by itself (exit 70) starts again in the same window after 1, 5, 15, 30, 30 s, and not after five in ten minutes", onWindows, async (t) => {
  const { root: repo, work } = await privateWindowsInstall();
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(work, "reach-relaunch-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 30, retryDelay: 200 }));
  const starts = path.join(base, "starts.log");
  // Reach itself (scripts\bootstrap.mjs, which the supervisor starts) stops
  // at once with crash-guard's code; nothing else in the chain is touched.
  const crash = path.join(base, "crash.mjs");
  fs.writeFileSync(crash, [
    'import fs from "node:fs";',
    `if (/[\\\\/]scripts[\\\\/]bootstrap\\.mjs$/i.test(process.argv[1] || "")) {`,
    `  fs.appendFileSync(${JSON.stringify(starts)}, Date.now() + "\\n");`,
    "  process.exit(70);",
    "}",
  ].join("\n"));
  const reach = windowsConsole(t, consoleEnv({ REACH_HOME: path.join(base, "state"), NODE_OPTIONS: `--import=${pathToFileURL(crash).href}` }), { cwd: repo });
  const code = await reach.ended(200000);
  const at = fs.readFileSync(starts, "utf8").trim().split(/\r?\n/).map(Number);
  assert.equal(at.length, 6, reach.text());
  const gaps = at.slice(1).map((time, i) => time - at[i]);
  for (const [i, delay] of [1000, 5000, 15000, 30000, 30000].entries())
    assert.ok(gaps[i] >= delay && gaps[i] < delay + 8000, `start ${i + 2} came ${gaps[i]} ms after the one before, not ${delay}`);
  const text = reach.text();
  for (const [seconds, times] of [[1, 1], [5, 1], [15, 1], [30, 2]])
    assert.equal(text.split(`Reach: starting again in ${seconds}s…`).length - 1, times, `${seconds}s: ${text}`);
  assert.match(text, /Reach stopped unexpectedly 5 times in 10 minutes, so it isn't starting again by itself\./);
  assert.equal(code, 70, "the window says how it ended");
});
