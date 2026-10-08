#!/bin/sh
# Reach's PreToolUse hook for Claude Code (~/.claude/settings.json), run as:
# sh agent-mode-hook.sh <pending-modes folder>. Claude Code runs it before
# every tool call, so it stays a few shell lines (no Node start-up).
# A permission mode picked on the phone for a session Reach doesn't run is a
# file named after the session in that folder (agent-asks.mjs). While it's
# there, Claude Code is told to ask for this call: its PermissionRequest hook
# then reaches Reach, which switches the mode (setMode, the one way in
# Claude Code takes a mode from outside): by itself on a step every mode
# takes without asking, with the phone's allow otherwise. Otherwise it says nothing and
# Claude Code goes on as without Reach.
input=$(cat)
id=$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F-]\{36\}\)".*/\1/p' | head -n 1)
if [ -n "$id" ] && [ -n "$1" ] && [ -f "$1/$id" ]; then
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"Reach: a permission mode picked on your phone switches with this answer."}}'
fi
exit 0
