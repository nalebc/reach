// Installing an agent Reach chats with, from the phone: its makers' own
// install command (never text from the phone), shown first and run only once
// the person confirms, in a Reach terminal they can watch; the terminal ends
// with the install. Then the phone checks again.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { runtimePath } from "./openclaw-run.mjs";
import { availableUpdateRuntime } from "./openclaw-update-recovery.mjs";
import { computerWord } from "./computer-word.mjs";

const exec = promisify(execFile);

// As each maker documents it.
// - Claude Code: its native installer (code.claude.com/docs/en/setup).
// - Codex: its npm package, or Homebrew's cask without npm
//   (github.com/openai/codex).
// - OpenClaw: its npm package, or its installer script (which brings Node)
//   without npm; no onboarding there, the phone sets it up next
//   (docs.openclaw.ai/install). On Windows OpenClaw points to WSL: none.
export const AGENT_INSTALLS = {
  claude: { name: "Claude Code", commands: ["curl -fsSL --proto '=https' --tlsv1.2 https://claude.ai/install.sh | bash"] },
  codex: { name: "Codex", commands: ["npm install -g @openai/codex", "brew install --cask codex"], needs: ["npm", "brew"] },
  openclaw: {
    name: "OpenClaw",
    commands: ["npm install -g openclaw@latest", "curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard"],
    needs: ["npm"],
  },
};
// Git for Windows, which Claude Code needs there (its Git Bash:
// claude-environment.mjs), from winget's own catalog; its agreements are
// accepted on the phone, as nothing in a Reach terminal could answer them.
const windowsInstalls = {
  claude: { name: "Claude Code", commands: ["irm https://claude.ai/install.ps1 | iex"] },
  codex: { name: "Codex", commands: ["npm.cmd install -g @openai/codex"], needs: ["npm"] },
  git: {
    name: "Git for Windows",
    commands: ["winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements"],
    needs: ["winget"],
  },
};

// Whether the owner's login shell has a command (npm, brew).
export async function hasCommand(name, run = exec, { platform = process.platform, env = process.env } = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return false;
  try {
    if (platform === "win32") {
      const command = name === "npm" ? "npm.cmd" : name;
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Command -Name '${command}' -CommandType Application -ErrorAction Stop).Source`], { timeout: 8000, windowsHide: true });
      return path.win32.isAbsolute(stdout.trim());
    }
    const { stdout } = await run(env.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh"), ["-lc", `command -v ${name}`], { timeout: 8000 });
    return stdout.trim().startsWith("/");
  } catch {
    return false;
  }
}

// The command for this computer: the first one whose tool it has.
// OpenClaw 2026.9 refuses Node older than 24.16: with Homebrew's node@24 on
// this Mac, its npm and node go first on PATH for the install (`lead`, shell
// text Reach builds, never shown or sent to the phone).
export async function installPlan(agent, { has, platform = process.platform, findRuntime = availableUpdateRuntime } = {}) {
  has ??= (name) => hasCommand(name, exec, { platform });
  const recipes = platform === "win32" ? windowsInstalls : AGENT_INSTALLS;
  const recipe = Object.hasOwn(recipes, agent) ? recipes[agent] : null;
  if (!recipe) throw Object.assign(new Error("Reach can't install that app."), { status: 400 });
  for (const [i, command] of recipe.commands.entries()) {
    const tool = recipe.needs?.[i];
    if (tool === "brew" && platform !== "darwin") continue;
    if (!tool || (await has(tool))) {
      const lead = agent === "openclaw" && platform !== "win32" ? runtimePath(await findRuntime({ platform }).catch(() => null)) : "";
      return lead ? { agent, name: recipe.name, command, lead } : { agent, name: recipe.name, command };
    }
  }
  const tools = recipe.needs?.includes("winget") ? `winget (Windows' App Installer) on this ${computerWord(platform)}` : platform === "darwin" ? "npm or Homebrew on this Mac" : "npm on this computer";
  throw Object.assign(new Error(`Install ${recipe.name} needs ${tools}.`), { status: 409 });
}

// The terminal manager starts PowerShell on Windows and a POSIX shell elsewhere.
// A failed download/installer must end the temporary terminal with a failure.
export function installTerminalCommand(plan, platform = process.platform) {
  if (platform !== "win32") return `set -o pipefail; ${plan.lead ? `${plan.lead}; ` : ""}${plan.command}; exit`;
  // A script piped to iex (Claude Code's installer) sets no exit code of its
  // own; a program's (npm, winget, claude update) is the install's.
  const exit = /\|\s*iex$/.test(plan.command) ? "exit 0" : "exit $LASTEXITCODE";
  return `$ErrorActionPreference = 'Stop'; try { ${plan.command}; ${exit} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
}

// One install per app at a time: a second phone confirming while one is
// being planned or its terminal still runs gets 409. `running(id)` reads the
// terminal's status; a terminal Reach can't read is treated as running.
export function installLock(running) {
  const held = new Map();
  return {
    take(agent) {
      const current = held.get(agent);
      if (current === "pending" || (current && running(current))) return false;
      held.set(agent, "pending");
      return true;
    },
    started(agent, terminalId) { held.set(agent, terminalId); },
    release(agent) { held.delete(agent); },
  };
}
