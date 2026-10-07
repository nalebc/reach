// Terminal names as people read them. A Mac Terminal window title like
// "reach — ✳ Fix the list — claude — 132×48" becomes "Fix the list" with
// "Claude Code · reach"; iTerm2's "ssh pi@home (ssh)" becomes "ssh pi@home"
// with "ssh". Agents are recognized so their real logos can show.
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

export function describeMacTerminal(
  name: string,
  provider: string,
): TerminalSummary {
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
