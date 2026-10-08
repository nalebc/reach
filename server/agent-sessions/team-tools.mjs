// The tools a team's lead gets (docs/ACROSS_AGENTS.md, Team chats), as MCP
// tool definitions: the same list the bridge offers (scripts/team-mcp.mjs)
// and the team engine checks (teams.mjs). Helpers never get them.
export const TEAM_HELPERS = ["codex", "claude"];
export const TEAM_LIMITS = {
  // Hand-offs and follow-ups in all, per team (each wakes the lead once).
  steps: 12,
  // Helper chats at work at once.
  working: 3,
  task: 20000,
  title: 80,
  message: 8000,
};

export const TEAM_TOOLS = [
  {
    name: "team_delegate",
    description:
      "Hand one helper a well-scoped task. It starts in its own chat in this folder and works on its own; this returns at once with a task id. " +
      "Then end your turn: Reach sends you the helper's result as a new message when it finishes. Use kind \"build\" for work that changes files " +
      "and \"review\" for checking work without changing anything.",
    inputSchema: {
      type: "object",
      properties: {
        helper: { type: "string", enum: TEAM_HELPERS, description: "Which helper: codex or claude (only those on your team)." },
        kind: { type: "string", enum: ["build", "review"], description: "build changes files; review only reads and reports." },
        title: { type: "string", maxLength: TEAM_LIMITS.title, description: "A few words naming the task (shown to the user)." },
        task: { type: "string", maxLength: TEAM_LIMITS.task, description: "Everything the helper needs: the goal, the files, what done looks like." },
      },
      required: ["helper", "kind", "task"],
    },
  },
  {
    name: "team_message",
    description:
      "Send a follow-up to a helper's chat (a fix after your check, a question). Returns at once; Reach sends you the helper's next reply when it finishes.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "The task id team_delegate gave you." },
        message: { type: "string", maxLength: TEAM_LIMITS.message },
      },
      required: ["task_id", "message"],
    },
  },
  {
    name: "team_stop",
    description: "Stop a helper that is working on a task (its chat stays, as it is).",
    inputSchema: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
  {
    name: "team_roster",
    description: "Your helpers, every task so far with where it stands, and how many hand-offs are left.",
    inputSchema: { type: "object", properties: {} },
  },
];
