import test from "node:test";
import assert from "node:assert/strict";
import { createAgentDesktop } from "../server/agent-desktop.mjs";
import { presetScopes } from "../server/agent-presets.mjs";

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
    platform, available: () => true, home, verifyClient: () => client,
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
