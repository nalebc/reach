// Installing an agent Reach chats with, from the phone: its makers' own
// install command (never text from the phone), shown first and run only once
// the person confirms, in a Reach terminal they can watch; the terminal ends
// with the install. Then the phone checks again.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// As each maker documents it.
// - Claude Code: its native installer (code.claude.com/docs/en/setup).
// - Codex: its npm package, or Homebrew's cask without npm
//   (github.com/openai/codex).
export const AGENT_INSTALLS = {
  claude: { name: "Claude Code", commands: ["curl -fsSL https://claude.ai/install.sh | bash"] },
  codex: { name: "Codex", commands: ["npm install -g @openai/codex", "brew install --cask codex"], needs: ["npm", "brew"] },
};

// Whether the owner's login shell has a command (npm, brew).
export async function hasCommand(name, run = exec) {
  try {
    const { stdout } = await run(process.env.SHELL || "/bin/zsh", ["-lc", `command -v ${name}`], { timeout: 8000 });
    return stdout.trim().startsWith("/");
  } catch {
    return false;
  }
}

// The command for this Mac: the first one whose tool it has.
export async function installPlan(agent, { has = hasCommand } = {}) {
  const recipe = AGENT_INSTALLS[agent];
  if (!recipe) throw Object.assign(new Error("Reach can't install that app."), { status: 400 });
  for (const [i, command] of recipe.commands.entries()) {
    const tool = recipe.needs?.[i];
    if (!tool || (await has(tool))) return { agent, name: recipe.name, command };
  }
  throw Object.assign(new Error(`Install ${recipe.name} needs npm or Homebrew on this Mac.`), { status: 409 });
}
