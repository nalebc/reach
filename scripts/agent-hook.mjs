#!/usr/bin/env node
// Reach's PermissionRequest hook for Claude Code (~/.claude/settings.json) and
// Codex (~/.codex/config.toml), run as: node agent-hook.mjs <agent> <socket>.
// The agent runs it before it asks for a permission or answer; it asks Reach
// (server/agent-sessions/agent-asks.mjs) over a private socket and prints
// Reach's decision, the phone's answer. Whenever Reach has none (it isn't
// running, someone is at the Mac, anything fails), it prints nothing and exits
// cleanly: the agent then shows its own dialog as usual.
import net from "node:net";

const [agent, socketPath] = process.argv.slice(2);
const stepAside = () => process.exit(0);
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
  if (raw.length > 8 * 1024 * 1024) stepAside();
});
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return stepAside();
  }
  if (!socketPath || input.hook_event_name !== "PermissionRequest") return stepAside();
  const socket = net.createConnection(socketPath);
  let reply = "";
  socket.setEncoding("utf8");
  socket.on("error", stepAside);
  socket.on("close", stepAside);
  socket.on("connect", () =>
    socket.write(
      `${JSON.stringify({
        agent,
        session_id: input.session_id,
        tool_name: input.tool_name,
        tool_input: input.tool_input,
        permission_mode: input.permission_mode,
      })}\n`,
    ),
  );
  socket.on("data", (chunk) => {
    reply += chunk;
    const at = reply.indexOf("\n");
    if (at < 0) return;
    let decision = null;
    try {
      decision = JSON.parse(reply.slice(0, at)).decision || null;
    } catch {
      /* no decision */
    }
    if (!decision) return stepAside();
    socket.removeAllListeners("close");
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }), () =>
      process.exit(0),
    );
  });
});
