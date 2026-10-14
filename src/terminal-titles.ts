// Terminal names as people read them. A Mac Terminal window title like
// "reach — ✳ Fix the list — claude — 132×48" becomes "Fix the list" with
// "Claude Code · reach"; iTerm2's "ssh pi@home (ssh)" becomes "ssh pi@home"
// with "ssh"; a Windows console's "Command Prompt - npm run dev" becomes
// "npm run dev". Agents are recognized so their real logos can show.
export type Agent = "claude" | "codex";
export type TerminalSummary = { title: string; detail: string; agent?: Agent };

export const AGENT_NAMES: Record<Agent, string> = {
  claude: "Claude Code",
  codex: "Codex",
};
const SHELLS = new Set([
  "zsh",
  "bash",
  "fish",
  "sh",
  "tcsh",
  "ksh",
  "nu",
  "login",
]);
const PROMPT = /[%$#>❯➜]$/;
const DIMENSIONS = /^\d+\s*[×x]\s*\d+$/;

// Status glyphs agents put before their titles (✳, ✻, spinner dots).
const tidy = (text: string) =>
  text.replace(/^[^\p{L}\p{N}~/.@[(]+/u, "").trim();
// "-zsh" → "zsh", "/usr/bin/python3 x.py" → "python3".
const program = (command: string) =>
  (command.trim().replace(/^-/, "").split(/\s+/)[0] || "").split("/").pop() ||
  "";
const agentOf = (command: string): Agent | undefined => {
  const name = program(command).toLowerCase();
  return name === "claude" || name === "codex" ? name : undefined;
};
const shellOf = (command: string) => SHELLS.has(program(command).toLowerCase());

function summarize(
  folder: string,
  titles: string[],
  job: string,
  app: string,
): TerminalSummary {
  const agent = agentOf(job) || titles.map(agentOf).find(Boolean);
  const named = titles.map(tidy).find((t) => t && !agentOf(t));
  if (agent) {
    // A task title when the agent shows one, else the project folder.
    const title = named || folder || AGENT_NAMES[agent];
    const detail = [AGENT_NAMES[agent], named ? folder : ""]
      .filter(Boolean)
      .join(" · ");
    return { agent, title, detail: detail === title ? app : detail };
  }
  const command = job && (shellOf(job) ? program(job) : job.trim());
  if (named)
    return {
      title: named,
      detail: [command, folder].filter(Boolean).join(" · ") || app,
    };
  if (folder) return { title: folder, detail: command || app };
  return command
    ? { title: command, detail: app }
    : { title: `${app} window`, detail: app };
}

// Windows' shells as their windows name them by default: a path to the
// program, or the Start menu's (or Windows Terminal's) name for it.
const WINDOWS_PROGRAMS: Record<string, string> = {
  cmd: "Command Prompt",
  powershell: "Windows PowerShell",
  pwsh: "PowerShell",
};
const WINDOWS_NAMES: Record<string, string> = {
  "command prompt": "Command Prompt",
  "windows powershell": "Windows PowerShell",
  powershell: "PowerShell",
};
const windowsShell = (title: string): string | undefined => {
  const base = title.split(/[\\/]/).pop()!.trim();
  const program = base.match(/^(.+)\.exe$/i);
  if (program) return WINDOWS_PROGRAMS[program[1].toLowerCase()];
  // "PowerShell 7 (x64)", "PowerShell 7.4.1".
  return WINDOWS_NAMES[base.replace(/\s+\d[\d.]*(?:\s*\(x\d+\))?$/, "").toLowerCase()];
};

// A command as cmd shows it, its program by name: '"C:\…\codex.cmd" resume'
// reads "codex resume".
const windowsJob = (job: string) => {
  const parts = job.match(/^"([^"]+)"\s*(.*)$/) || job.match(/^(\S+)\s*(.*)$/);
  if (!parts) return job;
  const name = parts[1].split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat|ps1)$/i, "");
  return [name, parts[2]].filter(Boolean).join(" ");
};

// A Windows PC's own terminals: Windows Terminal's tabs and console windows
// carry the title the program in them set. cmd's is "<title> - <command>"
// while a command runs.
export function describeWindowsTerminal(
  name: string,
  provider: string,
): TerminalSummary {
  const app = provider === "console" ? "Console" : "Windows Terminal";
  const raw = tidy((name || "").trim());
  const running = raw.match(/^(.+?)\s+-\s+(.+)$/);
  if (running && windowsShell(running[1]) === "Command Prompt")
    return summarize("", [], windowsJob(running[2].replace(/\s+/g, " ").trim()), app);
  const shell = windowsShell(raw);
  if (shell) return { title: shell, detail: app };
  return summarize("", raw ? [raw] : [], "", app);
}

export function describeMacTerminal(
  name: string,
  provider: string,
): TerminalSummary {
  if (provider === "windows-terminal" || provider === "console")
    return describeWindowsTerminal(name, provider);
  const app = provider === "iterm2" ? "iTerm2" : "Terminal";
  const raw = (name || "").trim();
  if (provider === "iterm2") {
    // iTerm2 names a pane "<title> (<job>)".
    const match = raw.match(/^(.*?)\s*\(([^()]+)\)$/);
    const title = tidy(match ? match[1] : raw);
    return summarize("", title ? [title] : [], match ? match[2] : "", app);
  }
  // Terminal: "<folder> — <titles…> — <process> — <cols×rows>".
  const parts = raw
    .split(/\s+—\s+/)
    .map((p) => p.trim())
    .filter((p) => p && !DIMENSIONS.test(p));
  if (parts.length < 2) return summarize("", parts, "", app);
  const [folder, ...rest] = parts;
  const job = rest.pop() || "";
  return summarize(tidy(folder), rest, job, app);
}

// A shell started from Reach: its name, its folder and its last line.
export function describeReachTerminal(session: {
  name: string;
  cwd: string;
  preview?: string[] | null;
}): TerminalSummary {
  const folder =
    session.cwd.split(/[\\/]/).filter(Boolean).pop() || session.cwd;
  // The last thing printed, skipping a bare prompt ("you@mac folder %").
  const last = [...(session.preview || [])]
    .reverse()
    .map((line) => line.trim())
    .find((line) => line && !PROMPT.test(line));
  const agent = (Object.keys(AGENT_NAMES) as Agent[]).find(
    (a) => AGENT_NAMES[a] === session.name,
  );
  return {
    title: session.name,
    detail: [folder, last].filter(Boolean).join(" · "),
    ...(agent && { agent }),
  };
}
