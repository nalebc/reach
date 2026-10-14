import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { readWindowsIcons } from "../server/app-icons.mjs";
import { createLogos } from "../server/agent-sessions/logos.mjs";

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

test("on a real Windows PC: Notepad's icon and a Start app's, drawn by Windows; nothing for what isn't there", { skip: process.platform !== "win32", timeout: 180000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-icons-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const start = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-StartApps | Select-Object -First 1 Name,AppID | ConvertTo-Json -Compress"], { encoding: "utf8" }) || "null");
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
