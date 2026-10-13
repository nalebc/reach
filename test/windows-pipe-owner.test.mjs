import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import { askOwners, pipeOwner } from "../server/windows-owners.mjs";
import { trustedSocket } from "../server/agent-sessions/trusted-socket.mjs";
import { createCodexDaemon, ownSocket } from "../server/agent-sessions/codex-daemon.mjs";

// Codex's pipes on Windows are trusted as its sockets are on a Mac (audit
// #17, Oct 12): made by you, Windows or an administrator, served by a
// process of yours, and no one else's to serve; refused in the Mac's words.
// What Windows won't say isn't refused: a Mac's check can't fail that way,
// and chats stay in sync across the app, its CLI and Reach (owner, Oct 12).
const windows = process.platform === "win32";
const ME = "S-1-5-21-1111-2222-3333-1001";
const OTHER = "S-1-5-21-1111-2222-3333-1002";
const LOGON = "S-1-5-5-0-123456";
const PIPE = "\\\\.\\pipe\\codex-ipc";
const yours = { self: ME, logon: [LOGON], owner: ME, serves: [ME, "S-1-5-18", "S-1-5-32-544", LOGON], pid: 4242, user: ME, image: "C:\\codex.exe" };
const asWindows = (answer) => ({ platform: "win32", owner: async () => (typeof answer === "function" ? answer() : answer) });
const said = (because) => new RegExp(`Codex's session service isn't one Reach can trust here: ${because}\\.$`);

test("a pipe of yours is trusted; one made or served by another account, or one it may serve too, is refused in the Mac's words", async () => {
  assert.equal(await trustedSocket(PIPE, asWindows(yours)), PIPE);
  assert.equal(await ownSocket(PIPE, asWindows({ ...yours, owner: "S-1-5-32-544" })), PIPE, "made by an administrator (Codex run as one)");
  assert.equal(await ownSocket(PIPE, asWindows({ ...yours, owner: "S-1-5-18" })), PIPE, "made by Windows");
  assert.equal(await ownSocket(PIPE, asWindows({ ...yours, serves: [ME, "S-1-3-4", "S-1-3-0"] })), PIPE, "owner rights and creator owner name no one else");
  for (const [what, answer, because] of [
    ["made by another account", { ...yours, owner: OTHER }, "it belongs to another account"],
    ["served by another account", { ...yours, user: OTHER }, "it belongs to another account"],
    ["served by Windows itself", { ...yours, user: "S-1-5-18" }, "it belongs to another account"],
    ["anyone may serve it", { ...yours, serves: [ME, "S-1-1-0"] }, "another account can serve it too"],
    ["another account may serve it", { ...yours, serves: [OTHER] }, "another account can serve it too"],
    ["an entry Windows wouldn't name", { ...yours, serves: ["unknown"] }, "another account can serve it too"],
    ["not there", { error: "missing", code: 2 }, "it isn't there"],
    // Known to be someone else's even where the rest is unknown.
    ["made by another account, server unknown", { ...yours, owner: OTHER, user: null }, "it belongs to another account"],
  ])
    await assert.rejects(ownSocket(PIPE, asWindows(answer)), (e) => (assert.match(e.message, said(because), what), e.status === 503));
  // Another account's logon session isn't yours.
  await assert.rejects(ownSocket(PIPE, asWindows({ ...yours, serves: [ME, "S-1-5-5-0-999"] })), said("another account can serve it too"));
  // What Windows won't say, or a check that can't run (no csc.exe, a policy
  // that blocks it): used as yours, as on a Mac, and said once in Reach's window.
  const warned = [];
  const warn = console.warn;
  console.warn = (line) => warned.push(line);
  try {
    for (const [what, answer] of [
      ["Windows wouldn't open it", { error: "unchecked", code: 5 }],
      ["its server's account unknown", { ...yours, user: null }],
      ["its owner unknown", { ...yours, owner: null }],
      ["no list of who may serve it", { ...yours, serves: undefined }],
      ["your own account unknown", { ...yours, self: "" }],
      ["an answer that isn't one", "S-1-5-21"],
      ["the check failed", () => { throw Object.assign(new Error("Windows refused to run its C# compiler (csc.exe) on this PC."), { status: 503 }); }],
    ])
      assert.equal(await ownSocket(PIPE, asWindows(answer)), PIPE, what);
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 1, "said once, not on every poll");
  assert.match(warned[0], /couldn't check who serves .*codex-ipc.*used as yours, as on a Mac/);
});

test("only a named pipe is asked about on Windows; a path isn't one", async () => {
  let asked = 0;
  const owner = async () => (asked++, yours);
  for (const file of ["C:\\Users\\me\\.codex\\ipc\\ipc.sock", "/tmp/codex.sock", "\\\\.\\pipe\\..", "\\\\server\\pipe\\codex-ipc", ""])
    await assert.rejects(ownSocket(file, { platform: "win32", owner }), said("it isn't a named pipe"), file);
  assert.equal(asked, 0);
});

test("the helper is asked one question, built in Reach's data folder, run only as built, and only one JSON line counts", async () => {
  const runs = [];
  const built = { file: "C:\\data\\reach-owners-abc.exe", sha256: "a".repeat(64) };
  const helper = (stdout, unchanged = (file, sha256) => runs.push({ unchanged: [file, sha256] })) => ({
    build: async (kind, options) => (runs.push({ kind, options }), built),
    unchanged,
    run: async (file, args, options) => (runs.push({ file, args, options }), { stdout }),
  });
  assert.deepEqual(await pipeOwner(PIPE, { dataDir: "C:\\data", ...helper(`${JSON.stringify(yours)}\r\n`) }), yours);
  assert.deepEqual(runs[0], { kind: "owners", options: { dir: "C:\\data" } });
  assert.deepEqual(runs[1], { unchanged: [built.file, built.sha256] }, "its hash checked before it runs");
  assert.equal(runs[2].file, built.file);
  assert.deepEqual(runs[2].args, ["pipe", PIPE]);
  assert.equal(runs[2].options.windowsHide, true);
  for (const stdout of ["", "{}\n{}\n", "[1]\n", "null\n", "not json\n"])
    await assert.rejects(askOwners("pipe", PIPE, { dataDir: "C:\\data", ...helper(stdout) }), Error, JSON.stringify(stdout));
  // Changed on disk since it was built: never run.
  runs.length = 0;
  const changed = () => { throw Object.assign(new Error("Reach's helper changed on disk."), { code: "ECHANGED" }); };
  await assert.rejects(askOwners("pipe", PIPE, { dataDir: "C:\\data", ...helper("{}", changed) }), { code: "ECHANGED" });
  assert.equal(runs.some((r) => r.args), false);
  // Nothing but a pipe or a file on a drive is asked about, and not without a folder to build in.
  runs.length = 0;
  for (const [verb, target] of [["pipe", "C:\\x"], ["holders", "\\\\server\\share\\x"], ["holders", "relative\\x"], ["holders", "C:\\x\n"], ["other", PIPE], ["pipe", 7]])
    await assert.rejects(askOwners(verb, target, { dataDir: "C:\\data", ...helper("{}") }), /Not something Reach checks/);
  await assert.rejects(askOwners("pipe", PIPE, { dataDir: null, ...helper("{}") }), /data folder/);
  assert.deepEqual(runs, []);
});

// Real Windows: Node's own pipe, a pipe nobody serves, Windows' own and one
// anyone may serve, checked by the helper the PC compiles.
const pipeName = () => `\\\\.\\pipe\\reach-test-owner-${crypto.randomBytes(6).toString("hex")}`;
const folder = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach owners-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const real = { skip: !windows, timeout: 240000 };

test("on real Windows, a pipe Reach's own Node serves is trusted, and one nobody serves isn't there", real, async (t) => {
  const dataDir = folder(t);
  const pipe = pipeName();
  const server = net.createServer((socket) => socket.destroy());
  server.listen(pipe);
  await once(server, "listening");
  t.after(() => server.close());
  const seen = await pipeOwner(pipe, { dataDir });
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/windows-pipe-owner.json", JSON.stringify(seen, null, 2));
  assert.equal(seen.user, seen.self, "served by this account");
  assert.equal(seen.pid, process.pid);
  assert.match(seen.image, /node(\.exe)?$/i);
  assert.equal(await trustedSocket(pipe, { platform: "win32", dataDir }), pipe);
  await assert.rejects(trustedSocket(pipeName(), { platform: "win32", dataDir }), /it isn't there/);
});

test("on real Windows, a pipe Windows' own services serve is refused", real, async (t) => {
  const dataDir = folder(t);
  const present = new Set(fs.readdirSync("\\\\.\\pipe\\").map((name) => name.toLowerCase()));
  const name = ["lsass", "ntsvcs", "epmapper", "initshutdown", "eventlog", "scerpc"].find((n) => present.has(n));
  if (!name) return t.skip("No service pipe of Windows' own was found.");
  await assert.rejects(trustedSocket(`\\\\.\\pipe\\${name}`, { platform: "win32", dataDir }), /it belongs to another account|another account can serve it too/);
});

test("on real Windows, a pipe any account may serve too is refused", real, async (t) => {
  const dataDir = folder(t);
  const pipe = pipeName();
  // Made with .NET's pipe security, as another program could: Everyone may
  // do anything with it, add an instance included.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$security = New-Object System.IO.Pipes.PipeSecurity",
    "$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($me, 'FullControl', 'Allow')))",
    "$everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')",
    "$security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule($everyone, 'FullControl', 'Allow')))",
    "$pipe = New-Object System.IO.Pipes.NamedPipeServerStream($env:REACH_TEST_PIPE, 'InOut', 4, 'Byte', 'None', 0, 0, $security)",
    "[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()",
    "$pipe.WaitForConnection(); Start-Sleep -Seconds 60",
  ].join("; ");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, REACH_TEST_PIPE: pipe.slice("\\\\.\\pipe\\".length) },
    windowsHide: true,
  });
  t.after(() => child.kill());
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`PowerShell never made the pipe: ${out}`)), 60000);
    child.stdout.on("data", () => /ready/.test(out) && (clearTimeout(timer), resolve()));
    child.once("exit", () => (clearTimeout(timer), reject(new Error(`PowerShell stopped: ${out}`))));
  });
  await assert.rejects(trustedSocket(pipe, { platform: "win32", dataDir }), /another account can serve it too/);
});

test("on real Windows, Codex's session service on a pipe of yours passes the check and answers", real, async (t) => {
  const dataDir = folder(t);
  const pipe = pipeName();
  const server = http.createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      if (message.id != null) socket.send(JSON.stringify({ id: message.id, result: message.method === "initialize" ? {} : { data: [] } }));
    }),
  );
  server.listen(pipe);
  await once(server, "listening");
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((r) => wss.close(r));
    await new Promise((r) => server.close(r));
  });
  const daemon = createCodexDaemon({
    locate: async () => "C:\\codex.exe",
    run: async () => ({ stdout: JSON.stringify({ socketPath: pipe }) }),
    check: async () => ({ status: "available", version: null }),
    checkSocket: (file) => ownSocket(file, { dataDir }),
  });
  t.after(() => daemon.close());
  assert.deepEqual(await daemon.rpc("thread/list"), { data: [] });
});
