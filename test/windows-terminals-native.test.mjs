import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cscCandidates, windowsBinary } from "../server/desktop-native.mjs";
import { DesktopTerminals } from "../server/desktop-terminals.mjs";
import { terminalWatchHelper } from "../server/mac-terminal-watch.mjs";
import { windowsProcesses } from "../server/windows-processes.mjs";
import { endWindowsTerminal, isTerminal, useWindowsTerminal, whyNoWindowsTerminal, windowsTerminalTabs } from "./helpers/windows-terminal-portable.mjs";

// The PC's own terminals on a real Windows PC (GitHub's windows-2025 runner):
// scripts/native/windows-terminals.cs built with the PC's csc.exe, driving a
// real console window (conhost, never handed to Windows Terminal), a console
// opened as Reach opens one, and a Windows Terminal tab when Windows Terminal
// is installed. Each is listed, read, typed into and closed exactly as the
// phone does it, through DesktopTerminals. Reach's own stand-ins (a process
// opening terminals, one with ConPTY sessions) are child processes, so a
// native session can never keep this file from ending, and so what they open
// is seen to outlive them. What each run saw is kept in
// reports/windows-terminals-native.json: which kind each terminal turned out
// to be (a console opened on a PC whose default terminal is Windows Terminal
// is handed to it).
const windows = process.platform === "win32";
const real = { skip: (!windows || process.env.REACH_TEST_WINDOWS_DESKTOP !== "1") && "the serial Windows desktop lane", timeout: 170000 };
const run = promisify(execFile);
const allow = () => {};
const system = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
const cmd = path.join(system, "cmd.exe");
const seen = { tests: {} };
let dataDir = null;
// One build for the file, in a folder with a space as most PCs' have.
async function folder() {
  if (dataDir) return dataDir;
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "reach terminals-"));
  const started = Date.now();
  await windowsBinary({ dataDir }, "windows-terminals");
  seen.buildMs = Date.now() - started;
  return dataDir;
}
after(async () => {
  if (!windows) return;
  await fs.mkdir("reports", { recursive: true });
  await fs.writeFile("reports/windows-terminals-native.json", JSON.stringify(seen, null, 2));
  if (dataDir) await endWindowsTerminal({ nativeDir: dataDir }).catch(() => {});
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
});
const marker = (kind) => `reach-${kind}-${crypto.randomBytes(4).toString("hex")}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what, check, ms = 30000) {
  const end = Date.now() + ms;
  let last;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > end)
      throw Error(`Timed out: ${what}${last ? ` (last: ${last.message})` : ""}; the PC's terminals were: ${JSON.stringify(lastSeen)}`);
    await pause(400);
  }
}
// The console's programs ended for good, whatever the test's outcome.
const sweep = (pids) => Promise.all(pids.filter(Boolean).map((pid) => run("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {})));
const terminals = async (options = {}) =>
  new DesktopTerminals({ platform: "win32", dataDir: await folder(), reach: 0, ...options });
const module = (file) => JSON.stringify(new URL(`../server/${file}`, import.meta.url).href);
// A console window as the Run box or Start menu opens one: conhost.exe
// started by the shell, so it has no standard handles. Given some, as Node
// gives every program it starts (NUL for ignored ones), conhost takes them
// for a pseudo console's pipes and shows no window (the first runner run,
// Oct 13). Its pid, ended whatever the test's outcome.
async function consoleWindow(t, title) {
  const conhost = path.join(system, "conhost.exe");
  const { stdout } = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `(Start-Process -FilePath '${conhost}' -ArgumentList '${cmd} /d /k title ${title}' -PassThru).Id`],
    { windowsHide: true, timeout: 60000 },
  );
  const pid = Number(stdout.trim());
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `conhost started: ${stdout}`);
  t.after(() => sweep([pid]));
  return pid;
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// A script run by its own Node process, from a folder of its own.
async function script(t, source) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach terminals child-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }).catch(() => {}));
  const file = path.join(dir, "child.mjs");
  await fs.writeFile(file, source);
  return file;
}
// Reach opening a terminal (a shortcut), then gone: what it opened stays.
async function openFrom(t, provider, name, cwd) {
  const file = await script(
    t,
    `import { DesktopTerminals } from ${module("desktop-terminals.mjs")};
import { windowsLaunch } from ${module("windows-terminals.mjs")};
const [provider, name, dataDir, cwd, cmd] = process.argv.slice(2);
// cmd as the owner's shell, so the command line is the one Reach writes.
const d = new DesktopTerminals({ platform: "win32", dataDir, reach: 0, launch: (options) => windowsLaunch({ ...options, shell: { file: cmd, args: ["/d"], kind: "cmd", name: "Command Prompt" } }) });
console.log(JSON.stringify(await d.create(provider, () => {}, \`title \${name} & cd & echo opened-ok\`, { cwd })));
process.exit(0);
`,
  );
  const { stdout } = await run(process.execPath, [file, provider, name, await folder(), cwd, cmd], { timeout: 120000, windowsHide: true });
  return JSON.parse(stdout.trim().split(/\r?\n/).pop());
}
// What the list had, said when a wait for a terminal runs out.
let lastSeen = [];
const find = async (d, name) => {
  const { sessions } = await d.list(allow);
  lastSeen = sessions.map((s) => `${s.provider}: ${s.name}`);
  return sessions.find((s) => s.name.includes(name));
};
const lines = (text) => String(text).split("\n").map((line) => line.trim());

// Console handover needs an interactive default-terminal host. The full CI
// lane reuses the desktop after lifecycle tests; establish a known live tab
// before exercising handover, then close only this test's tab. The console
// under test is still created through Node/CreateProcess, never wt.exe.
async function handoverHost(t) {
  const terminal = await useWindowsTerminal();
  const name = marker("handover-host");
  await openFrom(t, "windows-terminal", name, await folder());
  const d = await terminals();
  const tab = await eventually(`${name} ready for console handover`, () => find(d, name));
  assert.equal(tab.provider, "windows-terminal");
  seen.handoverHost = { source: terminal.source, ready: true };
  t.after(async () => {
    try { await d.action(tab.id, "close", { confirm: true }, allow); }
    catch (error) { if (error.status !== 404) throw error; }
  });
}

async function consoleLauncher() {
  const file = path.join(await folder(), "new-console.exe");
  try { await fs.access(file); return file; } catch {}
  let csc;
  for (const candidate of cscCandidates()) {
    try { await fs.access(candidate); csc = candidate; break; } catch {}
  }
  assert.ok(csc, "the in-box C# compiler is present");
  await run(csc, ["/nologo", "/noconfig", "/target:exe", `/out:${file}`,
    `/reference:${path.join(path.dirname(csc), "System.dll")}`,
    path.resolve("test/fixtures/windows/new-console.cs")], { windowsHide: true, timeout: 120000 });
  return file;
}

// List it, type into it, read the answer back (screen and scrollback), bring
// it forward and close it: the phone's whole round trip.
async function roundTrip(d, name, record) {
  const tab = await eventually(`${name} listed`, () => find(d, name));
  record.provider = tab.provider;
  record.tty = tab.tty;
  const target = d.targets.get(tab.id).target;
  record.pid = target.pid;
  const echo = `ok-${crypto.randomBytes(3).toString("hex")}`;
  const sentAt = Date.now();
  await d.action(tab.id, "send", { text: `echo ${echo}` }, allow);
  const screen = await eventually("the answer on screen", async () => {
    const { text } = await d.action(tab.id, "read", null, allow);
    return lines(text).includes(echo) && text;
  });
  record.echoMs = Date.now() - sentAt;
  assert.ok(lines(screen).some((line) => line.endsWith(`echo ${echo}`)), "the typed line shows where it was typed");
  const { text: scrollback } = await d.action(tab.id, "read", { scrollback: true }, allow);
  assert.ok(lines(scrollback).includes(echo));
  // Typed with Windows' own keyboard and as Unicode, Enter included.
  const unicode = "héllo-✓";
  await d.action(tab.id, "send", { text: `echo ${unicode}` }, allow);
  await eventually("Unicode typed and read back", async () => lines((await d.action(tab.id, "read", null, allow)).text).includes(unicode));
  const front = await d.action(tab.id, "focus", {}, allow);
  assert.equal(front.ok, true);
  record.front = front.front;
  await d.action(tab.id, "close", { confirm: true }, allow);
  await eventually(`${name} gone from the list`, async () => !(await find(d, name)), 20000);
  return target;
}

test("a console window on the PC is listed, read, typed into, brought forward and closed", real, async (t) => {
  const record = (seen.tests.console = {});
  const name = marker("console");
  // conhost.exe started with a command line keeps its own window: Windows
  // never hands it to Windows Terminal.
  const host = await consoleWindow(t, name);
  const d = await terminals();
  const target = await roundTrip(d, name, record);
  assert.equal(record.provider, "console");
  assert.match(record.tty, /^\d+$/);
  // Closed as its close button closes it: the window and its programs end.
  await eventually("conhost exited after closing", () => !alive(host), 15000);
  // The helper knows a console that's gone, never another in its place.
  await assert.rejects(d.run({ provider: "console", action: "read", target }), { status: 404, message: "This terminal has closed. Refresh the list." });
});

test("Reach's own terminals are left out of the PC's list; a console Reach's process opened itself is too, others aren't", real, async (t) => {
  await handoverHost(t);
  const record = (seen.tests.own = {});
  const own = marker("own");
  const shell = marker("shell");
  // Reach's stand-in, with no console of its own (as a service has none):
  // one ConPTY terminal as Reach starts them (server/terminal.mjs), and a
  // shell it starts, which Windows gives a console window of its own.
  const file = await script(
    t,
    `import { spawn } from "node:child_process";
import { loadPty } from ${module("pty-helper.mjs")};
const [own, shell, cmd, launcher] = process.argv.slice(2);
const pty = loadPty().spawn(cmd, ["/d", "/k", \`title \${own}\`], { name: "xterm-256color", cols: 90, rows: 28, cwd: process.cwd(), env: process.env, useConptyDll: true });
const child = spawn(launcher, [cmd, shell, String(process.pid)], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
let ready = false, ptyReady = false, shellPid = null, said = "";
const report = () => {
  if (ready || !ptyReady || !shellPid) return;
  ready = true;
  console.log(JSON.stringify({ pty: pty.pid, shell: shellPid }));
};
pty.onData(() => { ptyReady = true; report(); });
child.stdout.on("data", (chunk) => {
  said += chunk;
  if (said.includes("\\n")) { shellPid = Number(said.trim()); report(); }
});
process.stdin.resume();
process.stdin.on("end", () => {
  for (const end of [() => pty.kill(), () => child.kill()]) try { end(); } catch {}
  setTimeout(() => process.exit(0), 300);
});
`,
  );
  const reach = spawn(process.execPath, [file, own, shell, cmd, await consoleLauncher()], { detached: true, stdio: ["pipe", "pipe", "inherit"] });
  const gone = new Promise((resolve) => reach.once("exit", resolve));
  let said = "";
  reach.stdout.on("data", (chunk) => (said += chunk));
  t.after(async () => {
    reach.stdin.end();
    await Promise.race([gone, pause(10000)]);
    await sweep([reach.pid]);
  });
  const pids = await eventually("Reach's stand-in started", () => said.includes("\n") && JSON.parse(said.split("\n")[0]), 60000);
  t.after(() => sweep([pids.shell]));
  // Anyone else's view: the console window is the PC's.
  const everyone = await terminals();
  const window = await eventually(`${shell} listed`, () => find(everyone, shell)).catch(async error => {
    const { stdout } = await run(await consoleLauncher(), ["--probe", String(pids.shell)], { windowsHide: true, timeout: 15000 });
    record.console = JSON.parse(stdout.trim());
    record.processes = (await windowsProcesses({ nativeDir: await folder() }))
      .filter(p => [reach.pid, pids.shell, record.console.rootPid, record.console.ownerPid].includes(p.pid))
      .map(({ pid, ppid, image }) => ({ pid, ppid, image }));
    error.message += `; console: ${JSON.stringify(record)}`;
    throw error;
  });
  record.provider = window.provider;
  // Reach's own view: neither its terminal nor the shell it started.
  const reachs = await terminals({ reach: reach.pid });
  const listed = (await reachs.list(allow)).sessions.map((s) => s.name);
  assert.ok(!listed.some((name) => name.includes(shell)), "a shell Reach started is Reach's own");
  for (const view of [everyone, reachs])
    assert.equal(await find(view, own), undefined, "Reach's own terminal is never the PC's");
  record.excluded = true;
});

test("a new terminal opens from the phone in the folder asked, running its command, and stays after Reach is gone", real, async (t) => {
  await handoverHost(t);
  const record = (seen.tests.created = {});
  const name = marker("created");
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "reach new;terminal "));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }).catch(() => {}));
  const opened = await openFrom(t, "console", name, cwd);
  assert.equal(opened.provider, "console");
  const d = await terminals();
  const tab = await eventually(`${name} listed after the process that opened it ended`, () => find(d, name));
  t.after(() => sweep([d.targets.get(tab.id)?.target.pid]));
  // Handed to Windows Terminal when it's this PC's default terminal app.
  record.provider = tab.provider;
  const { text } = await eventually("its command ran in its folder", async () => {
    const read = await d.action(tab.id, "read", null, allow);
    return lines(read.text).includes("opened-ok") && read;
  });
  assert.ok(lines(text).includes(cwd), `it started in ${cwd}`);
  await roundTrip(d, name, (record.roundTrip = {}));
});

// Windows Terminal itself, the PC's own or its pinned portable build
// (test/helpers/windows-terminal-portable.mjs); never skipped. A tab is the
// Windows Terminal's that wt.exe started when its shell is that program's
// child (a console Windows handed over has another parent).
// A portable one is ended once the test is done: a running Windows Terminal
// takes the consoles Windows hands over.
async function terminalFor(t) {
  const terminal = await useWindowsTerminal();
  seen.windowsTerminal = { source: terminal.source, version: terminal.version, wt: terminal.wt };
  t.after(async () => endWindowsTerminal({ nativeDir: await folder() }));
  return terminal;
}
async function startedBy(pid, terminal) {
  const list = await windowsProcesses({ nativeDir: await folder() });
  const shell = list.find((p) => p.pid === pid);
  const parent = shell && list.find((p) => p.pid === shell.ppid);
  return { parent, ours: isTerminal(parent, terminal) };
}
// Tabs carry their console's title, with "Administrator: " before it on an
// elevated PC (GitHub's runner): a marker is found in it.
const tabsNamed = async (names) => (await windowsTerminalTabs()).find((w) => names.every((name) => w.tabs.some((tab) => String(tab.name).includes(name))));

test("a Windows Terminal tab opened from the phone is listed, read, typed into and closed", real, async (t) => {
  const terminal = await terminalFor(t);
  const record = (seen.tests.windowsTerminal = {});
  const name = marker("wt");
  const opened = await openFrom(t, "windows-terminal", name, os.tmpdir());
  assert.equal(opened.provider, "windows-terminal");
  const d = await terminals();
  const tab = await eventually(`${name} listed after the process that opened it ended`, () => find(d, name), 60000).catch(async (error) => {
    throw Error(`${error.message}; ${await whyNoWindowsTerminal({ nativeDir: await folder() })}`);
  });
  t.after(() => sweep([d.targets.get(tab.id)?.target.pid]));
  assert.equal(tab.provider, "windows-terminal");
  const by = await startedBy(d.targets.get(tab.id).target.pid, terminal);
  record.parent = by.parent && `${by.parent.image} ${by.parent.path}`;
  assert.ok(by.ours, `its shell is Windows Terminal's (${terminal.wt}), not a console Windows handed over: parent ${record.parent}`);
  await eventually("its command ran", async () => lines((await d.action(tab.id, "read", null, allow)).text).includes("opened-ok"));
  // Windows Terminal shows it, titled as its console is.
  assert.ok(await tabsNamed([name]), `Windows Terminal shows a tab named ${name}`);
  await roundTrip(d, name, record);
});

test("a Windows Terminal tab is picked by its title in a window with others, as the PC shows it", real, async (t) => {
  const terminal = await terminalFor(t);
  const record = (seen.tests.pickTab = {});
  const window = marker("window");
  const names = [marker("tab-a"), marker("tab-b")];
  const d = await terminals();
  // Two tabs in one window, the second chosen as it opens.
  const tabs = [];
  for (const name of names) {
    await run(terminal.wt, ["-w", window, "new-tab", "-d", os.tmpdir(), "--", cmd, "/d", "/k", `title ${name}`], { windowsHide: true, timeout: 60000 });
    const tab = await eventually(`${name} listed`, () => find(d, name), 60000).catch(async (error) => {
      throw Error(`${error.message}; ${await whyNoWindowsTerminal({ nativeDir: await folder() })}`);
    });
    t.after(() => sweep([d.targets.get(tab.id)?.target.pid]));
    tabs.push(tab);
  }
  const shown = await eventually("both tabs in one window", () => tabsNamed(names));
  record.window = shown.window;
  // The shown tab, by the marker in its name.
  const selected = async () =>
    ((await tabsNamed(names))?.tabs || []).filter((tab) => tab.selected).map((tab) => names.find((name) => String(tab.name).includes(name)) || tab.name);
  assert.deepEqual(await selected(), [names[1]], "the newest tab is the one shown");
  // Bringing the first forward shows its tab, then the second's.
  for (const [i, tab] of [[0, tabs[0]], [1, tabs[1]]]) {
    const front = await d.action(tab.id, "focus", {}, allow);
    record[`focus${i}`] = front;
    assert.equal(front.tab, true, `the helper chose ${names[i]}'s tab`);
    await eventually(`${names[i]}'s tab shown`, async () => JSON.stringify(await selected()) === JSON.stringify([names[i]]), 15000);
  }
  for (const tab of tabs) await d.action(tab.id, "close", { confirm: true }, allow);
  await eventually("both tabs closed", async () => !(await tabsNamed([names[0]])) && !(await tabsNamed([names[1]])), 20000);
});

test("the watch says when a console opens, prints and closes", real, async (t) => {
  const record = (seen.tests.watch = {});
  const dir = await folder();
  const helper = await terminalWatchHelper({ dataDir: dir }, { platform: "win32" })();
  t.after(async () => {
    const stopped = helper.stop();
    assert.equal(helper.stop(), stopped, "native watcher shutdown is idempotent");
    const result = await stopped;
    assert.deepEqual(result, { code: 0, signal: null }, "actual C# watcher has closed after stdin EOF");
    record.retired = true;
  });
  const events = [];
  helper.on("event", (event) => events.push({ at: Date.now(), ...event }));
  await eventually("ready", () => events.some((e) => e.type === "ready"));
  const name = marker("watch");
  const started = Date.now();
  await consoleWindow(t, name);
  await eventually("opened", () => events.some((e) => e.type === "opened" && e.at >= started));
  const d = await terminals();
  const tab = await eventually(`${name} listed`, () => find(d, name));
  helper.send({ ttys: [tab.tty] });
  await eventually("watching", () => events.some((e) => e.type === "watching" && e.ttys === 1));
  const typed = Date.now();
  await d.action(tab.id, "send", { text: "echo watched" }, allow);
  const output = await eventually("output", () => events.find((e) => e.type === "output" && e.tty === tab.tty && e.at >= typed));
  record.outputMs = output.at - typed;
  const closing = Date.now();
  await d.action(tab.id, "close", { confirm: true }, allow);
  await eventually("closed", () => events.some((e) => e.type === "closed" && e.at >= closing));
  record.closedMs = Date.now() - closing;
});
