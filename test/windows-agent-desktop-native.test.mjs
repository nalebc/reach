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
// medium: at medium integrity, as Reach runs on a PC (GitHub's runners run
// everything elevated, and an elevated helper gets no input, Rule S).
function helper(t, { reachPid = process.pid, console = false, medium = false } = {}) {
  const args = ["--reach-pid", String(reachPid), "--reach-console", console ? "1" : "0"];
  const child = medium
    ? spawn(fixtureConsole, ["medium", helperFile, ...args], { stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true })
    : spawn(helperFile, args, { stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true });
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
  const args = ["window", work, name, title, color, String(x), String(y), String(width), String(height), ...flags.filter((flag) => flag !== "medium")];
  const child = flags.includes("medium") ? spawn(fixtureConsole, ["medium", exe, ...args], { stdio: "ignore", windowsHide: true }) : spawn(exe, args, { stdio: "ignore" });
  children.add(child);
  const file = path.join(work, `${name}.json`);
  const shown = JSON.parse(await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8"), `${name} shown`));
  const kill = () => { try { process.kill(shown.pid); } catch {} try { child.kill(); } catch {} children.delete(child); };
  t.after(kill);
  return { exe, child: { kill }, log: () => (fs.existsSync(path.join(work, `${name}.log`)) ? fs.readFileSync(path.join(work, `${name}.log`), "utf8") : ""), ...shown };
}
// Fractions of the main display, as an agent gives a point.
const fractions = (displays) => {
  const main = displays.find((display) => display.main) || displays[0];
  return ([x, y]) => ({ x: (x - main.x) / main.width, y: (y - main.y) / main.height });
};
// The test's own real click (it runs elevated: its input reaches every window).
const clickAt = (x, y) => exec(fixtureConsole, ["click", String(x), String(y)], { windowsHide: true });
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
  // Reach's stand-in in a classic console window titled "Windows PowerShell",
  // at medium integrity as on a PC.
  const conhost = spawn(fixtureConsole, ["medium", path.join(SYSTEM32, "conhost.exe"), fixtureConsole, "sleeper", work, "reach", "Windows PowerShell"], { stdio: "ignore", detached: true, windowsHide: true });
  children.add(conhost);
  t.after(() => { try { conhost.kill(); } catch {} });
  const file = path.join(work, "reach.json");
  const reach = JSON.parse(await until(() => fs.existsSync(file) && fs.readFileSync(file, "utf8"), "Reach's stand-in"));
  t.after(() => { try { process.kill(reach.pid); } catch {} });
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
  const target = await window(t, "input", "Reach input target", "FF8C00", [40, 40, 560, 380], "medium");
  const h = helper(t, { medium: true });
  const ready = await h.send({ op: "rules", ...rulesFor("full") });
  note({ input: { ready } });
  assert.equal(ready.elevated, false, "medium integrity, as on a PC");
  const at = fractions((await h.send({ op: "displays" })).displays);
  await clickAt(target.x + 80, target.y + 12);
  const act = async (action, what) => {
    const answer = await h.send({ op: "act", action });
    assert.equal(answer.ok, true, `${what}: ${JSON.stringify(answer)}`);
  };
  await act({ type: "click", ...at(target.notes) }, "a click");
  await until(() => /^click /m.test(target.log()), "the click arrives");
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
  const target = await window(t, "paste", "Reach paste target", "FF8C00", [60, 60, 520, 320], "medium");
  const h = helper(t, { medium: true });
  assert.equal((await h.send({ op: "rules", ...rulesFor("full") })).ok, true);
  const at = fractions((await h.send({ op: "displays" })).displays);
  await clickAt(target.x + 80, target.y + 12);
  assert.equal((await h.send({ op: "act", action: { type: "click", ...at(target.notes) } })).ok, true);
  assert.equal((await h.send({ op: "act", action: { type: "type", text: "pasted text", paste: true } })).ok, true);
  await until(() => target.log().includes("text pasted text"), "the paste arrives");
  await until(() => /\| text owner's text$/m.test(watched()), "the owner's text back");
  const formats = ["ExcludeClipboardContentFromMonitorProcessing", "CanIncludeInClipboardHistory", "CanUploadToCloudClipboard"];
  const lines = watched().split("\n").filter(Boolean);
  note({ paste: lines });
  const agent = lines.find((line) => line.endsWith("| text pasted text")), owner = lines.filter((line) => line.endsWith("| text owner's text")).at(-1);
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
  const target = await window(t, "chosen", "Reach chosen target", "FF8C00", [40, 40, 420, 300], "medium");
  const vault = await window(t, "vault2", "Password Manager", "1E50FF", [500, 40, 300, 220], "medium");
  const admin = await window(t, "admin", "Reach elevated target", "30A0A0", [500, 320, 300, 200]);
  const h = helper(t, { medium: true });
  const rules = rulesFor("apps", { apps: [{ id: target.exe, bundleId: "exe:chosen.exe", name: "chosen" }, { id: admin.exe, bundleId: "", name: "admin" }] });
  assert.equal((await h.send({ op: "rules", ...rules })).ok, true);
  const at = fractions((await h.send({ op: "displays" })).displays);
  await clickAt(target.x + 80, target.y + 12);
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
  await clickAt(admin.x + 80, admin.y + 12);
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
  const target = await window(t, "held", "Reach held target", "FF8C00", [40, 40, 520, 360], "medium");
  const h = helper(t, { medium: true });
  assert.equal((await h.send({ op: "rules", ...rulesFor("full") })).ok, true);
  const at = fractions((await h.send({ op: "displays" })).displays);
  await clickAt(target.x + 80, target.y + 12);
  const from = at([target.x + 300, target.y + 250]), to = at([target.x + 420, target.y + 300]);
  const drag = { type: "drag", x: from.x, y: from.y, toX: to.x, toY: to.y, holdMs: 5000 };
  const ups = (target.log().match(/^up /gm) || []).length;
  h.send({ op: "act", action: drag }).catch(() => {});
  await until(() => /^click /m.test(target.log()), "the button is down");
  const ended = Date.now();
  h.child.stdin.end();
  await until(() => (target.log().match(/^up /gm) || []).length > ups, "let go at the end of input", 1500);
  assert.equal((await exec(fixtureConsole, ["buttons"], { windowsHide: true })).stdout.trim(), "left up");
  await Promise.race([h.exited, sleep(1500)]);
  note({ release: { endedToUpMs: Date.now() - ended } });
  // Reach killed outright: its helper's watchdog lets go.
  const parent = spawn(process.execPath, [path.resolve("test/fixtures/windows/parent-node.mjs"), fixtureConsole, helperFile, JSON.stringify({ op: "rules", ...rulesFor("full") }), JSON.stringify(drag)],
    { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
  children.add(parent);
  let said = "";
  parent.stdout.on("data", (chunk) => { said += chunk; });
  await until(() => said.includes('"ok":true'), "the stand-in's helper is ready");
  const before = (target.log().match(/^up /gm) || []).length;
  await until(() => (target.log().match(/^click /gm) || []).length >= 2, "the button is down again");
  await exec(path.join(SYSTEM32, "taskkill.exe"), ["/F", "/PID", String(parent.pid)], { windowsHide: true });
  await until(() => (target.log().match(/^up /gm) || []).length > before, "let go when Reach was killed", 1500);
  assert.equal((await exec(fixtureConsole, ["buttons"], { windowsHide: true })).stdout.trim(), "left up");
});
