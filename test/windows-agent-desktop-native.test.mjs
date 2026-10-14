import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cscCandidates, windowsBinary } from "../server/desktop-native.mjs";
import { nativeRules } from "../server/agent-guard.mjs";
import { smartAppControlState, windowsHelperEnv } from "../server/windows-helper-launch.mjs";

// The Windows agent helper (scripts/native/agent-desktop.cs) on a real
// Windows runner, driven as Reach drives it: one JSON line in, one out
// (docs/parity/B-desktop-helper.md §13.4). Windows of one colour stand in for
// apps (test/fixtures/windows/desktop-fixture.cs); the screenshots are read
// back pixel by pixel. Elsewhere, or without REACH_TEST_WINDOWS_DESKTOP, it's
// skipped. What the runner is (its build, its integrity, its displays, the
// policies that could block a helper) goes to reports/windows-agent-desktop.json.
const run = process.platform === "win32" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1";
const skip = run ? false : "a real Windows runner only (REACH_TEST_WINDOWS_DESKTOP=1)";
const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SYSTEM32 = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
const reg = (args) => exec(path.join(SYSTEM32, "reg.exe"), args, { windowsHide: true, timeout: 20000 });
const report = {};
const note = (values) => {
  Object.assign(report, values);
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/windows-agent-desktop.json", JSON.stringify(report, null, 2));
};
// A wait that times out says what the newest fixture window had logged.
let lastLog = null;
const until = async (check, what, ms = 30000) => {
  for (const end = Date.now() + ms; ; await sleep(100)) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw Error(`timed out waiting: ${what}${lastLog ? `; ${lastLog()}` : ""}`);
  }
};

// Built once for the file: the helper as Reach builds it, and the fixtures.
let work, helperFile, fixtureGui, fixtureConsole;
const children = new Set();
test.before(async () => {
  if (!run) return;
  // By its long name: a runner's TEMP can be an 8.3 alias (RUNNER~1), and
  // the helper names programs as Windows does.
  work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach agent desktop-")));
  const started = Date.now();
  helperFile = await windowsBinary({ dataDir: work }, "agent-desktop");
  note({ helperBuildMs: Date.now() - started, csc: cscCandidates().find((candidate) => fs.existsSync(candidate)) });
  const csc = cscCandidates().find((candidate) => fs.existsSync(candidate));
  const framework = path.win32.dirname(csc);
  const references = ["System.dll", "System.Drawing.dll", "System.Windows.Forms.dll"].map((name) => `/reference:${path.win32.join(framework, name)}`);
  for (const [target, out] of [["winexe", "fixture.exe"], ["exe", "fixture-console.exe"]])
    await exec(csc, ["/nologo", "/noconfig", `/target:${target}`, "/platform:anycpu", `/out:${path.join(work, out)}`, ...references, path.resolve("test/fixtures/windows/desktop-fixture.cs")],
      { windowsHide: true, timeout: 120000 });
  fixtureGui = path.join(work, "fixture.exe");
  fixtureConsole = path.join(work, "fixture-console.exe");
  // A runner's own console (open on Windows Server 2022 runners) would cover
  // the test windows. Minimized, with only its program's name recorded.
  const { stdout } = await exec(fixtureConsole, ["minimize-consoles"], { windowsHide: true });
  note({ runnerConsoles: JSON.parse(stdout.trim()) });
});
test.after(async () => {
  for (const child of children) try { child.kill(); } catch {}
  if (!work) return;
  // What the launchers started outlives them: every program run from here, by name.
  const programs = fs.readdirSync(work, { recursive: true }).filter((name) => /\.exe$/i.test(name)).map((name) => path.basename(name));
  for (const image of new Set(programs)) await exec(path.join(SYSTEM32, "taskkill.exe"), ["/F", "/IM", image], { windowsHide: true }).catch(() => {});
  fs.rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
});

// The helper as Reach starts it: detached, its own environment, Reach's pid.
// medium: at medium integrity, as Reach runs on a PC (GitHub's runners run
// everything elevated, and an elevated helper gets no input, Rule S).
// env: the environment it starts with (Reach gives it windowsHelperEnv's).
function helper(t, { reachPid = process.pid, console = false, medium = false, env } = {}) {
  const args = ["--reach-pid", String(reachPid), "--reach-console", console ? "1" : "0"];
  const options = { stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true, ...(env ? { env } : {}) };
  const child = medium ? spawn(fixtureConsole, ["medium", helperFile, ...args], options) : spawn(helperFile, args, options);
  children.add(child);
  let buffer = "", stderr = "";
  const waiting = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let at; (at = buffer.indexOf("\n")) >= 0; ) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      waiting.shift()?.resolve(JSON.parse(line));
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code) => { for (const item of waiting.splice(0)) item.reject(Error(`helper exited ${code} ${stderr.slice(0, 500)}`)); resolve(code); }));
  const send = (request, ms = 60000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`no answer to ${request.op ?? "a line"}`)), ms);
    waiting.push({ resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    child.stdin.write(Buffer.isBuffer(request) || typeof request === "string" ? request : JSON.stringify(request) + "\n");
  });
  const close = async () => { child.stdin.end(); await exited; children.delete(child); };
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return { child, send, close, exited, stderr: () => stderr };
}
const rulesFor = (preset, extra = {}, guard = {}) =>
  nativeRules({ preset, ...extra }, { hosts: ["localhost:8443"], titles: ["reach"], protectedPaths: [], home: os.homedir(), platform: "win32", ...guard });

// A fixture window: a copy of the fixture under its own name (an app is its
// .exe), started visibly; its JSON once shown. No title names Reach: a window
// that does is Reach's own to every narrower preset.
async function window(t, name, title, color, [x, y, width, height], ...flags) {
  const exe = path.join(work, `${name}.exe`);
  fs.copyFileSync(fixtureGui, exe);
  const args = ["window", work, name, title, color, String(x), String(y), String(width), String(height), ...flags.filter((flag) => flag !== "medium")];
  const child = flags.includes("medium") ? spawn(fixtureConsole, ["medium", exe, ...args], { stdio: "ignore", windowsHide: true }) : spawn(exe, args, { stdio: "ignore" });
  children.add(child);
  const file = path.join(work, `${name}.json`);
  const shown = JSON.parse(await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8"), `${name} shown`));
  const probeArgs = ["helper-probe", helperFile, String(shown.pid), exe];
  const probe = await exec(fixtureConsole, flags.includes("medium") ? ["medium", fixtureConsole, ...probeArgs] : probeArgs,
    { windowsHide: true, timeout: 15000 });
  note({ processProbes: { ...report.processProbes, [name]: JSON.parse(probe.stdout.trim()) } });
  const kill = () => { try { process.kill(shown.pid); } catch {} try { child.kill(); } catch {} children.delete(child); };
  t.after(kill);
  const log = () => (fs.existsSync(path.join(work, `${name}.log`)) ? fs.readFileSync(path.join(work, `${name}.log`), "utf8") : "");
  lastLog = () => `${name} logged ${JSON.stringify(log().slice(-700))}`;
  t.after(() => { lastLog = null; });
  return { exe, child: { kill }, log, ...shown };
}
// A point on a fixture window's own background (its controls sit at the top).
const background = (w) => [w.x + 30, w.y + w.height - 25];
// Fractions of the main display, as an agent gives a point.
const fractions = (displays) => {
  const main = displays.find((display) => display.main) || displays[0];
  return ([x, y]) => ({ x: (x - main.x) / main.width, y: (y - main.y) / main.height });
};
// The test's own real click (it runs elevated: its input reaches every window).
// A test's console window, closed so it can't cover a later test's windows.
const closeWindow = (handle) => exec(fixtureConsole, ["close", String(handle)], { windowsHide: true })
  .catch(() => { throw Error(`window ${handle} stayed open after its test`); });
// Given a pid, the click refuses a point some other window covers.
const clickAt = (x, y, pid) => exec(fixtureConsole, ["click", String(x), String(y), ...(pid ? [String(pid)] : [])], { windowsHide: true });
// A screenshot, saved; its pixels at screen points.
async function shot(h, displays, maxWidth = 3840) {
  const answer = await h.send({ op: "shot", maxWidth });
  assert.equal(answer.ok, true, JSON.stringify(answer).slice(0, 300));
  const file = path.join(work, `shot-${Date.now()}.jpg`);
  fs.writeFileSync(file, Buffer.from(answer.jpeg, "base64"));
  const main = displays.find((display) => display.main) || displays[0];
  const pixels = async (points) => {
    const args = points.map(([x, y]) => `${Math.round((x - main.x) * answer.width / answer.displayWidth)},${Math.round((y - main.y) * answer.height / answer.displayHeight)}`);
    const { stdout } = await exec(fixtureConsole, ["pixels", file, ...args], { windowsHide: true });
    return stdout.trim().split(/\r?\n/).map((line) => line.split(",").map(Number));
  };
  return { ...answer, file, pixels };
}
const black = ([r, g, b]) => r < 45 && g < 45 && b < 45;
const near = (rgb, hex) => {
  const want = [0, 8, 16].map((shift) => (parseInt(hex, 16) >> (16 - shift)) & 255);
  return rgb.every((value, i) => Math.abs(value - want[i]) < 70);
};
const centre = (w) => [w.x + Math.round(w.width / 2), w.y + Math.round(w.height * 0.6)];

test("probe: what this runner is, and the helper built and answering within its cold start", { skip, timeout: 300000 }, async (t) => {
  const probe = {};
  const read = async (file, args) => { try { return (await exec(file, args, { windowsHide: true, timeout: 20000, maxBuffer: 8 << 20 })).stdout.trim(); } catch (error) { return `error: ${String(error.message).split("\n")[0]}`; } };
  probe.build = await read(path.join(SYSTEM32, "cmd.exe"), ["/d", "/c", "ver"]);
  probe.enableLua = await read(path.join(SYSTEM32, "reg.exe"), ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System", "/v", "EnableLUA"]);
  probe.integrity = (await read(path.join(SYSTEM32, "whoami.exe"), ["/groups"])).split(/\r?\n/).filter((line) => /Mandatory Label/i.test(line)).join(" | ");
  probe.smartAppControl = await smartAppControlState();
  probe.codeIntegrityLog = (await read(path.join(SYSTEM32, "wevtutil.exe"), ["qe", "Microsoft-Windows-CodeIntegrity/Operational", "/rd:true", "/c:1", "/f:text"])).slice(0, 200);
  probe.appLockerLog = (await read(path.join(SYSTEM32, "wevtutil.exe"), ["qe", "Microsoft-Windows-AppLocker/EXE and DLL", "/rd:true", "/c:1", "/f:text"])).slice(0, 200);
  probe.dotnet = await read(path.join(SYSTEM32, "reg.exe"), ["query", "HKLM\\SOFTWARE\\Microsoft\\NET Framework Setup\\NDP\\v4\\Full", "/v", "Release"]);
  // This job's own integrity, and what the medium launcher gives a program.
  probe.ownIntegrity = await read(fixtureConsole, ["integrity"]);
  probe.mediumIntegrity = await read(fixtureConsole, ["medium", fixtureConsole, "integrity"]);
  const h = helper(t);
  const started = Date.now();
  const ready = await h.send({ op: "rules", ...rulesFor("readonly") });
  probe.firstAnswerMs = Date.now() - started;
  probe.rules = ready;
  assert.equal(ready.ok, true, JSON.stringify(ready));
  assert.equal(ready.mode, "view");
  assert.equal(ready.desktop, "Default");
  assert.equal(ready.screen, true);
  assert.equal(typeof ready.elevated, "boolean");
  const displays = await h.send({ op: "displays" });
  probe.displays = displays.displays;
  assert.ok(displays.displays.length >= 1 && displays.displays.every((display) => Number.isInteger(display.id) && display.id > 0 && display.width > 0));
  assert.deepEqual((await h.send({ op: "displays" })).displays.map((display) => display.id), displays.displays.map((display) => display.id), "the same ids twice");
  const bogus = await h.send({ op: "shot", displayId: 7 });
  assert.equal(bogus.kind, "retry");
  // Rules first; a line that isn't UTF-8 or JSON is invalid, and the next one is read.
  const fresh = helper(t);
  assert.deepEqual(await fresh.send({ op: "shot" }), { error: "Rules come first.", kind: "invalid", candidates: [] });
  assert.equal((await fresh.send("not json\n")).kind, "invalid");
  assert.equal((await fresh.send(Buffer.from([0xc3, 0x28, 0x0a]))).kind, "invalid");
  assert.equal((await fresh.send(Buffer.concat([Buffer.alloc(300000, 0x20), Buffer.from("\n")]))).kind, "invalid", "a line over 256 KiB");
  assert.equal((await fresh.send({ op: "rules", ...rulesFor("readonly") })).ok, true);
  assert.equal(h.stderr(), "", "nothing on stderr");
  await fresh.close();
  await h.close();
  note({ probe });
});

test("screenshots: View blacks out protected windows, captionless ones too; Apps shows only the chosen app; Full control everything", { skip, timeout: 300000 }, async (t) => {
  const target = await window(t, "target", "Sample test target", "FF8C00", [40, 40, 360, 260]);
  const vault = await window(t, "vault", "Password Manager", "1E50FF", [440, 40, 300, 200]);
  const popup = await window(t, "popup", "Password Manager", "20C040", [440, 300, 260, 140], "popup");
  const other = await window(t, "other", "Sample test other", "9030C0", [40, 340, 340, 200]);
  const tool = await window(t, "tool", "Sample test tool", "F0F0F0", [60, 60, 120, 90], "topmost", "tool");
  await sleep(1000);
  const h = helper(t);
  assert.equal((await h.send({ op: "rules", ...rulesFor("readonly") })).ok, true);
  const { displays } = await h.send({ op: "displays" });
  const view = await shot(h, displays);
  const [vaultPixel, popupPixel, targetPixel, otherPixel] = await view.pixels([centre(vault), centre(popup), background(target), background(other)]);
  note({ view: { hidden: view.hidden, vaultPixel, popupPixel, targetPixel, otherPixel } });
  assert.ok(black(vaultPixel), `the window titled Password Manager is black: ${vaultPixel}`);
  assert.ok(black(popupPixel), `the captionless one too: ${popupPixel}`);
  assert.ok(near(targetPixel, "FF8C00"), `the target shows: ${targetPixel}`);
  assert.ok(near(otherPixel, "9030C0"), `an ordinary window shows: ${otherPixel}`);
  assert.ok(view.hidden >= 2);
  await h.close();
  // Apps: only the target, less the topmost tool window over it.
  const apps = helper(t);
  assert.equal((await apps.send({ op: "rules", ...rulesFor("apps", { apps: [{ id: target.exe, bundleId: "exe:target.exe", name: "target" }] }) })).ok, true);
  const picture = await shot(apps, displays);
  const [shown, covered, otherApp, vaultApp] = await picture.pixels([background(target), [tool.x + 60, tool.y + 45], background(other), centre(vault)]);
  note({ apps: { hidden: picture.hidden, shown, covered, otherApp, vaultApp } });
  assert.ok(near(shown, "FF8C00"), `the chosen app shows: ${shown}`);
  assert.ok(black(covered), `the topmost tool over it is black: ${covered}`);
  assert.ok(black(otherApp) && black(vaultApp), `the rest is black: ${otherApp} ${vaultApp}`);
  await apps.close();
  // Full control: nothing is black.
  const full = helper(t);
  assert.equal((await full.send({ op: "rules", ...rulesFor("full") })).ok, true);
  const plain = await shot(full, displays);
  const [vaultFull] = await plain.pixels([background(vault)]);
  assert.ok(near(vaultFull, "1E50FF"), `full control sees it: ${vaultFull}`);
  assert.equal(plain.hidden, 0);
  await full.close();
  for (const w of [target, vault, popup, other, tool]) w.child.kill();
});

test("Reach in this PC's default terminal (a pseudo console on GitHub's runners): the window titled Reach is closed, by the Mac's title rule", { skip, timeout: 300000 }, async (t) => {
  const child = spawn(fixtureConsole, ["medium-shown", fixtureConsole, "sleeper", work, "reach-pseudo", "Reach"], { stdio: "ignore", detached: true, windowsHide: true });
  children.add(child);
  t.after(() => { try { child.kill(); } catch {} });
  const file = path.join(work, "reach-pseudo.json");
  const reach = JSON.parse(await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8"), "Reach's stand-in"));
  t.after(() => { try { process.kill(reach.pid); } catch {} });
  const [pseudo, x, y, width, height] = (await until(async () => { try { return (await exec(fixtureConsole, ["find", "Reach"], { windowsHide: true })).stdout.trim(); } catch { return null; } }, "a window titled Reach")).split(",").map(Number);
  t.after(() => closeWindow(pseudo));
  const h = helper(t, { reachPid: reach.pid, console: true, medium: true });
  const ready = await h.send({ op: "rules", ...rulesFor("readonly") });
  assert.equal(ready.ok, true, JSON.stringify(ready));
  const { displays } = await h.send({ op: "displays" });
  const view = await shot(h, displays);
  const [inside] = await view.pixels([[x + Math.round(width / 2), y + Math.round(height / 2)]]);
  note({ pseudo: { reachConsole: ready.reachConsole, frame: [x, y, width, height], inside } });
  assert.ok(black(inside), `the window titled Reach is black: ${inside}`);
  assert.equal((await h.send({ op: "front" })).ok, true, "requests flow after the probe");
  await h.close();
});

test("Reach's own console window is closed to the agent whatever its title, and requests flow after the probe", { skip, timeout: 300000 }, async (t) => {
  // Reach's stand-in in a classic console window of its own titled "Windows
  // PowerShell", at medium integrity as on a PC. This user's default
  // terminal (Windows Terminal on GitHub's runners) is set to the console
  // host meanwhile, as an owner may have it.
  const STARTUP = "HKCU\\Console\\%%Startup", CONHOST = "{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}";
  const before = await reg(["query", STARTUP]).then((result) => result.stdout, () => "");
  note({ defaultTerminal: before.trim() });
  for (const value of ["DelegationConsole", "DelegationTerminal"]) await reg(["add", STARTUP, "/v", value, "/t", "REG_SZ", "/d", CONHOST, "/f"]);
  t.after(async () => {
    for (const value of ["DelegationConsole", "DelegationTerminal"]) {
      const was = before.match(new RegExp(`${value}\\s+REG_SZ\\s+(\\S+)`))?.[1];
      await reg(was ? ["add", STARTUP, "/v", value, "/t", "REG_SZ", "/d", was, "/f"] : ["delete", STARTUP, "/v", value, "/f"]).catch(() => {});
    }
  });
  const conhost = spawn(fixtureConsole, ["medium-shown", fixtureConsole, "sleeper", work, "reach", "Windows PowerShell"], { stdio: ["ignore", "ignore", "pipe"], detached: true, windowsHide: true });
  children.add(conhost);
  t.after(() => { try { conhost.kill(); } catch {} });
  let launcher = "";
  conhost.stderr.on("data", (chunk) => { launcher += chunk; });
  conhost.once("exit", (code) => { launcher += ` (exited ${code})`; });
  const file = path.join(work, "reach.json");
  const reach = JSON.parse(await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8"), "Reach's stand-in").catch((error) => { throw Error(`${error.message}: the launcher said ${launcher || "nothing"}`); }));
  t.after(() => { try { process.kill(reach.pid); } catch {} });
  t.after(() => closeWindow(reach.console));
  const [x, y, width, height] = (await exec(fixtureConsole, ["frame", String(reach.console)], { windowsHide: true })).stdout.trim().split(",").map(Number);
  await sleep(500);
  const h = helper(t, { reachPid: reach.pid, console: true, medium: true });
  const ready = await h.send({ op: "rules", ...rulesFor("readonly") });
  note({ console: { ready, frame: [x, y, width, height] } });
  assert.equal(ready.reachConsole, "classic", JSON.stringify(ready));
  const { displays } = await h.send({ op: "displays" });
  const view = await shot(h, displays);
  const [inside] = await view.pixels([[x + Math.round(width / 2), y + Math.round(height / 2)]]);
  assert.ok(black(inside), `Reach's console is black: ${inside}`);
  assert.equal((await h.send({ op: "front" })).ok, true, "requests flow after the probe");
  await h.close();
  // Even an agent allowed that program can't click, type or press a key there.
  const apps = helper(t, { reachPid: reach.pid, console: true, medium: true });
  assert.equal((await apps.send({ op: "rules", ...rulesFor("apps", { apps: [{ id: fixtureConsole, bundleId: "", name: "fixture-console" }] }) })).reachConsole, "classic");
  const at = fractions(displays);
  const click = await apps.send({ op: "act", action: { type: "click", ...at([x + Math.round(width / 2), y + Math.round(height / 2)]) } });
  assert.equal(click.error, "That's Reach. The agent can't use Reach.", JSON.stringify(click));
  await clickAt(x + 60, y + 12);
  for (const action of [{ type: "key", key: "c", modifiers: ["cmd"] }, { type: "key", key: "f4", modifiers: ["option"] }, { type: "type", text: "exit" }]) {
    const refused = await apps.send({ op: "act", action });
    assert.ok(refused.kind === "blocked" || refused.kind === "retry", `${JSON.stringify(action)}: ${JSON.stringify(refused)}`);
    if (refused.kind === "blocked") assert.equal(refused.error, "That's Reach. The agent can't use Reach.");
  }
  await apps.close();
  // When Reach ends, its helper lets go and ends too.
  const watched = helper(t, { reachPid: reach.pid, console: true, medium: true });
  assert.equal((await watched.send({ op: "rules", ...rulesFor("readonly") })).ok, true);
  process.kill(reach.pid);
  assert.equal(await Promise.race([watched.exited, sleep(10000).then(() => "still running")]), 0);
});

test("input reaches a window at the helper's own integrity: clicks, typing in any script, a chord, a scroll, a drag", { skip, timeout: 300000 }, async (t) => {
  const target = await window(t, "input", "Sample input target", "FF8C00", [40, 40, 560, 380], "medium");
  const h = helper(t, { medium: true });
  const ready = await h.send({ op: "rules", ...rulesFor("full") });
  note({ input: { ready } });
  assert.equal(ready.elevated, false, "medium integrity, as on a PC");
  const at = fractions((await h.send({ op: "displays" })).displays);
  await clickAt(target.x + 80, target.y + 12, target.pid);
  const act = async (action, what) => {
    const answer = await h.send({ op: "act", action });
    if (!answer.ok) {
      const probe = await exec(fixtureConsole, ["medium", fixtureConsole, "helper-probe", helperFile, String(target.pid), target.exe], { windowsHide: true });
      note({ inputFailure: { what, answer, ...JSON.parse(probe.stdout.trim()) } });
    }
    assert.equal(answer.ok, true, `${what}: ${JSON.stringify(answer)}`);
  };
  await act({ type: "click", ...at(target.notes) }, "a click");
  await until(() => /^click /m.test(target.log()), "the click arrives");
  // Another at once, at the same point: a click, not Windows' double click
  // (the helper waits out the double-click time, as a Mac's says the count).
  await act({ type: "click", ...at(target.notes) }, "a second click");
  await until(() => (target.log().match(/^click /gm) || []).length >= 2, "the second click arrives as a click");
  assert.ok(!/^double /m.test(target.log()), `two clicks, no double click: ${target.log()}`);
  await act({ type: "click", ...at(target.notes), count: 2 }, "a double click");
  await until(() => /^double /m.test(target.log()), "the double click arrives");
  await act({ type: "type", text: "café 🙂 日本\nnext" }, "typing");
  await until(() => target.log().includes("text café 🙂 日本\r\nnext"), "the text, exactly");
  await act({ type: "key", key: "m", modifiers: ["cmd"] }, "Ctrl+M");
  await until(() => /^menu$/m.test(target.log()), "the menu's shortcut");
  await act({ type: "scroll", ...at(target.list), dy: 120 }, "a scroll down");
  await until(() => /^wheel -120$/m.test(target.log()), "the wheel turned towards the owner");
  await act({ type: "click", ...at([target.x + 330, target.y + 320]), button: "right" }, "a right click");
  await until(() => /^right /m.test(target.log()), "the right click arrives");
  const from = at([target.x + 330, target.y + 250]), to = at([target.x + 450, target.y + 300]);
  const ups = (target.log().match(/^up /gm) || []).length;
  await act({ type: "drag", x: from.x, y: from.y, toX: to.x, toY: to.y }, "a drag");
  await until(() => (target.log().match(/^up /gm) || []).length > ups, "the drag lets go");
  assert.equal(h.stderr(), "");
  await h.close();
});

test("paste: the agent's text and then the owner's own, both kept out of Clipboard History and cloud sync; nothing left when there was nothing", { skip, timeout: 300000 }, async (t) => {
  const watcher = spawn(fixtureGui, ["clipboard-watch", work, "watch"], { stdio: "ignore" });
  children.add(watcher);
  t.after(() => { try { watcher.kill(); } catch {} });
  await until(() => fs.existsSync(path.join(work, "watch.json")), "the clipboard watcher");
  const watched = () => (fs.existsSync(path.join(work, "watch.log")) ? fs.readFileSync(path.join(work, "watch.log"), "utf8") : "");
  await exec(fixtureConsole, ["clipboard-set", "owner's text"], { windowsHide: true });
  const target = await window(t, "paste", "Sample paste target", "FF8C00", [60, 60, 520, 320], "medium");
  const h = helper(t, { medium: true });
  assert.equal((await h.send({ op: "rules", ...rulesFor("full") })).ok, true);
  const at = fractions((await h.send({ op: "displays" })).displays);
  await clickAt(target.x + 80, target.y + 12, target.pid);
  assert.equal((await h.send({ op: "act", action: { type: "click", ...at(target.notes) } })).ok, true);
  assert.equal((await h.send({ op: "act", action: { type: "type", text: "pasted text", paste: true } })).ok, true);
  await until(() => target.log().includes("text pasted text"), "the paste arrives");
  // The watcher logs in its own time: the owner's text back is the first
  // line with it after the agent's (the test's own setting came before).
  const restored = () => {
    const lines = watched().split("\n").filter(Boolean), at = lines.findIndex((line) => line.endsWith("| text pasted text"));
    return at >= 0 && lines.slice(at + 1).find((line) => line.endsWith("| text owner's text"));
  };
  const owner = await until(restored, "the owner's text back after the paste");
  const formats = ["ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard"];
  const lines = watched().split("\n").filter(Boolean);
  note({ paste: lines });
  const agent = lines.find((line) => line.endsWith("| text pasted text"));
  for (const format of formats) {
    assert.ok(agent.includes(format), `the agent's text carries ${format}`);
    assert.ok(owner.includes(format), `the owner's restored text carries ${format}`);
  }
  assert.equal((await exec(fixtureConsole, ["clipboard-get"], { windowsHide: true })).stdout.trim(), "owner's text");
  await exec(fixtureConsole, ["clipboard-clear"], { windowsHide: true });
  assert.equal((await h.send({ op: "act", action: { type: "type", text: "once more", paste: true } })).ok, true);
  await until(() => target.log().includes("once more"), "the second paste arrives");
  await sleep(500);
  assert.equal((await exec(fixtureConsole, ["clipboard-get"], { windowsHide: true })).stdout.trim(), "(none)", "nothing left behind");
  await h.close();
});

test("refused: a protected window, a password box, an elevated window (Rule T), an elevated window in front (Rule F), an elevated helper (Rule S)", { skip, timeout: 300000 }, async (t) => {
  const target = await window(t, "chosen", "Sample chosen target", "FF8C00", [40, 40, 420, 300], "medium");
  const vault = await window(t, "vault2", "Password Manager", "1E50FF", [500, 40, 300, 220], "medium");
  const admin = await window(t, "admin", "Sample elevated target", "30A0A0", [500, 320, 300, 200]);
  const h = helper(t, { medium: true });
  const rules = rulesFor("apps", { apps: [{ id: target.exe, bundleId: "exe:chosen.exe", name: "chosen" }, { id: admin.exe, bundleId: "", name: "admin" }] });
  assert.equal((await h.send({ op: "rules", ...rules })).ok, true);
  const at = fractions((await h.send({ op: "displays" })).displays);
  await clickAt(target.x + 80, target.y + 12, target.pid);
  const protectedClick = await h.send({ op: "act", action: { type: "click", ...at([vault.x + 150, vault.y + 150]) } });
  assert.equal(protectedClick.kind, "blocked", JSON.stringify(protectedClick));
  assert.equal(vault.log(), "", "nothing reached it");
  assert.equal((await h.send({ op: "act", action: { type: "click", ...at(target.password) } })).ok, true);
  const plain = await h.send({ op: "act", action: { type: "type", text: "not a secret" } });
  assert.equal(plain.kind, "blocked", `plain text into a password box: ${JSON.stringify(plain)}`);
  assert.ok(!target.log().includes("secret "), "nothing typed");
  const ruleT = await h.send({ op: "act", action: { type: "click", ...at([admin.x + 150, admin.y + 120]) } });
  assert.equal(ruleT.kind, "blocked");
  assert.match(ruleT.error, /runs as administrator/);
  assert.equal(admin.log(), "");
  await clickAt(admin.x + 80, admin.y + 12, admin.pid);
  const ruleF = await h.send({ op: "act", action: { type: "click", ...at(target.notes) } });
  assert.equal(ruleF.kind, "paused", JSON.stringify(ruleF));
  assert.match(ruleF.error, /A window running as administrator is in front/);
  await h.close();
  const elevated = helper(t);
  const ready = await elevated.send({ op: "rules", ...rules });
  assert.equal(ready.elevated, true, "a helper started elevated says so");
  const ruleS = await elevated.send({ op: "act", action: { type: "click", ...at(target.notes) } });
  assert.equal(ruleS.kind, "blocked");
  assert.match(ruleS.error, /Reach is running as administrator/);
  assert.equal((await elevated.send({ op: "shot", maxWidth: 640 })).ok, true, "it still sees the screen");
  await elevated.close();
});

test("a held button is let go when the helper's input ends, and when Reach's process is killed", { skip, timeout: 300000 }, async (t) => {
  const target = await window(t, "held", "Sample held target", "FF8C00", [40, 40, 520, 360], "medium");
  const h = helper(t, { medium: true });
  assert.equal((await h.send({ op: "rules", ...rulesFor("full") })).ok, true);
  const at = fractions((await h.send({ op: "displays" })).displays);
  await clickAt(target.x + 80, target.y + 12, target.pid);
  const from = at([target.x + 300, target.y + 250]), to = at([target.x + 420, target.y + 300]);
  const drag = { type: "drag", x: from.x, y: from.y, toX: to.x, toY: to.y, holdMs: 5000 };
  // A press is a press here, whatever Windows makes of its timing (a second
  // one soon after at the same point is its double click).
  const presses = () => (target.log().match(/^(click|double) /gm) || []).length;
  const ups = (target.log().match(/^up /gm) || []).length;
  h.send({ op: "act", action: drag }).catch(() => {});
  await until(() => presses() >= 1, "the button is down");
  const ended = Date.now();
  h.child.stdin.end();
  await until(() => (target.log().match(/^up /gm) || []).length > ups, "let go at the end of input", 1500);
  assert.equal((await exec(fixtureConsole, ["buttons"], { windowsHide: true })).stdout.trim(), "left up");
  await Promise.race([h.exited, sleep(1500)]);
  note({ release: { endedToUpMs: Date.now() - ended } });
  // Reach killed outright: its helper's watchdog lets go. A new helper, so
  // its press starts elsewhere: Windows would make one at the same point
  // within its double-click time a double click.
  const again = at([target.x + 340, target.y + 280]);
  const parent = spawn(process.execPath, [path.resolve("test/fixtures/windows/parent-node.mjs"), fixtureConsole, helperFile, JSON.stringify({ op: "rules", ...rulesFor("full") }),
    JSON.stringify({ ...drag, x: again.x, y: again.y })],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  children.add(parent);
  let said = "";
  parent.stdout.on("data", (chunk) => { said += chunk; });
  await until(() => said.includes('"ok":true'), "the stand-in's helper is ready");
  const before = (target.log().match(/^up /gm) || []).length;
  await until(() => presses() >= 2, "the button is down again");
  await exec(path.join(SYSTEM32, "taskkill.exe"), ["/F", "/PID", String(parent.pid)], { windowsHide: true });
  await until(() => (target.log().match(/^up /gm) || []).length > before, "let go when Reach was killed", 1500);
  assert.equal((await exec(fixtureConsole, ["buttons"], { windowsHide: true })).stdout.trim(), "left up");
});


test("UI Automation: the window's controls by role, a press and a fill by name, find, read, windows, menus, wait-change and focus", { skip, timeout: 300000 }, async (t) => {
  const target = await window(t, "controls", "Sample controls target", "FF8C00", [40, 40, 600, 420], "medium");
  const vault = await window(t, "vault3", "Password Manager", "1E50FF", [660, 40, 300, 220], "medium");
  const h = helper(t, { medium: true });
  const ready = await h.send({ op: "rules", ...rulesFor("apps", { apps: [{ id: target.exe, bundleId: "", name: "controls" }] }) });
  assert.equal(ready.accessibility, true, "UI Automation answered its known questions");
  await clickAt(target.x + 80, target.y + 12, target.pid);
  // Shown is the WinForms window's event, before its accessibility provider
  // and the helper's stable-window snapshots necessarily expose its controls.
  // Require every expected control; an empty initial tree is not acceptance.
  const wantedControls = ["Button:Mark", "TextField:Notes", "SecureTextField:Password"];
  const elements = await until(async () => {
    const result = await h.send({ op: "elements" });
    assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
    const available = result.items.map((item) => `${item.role}:${item.name}`);
    return wantedControls.every((wanted) => available.includes(wanted)) && result;
  }, "the fixture's UI Automation controls", 15000);
  note({ elements: elements.items?.map((item) => `${item.role} ${item.name}`) });
  assert.equal(elements.ok, true, JSON.stringify(elements).slice(0, 300));
  const roles = elements.items.map((item) => `${item.role}:${item.name}`);
  for (const wanted of wantedControls) assert.ok(roles.includes(wanted), `${wanted} in ${roles.join(", ")}`);
  assert.ok(!elements.items.some((item) => item.secure && item.value), "never a password field's value");
  // press by name: the button marks itself
  assert.equal((await h.send({ op: "act", action: { type: "press", name: "Mark" } })).ok, true);
  await until(() => /^button$/m.test(target.log()), "pressed by name");
  // fill: the notes and, from the vault, the password
  assert.equal((await h.send({ op: "act", action: { type: "fill", fields: [{ label: "Notes", text: "filled" }, { label: "Password", text: "hunter2-secret", secret: true }] } })).ok, true);
  await until(() => target.log().includes("text filled") && /^secret 14$/m.test(target.log()), "both fields filled");
  // the vault value is nowhere the agent reads
  const again = await h.send({ op: "elements" });
  const read = await h.send({ op: "read" });
  assert.equal(read.ok, true);
  assert.ok(read.text.includes("[password field]"), "a password field reads as one");
  for (const answer of [again, read]) assert.ok(!JSON.stringify(answer).includes("hunter2-secret"), "the secret never comes back");
  // find scrolls a long list into view
  const found = await h.send({ op: "find", text: "Row 180" });
  note({ find: { found: found.found, inView: found.inView, scrolled: found.scrolled } });
  assert.equal(found.found, true, JSON.stringify(found).slice(0, 300));
  // windows: the chosen app's window; the protected one isn't named at all
  const windows = await h.send({ op: "windows" });
  assert.ok(windows.windows.some((item) => item.title === "Sample controls target"));
  assert.ok(!JSON.stringify(windows).includes("Password Manager"), "protected windows aren't listed");
  // menus: the classic menu with its shortcut; a menu press runs the item
  const menus = await h.send({ op: "menus", menu: "File" });
  note({ menus: menus.menus });
  assert.deepEqual(menus.menus?.[0]?.items?.map((item) => [item.title, item.key]), [["Mark", "Ctrl+M"]]);
  const pressed = await h.send({ op: "act", action: { type: "menu", path: ["File", "Mark"] } });
  note({ menuPress: pressed });
  assert.equal(pressed.ok, true, JSON.stringify(pressed));
  await until(() => /^menu$/m.test(target.log()), "the menu item ran");
  const menuCount = () => target.log().split(/\r?\n/).filter((line) => line === "menu").length;
  const beforeMenuChange = menuCount();
  fs.writeFileSync(path.join(work, "controls.menu-change"), "change during menu preparation");
  const changedMenu = await h.send({ op: "act", action: { type: "menu", path: ["File", "Mark"] } });
  assert.equal(changedMenu.kind, "retry", JSON.stringify(changedMenu));
  assert.equal(changedMenu.pressed, undefined, "no command was acknowledged");
  assert.match(changedMenu.error, /menu item changed/i);
  await sleep(100);
  assert.equal(menuCount(), beforeMenuChange, "a changed command is never dispatched");
  note({ changedMenu: { kind: changedMenu.kind, dispatched: menuCount() - beforeMenuChange } });
  // wait-change: the window changed its own text
  const before = (await h.send({ op: "elements" })).revision;
  await clickAt(target.button[0], target.button[1], target.pid);
  const change = await h.send({ op: "wait-change", revision: before, ms: 400 });
  assert.equal(change.changed, true, JSON.stringify(change));
  // focus: the window by its ref; whether Windows let it come forward is recorded
  await clickAt(vault.x + 80, vault.y + 12, vault.pid);
  const ref = windows.windows.find((item) => item.title === "Sample controls target").id;
  const focused = await h.send({ op: "focus", id: ref, title: "Sample controls target" });
  note({ focus: focused });
  assert.equal(focused.ok, true, JSON.stringify(focused));
  await h.close();
});

test("Settings: its private pages are closed to the agent and black in a screenshot; an ordinary page stays usable", { skip, timeout: 300000 }, async (t) => {
  const settings = "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel";
  const open = (page) => exec(path.join(process.env.SystemRoot || "C:\\Windows", "explorer.exe"), [page], { windowsHide: true }).catch(() => {});
  // GitHub's runners have no unelevated token of their own (their shell runs
  // elevated), and the Basic User token the medium launcher gives can't reach
  // a packaged app's UI Automation (recorded below). So Settings is judged by
  // helpers started as this runner's programs are: elevated, they may look
  // and read, not act (Rule S), which is all this needs.
  const h = helper(t);
  assert.equal((await h.send({ op: "rules", ...rulesFor("apps", { apps: [{ id: settings, bundleId: settings, name: "Settings" }] }) })).ok, true);
  const full = helper(t);
  assert.equal((await full.send({ op: "rules", ...rulesFor("full") })).ok, true);
  const medium = helper(t, { medium: true });
  assert.equal((await medium.send({ op: "rules", ...rulesFor("full") })).ok, true);
  const { displays } = await h.send({ op: "displays" });
  const seen = {};
  for (const page of ["ms-settings:privacy", "ms-settings:network", "ms-settings:display"]) {
    await open(page);
    await sleep(3000);
    // A page that can't be read yet is closed; it opens once it reads as ordinary.
    const answers = [];
    for (let i = 0; i < 10; i++) {
      const front = await h.send({ op: "front" });
      answers.push(front.blocked || "open");
      if (page === "ms-settings:display" ? front.blocked === "" : i >= 2) break;
      await sleep(1000);
    }
    const [, x, y, width, height] = (await exec(fixtureConsole, ["find", "Settings"], { windowsHide: true })).stdout.trim().split(",").map(Number);
    const picture = await shot(h, displays);
    const [inside] = await picture.pixels([[x + Math.round(width / 2), y + Math.round(height / 2)]]);
    const read = await full.send({ op: "read" });
    const mediumRead = await medium.send({ op: "read" });
    seen[page] = { answers, inside, read: (read.text ?? JSON.stringify(read)).slice(0, 600), mediumRead: (mediumRead.text ?? JSON.stringify(mediumRead)).slice(0, 200) };
  }
  note({ settings: seen });
  for (const page of ["ms-settings:privacy", "ms-settings:network"]) {
    assert.ok(seen[page].answers.every((answer) => answer !== "open"), `${page} stays closed: ${seen[page].answers.join(" | ")}`);
    assert.ok(black(seen[page].inside), `${page} is black in a screenshot: ${seen[page].inside}`);
  }
  assert.equal(seen["ms-settings:display"].answers.at(-1), "open", `the display page opens: ${seen["ms-settings:display"].answers.join(" | ")}`);
  for (const helper of [medium, full, h]) await helper.close();
});

// Launching (§13.4 items 4 and 7): copies of the fixture write how they were
// started. Every program the helper starts gets the user's own environment,
// as Windows builds it, never the helper's.
const LAYERS = "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers";
const reportOf = (exe, what, ms = 20000) => until(() => { try { return JSON.parse(fs.readFileSync(`${exe}.env.json`, "utf8")); } catch { return null; } }, what, ms);
const neverStarted = async (exe, what) => { await sleep(1500); assert.ok(!fs.existsSync(`${exe}.env.json`), `${what}: nothing started`); };

test("launching: open, open-file and open-url start programs with the user's own environment; a protected file under another name, and apps that ask for administrator rights, are refused before anything starts", { skip, timeout: 300000 }, async (t) => {
  const folder = path.join(work, "launch");
  const vault = path.join(folder, "Vault Folder"), docs = path.join(folder, "Docs");
  for (const dir of [vault, docs, path.join(folder, "browser")]) fs.mkdirSync(dir, { recursive: true });
  const [reporter, opener, flagged, browser] = ["reporter.exe", "opener.exe", "flagged.exe", path.join("browser", "chrome.exe")].map((name) => path.join(folder, name));
  for (const exe of [reporter, opener, flagged, browser]) fs.copyFileSync(fixtureGui, exe);
  // The fixture again, with a manifest that asks for administrator rights;
  // and a copy that Windows' compatibility settings run as administrator.
  const admin = path.join(folder, "admin-app.exe");
  const csc = cscCandidates().find((candidate) => fs.existsSync(candidate));
  await exec(csc, ["/nologo", "/noconfig", "/target:winexe", "/platform:anycpu", `/out:${admin}`, `/win32manifest:${path.resolve("test/fixtures/windows/require-admin.manifest")}`,
    ...["System.dll", "System.Drawing.dll", "System.Windows.Forms.dll"].map((name) => `/reference:${path.win32.join(path.win32.dirname(csc), name)}`),
    path.resolve("test/fixtures/windows/desktop-fixture.cs")], { windowsHide: true, timeout: 120000 });
  t.after(async () => {
    for (const args of [["delete", LAYERS, "/v", flagged, "/f"], ["delete", "HKCU\\Software\\Classes\\.reachtest", "/f"], ["delete", "HKCU\\Software\\Classes\\ReachTest.File", "/f"]])
      await reg(args).catch(() => {});
  });
  await reg(["add", LAYERS, "/v", flagged, "/t", "REG_SZ", "/d", "~ RUNASADMIN", "/f"]);
  // .reachtest files open in opener.exe: one of the user's own file types.
  await reg(["add", "HKCU\\Software\\Classes\\.reachtest", "/ve", "/d", "ReachTest.File", "/f"]);
  await reg(["add", "HKCU\\Software\\Classes\\ReachTest.File\\shell\\open\\command", "/ve", "/d", `"${opener}" "%1"`, "/f"]);
  const secret = path.join(vault, "secret.reachtest"), noteFile = path.join(docs, "note.reachtest");
  fs.writeFileSync(secret, "a secret");
  fs.writeFileSync(noteFile, "a note");
  const block = JSON.parse((await exec(fixtureConsole, ["env-block"], { windowsHide: true })).stdout);
  // The helper's own environment, as Reach gives it, with two values of its own.
  const helperEnv = { ...windowsHelperEnv(process.env), ProgramFiles: path.join(work, "helper-only"), ComSpec: path.join(work, "helper-only", "cmd.exe") };
  const h = helper(t, { medium: true, env: helperEnv });
  const apps = [reporter, opener, flagged, browser, admin].map((exe) => ({ id: exe, bundleId: "", name: path.basename(exe, ".exe") }));
  assert.equal((await h.send({ op: "rules", ...rulesFor("apps", { apps }, { protectedPaths: [vault] }) })).ok, true);
  const seen = { block, helperPath: helperEnv.PATH, association: (await reg(["query", "HKCU\\Software\\Classes\\ReachTest.File\\shell\\open\\command", "/ve"])).stdout.trim() };
  const theUsers = (report, how) => {
    for (const name of ["PATH", "ProgramFiles", "ComSpec"]) {
      assert.equal(report[name], block[name], `${how}: ${name} as Windows builds it for the user`);
      assert.notEqual(report[name], helperEnv[name], `${how}: ${name} isn't the helper's own`);
    }
  };
  // Refused before anything starts: the protected file by any of its names, and a program.
  const PROTECTED = "That path holds your passwords, keys or Reach's own files.";
  const refused = {};
  const refuse = async (file, what, kinds = ["blocked"]) => {
    const answer = await h.send({ op: "open-file", path: file });
    refused[what] = { file, answer };
    assert.notEqual(answer.ok, true, `${what}: ${JSON.stringify(answer)}`);
    assert.ok(kinds.includes(answer.kind), `${what}: ${JSON.stringify(answer)}`);
    return answer.error;
  };
  assert.equal(await refuse(secret, "the protected file"), PROTECTED);
  assert.equal(await refuse(secret.toUpperCase(), "in capitals"), PROTECTED);
  let alias = null;
  try {
    await exec(path.join(SYSTEM32, "fsutil.exe"), ["file", "setshortname", vault, "VLTALIAS"], { windowsHide: true, timeout: 20000 });
    alias = path.join(folder, "VLTALIAS");
  } catch (error) {
    seen.setShortName = String(error.stdout || error.message).trim().split("\n")[0];
    const short = (await exec(fixtureConsole, ["short", vault], { windowsHide: true })).stdout.trim();
    if (short.toLowerCase() !== vault.toLowerCase()) alias = short;
  }
  seen.alias = alias;
  if (alias) assert.equal(await refuse(path.join(alias, "secret.reachtest"), "its folder by its 8.3 name"), PROTECTED);
  else t.diagnostic("No 8.3 names on this volume: the alias case wasn't run.");
  await refuse(`${secret}.`, "a trailing dot", ["blocked", "invalid"]);
  await refuse(path.join(`${vault}.`, "secret.reachtest"), "a trailing dot on its folder", ["blocked", "invalid"]);
  const junction = path.join(docs, "Link");
  fs.symlinkSync(vault, junction, "junction");
  assert.equal(await refuse(path.join(junction, "secret.reachtest"), "through a junction"), PROTECTED);
  const hard = path.join(docs, "copy.reachtest");
  fs.linkSync(secret, hard);
  assert.match(await refuse(hard, "a hard link to it"), /another name elsewhere/);
  assert.match(await refuse(reporter, "a program"), /would run as a program/);
  await neverStarted(opener, "the refused files");
  // Apps that ask for administrator rights: refused, never started.
  for (const [exe, what] of [[admin, "a manifest asking for administrator rights"], [flagged, "compatibility settings that run it as administrator"]]) {
    const answer = await h.send({ op: "open", app: exe });
    refused[what] = { file: exe, answer };
    assert.equal(answer.kind, "blocked", `${what}: ${JSON.stringify(answer)}`);
    assert.equal(answer.error, "That app asks for administrator rights. The owner opens it at the PC.");
    await neverStarted(exe, what);
  }
  // open: the program alone.
  const opened = await h.send({ op: "open", app: reporter });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const byOpen = await reportOf(reporter, "started by open");
  theUsers(byOpen, "open");
  assert.deepEqual(byOpen.args, []);
  // open-file: the program its file type names, with the file alone.
  const fileOpened = await h.send({ op: "open-file", path: noteFile });
  assert.equal(fileOpened.ok, true, JSON.stringify(fileOpened));
  const byFile = await reportOf(opener, "started by open-file");
  theUsers(byFile, "open-file");
  assert.deepEqual(byFile.args.map((arg) => arg.toLowerCase()), [noteFile.toLowerCase()]);
  // open-url: the browser chosen by its path, the address its one argument.
  const address = "https://example.com/launch-test?x=1";
  const urlOpened = await h.send({ op: "open-url", url: address, app: browser });
  assert.equal(urlOpened.ok, true, JSON.stringify(urlOpened));
  const byUrl = await reportOf(browser, "started by open-url");
  theUsers(byUrl, "open-url");
  assert.deepEqual(byUrl.args, [address]);
  // The app list: Start's apps, File Explorer among them.
  const catalog = await h.send({ op: "catalog" });
  assert.equal(catalog.ok, true, JSON.stringify(catalog).slice(0, 300));
  note({ launching: { ...seen, refused, byOpen, byFile, byUrl, catalog: { count: catalog.apps.length, apps: catalog.apps.slice(0, 60) } } });
  assert.ok(catalog.apps.some((app) => /\\explorer\.exe$/i.test(app.id)), "File Explorer is offered");
  for (const app of catalog.apps) assert.ok(app.name && (/^[a-z]:\\.+\.exe$/i.test(app.id) || /^[a-z0-9.-]+_[0-9a-z]{13}!/i.test(app.id)), `a program's path or a Store app's id: ${JSON.stringify(app)}`);
  assert.equal(h.stderr(), "");
  await h.close();
});

// Bank sites in real browsers (§13.4 item 8): pages served here, the bank
// being localhost. Edge gates, and Chrome when it's installed; Firefox is
// recorded.
test("bank sites in Edge and Chrome: the page's and a frame's address read, Transfer refused, account numbers masked; a chosen browser opens a website", { skip, timeout: 600000 }, async (t) => {
  const MONEY_PAGE = "This bank page moves money. The agent may read it and leave (Back, Accounts, Sign out), nothing else.";
  const hits = [];
  let port = 0;
  const pages = {
    "/accounts": `<!doctype html><title>Test Bank Accounts</title><h1>Accounts</h1><p>Checking 12345678901234</p><p>Card 4111 1111 1111 1111</p>`,
    "/transfer": `<!doctype html><title>Test Bank Transfer</title><h1>Move funds</h1><button onclick="fetch('/clicked?what=transfer')">Transfer</button>`,
    "/shop": () => `<!doctype html><title>Test Shop</title><h1>Shop</h1><button onclick="fetch('/clicked?what=continue')">Continue</button>` +
      `<p><iframe title="payment" src="http://localhost:${port}/transfer" width="420" height="220"></iframe>`,
  };
  const serve = (request, response) => {
    hits.push(request.url);
    const page = pages[new URL(request.url, "http://localhost").pathname];
    response.writeHead(page ? 200 : 204, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(typeof page === "function" ? page() : page || "");
  };
  const servers = [http.createServer(serve), http.createServer(serve)];
  await new Promise((resolve) => servers[0].listen(0, "127.0.0.1", resolve));
  port = servers[0].address().port;
  // localhost can mean ::1 first; the same pages there too, when it exists.
  await new Promise((resolve) => servers[1].once("error", resolve).listen(port, "::1", resolve));
  t.after(() => { for (const server of servers) server.close(); });
  const kill = () => Promise.all(["msedge.exe", "chrome.exe", "firefox.exe"].map((image) => exec(path.join(SYSTEM32, "taskkill.exe"), ["/F", "/T", "/IM", image], { windowsHide: true }).catch(() => {})));
  t.after(kill);
  const programFiles = process.env.ProgramFiles || "C:\\Program Files", programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const installed = (...candidates) => candidates.find((file) => fs.existsSync(file));
  const browsers = [
    { name: "Edge", gate: true, exe: installed(path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"), path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe")) },
    { name: "Chrome", gate: true, exe: installed(path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"), path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe")) },
    { name: "Firefox", gate: false, exe: installed(path.join(programFiles, "Mozilla Firefox", "firefox.exe"), path.join(programFilesX86, "Mozilla Firefox", "firefox.exe")) },
  ];
  const results = {};
  note({ browsers: { installed: Object.fromEntries(browsers.map((browser) => [browser.name, browser.exe || null])) } });
  assert.ok(browsers[0].exe, "Edge is on every Windows PC");
  const h = helper(t, { medium: true });
  const apps = browsers.filter((browser) => browser.exe).map((browser) => ({ id: fs.realpathSync.native(browser.exe), bundleId: "", name: browser.name }));
  assert.equal((await h.send({ op: "rules", ...rulesFor("apps", { apps }), moneySites: ["localhost"] })).ok, true);
  const at = fractions((await h.send({ op: "displays" })).displays);
  // A page in that browser, at medium integrity as the owner's, then brought
  // to the front by a real click on it.
  const show = async (browser, profile, url, title) => {
    const args = browser.name === "Firefox" ? ["-profile", profile, url]
      : ["--no-first-run", "--no-default-browser-check", "--disable-search-engine-choice-screen", "--disable-sync", "--disable-extensions", `--user-data-dir=${profile}`, url];
    const child = spawn(fixtureConsole, ["medium", browser.exe, ...args], { stdio: "ignore", windowsHide: true });
    children.add(child);
    const [, x, y, width, height] = (await until(async () => { try { return (await exec(fixtureConsole, ["find", title], { windowsHide: true })).stdout.trim(); } catch { return null; } }, `${browser.name} shows ${title}`, 60000)).split(",").map(Number);
    await clickAt(x + Math.round(width / 2), y + height - 40);
    return { x, y, width, height };
  };
  // Waits that say what they last saw.
  const seenLast = (check, what) => {
    let last = null;
    return until(async () => { const [done, seen] = await check(); last = seen; return done; }, what, 60000)
      .catch((error) => { throw Error(`${error.message}; last: ${JSON.stringify(last)?.slice(0, 1500)}`); });
  };
  const readUntil = (want, what) => seenLast(async () => {
    const answer = await h.send({ op: "read" });
    return [answer.ok && answer.text?.includes(want) ? answer : null, { ...answer, text: answer.text?.slice(0, 600) }];
  }, what);
  const button = (name, what) => seenLast(async () => {
    const answer = await h.send({ op: "elements" });
    return [answer.ok && answer.items?.find((item) => item.name === name && item.role === "Button"), answer.ok ? answer.items?.map((item) => `${item.role}:${item.name}`).slice(0, 80) : answer];
  }, what);
  const click = async (item, record) => {
    const point = { x: item.x + item.w / 2, y: item.y + item.h / 2 };
    let answer;
    for (let i = 0; i < 20; i++) {
      answer = await h.send({ op: "act", action: { type: "click", ...point } });
      record.push(answer);
      if (answer.kind !== "retry") break;
      await sleep(500);
    }
    return answer;
  };
  for (const browser of browsers.filter((candidate) => candidate.exe)) {
    const result = (results[browser.name] = { clicks: [] });
    const profile = fs.mkdtempSync(path.join(work, `${browser.name.toLowerCase()}-profile-`));
    if (browser.name === "Firefox") fs.writeFileSync(path.join(profile, "user.js"), ['"browser.shell.checkDefaultBrowser", false', '"browser.aboutwelcome.enabled", false',
      '"datareporting.policy.dataSubmissionPolicyBypassNotification", true', '"browser.startup.homepage_override.mstone", "ignore"', '"toolkit.telemetry.reportingpolicy.firstRun", false']
      .map((pref) => `user_pref(${pref});`).join("\n"));
    try {
      // Account numbers: only their last four digits.
      await show(browser, profile, `http://localhost:${port}/accounts`, "Test Bank Accounts");
      const read = await readUntil("Checking", `${browser.name}: the accounts page read`);
      result.read = { url: read.url, text: read.text.slice(0, 400) };
      assert.ok(read.url.startsWith(`http://localhost:${port}/accounts`), `the page's address: ${read.url}`);
      assert.ok(read.text.includes("••••1234") && read.text.includes("••••1111"), `masked: ${read.text.slice(0, 300)}`);
      assert.ok(!read.text.includes("12345678901234") && !read.text.includes("4111 1111 1111 1111"), "never the whole number");
      // A transfer page: its Transfer button refused, nothing clicked.
      await show(browser, profile, `http://localhost:${port}/transfer`, "Test Bank Transfer");
      const transfer = await click(await button("Transfer", `${browser.name}: the Transfer button`), result.clicks);
      assert.equal(transfer.kind, "blocked", JSON.stringify(transfer));
      assert.equal(transfer.error, MONEY_PAGE);
      // A shop (not the bank) holding the bank's transfer page in a frame:
      // its own button works; the frame's address is read and its Transfer refused.
      await show(browser, profile, `http://127.0.0.1:${port}/shop`, "Test Shop");
      const go = await click(await button("Continue", `${browser.name}: the shop's button`), result.clicks);
      assert.equal(go.ok, true, JSON.stringify(go));
      await until(() => hits.includes("/clicked?what=continue"), `${browser.name}: the shop's click arrived`, 10000);
      const framed = await click(await button("Transfer", `${browser.name}: the framed Transfer button`), result.clicks);
      assert.equal(framed.kind, "blocked", JSON.stringify(framed));
      assert.equal(framed.error, MONEY_PAGE);
      await sleep(1000);
      assert.ok(!hits.includes("/clicked?what=transfer"), "no transfer was clicked");
      result.passed = true;
    } catch (error) {
      result.error = String(error.message).slice(0, 500);
      if (browser.gate) { note({ browsers: { installed: Object.fromEntries(browsers.map((candidate) => [candidate.name, candidate.exe || null])), results } }); throw error; }
    } finally {
      hits.splice(0, hits.length, ...hits.filter((hit) => !hit.startsWith("/clicked")));
      await kill();
    }
  }
  // open-url with a chosen browser: the helper starts it with the address.
  const edge = apps.find((app) => app.name === "Edge");
  const opened = await h.send({ op: "open-url", url: `http://localhost:${port}/accounts?via=open-url`, app: edge.id });
  results.openUrl = { answer: opened };
  assert.equal(opened.ok, true, JSON.stringify(opened));
  results.openUrl.arrived = await until(() => hits.includes("/accounts?via=open-url"), "Edge asked for the address", 60000).then(() => true, () => false);
  note({ browsers: { installed: Object.fromEntries(browsers.map((browser) => [browser.name, browser.exe || null])), results } });
  assert.equal(results.openUrl.arrived, true, "Edge opened the address");
  await h.close();
});
