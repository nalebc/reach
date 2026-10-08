# Agent compatibility

Reach cannot guarantee compatibility with every future agent update. Its chat adapters depend on CLI protocols, local transcript formats and, for some Claude desktop actions, Accessibility controls. Screen, files and terminals do not depend on those chat adapters.

## Same-session synchronization

- Codex uses its local owner/follower connection. Reach-created tasks keep the same native task ID in Codex desktop; desktop composer actions go to that task's writer. Reach sends to the desktop owner when Codex already owns the task.
- Claude Code uses its native session UUID and transcript. Opening a Reach-created conversation in Claude releases Reach's idle writer first. Subsequent messages to desktop conversations use the native composer, with exact-session checks and protection for existing Mac drafts. Native sends require Accessibility permission for the app running Reach.
- OpenClaw uses the local Gateway's session key and history. Separate clients see the same conversation. Reach sends only to its own local webchat sessions, and does not deliver messages to external channels.
- Gemini currently supports reading native JSON/JSONL histories, with file-change notifications that wake open Reach chats. Sending, queueing, and approval controls are unavailable in this adapter. The installed Gemini CLI 0.39.1 rejected the October 7, 2026 live test with `UNSUPPORTED_CLIENT` for the signed-in personal account; this is separate from history synchronization.

## Runtime behavior

- Reach records CLI versions and probes the required command surface using bounded, account-free `--version` and `--help` calls. Executable changes invalidate the cache; otherwise results expire within a minute. “Available” means those commands exist, not that every desktop feature has passed an end-to-end test.
- Codex replies must match the shapes Reach consumes. Extra fields are allowed. Missing methods and malformed required fields stop that method and appear in compatibility status. Invalid parameters reject that request without disabling the method for other conversations. Unknown approval requests receive an error, never approval. Changed executable versions clear method failures on the next compatibility check; restarting Reach after updating also clears them.
- Claude question IDs, question text and choices are validated. Ambiguous or unsupported hook requests return to the agent's local dialog. Unsupported hosted requests receive an error. No answer is inferred.
- Native Claude Send requires an explicit acknowledgement. A helper timeout or unknown response is an uncertain outcome, not an invitation to send again.
- Queued delivery writes a marker before acting. A restart during delivery or uncertain result pauses the message. The message carries a visible explanation that delivery is uncertain. Removing the queued copy does not undo a message already received by Claude. Check before manually resending.
- Native consent is pressed once, only after checking the target session and pending request again. An uncertain attempt must be resolved on the Mac; it is not automatically repeated. This deduplication is in memory; after a Reach restart, check the Mac before retrying a native approval.
- A Codex approval callback is bound to its original connection and cannot reply over a replacement socket. Notifications that an adapter cannot process are contained within the agent integration.

A CLI command check cannot validate hidden flags, all event semantics, account-specific behavior, desktop Accessibility labels, or changes to private files. A schema-compatible update can still change behavior. Keep the screen/terminal fallback available.

## Automated checks

```sh
node --test test/agent-compatibility.test.mjs test/agent-outbox.test.mjs
node scripts/check-agent-compatibility.mjs claude
node scripts/check-agent-compatibility.mjs codex /absolute/path/to/codex
```

The `Agent release compatibility` GitHub workflow installs the latest published CLIs in a disposable runner on relevant PRs/pushes, or on manual dispatch. It checks version/help, generates Codex protocol schemas to check required queue/turn/approval fields, and runs a Claude initialization handshake with a temporary configuration directory. It uploads the versioned report. It uses no account credentials and makes no model calls. A public CLI that lacks the required shared-daemon command should fail the canary; do not turn that failure into an unsafe fallback. The normal test suite separately checks protocol contracts, malformed input, disconnections, approvals and durable outbox recovery with controlled agent stand-ins.

There is no claim of continuous monitoring between workflow runs or of testing a signed-in desktop app in this workflow.

## Release gate on real devices

Before calling an agent version supported, record Reach revision, CLI version, desktop app version, OS and phone browser/app version. On a disposable test conversation, verify:

1. List and resume the same session, send once, stream the reply, queue while busy, and stop.
2. Answer every page of a multi-question prompt, including multiple choices and free text. Deny a harmless tool request, then explicitly allow a separate harmless request.
3. Answer the same prompt from a second client; the original prompt must become stale. Disconnect before and after submitting; no automatic repeated approval or send.
4. Restart Reach during queued delivery; an ambiguous message must remain paused. Confirm on the Mac before removing its queued copy.
5. Change the desktop chat or leave a local draft while Reach tries to send. Reach must not overwrite or send into another chat.
6. Break an agent adapter deliberately; chat must show recovery while Files, Terminal and Screen remain usable.
7. Repeat on an actual iPhone/iPad, including backgrounding Safari and changing networks.

Release records must separate command-probe success, simulated protocol tests and these real-device results. Do not label an untested desktop/CLI version fully supported just because its version number is newer.

## Verification records

The earlier local verification described a previous snapshot and is not a release certificate for the current checkout. [The agent integration audit](AGENT_INTEGRATION_AUDIT.md) is a historical record of that snapshot, not current evidence: its release blocker ("browser-invitation APIs are absent") is obsolete, since browser agents are now invited with presets (`POST /api/agents/browser-invitations`; see [BROWSER_AGENT_TOOLS.md](BROWSER_AGENT_TOOLS.md)). Current status, including what real-device behavior remains untested, is in [OPEN_SOURCE_READINESS.md](OPEN_SOURCE_READINESS.md).
