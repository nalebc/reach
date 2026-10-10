#!/usr/bin/env node
// Reach's PermissionRequest hook for Claude Code (~/.claude/settings.json),
// run as: node agent-hook.mjs claude <socket>. Claude Code runs it while it
// shows its own dialog; it asks Reach (server/agent-sessions/agent-asks.mjs)
// over a private socket and prints the phone's answer as Claude Code's hook
// decision. Whenever Reach has none (the Mac answered, the session isn't one
// the phone shows, anything fails), it prints nothing and exits cleanly:
// Claude Code's own dialog decides, as without Reach. Reach away (restarting):
// asked again every second for a few minutes, the dialog open on the Mac all
// along; then nothing, never an answer of its own. Reach never reached (not
// running): given up within seconds.
// Any other agent (an old Codex entry) steps aside at once.
import net from "node:net";

const [agent, socketPath] = process.argv.slice(2);
const stepAside = () => process.exit(0);
// REACH_HOOK_RETRY_MS, REACH_HOOK_AWAY_MS: tests only (Claude Code's settings never set them).
const ms = (name, fallback) => (/^\d+$/.test(process.env[name] || "") ? Number(process.env[name]) : fallback);
const retryFor = ms("REACH_HOOK_RETRY_MS", 3 * 60 * 1000);
const awayFor = Math.min(retryFor, ms("REACH_HOOK_AWAY_MS", 10 * 1000));
if (agent !== "claude" || !socketPath) stepAside();
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
  if (input?.hook_event_name !== "PermissionRequest") return stepAside();
  const started = Date.now();
  // Reach was there once: what follows is a restart, worth the few minutes.
  let connected = false;
  const ask = (again) => {
    const socket = net.createConnection(socketPath);
    let reply = "";
    let over = false;
    // Gone without an answer (Reach quit, or isn't there): once more soon.
    const retry = () => {
      if (over) return;
      over = true;
      socket.destroy();
      if (Date.now() >= started + (connected ? retryFor : awayFor)) return stepAside();
      setTimeout(() => ask(true), 1000);
    };
    socket.setEncoding("utf8");
    socket.on("error", retry);
    socket.on("close", retry);
    socket.on("connect", () => {
      connected = true;
      socket.write(
        `${JSON.stringify({
          agent,
          session_id: input.session_id,
          tool_name: input.tool_name,
          tool_input: input.tool_input,
          permission_suggestions: input.permission_suggestions,
          permission_mode: input.permission_mode,
          cwd: input.cwd,
          // Its call's id, from a Claude Code that gives one (2.1.296 doesn't).
          ...(typeof input.tool_use_id === "string" ? { tool_use_id: input.tool_use_id } : {}),
          // Reach checks Claude Code still waits on it before showing it.
          ...(again ? { again: true } : {}),
        })}\n`,
      );
    });
    socket.on("data", (chunk) => {
      reply += chunk;
      const at = reply.indexOf("\n");
      if (at < 0) return;
      let answer = null;
      try {
        answer = JSON.parse(reply.slice(0, at));
      } catch {
        /* no decision */
      }
      if (answer?.retry === true) return retry();
      over = true;
      const decision = answer?.decision || null;
      if (!decision) return stepAside();
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } }), () =>
        process.exit(0),
      );
    });
  };
  ask(false);
});
