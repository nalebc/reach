import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// Oct 11: a first Windows user's live screen never loaded and nothing had
// ever run Reach's real Windows screen and input end to end. On a real
// Windows runner (after the CI step sets a normal PC's script policy), this
// starts Reach with its real helpers, watches the screen through the same
// socket a phone uses, takes control, clicks into a window and types into
// it, then checks the window got exactly that; and that Pause ends it all and
// nothing is left running. Elsewhere, or without REACH_TEST_WINDOWS_DESKTOP,
// it's skipped.
const run = process.platform === "win32" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1";
const exec = promisify(execFile);
const until = async (check, what, ms = 60000) => {
  for (const end = Date.now() + ms; !(await check()); ) {
    if (Date.now() > end) throw Error(`timed out waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const report = {};
const note = (values) => {
  Object.assign(report, values);
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/windows-desktop-e2e.json", JSON.stringify(report, null, 2));
};
// A small window that writes down what reaches it: where it was clicked and
// the text in its box. A button holds the focus first, so text lands in the
// box only if Reach's click put it there.
const TARGET = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices;
public class ReachTargetDpi { [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v); }
'@
[ReachTargetDpi]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$out = $env:REACH_TARGET_OUT
$f = New-Object System.Windows.Forms.Form
$f.Text = 'Reach input target'; $f.TopMost = $true; $f.StartPosition = 'Manual'
$f.Left = 160; $f.Top = 160; $f.Width = 700; $f.Height = 320; $f.BackColor = 'DarkOrange'
$b = New-Object System.Windows.Forms.Button
$b.Text = 'Focus starts here'; $b.Left = 20; $b.Top = 200; $b.Width = 300; $b.Height = 50
$t = New-Object System.Windows.Forms.TextBox
$t.Left = 20; $t.Top = 30; $t.Width = 640; $t.Font = New-Object System.Drawing.Font('Segoe UI', 20)
$f.Controls.Add($b); $f.Controls.Add($t)
$t.Add_MouseDown({ [IO.File]::WriteAllText("$out.click", 'clicked') })
$t.Add_TextChanged({ [IO.File]::WriteAllText("$out.text", $t.Text) })
$f.Add_Shown({
  $f.ActiveControl = $b
  $p = $t.PointToScreen((New-Object System.Drawing.Point([int]($t.Width / 2), [int]($t.Height / 2))))
  [IO.File]::WriteAllText("$out.ready", "$($p.X),$($p.Y)")
})
[System.Windows.Forms.Application]::Run($f)
`;
const encoded = (script) => Buffer.from(script, "utf16le").toString("base64");

test("Windows: the live screen streams, a click and typing reach a window, and Pause ends it all", { skip: !run, timeout: 300000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-windows-e2e-"));
  const out = path.join(dir, "target");
  const target = spawn("powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", encoded(TARGET)], {
    env: { ...process.env, REACH_TARGET_OUT: out },
    stdio: "ignore",
  });
  t.after(() => target.kill());
  await until(() => fs.existsSync(`${out}.ready`), "the target window");
  const [boxX, boxY] = fs.readFileSync(`${out}.ready`, "utf8").split(",").map(Number);
  note({ box: { x: boxX, y: boxY } });

  const reach = await createReach({ roots: [dir], dataDir: path.join(dir, "private"), screen: true });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.terminate();
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const call = (route, { method = "GET", body } = {}) =>
    fetch(url + route, {
      method,
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const socket = async (route, auth) => {
    const ws = new WebSocket(url.replace("http:", "ws:") + route);
    sockets.push(ws);
    const messages = [];
    ws.on("error", () => {});
    ws.on("message", (b, binary) => messages.push(binary ? b : JSON.parse(b)));
    await once(ws, "open");
    ws.send(JSON.stringify({ type: "auth", token: owner.token, ...auth }));
    return { ws, messages };
  };

  // The displays, as the phone's display picker gets them.
  let started = Date.now();
  const listed = await call("/api/screen/displays");
  assert.equal(listed.status, 200, JSON.stringify(listed.body));
  const displays = listed.body.displays || listed.body;
  const primary = displays.find((d) => d.primary) || displays[0];
  note({ displays, listMs: Date.now() - started });

  // The live screen, as a phone watches it: frames keep coming.
  started = Date.now();
  const screen = await socket("/ws/screen", { protocol: 2, display: "primary", format: "jpeg", quality: "saver" });
  const frames = () => screen.messages.filter((m) => Buffer.isBuffer(m));
  await until(() => frames().length >= 1 || screen.messages.some((m) => m.type === "error"), "the first frame", 120000);
  assert.equal(screen.messages.find((m) => m.type === "error"), undefined, JSON.stringify(screen.messages.filter((m) => !Buffer.isBuffer(m))));
  const firstFrameMs = Date.now() - started;
  // Each frame is acknowledged, as the phone does, so more are sent.
  const acked = new Set();
  const ack = setInterval(() => {
    frames().forEach((frame) => {
      const id = frame.readUInt32BE(0);
      if (acked.has(id)) return;
      acked.add(id);
      screen.ws.send(JSON.stringify({ type: "ack", id }));
    });
  }, 50);
  t.after(() => clearInterval(ack));
  await until(() => frames().length >= 3, "more frames", 60000);
  const first = frames()[0].subarray(4);
  assert.deepEqual([...first.subarray(0, 2)], [0xff, 0xd8], "a JPEG");
  note({ firstFrameMs, frames: frames().length, frameBytes: first.length });

  // Control, as the phone takes it, then a click on the box and typing.
  assert.equal((await call("/api/screen/control", { method: "POST", body: { enabled: true } })).status, 200);
  const input = await socket("/ws/screen-input", { display: primary.id });
  await until(() => input.messages.some((m) => m.type === "ready" || m.type === "error"), "control", 60000);
  assert.ok(input.messages.some((m) => m.type === "ready"), JSON.stringify(input.messages));
  let id = 0;
  const send = async (action) => {
    const n = ++id;
    input.ws.send(JSON.stringify({ type: "input", id: n, action }));
    await until(() => input.messages.some((m) => (m.type === "ack" || m.type === "error") && m.id === n), `input ${action.type}`, 30000);
    const answer = input.messages.find((m) => m.id === n);
    assert.equal(answer.type, "ack", JSON.stringify(answer));
    return answer;
  };
  const at = {
    x: (boxX - primary.x) / Math.max(1, primary.width - 1),
    y: (boxY - primary.y) / Math.max(1, primary.height - 1),
  };
  note({ click: at });
  const probed = await send({ type: "probe", ...at });
  assert.equal(probed.field, true, "the Windows field is detected before a click");
  assert.equal(probed.secure, false);
  assert.equal(fs.existsSync(`${out}.click`), false, "a probe never clicks the field");
  assert.equal(fs.existsSync(`${out}.text`), false, "a probe never types");
  assert.equal((await send({ type: "focus", ...at })).target.editable, false,
    "probing must not move focus from the initial button");
  await send({ type: "click", ...at, button: "left", count: 1 });
  await until(() => fs.existsSync(`${out}.click`), "the click to reach the box", 15000);
  const focused = await send({ type: "focus", ...at });
  assert.equal(focused.target.editable, true);
  assert.ok(focused.target.focus);
  await send({ type: "type-edit", delete: 0, text: "hello reach", focus: focused.target.focus });
  await until(() => fs.existsSync(`${out}.text`) && fs.readFileSync(`${out}.text`, "utf8") === "hello reach", "the typing to reach the box", 15000);
  note({ typed: fs.readFileSync(`${out}.text`, "utf8") });
  assert.equal((await send({ type: "focus", x: 0, y: 0 })).target.editable, false,
    "a field retaining Windows focus must not qualify for a tap outside its bounds");
  assert.equal((await send({ type: "probe", x: 0, y: 0 })).field, false);
  note({ probedBeforeClick: true, guardedTyping: true, outsideFieldRejected: true });

  // Pause gives the PC back: the stream and control end, and no screen or
  // input helper is left running.
  assert.deepEqual((await call("/api/settings/pause", { method: "POST", body: { paused: true } })).body, { paused: true });
  await until(() => screen.messages.some((m) => m.type === "error"), "the stream to end on Pause", 15000);
  await until(() => input.ws.readyState === WebSocket.CLOSED || input.messages.some((m) => m.type === "error"), "control to end on Pause", 15000);
  const helpers = async () => {
    const { stdout } = await exec("powershell.exe", [
      "-NoProfile",
      "-Command",
      // Not this query's own process: its command line names the helpers too.
      "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match '-File .*(screen-stream|desktop-input)\\.ps1' } | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
    ]);
    return stdout.split(/\r?\n/).filter((line) => line.trim());
  };
  let left = [];
  await until(async () => !(left = await helpers()).length, "no screen or input helper left after Pause", 20000).catch((error) => {
    note({ helpersLeft: left });
    throw Object.assign(error, { message: `${error.message}: ${left.join(" | ")}` });
  });
  note({ paused: true, helpersAfterPause: 0 });
});
