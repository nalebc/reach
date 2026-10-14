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
import { ensurePtyHelper, loadPty } from "../server/pty-helper.mjs";
import { claudeConfig, claudeEnv, startStandIn } from "./helpers/standin-anthropic.mjs";

// The real Claude Code on a real Windows PC (GitHub's windows-2025 runner),
// its prompts answered from the phone exactly as on a Mac: Claude Code is
// installed with Anthropic's own installer, pointed at a stand-in Messages
// API (no account, a dummy key) that asks for a tool needing permission, and
// Reach's own hook, pipe and pipe-owner check are in the loop. We check that
// Claude Code runs Reach's PermissionRequest hook over the pipe and that the
// phone's answer, not Claude Code's dialog, decides the tool call; and that a
// mode picked on the phone makes the mode hook ask. The runner has no
// Anthropic account, so the model's side is the stand-in; everything on
// Reach's side is real (docs/WINDOWS_AGENT_PARITY.md rule 5).
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

// Installs Claude Code with Anthropic's own installer once, into this test's
// own CLAUDE_CONFIG_DIR, and finds claude.exe. Only when this file runs.
async function installClaude(configDir) {
  // irm https://claude.ai/install.ps1 | iex, as the docs give it, writing the
  // launcher under the test's config dir (not the runner's own profile).
  const out = await powershell("irm https://claude.ai/install.ps1 | iex; Write-Output DONE", { CLAUDE_CONFIG_DIR: configDir });
  assert.match(`${out.stdout}`, /Installation complete|DONE/, out.stderr?.slice(0, 2000));
  const candidates = [
    path.join(os.homedir(), ".local", "bin", "claude.exe"),
    path.join(process.env.USERPROFILE || os.homedir(), ".local", "bin", "claude.exe"),
    path.join(configDir, "bin", "claude.exe"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  // Else ask the shell where it landed on PATH.
  const where = await powershell("(Get-Command claude -ErrorAction SilentlyContinue).Source", { CLAUDE_CONFIG_DIR: configDir }).catch(() => ({ stdout: "" }));
  const found = `${where.stdout}`.trim().split(/\r?\n/).find((line) => /claude(\.exe)?$/i.test(line.trim()));
  assert.ok(found && fs.existsSync(found), `claude.exe after install (looked in ${candidates.join(", ")})`);
  return found;
}

test("on real Windows, Claude Code runs Reach's hook over the pipe and the phone's answer decides the tool call", { skip, timeout: 1500000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "reach-cc-e2e-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, "reach");
  const configDir = path.join(dir, "claude-config");
  const work = path.join(dir, "work");
  for (const d of [dataDir, configDir, work]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(work, "seed.txt"), "seed\n");
  const report = {};
  t.after(() => {
    fs.mkdirSync("reports", { recursive: true });
    fs.writeFileSync("reports/windows-claude-hooks-e2e.json", JSON.stringify(report, null, 2));
  });

  const claude = await installClaude(configDir);
  report.claude = claude;
  report.version = (await exec(claude, ["--version"], { windowsHide: true }).catch((e) => ({ stdout: String(e) }))).stdout.trim();

  // Reach's side, all real: the pipe-owner check built with the PC's csc.exe,
  // the pipe listener, and the hook installed in Claude Code's settings. The
  // session is shown and waited-on here (the live-session wiring is the Mac's,
  // tested on a Mac); this test proves the Windows pipe, hook and decision.
  await prepareOwners(dataDir);
  const answers = [];
  const asks = createAgentAsks({
    platform: "win32",
    dataDir,
    everyMs: 300,
    shows: async () => true,
    waiting: async () => true,
  });
  await asks.listen();
  t.after(() => asks.close());
  report.pipe = asks.socketPath;

  const modesDir = path.join(dataDir, "pending-modes");
  const command = agentHookCommand({ node: process.execPath, script: hookScript, agent: "claude", dataDir, platform: "win32" });
  const modeCommand = agentModeHookCommand({ node: process.execPath, script: modeHookScript, modesDir, platform: "win32" });
  // Reach's hook beside the test's config; the stand-in key is pre-approved
  // and the folder pre-trusted so -p starts straight away.
  const settings = claudeConfig({ folders: [work] });
  fs.writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify(settings, null, 2));
  installClaudeHook({ settingsPath: path.join(configDir, "settings.json"), command, modeCommand, backupDir: path.join(dir, "backups") });

  // The stand-in model: one Bash call that needs permission, then "done".
  const stand = await startStandIn({ "write the proof": [{ name: "Bash", input: { command: "echo reach> proof.txt", description: "Write the proof file" } }] });
  t.after(() => stand.close());
  report.standIn = stand.url;

  // The phone: allow the one request that reaches Reach for this session.
  const session = crypto.randomUUID();
  const watch = setInterval(() => {
    for (const prompt of asks.prompts?.("claude", session) || []) {
      try {
        asks.answer("claude", session, prompt.id, { decision: "allow" });
        answers.push({ id: prompt.id, tool: prompt.tool || prompt.kind });
      } catch {
        /* already answered */
      }
    }
  }, 150);
  t.after(() => clearInterval(watch));

  const env = claudeEnv({ configDir, url: stand.url });
  const run = await exec(claude, ["-p", "Please write the proof file.", "--session-id", session, "--permission-mode", "default", "--output-format", "json"], {
    cwd: work,
    env,
    timeout: 180000,
    windowsHide: true,
    maxBuffer: 16 << 20,
  }).catch((error) => ({ error }));
  report.answers = answers;
  report.requests = stand.requests.map((r) => ({ key: r.key, results: r.results, tools: r.tools?.length }));
  report.proof = fs.existsSync(path.join(work, "proof.txt"));

  // Claude Code reached Reach's hook over the pipe, Reach held the request,
  // and the phone's allow decided it: the tool ran and wrote the file.
  assert.ok(answers.length >= 1, `the phone answered a request Reach held (${JSON.stringify(answers)})`);
  assert.ok(stand.requests.some((r) => r.key === "write the proof"), "the stand-in model asked for the tool");
  await until(() => fs.existsSync(path.join(work, "proof.txt")), 10000, "the allowed tool wrote the proof file");
  const results = stand.results("write the proof");
  assert.ok(results.some((r) => !r.error), `Claude Code ran the tool after the phone's allow: ${JSON.stringify(results)}`);
});

// The mode switch can't be shown in `-p`: there a PreToolUse "ask" is denied
// without running the PermissionRequest hook (verified on Claude Code 2.1.299).
// So this runs Claude Code interactively, in a pseudo-terminal, as a person
// would, and the mode hook's "ask" there does reach the PermissionRequest
// hook, so the phone's allow carries the setMode in.
test("on real Windows, a mode picked on the phone makes the mode hook ask, and Reach switches it on the allow", { skip, timeout: 1500000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "reach-cc-mode-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, "reach");
  const configDir = path.join(dir, "claude-config");
  const work = path.join(dir, "work");
  for (const d of [dataDir, configDir, work]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(work, "seed.txt"), "seed\n");
  const report = {};
  t.after(() => {
    fs.mkdirSync("reports", { recursive: true });
    fs.writeFileSync("reports/windows-claude-hooks-mode.json", JSON.stringify(report, null, 2));
  });

  const claude = await installClaude(configDir);
  await prepareOwners(dataDir);
  const switched = [];
  const modesDir = path.join(dataDir, "pending-modes");
  const asks = createAgentAsks({ platform: "win32", dataDir, modesDir, everyMs: 300, shows: async () => true, waiting: async () => true });
  await asks.listen();
  t.after(() => asks.close());

  const command = agentHookCommand({ node: process.execPath, script: hookScript, agent: "claude", dataDir, platform: "win32" });
  const modeCommand = agentModeHookCommand({ node: process.execPath, script: modeHookScript, modesDir, platform: "win32" });
  fs.writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify(claudeConfig({ folders: [work] }), null, 2));
  installClaudeHook({ settingsPath: path.join(configDir, "settings.json"), command, modeCommand, backupDir: path.join(dir, "backups") });

  const session = crypto.randomUUID();
  // The phone picks accept-edits for a chat Reach doesn't run. Reach writes
  // the waiting mode to the modes folder; the mode hook must then make Claude
  // Code ask before its next tool call (even one accept-edits wouldn't prompt
  // for), so the PermissionRequest hook runs and the mode goes in on the allow.
  asks.queueMode("claude", session, "acceptEdits");
  assert.ok(fs.existsSync(path.join(modesDir, session)), "Reach wrote the waiting mode for the mode hook to find");

  const stand = await startStandIn({ "read the seed": [{ name: "Read", input: { file_path: path.join(work, "seed.txt") } }] });
  t.after(() => stand.close());
  const watch = setInterval(() => {
    for (const prompt of asks.prompts?.("claude", session) || []) {
      try {
        asks.answer("claude", session, prompt.id, { decision: "allow" });
        switched.push(prompt.id);
      } catch {
        /* already answered */
      }
    }
  }, 150);
  t.after(() => clearInterval(watch));

  // Interactive, in a pseudo-terminal: the prompt is Claude Code's first
  // message. node-pty is Reach's own terminal component.
  const helperWarning = ensurePtyHelper();
  assert.equal(helperWarning, null, helperWarning || "");
  const pty = loadPty();
  const env = claudeEnv({ configDir, url: stand.url, extra: { TERM: "xterm-256color" } });
  const term = pty.spawn(claude, ["Please read the seed file.", "--session-id", session, "--permission-mode", "acceptEdits"], {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: work,
    env,
  });
  let screen = "";
  term.onData((d) => (screen += d));
  t.after(() => {
    try {
      term.kill();
    } catch {
      /* already gone */
    }
  });
  // The mode clears only when the request reached Reach through the pipe and
  // Reach applied the setMode: a safe Read (inside the folder, nothing hidden)
  // switches by itself with no tap, as on a Mac; anything else would wait for
  // the phone's allow. Either way, acceptEdits wouldn't have asked for this
  // Read on its own, so the switch is proof the mode hook forced the ask.
  await until(() => asks.queuedMode("claude", session) === null, 120000, "Reach applied the picked mode through the mode hook and pipe");
  report.switched = switched;
  report.standIn = stand.requests.map((r) => r.key).filter(Boolean);
  report.screenTail = screen.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").split(/\r?\n/).filter((l) => l.trim()).slice(-8);

  assert.equal(asks.queuedMode("claude", session), null, "the mode the phone picked was applied, so the mode hook asked and the pipe carried it");
  assert.ok(stand.requests.some((r) => r.key === "read the seed"), "the interactive session reached the tool call");
});
