import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createAgentAsks } from "../server/agent-sessions/agent-asks.mjs";
import { agentHookCommand, agentModeHookCommand, installClaudeHook } from "../server/agent-sessions/agent-hook-install.mjs";
import { prepareOwners } from "../server/windows-owners.mjs";
import { claudeConfig, claudeEnv, startStandIn } from "./helpers/standin-anthropic.mjs";

// The real Claude Code on a real Windows PC (GitHub's windows-2025 runner),
// its prompts answered from the phone exactly as on a Mac: Claude Code is
// installed with Anthropic's own installer, pointed at a stand-in Messages
// API (no account, a dummy key) that asks for a tool, and Reach's own hook,
// named pipe and pipe-owner check are in the loop. We check that Claude Code
// runs Reach's PermissionRequest hook over the pipe and that the phone's
// answer decides the tool call; and that a mode picked on the phone makes the
// mode hook ask. The runner has no Anthropic account, so the model's side is
// the stand-in; everything on Reach's side is real (parity rule 5). The whole
// flow was first validated on this Mac against the same stand-in with Claude
// Code 2.1.299.
const real = process.platform === "win32" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1";
const skip = real ? false : "needs a real Windows PC (REACH_TEST_WINDOWS_DESKTOP=1)";
const exec = promisify(execFile);
const hookScript = fileURLToPath(new URL("../scripts/agent-hook.mjs", import.meta.url));
const modeHookScript = fileURLToPath(new URL("../scripts/agent-mode-hook.mjs", import.meta.url));
const powershell = (script, env = {}) =>
  exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, timeout: 600000, maxBuffer: 32 << 20, env: { ...process.env, ...env } });
const until = async (check, ms, what) => {
  for (const end = Date.now() + ms; ; ) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) assert.fail(`${what} within ${ms / 1000}s`);
    await new Promise((r) => setTimeout(r, 200));
  }
};

// Install Claude Code with Anthropic's own installer once for both tests
// (into the runner's profile; only its config dir is this test's). Finds the
// launcher the installer made.
let installed = null;
function installClaude() {
  return (installed ||= (async () => {
    const out = await powershell("irm https://claude.ai/install.ps1 | iex; Write-Output DONE");
    assert.match(`${out.stdout}`, /Installation complete|DONE/, `${out.stdout}\n${out.stderr}`.slice(0, 2000));
    const candidates = [
      path.join(process.env.USERPROFILE || os.homedir(), ".local", "bin", "claude.exe"),
      path.join(os.homedir(), ".local", "bin", "claude.exe"),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
    const where = await powershell("(Get-Command claude -ErrorAction SilentlyContinue).Source").catch(() => ({ stdout: "" }));
    const found = `${where.stdout}`.trim().split(/\r?\n/).map((l) => l.trim()).find((l) => /claude(\.exe)?$/i.test(l));
    assert.ok(found && fs.existsSync(found), `claude.exe after install (looked in ${candidates.join(", ")})`);
    return found;
  })());
}

// Reach's side, all real: the pipe-owner check built with the PC's csc.exe,
// the pipe listener, and the hook written into Claude Code's settings in exec
// form. The session is shown and waited-on here (the live-session wiring is
// the Mac's, tested on a Mac); this proves the Windows pipe, hook and
// decision. Returns the things a test drives.
async function reachSide(t, { queueMode } = {}) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "reach-cc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, "reach");
  const configDir = path.join(dir, "claude-config");
  const work = path.join(dir, "work");
  for (const d of [dataDir, configDir, work]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(work, "seed.txt"), "the-seed-line\n");
  await prepareOwners(dataDir);
  const modesDir = path.join(dataDir, "pending-modes");
  const answers = [];
  const session = crypto.randomUUID();
  const asks = createAgentAsks({ platform: "win32", dataDir, modesDir, everyMs: 300, shows: async () => true, waiting: async () => true });
  await asks.listen();
  t.after(() => asks.close());
  if (queueMode) asks.queueMode("claude", session, queueMode);
  const command = agentHookCommand({ node: process.execPath, script: hookScript, agent: "claude", dataDir, platform: "win32" });
  const modeCommand = agentModeHookCommand({ node: process.execPath, script: modeHookScript, modesDir, platform: "win32" });
  fs.writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify(claudeConfig({ folders: [work] }), null, 2));
  installClaudeHook({ settingsPath: path.join(configDir, "settings.json"), command, modeCommand, backupDir: path.join(dir, "backups") });
  // The phone: allow any prompt Reach holds for this session.
  const watch = setInterval(() => {
    for (const prompt of asks.prompts?.("claude", session) || []) {
      try {
        asks.answer("claude", session, prompt.id, { decision: "allow" });
        answers.push({ id: prompt.id, tool: prompt.tool });
      } catch {
        /* already answered */
      }
    }
  }, 150);
  t.after(() => clearInterval(watch));
  return { dir, dataDir, configDir, work, session, asks, answers, pipe: asks.socketPath };
}

test("on real Windows, Claude Code runs Reach's hook over the pipe and the phone's answer decides the tool call", { skip, timeout: 1500000 }, async (t) => {
  const claude = await installClaude();
  const { dir, configDir, work, session, answers, pipe } = await reachSide(t);
  const report = { claude, pipe };
  t.after(() => {
    fs.mkdirSync("reports", { recursive: true });
    fs.writeFileSync("reports/windows-claude-hooks-e2e.json", JSON.stringify(report, null, 2));
  });
  // A Read of a file outside the chat's own folder: Claude Code always asks
  // for that in default mode, and it only runs if the permission is granted —
  // nothing else gates it (unlike a write, which Claude Code's own path
  // guards can stop after the hook). So whether the model gets the file's
  // text back is exactly whether the phone's allow decided the call.
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "notes.txt"), "the-proof-line\n");
  const stand = await startStandIn({ "read the notes": [{ name: "Read", input: { file_path: path.join(outside, "notes.txt") } }] });
  t.after(() => stand.close());
  const run = await exec(claude, ["-p", "Please read the notes file.", "--session-id", session, "--permission-mode", "default", "--output-format", "json"], {
    cwd: work,
    env: claudeEnv({ configDir, url: stand.url }),
    timeout: 180000,
    windowsHide: true,
    maxBuffer: 16 << 20,
  }).catch((error) => ({ error: String(error).slice(0, 500) }));
  report.answers = answers;
  report.results = stand.results("read the notes");
  report.run = run.error || "ok";

  // The hook reached Reach over the pipe, Reach held the request, and the
  // phone's allow decided it: Claude Code ran the Read and the model got the
  // file's text back, with no permission error.
  assert.ok(answers.some((a) => a.tool === "Read"), `the phone answered the Read prompt Reach held over the pipe (${JSON.stringify(answers)})`);
  assert.ok(stand.requests.some((r) => r.key === "read the notes"), "the stand-in model asked for the tool");
  await until(() => stand.results("read the notes").some((r) => !r.error && /the-proof-line/.test(r.text)), 10000, "the allowed Read ran and the file's text reached the model");
  assert.ok(!stand.results("read the notes").some((r) => r.error), `no permission error after the phone's allow: ${JSON.stringify(stand.results("read the notes"))}`);
});

test("on real Windows, a mode picked on the phone makes Reach's mode hook ask before the next tool call", { skip, timeout: 1500000 }, async (t) => {
  const claude = await installClaude();
  // A mode waiting for this chat: the mode hook must make Claude Code ask even
  // for a step the running mode wouldn't prompt for (a Read, in accept-edits).
  const { dataDir, configDir, work, session, asks, pipe } = await reachSide(t, { queueMode: "acceptEdits" });
  const report = { claude, pipe };
  t.after(() => {
    fs.mkdirSync("reports", { recursive: true });
    fs.writeFileSync("reports/windows-claude-hooks-mode.json", JSON.stringify(report, null, 2));
  });
  assert.equal(asks.queuedMode("claude", session), "acceptEdits", "Reach has the mode waiting");
  assert.ok(fs.existsSync(path.join(dataDir, "pending-modes", session)), "Reach wrote the waiting mode for the mode hook to find");
  const stand = await startStandIn({ "read the seed": [{ name: "Read", input: { file_path: path.join(work, "seed.txt") } }] });
  t.after(() => stand.close());
  // In -p a PreToolUse "ask" is answered by denial (no one can confirm), and
  // the denial carries the mode hook's reason: that is the mode hook asking.
  // (The full switch that the ask leads to needs an interactive session and
  // is covered on a Mac; here we prove the Windows mode hook asks.)
  const run = await exec(claude, ["-p", "Please read the seed file.", "--session-id", session, "--permission-mode", "acceptEdits", "--output-format", "json"], {
    cwd: work,
    env: claudeEnv({ configDir, url: stand.url }),
    timeout: 180000,
    windowsHide: true,
    maxBuffer: 16 << 20,
  }).catch((error) => ({ error: String(error).slice(0, 500) }));
  const results = stand.results("read the seed");
  report.results = results;
  report.run = run.error || "ok";

  // Accept-edits wouldn't prompt for this Read on its own; the mode hook made
  // Claude Code ask, and in -p that ask came back as the mode hook's reason.
  assert.ok(stand.requests.some((r) => r.key === "read the seed"), "the stand-in model asked for the Read");
  await until(() => stand.results("read the seed").some((r) => /permission mode picked on your phone/.test(r.text)), 20000, "the mode hook asked before the Read (its reason reached the model)");
});
