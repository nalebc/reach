# Agents on this Mac: presets and tools

An agent that works from a browser (Muse, ChatGPT agent, a Grok bot) is invited from the phone with **one choice: a preset**. Its API and UI permissions follow from that preset. The agent opens the link in its browser, the owner matches its connection code, and the page becomes the agent's workspace. Bots that automate a browser use the same session through `window.reach`.

These presets require macOS. The protected file helper is macOS-only, so Linux and Windows refuse new Files invitations before issuing credentials; protected file operations with older browser credentials return HTTP 503. Owner Files and Reach terminals are separate capabilities, as is scoped command-line agent access. `GET /api/agents/browser-options` reports `protectedFilesSupported` and `desktopAvailable`; the invitation form disables unavailable presets.

**Full control is trusted access to the owner's OS account.** Its commands are not sandboxed: they can read sensitive files or change Reach, even when the file API or a visible UI target refuses the same operation. Command refusals and protected-window filters are guardrails, not isolation. Apps has no shell API, but a selected terminal or IDE can run commands as the owner. Use Files or a separate account/computer when an agent needs stronger confinement.

## The four presets

| Preset           | Sees                                                        | Touches                      | Files                                                                   | Commands                       |
| ---------------- | ----------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------- | ------------------------------ |
| **Full control** | The screen with known protected windows filtered            | Screen input with guardrails | File API uses shared folders; shell can access other files as the owner | Unsandboxed shell as the owner |
| **Apps**         | Only the chosen apps' windows                               | Only those apps              | None                                                                    | None                           |
| **Files**        | Nothing                                                     | Nothing                      | Chosen folders; read, or read and edit                                  | None                           |
| **Read only**    | The screen with known protected and hidden windows filtered | Nothing                      | Shared folders, subject to root validation, or the ones chosen; read    | Watch chosen terminals         |

**Folder selection is validated before an invitation is issued.** Full control and Read only may include the owner’s exact Home folder; Files and earlier narrow invitations still require a project or data folder, such as Desktop. Filesystem roots, ancestors of Home, and protected system or application installation directories are refused. With no folders selected, Full control and Read only use all configured shared roots: if any root is invalid, choose valid folders explicitly. Sharing Home does not remove the file API’s protected private names and paths, including credentials, Home’s Library, and Reach’s own code and data. The separate Full control shell remains unsandboxed.

The preset is one field on the invitation (`policy.preset`). Its scopes, its route allowlist, its tools and the rules the native checker applies are derived from it on every request (`server/agent-presets.mjs`). A stored credential can't grow. Full control and Apps bind the phone that created the invitation (the host guard, as app sessions did): while one exists, ordinary Reach APIs answer only that phone. Lowering a preset later is always allowed; raising Files or Read only into Full control or Apps needs a new invitation from the phone.

## Protected UI targets and command guardrails

The following are refused or filtered when recognized by `server/agent-guard.mjs` and the native checker (`scripts/native/agent-desktop.swift`). They do not prevent equivalent operations through an unsandboxed shell or guarantee isolation against malicious content:

- **Reach and Tailscale**, in every form: their apps, windows and tabs (by title and address), Reach's Terminal window (it titles itself "Reach"), Reach's folder and data, iPhone Mirroring, and commands that would stop them.
- **Password stores:** Keychain Access, Passwords, 1Password, Bitwarden and the like, and the browser pages that show saved passwords or cards (`chrome://password-manager`, `chrome://settings/passwords`, `…/payments`, `about:logins`, …). Developer tools too.
- **Password fields:** recognized secure text fields reject typing. The owner signs in from their phone (Screen) and the agent continues with the session.
- **Anything that needs the owner's password:** `sudo`, `su`, the security prompts (SecurityAgent, Touch ID dialogs), System Settings' privacy, security, login and network panes.
- **The Mac's safety:** Activity Monitor and Force Quit, and a shell deny list: disk tools, shutdown, `csrutil`, `tccutil`, `launchctl`, `security`, scripted keystrokes, recursive deletes of the home or system folders, Reach's own addresses, and paths to secret files (`~/.ssh`, `~/.aws`, shell histories, browser profiles, keychains).
- **The owner's hidden apps:** under Full control and Read only the owner can hide more apps (Messages and Mail are suggested: codes and mail arrive there).
- **Bank sites are read-only** (`server/money-sites.mjs`, the same rules in the native checker). `reach_open_bank` opens a listed bank (RBC, TD, Wealthsimple, American Express, …) at its sign-in. On a bank, card, brokerage or payment site in a browser, the agent may sign in from its vault, type a code, read, search, filter by date, download statements and sign out. Refused there:
  - Pressing anything (click, Enter, Space) whose label moves money or commits or changes something: pay, transfer, send, Zelle, payee, submit, confirm, settings, lock and the like.
  - Pressing anything (button, link, tab, list, clickable card) unless every word of its name reads, downloads, filters, chooses a period or an account, or leaves (an allow list: Download, CSV, Show more, Statements, Sign out). A link or card showing an account's number or balance opens that account. On an activity, statements or documents page, Continue, View and Download go on.
  - The words are English and French. In any other language the agent can read the page but press nothing on it.
  - Pressing a control with no readable name.
  - Anything but leaving, on a page whose address or title moves money.
  - Typing into a field that isn't for sign-in, a code, search or a date.
  - Pasting and dragging.
  - Saved tools.

  A page the native checker can't read is refused. Account and card numbers in the screen-as-text show only their last four digits; screenshots are not redacted. Sites are recognized by host from a built-in list, so a bank that isn't listed is not protected. The hidden-display drive tools (`apps:drive`) don't apply these checks.

Anything already running or signed in can be available to the agent, including one-click purchases and codes arriving in visible apps. Pages the agent reads can try to steer it. The owner watches the agent live (Agents & people, the agent's sheet), can pause it or remove its access, and real input on the Mac pauses agent input. These controls cannot undo completed actions.

## Several agents at once

Each invitation is its own session with its own helper process, log and lease. The Mac has one pointer and one keyboard, so **one input operation runs at a time**, including calls from the same agent. Ownership lasts until the operation finishes or its stopped helper actually exits; an idle lease then keeps successive actions together briefly. Competing input is answered `409 {kind: "busy", holder, retryInMs}`. Wait, observe again, and retry the intended action only after access is available. Screenshots are reads and run side by side; they never hold the Mac. When a chat has just updated the Claude app on the Mac, the next click is answered `409 {kind: "busy", stale: true}` until the agent takes a new screenshot. Input queued behind a read rechecks authorization, owner pause and phone control immediately before native dispatch. The owner's phone control (Screen) and the owner's pause come before every agent. File edits from Files-with-editing go through the sandboxed helper; Reach's writer coordinator still serialises overlapping folders for the approval-based sessions that remain.

## The visible agent workspace

An admitted agent lands on **Screen**, the Mac's live screen: a new picture as soon as the last one arrives (at most four a second, sized to the page). The picture is the Mac. A click, double-click, right-click, drag, wheel turn or resting pointer on it happens at the same spot; keys typed while it has focus reach the app in front, which the page names ("Typing goes to …"). Typed characters leave as one `type` action, so terminal checks still see whole lines; from a browser that isn't on a Mac, Ctrl+letter shortcuts become ⌘. After a refused click, typing waits for a click that lands, and input queued behind any refusal is dropped. **Keys** and **Type text** cover what a browser keeps for itself; **Zoom in** shows a quarter of the screen at four times. Persistent navigation exposes **Tools**, **Screen**, **Apps**, **Files**, **Commands**, and **Access**; capabilities outside the current grant are labelled and disabled. Earlier invitations use the same frame while retaining their original controls and owner approvals.

The **Tool library** has task search, service/source filters, named buttons, and a focused input panel. Ready tasks can run directly. Tasks with missing inputs open their panel before any request is sent. Results show returned items and files with expiry, visible-page coverage, and buttons to populate the next tool's inputs. Choosing a next step does not execute it; the agent still runs that tool explicitly. Raw JSON, definitions, and the shared creation protocol remain available for tool authors.

Switching sections keeps pending tools, request IDs, input drafts, and results in the same session. An activity strip returns to the active tool or recording. Screen captures pause outside **Screen**; its ordinary input sequence keeps its lock until completion. A credential change remounts the workspace, and narrowed access removes the corresponding controls and discards obsolete outputs. **Access** displays the current abilities, app/folder selections, and invitation expiry.

## Tools (`window.reach`)

```js
const tools = await window.reach.listTools();
const access = await window.reach.callTool("reach_access", {});
const shot = await window.reach.callTool("reach_screenshot", {}); // {image, mimeType}
await window.reach.callTool("reach_act", {
  action: { type: "click", x: 0.42, y: 0.18 },
});
```

| Tool                                                        | Presets                  | What it does                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reach_access`                                              | all                      | The preset, what it allows, shared folders, expiry                                                                                                                     |
| `reach_screenshot`, `reach_front`                           | Full, Apps, Read only    | The screen now (protected and hidden windows left out; Apps: chosen apps only); what is in front and whether it takes commands or a password                           |
| `reach_act`                                                 | Full, Apps               | One action: `click`, `move`, `drag`, `scroll`, `type` (`paste: true` goes through the clipboard), `key`, `element`, `press`, `fill`, `menu` (a menu path pressed through accessibility). Coordinates are fractions of the screenshot. Refusals carry a kind: `blocked`, `busy`, `paused`, `retry` |
| `reach_windows`, `reach_focus_window`                       | Full, Apps (list: Read only too) | Every window the agent may know of, a browser's with its page and tabs; one brought forward by id, a tab chosen by title                                     |
| `reach_find`                                                | Full, Apps               | Text or a control anywhere in the front window, scrolled into view through accessibility, then the screen read again with its number                                   |
| `reach_menus`                                               | Full, Apps               | The front app's menu bar with shortcuts; never the Apple menu                                                                                                          |
| `reach_read_page`                                           | Full, Apps               | The front window's whole text, 12000 characters a page                                                                                                                 |
| `reach_open_file`                                           | Full (shared folders)    | A file opened in its app or revealed in the Finder; programs, scripts, installers and protected paths refused                                                         |
| `reach_mac_shortcuts`, `reach_run_mac_shortcut`             | Full, Apps               | Shortcuts-app shortcuts the owner switched on (Agents & people → Shortcuts), run as the owner with text in and out; others refused and the owner told once             |
| `reach_desktop_apps`, `reach_open_app`                      | Full, Apps               | The apps the session may use, and opening or raising one by path                                                                                                       |
| `reach_list_files`, `reach_search_files`, `reach_read_file` | Full, Files, Read only   | Reading inside shared folders                                                                                                                                          |
| `reach_change_file`                                         | Full, Files with editing | `write` (whole file, up to 1 MiB), `mkdir`, `rm`, `cp`, inside a shared folder, immediate                                                                              |
| `reach_read_terminal`                                       | Full, Read only          | Output of a terminal the owner chose to share                                                                                                                          |
| `reach_shell`, `reach_shell_history`                        | Full                     | One command as the owner, from inside a shared folder, 60 s and 256 KiB, logged; the deny list refuses and logs the rest                                               |

The shell executes for at most **60 seconds**. Its default request deadline is **70 seconds** for exact `POST /api/browser/shell`, allowing time for termination and logging; other requests retain a 35-second deadline. A transport timeout or disconnect does not prove whether a mutation finished. Observe the result or command history before deciding to submit again; clients do not automatically retry mutations.

Native helper failures return HTTP 503 with `kind: "unavailable"` and a fixed `helperReason`, `helperOperation` and `helperDispatch` tuple. `completion_unknown` means a request write was attempted; it does not prove the action finished. `not_dispatched` means that request was never written to the helper. Raw stderr, request payloads and arbitrary exit details are excluded from this tuple. Actions are not automatically retried: inspect the screen before deciding whether to submit again. A failure category describes what the helper observed, not necessarily its underlying cause.

The stdio MCP adapter advertises the same tools for a compatible credential. There is no invitation, owner-approval or generic HTTP tool, and no tool reaches another agent's session.

## What the owner sees

Every action an agent takes on the Mac is written to the owner's action log (`server/agent-actions.mjs`, `<dataDir>/agent-actions.jsonl`): each click, key, typed text (a glimpse of it, never a vault value), menu item, window switch, opened app, page or file, shell command, file change, tool or shortcut run, and each refusal with its reason. It survives restarts and is read per agent (`GET /api/agents/actions?clientId=…`, owner only) under the agent's **Activity** in Agents & people. Looks (screenshots, the screen as text, the window and menu lists) are not logged one by one.

## How it is enforced

- **Server.** `agent-presets.mjs` (presets → scopes, routes, policy checks), `agent-guard.mjs` (the protected lists, the shell and typed-text deny list, the rules sent to the native checker), `agent-desktop.mjs` (one helper per session, the lease, the owner's pause, activity for the owner), `agent-shell.mjs` (the shell: clean environment, limits, logging). Typed text is checked as a command when a terminal or IDE is in front.
- **Native.** `agent-desktop.swift` runs per session with rules as data. It checks the observed window or focused element before an action, pauses for owner input, and filters known protected windows from screenshots, including windows inside selected apps. Captures and multi-event actions are not atomic with the OS: content or focus can change while they run. Its pure policy compiles separately for tests.
- **Files.** Files-with-editing uses the sandboxed helper (`browser-files.swift`: descriptor traversal, `O_NOFOLLOW`, kernel sandbox, private names denied). Full control's file API checks shared/private paths too; its separate unsandboxed shell is not confined by that API boundary.
- **Host guard.** While a Full control or Apps session exists, Reach answers only the approving phone (`browser-host-guard.mjs`).

## Saved agent tools

Chrome and Safari also expose deterministic tools built from `reach.tool.v1`. The nine prebuilt tools and agent-created tools use the identical definition validator and runtime. `reach_tools({query})` returns their complete definitions. `reach_tool_protocol({})` explains input types, value templates, exact targets, nested identity checks and fixed operations. `reach_define_tool({definition})` validates and saves a new definition with an immutable ID and immediately adds its named button and `reach_tool_*` MCP tool; MCP emits `notifications/tools/list_changed`. An agent using the visual workspace can use **Create deterministic tool** to inspect the same protocol and definitions and submit the same JSON. [The exported protocol](agent-tool-protocol.json) includes all built-in definitions.

To execute a named tool, supply `browser: "Chrome"` or `"Safari"`, its declared inputs and a fresh UUID `requestId`. The server holds the Mac's input lease and checks the invitation, selected browser, pause and owner input before every phase. It binds operations to the exact page/document and item identity. Every action requires one visible matching target; missing, ambiguous or stale targets stop it. `wait` retries only a bounded read. There is no JavaScript/shell operation or inferred recovery step. Password/code fields and protected browser pages stay closed. Definitions can operate only on their declared public HTTPS origins. Creating a tool does not increase access.

Each run's request ID and payload hash are written privately before execution. Retrying the same ID returns its status without repeating effects; using the ID with different inputs is refused. `reach_tool_operation({requestId})` recovers status after a lost response. A crash leaves pending operations uncertain. Completed actions are not undone. Runs have a 30-second deadline, the transport budget is 70 seconds, definitions at most 24 steps/12 inputs/24,000 bytes, and the custom store at most 100 tools. Item handles expire in five minutes; private files in fifteen minutes, at most 8 MiB. Both also end at invitation expiry, revocation or restart. Handles are scoped to their invitation; selected items also to their browser and unchanged document.

The Gmail/Walmart adapters check their declared English layouts and supported download links. Search coverage is the visible result page. Gmail composition creates a draft, refuses an existing dialog and never sends. A Walmart receipt is a plain-text PDF snapshot of the verified order details. These adapters are covered by controlled-page tests; live signed-in-account compatibility remains a separate check. Native browser execution requires the host's **Allow JavaScript from Apple Events** and macOS Automation permissions; missing permission or sign-in challenges stop without falling back to keyboard guesses.

### Many tabs at once (`reach_tool_batch`)

One named tool for up to 10 items, each in a Chrome tab of its own: a grocery list, a price check across several searches. The tabs open behind the tab the owner is looking at, and their pages load side by side. Then each item runs as an ordinary run, one tab after another, so clicks on one site's cart never race each other. Nothing comes to the front and the pointer never moves: the steps run in the page, not on the screen. The result has one entry per item (`status`, `completedSteps`, `data`, or `code` and `error`).

- **How agents find it:** its description starts with what it's for, each saved tool's description and `reach_tools` name it, and the one-line instructions Reach sends an MCP client on connecting say: for a list of items, use `reach_tool_batch`.
- **More than 10 items:** call again with the next 10 and a new `requestId`.
- **A lost or partial response:** call again with the same `requestId` and items. Each item has its own request ID derived from the batch's, so a finished item is never repeated, and `reach_tool_operation` reads any one of them. A batch starts no new item after 30 seconds; it says so in `next`.
- **Shopping:** batch a search tool that collects results with `keepTabs: true`, pick the right product's handle for each item, then batch a handle tool (`use`, then the Add click) on those handles. Read the cart once at the end.
- **Tabs:** a batch never uses or closes the owner's own tabs. At the end it closes the tabs Reach opened for it, if they're still on the tool's sites, unless `keepTabs` is set; kept tabs close with the batch that uses their handles.
  - At most 10 batch tabs are open on the Mac at once, all agents together. Past that, items come back `not_started` with `tab_limit` and no tab opens.
  - A kept tab, or one left open because its item stopped, closes on its own after 5 minutes (when its handles expire). So do an agent's tabs when its access ends. Reach records its batch tabs in its data folder, so after a restart it still closes them, but only on the exact page they were left on.
  - A retry with the same `requestId` reuses the tabs it already opened.
  - Reach never closes a tab that has left the tool's sites or that the owner has brought to the front. That tab is the owner's now.
  - One batch runs at a time on the Mac.
- **Stops:** an item that fails doesn't stop the others. A stop every later item would meet ends the batch, and the rest come back `not_started`. Those stops are setup, sign-in, browser closed, access changed, another tool taking the Mac, or two pages that never settle on their address.

Chrome only: Safari names a tab by its position, which opening tabs shifts. Every guard of a single run applies to each item: declared origins, bank sites, protected pages, the owner's pause and input. Batches record the round trips they spare in the savings ledger (`tab-batch`).

Full control and Apps agents can record a task through `reach_record_shortcut({name})`, perform normal app/screen actions, verify the result, then call `reach_save_shortcut({})`. `reach_discard_shortcut({})` drops an unfinished recording. `reach_shortcuts({query})` finds and inspects permitted tasks. Each enabled task also appears as a named `reach_saved_*` tool in the browser and MCP catalogs; `reach_run_shortcut({id, values})` runs the same recipe directly. MCP emits `notifications/tools/list_changed` after a successful save. Tools created in one admitted session can be reused by another only when all their apps remain permitted.

Typed text is supplied again through required `text1`, `text2`, … arguments. A plain HTTPS origin landing page can be recorded as navigation; paths, queries and fragments stay inputs. Text-producing key recording is refused so literal typed characters are not retained. Saved window title/layout fingerprints avoid persisting their raw values; fresh matching context is checked again by the native input helper. Fingerprints are not encryption. Task names and app identities remain visible to agents that can use the task.

A recipe has at most 60 steps; the store holds at most 100 recipes. Replay checks its 25-second budget and current authorization between operations. An in-flight native operation can still take time to drain; clients allow a 70-second response budget. A stopped response reports confirmed progress. Observe the screen and continue from that state rather than automatically repeating the recipe. Completed actions cannot be undone by cancellation.

The owner can inspect, disable or delete tasks in **Agents & people → Shortcuts** (a row that appears once a task is saved), and stop a specific active replay. Stop is bound to the displayed run ID, so a stale control cannot cancel a later run. Permission changes, revocation, expiry, pause and protected-target checks continue to apply. A recorded task is not a broader grant or an exemption from normal app restrictions.

## Earlier invitations

Invitations made with the earlier form (view-only app windows, read-only commands, per-change approvals) keep working until they end. Their routes, approvals and sandboxed scripts remain as described in `SECURITY.md`; new invitations are presets only.
