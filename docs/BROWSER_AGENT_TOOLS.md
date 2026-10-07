# Agents on this Mac: presets and tools

An agent that works from a browser (Muse, ChatGPT agent, a Grok bot) is invited from the phone with **one choice: a preset**. Its API and UI permissions follow from that preset. The agent opens the link in its browser, the owner matches its connection code, and the page becomes the agent's workspace. Bots that automate a browser use the same session through `window.reach`.

These presets require macOS. The protected file helper is macOS-only, so Linux and Windows refuse new Files invitations before issuing credentials; protected file operations with older browser credentials return HTTP 503. Owner Files and Reach terminals are separate capabilities, as is scoped command-line agent access. `GET /api/agents/browser-options` reports `protectedFilesSupported` and `desktopAvailable`; the invitation form disables unavailable presets.

**Full control is trusted access to the owner's OS account.** Its commands are not sandboxed: they can read sensitive files or change Reach, even when the file API or a visible UI target refuses the same operation. Command refusals and protected-window filters are guardrails, not isolation. Apps has no shell API, but a selected terminal or IDE can run commands as the owner. Use Files or a separate account/computer when an agent needs stronger confinement.

## The four presets

| Preset | Sees | Touches | Files | Commands |
| --- | --- | --- | --- | --- |
| **Full control** | The screen with known protected windows filtered | Screen input with guardrails | File API uses shared folders; shell can access other files as the owner | Unsandboxed shell as the owner |
| **Apps** | Only the chosen apps' windows | Only those apps | None | None |
| **Files** | Nothing | Nothing | Chosen folders; read, or read and edit | None |
| **Read only** | The screen with known protected and hidden windows filtered | Nothing | Every shared folder, or the ones chosen; read | Watch chosen terminals |

The preset is one field on the invitation (`policy.preset`). Its scopes, its route allowlist, its tools and the rules the native checker applies are derived from it on every request (`server/agent-presets.mjs`). A stored credential can't grow. Full control and Apps bind the phone that created the invitation (the host guard, as app sessions did): while one exists, ordinary Reach APIs answer only that phone. Lowering a preset later is always allowed; raising Files or Read only into Full control or Apps needs a new invitation from the phone.

## Protected UI targets and command guardrails

The following are refused or filtered when recognized by `server/agent-guard.mjs` and the native checker (`scripts/native/agent-desktop.swift`). They do not prevent equivalent operations through an unsandboxed shell or guarantee isolation against malicious content:

- **Reach and Tailscale**, in every form: their apps, windows and tabs (by title and address), Reach's Terminal window (it titles itself "Reach"), Reach's folder and data, iPhone Mirroring, and commands that would stop them.
- **Password stores:** Keychain Access, Passwords, 1Password, Bitwarden and the like, and the browser pages that show saved passwords or cards (`chrome://password-manager`, `chrome://settings/passwords`, `…/payments`, `about:logins`, …). Developer tools too.
- **Password fields:** recognized secure text fields reject typing. The owner signs in from their phone (Screen) and the agent continues with the session.
- **Anything that needs the owner's password:** `sudo`, `su`, the security prompts (SecurityAgent, Touch ID dialogs), System Settings' privacy, security, login and network panes.
- **The Mac's safety:** Activity Monitor and Force Quit, and a shell deny list: disk tools, shutdown, `csrutil`, `tccutil`, `launchctl`, `security`, scripted keystrokes, recursive deletes of the home or system folders, Reach's own addresses, and paths to secret files (`~/.ssh`, `~/.aws`, shell histories, browser profiles, keychains).
- **The owner's hidden apps:** under Full control and Read only the owner can hide more apps (Messages and Mail are suggested: codes and mail arrive there).

Anything already running or signed in can be available to the agent, including one-click purchases and codes arriving in visible apps. Pages the agent reads can try to steer it. The owner watches the agent live (Settings → Agents), can pause or stop it, and real input on the Mac pauses agent input. These controls cannot undo completed actions.

## Several agents at once

Each invitation is its own session with its own helper process, log and lease. The Mac has one pointer and one keyboard, so **one input operation runs at a time**, including calls from the same agent. Ownership lasts until the operation finishes or its stopped helper actually exits; an idle lease then keeps successive actions together briefly. Competing input is answered `409 {kind: "busy", holder, retryInMs}`. Wait, observe again, and retry the intended action only after access is available. Screenshots are reads and run side by side. Input queued behind a read rechecks authorization, owner pause and phone control immediately before native dispatch. The owner's phone control (Screen) and the owner's pause come before every agent. File edits from Files-with-editing go through the sandboxed helper; Reach's writer coordinator still serialises overlapping folders for the approval-based sessions that remain.

## Tools (`window.reach`)

```js
const tools = await window.reach.listTools();
const access = await window.reach.callTool("reach_access", {});
const shot = await window.reach.callTool("reach_screenshot", {}); // {image, mimeType}
await window.reach.callTool("reach_act", { action: { type: "click", x: 0.42, y: 0.18 } });
```

| Tool | Presets | What it does |
| --- | --- | --- |
| `reach_access` | all | The preset, what it allows, shared folders, expiry |
| `reach_screenshot`, `reach_front` | Full, Apps, Read only | The screen now (protected and hidden windows left out; Apps: chosen apps only); what is in front and whether it takes commands or a password |
| `reach_act` | Full, Apps | One action: `click`, `move`, `drag`, `scroll`, `type`, `key`. Coordinates are fractions of the screenshot. Refusals carry a kind: `blocked`, `busy`, `paused`, `retry` |
| `reach_desktop_apps`, `reach_open_app` | Full, Apps | The apps the session may use, and opening or raising one by path |
| `reach_list_files`, `reach_search_files`, `reach_read_file` | Full, Files, Read only | Reading inside shared folders |
| `reach_change_file` | Full, Files with editing | `write` (whole file, up to 1 MiB), `mkdir`, `rm`, `cp`, inside a shared folder, immediate |
| `reach_read_terminal` | Full, Read only | Output of a terminal the owner chose to share |
| `reach_shell`, `reach_shell_history` | Full | One command as the owner, from inside a shared folder, 60 s and 256 KiB, logged; the deny list refuses and logs the rest |

The stdio MCP adapter advertises the same tools for a compatible credential. There is no invitation, owner-approval or generic HTTP tool, and no tool reaches another agent's session.

## How it is enforced

- **Server.** `agent-presets.mjs` (presets → scopes, routes, policy checks), `agent-guard.mjs` (the protected lists, the shell and typed-text deny list, the rules sent to the native checker), `agent-desktop.mjs` (one helper per session, the lease, the owner's pause, activity for the owner), `agent-shell.mjs` (the shell: clean environment, limits, logging). Typed text is checked as a command when a terminal or IDE is in front.
- **Native.** `agent-desktop.swift` runs per session with rules as data. It checks the observed window or focused element before an action, pauses for owner input, and filters known protected windows from screenshots, including windows inside selected apps. Captures and multi-event actions are not atomic with the OS: content or focus can change while they run. Its pure policy compiles separately for tests.
- **Files.** Files-with-editing uses the sandboxed helper (`browser-files.swift`: descriptor traversal, `O_NOFOLLOW`, kernel sandbox, private names denied). Full control's file API checks shared/private paths too; its separate unsandboxed shell is not confined by that API boundary.
- **Host guard.** While a Full control or Apps session exists, Reach answers only the approving phone (`browser-host-guard.mjs`).

## Earlier invitations

Invitations made with the earlier form (view-only app windows, read-only commands, per-change approvals) keep working until they end. Their routes, approvals and sandboxed scripts remain as described in `SECURITY.md`; new invitations are presets only.
