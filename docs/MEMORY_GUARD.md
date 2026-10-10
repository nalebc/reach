# Memory guard (plan, Oct 9 2026)

Reach watches the memory of every process an agent starts on this Mac. One
that is about to fill memory is paused, you hear about it on the phone, and
Reach ends it only if memory stays critical. Mac only.

Why: on Oct 9 three agent-run `node --test` processes reached 39, 36 and
6 GB on a 16 GB Mac within four minutes. macOS compressed and swapped until
WindowServer stopped answering, its watchdog killed it, and the session
logged out. Reach's own tests are guarded (test/helpers/runaway-guard.mjs);
this guards every project an agent works in.

## Whose processes

- Everything started under an agent: Claude Code (`claude`, whatever hosts
  it: the Claude app, a terminal, Reach), Codex (the CLI, the app's
  `app-server` and its daemon), Gemini CLI, the OpenClaw gateway, and
  terminals Reach opened. That includes their tools, MCP servers and test
  workers.
- The agents themselves are never paused: pausing `claude` freezes the chat,
  and Codex's app-server serves every thread.
- A large process whose parent is gone (moved under launchd) still counts
  when its environment names an agent: `CLAUDECODE` / `CLAUDE_CODE_SESSION_ID`,
  `CODEX_*`, `OPENCLAW_GATEWAY_SERVICE_PID`. The marker also names the chat
  for the card. Checked on this Mac for node children. macOS hides the
  environment of its own binaries, so ancestry stays the main signal.

## Never touched

- Reach, the processes that started it, and its own helpers, known by pid,
  never by name.
- Other users' processes, macOS itself (`/System`, `/usr/libexec`, `/sbin`,
  `/usr/sbin`, WindowServer, loginwindow, Finder, Dock) and the protected apps
  in server/agent-guard.mjs.
- Any app or process no agent started.

## How it measures

- Each process's physical footprint (`proc_pid_rusage`, `ri_phys_footprint`):
  what macOS counts, compressed and swapped pages included. Not RSS, which
  stayed near 1.5 GB while one process passed 80 GB.
- The Mac's memory pressure (`kern.memorystatus_vm_pressure_level`: 1 normal,
  2 warn, 4 critical). Warn is common on a 16 GB Mac (this one reads warn
  with 46% free), so warn alone never acts.
- A small Swift helper (scripts/native/memory-watch.swift) samples every
  second for a few milliseconds of CPU. It is one long-lived process, so
  nothing is forked per sample and it keeps working when memory is tight.
- Without Apple's developer tools: `top` streaming every 3 s. Its MEM is the
  same footprint (checked); it costs about 6% of one core.
- A footprint that can't be read counts as unknown, never as 0.

## When it pauses

R is this Mac's memory; the brackets show a 16 GB Mac.

1. One agent process reaches 40% of R [6.4 GB].
2. One agent's running processes together reach 60% of R [9.6 GB]: Reach
   pauses its largest running process, then the next, until the total is
   under the line.
3. Memory is critical: Reach pauses the largest running agent process,
   then another every 5 s while it stays critical.

A process under 10% of R (at least 1 GB) [1.6 GB] is never paused, whatever
the pressure. A 300 MB `tsc` isn't the problem when Chrome is.

## What happens next

- Pause is SIGSTOP. It stops growing, but it doesn't give memory back.
- Needs you on the phone, with a push:
  **End node --test?** · reach · 9.4 GB · Fix invite UI
  *Paused: it was filling your Mac's memory.*
  [End] [Resume]
  The size is frozen when the process is paused, so the card doesn't change
  under your tap. It opens the chat when Reach knows which one.
- End is SIGKILL, on that process only.
- Resume is SIGCONT. Rules 1 and 2 leave the process alone until it grows
  another 25% of R [4 GB]. Rule 3 still applies.
- If memory is still critical 30 s after the last pause, Reach ends the
  paused processes, largest first, one every 5 s, until it isn't. The card
  says so: **Ended node --test** · Memory stayed critical · 31 GB [OK].
  When the pause itself didn't bring memory back, this is the expected end.
- A pressure value Reach doesn't know never ends anything. Pauses by size
  still happen.
- Every signal is checked against the process's pid and start time first,
  so a reused pid is never signaled.
- The paused list is saved in Reach's data folder. When Reach restarts it
  offers the card again instead of forgetting a stopped process.
- Each pause, resume and end writes one line in Reach's Terminal log, with
  the cause.

## Order

1. Policy: server/memory-guard.mjs decides from samples alone. Tests use fake
   process tables, footprints and a fake clock. No signals are sent.
2. Sampler: the Swift helper and its reader. Tests run on recorded lines,
   plus one smoke run of the helper on its own pid.
3. Actions and card: signals (injected in tests), the saved list, the Needs
   you card with End, Resume and OK, and the push.
4. Fallback without developer tools (`top`).

## Rules

- No real runaways in tests, and no real signals in tests.
- Signals only. Nothing is clicked or typed.
- Nothing about cost is recorded.
- Short text on the phone.
- Mac only. On Windows and Linux the guard is off.
