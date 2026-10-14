// Installing an agent Reach chats with, from the phone: its makers' own
// install command (never text from the phone), shown first and run only once
// the person confirms, in a Reach terminal they can watch; the terminal ends
// with the install. Then the phone checks again.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { loginShell, runtimePath } from "./openclaw-run.mjs";
import { availableUpdateRuntime } from "./openclaw-update-recovery.mjs";
import { installNode } from "./openclaw-windows.mjs";
import { nodeNote, nodeVersion, privateNode, privateNodePrefix, REACH_NODE, supportedNode } from "./openclaw-node.mjs";
import { hubGateway } from "./openclaw-hub.mjs";
import { computerWord } from "./computer-word.mjs";

const exec = promisify(execFile);

// As each maker documents it.
// - Claude Code: its native installer (code.claude.com/docs/en/setup).
// - Codex: its npm package, or Homebrew's cask without npm
//   (github.com/openai/codex).
// - OpenClaw: its own installer, as its docs give it without onboarding
//   (docs.openclaw.ai/install, /install/installer): install.sh here,
//   install.ps1 on Windows; the phone sets it up next. Not bare npm: npm 12
//   blocks OpenClaw's own install scripts unless told (--allow-scripts,
//   which npm 11.15 and older don't know), and the installers ask npm's
//   version and check Node (its version and its SQLite) first.
const OPENCLAW_SH = "curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-prompt --no-onboard";
export const AGENT_INSTALLS = {
  claude: { name: "Claude Code", commands: ["curl -fsSL --proto '=https' --tlsv1.2 https://claude.ai/install.sh | bash"] },
  codex: { name: "Codex", commands: ["npm install -g @openai/codex", "brew install --cask codex"], needs: ["npm", "brew"] },
  openclaw: { name: "OpenClaw", commands: [OPENCLAW_SH] },
};
// Git for Windows, which Claude Code needs there (its Git Bash:
// claude-environment.mjs), from winget's own catalog; its agreements are
// accepted on the phone, as nothing in a Reach terminal could answer them.
const OPENCLAW_PS1 = "& ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1)))";
const windowsInstalls = {
  claude: { name: "Claude Code", commands: ["irm https://claude.ai/install.ps1 | iex"] },
  codex: { name: "Codex", commands: ["npm.cmd install -g @openai/codex"], needs: ["npm"] },
  openclaw: { name: "OpenClaw", commands: [`${OPENCLAW_PS1} -NoOnboard`] },
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
// OpenClaw's installer needs nothing but the computer's Node, and adds a
// Node of OpenClaw's own first when that one is older than OpenClaw takes
// (`lead`, shell text Reach builds, never shown or sent to the phone; the
// phone gets `note` instead).
export async function installPlan(agent, { has, platform = process.platform, findRuntime = availableUpdateRuntime, node, hub = hubGateway } = {}) {
  has ??= (name) => hasCommand(name, exec, { platform });
  const recipes = platform === "win32" ? windowsInstalls : AGENT_INSTALLS;
  const recipe = Object.hasOwn(recipes, agent) ? recipes[agent] : null;
  if (!recipe) throw Object.assign(new Error("Reach can't install that app."), { status: 400 });
  // OpenClaw's own Windows app keeps a Gateway here already: no second one.
  if (agent === "openclaw" && platform === "win32" && (await hub()))
    throw Object.assign(new Error("OpenClaw already runs in its Windows app on this PC, and Reach uses that one."), { status: 409 });
  if (agent === "openclaw" && platform === "win32") return windowsOpenClawPlan(recipe, await (node ?? installNode)());
  if (agent === "openclaw") return posixOpenClawPlan(recipe, await (node ?? posixInstallNode)({ platform, findRuntime }), platform);
  for (const [i, command] of recipe.commands.entries()) {
    const tool = recipe.needs?.[i];
    if (tool === "brew" && platform !== "darwin") continue;
    if (!tool || (await has(tool))) return { agent, name: recipe.name, command };
  }
  const tools = recipe.needs?.includes("winget") ? `winget (Windows' App Installer) on this ${computerWord(platform)}` : platform === "darwin" ? "npm or Homebrew on this Mac" : "npm on this computer";
  throw Object.assign(new Error(`Install ${recipe.name} needs ${tools}.`), { status: 409 });
}

// OpenClaw on a computer whose Node it can't run on (24.16 or newer):
// OpenClaw's own Node for OpenClaw only, from its installer's Node-only mode
// (nodejs.org, SHA-256 checked), led on PATH so the install runs on it, and
// npm's global folder kept where the computer's own npm keeps it (a Node
// from a tarball would name its own folder). The computer's own Node isn't
// touched: OpenClaw's installers would otherwise update it themselves
// (Homebrew's `brew install node` and `brew link --overwrite` on a Mac;
// winget on Windows, with an administrator's OK at the PC, maybe for the
// very node.exe Reach runs on). Said on the phone first (`note`).
const psQuote = (value) => `'${String(value).replace(/['\u2018-\u201B]/g, "$&$&")}'`;
const shQuote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
function windowsOpenClawPlan(recipe, node) {
  const plan = { agent: "openclaw", name: recipe.name, command: recipe.commands[0] };
  if (node.supported) return plan;
  const { dir } = node;
  const lead = [
    node.privateReady ? "" : `${OPENCLAW_PS1} -NodeOnly -NodePrefix ${psQuote(dir)}`,
    `$env:Path = ${psQuote(`${dir};`)} + $env:Path`,
    "$env:NPM_CONFIG_PREFIX = Join-Path $env:APPDATA 'npm'",
  ].filter(Boolean).join("; ");
  return { ...plan, lead, ...(node.privateReady ? {} : { note: nodeNote({ version: node.version, word: computerWord("win32") }) }) };
}

// The same on a Mac (and Linux): install-cli.sh --node-only, OpenClaw's own
// Node-only installer, then install.sh on it. npm's global folder is the
// one the computer's own npm names; Reach's private Node (.reach/runtime)
// isn't the computer's, so then Homebrew's; with neither the terminal ends
// saying why, before anything is installed. Homebrew's node@24 there
// already: it leads, as before, and nothing is added.
const OPENCLAW_NODE_ONLY = "curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- --node-only --prefix";
function posixOpenClawPlan(recipe, node, platform) {
  const plan = { agent: "openclaw", name: recipe.name, command: recipe.commands[0] };
  if (node.supported) return plan;
  if (node.runtime) return { ...plan, lead: runtimePath(node.runtime) };
  const word = computerWord(platform);
  const lead = [
    "openclaw_prefix=$(npm prefix -g 2>/dev/null) || openclaw_prefix=",
    "case \"$openclaw_prefix\" in ''|*/.reach/runtime/*) openclaw_prefix=$(brew --prefix 2>/dev/null) || openclaw_prefix= ;; esac",
    `[ -n "$openclaw_prefix" ] || { echo "This ${word} has no npm of its own to install OpenClaw with. Install Node.js 24 or newer from nodejs.org, then install OpenClaw again." >&2; exit 1; }`,
    'export NPM_CONFIG_PREFIX="$openclaw_prefix"',
    node.privateReady ? "" : `${OPENCLAW_NODE_ONLY} ${shQuote(node.prefix)} || exit 1`,
    `export PATH=${shQuote(node.bin)}:"$PATH"`,
  ].filter(Boolean).join("; ");
  return { ...plan, lead, ...(node.privateReady ? {} : { note: nodeNote({ version: node.version, word }) }) };
}

// The Node a Reach terminal finds first (the login shell's, what
// install.sh checks), Homebrew's node@24, and OpenClaw's own Node.
// `version` is the computer's own: Reach's private one isn't.
export async function posixInstallNode({ platform = process.platform, env = process.env, run = exec, findRuntime = availableUpdateRuntime, version = nodeVersion } = {}) {
  let found = null, current = null;
  try {
    const { stdout } = await run(loginShell(env, platform), ["-lc", 'command -v node >/dev/null 2>&1 && node -p "process.execPath + String.fromCharCode(10) + process.versions.node"'], { timeout: 15000 });
    [found, current] = String(stdout).trim().split(/\r?\n/).slice(-2);
  } catch {}
  if (!/^\d+\.\d+\.\d+$/.test(current || "")) current = null;
  const own = privateNode({ platform, env });
  return {
    version: current && !REACH_NODE.test(found || "") ? current : null,
    supported: supportedNode(current),
    runtime: await findRuntime({ platform }).catch(() => null),
    prefix: privateNodePrefix({ env }),
    bin: path.dirname(own),
    privateReady: supportedNode(await version(own)),
  };
}

// The terminal manager starts PowerShell on Windows and a POSIX shell elsewhere.
// A failed download/installer must end the temporary terminal with a failure.
export function installTerminalCommand(plan, platform = process.platform) {
  if (platform !== "win32") return `set -o pipefail; ${plan.lead ? `${plan.lead}; ` : ""}${plan.command}; exit`;
  // A script piped to iex (Claude Code's installer) or run as a script
  // block (OpenClaw's) throws when it fails and sets no exit code of its
  // own: what's left in $LASTEXITCODE is its last probe's. A program's (npm,
  // winget, claude update) is the install's.
  const exit = /\|\s*iex$|^& \(\[scriptblock\]::Create\(/.test(plan.command) ? "exit 0" : "exit $LASTEXITCODE";
  return `$ErrorActionPreference = 'Stop'; try { ${plan.lead ? `${plan.lead}; ` : ""}${plan.command}; ${exit} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
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
