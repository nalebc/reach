// Installing an agent Reach chats with, from the phone: its makers' own
// install command (never text from the phone), shown first and run only once
// the person confirms, in a Reach terminal they can watch; the terminal ends
// with the install. Then the phone checks again.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);

// As each maker documents it.
// - Claude Code: its native installer (code.claude.com/docs/en/setup).
// - Codex: its npm package, or Homebrew's cask without npm
//   (github.com/openai/codex).
export const AGENT_INSTALLS = {
  claude: { name: "Claude Code", commands: ["curl -fsSL https://claude.ai/install.sh | bash"] },
  codex: { name: "Codex", commands: ["npm install -g @openai/codex", "brew install --cask codex"], needs: ["npm", "brew"] },
};
const windowsInstalls = {
  claude: { name: "Claude Code", commands: ["irm https://claude.ai/install.ps1 | iex"] },
  codex: { name: "Codex", commands: ["npm.cmd install -g @openai/codex"], needs: ["npm"] },
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
export async function installPlan(agent, { has, platform = process.platform } = {}) {
  has ??= (name) => hasCommand(name, exec, { platform });
  const recipes = platform === "win32" ? windowsInstalls : AGENT_INSTALLS;
  const recipe = Object.hasOwn(recipes, agent) ? recipes[agent] : null;
  if (!recipe) throw Object.assign(new Error("Reach can't install that app."), { status: 400 });
  for (const [i, command] of recipe.commands.entries()) {
    const tool = recipe.needs?.[i];
    if (tool === "brew" && platform !== "darwin") continue;
    if (!tool || (await has(tool))) return { agent, name: recipe.name, command };
  }
  throw Object.assign(new Error(`Install ${recipe.name} needs ${platform === "darwin" ? "npm or Homebrew on this Mac" : "npm on this computer"}.`), { status: 409 });
}

// The terminal manager starts PowerShell on Windows and a POSIX shell elsewhere.
// A failed download/installer must end the temporary terminal with a failure.
export function installTerminalCommand(plan, platform = process.platform) {
  if (platform !== "win32") return `set -o pipefail; ${plan.command}; exit`;
  const exit = plan.agent === "codex" ? "exit $LASTEXITCODE" : "exit 0";
  return `$ErrorActionPreference = 'Stop'; try { ${plan.command}; ${exit} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
}
