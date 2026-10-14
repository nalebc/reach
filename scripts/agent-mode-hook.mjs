#!/usr/bin/env node
// Reach's PreToolUse hook for Claude Code on Windows, run as:
//   node agent-mode-hook.mjs <pending-modes folder>
// It is the Mac's scripts/agent-mode-hook.sh in Node, because Windows has no
// /bin/sh to count on (Claude Code there uses Git Bash, or PowerShell when
// Git Bash is missing), and PowerShell's start-up would be too slow before
// every tool call. Claude Code runs it before every tool call, so it does as
// little as possible: a permission mode picked on the phone for a session
// Reach doesn't run is a file named after the session in that folder
// (agent-asks.mjs). While it's there, Claude Code is told to ask for this
// call; its PermissionRequest hook then reaches Reach, which switches the
// mode (setMode, the one way Claude Code takes a mode from outside). Anything
// else, or any trouble, prints nothing and Claude Code goes on as without
// Reach: the mode just isn't switched, and no tool call is ever blocked.
import fs from "node:fs";
import path from "node:path";

const modesDir = process.argv[2];
const done = () => process.exit(0);
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
  if (raw.length > 8 * 1024 * 1024) done();
});
process.stdin.on("end", () => {
  if (!modesDir) return done();
  let id = null;
  try {
    id = JSON.parse(raw)?.session_id;
  } catch {
    return done();
  }
  // A session id Claude Code gives is a UUID; anything else can't name a file.
  if (typeof id !== "string" || !/^[0-9a-fA-F-]{36}$/.test(id)) return done();
  let waiting = false;
  try {
    waiting = fs.statSync(path.join(modesDir, id)).isFile();
  } catch {
    waiting = false;
  }
  if (waiting)
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: "Reach: a permission mode picked on your phone switches with this answer.",
        },
      }),
      done,
    );
  else done();
});
