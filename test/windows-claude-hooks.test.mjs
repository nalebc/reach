import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
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

// Black-box hook process and real Node IPC, with Windows compiler/token/pipe
// ownership results modeled by an ESM loader. This is not NTFS or Windows
// execution evidence; the opt-in native case below covers the actual helper.
async function modeledHook(t, { mode = "ok", answer, away = 2200, retry = 4500 } = {}) {
  const dir = folder(t), audit = path.join(dir, "audit.jsonl"), fresh = path.join(dir, "stage", "owners.exe");
  const cached = path.join(dir, "planted-owners.exe"), pipe = newAgentAskPipe();
  fs.writeFileSync(cached, "planted executable");
  const config = { dir, audit, fresh, cached, pipe, mode };
  const fake = path.join(dir, "fake.mjs");
  fs.writeFileSync(fake, `
    import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'; import { promisify } from 'node:util';
    const c = JSON.parse(process.env.REACH_HOOK_MODEL);
    const sid = 'S-1-5-21-1-2-3-1001', logon = 'S-1-5-5-0-99';
    const note = (event, details = {}) => fs.appendFileSync(c.audit, JSON.stringify({event,...details})+'\\n');
    const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    export const readAgentAskPipe = () => c.pipe;
    export const windowsBuildDirectory = dir => dir;
    export const accountSid = () => c.mode === 'bad-sid' ? '' : sid;
    export async function createWindowsPrivateStage({sid: asked}) {
      note('stage', {sid:asked});
      if(c.mode === 'stage-fail') throw Error('private stage refused');
      fs.mkdirSync(path.dirname(c.fresh), {recursive:true}); return {dir:path.dirname(c.fresh),sid:asked};
    }
    export function builtWindowsHelper() { note('cached-lookup'); return {file:c.cached,sha256:digest(c.cached)}; }
    export async function windowsHelper(kind, options) {
      note('compile', {kind,dir:options.dir,fresh:options.fresh});
      if(c.mode === 'compile-fail') throw Error('compiler refused');
      if(c.mode === 'compile-stall') return new Promise((resolve,reject) => {
        const stop=()=>{ note('aborted'); reject(Error('aborted')); };
        if(options.signal?.aborted) stop(); else options.signal?.addEventListener('abort',stop,{once:true});
      });
      fs.writeFileSync(c.fresh, 'fresh compiled verifier'); return {file:c.fresh,sha256:digest(c.fresh)};
    }
    export function assertUnchanged(file, sha256) { if(digest(file)!==sha256) { note('changed'); throw Error('changed'); } }
    export function execFile() { throw Error('use promisified invocation'); }
    execFile[promisify.custom] = async (file,args,options) => {
      if(file.endsWith('\\\\whoami.exe')) { note('whoami',{file,args}); return {stdout:'"PC\\\\owner","'+sid+'"\\r\\n',stderr:''}; }
      note('execute',{file,args});
      return {stdout:JSON.stringify({self:sid,owner:sid,user:c.mode==='foreign'? 'S-1-5-21-1-2-3-1002':sid,logon:[logon],serves:[sid,'S-1-5-18','S-1-5-32-544',logon]}),stderr:''};
    };
  `);
  const loader = path.join(dir, "loader.mjs");
  fs.writeFileSync(loader, `
    import {pathToFileURL} from 'node:url';
    const fake = pathToFileURL(${JSON.stringify(fake)}).href;
    export async function resolve(specifier, context, next) {
      if(specifier === 'node:child_process' || /\\/(?:desktop-native|windows-private-stage|windows-private-folder|agent-asks)\\.mjs$/.test(specifier)) return {url:fake,shortCircuit:true};
      return next(specifier,context);
    }
  `);
  const register = path.join(dir, "register.mjs");
  fs.writeFileSync(register, `import {register} from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)}, import.meta.url);`);
  const requests = [], sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket));
    let raw = "";
    socket.on("data", chunk => {
      raw += chunk;
      if (!raw.includes("\n")) return;
      requests.push(JSON.parse(raw.slice(0, raw.indexOf("\n")))); raw = "";
      const response = answer ? answer(requests.length, config) : {decision:{behavior:"allow"}};
      socket.end(`${JSON.stringify(response)}\n`);
    });
    socket.on("error", () => {});
  });
  server.listen(pipe); await once(server, "listening");
  const child = spawn(process.execPath, ["--import", pathToFileURL(register).href, fileURLToPath(new URL("../scripts/agent-hook.mjs", import.meta.url)), "claude", "--pipe-dir", dir], {
    env: {...process.env, SystemRoot: "C:\\Windows", REACH_HOOK_MODEL:JSON.stringify(config), REACH_HOOK_AWAY_MS:String(away), REACH_HOOK_RETRY_MS:String(retry)},
    stdio:["pipe","pipe","pipe"],
  });
  let output = "", error = "";
  child.stdout.on("data", chunk => output += chunk); child.stderr.on("data", chunk => error += chunk);
  const timer = setTimeout(() => child.kill("SIGKILL"), 8000);
  t.after(() => { clearTimeout(timer); child.kill(); for(const socket of sockets) socket.destroy(); server.close(); });
  child.stdin.end(JSON.stringify({hook_event_name:"PermissionRequest",session_id:SESSION,tool_name:"Bash",tool_input:{command:"echo fixture"}}));
  const [code, signal] = await once(child, "close");
  clearTimeout(timer); for(const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve));
  let events = []; try { events = fs.readFileSync(audit,"utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch(error) { if(error.code!=="ENOENT") throw error; }
  return {code,signal,output,error,events,requests,config};
}

test("modeled Windows hook ignores a planted EXE/hash pair and pins one fresh verifier across retries", {timeout:12000}, async t => {
  const got = await modeledHook(t, {answer:n => n===1 ? {retry:true} : {decision:{behavior:"allow"}}});
  assert.equal(got.code,0,got.error); assert.equal(got.signal,null,got.error);
  assert.equal(JSON.parse(got.output).hookSpecificOutput.decision.behavior,"allow");
  assert.equal(got.requests.length,2); assert.equal(got.requests[1].again,true);
  assert.equal(got.events.filter(e => e.event==="compile").length,1,"one fresh compile per hook process");
  assert.equal(got.events.filter(e => e.event==="stage").length,1);
  assert.equal(got.events.filter(e => e.event==="whoami").length,1);
  assert.deepEqual(got.events.filter(e => e.event==="execute").map(e => e.file),[got.config.fresh,got.config.fresh]);
  assert.ok(got.events.some(e => e.event==="compile" && e.kind==="owners" && e.fresh===true));
  assert.ok(!got.events.some(e => e.event==="cached-lookup"),"a matching historical EXE/hash pair is never authority");
});

test("modeled Windows hook refuses a verifier changed after its first answer without rebuilding or trusting a cache", {timeout:12000}, async t => {
  const got = await modeledHook(t, {retry:2400,answer:(_n,c) => { fs.writeFileSync(c.fresh,"replaced after compile"); return {retry:true}; }});
  assert.equal(got.code,0,got.error); assert.equal(got.output,""); assert.equal(got.requests.length,1);
  assert.equal(got.events.filter(e => e.event==="compile").length,1);
  assert.equal(got.events.filter(e => e.event==="execute").length,1);
  assert.ok(got.events.some(e => e.event==="changed"));
  assert.ok(!got.events.some(e => e.event==="cached-lookup"));
});

for (const mode of ["bad-sid","stage-fail","compile-fail","foreign","compile-stall"]) {
  test(`modeled Windows hook leaves the native dialog in charge after ${mode}`, {timeout:12000}, async t => {
    const got = await modeledHook(t,{mode,away:120,retry:120});
    assert.equal(got.code,0,got.error); assert.equal(got.signal,null,got.error); assert.equal(got.output,"");
    assert.equal(got.requests.length,0,"an unverified endpoint receives no request");
    assert.ok(!got.events.some(e => e.event==="cached-lookup"));
    assert.ok(got.events.filter(e => e.event==="compile").length<=1,"failure retries do not recompile");
    if(mode==="compile-stall") assert.ok(got.events.some(e => e.event==="aborted"),"the existing away budget cancels a stalled compiler");
  });
}

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

test("on hosted Windows the actual hook ignores a forged matching owners cache and uses its own freshly built pipe verifier", {
  skip: !(windows && process.env.REACH_TEST_WINDOWS_DESKTOP === "1" && process.env.CI === "true"
    && process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_ENVIRONMENT === "github-hosted") && "disposable GitHub-hosted Windows runner only",
  timeout:300000,
}, async t => {
  const {windowsHelper,builtWindowsHelper,cscCandidates} = await import("../server/desktop-native.mjs");
  const {accountSid} = await import("../server/windows-private-folder.mjs");
  const run = promisify(execFile), dir = folder(t), marker = path.join(dir,"planted-executed.txt");
  const report = {schema:1,head:process.env.GITHUB_SHA || null,actualWindows:true,physicalDevice:false,node:process.version,
    scope:"Actual hook, fresh PowerShell/C# bootstrap and Node named pipe; controlled disposable forged cache, no Claude account or phone"};
  t.after(() => { fs.mkdirSync("reports",{recursive:true}); fs.writeFileSync("reports/windows-hook-fresh-verifier.json",JSON.stringify(report,null,2)); });
  const system = path.win32.join(process.env.SystemRoot,"System32");
  const sid = accountSid((await run(path.win32.join(system,"whoami.exe"),["/user","/fo","csv","/nh"],{timeout:10000,windowsHide:true})).stdout);
  assert.match(sid,/^S-1-5-21-/);
  const original = await windowsHelper("owners",{dir});
  const source = path.join(dir,"planted.cs");
  fs.writeFileSync(source,`using System; using System.IO;
    static class PlantedOwners { static void Main() {
      File.WriteAllText(Environment.GetEnvironmentVariable("REACH_TEST_HOOK_CACHE_MARKER"),"executed");
      Console.WriteLine(Environment.GetEnvironmentVariable("REACH_TEST_HOOK_FORGED_OWNER"));
    } }`);
  const compiler = cscCandidates().find(file => fs.existsSync(file));
  assert.ok(compiler,"Windows Framework compiler is present");
  await run(compiler,["/nologo","/noconfig","/target:exe","/platform:anycpu",`/out:${original.file}`,source],{timeout:60000,windowsHide:true});
  const forgedDigest = crypto.createHash("sha256").update(fs.readFileSync(original.file)).digest("hex");
  fs.writeFileSync(original.file.replace(/\.exe$/,".sha256"),`${forgedDigest}\n`);
  assert.deepEqual(builtWindowsHelper("owners",{dir}),{file:original.file,sha256:forgedDigest},"fixture has a matching forged historical EXE/hash pair");
  report.plantedMatchingCache = true;

  const pipe = newAgentAskPipe(), sockets = new Set(), requests = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on("close",()=>sockets.delete(socket)); socket.on("error",()=>{});
    let raw = "";
    socket.on("data",chunk => {
      raw += chunk;
      if(!raw.includes("\n")) return;
      requests.push(JSON.parse(raw.slice(0,raw.indexOf("\n"))));
      socket.end(`${JSON.stringify({decision:{behavior:"allow"}})}\n`);
    });
  });
  server.listen(pipe); await once(server,"listening");
  t.after(() => { for(const socket of sockets) socket.destroy(); server.close(); });
  fs.writeFileSync(path.join(dir,"agent-hook-pipe"),`${pipe.slice("\\\\.\\pipe\\".length)}\n`);
  assert.equal(readAgentAskPipe(dir),pipe,"the actual hook metadata names the controlled pipe");
  const env = {...process.env,REACH_TEST_HOOK_CACHE_MARKER:marker,REACH_TEST_HOOK_FORGED_OWNER:JSON.stringify({self:sid,owner:sid,user:sid,logon:[],serves:[sid]})};
  delete env.REACH_HOOK_AWAY_MS; delete env.REACH_HOOK_RETRY_MS;
  const child = spawn(process.execPath,[fileURLToPath(new URL("../scripts/agent-hook.mjs",import.meta.url)),"claude","--pipe-dir",dir],{env,stdio:["pipe","pipe","pipe"]});
  let output = "", error = "";
  child.stdout.on("data",chunk => output += chunk); child.stderr.on("data",chunk => error += chunk);
  const timer = setTimeout(()=>child.kill("SIGKILL"),15000);
  t.after(()=>{clearTimeout(timer);child.kill();});
  const started = Date.now();
  child.stdin.end(JSON.stringify({hook_event_name:"PermissionRequest",session_id:SESSION,tool_name:"Bash",tool_input:{command:"echo fixture"}}));
  const [code,signal] = await once(child,"close"); clearTimeout(timer);
  Object.assign(report,{elapsedMs:Date.now()-started,code,signal,requests:requests.length,error});
  assert.equal(code,0,error); assert.equal(signal,null,error);
  assert.equal(requests.length,1,"the fresh real checker authorizes this account's Node pipe within the unchanged hook budget");
  assert.equal(JSON.parse(output).hookSpecificOutput.decision.behavior,"allow");
  await assert.rejects(fs.promises.readFile(marker),{code:"ENOENT"},"the forged historical helper never executes");
  report.plantedExecuted = false; report.passed = true;
});
