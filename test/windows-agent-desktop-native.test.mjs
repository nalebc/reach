import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { cscCandidates, windowsBinary } from "../server/desktop-native.mjs";
import { nativeRules } from "../server/agent-guard.mjs";
import { smartAppControlState } from "../server/windows-helper-launch.mjs";

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
const report = {};
const note = (values) => {
  Object.assign(report, values);
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/windows-agent-desktop.json", JSON.stringify(report, null, 2));
};
const until = async (check, what, ms = 30000) => {
  for (const end = Date.now() + ms; ; await sleep(100)) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw Error(`timed out waiting: ${what}`);
  }
};

// Built once for the file: the helper as Reach builds it, and the fixtures.
let work, helperFile, fixtureGui, fixtureConsole;
const children = new Set();
test.before(async () => {
  if (!run) return;
  work = fs.mkdtempSync(path.join(os.tmpdir(), "reach agent desktop-"));
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
});
test.after(async () => {
  for (const child of children) try { child.kill(); } catch {}
  if (work) fs.rmSync(work, { recursive: true, force: true });
});

// The helper as Reach starts it: detached, its own environment, Reach's pid.
function helper(t, { reachPid = process.pid, console = false } = {}) {
  const child = spawn(helperFile, ["--reach-pid", String(reachPid), "--reach-console", console ? "1" : "0"], { stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true });
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
  const exited = new Promise((resolve) => child.once("exit", (code) => { for (const item of waiting.splice(0)) item.reject(Error(`helper exited ${code}`)); resolve(code); }));
  const send = (request, ms = 60000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(`no answer to ${request.op ?? "a line"}`)), ms);
    waiting.push({ resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    child.stdin.write(Buffer.isBuffer(request) || typeof request === "string" ? request : JSON.stringify(request) + "\n");
  });
  const close = async () => { child.stdin.end(); await exited; children.delete(child); };
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return { child, send, close, exited, stderr: () => stderr };
}
const rulesFor = (preset, extra = {}) => nativeRules({ preset, ...extra }, { hosts: ["localhost:8443"], titles: ["reach"], protectedPaths: [], home: os.homedir(), platform: "win32" });

// A fixture window: a copy of the fixture under its own name (an app is its
// .exe), started visibly; its JSON once shown.
async function window(t, name, title, color, [x, y, width, height], ...flags) {
  const exe = path.join(work, `${name}.exe`);
  fs.copyFileSync(fixtureGui, exe);
  const child = spawn(exe, ["window", work, name, title, color, String(x), String(y), String(width), String(height), ...flags], { stdio: "ignore" });
  children.add(child);
  t.after(() => { try { child.kill(); } catch {} children.delete(child); });
  const file = path.join(work, `${name}.json`);
  const shown = await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8"), `${name} shown`);
  return { exe, child, ...JSON.parse(shown) };
}
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
  const target = await window(t, "target", "Reach test target", "FF8C00", [40, 40, 360, 260]);
  const vault = await window(t, "vault", "Password Manager", "1E50FF", [440, 40, 300, 200]);
  const popup = await window(t, "popup", "Password Manager", "20C040", [440, 300, 260, 140], "popup");
  const other = await window(t, "other", "Reach test other", "9030C0", [40, 340, 340, 200]);
  const tool = await window(t, "tool", "Reach test tool", "F0F0F0", [60, 60, 120, 90], "topmost", "tool");
  await sleep(1000);
  const h = helper(t);
  assert.equal((await h.send({ op: "rules", ...rulesFor("readonly") })).ok, true);
  const { displays } = await h.send({ op: "displays" });
  const view = await shot(h, displays);
  const [vaultPixel, popupPixel, targetPixel, otherPixel] = await view.pixels([centre(vault), centre(popup), [target.x + 300, target.y + 200], centre(other)]);
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
  const [shown, covered, otherApp, vaultApp] = await picture.pixels([[target.x + 300, target.y + 200], [tool.x + 60, tool.y + 45], centre(other), centre(vault)]);
  note({ apps: { hidden: picture.hidden, shown, covered, otherApp, vaultApp } });
  assert.ok(near(shown, "FF8C00"), `the chosen app shows: ${shown}`);
  assert.ok(black(covered), `the topmost tool over it is black: ${covered}`);
  assert.ok(black(otherApp) && black(vaultApp), `the rest is black: ${otherApp} ${vaultApp}`);
  await apps.close();
  // Full control: nothing is black.
  const full = helper(t);
  assert.equal((await full.send({ op: "rules", ...rulesFor("full") })).ok, true);
  const plain = await shot(full, displays);
  const [vaultFull] = await plain.pixels([centre(vault)]);
  assert.ok(near(vaultFull, "1E50FF"), `full control sees it: ${vaultFull}`);
  assert.equal(plain.hidden, 0);
  await full.close();
  for (const w of [target, vault, popup, other, tool]) w.child.kill();
});

test("Reach's own console window is closed to the agent whatever its title, and requests flow after the probe", { skip, timeout: 300000 }, async (t) => {
  const conhost = spawn(path.join(SYSTEM32, "conhost.exe"), [fixtureConsole, "sleeper", work, "reach", "Windows PowerShell"], { stdio: "ignore", detached: true });
  children.add(conhost);
  t.after(() => { try { conhost.kill(); } catch {} });
  const file = path.join(work, "reach.json");
  const reach = JSON.parse(await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8"), "Reach's stand-in"));
  t.after(() => { try { process.kill(reach.pid); } catch {} });
  const [x, y, width, height] = (await exec(fixtureConsole, ["frame", String(reach.console)], { windowsHide: true })).stdout.trim().split(",").map(Number);
  await sleep(500);
  const h = helper(t, { reachPid: reach.pid, console: true });
  const ready = await h.send({ op: "rules", ...rulesFor("readonly") });
  note({ console: { ready, frame: [x, y, width, height] } });
  assert.equal(ready.reachConsole, "classic", JSON.stringify(ready));
  const { displays } = await h.send({ op: "displays" });
  const view = await shot(h, displays);
  const [inside] = await view.pixels([[x + Math.round(width / 2), y + Math.round(height / 2)]]);
  assert.ok(black(inside), `Reach's console is black: ${inside}`);
  const front = await h.send({ op: "front" });
  assert.equal(front.ok, true);
  await h.close();
  // When Reach ends, its helper lets go and ends too.
  const watched = helper(t, { reachPid: reach.pid, console: true });
  assert.equal((await watched.send({ op: "rules", ...rulesFor("readonly") })).ok, true);
  process.kill(reach.pid);
  assert.equal(await Promise.race([watched.exited, sleep(10000).then(() => "still running")]), 0);
});
