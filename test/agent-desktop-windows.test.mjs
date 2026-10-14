import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AgentDesktopHelper, createAgentDesktop, normalizeAction, windowsAction, windowsModifiers } from "../server/agent-desktop.mjs";
import { presetScopes } from "../server/agent-presets.mjs";
import { createAgentPauses } from "../server/agent-pauses.mjs";
import { nativeRules } from "../server/agent-guard.mjs";

// The desktop service's own checks with Windows' names for apps, files and
// keys (docs/WINDOWS_AGENT_PARITY.md, workstream A), against a stand-in for
// the native helper: nothing here touches this computer. Every case runs as
// Windows (platform: "win32") and as a Mac, which must not change.
const chromeExe = String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`;
const edgeExe = String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;
const calculator = "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App";
function world(platform, { preset = "full" } = {}) {
  const home = platform === "win32" ? String.raw`C:\Users\me` : "/Users/me";
  const policy = { invite: true, browser: true, preset, roots: [home] };
  const client = { id: "muse", kind: "agent", name: "Muse", expiresAt: Date.now() + 600000, policy, scopes: presetScopes(policy) };
  const requests = [];
  const desktop = createAgentDesktop({ screen: true }, {
    platform, available: () => true, home, verifyClient: () => client, pauses: createAgentPauses(),
    protectedPaths: () => [platform === "win32" ? String.raw`C:\Users\me\.reach` : "/Users/me/.reach"],
    spawnHelper: async () => ({ async send(request, beforeSend) { beforeSend?.(); requests.push(request); return { ok: true, app: "App", bundle: "" }; }, stop() {} }),
  });
  return { desktop, client, authorize: () => client, requests };
}
const rejects = (promise, status, pattern) => assert.rejects(promise, (error) => error.status === status && pattern.test(error.message));

test("on Windows an agent opens an .exe by its path or a Store app by its id; never a Mac path", async (t) => {
  const w = world("win32");
  t.after(() => w.desktop.close());
  for (const app of [chromeExe, calculator]) {
    await w.desktop.open(w.client, app, w.authorize);
    assert.deepEqual(w.requests.at(-1), { op: "open", app });
  }
  await w.desktop.openUrl(w.client, "https://example.com/", edgeExe, w.authorize);
  assert.deepEqual(w.requests.at(-1), { op: "open-url", url: "https://example.com/", app: edgeExe });
  const before = w.requests.length;
  for (const app of ["/Applications/Google Chrome.app", String.raw`C:\PROGRA~1\Google\Chrome\Application\chrome.exe`, String.raw`\\server\share\app.exe`,
    String.raw`C:\Tools\app.exe:stream`, String.raw`C:\Tools\script.ps1`, "Chrome", 7])
    await rejects(w.desktop.open(w.client, app, w.authorize), 400, /Choose an app/);
  await rejects(w.desktop.openUrl(w.client, "https://example.com/", "/Applications/Safari.app", w.authorize), 400, /Choose the browser/);
  assert.equal(w.requests.length, before, "nothing refused reached the helper");
});

test("on a Mac the same Windows names are refused, and Mac paths still open", async (t) => {
  const w = world("darwin");
  t.after(() => w.desktop.close());
  for (const app of [chromeExe, calculator]) await rejects(w.desktop.open(w.client, app, w.authorize), 400, /Choose an app/);
  await rejects(w.desktop.openUrl(w.client, "https://example.com/", edgeExe, w.authorize), 400, /Choose the browser/);
  await rejects(w.desktop.openFile(w.client, String.raw`C:\Users\me\Documents\notes.txt`, {}, w.authorize), 400, /full path/);
  await w.desktop.open(w.client, "/Applications/Google Chrome.app", w.authorize);
  await w.desktop.openFile(w.client, "/Users/me/Documents/notes.txt", {}, w.authorize);
  assert.deepEqual(w.requests.map((request) => request.op), ["open", "open-file"]);
});

test("on Windows an agent opens a file by its drive-letter path; protected files stay closed whatever their case", async (t) => {
  const w = world("win32", { preset: "readonly" });
  t.after(() => w.desktop.close());
  // Read only can't open; Apps and Full control can. Apps keeps protected paths.
  await rejects(w.desktop.openFile(w.client, String.raw`C:\Users\me\Documents\notes.txt`, {}, w.authorize), 403, /changed or ended/);
  const apps = world("win32", { preset: "apps" });
  apps.client.policy.apps = [{ id: chromeExe, name: "Google Chrome", bundleId: "" }];
  apps.client.policy.roots = [];
  apps.client.scopes = presetScopes(apps.client.policy);
  t.after(() => apps.desktop.close());
  await apps.desktop.openFile(apps.client, String.raw`C:\Users\me\Documents\notes.txt`, { reveal: true }, apps.authorize);
  assert.deepEqual(apps.requests.at(-1), { op: "open-file", path: String.raw`C:\Users\me\Documents\notes.txt`, reveal: true });
  for (const file of [String.raw`C:\Users\me\.reach\clients.json`, String.raw`c:\users\ME\.Reach\clients.json`, String.raw`C:\Users\me\.ssh\id_rsa`])
    await rejects(apps.desktop.openFile(apps.client, file, {}, apps.authorize), 403, /passwords, keys or Reach/);
  for (const file of ["/Users/me/Documents/notes.txt", "notes.txt", String.raw`\\nas\share\notes.txt`, String.raw`C:\Users\me\SSH~1\id_rsa`, String.raw`C:\Users\me\notes.txt:hidden`])
    await rejects(apps.desktop.openFile(apps.client, file, {}, apps.authorize), 400, /full path/);
  assert.equal(apps.requests.filter((request) => request.op === "open-file").length, 1);
});

test("on Windows, programs and scripts are refused before the helper for Apps; Full control may open them; a Mac leaves it to its helper", async (t) => {
  const apps = world("win32", { preset: "apps" });
  apps.client.policy.apps = [{ id: chromeExe, name: "Google Chrome", bundleId: "" }];
  apps.client.policy.roots = [];
  apps.client.scopes = presetScopes(apps.client.policy);
  t.after(() => apps.desktop.close());
  for (const file of ["setup.exe", "run.BAT", "build.cmd", "script.ps1", "macro.vbs", "tool.js", "page.hta", "shortcut.lnk", "site.url", "keys.reg", "install.msi",
    "console.msc", "panel.cpl", "saver.scr", "page.settingcontent-ms", "app.appref-ms", "Report.pdf.exe", "disk.iso"])
    for (const reveal of [false, true])
      await rejects(apps.desktop.openFile(apps.client, "C:\\Users\\me\\Downloads\\" + file, { reveal }, apps.authorize), 403, /run as a program/);
  assert.equal(apps.requests.filter((request) => request.op === "open-file").length, 0, "nothing refused reached the helper");
  await apps.desktop.openFile(apps.client, String.raw`C:\Users\me\Downloads\Report.pdf`, {}, apps.authorize);
  await apps.desktop.openFile(apps.client, String.raw`C:\Users\me\Downloads\notes`, {}, apps.authorize);
  assert.equal(apps.requests.filter((request) => request.op === "open-file").length, 2);
  const full = world("win32", { preset: "full" });
  t.after(() => full.desktop.close());
  await full.desktop.openFile(full.client, String.raw`C:\Users\me\Downloads\setup.exe`, {}, full.authorize);
  assert.deepEqual(full.requests.at(-1), { op: "open-file", path: String.raw`C:\Users\me\Downloads\setup.exe` });
  // A Mac's helper refuses programs itself (agent-desktop.swift); its requests are unchanged.
  const mac = world("darwin", { preset: "apps" });
  mac.client.policy.apps = [{ id: "/Applications/Google Chrome.app", name: "Google Chrome", bundleId: "com.google.Chrome" }];
  mac.client.policy.roots = [];
  mac.client.scopes = presetScopes(mac.client.policy);
  t.after(() => mac.desktop.close());
  await mac.desktop.openFile(mac.client, "/Users/me/Downloads/setup.exe", {}, mac.authorize);
  assert.deepEqual(mac.requests.at(-1), { op: "open-file", path: "/Users/me/Downloads/setup.exe" });
});

test("Mac modifier names become Windows keys in one place: cmd and control are Ctrl, option is Alt", () => {
  for (const [mac, windows] of [["cmd", "ctrl"], ["command", "ctrl"], ["meta", "ctrl"], ["control", "ctrl"], ["ctrl", "ctrl"], ["option", "alt"], ["alt", "alt"], ["shift", "shift"]])
    assert.deepEqual(windowsModifiers([mac]), [windows], mac);
  // Each key once, in Windows' order, whatever order or names they came in.
  assert.deepEqual(windowsModifiers(["shift", "cmd", "control", "option"]), ["ctrl", "alt", "shift"]);
  assert.deepEqual(windowsModifiers(["cmd", "ctrl", "meta"]), ["ctrl"]);
  assert.deepEqual(windowsModifiers([]), []);
  // Every name normalizeAction lets through has a Windows key.
  const accepted = normalizeAction({ type: "key", key: "a", modifiers: ["cmd", "command", "meta", "shift"] }).modifiers;
  assert.deepEqual(windowsModifiers(accepted), ["ctrl", "shift"]);
  // Unknown names are refused, never dropped: a dropped one would send a different shortcut.
  for (const bad of [["win"], ["fn"], ["cmd", "super"], ["Cmd"], [1], "cmd", undefined])
    assert.throws(() => windowsModifiers(bad), (error) => error.status === 400, JSON.stringify(bad));
  assert.deepEqual(windowsAction({ type: "move", x: 0.5, y: 0.5 }), { type: "move", x: 0.5, y: 0.5 }, "an action without modifiers is unchanged");
});

test("on Windows the helper receives Windows modifiers; on a Mac, the agent's names as before", async (t) => {
  for (const platform of ["win32", "darwin"]) {
    const w = world(platform);
    t.after(() => w.desktop.close());
    await w.desktop.act(w.client, { type: "key", key: "c", modifiers: ["cmd"] }, w.authorize);
    await w.desktop.act(w.client, { type: "click", x: 0.2, y: 0.4, modifiers: ["option", "shift", "control", "cmd"] }, w.authorize);
    await w.desktop.act(w.client, { type: "scroll", x: 0.5, y: 0.5, dy: 120 }, w.authorize);
    const sent = w.requests.filter((request) => request.op === "act").map((request) => request.action);
    assert.deepEqual(sent.map((action) => action.modifiers), platform === "win32"
      ? [["ctrl"], ["ctrl", "alt", "shift"], undefined]
      : [["cmd"], ["option", "shift", "control", "cmd"], undefined], platform);
    assert.deepEqual(sent[1], { type: "click", x: 0.2, y: 0.4, button: "left", count: 1, modifiers: platform === "win32" ? ["ctrl", "alt", "shift"] : ["option", "shift", "control", "cmd"] });
  }
});

// The Windows helper's own start (docs/parity/B-desktop-helper.md §12): how
// it's built and started, what it's told, and how a PC that won't run it is
// answered, against a stand-in process. Nothing is built or run.
const helperFile = String.raw`C:\Users\me\.reach\reach-agent-desktop-0123456789ab.exe`;
const ready = (mode, extra = {}) => ({ ok: true, accessibility: true, screen: true, mode, elevated: false, desktop: "Default", reachConsole: "classic", ...extra });
function windowsHelperWorld(t, { replies = {}, preset = "apps", sac = 0, blocked = false, exit = false, missing = false, binary } = {}) {
  const home = String.raw`C:\Users\me`;
  const policy = { invite: true, browser: true, preset, roots: [], apps: preset === "apps" ? [{ id: chromeExe, name: "Google Chrome", bundleId: "" }] : [] };
  const client = { id: "muse", kind: "agent", name: "Muse", expiresAt: Date.now() + 600000, policy, scopes: presetScopes(policy) };
  const spawned = [], builds = [], policyReads = [];
  const answers = { rules: (request) => ready(request.mode), front: () => ({ ok: true, app: "Notepad", bundle: "exe:notepad.exe", title: "", terminalLike: false, secure: false, blocked: "", path: "", layout: "" }), ...replies };
  const spawnProcess = (file, args, options) => {
    const child = new EventEmitter();
    child.exitCode = null; child.signalCode = null;
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    const writes = [];
    child.stdin.write = (line) => {
      const request = JSON.parse(line);
      writes.push(request);
      const answer = answers[request.op]?.(request);
      if (answer !== undefined) queueMicrotask(() => child.stdout.emit("data", Buffer.from(JSON.stringify(answer) + "\n")));
      return true;
    };
    child.stdin.end = () => { child.ended = true; };
    child.kill = (signal) => { child.signalCode = signal; child.emit("exit", null, signal); return true; };
    spawned.push({ file, args, options, child, writes });
    if (missing) {
      // Windows found no file to run: it never had a process.
      queueMicrotask(() => child.emit("error", Object.assign(Error("spawn ENOENT"), { code: "ENOENT", syscall: "spawn" })));
    } else {
      child.pid = 7000 + spawned.length;
      if (exit) queueMicrotask(() => { child.exitCode = 1; child.emit("exit", 1, null); });
    }
    return child;
  };
  const desktop = createAgentDesktop({ screen: true, dataDir: String.raw`C:\Users\me\.reach` }, {
    platform: "win32", available: () => true, home, verifyClient: () => client, pauses: createAgentPauses(),
    helperBinary: async (config, kind) => { builds.push(kind); return binary ?? helperFile; }, spawnProcess,
    launch: { smartAppControl: async () => sac, blockedByPolicy: async (file) => { policyReads.push(file); return blocked; } },
    env: { SystemRoot: String.raw`C:\Windows`, ProgramFiles: String.raw`C:\Program Files`, ComSpec: String.raw`C:\Windows\system32\cmd.exe`, COR_ENABLE_PROFILING: "1", COMPlus_x: "1", DOTNET_x: "1", REACH_TOKEN: "secret" },
    processId: 4242, consoleAttached: () => true,
  });
  t.after(() => desktop.close());
  return { desktop, client, authorize: () => client, spawned, builds, policyReads };
}

test("a Windows helper is built here, started detached with Reach's process and Windows' own environment, and told the rules alone", async (t) => {
  const w = windowsHelperWorld(t);
  await w.desktop.front(w.client, w.authorize);
  assert.deepEqual(w.builds, ["agent-desktop"]);
  assert.equal(w.spawned.length, 1);
  const { file, args, options, writes } = w.spawned[0];
  assert.equal(file, helperFile);
  assert.deepEqual(args, ["--reach-pid", "4242", "--reach-console", "1"]);
  assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(options.detached, true, "outside Node's kill-on-close job, so it lets go of a held button");
  assert.equal(options.windowsHide, true);
  assert.equal(options.shell, undefined);
  assert.equal(options.env.PATH, String.raw`C:\Windows\System32;C:\Windows`);
  assert.equal(options.env.ProgramFiles, String.raw`C:\Program Files`);
  assert.equal(options.env.ComSpec, String.raw`C:\Windows\system32\cmd.exe`);
  for (const key of Object.keys(options.env)) assert.doesNotMatch(key, /^(COR_|COMPlus_|DOTNET_|REACH)/i, key);
  // The rules exactly as the guard writes them, then the request.
  const expected = nativeRules(w.client.policy, { hosts: [], titles: ["reach"], protectedPaths: [], home: String.raw`C:\Users\me`, platform: "win32" });
  assert.equal(JSON.stringify(writes[0]), JSON.stringify({ op: "rules", ...expected }));
  assert.deepEqual(writes.slice(1).map((request) => request.op), ["front"]);
});

test("a Windows helper that can't act for an agent says why: Reach elevated, a secure desktop, no UI Automation, no screen", async (t) => {
  const cases = [
    [{ elevated: true }, 503, /running as administrator \(or User Account Control is off\)\. Agents act only from a standard Reach session\./, "blocked"],
    [{ desktop: "Winlogon" }, 409, /administrator prompt, the lock screen or the sign-in screen is up on the PC/, "paused"],
    [{ desktop: "" }, 409, /administrator prompt/, "paused"],
    [{ accessibility: false }, 503, /^Windows UI Automation isn't available to Reach on this PC\.$/, undefined],
    [{ screen: false }, 503, /^Windows won't let Reach see the screen right now\. Keep the PC signed in and unlocked\.$/, undefined],
  ];
  for (const [answer, status, message, kind] of cases) {
    const w = windowsHelperWorld(t, { replies: { rules: (request) => ready(request.mode, answer) } });
    await assert.rejects(w.desktop.front(w.client, w.authorize), (error) => error.status === status && message.test(error.message) && error.kind === kind, JSON.stringify(answer));
    assert.equal(w.spawned[0].child.ended, true, "that helper is stopped");
  }
  // Looking only (Read only): an elevated Reach or no UI Automation still shows the screen.
  for (const answer of [{ elevated: true }, { accessibility: false }]) {
    const w = windowsHelperWorld(t, { preset: "readonly", replies: { rules: (request) => ready(request.mode, answer) } });
    await w.desktop.front(w.client, w.authorize);
  }
  // A refusal from the helper itself is passed on.
  const w = windowsHelperWorld(t, { replies: { rules: () => ({ error: "This version of Windows changed how window titles are read. Reach can't check windows here yet.", kind: "unavailable" }) } });
  await assert.rejects(w.desktop.front(w.client, w.authorize), (error) => error.status === 503 && /window titles/.test(error.message));
});

test("a PC that won't run the helper Reach built is told why, from Smart App Control and Windows' own logs", async (t) => {
  // Smart App Control on: nothing is built.
  const sac = windowsHelperWorld(t, { sac: 1 });
  await assert.rejects(sac.desktop.front(sac.client, sac.authorize), (error) => error.status === 503 && error.permanent === true && /Smart App Control on this PC only runs signed programs/.test(error.message));
  assert.deepEqual(sac.builds, []);
  for (const state of [0, 2, null]) {
    const ok = windowsHelperWorld(t, { sac: state });
    await ok.desktop.front(ok.client, ok.authorize);
  }
  // It ended before answering: Windows' logs name it, or they don't.
  const blocked = windowsHelperWorld(t, { exit: true, blocked: true });
  await assert.rejects(blocked.desktop.front(blocked.client, blocked.authorize), (error) => error.status === 503 && error.permanent === true && /application control on this PC/.test(error.message));
  assert.deepEqual(blocked.policyReads, [helperFile]);
  const stopped = windowsHelperWorld(t, { exit: true });
  await assert.rejects(stopped.desktop.front(stopped.client, stopped.authorize), (error) => error.status === 503 && !error.permanent && /^The Windows PC's agent helper stopped before it was ready\.$/.test(error.message));
  // Removed after its build (an antivirus): built again once in this run, then the reason.
  const gone = windowsHelperWorld(t, { missing: true, binary: String.raw`C:\no such folder\reach-agent-desktop-0123456789ab.exe` });
  await assert.rejects(gone.desktop.front(gone.client, gone.authorize), (error) => error.status === 503 && error.permanent === true && /Windows security removed Reach's agent helper/.test(error.message));
  assert.deepEqual(gone.builds, ["agent-desktop", "agent-desktop"]);
  assert.equal(gone.spawned.length, 2);
});

test("a Windows helper's first answer may take a cold start; it then answers within the usual time, and is given 1.5 s to let go when stopped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new EventEmitter(), writes = [], kills = [];
  child.pid = 99; child.exitCode = null; child.signalCode = null;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
  child.stdin.write = (line) => { writes.push(JSON.parse(line)); return true; };
  child.stdin.end = () => {};
  child.kill = (signal) => { kills.push(signal); return true; };
  const helper = new AgentDesktopHelper(child, { platform: "win32", coldStartMs: 60000 });
  const first = helper.send({ op: "rules" });
  t.mock.timers.tick(59000);
  child.stdout.emit("data", Buffer.from('{"ok":true}\n'));
  assert.deepEqual(await first, { ok: true });
  const second = helper.send({ op: "front" }).then(() => assert.fail("no answer"), (error) => error);
  t.mock.timers.tick(15000);
  const failure = await second;
  assert.equal(failure.helperReason, "timeout");
  assert.match(failure.message, /^The Windows PC's agent helper did not answer in time during front\./);
  // Stopped: its input ends at once, the process is ended only after 1.5 s.
  t.mock.timers.tick(1499);
  assert.deepEqual(kills, []);
  t.mock.timers.tick(1);
  assert.deepEqual(kills, ["SIGTERM"]);
  // A Mac's helper: 300 ms, and the Mac's words.
  const mac = new EventEmitter(), macKills = [];
  mac.pid = 100; mac.exitCode = null; mac.signalCode = null;
  mac.stdout = new EventEmitter(); mac.stderr = new EventEmitter(); mac.stdin = new EventEmitter();
  mac.stdin.write = () => true; mac.stdin.end = () => {};
  mac.kill = (signal) => { macKills.push(signal); return true; };
  const macHelper = new AgentDesktopHelper(mac, { platform: "darwin" });
  const late = macHelper.send({ op: "shot" }).then(() => assert.fail("no answer"), (error) => error);
  t.mock.timers.tick(15000);
  assert.match((await late).message, /^The Mac's agent helper did not answer in time during shot\./);
  t.mock.timers.tick(300);
  assert.deepEqual(macKills, ["SIGTERM"]);
});

test("a Windows PC's desktop says it isn't available unless told: presets open there with the sandbox", () => {
  const options = { pauses: createAgentPauses(), spawnHelper: async () => assert.fail("never started") };
  assert.equal(createAgentDesktop({ screen: true }, { ...options, platform: "win32" }).available(), false);
  assert.equal(createAgentDesktop({ screen: true }, { ...options, platform: "darwin" }).available(), true);
  assert.equal(createAgentDesktop({ screen: false }, { ...options, platform: "darwin" }).available(), false);
});
