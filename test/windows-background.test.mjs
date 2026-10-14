import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { backgroundService, privateNodePath } from "../scripts/background-service.mjs";
import { decodeOutput, holdFile, legacyStartup, taskMarker, taskName, taskXml, windowsArg, windowsTask } from "../scripts/windows-task.mjs";
import { windowsArgv } from "../scripts/instances.mjs";
import { windowsBinary } from "../server/desktop-native.mjs";

// Background mode and start at sign-in on Windows (audit #4): a Scheduled
// Task of yours, started when you sign in, in your session (InteractiveToken:
// the live screen, control and Tailscale's check of Reach's route need your
// session; a batch or S4U logon has none of them), running Reach's starter
// (scripts/native/background.cs), which runs the real launcher with --service
// and no window. Here schtasks and the starter are stand-ins; on a real
// Windows runner the last test installs a task, runs it once against a
// stand-in Reach, and removes it.
const windows = process.platform === "win32";
const exec = promisify(execFile);
const SID = "S-1-5-21-1111-2222-3333-1001";
const ROOT = "C:\\Users\\Me & You\\reach";
const STARTER = "C:\\Users\\Me & You\\reach\\.reach\\service\\reach-background-0123456789ab.exe";

test("the task: at your sign-in, in your session, least privilege, no time limit, on battery too", () => {
  const args = ["--log", "C:\\Users\\Me & You\\reach\\.reach\\logs", "--", "C:\\node\\node.exe", `${ROOT}\\scripts\\bootstrap.mjs`, "--service"];
  const xml = taskXml({ sid: SID, starter: STARTER, args, root: ROOT, profile: "C:\\Users\\Me & You" });
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-16"\?>\n<Task version="1\.2" xmlns="http:\/\/schemas\.microsoft\.com\/windows\/2004\/02\/mit\/task">/);
  assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>S-1-5-21-1111-2222-3333-1001<\/UserId>\s*<\/LogonTrigger>/);
  // Your signed-in session, never a batch, S4U or saved-password logon:
  // Tailscale's service answers Reach's route check only for interactive
  // and service logons (scripts/native/tailscaled-peer.cs).
  assert.match(xml, /<Principal id="Author">\s*<UserId>S-1-5-21-1111-2222-3333-1001<\/UserId>\s*<LogonType>InteractiveToken<\/LogonType>\s*<RunLevel>LeastPrivilege<\/RunLevel>\s*<\/Principal>/);
  assert.doesNotMatch(xml, /S4U|Password|ServiceAccount|HighestAvailable|<GroupId>/);
  for (const [setting, value] of [["MultipleInstancesPolicy", "IgnoreNew"], ["DisallowStartIfOnBatteries", "false"], ["StopIfGoingOnBatteries", "false"], ["ExecutionTimeLimit", "PT0S"], ["Enabled", "true"], ["AllowStartOnDemand", "true"]])
    assert.match(xml, new RegExp(`<${setting}>${value}</${setting}>`), setting);
  assert.match(xml, /<RestartOnFailure>\s*<Interval>PT1M<\/Interval>\s*<Count>3<\/Count>\s*<\/RestartOnFailure>/);
  assert.match(xml, /<Command>C:\\Users\\Me &amp; You\\reach\\\.reach\\service\\reach-background-0123456789ab\.exe<\/Command>/);
  assert.match(xml, /<Arguments>--log "C:\\Users\\Me &amp; You\\reach\\\.reach\\logs" -- C:\\node\\node\.exe "C:\\Users\\Me &amp; You\\reach\\scripts\\bootstrap\.mjs" --service<\/Arguments>/);
  assert.match(xml, /<WorkingDirectory>C:\\Users\\Me &amp; You<\/WorkingDirectory>/);
  // Which folder installed it: a name it carries, in ASCII.
  assert.match(xml, new RegExp(`<Source>${taskMarker(ROOT)}</Source>`));
  assert.match(taskMarker(ROOT), /^Reach [0-9a-f]{16}$/);
  assert.equal(taskMarker("c:\\users\\me & you\\REACH"), taskMarker(ROOT), "Windows names a folder in any case");
  assert.equal(taskName(SID), `Reach-${SID}`);
  // Task Scheduler reads %…% as a variable: such a path is refused, never changed.
  assert.throws(() => taskXml({ sid: SID, starter: STARTER, args: ["--log", "C:\\100%\\logs"], root: ROOT }), /its path has a % sign/);
  assert.throws(() => taskXml({ sid: "S-1-5-18", starter: STARTER, args: [], root: ROOT }), /which Windows account/);
});

test("its arguments come back exactly as Windows programs read them", () => {
  const args = ["plain", "with space", 'quote"inside', "C:\\trailing\\", "C:\\trailing space\\", "", "back\\\\slashes", 'C:\\a\\"b'];
  assert.deepEqual(windowsArgv(`starter.exe ${args.map(windowsArg).join(" ")}`).slice(1), args);
});

// A schtasks and whoami stand-in, recording what they're asked.
const schtasks = ({ installed = null, fail = "" } = {}) => {
  const calls = [];
  let xml = installed;
  const run = (file, args) => {
    calls.push([path.win32.basename(file), ...args]);
    if (file.endsWith("whoami.exe")) return Buffer.from(`"pc\\me","${SID}"\r\n`);
    const verb = args[0];
    if (verb === fail) throw Object.assign(Error("Command failed"), { stderr: Buffer.from("ERROR: Access is denied.\r\n") });
    if (verb === "/Query") {
      if (!xml) throw Error("ERROR: The system cannot find the file specified.");
      return Buffer.from(`\ufeff${xml}`, "utf16le");
    }
    if (verb === "/Create") xml = decodeOutput(fs.readFileSync(args[args.indexOf("/XML") + 1]));
    if (verb === "/Delete") xml = null;
    return Buffer.from("SUCCESS\r\n");
  };
  return { run, calls, get xml() { return xml; } };
};
const pc = (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-win-bg-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "reach");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "main.tsx"), "");
  const env = { SystemRoot: "C:\\Windows", LOCALAPPDATA: path.join(dir, "local"), USERPROFILE: "C:\\Users\\Me", APPDATA: path.join(dir, "roaming"), REACH_HOME: path.join(root, ".reach") };
  return { dir, root, env, state: path.join(root, ".reach") };
};
const installing = (p, task, extra = {}, said = []) => ({
  platform: "win32",
  env: p.env,
  task,
  said,
  print: (line) => said.push(line),
  privateNode: () => "C:\\Users\\Me\\reach\\.reach\\runtime\\node-v22.23.3-win-x64\\node.exe",
  allocatePort: async () => 4318,
  prepareOrigin: async () => "https://pc.tail1.ts.net:8443",
  starter: async () => STARTER,
  ...extra,
});

test("reach install on Windows: the task, written in UTF-16, run now and at every sign-in; the old startup entry goes", async (t) => {
  const p = pc(t);
  const tasks = schtasks();
  const task = windowsTask({ env: p.env, run: tasks.run });
  // An entry npm run install-service wrote long ago: a second Reach at each sign-in.
  const startup = path.join(p.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  fs.mkdirSync(startup, { recursive: true });
  fs.writeFileSync(path.join(startup, "Reach.cmd"), `@echo off\r\nstart "Reach Companion" /min "node.exe" "C:\\reach\\server\\index.mjs"\r\n`);
  assert.equal(legacyStartup(p.env), path.join(startup, "Reach.cmd"));
  const deps = installing(p, task);
  const result = await backgroundService({ command: "install", folders: ["D:\\Shared"], httpsPort: 8443 }, p.root, deps);
  assert.deepEqual(tasks.calls.map((c) => c.slice(0, 2)), [["whoami.exe", "/user"], ["schtasks.exe", "/Query"], ["schtasks.exe", "/Create"], ["schtasks.exe", "/Run"]]);
  assert.deepEqual(tasks.calls[1], ["schtasks.exe", "/Query", "/TN", `Reach-${SID}`, "/XML"]);
  const file = path.join(p.state, "service", "task.xml");
  assert.deepEqual(tasks.calls[2], ["schtasks.exe", "/Create", "/TN", `Reach-${SID}`, "/XML", file]);
  const raw = fs.readFileSync(file);
  assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe], "UTF-16 with its byte order mark");
  const xml = decodeOutput(raw);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  const args = windowsArgv(`starter ${xml.match(/<Arguments>([^<]*)<\/Arguments>/)[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"')}`).slice(1);
  assert.deepEqual(args, [
    "--log", path.join(p.state, "logs"),
    "--hold", holdFile(p.env),
    "--env", `REACH_DATA=${path.join(p.state, "quick")}`,
    "--env", `REACH_HOME=${p.env.REACH_HOME}`,
    "--",
    "C:\\Users\\Me\\reach\\.reach\\runtime\\node-v22.23.3-win-x64\\node.exe",
    path.join(p.root, "scripts", "bootstrap.mjs"),
    "--service", "--port", "4318", "--https-port", "8443", "--stay-awake-always", "--folder", "D:\\Shared",
  ]);
  const saved = JSON.parse(fs.readFileSync(path.join(p.state, "service.json"), "utf8"));
  assert.equal(saved.installed, true);
  assert.equal(saved.task, `Reach-${SID}`);
  assert.equal(saved.options.port, 4318);
  assert.equal(result.origin, "https://pc.tail1.ts.net:8443");
  const said = deps.said.join("\n");
  assert.match(said, /^Reach installed\. Starts at sign-in and restarts after exit\.\nPrivate link: https:\/\/pc\.tail1\.ts\.net:8443\n/);
  assert.match(said, /The live screen and control work while you're signed in; new phones are approved with \S+ approve\./);
  assert.match(said, /The old startup entry \(npm run install-service\) was removed\./);
  assert.equal(legacyStartup(p.env), null);
  assert.ok(!fs.existsSync(path.join(startup, "Reach.cmd")));
  // Installed once: a second install says to uninstall first, from this folder.
  await assert.rejects(backgroundService({ command: "install", folders: [], httpsPort: 8443 }, p.root, installing(p, task)), /Reach already has a background task \(Reach-S-1-5-21-1111-2222-3333-1001\)\. Run \S+ uninstall from /);
  // Another folder's: never changed from here, and said whose it is.
  const other = pc(t);
  await assert.rejects(backgroundService({ command: "install", folders: [], httpsPort: 8443 }, other.root, installing(other, windowsTask({ env: other.env, run: tasks.run }))), (error) => {
    assert.match(error.message, /This background task belongs to another Reach folder/);
    assert.ok(error.message.includes(`Manage it from its folder: ${p.root}.`), error.message);
    return true;
  });
});

test("a task Windows won't take leaves nothing behind", async (t) => {
  const p = pc(t);
  const tasks = schtasks({ fail: "/Run" });
  const task = windowsTask({ env: p.env, run: tasks.run });
  await assert.rejects(backgroundService({ command: "install", folders: [], httpsPort: 8443 }, p.root, installing(p, task)), /Windows' Task Scheduler wouldn't take Reach's background task \(ERROR: Access is denied\.\)\./);
  assert.equal(tasks.xml, null, "the task it made is removed");
  assert.equal(fs.existsSync(path.join(p.state, "service.json")), false);
});

test("reach uninstall on Windows: its Reach stops first, then the task goes; status says how it runs", async (t) => {
  const p = pc(t);
  const tasks = schtasks();
  const task = windowsTask({ env: p.env, run: tasks.run });
  await backgroundService({ command: "install", folders: [], httpsPort: 8443 }, p.root, installing(p, task));
  fs.writeFileSync(path.join(p.state, "host-status.json"), JSON.stringify({ pid: 4242, service: true, link: "https://pc.tail1.ts.net", awake: { mode: "always", active: true } }));
  const shown = [];
  const status = await backgroundService({ command: "status" }, p.root, { platform: "win32", env: p.env, task, print: (l) => shown.push(l) });
  assert.equal(shown[0], `Reach: running (PID 4242)\nTailscale link: https://pc.tail1.ts.net\nLogs: ${path.join(p.state, "logs")}\nSleep prevention: always · active`);
  assert.equal(status.installed, true);
  const order = [];
  tasks.calls.length = 0;
  const said = [];
  await backgroundService({ command: "uninstall" }, p.root, { platform: "win32", env: p.env, task, stop: async () => order.push("stop"), print: (l) => said.push(l) });
  assert.deepEqual(order, ["stop"]);
  assert.deepEqual(tasks.calls.map((c) => c[1]).filter((v) => v !== "/user"), ["/Query", "/End", "/Delete"]);
  assert.equal(tasks.xml, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.state, "service.json"), "utf8")).installed, false);
  assert.match(said.join("\n"), /^Reach stopped and uninstalled\.\nSaved pairings and logs remain in /);
});

test("the background Reach runs on Reach's own Node on Windows too, never the PC's", (t) => {
  const p = pc(t);
  assert.throws(() => privateNodePath(p.root, "x64", "win32"), /private Node runtime is missing/);
  const node = path.join(p.state, "runtime", "node-v22.23.3-win-x64", "node.exe");
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.writeFileSync(node, "", { mode: 0o755 });
  const previous = process.env.REACH_HOME;
  process.env.REACH_HOME = p.state;
  try {
    assert.equal(privateNodePath(p.root, "x64", "win32"), node);
  } finally {
    if (previous === undefined) delete process.env.REACH_HOME;
    else process.env.REACH_HOME = previous;
  }
  assert.throws(() => privateNodePath(p.root, "ia32", "win32"), /Unsupported Windows architecture/);
});

test("whoami's SID names the task; schtasks' answer read in whichever encoding it chose", () => {
  const tasks = schtasks();
  const task = windowsTask({ env: { SystemRoot: "C:\\Windows" }, run: tasks.run });
  assert.equal(task.name(), `Reach-${SID}`);
  assert.equal(tasks.calls[0][0], "whoami.exe");
  assert.deepEqual(task.state("C:\\x"), { installed: false, ours: false, name: `Reach-${SID}` });
  assert.throws(() => windowsTask({ env: {}, run: tasks.run }).state("C:\\x"), /Windows folder/);
  assert.equal(decodeOutput(Buffer.from("\ufeffhello", "utf16le")), "hello");
  assert.equal(decodeOutput(Buffer.from("hello", "utf16le")), "hello");
  assert.equal(decodeOutput(Buffer.from("hello")), "hello");
  assert.throws(() => windowsTask({ env: {}, run: tasks.run }).sid(), /Windows folder/);
});

test("npm run install-service on Windows points to reach install, and removes only its own old entry", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-legacy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const startup = path.join(dir, "Microsoft", "Windows", "Start Menu", "Programs", "Startup");
  fs.mkdirSync(startup, { recursive: true });
  const entry = path.join(startup, "Reach.cmd");
  const asWindows = pathToFileURL(path.resolve("test/helpers/as-windows.mjs")).href;
  const run = (verb) => exec(process.execPath, ["--import", asWindows, "scripts/service.mjs", verb], { env: { ...process.env, APPDATA: dir, REACH_DATA: path.join(dir, "data") } }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }),
  );
  // Someone else's file of that name stays.
  fs.writeFileSync(entry, "@echo off\r\necho mine\r\n");
  const theirs = await run("install");
  assert.equal(theirs.code, 1);
  assert.match(theirs.stderr, /^On Windows, background mode is \S+ install \(or \S+ setup background\)\.\n$/);
  assert.ok(fs.existsSync(entry));
  fs.writeFileSync(entry, `@echo off\r\nstart "Reach Companion" /min "node.exe" "C:\\reach\\server/index.mjs"\r\n`);
  const removed = await run("install");
  assert.match(removed.stderr, /The old startup entry was removed\./);
  assert.ok(!fs.existsSync(entry));
  assert.match((await run("uninstall")).stdout, /There's no old startup entry to remove\./);
});

test("the starter is a Windows program with no console window; every other helper keeps its build", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-winexe-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const calls = [];
  const run = async (command, args) => {
    calls.push(args);
    fs.writeFileSync(args.find((arg) => arg.startsWith("/out:")).slice(5), "MZ");
    return { stdout: "", stderr: "" };
  };
  const options = { platform: "win32", env: { SystemRoot: "C:\\Windows" }, run, exists: () => true };
  const starter = await windowsBinary({ dataDir }, "background", { ...options, target: "winexe" });
  assert.ok(calls[0].includes("/target:winexe") && !calls[0].includes("/target:exe"));
  const plain = await windowsBinary({ dataDir }, "processes", options);
  assert.ok(calls[1].includes("/target:exe"));
  // A console helper's name is what it was before winexe existed: no rebuilds.
  const source = fs.readFileSync("scripts/native/processes.cs");
  const flags = ["/nologo", "/noconfig", "/target:exe", "/platform:anycpu", "/optimize+", "/debug-", "/codepage:65001", "/utf8output"];
  const refs = ["System.dll", "System.Core.dll", "System.Drawing.dll", "System.Windows.Forms.dll", "WPF\\UIAutomationClient.dll", "WPF\\UIAutomationTypes.dll", "WPF\\WindowsBase.dll"];
  assert.equal(path.basename(plain), `reach-processes-${crypto.createHash("sha256").update(source).update(JSON.stringify([flags, refs])).digest("hex").slice(0, 12)}.exe`);
  assert.match(path.basename(starter), /^reach-background-[0-9a-f]{12}\.exe$/);
  await assert.rejects(windowsBinary({ dataDir }, "background", { ...options, target: "dll" }), (error) => error.status === 400);
});

test("on real Windows, install makes the task, it runs once in your session against a stand-in Reach, and uninstall removes it", { skip: !windows, timeout: 300000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach background-"));
  const name = `Reach-test-${crypto.randomBytes(4).toString("hex")}`;
  const task = windowsTask({ name });
  t.after(async () => {
    try { task.remove(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // A stand-in Reach: the launcher's entry, saying what it ran with, then done.
  const root = path.join(dir, "reach");
  const marker = path.join(dir, "ran.json");
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "bootstrap.mjs"), `import fs from "node:fs";
console.log("STAND-IN SAID THIS");
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), data: process.env.REACH_DATA, cwd: process.cwd(), stdinTTY: !!process.stdin.isTTY, stdoutTTY: !!process.stdout.isTTY }));
`);
  const env = { ...process.env, REACH_HOME: path.join(dir, "state") };
  const said = [];
  await backgroundService({ command: "install", local: true, folders: [], httpsPort: 8443 }, root, {
    platform: "win32",
    env,
    task,
    privateNode: () => process.execPath,
    allocatePort: async () => 4319,
    print: (line) => said.push(line),
  });
  // Task Scheduler took it as written: your session, least privilege.
  const { stdout } = await exec(path.join(process.env.SystemRoot, "System32", "schtasks.exe"), ["/Query", "/TN", name, "/XML"], { encoding: "buffer", windowsHide: true });
  const xml = decodeOutput(stdout);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.ok(xml.includes(taskMarker(root)), "it names this folder");
  // Run now by install: the starter ran the stand-in, with no window and its output in the logs.
  for (const until = Date.now() + 60000; !fs.existsSync(marker); ) {
    if (Date.now() > until) assert.fail(`The task never ran it.\n${said.join("\n")}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 500));
  const ran = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.deepEqual(ran.args.slice(0, 3), ["--service", "--local", "--port"]);
  assert.equal(ran.data, path.resolve(path.join(env.REACH_HOME, "quick")));
  assert.equal(ran.cwd.toLowerCase(), os.homedir().toLowerCase(), "never Reach's own folder");
  assert.deepEqual([ran.stdinTTY, ran.stdoutTTY], [false, false], "nothing to read; its output goes to the logs");
  for (const until = Date.now() + 10000; !/STAND-IN SAID THIS/.test(fs.readFileSync(path.join(env.REACH_HOME, "logs", "companion.log"), "utf8")); ) {
    if (Date.now() > until) assert.fail("Its output never reached companion.log.");
    await new Promise((r) => setTimeout(r, 250));
  }
  await backgroundService({ command: "uninstall" }, root, { platform: "win32", env, task, stop: async () => {}, print: () => {} });
  await assert.rejects(exec(path.join(process.env.SystemRoot, "System32", "schtasks.exe"), ["/Query", "/TN", name], { windowsHide: true }), "the task is gone");
});

// The round trip a phone's Restart makes on a PC in background mode: the
// task's Reach opens a window (as the Restart card does), then a restart
// goes through the task (held, its Reach asked to stop, started again). The
// window must outlive it: Task Scheduler may end what a task started.
test("on real Windows, a restart through the task brings its Reach back, and a window that Reach opened lives on", { skip: !windows, timeout: 300000 }, async (t) => {
  const { stopReach } = await import("../scripts/stop.mjs");
  const { windowsReaches } = await import("../scripts/instances.mjs");
  const { windowsProcesses } = await import("../server/windows-processes.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach roundtrip-"));
  const name = `Reach-test-${crypto.randomBytes(4).toString("hex")}`;
  const task = windowsTask({ name });
  const state = path.join(dir, "state");
  const env = { ...process.env, REACH_HOME: state };
  const root = path.join(dir, "reach");
  const windowRoot = path.join(dir, "window");
  const windowState = path.join(dir, "window-state");
  const repo = new URL("..", import.meta.url);
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(windowRoot, "bin"), { recursive: true });
  fs.mkdirSync(windowState, { recursive: true });
  fs.mkdirSync(state, { recursive: true });
  // A stand-in background Reach: stops when asked, as Reach does; the first
  // one opens a window of its own, as the phone's Restart card does.
  fs.writeFileSync(path.join(root, "scripts", "bootstrap.mjs"), `import fs from "node:fs";
import path from "node:path";
import { watchStopRequest } from ${JSON.stringify(new URL("scripts/instances.mjs", repo).href)};
import { startInConsole } from ${JSON.stringify(new URL("scripts/stop.mjs", repo).href)};
const state = process.env.REACH_HOME;
fs.appendFileSync(path.join(state, "starts.txt"), process.pid + "\\n");
if (!fs.existsSync(path.join(state, "window-asked"))) {
  fs.writeFileSync(path.join(state, "window-asked"), "1");
  startInConsole(${JSON.stringify(windowRoot)}, { state: ${JSON.stringify(windowState)}, env: { ...process.env, REACH_HOME: ${JSON.stringify(windowState)} } });
}
watchStopRequest(state, { every: 100, stop: () => process.exit(0) });
setInterval(() => {}, 1000);
`);
  // What that window runs: a heartbeat for half a minute.
  fs.writeFileSync(path.join(windowRoot, "bin", "reach.mjs"), `import fs from "node:fs";
let beats = 0;
setInterval(() => { fs.appendFileSync(process.env.REACH_HOME + "\\\\beats.txt", Date.now() + "\\n"); if (++beats >= 60) process.exit(0); }, 500);
`);
  const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\s+/).filter(Boolean) : []);
  const starts = () => lines(path.join(state, "starts.txt"));
  const beats = () => lines(path.join(windowState, "beats.txt")).length;
  const until = async (check, ms, what) => {
    for (const end = Date.now() + ms; !check(); await new Promise((r) => setTimeout(r, 250))) if (Date.now() > end) assert.fail(`Never: ${what}.`);
  };
  // This test's Reach only, never another on the runner.
  const reaches = async () => {
    const found = await windowsReaches({ root, state, list: () => windowsProcesses({ nativeDir: path.join(state, "native") }) });
    return { ...found, hosts: found.hosts.filter((h) => h.root && h.root.toLowerCase() === root.toLowerCase()) };
  };
  const stopping = { platform: "win32", yes: true, state: () => state, windows: { task, reaches, env } };
  t.after(async () => {
    try {
      await backgroundService({ command: "uninstall" }, root, { platform: "win32", env, task, stop: () => stopReach(root, { ...stopping, print: () => {} }), print: () => {} });
    } catch {}
    try { task.remove(); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await backgroundService({ command: "install", local: true, folders: [], httpsPort: 8443 }, root, { platform: "win32", env, task, privateNode: () => process.execPath, allocatePort: async () => 4320, print: () => {} });
  await until(() => starts().length >= 1 && beats() >= 2, 90000, "the task ran its Reach, and that Reach's window beat");
  const [first] = starts();
  const said = [];
  const result = await stopReach(root, { ...stopping, restarting: true, print: (line) => said.push(line) });
  assert.equal(result.service, true);
  await until(() => starts().length >= 2, 60000, "the task started its Reach again");
  assert.notEqual(starts()[1], first);
  assert.ok(!said.some((line) => /didn't start again/.test(line)), said.join("\n"));
  const at = beats();
  await new Promise((r) => setTimeout(r, 2000));
  assert.ok(beats() > at, "the window the first Reach opened lives on through the restart");
});
