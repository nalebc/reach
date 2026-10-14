import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hasCommand, installLock, installPlan, installTerminalCommand, posixInstallNode } from "../server/agent-install.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// "Claude Code isn't installed" sent you to a web page to install it on the
// Mac yourself. Now the phone installs it: its maker's own command, shown
// first, run once you confirm, in a Reach terminal that ends with it.
test("each app's own installer, the one this Mac can run", async () => {
  const options = (tools) => ({ platform: "darwin", has: async (tool) => tools.includes(tool) });
  assert.deepEqual(await installPlan("claude", options([])), {
    agent: "claude",
    name: "Claude Code",
    command: "curl -fsSL --proto '=https' --tlsv1.2 https://claude.ai/install.sh | bash",
  });
  assert.equal((await installPlan("codex", options(["npm", "brew"]))).command, "npm install -g @openai/codex");
  assert.equal((await installPlan("codex", options(["brew"]))).command, "brew install --cask codex");
  await assert.rejects(installPlan("codex", options([])), (e) => e.status === 409 && /npm or Homebrew/.test(e.message));
  // Nothing else: no command from the phone, no other app.
  await assert.rejects(installPlan("rm -rf /", options(["npm"])), (e) => e.status === 400);
  await assert.rejects(installPlan("gemini", options(["npm"])), (e) => e.status === 400);
  await assert.rejects(installPlan("__proto__", options(["npm"])), (e) => e.status === 400);
});

test("Windows installers use PowerShell and Linux never offers a Homebrew cask", async () => {
  const available = async name => name === "npm";
  const claude = await installPlan("claude", { platform: "win32", has: available });
  assert.equal(claude.command, "irm https://claude.ai/install.ps1 | iex");
  const codex = await installPlan("codex", { platform: "win32", has: available });
  assert.equal(codex.command, "npm.cmd install -g @openai/codex");
  for (const plan of [claude, codex]) {
    const command = installTerminalCommand(plan, "win32");
    assert.match(command, /^\$ErrorActionPreference = 'Stop'; try \{/);
    assert.match(command, /catch \{.*exit 1/);
    assert.doesNotMatch(command, /pipefail|\| bash/);
  }
  assert.match(installTerminalCommand(codex, "win32"), /exit \$LASTEXITCODE/);
  await assert.rejects(installPlan("codex", { platform: "win32", has: async () => false }), error => error.status === 409 && /needs npm/.test(error.message));
  await assert.rejects(installPlan("codex", { platform: "linux", has: async name => name === "brew" }), error => error.status === 409 && !/Homebrew/.test(error.message));
});

// Claude Code on Windows runs on Git Bash (audit #7, Oct 12): Git for
// Windows from winget's own catalog, its agreements accepted on the phone
// (a Reach terminal can't answer winget's questions), its exit code the
// install's. Only Windows needs it, so only Windows offers it.
test("Git for Windows installs with winget on Windows, and nowhere else", async () => {
  const git = await installPlan("git", { platform: "win32", has: async (name) => name === "winget" });
  assert.deepEqual(git, {
    agent: "git",
    name: "Git for Windows",
    command: "winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements",
  });
  assert.equal(
    installTerminalCommand(git, "win32"),
    "$ErrorActionPreference = 'Stop'; try { winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }",
  );
  await assert.rejects(installPlan("git", { platform: "win32", has: async () => false }), (e) => e.status === 409 && e.message === "Install Git for Windows needs winget (Windows' App Installer) on this Windows PC.");
  for (const platform of ["darwin", "linux"]) await assert.rejects(installPlan("git", { platform, has: async () => true }), (e) => e.status === 400, platform);
  // Claude Code's own installer is a script, which sets no exit code.
  assert.match(installTerminalCommand(await installPlan("claude", { platform: "win32", has: async () => true }), "win32"), /; exit 0 \}/);
});

test("installer prerequisites are queried using the selected platform's shell", async () => {
  const calls = [];
  const run = async (...args) => { calls.push(args); return { stdout: "C:\\Program Files\\nodejs\\npm.cmd\r\n" }; };
  assert.equal(await hasCommand("npm", run, { platform: "win32", env: {} }), true);
  assert.equal(calls[0][0], "powershell.exe");
  assert.match(calls[0][1].at(-1), /Get-Command -Name 'npm\.cmd'/);
  assert.equal(await hasCommand("npm; anything", run, { platform: "win32" }), false);
  assert.equal(calls.length, 1);
  assert.equal(await hasCommand("npm", async (command, args) => {
    assert.equal(command, "/bin/sh"); assert.deepEqual(args, ["-lc", "command -v npm"]);
    return { stdout: "/usr/bin/npm\n" };
  }, { platform: "linux", env: {} }), true);
});

test("PowerShell installer wrappers preserve success and failure without executing an installer", { skip: process.platform !== "win32" }, () => {
  const node = process.execPath.replaceAll("'", "''");
  // Windows PowerShell 5.1 can take well over ten seconds to start on a busy
  // hosted runner; a timeout here surfaced as a null status, not as a hang.
  for (const [plan, expected] of [
    [{ agent: "claude", command: "Write-Output 'synthetic success'" }, 0],
    [{ agent: "claude", command: "throw 'synthetic failure'" }, 1],
    [{ agent: "codex", command: `& '${node}' -e 'process.exit(23)'` }, 23],
    // A program's own failure (winget's, an update's) fails the install.
    [{ agent: "git", command: `& '${node}' -e 'process.exit(5)'` }, 5],
    [{ agent: "claude", command: `& '${node}' -e 'process.exit(0)'` }, 0],
  ]) {
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", installTerminalCommand(plan, "win32")], { encoding: "utf8", timeout: 60_000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, expected, result.stderr);
  }
});

test("revocation during asynchronous installer lookup cannot start a terminal", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-install-revoked-"));
  let lookupStarted, finishLookup;
  const started = new Promise(resolve => { lookupStarted = resolve; });
  const release = new Promise(resolve => { finishLookup = resolve; });
  const created = [];
  const reach = await createReach({ roots: [root], dataDir: path.join(root, ".reach"), screen: false,
    agentInstallPlan: async agent => { lookupStarted(); await release; return { agent, name: "Codex", command: "synthetic-installer-never-run" }; },
    terminals: { create: options => { created.push(options); return { id: "forbidden" }; }, list: () => [], get: () => null, dispose: () => {} },
  });
  t.after(async () => { finishLookup(); await reach.close(); await fs.rm(root, { recursive: true, force: true }); });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  const owner = reach.auth.issue("Owner", ALL_SCOPES);
  const result = fetch(`http://127.0.0.1:${reach.server.address().port}/api/sessions/agent-install/codex`, {
    method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ confirm: true }),
  });
  await started;
  reach.auth.revoke(owner.clientId);
  finishLookup();
  assert.equal((await result).status, 401);
  assert.deepEqual(created, []);
});

test("installing from the phone: shown first, run once confirmed, the owner's own devices only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-install-"));
  const created = [];
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: { list: async () => ({ sessions: [], errors: {} }), health: async () => [] },
    terminals: {
      create: (options) => (created.push(options), { id: "t1", name: options.name, status: "running" }),
      list: () => [],
      get: () => null,
      dispose: () => {},
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["terminal", "files"], "agent");
  const other = reach.auth.issue("linked", ALL_SCOPES, "linked-mac");
  const install = (token, body = {}, app = "claude") =>
    fetch(`${url}/api/sessions/agent-install/${app}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await install(agent.token, { confirm: true })).status, 403);
    assert.equal((await install(other.token, { confirm: true })).status, 403);
    assert.deepEqual(created, []);
    // Shown first: nothing runs.
    const plan = await install(owner.token);
    assert.equal(plan.status, 200);
    const expectedPlan = { agent: "claude", name: "Claude Code", command: process.platform === "win32" ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL --proto '=https' --tlsv1.2 https://claude.ai/install.sh | bash" };
    assert.deepEqual(await plan.json(), expectedPlan);
    assert.deepEqual(created, []);
    // Confirmed: in a terminal of its own, which ends with the install.
    const started = await install(owner.token, { confirm: true });
    assert.equal(started.status, 200);
    assert.equal((await started.json()).terminal.id, "t1");
    assert.deepEqual(
      created.map(({ cwd, name, command }) => ({ cwd, name, command })),
      [{ cwd: os.homedir(), name: "Install Claude Code", command: installTerminalCommand(expectedPlan) }],
    );
    assert.equal((await install(owner.token, { confirm: true }, "anything")).status, 400);
  } finally {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an install that can't start answers with why, and Reach keeps running", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-install-fail-"));
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: { list: async () => ({ sessions: [], errors: {} }), health: async () => [] },
    terminals: {
      // The Mac couldn't open a terminal (a shell that won't start, say).
      create: () => {
        throw new Error("posix_spawnp failed.");
      },
      list: () => [],
      get: () => null,
      dispose: () => {},
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const install = (body, app = "claude") =>
    fetch(`${url}/api/sessions/agent-install/${app}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const failed = await install({ confirm: true });
    assert.ok(failed.status >= 400);
    assert.equal(typeof (await failed.json()).error, "string");
    // The install lock let go: a retry isn't "already installing".
    assert.notEqual((await install({ confirm: true })).status, 409);
    // Still answering.
    assert.equal((await install({})).status, 200);
  } finally {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// OpenClaw 2026.9 refuses Node older than 24.16: its npm install runs with
// Homebrew's node@24 first on PATH, and the phone never sees that shell text.
// A Mac installs OpenClaw with its own installer, as Windows does (owner,
// Oct 13): install.sh asks npm's version (npm 12 blocks OpenClaw's own
// scripts unless told) and checks Node. A Mac whose Node OpenClaw can't use
// gets OpenClaw's own Node first (install-cli.sh --node-only), said on the
// phone in the same words as on a PC; the Mac's own Node is kept.
const INSTALL_SH = "curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard";
const macNode = (over = {}) => async () => ({ version: "22.12.0", supported: false, runtime: null, prefix: "/Users/ann/.openclaw/tools/cli-node", bin: "/Users/ann/.openclaw/tools/cli-node/tools/node/bin", privateReady: false, ...over });
test("OpenClaw on a Mac: its own installer; Homebrew's node@24 leads when there; OpenClaw's own Node added when the Mac's is too old", async () => {
  const ready = await installPlan("openclaw", { platform: "darwin", node: macNode({ version: "24.21.0", supported: true }) });
  assert.deepEqual(ready, { agent: "openclaw", name: "OpenClaw", command: INSTALL_SH });
  assert.equal(installTerminalCommand(ready, "darwin"), `set -o pipefail; ${INSTALL_SH}; exit`);
  const runtime = "/opt/homebrew/opt/node@24/bin/node";
  const brew = await installPlan("openclaw", { platform: "darwin", node: macNode({ runtime }) });
  assert.equal(installTerminalCommand(brew, "darwin"),
    `set -o pipefail; export PATH='/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin':"$PATH"; ${INSTALL_SH}; exit`);
  assert.equal(brew.note, undefined, "nothing is added");
  const old = await installPlan("openclaw", { platform: "darwin", node: macNode() });
  assert.equal(old.command, INSTALL_SH, "the phone shows the maker's command");
  assert.equal(old.note, "OpenClaw needs Node 24.16 or newer, and this Mac has Node 22.12.0. Reach adds a Node for OpenClaw only first, with OpenClaw's own installer, and keeps this Mac's Node as it is.");
  assert.match(old.lead, /install-cli\.sh \| bash -s -- --node-only --prefix '\/Users\/ann\/\.openclaw\/tools\/cli-node' \|\| exit 1; export PATH='\/Users\/ann\/\.openclaw\/tools\/cli-node\/tools\/node\/bin':"\$PATH"$/);
  // Its own Node there already: led on PATH, nothing added, nothing to say.
  const kept = await installPlan("openclaw", { platform: "darwin", node: macNode({ privateReady: true }) });
  assert.equal(kept.note, undefined);
  assert.doesNotMatch(kept.lead, /node-only/);
  // Reach's own private Node isn't the Mac's: the note names no version.
  assert.match((await installPlan("openclaw", { platform: "darwin", node: macNode({ version: null }) })).note, /^OpenClaw needs Node 24\.16 or newer\. Reach adds/);
  const codex = await installPlan("codex", { platform: "darwin", has: async () => true, findRuntime: async () => runtime });
  assert.equal(codex.lead, undefined);
});

test("the Mac's Node as a Reach terminal finds it: its own, not Reach's private one; OpenClaw's own Node when it's there", async () => {
  const probe = (stdout) => async (file, args) => {
    assert.deepEqual(args.slice(0, 1), ["-lc"]);
    return { stdout };
  };
  const base = { platform: "darwin", env: { SHELL: "/bin/zsh", HOME: "/Users/ann" }, findRuntime: async () => null };
  const own = await posixInstallNode({ ...base, run: probe("/opt/homebrew/bin/node\n22.12.0\n"), version: async () => null });
  assert.deepEqual([own.version, own.supported, own.privateReady], ["22.12.0", false, false]);
  const reach = await posixInstallNode({ ...base, run: probe("/Users/ann/reach/.reach/runtime/node-v22.23.3-darwin-arm64/bin/node\n22.23.3\n"), version: async () => "24.21.0" });
  assert.deepEqual([reach.version, reach.supported, reach.privateReady], [null, false, true]);
  const none = await posixInstallNode({ ...base, run: async () => { throw Object.assign(new Error("no node"), { code: 1 }); }, version: async () => null });
  assert.deepEqual([none.version, none.supported], [null, false]);
  assert.equal(none.bin, path.join(none.prefix, "tools", "node", "bin"));
});

// The lead is typed into the owner's own shell: zsh on a Mac, often bash.
// Run as typed, with stand-ins for npm, brew and curl: npm's global folder
// is the Mac's own npm's; Reach's private npm falls back to Homebrew's; with
// neither, or when OpenClaw's Node-only installer fails, the terminal ends
// before install.sh runs (whose own way would `brew install node` and
// `brew link --overwrite`, replacing the Mac's Node).
const shells = ["/bin/zsh", "/bin/bash"].filter((shell) => fsSync.existsSync(shell));
test("the Mac's install lead, run by zsh and bash as typed", { skip: process.platform === "win32" && "a Mac's shells" }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-openclaw-lead-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin");
  await fs.mkdir(bin);
  const log = path.join(dir, "log.txt");
  const stub = async (name, text) => fs.writeFile(path.join(bin, name), `#!/bin/sh\n${text}\n`, { mode: 0o755 });
  await stub("npm", '[ "$1 $2" = "prefix -g" ] && [ -n "$STUB_NPM" ] && { echo "$STUB_NPM"; exit 0; }; exit 1');
  await stub("brew", '[ "$1" = "--prefix" ] && [ -n "$STUB_BREW" ] && { echo "$STUB_BREW"; exit 0; }; exit 1');
  // curl prints what bash then runs: the Node-only step, or install.sh.
  await stub("curl", `case "$*" in *install-cli.sh*) printf '%s\\n' 'echo "node-only $*" >> "$STUB_LOG"; exit \${STUB_NODE_EXIT:-0}' ;; *install.sh*) printf '%s\\n' 'echo "install.sh $* prefix=$NPM_CONFIG_PREFIX path=$PATH" >> "$STUB_LOG"' ;; esac`);
  const plan = await installPlan("openclaw", { platform: "darwin", node: macNode({ prefix: path.join(dir, "cli-node"), bin: path.join(dir, "cli-node", "tools", "node", "bin") }) });
  const typed = installTerminalCommand(plan, "darwin");
  const runIn = (shell, extra) => {
    fsSync.rmSync(log, { force: true });
    const result = spawnSync(shell, ["-c", typed], { encoding: "utf8", timeout: 30000, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, STUB_LOG: log, ...extra } });
    const lines = fsSync.existsSync(log) ? fsSync.readFileSync(log, "utf8").trim().split("\n") : [];
    return { status: result.status, stderr: result.stderr, lines };
  };
  assert.ok(shells.length, "a POSIX shell to run it");
  for (const shell of shells) {
    const own = runIn(shell, { STUB_NPM: "/opt/homebrew", STUB_BREW: "/opt/homebrew" });
    assert.equal(own.status, 0, `${shell}: ${own.stderr}`);
    assert.match(own.lines[0], new RegExp(`^node-only --node-only --prefix ${path.join(dir, "cli-node").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), shell);
    assert.match(own.lines[1], /^install\.sh --no-prompt --no-onboard prefix=\/opt\/homebrew path=/, shell);
    assert.ok(own.lines[1].includes(`path=${path.join(dir, "cli-node", "tools", "node", "bin")}:`), `${shell}: OpenClaw's own Node first on PATH`);
    const reachNpm = runIn(shell, { STUB_NPM: "/Users/ann/reach/.reach/runtime/node-v22.23.3-darwin-arm64", STUB_BREW: "/usr/local" });
    assert.equal(reachNpm.status, 0, shell);
    assert.match(reachNpm.lines[1], /prefix=\/usr\/local /, `${shell}: Reach's npm isn't the Mac's`);
    const neither = runIn(shell, { STUB_NPM: "/Users/ann/reach/.reach/runtime/node-v22.23.3-darwin-arm64" });
    assert.equal(neither.status, 1, shell);
    assert.deepEqual(neither.lines, [], `${shell}: nothing installed`);
    assert.match(neither.stderr, /This Mac has no npm of its own to install OpenClaw with/);
    const failed = runIn(shell, { STUB_NPM: "/opt/homebrew", STUB_NODE_EXIT: "3" });
    assert.notEqual(failed.status, 0, shell);
    assert.equal(failed.lines.length, 1, `${shell}: install.sh never runs after a failed Node-only step`);
  }
});

test("one install per app at a time: planning or a running terminal holds it", () => {
  const status = new Map();
  const lock = installLock((id) => status.get(id) !== "exited");
  assert.equal(lock.take("openclaw"), true);
  assert.equal(lock.take("openclaw"), false); // still being planned
  assert.equal(lock.take("codex"), true); // another app is its own
  lock.release("codex");
  lock.started("openclaw", "t1");
  status.set("t1", "running");
  assert.equal(lock.take("openclaw"), false);
  status.set("t1", "exited");
  assert.equal(lock.take("openclaw"), true);
});

test("two phones confirming the same install at once: only one terminal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-install-lock-"));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const created = [];
  const reach = await createReach({
    roots: [root], dataDir: path.join(root, ".reach"), screen: false,
    agentSessions: { list: async () => ({ sessions: [], errors: {} }), health: async () => [] },
    // Its lead as each computer's installs write one: shell text on a Mac,
    // PowerShell on Windows (OpenClaw's own Node first: agent-install.mjs).
    agentInstallPlan: async (agent) => { await gate; return { agent, name: "OpenClaw", command: "synthetic-installer-never-run", lead: process.platform === "win32" ? "& 'C:\\x\\node-only.ps1'" : "export PATH='/x':\"$PATH\"" }; },
    terminals: {
      create: (options) => (created.push(options), { id: `t${created.length}`, status: "running" }),
      list: () => [], get: (id) => ({ id, status: "running" }), dispose: () => {},
    },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const install = (body) => fetch(`http://127.0.0.1:${reach.server.address().port}/api/sessions/agent-install/openclaw`, {
    method: "POST", headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    const first = install({ confirm: true });
    const second = await install({ confirm: true });
    assert.equal(second.status, 409);
    release();
    const done = await first;
    assert.equal(done.status, 200);
    const body = await done.json();
    assert.equal(body.lead, undefined); // shell text stays on the Mac
    assert.equal(created.length, 1);
    assert.match(created[0].command, process.platform === "win32"
      // The program's own exit code (only Claude Code's irm | iex installer says 0).
      ? /^\$ErrorActionPreference = 'Stop'; try \{ & 'C:\\x\\node-only\.ps1'; synthetic-installer-never-run; exit \$LASTEXITCODE/
      : /^set -o pipefail; export PATH='\/x'/);
    // Its terminal still runs: a third confirm waits too; showing the plan doesn't.
    assert.equal((await install({ confirm: true })).status, 409);
    assert.equal((await install({})).status, 200);
  } finally {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
