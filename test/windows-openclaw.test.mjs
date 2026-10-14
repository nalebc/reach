import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { openClawShell, runOpenClaw, secretEnv } from "../server/openclaw-run.mjs";
import {
  findOpenClaw, installNode, leadPath, openClawNode, ownerOnlyFile, privateNodeDir, runTree, supportedNode, withSecret,
} from "../server/openclaw-windows.mjs";
import { addOpenClawProvider, gatewayAnswers, onboardArgs, onboardOpenClaw, onboardSettled, onboardSetup, onboardStatus, saveApiKey, SETUP_ERRORS, setupFailure } from "../server/openclaw-onboard.mjs";
import { addOpenClawChannel, startOpenClawGateway } from "../server/openclaw.mjs";
import { restartOpenClawGateway, runOpenClawMaintenance } from "../server/openclaw-health.mjs";
import { availableUpdateRuntime, installUpdateRuntime, publicRecovery, updateRecovery } from "../server/openclaw-update-recovery.mjs";
import { installPlan, installTerminalCommand } from "../server/agent-install.mjs";

// OpenClaw on Windows, natively (owner, Oct 13: "installed, set up and given
// keys from the phone on both, natively, as on the Mac"). Its makers document
// the native CLI and Gateway (docs.openclaw.ai/platforms/windows): npm's
// openclaw.cmd runs openclaw.mjs on Node 24.16+ or 26.1+. Reach starts that
// script with Node itself, its arguments fixed and no shell between, as it
// starts Codex and Claude Code there (agent-cli.mjs). Fake npm layouts as
// npm writes them (cmd-shim), in a temp dir; the real-Windows tests at the
// end run on GitHub's Windows runner (.github/scripts/run-tests.mjs).
const exec = promisify(execFile);
const KEY = "sk-or-v1-SECRETKEY0123456789";
const HEAD = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n";
const progShim = (target) =>
  `${HEAD}\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n\r\n` +
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;
const ENTRY = "node_modules\\openclaw\\openclaw.mjs";

function layout(t, files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-windows-openclaw-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const at = (name) => path.join(dir, ...name.split("/"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(at(name)), { recursive: true });
    fs.writeFileSync(at(name), text, { mode: 0o755 });
  }
  return at;
}
// npm's global folder with OpenClaw in it, nothing else.
const npmOpenClaw = (t, extra = {}) =>
  layout(t, { "npm/openclaw.cmd": progShim(ENTRY), "npm/node_modules/openclaw/openclaw.mjs": "// stand-in\n", "home/.keep": "", ...extra });
const noNode = { pick: async () => null, node: "C:\\reach\\node.exe" };

test("OpenClaw's Node: 24.16 or newer on 24, 26.1 or newer, anything after 26", () => {
  for (const ok of ["24.16.0", "v24.21.0", "26.1.0", "26.4.2", "27.0.0"]) assert.equal(supportedNode(ok), true, ok);
  for (const no of ["22.12.0", "24.15.9", "25.9.0", "26.0.3", "", null, "node", "v24"]) assert.equal(supportedNode(no), false, String(no));
});

test("on Windows openclaw runs as npm's openclaw.cmd runs it: Node, openclaw.mjs, the arguments as given, no shell", async (t) => {
  const at = npmOpenClaw(t);
  const env = { PATH: at("npm"), APPDATA: at("roaming"), LOCALAPPDATA: at("local") };
  const node = at("node/node.exe");
  const [file, argv, childEnv] = await openClawShell(["channels", "add", "--token", 'a&b|c%PATH%^"d'], { env, platform: "win32", home: at("home"), findRuntime: async () => null, pick: async () => node });
  assert.equal(file, node);
  assert.deepEqual(argv, [at("npm/node_modules/openclaw/openclaw.mjs"), "channels", "add", "--token", 'a&b|c%PATH%^"d']);
  assert.ok(!/cmd\.exe|powershell|-lc/i.test([file, ...argv].join(" ")), "no shell between");
  // The child's PATH leads with its Node's folder (what it starts, npm or
  // the Gateway, runs on the same Node); the rest as it was.
  assert.equal(childEnv.PATH, `${path.dirname(node)};${at("npm")}`);
  // Reach's own Node only when there's no other at all: OpenClaw says why.
  const [fallback, args] = await openClawShell(["--version"], { env, platform: "win32", home: at("home"), findRuntime: async () => null, ...noNode });
  assert.deepEqual([fallback, args.slice(1)], ["C:\\reach\\node.exe", ["--version"]]);
});

test("installed since Reach started: found in npm's folder or OpenClaw's installer's Node, off Reach's PATH", async (t) => {
  for (const where of ["roaming/npm", "local/OpenClaw/deps/portable-node"]) {
    const at = layout(t, { [`${where}/openclaw.cmd`]: progShim(ENTRY), [`${where}/node_modules/openclaw/openclaw.mjs`]: "" });
    const env = { PATH: at("elsewhere"), APPDATA: at("roaming"), LOCALAPPDATA: at("local") };
    assert.equal(await findOpenClaw({ env, home: at("home") }), at(`${where}/node_modules/openclaw/openclaw.mjs`), where);
  }
  // Not there: ENOENT, as a missing program reads everywhere else.
  const at = layout(t, {});
  await assert.rejects(openClawShell(["--version"], { env: { PATH: at("x") }, platform: "win32", home: at("home"), findRuntime: async () => null }), (e) => e.code === "ENOENT");
});

test("which Node runs it: the one npm's .cmd would, when OpenClaw accepts it; else OpenClaw's own, PATH, Node's installers", async (t) => {
  const at = layout(t, {
    "a/node.exe": "", "b/node.exe": "", "pf/nodejs/node.exe": "", "local/OpenClaw/deps/portable-node/node.exe": "",
    "home/.openclaw/tools/cli-node/tools/node/node.exe": "", "npm/node.exe": "",
  });
  const own = at("home/.openclaw/tools/cli-node/tools/node/node.exe");
  const env = { PATH: `${at("a")};${at("b")}`, ProgramFiles: at("pf"), LOCALAPPDATA: at("local") };
  const pick = (versions, extra = {}) => openClawNode({ env, home: at("home"), version: async (file) => versions[file] ?? null, ...extra });
  // PATH's first, when good enough, as typing openclaw would.
  assert.equal(await pick({ [at("a/node.exe")]: "24.16.0" }), at("a/node.exe"));
  // npm's .cmd runs the node.exe beside it first (a zip Node's own npm).
  assert.equal(await pick({ [at("npm/node.exe")]: "26.1.0" }, { script: at("npm/node_modules/openclaw/openclaw.mjs") }), at("npm/node.exe"));
  // Too old: OpenClaw's own Node first, as its launcher looks.
  assert.equal(await pick({ [at("a/node.exe")]: "22.12.0", [own]: "26.1.0", [at("b/node.exe")]: "24.20.0" }), own);
  assert.equal(await pick({ [at("a/node.exe")]: "22.12.0", [at("b/node.exe")]: "24.20.0" }), at("b/node.exe"));
  // Installed by Node's installer or OpenClaw's after Reach started.
  assert.equal(await pick({ [at("a/node.exe")]: "22.12.0", [at("pf/nodejs/node.exe")]: "24.21.0" }), at("pf/nodejs/node.exe"));
  assert.equal(await pick({ [at("a/node.exe")]: "22.12.0", [at("local/OpenClaw/deps/portable-node/node.exe")]: "26.2.0" }), at("local/OpenClaw/deps/portable-node/node.exe"));
  // None it accepts: the first, and OpenClaw says why.
  assert.equal(await pick({ [at("a/node.exe")]: "22.12.0" }), at("a/node.exe"));
});

test("a secret on Windows is OpenClaw's own variable in the child's environment, any other spelling dropped; never argv", () => {
  const env = { Path: "C:\\x", openrouter_api_key: "old", REACH_SECRET: "stale" };
  assert.deepEqual(withSecret(env, "OPENROUTER_API_KEY", KEY), { Path: "C:\\x", OPENROUTER_API_KEY: KEY });
  assert.deepEqual(secretEnv(env, { platform: "win32", secret: "OPENROUTER_API_KEY", value: KEY }), { Path: "C:\\x", OPENROUTER_API_KEY: KEY });
  // A Mac's stays as it was: REACH_SECRET, moved by the login shell.
  assert.deepEqual(secretEnv({ SHELL: "/bin/zsh" }, { platform: "darwin", secret: "OPENROUTER_API_KEY", value: KEY }), { SHELL: "/bin/zsh", REACH_SECRET: KEY });
  // One PATH, kept as Windows spells it, its Node's folder once and first.
  assert.deepEqual(leadPath({ Path: "C:\\b;C:\\NODE;C:\\c" }, "C:\\node"), { Path: "C:\\node;C:\\b;C:\\c" });
});

test("setup from the phone on Windows: OpenClaw's own onboarding, the key in its variable only", async (t) => {
  const at = npmOpenClaw(t);
  const env = { PATH: at("npm"), APPDATA: at("roaming") };
  const file = at("home/.openclaw/openclaw.json");
  const calls = [];
  const done = await onboardOpenClaw(
    { provider: "openrouter", key: KEY, acceptRisk: true },
    { run: async (...a) => (calls.push(a), { stdout: "" }), env, platform: "win32", file, home: at("home"), runtime: at("node/node.exe"), gateway: async () => false },
  );
  assert.deepEqual(done, { started: true, provider: "openrouter" });
  await onboardSettled();
  assert.deepEqual(onboardSetup(), { state: "done", provider: "openrouter" });
  const [node, argv, options] = calls[0];
  assert.equal(node, at("node/node.exe"));
  assert.deepEqual(argv, [at("npm/node_modules/openclaw/openclaw.mjs"), ...onboardArgs("openrouter")]);
  assert.doesNotMatch(argv.join(" "), /SECRETKEY/);
  assert.equal(options.env.OPENROUTER_API_KEY, KEY);
  assert.equal(options.env.REACH_SECRET, undefined);
  // Not installed: said at once, in Reach's words.
  const empty = layout(t, {});
  await assert.rejects(
    onboardOpenClaw({ provider: "openrouter", key: KEY, acceptRisk: true }, { run: async () => assert.fail("must not run"), env: { PATH: empty("x") }, platform: "win32", file: empty("c.json"), home: empty("home"), runtime: null, findRuntime: async () => null, gateway: async () => false }),
    (e) => e.status === 409 && e.message === SETUP_ERRORS.missing,
  );
});

// OpenClaw's own Windows app (Windows Hub) keeps its Gateway in a WSL distro
// of its own: no setup Reach can see here, yet a Gateway on its port. Reach
// doesn't start a second one beside it, and says why.
test("on Windows, setup isn't started beside a Gateway Reach can't see", async (t) => {
  const at = npmOpenClaw(t);
  await assert.rejects(
    onboardOpenClaw({ provider: "openrouter", key: KEY, acceptRisk: true }, { run: async () => assert.fail("must not run"), env: { PATH: at("npm") }, platform: "win32", file: at("home/none.json"), runtime: "C:\\n\\node.exe", gateway: async () => true }),
    (e) => e.status === 409 && e.message === "OpenClaw already runs on this PC (likely its Windows app), with a Gateway Reach can't see. Reach won't start a second one.",
  );
  // Refused at once: nothing there. Any answer, or none in time: something.
  const refused = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18789"), { code: "ECONNREFUSED" }) });
  assert.equal(await gatewayAnswers({ get: async () => { throw refused; } }), false);
  assert.equal(await gatewayAnswers({ get: async () => new Response("", { status: 404 }) }), true);
  assert.equal(await gatewayAnswers({ get: async () => { throw new DOMException("timed out", "TimeoutError"); } }), true);
  const asked = [];
  await gatewayAnswers({ get: async (url, init) => (asked.push([url, init.signal instanceof AbortSignal]), new Response("{}")) });
  assert.deepEqual(asked, [["http://127.0.0.1:18789/readyz", true]]);
});

test("run on another Node than npm's own, npm is told where OpenClaw is installed; pnpm's layout is left alone", async (t) => {
  const at = npmOpenClaw(t, { "pnpm/openclaw.cmd": progShim("global\\5\\node_modules\\openclaw\\openclaw.mjs"), "pnpm/global/5/node_modules/openclaw/openclaw.mjs": "" });
  const own = at("home/.openclaw/tools/cli-node/tools/node/node.exe");
  const envFor = async (PATH, node) => (await openClawShell(["update"], { env: { PATH, npm_config_prefix: "C:\\elsewhere" }, platform: "win32", home: at("home"), runtime: node, findRuntime: async () => null }))[2];
  // OpenClaw's own Node, a zip whose npm would name its own folder.
  const onOwn = await envFor(at("npm"), own);
  assert.equal(onOwn.NPM_CONFIG_PREFIX, at("npm"));
  assert.ok(!("npm_config_prefix" in onOwn), "one spelling");
  // The Node beside npm's own .cmd: npm knows already.
  const beside = await envFor(at("npm"), at("npm/node.exe"));
  assert.equal(beside.NPM_CONFIG_PREFIX, undefined);
  assert.equal(beside.npm_config_prefix, "C:\\elsewhere");
  // pnpm's global folder isn't npm's to change.
  const pnpm = await envFor(at("pnpm"), own);
  assert.equal(pnpm.NPM_CONFIG_PREFIX, undefined);
});

test("a key from the phone on Windows: OpenClaw's paste-api-key with the key on stdin, then read back", async (t) => {
  const at = npmOpenClaw(t);
  const env = { PATH: at("npm") };
  const script = at("npm/node_modules/openclaw/openclaw.mjs");
  const piped = [];
  const ran = [];
  const run = async (file, argv) => {
    ran.push([file, argv]);
    if (argv.includes("agents")) return { stdout: JSON.stringify([{ id: "main", isDefault: true }]) };
    return { stdout: JSON.stringify({ profiles: [{ id: "anthropic:default", provider: "anthropic", type: "api_key" }] }) };
  };
  await saveApiKey("anthropic", KEY, { pipe: async (...a) => piped.push(a), run, env, platform: "win32", runtime: "C:\\n\\node.exe" });
  assert.deepEqual(piped[0].slice(0, 2), ["C:\\n\\node.exe", [script, "models", "auth", "paste-api-key", "--agent", "main", "--provider", "anthropic", "--profile-id", "anthropic:default"]]);
  assert.equal(piped[0][2].input, `${KEY}\n`);
  assert.doesNotMatch(JSON.stringify(ran), /SECRETKEY/);
  // Adding one is no longer refused on Windows.
  const config = at("home/openclaw.json");
  fs.writeFileSync(config, "{}");
  assert.deepEqual(await addOpenClawProvider({ provider: "anthropic", key: KEY }, { save: async () => {}, env, platform: "win32", file: config }), { added: true, provider: "anthropic", default: false });
});

test("status on Windows: supported, installed as Reach finds it", async (t) => {
  const at = layout(t, {});
  const status = await onboardStatus({ has: async () => false, file: at("none.json"), platform: "win32" });
  assert.equal(status.supported, true);
  assert.equal(status.installed, false);
});

test("channels from the phone on Windows: tokens as arguments to Node (no shell), Telegram's in a file closed to others first", async (t) => {
  const at = npmOpenClaw(t);
  const env = { PATH: at("npm") };
  const script = at("npm/node_modules/openclaw/openclaw.mjs");
  const ran = [];
  const run = async (...a) => (ran.push(a), { stdout: "" });
  const steps = [];
  const files = {
    writeFile: async (file, text, options) => steps.push(["write", file, text, options]),
    mkdir: async (dir) => steps.push(["mkdir", dir]),
    chmod: async () => assert.fail("Windows has no modes"),
    rm: async (file) => steps.push(["rm", file]),
    ownerOnly: async (file) => steps.push(["owner-only", file]),
    stateDir: at("state"),
  };
  const token = at("state/credentials/reach-telegram.token");
  await addOpenClawChannel({ channel: "telegram", token: " 123:ABC&calc|%PATH% " }, { run, env, platform: "win32", runtime: "C:\\n\\node.exe", ...files });
  assert.deepEqual(steps, [
    ["mkdir", at("state/credentials")],
    // Made anew: a file left there may be someone else's.
    ["rm", token],
    ["write", token, "", { flag: "wx" }],
    ["owner-only", token],
    ["write", token, "123:ABC&calc|%PATH%\n", { flag: "r+" }],
  ]);
  assert.deepEqual(ran[0].slice(0, 2), ["C:\\n\\node.exe", [script, "channels", "add", "--channel", "telegram", "--token-file", token]]);
  assert.doesNotMatch(JSON.stringify(ran), /ABC/);
  // Discord's token is an argument, as on a Mac: to Node, one argument whole.
  await addOpenClawChannel({ channel: "discord", token: 'MTA&echo&pwned"|^x%PATH%' }, { run, env, platform: "win32", runtime: "C:\\n\\node.exe", ...files });
  assert.deepEqual(ran[1][1], [script, "channels", "add", "--channel", "discord", "--token", 'MTA&echo&pwned"|^x%PATH%']);
  // The file can't be closed to others: nothing goes in it, it's removed,
  // and nothing runs.
  steps.length = 0;
  await assert.rejects(
    addOpenClawChannel({ channel: "telegram", token: "123:ABCDEFGH" }, { run, env, platform: "win32", runtime: "C:\\n\\node.exe", ...files, ownerOnly: async () => { throw new Error("icacls"); } }),
    (e) => e.status === 409,
  );
  assert.deepEqual(steps.map((s) => s[0]), ["mkdir", "rm", "write", "rm"]);
  assert.equal(steps[2][2], "", "the token was never written");
  assert.equal(ran.length, 2);
});

test("the Gateway on Windows starts and restarts through OpenClaw's own commands, to Node, never cmd.exe", async (t) => {
  const at = npmOpenClaw(t);
  const env = { PATH: at("npm") };
  const script = at("npm/node_modules/openclaw/openclaw.mjs");
  const ran = [];
  const run = async (...a) => (ran.push(a), { stdout: "" });
  await startOpenClawGateway({ configuration: async () => ({}), env, platform: "win32", runtime: "C:\\n\\node.exe", run });
  await restartOpenClawGateway({ configuration: async () => ({}), env, platform: "win32", runtime: "C:\\n\\node.exe", run });
  assert.deepEqual(ran.map(([file, argv]) => [file, argv]), [["C:\\n\\node.exe", [script, "gateway", "start"]], ["C:\\n\\node.exe", [script, "gateway", "restart"]]]);
  // A cold PowerShell in OpenClaw's task checks may take a minute; a
  // timeout ends OpenClaw itself.
  assert.deepEqual(ran.map(([, , options]) => options.timeout), [90000, 90000]);
  assert.ok(ran.every(([, , options]) => options.env.PATH.startsWith("C:\\n;")), "its Node's folder first");
  // What to type at the PC when it can't: openclaw.cmd, which PowerShell
  // runs under Windows' default policy (npm's openclaw.ps1 it refuses).
  const broken = async () => { throw new Error("x"); };
  await assert.rejects(startOpenClawGateway({ configuration: async () => ({}), env, platform: "win32", runtime: "C:\\n\\node.exe", run: broken }),
    (e) => e.status === 503 && e.message === "OpenClaw’s Gateway didn’t start. On this computer, run: openclaw.cmd gateway start");
  await assert.rejects(restartOpenClawGateway({ configuration: async () => ({}), env, platform: "win32", runtime: "C:\\n\\node.exe", run: broken }),
    (e) => e.status === 503 && e.message === "OpenClaw’s Gateway didn’t restart. On this computer, run: openclaw.cmd gateway restart");
  const config = at("home/openclaw.json");
  fs.writeFileSync(config, "{}");
  assert.deepEqual(await setupFailure({ code: 1 }, config, "win32"), { state: "partial", error: "OpenClaw saved its setup, but its Gateway service didn't install. On this computer, run: openclaw.cmd gateway install" });
  assert.deepEqual(await setupFailure({ code: 1 }, config, "darwin"), { state: "partial", error: SETUP_ERRORS.partial });
  assert.match(SETUP_ERRORS.partial, /run: openclaw gateway install$/);
});

test("maintenance on Windows: the same fixed commands, as arguments; the update read as on a Mac", async (t) => {
  const at = npmOpenClaw(t);
  const env = { PATH: at("npm") };
  const script = at("npm/node_modules/openclaw/openclaw.mjs");
  const ran = [];
  const run = async (file, argv, options) => {
    ran.push([file, argv, options]);
    return { stdout: argv.includes("update") ? '{"status":"ok"}' : "fine", stderr: "" };
  };
  const options = { configuration: async () => ({}), env, platform: "win32", run };
  assert.equal((await runOpenClawMaintenance("doctor", { ...options, runtime: "C:\\n\\node.exe" })).status, "done");
  assert.equal((await runOpenClawMaintenance("update", { ...options, runtime: "C:\\n\\node.exe" })).status, "done");
  await runOpenClawMaintenance("repair-service", { ...options, runtime: "C:\\own\\node.exe" });
  assert.deepEqual(ran.map(([file, argv]) => [file, argv]), [
    ["C:\\n\\node.exe", [script, "doctor", "--non-interactive", "--no-workspace-suggestions"]],
    ["C:\\n\\node.exe", [script, "update", "--yes", "--json", "--timeout", "600"]],
    ["C:\\own\\node.exe", [script, "gateway", "install", "--force", "--runtime", "node", "--json", "--runtime-path", "C:\\own\\node.exe"]],
  ]);
  assert.equal(ran[1][2].timeout, 1800000);
  // No OpenClaw: said as a command that couldn't start.
  const empty = layout(t, {});
  const missing = await runOpenClawMaintenance("doctor", { configuration: async () => ({}), env: { PATH: empty("x") }, platform: "win32", run, runtime: null, home: empty("h") });
  assert.equal(missing.status, "failed");
  assert.match(missing.message, /executable was not found/);
});

test("installing on Windows: OpenClaw's own installer; a Node it can't use gets OpenClaw's own beside it, said first", async () => {
  const dir = "C:\\Users\\Ann O'Neil\\.openclaw\\tools\\cli-node\\tools\\node";
  const ready = await installPlan("openclaw", { platform: "win32", node: async () => ({ version: "24.20.0", supported: true, dir }) });
  assert.deepEqual(ready, { agent: "openclaw", name: "OpenClaw", command: "& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard" });
  assert.equal(
    installTerminalCommand(ready, "win32"),
    "$ErrorActionPreference = 'Stop'; try { & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard; exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
  );
  const old = await installPlan("openclaw", { platform: "win32", node: async () => ({ version: "22.12.0", supported: false, dir, privateReady: false }) });
  assert.equal(old.command, ready.command, "the phone shows the maker's command");
  assert.equal(old.note, "OpenClaw needs Node 24.16 or newer, and this PC has Node 22.12.0. Reach adds a Node for OpenClaw only first, with OpenClaw's own installer, and keeps this PC's Node as it is.");
  assert.equal(
    old.lead,
    "& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NodeOnly -NodePrefix 'C:\\Users\\Ann O''Neil\\.openclaw\\tools\\cli-node\\tools\\node'; " +
      "$env:Path = 'C:\\Users\\Ann O''Neil\\.openclaw\\tools\\cli-node\\tools\\node;' + $env:Path; $env:NPM_CONFIG_PREFIX = Join-Path $env:APPDATA 'npm'",
  );
  assert.match(installTerminalCommand(old, "win32"), /^\$ErrorActionPreference = 'Stop'; try \{ & \(\[scriptblock\]::Create\(\(iwr -useb https:\/\/openclaw\.ai\/install\.ps1\)\)\) -NodeOnly .*; & .* -NoOnboard; exit 0 \} catch/);
  assert.doesNotMatch(old.note, /\bMac\b/);
  // OpenClaw's own Node there already: used, nothing added, nothing to say.
  const kept = await installPlan("openclaw", { platform: "win32", node: async () => ({ version: "22.12.0", supported: false, dir, privateReady: true }) });
  assert.equal(kept.note, undefined);
  assert.doesNotMatch(kept.lead, /NodeOnly/);
  // Nothing on PATH at all.
  assert.match((await installPlan("openclaw", { platform: "win32", node: async () => ({ version: null, supported: false, dir }) })).note, /^OpenClaw needs Node 24\.16 or newer\. Reach adds/);
});

test("the Node a Reach terminal finds first decides the install's Node step", async (t) => {
  const at = layout(t, { "a/node.exe": "", "home/.openclaw/tools/cli-node/tools/node/node.exe": "" });
  const own = at("home/.openclaw/tools/cli-node/tools/node/node.exe");
  const check = (versions) => installNode({ env: { PATH: at("a") }, home: at("home"), version: async (file) => versions[file] ?? null });
  assert.deepEqual(await check({ [at("a/node.exe")]: "24.18.0" }), { version: "24.18.0", supported: true, dir: path.dirname(own), privateReady: false });
  assert.deepEqual(await check({ [at("a/node.exe")]: "22.12.0", [own]: "26.1.0" }), { version: "22.12.0", supported: false, dir: path.dirname(own), privateReady: true });
  assert.equal(privateNodeDir({ env: { OPENCLAW_HOME: at("elsewhere") }, home: at("home") }), at("elsewhere/.openclaw/tools/cli-node/tools/node"));
  // Reach's own private Node first on PATH (scripts/bootstrap.ps1, on a PC
  // with none it can use): it decides, but the phone names the PC's own.
  const reach = layout(t, { "reach/.reach/runtime/node-v22.23.3-win-x64/node.exe": "", "pf/nodejs/node.exe": "" });
  const ours = reach("reach/.reach/runtime/node-v22.23.3-win-x64/node.exe");
  const versions = { [ours]: "22.23.3", [reach("pf/nodejs/node.exe")]: "20.11.1" };
  const both = await installNode({ env: { PATH: `${path.dirname(ours)};${reach("pf/nodejs")}` }, home: reach("home"), version: async (file) => versions[file] ?? null });
  assert.deepEqual([both.version, both.supported], ["20.11.1", false]);
  const alone = await installNode({ env: { PATH: path.dirname(ours) }, home: reach("home"), version: async (file) => versions[file] ?? null });
  assert.deepEqual([alone.version, alone.supported], [null, false]);
});

// OpenClaw's launcher refuses with "openclaw requires Node >=24.16.0 <25, or
// >=26.1.0." (node-sqlite.mjs, 2026.10.3); its engines read "|| >=26.1.0".
test("Node recovery on Windows: OpenClaw's own Node from the installer in its package, the PC's Node kept", async () => {
  const installer = async () => "C:\\npm\\node_modules\\openclaw\\scripts\\install.ps1";
  for (const said of ["openclaw: Node 22.12.0: openclaw requires Node >=24.16.0 <25, or >=26.1.0.", "this OpenClaw release requires Node >=24.16.0 <25 || >=26.1.0.\ndetected Node 22.12.0"]) {
    const recipe = await updateRecovery(said, { platform: "win32", installer });
    assert.equal(recipe.available, true, said);
    assert.equal(recipe.installer, "C:\\npm\\node_modules\\openclaw\\scripts\\install.ps1");
    assert.match(recipe.description, /for OpenClaw only.*Your current Node installation is kept\./);
    assert.equal(publicRecovery(recipe).installer, undefined, "no local path to the phone");
  }
  // A range its installer's Node 26 isn't in, or no installer: said, not run.
  assert.equal((await updateRecovery("requires Node >=24.16.0 <25", { platform: "win32", installer })).available, false);
  assert.equal((await updateRecovery("requires Node >=28.0.0", { platform: "win32", installer })).available, false);
  assert.equal((await updateRecovery("openclaw requires Node >=24.16.0 <25, or >=26.1.0.", { platform: "win32", installer: async () => null })).available, false);
  const recipe = await updateRecovery("openclaw requires Node >=24.16.0 <25, or >=26.1.0.", { platform: "win32", installer });
  const calls = [];
  let allowed = true;
  const deps = {
    platform: "win32",
    installer,
    env: { USERPROFILE: "C:\\Users\\ann" },
    authorize: () => { if (!allowed) throw new Error("revoked"); },
    run: async (...a) => (calls.push(a), { stdout: "26.3.0\n" }),
  };
  const runtime = await installUpdateRuntime(recipe, deps);
  assert.equal(runtime, path.join(privateNodeDir({ env: deps.env }), "node.exe"));
  assert.deepEqual(calls[0].slice(0, 2), ["powershell.exe", ["-NonInteractive", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "C:\\npm\\node_modules\\openclaw\\scripts\\install.ps1", "-NodeOnly", "-NodePrefix", privateNodeDir({ env: deps.env })]]);
  assert.deepEqual(calls[1].slice(0, 2), [runtime, ["-p", "process.versions.node"]]);
  // Revoked mid-way: nothing more runs.
  calls.length = 0;
  await assert.rejects(installUpdateRuntime(recipe, { ...deps, run: async (...a) => { calls.push(a); allowed = false; return {}; } }), /revoked/);
  assert.equal(calls.length, 1);
  allowed = true;
  // Not a Node it accepts, or not the installer the recipe named: refused.
  await assert.rejects(installUpdateRuntime(recipe, { ...deps, run: async () => ({ stdout: "26.0.1" }) }), (e) => e.status === 409);
  await assert.rejects(installUpdateRuntime(recipe, { ...deps, installer: async () => "C:\\elsewhere\\install.ps1" }), (e) => e.status === 409);
  // OpenClaw's own Node is what later runs use, while OpenClaw accepts it.
  const own = path.join(privateNodeDir({ env: deps.env }), "node.exe");
  assert.equal(await availableUpdateRuntime({ platform: "win32", env: deps.env, version: async () => "26.3.0" }), own);
  assert.equal(await availableUpdateRuntime({ platform: "win32", env: deps.env, version: async () => "22.1.0" }), null);
  assert.equal(await availableUpdateRuntime({ platform: "win32", env: deps.env, version: async () => null }), null);
});

test("a Telegram token file on Windows: this account, SYSTEM and Administrators by SID, inheritance off; unconfirmed throws", async () => {
  const ran = [];
  const env = { SystemRoot: "C:\\Windows" };
  await ownerOnlyFile("C:\\Users\\ann\\.openclaw\\credentials\\reach-telegram.token", {
    env,
    run: async (file, args) => (ran.push([file, args]), { stdout: '"pc\\ann","S-1-5-21-1-2-3-1001"\r\n' }),
  });
  assert.deepEqual(ran, [
    ["C:\\Windows\\System32\\whoami.exe", ["/user", "/fo", "csv", "/nh"]],
    ["C:\\Windows\\System32\\icacls.exe", ["C:\\Users\\ann\\.openclaw\\credentials\\reach-telegram.token", "/inheritance:r", "/grant:r", "*S-1-5-18:F", "*S-1-5-32-544:F", "*S-1-5-21-1-2-3-1001:F", "/Q"]],
  ]);
  await assert.rejects(ownerOnlyFile("x", { env, run: async () => ({ stdout: "nobody" }) }), /no account/);
  await assert.rejects(ownerOnlyFile("x", { env: {}, run: async () => assert.fail() }), /no Windows folder/);
  await assert.rejects(ownerOnlyFile("x", { env, run: async (file) => { if (/icacls/.test(file)) throw new Error("denied"); return { stdout: '"a","S-1-5-21-1-2-3-4"' }; } }), /denied/);
});

test("a timed-out OpenClaw on Windows ends with its whole process tree; the error never carries the command line", async () => {
  let killed = null;
  const fake = (file, args, options, done) => {
    assert.equal(options.windowsHide, true);
    setTimeout(() => done(Object.assign(new Error(`Command failed: ${file} ${args.join(" ")}`), { code: 1 }), "", ""), 30);
    return { pid: 4242 };
  };
  await assert.rejects(runTree("node.exe", ["x.mjs", "--token", "MTA-secret"], { timeout: 5 }, { start: fake, kill: (pid) => (killed = pid) }), (e) => {
    assert.equal(e.killed, true);
    assert.doesNotMatch(`${e.message} ${JSON.stringify(e)}`, /MTA-secret/);
    return true;
  });
  assert.equal(killed, 4242);
  const ok = (file, args, options, done) => (setTimeout(() => done(null, "out", ""), 1), { pid: 1 });
  assert.deepEqual(await runTree("node.exe", [], { timeout: 1000 }, { start: ok, kill: () => assert.fail() }), { stdout: "out", stderr: "" });
});

test("no OpenClaw command goes through cmd.exe or a PowerShell string", () => {
  for (const file of ["server/openclaw.mjs", "server/openclaw-health.mjs", "server/openclaw-onboard.mjs", "server/openclaw-run.mjs", "server/openclaw-windows.mjs"])
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /cmd\.exe|shell\s*:\s*true/, file);
});

// ---- On a real Windows PC (GitHub's Windows runner) -----------------------

const windows = process.platform === "win32" ? false : "real Windows only";

// OpenClaw's installer, run as a script block, throws when it fails; its
// last probe's exit code is no verdict (install.ps1's Complete-Install).
test("real Windows: the install terminal's verdict is the script block's, not its last probe's", { skip: windows }, () => {
  const node = process.execPath.replaceAll("'", "''");
  const block = (body) => `& ([scriptblock]::Create('${body.replaceAll("'", "''")}'))`;
  for (const [plan, expected] of [
    [{ command: `${block(`& '${node}' -e 'process.exit(1)'; Write-Output 'probe failed, install fine'`)} -NoOnboard` }, 0],
    [{ command: `${block("throw 'OpenClaw installation failed with exit code 1.'")} -NoOnboard` }, 1],
    [{ command: `${block("Write-Output 'fine'")} -NoOnboard`, lead: "throw 'Node download failed'" }, 1],
  ]) {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", installTerminalCommand(plan, "win32")], { encoding: "utf8", timeout: 60_000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, expected, `${plan.command}\n${result.stdout}\n${result.stderr}`);
  }
});

// This PC's environment with the stand-in's folder first on PATH. Windows
// spells it Path: any spelling goes first, so there's one PATH (and no
// OpenRouter key or Reach setting of this runner's).
const withFirst = (dir) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(path|openrouter_api_key|reach_.*)$/i.test(key))),
  PATH: `${dir};${process.env.PATH}`,
});
// A stand-in OpenClaw where npm puts it, run as Reach runs it.
const STAND_IN = `import fs from "node:fs";
const input = await new Promise((resolve) => { let text = ""; if (!process.argv.includes("--stdin")) return resolve(""); process.stdin.setEncoding("utf8"); process.stdin.on("data", (c) => (text += c)); process.stdin.on("end", () => resolve(text)); });
fs.appendFileSync(new URL("./log.jsonl", import.meta.url), JSON.stringify({ argv: process.argv.slice(2), key: process.env.OPENROUTER_API_KEY ?? null, reach: process.env.REACH_SECRET ?? null, input, node: process.execPath }) + "\\n");
`;
test("real Windows: Reach runs npm's OpenClaw with each argument whole, the key in its variable, stdin as given", { skip: windows, timeout: 60000 }, async (t) => {
  const at = layout(t, { "npm/openclaw.cmd": progShim(ENTRY), "npm/node_modules/openclaw/openclaw.mjs": STAND_IN });
  const env = withFirst(at("npm"));
  const given = ["channels", "add", "--token", 'a&b|c%PATH%^"d e', "--name", "two words"];
  const [file, argv, childEnv] = await openClawShell(given, { env, platform: "win32", runtime: process.execPath });
  await runOpenClaw(file, argv, { env: secretEnv(childEnv, { platform: "win32", secret: "OPENROUTER_API_KEY", value: KEY }), timeout: 30000 });
  const [paste, pasteArgs, pasteEnv] = await openClawShell(["models", "auth", "paste-api-key", "--stdin"], { env, platform: "win32", runtime: process.execPath });
  const { pipeRun } = await import("../server/openclaw-onboard.mjs");
  await pipeRun(paste, pasteArgs, { input: `${KEY}\n`, env: pasteEnv, timeout: 30000 });
  const log = fs.readFileSync(at("npm/node_modules/openclaw/log.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(log[0].argv, given);
  assert.equal(log[0].key, KEY);
  assert.equal(log[0].reach, null);
  assert.equal(log[1].input, `${KEY}\n`);
  assert.equal(log[1].key, null, "a key goes only where it's sent");
  assert.equal(log[0].node.toLowerCase(), process.execPath.toLowerCase());
});

test("real Windows: Telegram's token file is closed to everyone but this account, SYSTEM and Administrators", { skip: windows, timeout: 90000 }, async (t) => {
  const at = layout(t, { "npm/openclaw.cmd": progShim(ENTRY), "npm/node_modules/openclaw/openclaw.mjs": STAND_IN });
  const env = withFirst(at("npm"));
  await addOpenClawChannel({ channel: "telegram", token: "123:ABCDEFGHIJ" }, { env, platform: "win32", runtime: process.execPath, stateDir: at("state") });
  const token = at("state/credentials/reach-telegram.token");
  assert.equal(fs.readFileSync(token, "utf8"), "123:ABCDEFGHIJ\n");
  const script = `$a = Get-Acl -LiteralPath '${token.replaceAll("'", "''")}'; $a.AreAccessRulesProtected; $a.Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value + ' ' + $_.IsInherited }`;
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 60000 });
  const [protectedRules, ...rules] = stdout.trim().split(/\r?\n/).map((line) => line.trim());
  assert.equal(protectedRules, "True", "inheritance is off");
  const sids = rules.map((rule) => rule.split(" ")[0]).sort();
  const { stdout: me } = await exec("whoami.exe", ["/user", "/fo", "csv", "/nh"], { windowsHide: true });
  assert.deepEqual(sids, ["S-1-5-18", "S-1-5-32-544", me.trim().match(/"(S-1-5-21-[\d-]+)"/)[1]].sort());
  assert.ok(rules.every((rule) => rule.endsWith(" False")), "nothing inherited");
  const log = fs.readFileSync(at("npm/node_modules/openclaw/log.jsonl"), "utf8");
  assert.doesNotMatch(log, /ABCDEFGHIJ/, "the token itself is never an argument");
});

test("real Windows: a timeout ends OpenClaw and what it started", { skip: windows, timeout: 60000 }, async (t) => {
  const at = layout(t, {
    "hang.mjs": `import { spawn } from "node:child_process"; import fs from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(child.pid)); setInterval(() => {}, 1000);`,
  });
  const pidFile = at("child.pid");
  // Long enough for a cold Node on a busy runner to have started its child.
  await assert.rejects(runTree(process.execPath, [at("hang.mjs"), pidFile], { timeout: 6000 }), (e) => e.killed === true);
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "the child it started ended too");
});
