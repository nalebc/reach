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
  const rows = [["vendor.软件!App", "A name\twith\na new line"], ["{folder}\\a 'quoted' program.exe", "same name"]];
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
