import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { codexNative, findWindowsCli, shimTarget, spawnable } from "../server/agent-cli.mjs";
import { findCodexExecutable } from "../server/capabilities.mjs";
import { windowsGitBash } from "../server/agent-sessions/claude-environment.mjs";
import { createClaudeHost } from "../server/agent-sessions/claude-host.mjs";
import { forgetClaudeMiss, locateClaude } from "../server/agent-sessions/index.mjs";

// Oct 11: on Windows, Claude Code and Codex chats couldn't start. Claude was
// looked for with a POSIX login shell (none on Windows), and Codex was found
// as npm's extensionless sh shim, which Windows can't run; npm's .cmd beside
// it needs a shell (Node refuses .cmd since CVE-2024-27980), and a shell
// would read prompt text as commands. Now each is found as what Node can
// start directly: a native .exe, else Node with the JS entry script npm's
// .cmd names. Fake npm layouts as npm writes them (cmd-shim 9), in a temp dir.
const exec = promisify(execFile);
const AS_WINDOWS = pathToFileURL(path.resolve("test/helpers/as-windows.mjs")).href;
const TRIPLES = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" };
const ID = "11111111-2222-4333-8444-555555555555";

const HEAD = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n";
// npm's .cmd for a target without a shebang (Claude Code's bin/claude.exe).
const exeShim = (target) => `${HEAD}"%dp0%\\${target}"   %*\r\n`;
// npm's .cmd for a `#!/usr/bin/env <prog>` script (Codex's bin/codex.js).
const progShim = (target, prog = "node") =>
  `${HEAD}\r\nIF EXIST "%dp0%\\${prog}.exe" (\r\n  SET "_prog=%dp0%\\${prog}.exe"\r\n) ELSE (\r\n  SET "_prog=${prog}"\r\n)\r\n\r\n` +
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;
// The sh script npm writes beside it, with no extension.
const shShim = (target) => `#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")\nexec node "$basedir/${target}" "$@"\n`;

function layout(t, files) {
  // Its real path: Node's package lookup (Codex's own) gives one, and the
  // Mac's temp folder is behind a link.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-windows-cli-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = (name) => path.join(dir, ...name.split("/"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(at(name)), { recursive: true });
    fs.writeFileSync(at(name), text, { mode: 0o755 });
  }
  return at;
}

test("Claude Code's native installer: claude.exe in .local\\bin, found off PATH; npm's sh shim and .ps1 never", async (t) => {
  const at = layout(t, {
    "npm/claude": shShim("node_modules/@anthropic-ai/claude-code/cli.js"),
    "npm/claude.ps1": "& node \"$basedir/node_modules/@anthropic-ai/claude-code/cli.js\" $args\n",
    // PATHEXT's .JS is Windows Script Host's, not Node's.
    "npm/claude.js": "WScript.Echo('not Claude Code')\n",
    "home/.local/bin/claude.exe": "MZ",
  });
  const env = { Path: at("npm"), PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.PS1" };
  const exe = at("home/.local/bin/claude.exe");
  assert.equal(await findWindowsCli("claude", { env, home: at("home") }), exe);
  assert.equal(await findWindowsCli("claude", { env: { ...env, UserProfile: at("home") }, home: at("elsewhere") }), exe);
  assert.deepEqual(spawnable(exe, { platform: "win32" }), { file: exe, args: [] });
  assert.equal(await findWindowsCli("claude", { env, home: at("elsewhere") }), null, "the sh shim, .ps1 and a WSH script are no Claude Code");
});

test("npm's Claude Code: claude.cmd counts as the native claude.exe it runs, started directly", async (t) => {
  const exe = "node_modules/@anthropic-ai/claude-code/bin/claude.exe";
  const at = layout(t, {
    "npm/claude": shShim(exe),
    "npm/claude.cmd": exeShim(exe.replaceAll("/", "\\")),
    [`npm/${exe}`]: "MZ",
  });
  const found = await findWindowsCli("claude", { env: { PATH: at("npm") }, home: at("home") });
  assert.equal(found, at(`npm/${exe}`));
  assert.deepEqual(spawnable(found, { platform: "win32" }), { file: found, args: [] });
  fs.rmSync(at(`npm/${exe}`));
  assert.equal(await findWindowsCli("claude", { env: { PATH: at("npm") }, home: at("home") }), null, "a shim whose target is gone");
});

test("an older npm Claude Code (cli.js) runs under Node, unless a native claude.exe is there too", async (t) => {
  const cli = "node_modules/@anthropic-ai/claude-code/cli.js";
  const at = layout(t, {
    "npm/claude": shShim(cli),
    "npm/claude.cmd": progShim(cli.replaceAll("/", "\\")),
    [`npm/${cli}`]: "#!/usr/bin/env node\n",
  });
  const options = { env: { PATH: at("npm") }, home: at("home") };
  const script = at(`npm/${cli}`);
  assert.equal(await findWindowsCli("claude", options), script);
  assert.deepEqual(spawnable(script, { platform: "win32" }), { file: process.execPath, args: [script] });
  fs.mkdirSync(at("home/.local/bin"), { recursive: true });
  fs.writeFileSync(at("home/.local/bin/claude.exe"), "MZ");
  assert.equal(await findWindowsCli("claude", options), at("home/.local/bin/claude.exe"), "a native .exe wins over a script found first");
});

test("npm's Codex: codex.cmd counts as the native codex.exe in its platform package; the sh shim never", { skip: !TRIPLES[process.arch] && "no Codex build for this CPU" }, async (t) => {
  const arch = process.arch, triple = TRIPLES[arch];
  const cli = "node_modules/@openai/codex/bin/codex.js";
  const platformPackage = `npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-${arch}`;
  const at = layout(t, {
    "npm/codex": shShim(cli),
    "npm/codex.cmd": progShim(cli.replaceAll("/", "\\")),
    "npm/codex.ps1": "& node \"$basedir/node_modules/@openai/codex/bin/codex.js\" $args\n",
    "npm/node_modules/@openai/codex/package.json": JSON.stringify({ name: "@openai/codex", type: "module", bin: { codex: "bin/codex.js" } }),
    [`npm/${cli}`]: "#!/usr/bin/env node\n",
    [`${platformPackage}/package.json`]: JSON.stringify({ name: "@openai/codex", version: `0.162.1-win32-${arch}`, os: ["win32"], cpu: [arch] }),
    [`${platformPackage}/vendor/${triple}/bin/codex.exe`]: "MZ",
  });
  const options = { platform: "win32", env: { PATH: at("npm") }, home: at("home") };
  const exe = at(`${platformPackage}/vendor/${triple}/bin/codex.exe`);
  assert.equal(await findCodexExecutable(options), exe);
  assert.deepEqual(spawnable(exe, { platform: "win32" }), { file: exe, args: [] });
  // Without its platform package (npm --omit=optional): Node runs codex.js.
  fs.rmSync(at("npm/node_modules/@openai/codex/node_modules"), { recursive: true });
  const script = at(`npm/${cli}`);
  assert.equal(await findCodexExecutable(options), script);
  assert.deepEqual(spawnable(script, { platform: "win32" }), { file: process.execPath, args: [script] });
  // REACH_CODEX naming the shim is read the same way; an extensionless path
  // is looked for with PATHEXT, as Windows does, never as itself.
  assert.equal(await findCodexExecutable({ ...options, env: { REACH_CODEX: at("npm/codex.cmd") } }), script);
  assert.equal(await findCodexExecutable({ ...options, env: { REACH_CODEX: at("npm/codex") } }), script);
  fs.rmSync(at("npm/codex.cmd"));
  assert.equal(await findCodexExecutable(options), null, "the sh shim and .ps1 alone: none");
  assert.equal(await findCodexExecutable({ ...options, env: { REACH_CODEX: at("npm/codex") } }), null);
});

test("Codex's native exe beside a hoisted platform package, or in its own vendor folder", async (t) => {
  const at = layout(t, {
    "hoisted/node_modules/@openai/codex/bin/codex.js": "",
    "hoisted/node_modules/@openai/codex-win32-x64/package.json": "{}",
    "hoisted/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe": "MZ",
    "old/node_modules/@openai/codex/bin/codex.js": "",
    "old/node_modules/@openai/codex/vendor/aarch64-pc-windows-msvc/bin/codex.exe": "MZ",
    "other/bin/codex.js": "",
  });
  const hoisted = at("hoisted/node_modules/@openai/codex/bin/codex.js");
  assert.equal(await codexNative(hoisted, { arch: "x64" }), at("hoisted/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe"));
  assert.equal(await codexNative(hoisted, { arch: "arm64" }), null, "another CPU's build is never taken");
  assert.equal(await codexNative(at("old/node_modules/@openai/codex/bin/codex.js"), { arch: "arm64" }), at("old/node_modules/@openai/codex/vendor/aarch64-pc-windows-msvc/bin/codex.exe"));
  assert.equal(await codexNative(at("other/bin/codex.js"), { arch: "x64" }), null, "only Codex's own package");
  assert.equal(await codexNative(hoisted, { arch: "ia32" }), null);
});

test("shims Reach won't start: an sh target, a hand-written .cmd, more than one program", async (t) => {
  const at = layout(t, {
    "a/node_modules/x/run.sh": "",
    "a/sh.cmd": progShim("node_modules\\x\\run.sh", "sh"),
    "a/hand.cmd": "@echo off\r\ncodex-real.exe %*\r\n",
    "a/two.cmd": `${HEAD}"%dp0%\\a.exe" "%dp0%\\b.exe" %*\r\n`,
    "a/bat.bat": exeShim("tool.exe"),
    // npm 6 wrote %~dp0 and named node.exe and the script twice.
    "a/old.cmd": '@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n) ELSE (\r\n  @SETLOCAL\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n)',
  });
  assert.equal(await shimTarget(at("a/sh.cmd")), null);
  assert.equal(await shimTarget(at("a/hand.cmd")), null);
  assert.equal(await shimTarget(at("a/two.cmd")), null);
  assert.equal(await shimTarget(at("a/missing.cmd")), null);
  assert.equal(await shimTarget(at("a/bat.bat")), at("a/tool.exe"));
  assert.equal(await shimTarget(at("a/old.cmd")), at("a/node_modules/@openai/codex/bin/codex.js"));
  assert.equal(await findWindowsCli("sh", { env: { PATH: at("a") }, dirs: [] }), null);
});

test("Git Bash for Claude Code: CLAUDE_CODE_GIT_BASH_PATH in any case, Git for Windows' folders, or beside git on PATH", () => {
  const files = new Set();
  const isFile = (file) => files.has(file);
  const chosen = path.join("D:", "Tools", "Git", "bin", "bash.exe");
  const standard = path.join("C:\\Program Files", "Git", "bin", "bash.exe");
  files.add(chosen).add(standard);
  assert.equal(windowsGitBash({ Claude_Code_Git_Bash_Path: chosen }, { isFile }), chosen);
  assert.equal(windowsGitBash({ CLAUDE_CODE_GIT_BASH_PATH: path.join("D:", "gone.exe") }, { isFile }), null, "the owner's choice, even when it's gone");
  assert.equal(windowsGitBash({}, { isFile }), standard);
  files.delete(standard);
  assert.equal(windowsGitBash({}, { isFile }), null);
  const scoop = path.join("E:", "apps", "Git");
  files.add(path.join(scoop, "cmd", "git.exe")).add(path.join(scoop, "bin", "bash.exe"));
  assert.equal(windowsGitBash({ Path: `C:\\Windows;${path.join(scoop, "cmd")}` }, { isFile }), path.join(scoop, "bin", "bash.exe"));
  const programs = path.join("F:", "Programs");
  files.add(path.join(programs, "Git", "bin", "bash.exe"));
  assert.equal(windowsGitBash({ ProgramFiles: programs }, { isFile }), path.join(programs, "Git", "bin", "bash.exe"));
});

// `claude -p` played by a fake that answers Reach's handshake (as in
// computer-word.test.mjs), recording how it was started.
function fakeClaude() {
  const runs = [];
  const spawn = (file, args, options) => {
    const proc = new EventEmitter();
    Object.assign(proc, { file, args, options, exitCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() });
    proc.kill = () => ((proc.exitCode = 143), proc.emit("exit", 143));
    proc.stdin = {
      on() {},
      end() {},
      write(text, callback) {
        for (const line of text.split("\n").filter(Boolean)) {
          const message = JSON.parse(line);
          if (message.type === "control_request")
            queueMicrotask(() => proc.stdout.emit("data", `${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } })}\n`));
        }
        callback?.();
      },
    };
    runs.push(proc);
    return proc;
  };
  return { spawn, runs };
}

test("a Windows chat without Git Bash says so plainly; with it, Claude Code starts without a shell", async (t) => {
  const exe = "C:\\Users\\me\\.local\\bin\\claude.exe";
  const missing = fakeClaude();
  const without = createClaudeHost({ locate: async () => exe, spawn: missing.spawn, env: {}, platform: "win32", gitBash: () => null });
  t.after(() => without.close());
  await assert.rejects(without.send(ID, { text: "hi", cwd: os.tmpdir() }), {
    status: 503,
    message: "Claude Code needs Git Bash on this Windows PC. Install Git for Windows, then try again.",
  });
  assert.equal(missing.runs.length, 0, "nothing started");
  const claude = fakeClaude();
  const h = createClaudeHost({ locate: async () => exe, spawn: claude.spawn, env: {}, platform: "win32", gitBash: () => "C:\\Program Files\\Git\\bin\\bash.exe" });
  t.after(() => h.close());
  await h.send(ID, { text: "hi & echo pwned", cwd: os.tmpdir() });
  const [run] = claude.runs;
  assert.equal(run.file, exe);
  assert.equal(run.args[0], "-p");
  assert.equal(run.options.shell, undefined);
});

test("Mac and Linux are unchanged: PATH's codex as is, Claude Code from the login shell", { skip: process.platform === "win32" && "POSIX PATH and modes" }, async (t) => {
  const at = layout(t, { "npm/codex": shShim("node_modules/@openai/codex/bin/codex.js"), "npm/codex.cmd": progShim("x.js") });
  for (const platform of ["darwin", "linux"]) {
    const found = await findCodexExecutable({ platform, env: { PATH: at("npm") }, home: at("home"), bundled: async () => [], extraPaths: [], run: async () => ({ stdout: "" }) });
    assert.equal(found, at("npm/codex"));
    assert.deepEqual(spawnable(found, { platform }), { file: found, args: [] });
    assert.deepEqual(spawnable("/opt/cli.js", { platform }), { file: "/opt/cli.js", args: [] });
  }
  const asked = [];
  forgetClaudeMiss();
  const run = async (...args) => (asked.push(args), { stdout: "/opt/reach-test-missing/bin/claude\n" });
  assert.equal(await locateClaude(run, { platform: "darwin", now: () => 5e12 }), "/opt/reach-test-missing/bin/claude");
  assert.deepEqual(asked, [[process.env.SHELL || "/bin/zsh", ["-lc", "command -v claude"], { timeout: 8000 }]]);
  forgetClaudeMiss();
});

test("no agent CLI is started through a shell", () => {
  for (const file of ["server/agent-cli.mjs", "server/capabilities.mjs", "server/codex.mjs", "server/agent-sessions/codex-daemon.mjs", "server/agent-sessions/commands.mjs", "server/agent-sessions/compatibility.mjs", "server/agent-sessions/claude-host.mjs", "server/agent-sessions/claude.mjs", "server/agent-sessions/index.mjs"])
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /shell\s*:\s*(true|["'`])/, file);
});

test("a script npm's .cmd names gets its arguments as given, with no shell between", async (t) => {
  const at = layout(t, {
    "npm/echo.cmd": progShim("node_modules\\echo\\echo.js"),
    "npm/node_modules/echo/echo.js": "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
  });
  const found = await findWindowsCli("echo", { env: { PATH: at("npm") }, dirs: [] });
  const { file, args } = spawnable(found, { platform: "win32" });
  const given = ["two words", '"quoted"', "a & echo pwned", "%PATH%", "^|<>", ""];
  const { stdout } = await exec(file, [...args, ...given], { timeout: 20000 });
  assert.deepEqual(JSON.parse(stdout), given);
});

// Fake agents, run by Node from where npm's .cmd points: each records how
// it was started and what it was sent.
const LOG = "const fs = require('node:fs'), path = require('node:path');\nconst log = (entry) => fs.appendFileSync(path.join(__dirname, 'log.jsonl'), JSON.stringify(entry) + '\\n');\nlog({ node: process.execPath, argv: process.argv.slice(2) });\n";
const LINES = "let buffer = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', (chunk) => {\n  buffer += chunk;\n  for (let i; (i = buffer.indexOf('\\n')) >= 0; ) {\n    const line = buffer.slice(0, i);\n    buffer = buffer.slice(i + 1);\n    if (line.trim()) take(JSON.parse(line));\n  }\n});\n";
const HELP = ["--input-format <format>", "--output-format <format>", "-r, --resume [value]", "--session-id <uuid>", '--permission-mode <mode>  (choices: "acceptEdits", "plan", "manual")', "--verbose", "--permission-prompts <mode>", "--permission-prompt-tool <tool>", "--include-partial-messages", "--replay-user-messages", "--model <model>", "--effort <level>"].join("\n");
const FAKE_CLAUDE = `${LOG}const argv = process.argv.slice(2);
if (argv[0] === '--version') { process.stdout.write('2.1.296 (Claude Code)\\n'); process.exit(0); }
if (argv[0] === '--help') { process.stdout.write(${JSON.stringify(`Usage: claude [options]\n${HELP}\n`)}); process.exit(0); }
const take = (message) => {
  log({ stdin: message });
  if (message.type === 'control_request') process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: {} } }) + '\\n');
};
${LINES}`;
const FAKE_CODEX = `${LOG}const take = (message) => {
  if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: { userAgent: 'codex_cli_rs/0.162.1' } }) + '\\n');
  if (message.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { data: [] } }) + '\\n');
};
${LINES}`;

test("Windows, wired: npm's Codex and Claude Code are found and started through Node, the sh shims beside them never", { timeout: 60000 }, async (t) => {
  const codexCli = "node_modules/@openai/codex/bin/codex.js", claudeCli = "node_modules/@anthropic-ai/claude-code/cli.js";
  const at = layout(t, {
    "npm/codex": shShim(codexCli),
    "npm/codex.cmd": progShim(codexCli.replaceAll("/", "\\")),
    [`npm/${codexCli}`]: FAKE_CODEX,
    "npm/claude": shShim(claudeCli),
    "npm/claude.cmd": progShim(claudeCli.replaceAll("/", "\\")),
    [`npm/${claudeCli}`]: FAKE_CLAUDE,
    "git/bin/bash.exe": "MZ",
    "work/.keep": "",
  });
  // This computer's own agents, PATH and Reach settings stay out of it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|appdata|home|userprofile|node_test_context|claude.*|anthropic.*|reach_.*)$/i.test(key)));
  // TEMP: where a Windows os.tmpdir() looks (the compatibility check writes there).
  Object.assign(env, { PATH: at("npm"), HOME: at("home"), USERPROFILE: at("home"), APPDATA: at("home/AppData/Roaming"), TEMP: os.tmpdir(), TMP: os.tmpdir(), CLAUDE_CODE_GIT_BASH_PATH: at("git/bin/bash.exe") });
  const url = (file) => JSON.stringify(pathToFileURL(path.resolve(file)).href);
  const text = 'hello & echo pwned %PATH% "quoted"';
  const script = `
    import fs from "node:fs";
    const { findCodexExecutable } = await import(${url("server/capabilities.mjs")});
    const { cliModelList } = await import(${url("server/agent-sessions/codex-daemon.mjs")});
    const { locateClaude } = await import(${url("server/agent-sessions/index.mjs")});
    const { createClaudeHost } = await import(${url("server/agent-sessions/claude-host.mjs")});
    const codex = await findCodexExecutable();
    const claude = await locateClaude();
    // Anything but the fakes (a lookup gone back to a login shell finds this
    // Mac's own Claude Code) is reported, never started or sent a message.
    if (codex !== ${JSON.stringify(at(`npm/${codexCli}`))} || claude !== ${JSON.stringify(at(`npm/${claudeCli}`))}) {
      console.log(JSON.stringify({ platform: process.platform, codex, claude }));
      process.exit(0);
    }
    const models = await cliModelList(codex);
    const host = createClaudeHost({ locate: () => locateClaude() });
    const modes = (await host.modes()).map((m) => m.id);
    await host.send(${JSON.stringify(ID)}, { text: ${JSON.stringify(text)}, cwd: ${JSON.stringify(at("work"))} });
    const log = ${JSON.stringify(at(`npm/${path.dirname(claudeCli)}/log.jsonl`))};
    for (const until = Date.now() + 15000; !fs.readFileSync(log, "utf8").includes('"type":"user"'); await new Promise((r) => setTimeout(r, 20)))
      if (Date.now() > until) throw Error("Claude Code never got the message");
    host.close();
    console.log(JSON.stringify({ platform: process.platform, codex, models, claude, modes }));
    process.exit(0);
  `;
  const { stdout } = await exec(process.execPath, ["--import", AS_WINDOWS, "--input-type=module", "-e", script], { env, cwd: path.resolve("."), timeout: 50000 });
  const out = JSON.parse(stdout.trim().split("\n").pop());
  assert.equal(out.platform, "win32");
  assert.equal(out.codex, at(`npm/${codexCli}`));
  assert.deepEqual(out.models, { data: [] });
  assert.equal(out.claude, at(`npm/${claudeCli}`));
  assert.deepEqual(out.modes, ["manual", "plan", "acceptEdits"]);
  const read = (cli) => fs.readFileSync(at(`npm/${path.dirname(cli)}/log.jsonl`), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const codexRuns = read(codexCli).filter((e) => e.argv);
  assert.deepEqual(codexRuns, [{ node: process.execPath, argv: ["app-server"] }]);
  const claudeLog = read(claudeCli);
  const starts = claudeLog.filter((e) => e.argv);
  assert.ok(starts.every((e) => e.node === process.execPath), "Node runs the script npm's .cmd names");
  assert.deepEqual(starts.filter((e) => e.argv[0] === "--version").length, 1, "the compatibility check ran it");
  const chat = starts.find((e) => e.argv[0] === "-p");
  assert.ok(chat.argv.includes("--resume") && chat.argv.includes(ID), JSON.stringify(chat.argv));
  const sent = claudeLog.find((e) => e.stdin?.type === "user");
  assert.deepEqual(sent.stdin.message.content, [{ type: "text", text }], "the message as typed");
});

test("Windows sign-in and terminal shortcuts start the CLI by its full path, never npm's .ps1", async () => {
  const { windowsCliCommand, powershellCall } = await import("../server/app-shortcuts.mjs");
  // A native install off PATH, and an npm shim's JS entry (started with Node).
  const native = await windowsCliCommand("claude", { find: async () => "C:\\Users\\Sam\\.local\\bin\\claude.exe" });
  assert.equal(native, '"C:\\Users\\Sam\\.local\\bin\\claude.exe"');
  const script = await windowsCliCommand("gemini", { find: async () => "C:\\Users\\Sam\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js", node: "C:\\Reach\\node.exe" });
  assert.equal(script, '"C:\\Reach\\node.exe" "C:\\Users\\Sam\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js"');
  assert.equal(await windowsCliCommand("claude", { find: async () => null }), null);
  // Codex is looked up with its native codex.exe in mind.
  let options;
  await windowsCliCommand("codex", { find: async (_, o) => ((options = o), null) });
  assert.equal(typeof options.native, "function");
  // cmd runs the quoted form as is (sign-in: cmd /d /s /c "<command> auth login");
  // PowerShell gets a call with single quotes, so $ and ' in a path stay as written.
  assert.equal(powershellCall(native), "& 'C:\\Users\\Sam\\.local\\bin\\claude.exe'");
  assert.equal(powershellCall('"C:\\Users\\O\'Neil$x\\claude.exe"'), "& 'C:\\Users\\O''Neil$x\\claude.exe'");
  assert.equal(powershellCall(script), "& 'C:\\Reach\\node.exe' 'C:\\Users\\Sam\\AppData\\Roaming\\npm\\node_modules\\@google\\gemini-cli\\dist\\index.js'");
  assert.equal(powershellCall("claude"), "claude", "a Mac command passes through");
  // PowerShell takes curly quotes as quotes too: doubled like straight ones.
  assert.equal(powershellCall('"C:\\Users\\Nassim’s PC\\claude.exe"'), "& 'C:\\Users\\Nassim’’s PC\\claude.exe'");
});
