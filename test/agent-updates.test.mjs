import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeChannel, compareVersions, createAgentUpdates, feedFor, managerOf, parseVersion, readFeed } from "../server/agent-updates.mjs";
import { installTerminalCommand } from "../server/agent-install.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// "Add ability to update claude and codex if newer versions is available,
// but … we will not fail open" (Oct 8). An update is offered only when every
// reading is one Reach understands; anything else offers nothing.

test("versions compare as semver: a prerelease before its release, numeric parts as numbers", () => {
  assert.equal(compareVersions("2.1.291", "2.1.295"), -1);
  assert.equal(compareVersions("2.1.295", "2.1.295"), 0);
  assert.equal(compareVersions("2.10.0", "2.9.9"), 1);
  // The Codex bundled with ChatGPT on Oct 8 against npm's latest and Codex's
  // own cached latest.
  assert.equal(compareVersions("0.162.0-alpha.2", "0.162.0"), -1);
  assert.equal(compareVersions("0.162.0-alpha.2", "0.161.0"), 1);
  assert.equal(compareVersions("1.0.0-alpha.10", "1.0.0-alpha.2"), 1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareVersions("1.0.0+build.5", "1.0.0"), 0);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
});

test("anything that isn't exactly a version is unknown, never older or newer", () => {
  for (const bad of ["", "latest", "2.1", "2.1.295 (Claude Code)", "2.1.295\n2.1.296", "01.2.3", "1.2.3-01", "1.2.3-", "<html>", "9".repeat(120), null, undefined, 2, {}])
    assert.equal(parseVersion(bad), null, String(bad));
  assert.equal(compareVersions("2.1.291", "soon"), null);
  assert.equal(compareVersions(null, "2.1.295"), null);
});

test("who updates a copy is read from where it really lives; unknown places get nothing", () => {
  const home = "/Users/me";
  const at = (target) => ({ real: () => target, home, platform: "darwin" });
  assert.deepEqual(managerOf("claude", "/Users/me/.local/bin/claude", at("/Users/me/.local/share/claude/versions/2.1.291")), {
    manager: "native",
    channelFeed: true,
    command: "'/Users/me/.local/bin/claude' update",
  });
  assert.equal(managerOf("claude", "/opt/homebrew/bin/claude", at("/opt/homebrew/Caskroom/claude-code/2.1.286/claude")).command, "brew upgrade --cask claude-code");
  assert.equal(managerOf("claude", "/opt/homebrew/bin/claude", at("/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js")).manager, "npm");
  assert.equal(managerOf("codex", "/opt/homebrew/bin/codex", at("/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js")).command, "npm install -g --prefix '/opt/homebrew' @openai/codex@latest");
  assert.equal(managerOf("codex", "/Users/me/.nvm/versions/node/v24/bin/codex", at("/Users/me/.nvm/versions/node/v24/lib/node_modules/@openai/codex/bin/codex.js")).command, "npm install -g --prefix '/Users/me/.nvm/versions/node/v24' @openai/codex@latest");
  assert.equal(managerOf("codex", "/work/node_modules/.bin/codex", at("/work/node_modules/@openai/codex/bin/codex.js")), null, "a project-local Codex must not update an unrelated global installation");
  assert.equal(managerOf("codex", "/opt/homebrew/bin/codex", at("/opt/homebrew/Caskroom/codex/0.162.0/codex")).command, "brew upgrade --cask codex");
  // Inside an app: the app updates it.
  assert.deepEqual(
    managerOf("codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", at("/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex")),
    { manager: "app", app: "ChatGPT" },
  );
  // Somewhere else, a path that can't be quoted, a link that can't be
  // followed: nothing.
  assert.equal(managerOf("claude", "/usr/local/bin/claude", at("/usr/local/bin/claude")), null);
  assert.equal(managerOf("codex", "/Users/me/bin/codex", at("/Users/me/bin/codex")), null);
  assert.equal(managerOf("claude", "/Users/me/it's/claude", at("/Users/me/.local/share/claude/versions/2.1.291")), null);
  assert.equal(managerOf("claude", "relative/claude", at("/Users/me/.local/share/claude/versions/2.1.291")), null);
  assert.equal(managerOf("claude", "/Users/me/.local/bin/claude", { real: () => { throw new Error("ENOENT"); }, home, platform: "darwin" }), null);
  assert.equal(managerOf("gemini", "/opt/homebrew/bin/gemini", at("/opt/homebrew/lib/node_modules/@google/gemini-cli/x.js")), null);
});

// Oct 12 (audit #33): Windows offered no update and said nothing. The same
// decisions as a Mac's, as PowerShell (Reach's terminals there) runs them.
test("on Windows, Claude Code's native and npm copies update themselves and npm's global Codex updates in place", () => {
  const home = "C:\\Users\\me";
  const env = { AppData: "C:\\Users\\me\\AppData\\Roaming" };
  const node = "C:\\Program Files\\nodejs\\node.exe";
  const win = (file, target = file) => ({ real: () => target, home, env, node, platform: "win32" });
  const npm = "C:\\Users\\me\\AppData\\Roaming\\npm";
  assert.deepEqual(managerOf("claude", "C:\\Users\\me\\.local\\bin\\claude.exe", win("C:\\Users\\me\\.local\\bin\\claude.exe")), {
    manager: "native",
    channelFeed: true,
    command: "& 'C:\\Users\\me\\.local\\bin\\claude.exe' update",
  });
  // Found in another case, as Windows names don't care.
  assert.equal(managerOf("claude", "c:\\users\\ME\\.local\\bin\\CLAUDE.EXE", win("c:\\users\\ME\\.local\\bin\\CLAUDE.EXE")).manager, "native");
  assert.equal(managerOf("claude", "C:\\Users\\me\\.local\\bin\\claude.exe", win("C:\\Users\\me\\.local\\bin\\claude.exe", "C:\\Users\\me\\.local\\share\\claude\\versions\\2.1.291")).manager, "native");
  // npm's: its own claude.exe, or its script started with Reach's Node (never Windows' script host).
  const exe = `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
  assert.deepEqual(managerOf("claude", exe, win(exe)), { manager: "npm", channelFeed: true, command: `& '${exe}' update` });
  const script = `${npm}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
  assert.equal(managerOf("claude", script, win(script)).command, `& '${node}' '${script}' update`);
  // Codex from npm's global folder: its script, the native codex.exe in its package or beside it.
  const update = { manager: "npm", package: "@openai/codex", command: `npm.cmd install -g --prefix '${npm}' '@openai/codex@latest'` };
  for (const found of [
    `${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`,
    `${npm}\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`,
    `${npm}\\node_modules\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\bin\\codex.exe`,
  ])
    assert.deepEqual(managerOf("codex", found, win(found)), update, found);
  // No APPDATA: the folder Windows gives it.
  assert.deepEqual(managerOf("codex", `${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`, { ...win(`${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`), env: {} }), update);
  // Anywhere else nothing: a project's node_modules (the same layout on
  // Windows), a copy Reach can't tell, a path PowerShell's quotes can't
  // hold, a link that can't be followed, a share.
  for (const [agent, file, target] of [
    ["codex", "D:\\work\\node_modules\\@openai\\codex\\bin\\codex.js"],
    ["codex", `${npm}\\node_modules\\@openai\\codex-other\\codex.exe`],
    ["codex", `${npm}\\codex.exe`],
    ["claude", "C:\\claude.exe"],
    ["claude", "C:\\Users\\me\\.local\\bin\\other.exe"],
    ["claude", "C:\\Users\\O'Brien\\.local\\bin\\claude.exe"],
    ["claude", "C:\\Users\\me\\.local\\bin\\claude.exe", "C:\\Users\\me’s\\claude.exe"],
    ["claude", "\\\\server\\share\\claude.exe"],
    ["claude", "relative\\claude.exe"],
    ["gemini", `${npm}\\node_modules\\@google\\gemini-cli\\dist\\index.js`],
  ])
    assert.equal(managerOf(agent, file, win(file, target ?? file)), null, `${agent} ${file}`);
  assert.equal(managerOf("claude", "C:\\Users\\me\\.local\\bin\\claude.exe", { ...win("x"), real: () => { throw new Error("ENOENT"); } }), null);
  assert.equal(managerOf("claude", script, { ...win(script), node: "C:\\it's\\node.exe" }), null, "a Node PowerShell can't quote");
  // As PowerShell runs it in a Reach terminal: the program's own exit code.
  assert.equal(
    installTerminalCommand({ agent: "codex", ...update }, "win32"),
    `$ErrorActionPreference = 'Stop'; try { npm.cmd install -g --prefix '${npm}' '@openai/codex@latest'; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`,
  );
  assert.match(installTerminalCommand({ agent: "claude", command: `& '${exe}' update` }, "win32"), /update; exit \$LASTEXITCODE \}/);
});

test("Claude's channel is its setting's, latest unless set; an unknown one isn't guessed", () => {
  const read = (text) => ({ readFile: () => text });
  assert.equal(claudeChannel(read("{}")), "latest");
  assert.equal(claudeChannel(read('{"autoUpdatesChannel":"stable"}')), "stable");
  assert.equal(claudeChannel(read('{"autoUpdatesChannel":"nightly"}')), null);
  assert.equal(claudeChannel(read('{"autoUpdatesChannel":3}')), null);
  assert.equal(claudeChannel(read("{not json")), null);
  assert.equal(claudeChannel({ readFile: () => { throw Object.assign(new Error("none"), { code: "ENOENT" }); } }), "latest");
  assert.equal(claudeChannel({ readFile: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } }), null);
  assert.equal(feedFor("claude", { manager: "native", channelFeed: true }, { channel: () => null }), null);
  assert.equal(feedFor("claude", { manager: "native", channelFeed: true }, { channel: () => "stable" }).url, "https://downloads.claude.ai/claude-code-releases/stable");
});

test("a feed counts only when it answers exactly a version, in time and in size", async () => {
  const answer = (body, init = {}) => async () => ({ ok: init.ok ?? true, headers: new Map(Object.entries(init.headers || {})), text: async () => body });
  const plain = (t) => t.trim();
  const tags = feedFor("codex", { manager: "npm", package: "@openai/codex" }).pick;
  assert.equal(await readFeed("u", plain, { fetch: answer("2.1.295\n") }), "2.1.295");
  assert.equal(await readFeed("u", tags, { fetch: answer('{"latest":"0.162.0","alpha":"0.163.0-alpha.1"}') }), "0.162.0");
  for (const [what, fetch] of [
    ["an error page", answer("<html>Service unavailable</html>")],
    ["not ok", answer("2.1.295", { ok: false })],
    ["a channel name", answer("latest")],
    ["two versions", answer("2.1.295\n2.1.296")],
    ["no latest tag", answer('{"next":"9.9.9"}')],
    ["a number", answer('{"latest":2}')],
    ["an array", answer('["9.9.9"]')],
    ["broken JSON", answer('{"latest":"9.9.9"')],
    ["too long", answer("x".repeat(600 * 1024))],
    ["too long, said up front", answer("2.1.295", { headers: { "content-length": String(10 * 1024 * 1024) } })],
    ["offline", async () => { throw new TypeError("fetch failed"); }],
  ])
    assert.equal(await readFeed("u", what.includes("JSON") || what.includes("tag") || what.includes("number") || what.includes("array") ? tags : plain, { fetch }), null, what);
});

const fakeUpdates = ({ file = "/Users/me/.local/bin/claude", version = "2.1.291", how = { manager: "native", channelFeed: true, command: "'/Users/me/.local/bin/claude' update" }, newest = "2.1.295", reads = [] } = {}) =>
  createAgentUpdates({
    locate: { claude: async () => file, codex: async () => null },
    probe: async () => ({ version }),
    manager: () => how,
    feed: () => ({ url: "feed", pick: (t) => t }),
    read: async (url) => (reads.push(url), newest),
  });

test("an update is offered only when the published version is strictly newer", async () => {
  assert.deepEqual(await fakeUpdates().status("claude"), {
    agent: "claude", name: "Claude Code", state: "available", manager: "native", installed: "2.1.291", latest: "2.1.295",
    file: "/Users/me/.local/bin/claude", command: "'/Users/me/.local/bin/claude' update",
  });
  assert.equal((await fakeUpdates({ newest: "2.1.291" }).status("claude")).state, "current");
  assert.equal((await fakeUpdates({ newest: "2.1.200" }).status("claude")).state, "current");
  assert.equal((await fakeUpdates({ version: "0.162.0-alpha.2", newest: "0.161.0" }).status("claude")).state, "current");
  for (const [what, options] of [
    ["the feed can't be read", { newest: null }],
    ["its version can't be read", { version: "Claude Code (dev build)" }],
    ["no version at all", { version: null }],
    ["an unknown place", { how: null }],
    ["not installed", { file: null }],
  ]) {
    const s = await fakeUpdates(options).status("claude");
    assert.ok(["unknown", "missing"].includes(s.state), what);
    assert.equal(s.command, undefined, what);
    await assert.rejects(fakeUpdates(options).plan("claude"), (e) => e.status === 409, what);
  }
  const app = await fakeUpdates({ how: { manager: "app", app: "ChatGPT" } });
  assert.equal((await app.status("claude")).state, "app");
  await assert.rejects(app.plan("claude"), (e) => e.status === 409 && /updates with the ChatGPT app/.test(e.message));
  await assert.rejects(fakeUpdates({ newest: "2.1.291" }).plan("claude"), (e) => e.status === 409 && /up to date/.test(e.message));
  await assert.rejects(fakeUpdates().status("rm -rf /"), (e) => e.status === 400);
  await assert.rejects(fakeUpdates().status("__proto__"), (e) => e.status === 400);
  assert.deepEqual(await fakeUpdates().plan("claude"), { agent: "claude", name: "Claude Code", command: "'/Users/me/.local/bin/claude' update", from: "2.1.291", to: "2.1.295" });
});

test("a published version is kept a while; a failed look is retried sooner", async () => {
  let clock = 0, answers = [null, "2.1.295"];
  const reads = [];
  const updates = createAgentUpdates({
    locate: { claude: async () => "/c", codex: async () => null },
    probe: async () => ({ version: "2.1.291" }),
    manager: () => ({ manager: "native", channelFeed: true, command: "'/c' update" }),
    feed: () => ({ url: "feed", pick: (t) => t }),
    read: async (url) => (reads.push(url), answers.shift()),
    now: () => clock,
    ttlMs: 1000,
    failedTtlMs: 10,
  });
  assert.equal((await updates.status("claude")).state, "unknown");
  clock = 5;
  assert.equal((await updates.status("claude")).state, "unknown");
  assert.equal(reads.length, 1);
  clock = 20;
  assert.equal((await updates.status("claude")).state, "available");
  clock = 500;
  await updates.status("claude");
  assert.equal(reads.length, 2);
});

test("updating from the phone: shown first, run once confirmed, the owner's own devices only", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-update-"));
  const created = [];
  let offered = true;
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: { list: async () => ({ sessions: [], errors: {} }), health: async () => [] },
    agentUpdates: {
      list: async () => [{ agent: "claude", name: "Claude Code", state: "available", installed: "2.1.291", latest: "2.1.295", file: "/secret/path", command: "x" }],
      plan: async (agent) => {
        if (agent !== "claude") throw Object.assign(new Error("Reach can't update that app."), { status: 400 });
        if (!offered) throw Object.assign(new Error("Claude Code is up to date."), { status: 409 });
        return { agent, name: "Claude Code", command: "'/Users/me/.local/bin/claude' update", from: "2.1.291", to: "2.1.295" };
      },
    },
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
  const update = (token, body = {}, app = "claude") =>
    fetch(`${url}/api/sessions/agent-update/${app}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const list = await (await fetch(`${url}/api/sessions/agent-updates`, { headers: { Authorization: `Bearer ${owner.token}` } })).json();
    assert.equal(list.agents[0].state, "available");
    assert.equal(list.agents[0].file, undefined);
    assert.equal((await update(agent.token, { confirm: true })).status, 403);
    assert.equal((await update(other.token, { confirm: true })).status, 403);
    const plan = await update(owner.token);
    assert.equal(plan.status, 200);
    assert.equal((await plan.json()).to, "2.1.295");
    assert.deepEqual(created, []);
    const started = await update(owner.token, { confirm: true });
    assert.equal((await started.json()).terminal.id, "t1");
    assert.deepEqual(
      created.map(({ cwd, name, command }) => ({ cwd, name, command })),
      [{ cwd: os.homedir(), name: "Update Claude Code", command: installTerminalCommand({ agent: "claude", command: "'/Users/me/.local/bin/claude' update" }) }],
    );
    // No longer offered (it's current now): nothing runs.
    offered = false;
    assert.equal((await update(owner.token, { confirm: true })).status, 409);
    assert.equal((await update(owner.token, { confirm: true }, "anything")).status, 400);
    assert.equal(created.length, 1);
  } finally {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
