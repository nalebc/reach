#!/usr/bin/env node
// Reach's PermissionRequest hook for Claude Code (its user settings), run as
//   node agent-hook.mjs claude <socket>            on a Mac, and
//   node agent-hook.mjs claude --pipe-dir <folder> on Windows.
// Claude Code runs it while it shows its own dialog; it asks Reach
// (server/agent-sessions/agent-asks.mjs) over a private endpoint and prints
// the phone's answer as Claude Code's hook decision. Whenever Reach has none
// (the Mac or PC answered, the session isn't one the phone shows, anything
// fails), it prints nothing and exits cleanly: Claude Code's own dialog
// decides, as without Reach. Reach away (restarting): asked again every
// second for a few minutes, the dialog open all along; then nothing, never an
// answer of its own. Reach never reached (not running): given up in seconds.
//
// A Mac endpoint is a Unix socket in Reach's private folder, so reaching it is
// proof enough it's Reach's. Windows has only named pipes, in a namespace
// every account sees, so the pipe's name is read from an owner-only file each
// try (a restart may have moved it) and the pipe's server is checked to be
// this account's own process (trusted-socket.mjs pipeServedByMe) before any
// request is sent or any answer trusted; anything unsure prints nothing, so
// another account can't hand Claude Code a forged "allow". The helper that
// does the check is never compiled here: if Reach hasn't built it yet, the
// hook steps aside.
// Any other agent (an old Codex entry) steps aside at once.
import net from "node:net";

const argv = process.argv.slice(2);
const agent = argv[0];
const pipeDirAt = argv.indexOf("--pipe-dir");
const windows = pipeDirAt >= 0;
const dataDir = windows ? argv[pipeDirAt + 1] : null;
const socketPath = windows ? null : argv[1];
const stepAside = () => process.exit(0);
// REACH_HOOK_RETRY_MS, REACH_HOOK_AWAY_MS: tests only (Claude Code's settings never set them).
const ms = (name, fallback) => (/^\d+$/.test(process.env[name] || "") ? Number(process.env[name]) : fallback);
const retryFor = ms("REACH_HOOK_RETRY_MS", 3 * 60 * 1000);
const awayFor = Math.min(retryFor, ms("REACH_HOOK_AWAY_MS", 10 * 1000));
if (agent !== "claude" || (windows ? !dataDir : !socketPath)) stepAside();

// Windows: the pipe to reach Reach on now, but only if its server is this
// account's own process. Null when there's no pipe yet, the check's helper
// isn't built, or anything is unsure — the hook then waits or steps aside,
// never trusting an unverified server. Its modules load only here, so the
// Mac's path stays small and quick.
let winDeps = null;
async function windowsEndpoint() {
  try {
    if (!winDeps)
      winDeps = {
        readAgentAskPipe: (await import("../server/agent-sessions/agent-asks.mjs")).readAgentAskPipe,
        pipeOwner: (await import("../server/windows-owners.mjs")).pipeOwner,
        pipeServedByMe: (await import("../server/agent-sessions/trusted-socket.mjs")).pipeServedByMe,
        builtWindowsHelper: (await import("../server/desktop-native.mjs")).builtWindowsHelper,
      };
    const pipe = winDeps.readAgentAskPipe(dataDir);
    if (!pipe) return null;
    const build = (kind, { dir }) => {
      const found = winDeps.builtWindowsHelper(kind, { dir });
      if (!found) throw new Error("Reach hasn't built the pipe-owner check yet.");
      return found;
    };
    const seen = await winDeps.pipeOwner(pipe, { dataDir, build });
    return winDeps.pipeServedByMe(seen) ? pipe : null;
  } catch {
    return null;
  }
}

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
  // Gone, not there, or (Windows) not yet verifiable: once more soon, up to
  // the restart window if we ever connected, else only a few seconds.
  const soon = () => {
    if (Date.now() >= started + (connected ? retryFor : awayFor)) return stepAside();
    setTimeout(() => ask(true), 1000);
  };
  const ask = async (again) => {
    const endpoint = windows ? await windowsEndpoint() : socketPath;
    if (!endpoint) return soon();
    const socket = net.createConnection(endpoint);
    let reply = "";
    let over = false;
    const retry = () => {
      if (over) return;
      over = true;
      socket.destroy();
      soon();
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
