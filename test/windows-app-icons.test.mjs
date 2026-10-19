import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readWindowsIcons } from "../server/app-icons.mjs";
import { createLogos } from "../server/agent-sessions/logos.mjs";
import { windowsBinary } from "../server/desktop-native.mjs";
import { readWindowsApps, readWindowsFileTypeIcons, openWindowsApp } from "../server/windows-shell-data.mjs";
import { launchApp } from "../server/platform.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// App icons and the agents' logos on Windows (parity audit #28): the image
// the shell draws for each app or program, from scripts/native/app-icons.cs,
// as a Mac reads its apps' icons.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
function helper(answer) {
  const seen = [];
  return {
    seen,
    build: async ({ dataDir }, kind) => path.win32.join(dataDir, `reach-${kind}-abc.exe`),
    spawn: (file, args) => {
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = () => {};
      let input = "";
      child.stdin.on("data", (chunk) => (input += chunk));
      child.stdin.on("finish", () => {
        seen.push({ file, args, lines: input.split("\n").slice(0, -1) });
        child.stdout.end(answer(input.split("\n").slice(0, -1)));
        setImmediate(() => child.emit("close", 0));
      });
      return child;
    },
  };
}

test("one helper run for many apps: a line each, in order; anything but a PNG is no icon", async () => {
  const fake = helper((targets) => targets.map((t, i) => (i === 1 ? "not a png" : PNG)).join("\r\n") + "\r\n");
  const icons = await readWindowsIcons(["Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\notepad.exe", "C:\\Tools\\x.exe"], { size: 64, dataDir: "C:\\r", ...fake });
  assert.deepEqual(icons, [`data:image/png;base64,${PNG}`, null, `data:image/png;base64,${PNG}`]);
  assert.equal(fake.seen[0].file, "C:\\r\\reach-app-icons-abc.exe");
  assert.deepEqual(fake.seen[0].args, ["64"]);
  // A line break inside an id can't add a line of its own.
  await readWindowsIcons(["a\nb"], { dataDir: "C:\\r", ...fake });
  assert.deepEqual(fake.seen[1].lines, ["a b"]);
  assert.deepEqual(await readWindowsIcons([], { dataDir: "C:\\r", ...fake }), []);
  assert.deepEqual(await readWindowsIcons(["x"], { dataDir: null, ...fake }), [null], "no data folder yet: no icons");
});

test("the agents' logos on Windows: their apps found by name in Start's list; a mark nobody installed stays unshown", async () => {
  let apps = [
    { id: "Claude_pzs8sxrjxfjjc!Claude", name: "Claude" },
    { id: "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", name: "Terminal" },
    { id: "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel", name: "Settings" },
  ];
  const asked = [];
  const logos = createLogos({ dataDir: "C:\\r", platform: "win32", listApps: async () => apps, readIcons: async (ids) => (asked.push(ids), ids.map(() => `data:image/png;base64,${PNG}`)) });
  const first = await logos();
  assert.deepEqual(Object.keys(first.logos).sort(), ["claude", "macos", "terminal"]);
  assert.deepEqual(asked[0], ["Claude_pzs8sxrjxfjjc!Claude", "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App", "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel"]);
  assert.deepEqual(await logos(), first, "kept a while");
  // Start's list unreadable: no logos, the phone shows the names.
  const none = createLogos({ dataDir: "C:\\r", platform: "win32", listApps: async () => { throw Error("no list"); }, readIcons: async () => [] });
  assert.deepEqual((await none()).logos, {});
  apps = [];
});

// Controlled subprocess boundary checks; these do not execute Windows APIs.
test("shell data uses the verified shared helper with unchanged operation deadlines and lossless IDs", async () => {
  const calls = [], builds = [];
  const rows = [["\uFEFFvendor.软件!App", "\uFEFFA name\twith\na new line"], ["{folder}\\a 'quoted' program.exe", "same name"]];
  const options = {
    dataDir: "C:\\private",
    build: async (config, kind) => { builds.push({ config, kind }); return "C:\\private\\reach-app-icons-123456789abc.exe"; },
    run: async (file, args, settings) => {
      calls.push({ file, args, settings });
      return { stdout: args[0] === "apps" ? rows.map(row => row.map(value => Buffer.from(value).toString("base64")).join("\t")).join("\r\n") + "\r\n" : PNG + "\n\n" };
    },
  };
  assert.deepEqual(await readWindowsApps(options), rows.map(([id, name]) => ({ id, name })));
  assert.deepEqual(await readWindowsFileTypeIcons(["folder", "txt"], options), [PNG, ""]);
  await openWindowsApp(rows[1][0], options);
  assert.deepEqual(calls.map(call => call.args), [["apps"], ["types", "folder", "txt"], ["open", rows[1][0]]]);
  assert.deepEqual(calls.map(call => call.settings.timeout), [12000, 20500, 12000]);
  assert.ok(calls.every(call => call.settings.windowsHide === true && call.file === "C:\\private\\reach-app-icons-123456789abc.exe"));
  assert.deepEqual(builds, Array.from({ length: 3 }, () => ({ config: { dataDir: "C:\\private" }, kind: "app-icons" })));
});

test("shell data refuses malformed output and preserves a failed launch without replaying it", async () => {
  const options = { dataDir: "C:\\private", build: async () => "owned.exe" };
  for (const stdout of ["not two fields\n", "YQ==\t====\n", "wA==\tYQ==\n", "\tYQ==\n", "YQ==\tAA==\n"])
    await assert.rejects(readWindowsApps({ ...options, run: async () => ({ stdout }) }));
  let calls = 0;
  const unknown = Object.assign(new Error("delivery unknown"), { signal: "SIGTERM", killed: true });
  await assert.rejects(openWindowsApp("an app ID", { ...options, run: async () => { calls++; throw unknown; } }), error => error === unknown);
  assert.equal(calls, 1, "a failed or unknown shell launch is never replayed");
  for (const invalid of [["../private"], ["a\0b"], Array(65).fill("txt")])
    await assert.rejects(readWindowsFileTypeIcons(invalid, { ...options, run: async () => { throw Error("must not run"); } }), /valid file icon types/);
});

test("app opening reauthorizes after a held build before any physical dispatch", async () => {
  for (const status of [401, 409, null]) {
    let prepared, release;
    const started = new Promise(resolve => { prepared = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const events = [];
    let refusal = null;
    const pending = openWindowsApp("an exact app ID", {
      dataDir: "C:\\private",
      build: async () => { events.push("preparing"); prepared(); await held; events.push("prepared"); return "owned.exe"; },
      authorize: () => { events.push("authorize"); if (refusal) throw refusal; },
      run: async (file, args) => { events.push("dispatch"); assert.equal(file, "owned.exe"); assert.deepEqual(args, ["open", "an exact app ID"]); return { stdout: "" }; },
    });
    await started;
    assert.deepEqual(events, ["preparing"], "a held build cannot dispatch or satisfy the final authorization");
    if (status) refusal = Object.assign(new Error(status === 401 ? "revoked" : "paused"), { status });
    release();
    if (refusal) await assert.rejects(pending, error => error === refusal);
    else await pending;
    assert.deepEqual(events, ["preparing", "prepared", "authorize", ...(status ? [] : ["dispatch"])], "denial makes no launch; success dispatches exactly once");
  }
});

test("Mac app launching checks current access after catalog discovery and keeps exact IDs", async () => {
  const app = { id: "/Applications/Fixture.app", name: "Fixture" };
  let release, listed;
  const ready = new Promise(resolve => { listed = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let refusal = null, calls = 0;
  const options = { platform: "darwin", listApps: async () => { listed(); await held; return [app]; },
    authorize: () => { if (refusal) throw refusal; }, run: async () => { calls++; } };
  const pending = launchApp(app.id, options);
  await ready;
  refusal = Object.assign(new Error("revoked during discovery"), { status: 401 });
  release();
  await assert.rejects(pending, error => error === refusal);
  assert.equal(calls, 0);
  refusal = null;
  await assert.rejects(launchApp(app.id + " ", options), error => error.status === 404);
  assert.equal(calls, 0, "an ID absent from the catalog cannot dispatch");
  assert.deepEqual(await launchApp(app.id, options), { name: app.name });
  assert.equal(calls, 1);
});

test("on a real Windows PC: Notepad's icon and a Start app's, drawn by Windows; nothing for what isn't there", { skip: process.platform !== "win32", timeout: 180000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-icons-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const actual = promisify(execFile);
  const catalog = await readWindowsApps({ dataDir,
    build: async (...args) => {
      const at = performance.now();
      try { return await windowsBinary(...args); }
      finally { t.diagnostic(`cold shell helper build on ${process.arch}: ${Math.round(performance.now() - at)} ms`); }
    },
    run: async (...args) => {
      const at = performance.now();
      try { return await actual(...args); }
      finally { t.diagnostic(`first native app catalog on ${process.arch}: ${Math.round(performance.now() - at)} ms`); }
    },
  });
  assert.ok(catalog.length >= 5, "the cold native catalog is populated, without a PowerShell warm-up");
  // PowerShell is an independent oracle after the real cold native call.
  // Require every Start identity and display name, not a substitute catalog.
  const source = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"], { encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 }) || "[]");
  const startApps = Array.isArray(source) ? source : [source];
  const entries = list => list.map(app => [app.id, app.name]).sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  assert.deepEqual(entries(catalog), entries(startApps.map(app => ({ id: app.AppID, name: app.Name }))), "native AppsFolder preserves Get-StartApps identities and names");
  const start = startApps[0];
  const notepad = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "notepad.exe");
  const targets = [notepad, ...(start?.AppID ? [start.AppID] : []), "C:\\nowhere\\missing.exe"];
  const icons = await readWindowsIcons(targets, { size: 64, dataDir });
  const size = (url) => {
    const png = Buffer.from(url.slice("data:image/png;base64,".length), "base64");
    return [png.readUInt32BE(16), png.readUInt32BE(20)];
  };
  assert.ok(icons[0], "Notepad's icon");
  assert.deepEqual(size(icons[0]), [64, 64]);
  if (start?.AppID) {
    assert.ok(icons[1], `${start.Name}'s icon (${start.AppID})`);
    assert.deepEqual(size(icons[1]), [64, 64]);
  } else t.diagnostic("Start lists no apps on this runner");
  assert.equal(icons.at(-1), null, "no file, no icon");
});

// Real HTTP authorization with controlled catalog/build/dispatch boundaries;
// no Windows APIs or desktop actions run in these cases.
test("HTTP app launch honors revocation and pause during native preparation", async t => {
  for (const mode of ["revoked", "paused", "allowed"]) await t.test(mode, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-app-launch-"));
    let prepared, release, calls = 0;
    const started = new Promise(resolve => { prepared = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const app = { id: "fixture.vendor!App", name: "Fixture" };
    const reach = await createReach({ roots: [dir], dataDir: path.join(dir, "private"), appPlatform: "linux",
      sweepScreenHelpers: () => {},
      appLaunch: (id, options) => launchApp(id, { ...options, platform: "win32", listApps: async () => [app], windows: {
        dataDir: dir, build: async () => { prepared(); await held; return "owned.exe"; },
        run: async (_file, args) => { assert.deepEqual(args, ["open", app.id]); calls++; return { stdout: "" }; },
      } }),
    });
    t.after(async () => { release(); await reach.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
    await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${reach.server.address().port}`;
    const owner = reach.auth.issue("owner", ALL_SCOPES), requester = reach.auth.issue("phone", ALL_SCOPES);
    const call = (route, token, method, body) => fetch(base + route, { method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const pending = call("/api/apps/launch", requester.token, "POST", { id: app.id });
    await started;
    assert.equal(calls, 0);
    if (mode === "revoked") assert.equal((await call(`/api/clients/${requester.clientId}`, owner.token, "DELETE")).status, 200);
    if (mode === "paused") assert.equal((await call("/api/settings/pause", owner.token, "POST", { paused: true })).status, 200);
    release();
    const response = await pending;
    assert.equal(response.status, mode === "revoked" ? 401 : mode === "paused" ? 423 : 200);
    const body = await response.json();
    if (mode === "allowed") assert.deepEqual(body, { name: app.name });
    assert.equal(calls, mode === "allowed" ? 1 : 0, "only a still-authorized, unpaused request dispatches once");
  });
});

test("HTTP app launch limits each approved credential before controlled dispatch", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-app-launch-limit-"));
  let dispatches = 0;
  const reach = await createReach({ roots: [dir], dataDir: path.join(dir, "private"), appPlatform: "linux",
    appLaunch: async (id, { authorize }) => { authorize(); assert.equal(id, "fixture.vendor!App"); dispatches++; return { name: "Fixture" }; },
  });
  t.after(async () => { await reach.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${reach.server.address().port}/api/apps/launch`;
  const first = reach.auth.issue("first phone", ALL_SCOPES), second = reach.auth.issue("second phone", ALL_SCOPES);
  const call = (token, index) => fetch(url, { method: "POST", headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json",
    "X-Forwarded-For": `100.64.0.${index}`, "X-Real-IP": `192.0.2.${index}`, Forwarded: `for=192.0.2.${index}`,
  }, body: JSON.stringify({ id: "fixture.vendor!App" }) });
  for (let index = 1; index <= 35; index++) {
    const response = await call(index % 2 ? "invalid credential" : "", index);
    assert.equal(response.status, 401, "authentication runs before allocating a launch budget");
    assert.equal(response.headers.get("ratelimit"), null);
    await response.json();
  }
  assert.equal(dispatches, 0, "unauthenticated requests never reach even the controlled dispatcher");
  for (const [position, credential] of [first, second].entries()) {
    for (let index = 1; index <= 30; index++) {
      const response = await call(credential.token, index);
      assert.equal(response.status, 200, "each approved credential has its own full budget despite prior unauthenticated traffic");
      assert.deepEqual(await response.json(), { name: "Fixture" });
    }
    const before = dispatches;
    for (const spoofedAddress of [31, 99]) {
      const response = await call(credential.token, spoofedAddress);
      assert.equal(response.status, 429, "changing forwarded/IP headers cannot reset the credential's exhausted budget");
      assert.match(response.headers.get("content-type") || "", /application\/json/);
      assert.deepEqual(await response.json(), { error: "Too many app launch requests. Try again in one minute." });
      assert.match(response.headers.get("retry-after") || "", /^\d+$/);
      assert.ok(Number(response.headers.get("retry-after")) >= 1 && Number(response.headers.get("retry-after")) <= 60);
      assert.match(response.headers.get("ratelimit") || "", /app-launch.*r=0/);
      assert.match(response.headers.get("ratelimit-policy") || "", /app-launch/);
    }
    assert.equal(dispatches, before, "over-budget requests do not dispatch");
    assert.equal(dispatches, (position + 1) * 30, "the second approved credential gets a separate budget");
  }
});
