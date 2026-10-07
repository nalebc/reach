# Agents on this Mac: presets and tools

An agent that works from a browser (Muse, ChatGPT agent, a Grok bot) is invited from the phone with **one choice: a preset**. Everything it may do follows from the preset; what stays protected never changes. The agent opens the link in its browser, the owner matches its connection code, and the page becomes the agent's workspace. Bots that automate a browser use the same session through `window.reach`.

## The four presets

| Preset | Sees | Touches | Files | Commands |
| --- | --- | --- | --- | --- |
| **Full control** | The whole screen | Everything not protected | Every shared folder, or the ones chosen; read and change | A shell, as the owner |
| **Apps** | Only the chosen apps' windows | Only those apps | None | None |
| **Files** | Nothing | Nothing | Chosen folders; read, or read and edit | None |
| **Read only** | The whole screen | Nothing | Every shared folder, or the ones chosen; read | Watch chosen terminals |

The preset is one field on the invitation (`policy.preset`). Its scopes, its route allowlist, its tools and the rules the native checker applies are derived from it on every request (`server/agent-presets.mjs`). A stored credential can't grow. Full control and Apps bind the phone that created the invitation (the host guard, as app sessions did): while one exists, ordinary Reach APIs answer only that phone. Lowering a preset later is always allowed; raising Files or Read only into Full control or Apps needs a new invitation from the phone.

## What stays protected, in every preset

Decided in `server/agent-guard.mjs` and applied by the server and the native checker (`scripts/native/agent-desktop.swift`), never configurable:

- **Reach and Tailscale**, in every form: their apps, windows and tabs (by title and address), Reach's Terminal window (it titles itself "Reach"), Reach's folder and data, iPhone Mirroring, and commands that would stop them.
- **Password stores:** Keychain Access, Passwords, 1Password, Bitwarden and the like, and the browser pages that show saved passwords or cards (`chrome://password-manager`, `chrome://settings/passwords`, `…/payments`, `about:logins`, …). Developer tools too.
- **Password fields:** the agent never types into a secure text field. The owner signs in from their phone (Screen) and the agent continues with the session.
- **Anything that needs the owner's password:** `sudo`, `su`, the security prompts (SecurityAgent, Touch ID dialogs), System Settings' privacy, security, login and network panes.
- **The Mac's safety:** Activity Monitor and Force Quit, and a shell deny list: disk tools, shutdown, `csrutil`, `tccutil`, `launchctl`, `security`, scripted keystrokes, recursive deletes of the home or system folders, Reach's own addresses, and paths to secret files (`~/.ssh`, `~/.aws`, shell histories, browser profiles, keychains).
- **The owner's hidden apps:** under Full control and Read only the owner can hide more apps (Messages and Mail are suggested: codes and mail arrive there).

What stays open and is said so in the invitation: anything already running or signed in is open to the agent, including one-click purchases and codes arriving in visible apps. Pages the agent reads can try to steer it. The deny list stops obvious harm; it is not a sandbox, and the shell runs as the owner. The owner watches the agent live (Settings → Agents), can pause or stop it, and their own hands always win: real input on the Mac pauses the agent.

## Several agents at once

Each invitation is its own session with its own helper process, log and lease. The Mac has one pointer and one keyboard, so **one agent acts at a time**: an action takes a short lease that each further action extends; another agent's action is answered `409 {kind: "busy", holder, retryInMs}` and should wait. Screenshots are reads and run side by side. The owner's phone control (Screen) and the owner's pause come before every agent. File edits from Files-with-editing go through the sandboxed helper; Reach's writer coordinator still serialises overlapping folders for the approval-based sessions that remain.

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
- **Native.** `agent-desktop.swift` runs per session with the rules as data. Before posting each event it inspects the real target: the window under the pointer (window server and Accessibility), the focused element for keys and text (secure fields, page addresses, titles), the app set in Apps mode. It pauses while the owner uses the Mac and leaves protected windows out of screenshots. Its pure policy compiles on its own for tests.
- **Files.** Files-with-editing changes files through the sandboxed helper (`browser-files.swift`: descriptor traversal, `O_NOFOLLOW`, a kernel sandbox, private names denied). Full control writes directly inside shared folders, never into private paths.
- **Host guard.** While a Full control or Apps session exists, Reach answers only the approving phone (`browser-host-guard.mjs`).

## Earlier invitations

Invitations made with the earlier form (view-only app windows, read-only commands, per-change approvals) keep working until they end. Their routes, approvals and sandboxed scripts remain as described in `SECURITY.md`; new invitations are presets only.
