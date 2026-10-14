import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAgentAsks, newAgentAskPipe, readAgentAskPipe } from "../server/agent-sessions/agent-asks.mjs";
import { pipeServedByMe } from "../server/agent-sessions/trusted-socket.mjs";
import {
  agentHookCommand,
  agentModeHookCommand,
  claudeHookState,
  installClaudeHook,
  uninstallClaudeHook,
} from "../server/agent-sessions/agent-hook-install.mjs";

// Claude Code's permission prompts and mode switches on Windows, the same as
// on a Mac (docs/WINDOWS_AGENT_PARITY.md, row H): answered from the phone over
// a named pipe instead of a Unix socket, through a hook written in Claude
// Code's shell-less exec form (an `args` array, so no Git Bash and no
// quoting), with a Node mode hook in place of the Mac's /bin/sh one. Where
// anything is unsure the hook prints nothing and Claude Code's own dialog
// decides, exactly as on a Mac.
const windows = process.platform === "win32";
const SESSION = "34ab778a-0bc2-4a3d-a86b-887f8209431d";
const folder = (t, name = "reach-win-hooks-") => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const until = async (check, ms = 5000) => {
  for (const end = Date.now() + ms; !check() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
  return check();
};

// --- Installing the hook on Windows (provable on any computer: the commands
// are built for win32 and written into a settings file, no pipe needed) ---

test("on Windows the hook goes into Claude Code's settings in exec form: Reach's own node, its scripts as arguments, no shell line", (t) => {
  const settingsPath = path.join(folder(t), "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ model: "opus", hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "C:\\tools\\lint.exe" }] }] } }, null, 2));
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const command = agentHookCommand({ node, script: "C:\\reach\\scripts\\agent-hook.mjs", agent: "claude", dataDir: "C:\\Users\\me\\.reach", platform: "win32" });
  const modeCommand = agentModeHookCommand({ node, script: "C:\\reach\\scripts\\agent-mode-hook.mjs", modesDir: "C:\\Users\\me\\.reach\\pending-modes", platform: "win32" });
  // Exec form: a command plus an args array, never a shell string. The pipe
  // name is not an argument (the hook reads it from the data folder), so a
  // restart that moves the pipe never leaves a stale name in the settings.
  assert.deepEqual(command, { command: node, args: ["C:\\reach\\scripts\\agent-hook.mjs", "claude", "--pipe-dir", "C:\\Users\\me\\.reach"] });
  assert.deepEqual(modeCommand, { command: node, args: ["C:\\reach\\scripts\\agent-mode-hook.mjs", "C:\\Users\\me\\.reach\\pending-modes"] });

  assert.deepEqual(installClaudeHook({ settingsPath, command, modeCommand }), { changed: true });
  const hooks = JSON.parse(fs.readFileSync(settingsPath, "utf8")).hooks;
  assert.deepEqual(hooks.PermissionRequest, [{ matcher: "*", hooks: [{ type: "command", command: node, args: command.args, timeout: 86400, statusMessage: "Asking your phone (Reach)" }] }]);
  assert.deepEqual(hooks.PreToolUse, [{ matcher: "*", hooks: [{ type: "command", command: node, args: modeCommand.args, timeout: 10 }] }]);
  // The person's own hook (here a PostToolUse one) is left exactly as it was.
  assert.deepEqual(hooks.PostToolUse, [{ matcher: "Edit", hooks: [{ type: "command", command: "C:\\tools\\lint.exe" }] }]);

  assert.equal(claudeHookState({ settingsPath, command, modeCommand }), "on");
  // Reach's node moved: out of date, exactly as a changed shell string is on a Mac.
  assert.equal(claudeHookState({ settingsPath, command: { ...command, command: "D:\\node\\node.exe" }, modeCommand }), "outdated");
  // The pipe folder changed (a new data folder): also out of date.
  assert.equal(claudeHookState({ settingsPath, command: agentHookCommand({ node, script: "C:\\reach\\scripts\\agent-hook.mjs", agent: "claude", dataDir: "C:\\other", platform: "win32" }), modeCommand }), "outdated");

  assert.deepEqual(installClaudeHook({ settingsPath, command, modeCommand }), { changed: false });
  uninstallClaudeHook({ settingsPath });
  const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.deepEqual(after.hooks.PostToolUse, [{ matcher: "Edit", hooks: [{ type: "command", command: "C:\\tools\\lint.exe" }] }]);
  assert.ok(!after.hooks.PermissionRequest && !after.hooks.PreToolUse, "Reach's request and mode hooks are gone");
});

test("a Notepad-saved settings file with a UTF-8 BOM is still read, and Reach's write drops the BOM", (t) => {
  const settingsPath = path.join(folder(t), "settings.json");
  fs.writeFileSync(settingsPath, "\uFEFF" + JSON.stringify({ model: "opus" }, null, 2));
  const command = agentHookCommand({ node: "C:\\n\\node.exe", script: "C:\\r\\scripts\\agent-hook.mjs", agent: "claude", dataDir: "C:\\d", platform: "win32" });
  assert.deepEqual(installClaudeHook({ settingsPath, command }), { changed: true });
  const raw = fs.readFileSync(settingsPath, "utf8");
  assert.notEqual(raw.charCodeAt(0), 0xfeff, "no BOM written back");
  assert.equal(JSON.parse(raw).model, "opus");
});

// --- The pipe: Reach takes a name no one holds, and a squatter can't own it
// first (Node makes the first instance or none) ---

test("Reach answers on a named pipe of its own, and keeps the name in an owner-only file for the hook to read", async (t) => {
  const dir = folder(t);
  const asks = createAgentAsks({ platform: "win32", dataDir: dir, waiting: async () => true });
  await asks.listen();
  t.after(() => asks.close());
  assert.match(asks.socketPath, /^\\\\\.\\pipe\\reach-agent-hook-[0-9a-f]{32}$/);
  assert.equal(readAgentAskPipe(dir), asks.socketPath, "the hook reads the same name Reach listens on");
  if (!windows) assert.equal(fs.statSync(path.join(dir, "agent-hook-pipe")).mode & 0o777, 0o600);
  asks.close();
  assert.equal(readAgentAskPipe(dir), null, "the name file is cleared when Reach stops");
});

test("a pipe name already taken makes Reach pick another, so a squatter can't own the name first", async (t) => {
  const dir = folder(t);
  const taken = newAgentAskPipe();
  const other = net.createServer((s) => s.destroy());
  other.listen(taken);
  await once(other, "listening");
  t.after(() => other.close());
  // Force the first try onto the taken name, then fall back to fresh ones.
  const names = [taken, taken];
  const asks = createAgentAsks({ platform: "win32", dataDir: dir, waiting: async () => true, newPipe: () => names.shift() || newAgentAskPipe() });
  await asks.listen();
  t.after(() => asks.close());
  assert.notEqual(asks.socketPath, taken, "Reach didn't take the squatted name");
  assert.equal(readAgentAskPipe(dir), asks.socketPath);
});

// --- The hook trusts a pipe only when its server is this account's own
// process; anything unsure is refused, so no forged "allow" ---

test("pipeServedByMe trusts only this account's own pipe, never another's or an unsure answer", () => {
  const ME = "S-1-5-21-1-2-3-1001", OTHER = "S-1-5-21-1-2-3-1002", LOGON = "S-1-5-5-0-99";
  const mine = { self: ME, logon: [LOGON], owner: ME, user: ME, serves: [ME, "S-1-5-18", "S-1-5-32-544", LOGON] };
  assert.equal(pipeServedByMe(mine), true);
  assert.equal(pipeServedByMe({ ...mine, owner: "S-1-5-18" }), true, "made by Windows");
  assert.equal(pipeServedByMe({ ...mine, owner: "S-1-5-32-544" }), true, "made by an administrator");
  assert.equal(pipeServedByMe({ ...mine, serves: [ME, "S-1-3-4", "S-1-3-0"] }), true, "owner rights and creator owner name no one else");
  for (const [why, seen] of [
    ["made by another account", { ...mine, owner: OTHER }],
    ["served by another account", { ...mine, user: OTHER }],
    ["served by Windows itself", { ...mine, user: "S-1-5-18" }],
    ["anyone may serve it", { ...mine, serves: [ME, "S-1-1-0"] }],
    ["another account may serve it", { ...mine, serves: [OTHER] }],
    ["an entry Windows wouldn't name", { ...mine, serves: ["unknown"] }],
    ["not there", { error: "missing", code: 2 }],
    ["Windows wouldn't say", { error: "unchecked", code: 5 }],
    ["the owner unknown", { ...mine, owner: null }],
    ["the server's account unknown", { ...mine, user: null }],
    ["no list of who may serve", { ...mine, serves: undefined }],
    ["our own account unknown", { ...mine, self: "" }],
    ["not an answer", "S-1-5-21"],
    ["nothing", null],
  ])
    assert.equal(pipeServedByMe(seen), false, why);
});

// --- The Windows mode hook (Node): "ask" only for a session with a mode
// waiting, nothing otherwise, and never a word that could block a tool call ---

test("the Windows mode hook asks only for a session with a mode waiting, as the Mac's /bin/sh one does", async (t) => {
  const dir = folder(t);
  const script = fileURLToPath(new URL("../scripts/agent-mode-hook.mjs", import.meta.url));
  const run = (input) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [script, dir], { stdio: ["pipe", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (c) => (output += c));
      child.on("exit", (code) => resolve({ code, output }));
      child.stdin.end(input);
    });
  const call = JSON.stringify({ session_id: SESSION, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
  assert.deepEqual(await run(call), { code: 0, output: "" }, "nothing when no mode waits");
  fs.writeFileSync(path.join(dir, SESSION), "default\n");
  const asked = await run(call);
  assert.equal(asked.code, 0);
  assert.equal(JSON.parse(asked.output).hookSpecificOutput.permissionDecision, "ask");
  // Spaced JSON is read too; another session, a non-UUID, or no input gets nothing.
  assert.equal(JSON.parse((await run(JSON.stringify({ session_id: SESSION }, null, 2))).output).hookSpecificOutput.hookEventName, "PreToolUse");
  assert.deepEqual(await run(call.replace(SESSION, "11111111-2222-4333-8444-555555555555")), { code: 0, output: "" });
  assert.deepEqual(await run(JSON.stringify({ session_id: "../../evil" })), { code: 0, output: "" });
  assert.deepEqual(await run(""), { code: 0, output: "" });
});

// --- On a real Windows PC: the pipe-owner check runs the compiled helper,
// and a pipe any account may serve is refused (as the team bridge proves for
// its own pipe) ---

const real = { skip: !(windows && process.env.REACH_TEST_WINDOWS_DESKTOP === "1") && "needs a real Windows PC (REACH_TEST_WINDOWS_DESKTOP=1)", timeout: 300000 };

test("on real Windows, the hook trusts a pipe Reach's own Node serves and refuses one any account may serve", real, async (t) => {
  const { prepareOwners, pipeOwner } = await import("../server/windows-owners.mjs");
  const { builtWindowsHelper } = await import("../server/desktop-native.mjs");
  const dir = folder(t);
  await prepareOwners(dir);
  assert.ok(builtWindowsHelper("owners", { dir }), "Reach built the pipe-owner check with the PC's csc.exe");
  const build = (kind, { dir: d }) => {
    const found = builtWindowsHelper(kind, { dir: d });
    if (!found) throw new Error("owners helper not built");
    return found;
  };
  // Reach's own pipe: its server is this account's process, so the hook trusts it.
  const asks = createAgentAsks({ platform: "win32", dataDir: dir, waiting: async () => true });
  await asks.listen();
  t.after(() => asks.close());
  const seen = await pipeOwner(asks.socketPath, { dataDir: dir, build });
  fs.mkdirSync("reports", { recursive: true });
  fs.writeFileSync("reports/windows-claude-hooks.json", JSON.stringify({ pipe: asks.socketPath, seen }, null, 2));
  assert.equal(pipeServedByMe(seen), true, JSON.stringify(seen));

  // A pipe another program made so that everyone may serve it: refused.
  const name = `reach-agent-hook-test-${process.pid}-${Date.now()}`;
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "$s = New-Object System.IO.Pipes.PipeSecurity",
    "$s.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule([System.Security.Principal.WindowsIdentity]::GetCurrent().User, 'FullControl', 'Allow')))",
    "$s.AddAccessRule((New-Object System.IO.Pipes.PipeAccessRule((New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')), 'FullControl', 'Allow')))",
    "$p = New-Object System.IO.Pipes.NamedPipeServerStream($env:REACH_TEST_PIPE, 'InOut', 4, 'Byte', 'None', 0, 0, $s)",
    "[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()",
    "$p.WaitForConnection(); Start-Sleep -Seconds 60",
  ].join("; ");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { env: { ...process.env, REACH_TEST_PIPE: name }, windowsHide: true });
  t.after(() => child.kill());
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`PowerShell never made the pipe: ${out}`)), 60000);
    child.stdout.on("data", () => /ready/.test(out) && (clearTimeout(timer), resolve()));
    child.once("exit", () => (clearTimeout(timer), reject(new Error("PowerShell stopped early"))));
  });
  const shared = await pipeOwner(`\\\\.\\pipe\\${name}`, { dataDir: dir, build });
  assert.equal(pipeServedByMe(shared), false, "a pipe any account may serve is not trusted");
});
