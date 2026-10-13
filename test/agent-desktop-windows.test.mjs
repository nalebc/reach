import test from "node:test";
import assert from "node:assert/strict";
import { createAgentDesktop, normalizeAction, windowsAction, windowsModifiers } from "../server/agent-desktop.mjs";
import { presetScopes } from "../server/agent-presets.mjs";
import { createAgentPauses } from "../server/agent-pauses.mjs";

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
