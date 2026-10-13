import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTeamBridge, teamPipe } from "../server/agent-sessions/team-bridge.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// Team chats on Windows (audit #14, Oct 12): the bridge a lead reaches
// Reach on was a Unix socket, which Windows hasn't got, so Team always
// failed there. Now it's a named pipe of Reach's own, and the lead's bridge
// (scripts/team-mcp.mjs) checks the pipe is Reach's before the team's key
// goes to it, as a Mac's socket is kept in a private folder.
const windows = process.platform === "win32";
const script = fileURLToPath(new URL("../scripts/team-mcp.mjs", import.meta.url));
const AS_WINDOWS = pathToFileURL(path.resolve("test/helpers/as-windows.mjs")).href;
const folder = (t, name = "reach-team-") => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A team's lead, as Claude Code or Codex runs its bridge: MCP over stdio.
function lead(t, env, preload = []) {
  const proc = spawn(process.execPath, [...preload, script], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  t.after(() => proc.kill());
  let buffer = "";
  const waiting = new Map();
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      const m = JSON.parse(line); // only JSON-RPC on stdout
      waiting.get(m.id)?.(m);
    }
  });
  let id = 0;
  return (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
    });
}
// A team's key file where Reach writes it: <data>/teams/<id>.json.
const keyFile = (dataDir, socket) => {
  fs.mkdirSync(path.join(dataDir, "teams"), { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, "teams", "team-1.json");
  fs.writeFileSync(file, JSON.stringify({ socket, token: "k".repeat(43) }), { mode: 0o600 });
  return file;
};
const roster = async (ask) => {
  await ask("initialize", { protocolVersion: "2025-06-18" });
  return (await ask("tools/call", { name: "team_roster", arguments: {} })).result;
};

test("the team pipe's name is the data folder's own: kept across restarts, new for each folder, never guessed", (t) => {
  const a = folder(t), b = folder(t);
  const name = teamPipe(a);
  assert.match(name, /^\\\\\.\\pipe\\reach-team-[0-9a-f]{32}$/);
  assert.equal(teamPipe(a), name, "a team's key file still names it after a restart");
  assert.notEqual(teamPipe(b), name);
  if (!windows) assert.equal(fs.statSync(path.join(a, "team-pipe")).mode & 0o777, 0o600);
  // Something else in its place: a new name, never that text.
  fs.writeFileSync(path.join(a, "team-pipe"), "..\\..\\evil");
  assert.match(teamPipe(a), /^\\\\\.\\pipe\\reach-team-[0-9a-f]{32}$/);
  assert.notEqual(teamPipe(a), name);
});

test("on Windows the lead's bridge hands nothing to a connection that isn't a named pipe", async (t) => {
  // Played on any computer: the bridge script believes it's on Windows. Off
  // Windows something listens there, which the key must still never reach.
  const dir = folder(t);
  const socketPath = path.join(dir, "t.sock");
  const heard = [];
  if (!windows) {
    const listener = net.createServer((socket) => socket.on("data", (chunk) => heard.push(String(chunk))));
    listener.listen(socketPath);
    await once(listener, "listening");
    t.after(() => listener.close());
  }
  const ask = lead(t, { REACH_TEAM_FILE: keyFile(path.join(dir, "data"), socketPath) }, ["--import", AS_WINDOWS]);
  const result = await roster(ask);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Reach's team connection here isn't one the team can trust (it isn't a named pipe), so the team can't act right now.");
  assert.deepEqual(heard, [], "the team's key went nowhere");
});

// Real Windows: Reach's pipe, a lead calling team_roster through it.
const real = { skip: !windows, timeout: 240000 };

test("on real Windows, a lead reaches Reach on its team pipe and gets its roster", real, async (t) => {
  const dataDir = folder(t, "reach team data-");
  const pipe = teamPipe(dataDir);
  const calls = [];
  const bridge = createTeamBridge({ socketPath: pipe, call: async (token, tool, args) => (calls.push({ token, tool, args }), { tasks: [], steps_left: 7 }) });
  assert.equal(await bridge.listen(), true);
  t.after(() => bridge.close());
  const ask = lead(t, { REACH_TEAM_FILE: keyFile(dataDir, pipe) });
  const result = await roster(ask);
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.deepEqual(JSON.parse(result.content[0].text), { tasks: [], steps_left: 7 });
  assert.deepEqual(calls, [{ token: "k".repeat(43), tool: "team_roster", args: {} }]);
});

test("on real Windows, Reach won't serve a team pipe another program made first, and a lead says when Reach isn't there", real, async (t) => {
  const dataDir = folder(t, "reach team data-");
  const pipe = teamPipe(dataDir);
  const other = net.createServer((socket) => socket.destroy());
  other.listen(pipe);
  await once(other, "listening");
  const bridge = createTeamBridge({ socketPath: pipe, call: async () => assert.fail("never reached") });
  await assert.rejects(bridge.listen(), (e) => ["EADDRINUSE", "EACCES"].includes(e.code));
  await new Promise((r) => other.close(r));
  const ask = lead(t, { REACH_TEAM_FILE: keyFile(dataDir, pipe) });
  const result = await roster(ask);
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "Reach isn't running, so the team can't act right now.");
});

test("on real Windows, a lead won't hand its key to a pipe any account may serve", real, async (t) => {
  const dataDir = folder(t, "reach team data-");
  const name = `reach-team-test-${process.pid}-${Date.now()}`;
  // As another program could make it: Everyone may do anything with it.
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "$security = New-Object System.IO.Pipes.PipeSecurity",
    "$security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule([System.Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow')))",
    "$security.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule((New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')), 'FullControl', 'Allow')))",
    "$pipe = New-Object System.IO.Pipes.NamedPipeServerStream($env:REACH_TEST_PIPE, 'InOut', 4, 'Byte', 'None', 0, 0, $security)",
    "[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()",
    "$pipe.WaitForConnection(); $reader = New-Object System.IO.StreamReader($pipe); [Console]::Out.WriteLine('got:' + $reader.ReadLine()); [Console]::Out.Flush(); Start-Sleep -Seconds 60",
  ].join("; ");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { env: { ...process.env, REACH_TEST_PIPE: name }, windowsHide: true });
  t.after(() => child.kill());
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`PowerShell never made the pipe: ${out}`)), 60000);
    child.stdout.on("data", () => /ready/.test(out) && (clearTimeout(timer), resolve()));
    child.once("exit", () => (clearTimeout(timer), reject(new Error(`PowerShell stopped: ${out}`))));
  });
  const ask = lead(t, { REACH_TEAM_FILE: keyFile(dataDir, `\\\\.\\pipe\\${name}`) });
  const result = await roster(ask);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /isn't one the team can trust \(another account can serve it too\)/);
  await new Promise((r) => setTimeout(r, 500));
  assert.doesNotMatch(out, /k{43}/, "the team's key never reached it");
});

// The phone offers Team only where the bridge is open (5b81920e): the same
// answer on a Mac's socket and a PC's pipe once Reach listens (on Windows,
// once the owners helper the lead's check uses is built too).
test("once Reach's team bridge listens, the health check no longer says there are no teams", { timeout: 240000 }, async (t) => {
  const root = folder(t, "reach team health-");
  const dataDir = path.join(root, ".reach");
  const teamSocket = windows ? teamPipe(dataDir) : path.join(root, "t.sock");
  const reach = await createReach({
    roots: [root],
    dataDir,
    teamSocket,
    agentSessions: {
      list: async () => ({ sessions: [], errors: {} }),
      health: async () => [],
      start: async () => ({ threadId: "lead-1" }),
      models: async () => ({ models: [], modes: [], mode: null }),
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    reach.server.close();
    await reach.close?.();
  });
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const health = async () => (await fetch(`http://127.0.0.1:${reach.server.address().port}/api/sessions/health`, { headers: { Authorization: `Bearer ${owner.token}` } })).json();
  let answer;
  for (const until = Date.now() + 180000; (answer = await health()).teams === false && Date.now() < until; ) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(answer, { agents: [] });
});
