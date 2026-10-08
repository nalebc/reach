# Reach

**Your devices, within reach.** A private, mobile-friendly workspace for accessing your computers from iPhone, Android, or another computer. A companion runs on your computer and gives you an HTTPS link to open in any phone browser. Commands run on your computer; files travel over your private Tailscale connection.

Use Reach to continue a coding conversation away from your desk, get a file from your computer, work in a terminal, see and control your desktop, or give an assistant limited access to help. Reach runs on your own computer; it does not supply an AI account or keep your computer available when it is asleep or powered off.

**Release status:** the October 7 audit found and repaired authorization, revocation, agent-tool and chat-sync defects. Open-source qualification is still in progress. See the [audit and test matrix](docs/AUDIT_2026-10-07.md) for actual results and the [remaining release gates](docs/OPEN_SOURCE_READINESS.md). The audit separates real browser/API/provider tests from simulated native input and tests blocked by account or OS permissions.

## Supported platforms

- **macOS host, phone in the browser (Safari on iPhone, Chrome on Android):** the primary target. Local macOS tests pass; physical-phone acceptance for this candidate is still required.
- **Windows host:** experimental. It requires a successful candidate CI run and a physical-host test. Browser-agent invitations are unavailable; their protected helpers require macOS.
- **Linux host:** owner file browsing and Reach terminals; no desktop screen or app control. Browser-agent invitations are unavailable. Scoped command-line agent access uses its separate file/command permissions.
- **Native iOS app:** optional developer build, unsigned. The browser needs no app.

## A look inside Reach

[![Animated Reach interface tour: Home, Files, Chat, Settings and agent access](docs/media/reach-demo.gif)](docs/media/reach-demo.mp4)

[Watch or download the MP4](docs/media/reach-demo.mp4) · [Still preview](docs/media/reach-demo-poster.png)

*A refreshed October 7 interface walkthrough (23.7-second MP4) captured from the actual app at phone width, using sample devices, files, conversations and the current agent presets. It is a captioned sequence of browser captures, not a recording of live remote control or provider responses. Codex and Claude require their own installation and sign-in. Computer access uses Tailscale connectivity; the browser can run its own Tailscale node without a separate phone app.*

The isolated [demo fixture and capture instructions](scripts/demo/README.md) let contributors reproduce the same interface without connecting to a computer or exposing personal data.

This is an early-access release, not a signed App Store or Microsoft Store application. Phones act as clients, not remotely controlled hosts. See [Supported platforms](#supported-platforms) for what is tested.

The browser connection embeds Tailscale in WebAssembly. Reach's API and WebSockets stay on private Tailscale Serve (port 8443). A start page and a signed agent gateway on port 443 go public through **Tailscale Funnel only while an invitation is waiting to be opened or a browser agent's session is live**; otherwise port 443 is closed. **Face ID for a new browser** of yours (a passkey this computer knows) admits that browser as a tagged device with an owner credential, without a Tailscale login; it works only while the start page is up. Read the [current security model](docs/SECURITY.md) first. Physical iPhone/Android validation remains a release gate.

## What works

- Pair multiple computers with one-time, expiring codes. Switch between saved connections.
- A responsive workspace with an interactive device constellation, animated connection paths, and cards for real Codex sessions and terminals. Pause ambient motion from the top bar; Reach remembers the setting, follows reduced-motion preferences, and pauses animation when the page is hidden.
- Browse configured shared folders, preview text, images and PDFs, read Markdown formatted or as source, share files to phone apps, download files, upload large files (resumable, with progress), create folders, and transfer files between paired computers.
- Select several files to share them together. **Send to agent** gives a writable Codex or Claude conversation on the same computer the selected file or folder paths, with an optional message. It sends paths rather than uploading copies; that agent needs permission to read them. Read-only conversations explain why they cannot receive a message.
- Owners can **Unzip** ZIP, TAR and gzip-compressed TAR archives beside the original. Existing results receive a new name. Extraction is limited to 64 MiB compressed, 256 MiB expanded, 64 MiB per file, 4,096 entries and one minute. Guests and agents cannot extract archives; Bzip2/XZ archives must be downloaded and opened locally. See [the API contract](docs/API.md#files--scope-files-or-agent-filesread--fileswrite).
- Create real PTY terminals (zsh/bash on Mac, PowerShell on Windows). Reconnect to output after closing the browser. Shells survive browser/network disconnects while the companion remains running; they do **not** survive a companion restart or reboot.
- On Mac, **Terminals** automatically discovers existing Apple Terminal tabs and iTerm2 panes in its default **On your Mac** view. The list updates as tabs open and close; **Reach terminals** contains shells created by Reach. Select one to view its text (Apple Terminal tabs include their scrollback; iTerm2 panes show the visible screen), send text followed by Enter, show it on the Mac, or close it with confirmation. The stop button in an open terminal's header ends a Reach shell or closes a Mac tab, after confirming. You can also open a new window in either app. macOS may ask for Automation permission for the app running Reach; allow it in **System Settings → Privacy & Security → Automation**. These existing sessions stay owned by their terminal app and are not stopped when Reach shuts down. This is a text view, not a takeover of the terminal's PTY: use Screen for full-screen programs and keyboard shortcuts. VS Code, Cursor, Ghostty, and other terminal apps are not integrated yet. Only full-access paired people can use this feature; scoped agent keys cannot.
- Launch installed Mac/Windows applications on the computer’s desktop.
- **Chat** brings detected Codex threads, Claude Code sessions, Gemini CLI history (read only) and OpenClaw conversations into one list. Read streamed replies, command output, file diffs and subagent activity; send messages with files and answer questions or approvals. Provider-specific controls include model, effort, speed and permission choices; queue editing, removal and Send now; rename, archive, export, fork, edit-last and Claude rewind. Move conversations between Codex and Claude with their history. Context indicators show reported token usage; when capacity is unknown, Reach shows the count without inventing a percentage. Install and sign in to each agent on the computer first. Native app support varies: Reach does not yet inventory pending messages created directly in Claude's own queue. Full desktop-app ↔ Reach synchronization, including cancellation, settings, moves and restart recovery, still requires the recorded [acceptance checks](docs/OPEN_SOURCE_READINESS.md).
- **Connectors** (Chat → the plug button): give Claude Code, Codex and Gemini CLI access to GitHub, Linear, Notion, Sentry or any MCP server by its address, once for all of them. Each is saved in the agent's own settings on the computer, so its app and terminal have it too. Codex uses ChatGPT's own apps where one exists (GitHub, for one), and Claude Code shows the connectors of its claude.ai account. GitHub takes a token (pasted, or the GitHub CLI's sign-in on the computer); for the others you sign in from the phone and paste back the address the browser lands on. Gemini CLI signs in itself: run `gemini` on the computer (a Reach terminal works), then `/mcp auth <name>`. See [Connectors](docs/AGENTS.md#connectors-for-claude-code-codex-and-gemini-cli).

  Windows currently supports the separate Codex app-server connector path when its daemon is available; Claude/Gemini CLI connector management and Claude CLI sign-in are unavailable there.
- Remote desktop with H.264 video targeting 30 or 60 fps, display selection, trackpad/direct touch, dragging, pinch zoom and pan, a visible cursor, modifier shortcuts, explicit text clipboard transfers, and fullscreen. Mac uses VideoToolbox; Windows video needs FFmpeg with libx264. A JPEG compatibility mode supports browsers without H.264 WebCodecs. Viewing and control are separately enabled; OS permissions are required. See [Remote desktop](docs/REMOTE_DESKTOP.md).
- Apps on your phone (Mac): tap an app and it runs on the Mac in a window shaped like your phone, on its own hidden display, full screen on the phone with touch, scrolling and the phone keyboard. Several apps can be open at once; the Mac's screen stays untouched. See [Apps on your phone](docs/APP_THREADS.md).
- Scoped agent credentials, asynchronous command jobs, output polling, timeout/cancellation, a CLI, and a stdio MCP adapter.
- Browser invitations for an assistant with a browser (Mac): one preset (**Full control**, **Apps**, **Files** or **Read only**) decides what it sees, touches, reads and runs. Full control is trusted access to your signed-in account; its shell is not isolated. See [AI browser invitations](#ai-browser-invitations).
- Tag in (Mac): an agent with `apps:drive` uses apps on its own hidden displays and hands one to you when a person is needed (a code, a confirmation). It shows on your phone's Home as **Needs you**: **Open** the live app, then **Done** to hand it back or **Stop**. Clicks, typing and keys go to the agent's own app while you keep using the Mac; what needs the pointer or a menu waits until nobody has used the Mac for 15 seconds. See [the agent guide](docs/AGENTS.md).
- Notifications: the bell panel turns them on and tells your phone when an agent hands you an app, holds a question for you, or asks for access, even with Reach closed. On iPhone, add Reach to the Home Screen first. They come from the computer whose link you opened, say only what needs you, and are encrypted for your phone.

Reach adapts to the connected computer and your permissions. Unsupported features are hidden from navigation and Home; Mac-only terminal discovery is limited to owners, and Linux hosts show files/terminals without desktop controls. Chat shows an agent only when it is detected on the computer (Codex also needs a signed-in account). Optional setup is available in Settings. Capabilities refresh automatically while Reach is open; **Check again** in Settings refreshes readiness. External agent access is independent of these chats.

## AI browser invitations

Open **Invite someone → Agent → Browser link** to invite an assistant that works from a browser (Muse, ChatGPT agent, a Grok bot). Name it and make one choice, a preset:

These browser presets currently require a macOS host. Files uses a protected native file helper, unavailable on Linux and Windows; those hosts refuse a new Files invitation before issuing credentials. This does not disable your own Files or terminals, or the separate **Command line** agent connection. Older browser credentials also receive HTTP 503 for protected file operations on unsupported hosts.

| Preset | Sees | Touches | Files | Commands |
| --- | --- | --- | --- | --- |
| **Full control** | The screen with known protected and hidden windows filtered | Screen input with guardrails | Shared or chosen folders, subject to validation; read and change | A shell, as you |
| **Apps** | Only the chosen apps' windows | Only those apps | None | None |
| **Files** | Nothing | Nothing | Chosen folders; read, or read and edit | None |
| **Read only** | The screen with known protected and hidden windows filtered | Nothing | Shared or chosen folders, subject to validation; read | Watch chosen terminals |

Folder grants are validated before an invitation is issued. Full control and Read only can include your exact Home folder; Files requires a project or data folder, such as Desktop. Filesystem roots and protected system/application installation directories are refused. Full control and Read only use all configured shares unless you choose folders: if those defaults include Computer or another invalid root, choose valid folders explicitly. The file API still excludes protected private paths.

Choose 15 minutes, 30 minutes, 1 hour, 24 hours, or **Always** (until you end it) when available, then **Copy invite** and give the text to the assistant. The text names its preset, what stays closed and how to behave (one agent acts at a time; your hands come first), then the link. Everything the agent may do is derived from the preset on every request (`server/agent-presets.mjs`): its scopes, its route allowlist, its tools (`window.reach`, or the same tools through the stdio MCP adapter) and the rules the native checker applies. A stored credential cannot grow. There are no per-action approvals: Full control grants trusted use of the signed-in account, and Files with editing changes files immediately.

**Desktop guardrails** (`server/agent-guard.mjs`, applied by the server and by a native checker that inspects recognized targets before dispatch): Reach and Tailscale in every form; password stores and the browser pages that show saved passwords or cards; recognized password fields (sign in from your phone rather than sharing credentials with the agent); security prompts, `sudo` and anything else that needs your password; System Settings' privacy, security, login and network panes; Activity Monitor and Force Quit; developer tools; and a shell deny list (disk tools, shutdown, `csrutil`, `tccutil`, `launchctl`, `security`, scripted keystrokes, recursive deletes of home or system folders, paths to secret files). Under Full control and Read only you can hide more apps; Messages and Mail are suggested, since codes and mail arrive there. Other apps can be available, subject to these guardrails and the [documented limitations](docs/AGENT_ACCESS_ACCEPTANCE.md). Pages the agent reads can try to steer it, and the shell runs as you. The deny list stops some obvious harmful commands; it is not a sandbox. A Full control shell can still read sensitive files or invoke other programs with your account’s rights. Hidden apps, password-field checks and blocked UI targets do not confine that shell. Use Files without editing for tasks that only need to read selected documents.

**While it works:** one native input operation runs at a time, including calls from the same agent. Ownership lasts until it finishes or its stopped helper exits, followed by a short idle lease. A competing input receives "busy": wait and observe again before retrying. Reads and shell commands can run concurrently. Settings → **Agents** shows each agent's preset and what it is using right now, with **Pause** and **Stop**. Reach checks for your input and pauses agent actions when it detects you using the Mac. Already-dispatched OS actions may finish. Full control and Apps bind the phone that created the invitation: while such a session exists, Reach answers only that phone (the host guard). Lowering a preset later is allowed from **People with access**; raising into Full control or Apps needs a new invitation from the phone.

If the native helper fails, Reach distinguishes a request never dispatched from one whose completion is unknown. Actions are not automatically retried; inspect the screen before deciding whether to try again. A failure report does not by itself identify the cause.

**Approve the first connection:** opening the link consumes it into a waiting request that has no access yet. In **Home → Needs you**, compare the six-digit code with the one the agent shows, then **Approve connection** or **Deny**; only a paired owner device may decide, within five minutes. The invitation name is your label, not proof of who opened the link. A stolen unused link can create a request, but that request gets no access without your approval. Invitations are single-use and must be opened within 15 minutes; the credential ends at the chosen deadline, or when you end it.

**How it connects:** the agent's browser reaches the computer through Tailscale Funnel on port 443, at a signed gateway (`server/funnel-agent.mjs`). Each request is an envelope signed with the agent's own P-256 key (ECDSA, with a nonce and a one-minute clock window), the gateway accepts a fixed set of paths that is independent of Reach's route table, and the invitation's own allowlist applies behind it. TLS ends on the Mac. The gateway and the start page are public only while an invitation is waiting to be opened or an agent session is live (`scripts/ephemeral-funnel.mjs`); otherwise port 443 is closed. The agent's credential cannot create invitations, change grants, approve requests or reach another agent's session. Your own phone uses port 8443 inside the tailnet.

Invitations made with the earlier form (view-only app windows, read-only commands, per-change approvals) keep working until they end. Command-line agents (Claude Code, Codex) still use read / edit / run roles via **Invite someone → Agent → Command line**; see [Agents](#agents). The precise contract, tool by tool, is in [browser-agent tools and limits](docs/BROWSER_AGENT_TOOLS.md). The [agent acceptance matrix](docs/AGENT_ACCESS_ACCEPTANCE.md) covers successful tasks, permission boundaries, owner interruption and multi-agent access, and identifies the remaining real-host checks.

## Cloud agent CLI

Use `./reach-agent` to grant a Bedrock/AgentCore or other cloud agent short-lived read/write access to selected folders. The Mac enforces named profiles, folder limits and expiry. `join` runs an isolated ephemeral Tailscale connection with a dedicated tag, auth-key file or workload identity, and cleanup on exit. CLI and MCP requests use its private proxy. Shell access is disabled in the generated profile.

See [Agent CLI setup](docs/AGENT_CLI.md) for owner commands, restricted tailnet grants, cloud integration, and revocation. A tailnet administrator must review/apply the network policy; the CLI does not modify it automatically.

## Install

Install from source until 0.1.0 is on npm. Use a source checkout with Node.js 22 or newer and the Go version in `tailnet/go.mod`:

```sh
git clone https://github.com/nalebc/reach.git
cd reach
./reach
```

On Windows, use `.\reach.cmd` in place of `./reach` (experimental; see [Supported platforms](#supported-platforms)).

Once 0.1.0 is on npm:

```sh
npm install --global @nalebc/reach
reach
```

`reach` then works from any folder, with the same commands as `./reach` below (`reach configure`, `reach install`, `reach status`, `reach pair`…). It keeps your settings and paired phones in `~/.reach`, so updates (`reach update`) never touch them. The package runs no install script of its own; its terminal component (node-pty) runs its standard one, and on Linux needs a compiler (`build-essential`/Xcode tools) if no prebuilt binary matches.

Moving from a downloaded Reach folder? Stop it (Ctrl+C, and `./reach uninstall` if you used background mode), then run `reach import /path/to/that/folder` before the first `reach`, to keep your paired phones and settings.

## One-command start

From your downloaded Reach folder, run:

**Mac or Linux**

```sh
./reach
```

**Windows (PowerShell or Command Prompt)**

```powershell
.\reach.cmd
```

That command prepares Node.js if needed, installs dependencies, builds the interface, and starts a private Tailscale HTTPS link. First setup needs internet access; subsequent starts reuse the runtime and build.

**First run: a short guided setup.** On Mac/Linux, `./reach` walks you through four steps, then starts Reach: **1. Tailscale** (it waits while you install or sign in, and opens the right page) and confirming your **personal Tailscale account**; **2. the HTTPS link** (if MagicDNS or HTTPS certificates are off for your tailnet, it opens that one Tailscale page and waits); **3. invite links** (optional, now or later): paste one Tailscale access token and Reach adds its two rules to your Tailscale policy and makes its own limited key, or do it by hand; **4. background mode** (Mac, optional): keep Reach running after you close the terminal, and approve your phone right there. Each step is saved as it finishes: stop any time with **Ctrl+C** and `./reach` picks up where you left off. Change anything later with `./reach setup` (or go straight to one step: `./reach setup invites`, `account`, `link`, `background`). A computer set up before this flow starts with no questions. Setup uses **↑/↓ and Enter** menus with recommended choices; basic terminals use numbered menus. Staying awake is automatic and does not add a setup question. Reach does not install a VPN or change OS permissions silently. No Supabase project, separate Reach account, or hosted Reach backend is required; Tailscale still supplies its coordination service.

1. Scan the terminal QR with the phone camera, or open the printed link. With the **Tailscale app** on (same account) the phone connects directly at the private address, which is fastest and works at any time. Without the app, the phone signs in to Tailscale right in the browser (nothing to install) from the start page on port 443, which is public only while an invitation or a browser agent's session is live (see [Connection and distribution limits](#connection-and-distribution-limits)).
2. Tap **Connect**.
3. Match the eight-character request on your phone with the request in the Mac’s Reach terminal. Type that request there to approve. When running Reach in the background, run `./reach approve` locally instead. Use `deny <request>` to refuse one.
4. Future visits use the saved, device-bound session. There is no separate Reach login. Each new browser needs approval; expired or revoked sessions need approval again. **Face ID instead:** after your first browser is approved, tap **Use Face ID next time** (or Settings → Access → Face ID for new browsers). Your phone's other browsers then show **Use Face ID** and are approved with it, without waiting for the computer. With invite links set up too, a new browser without the Tailscale app needs only Face ID: open the link, tap **Continue with Face ID**, and you're in (no Tailscale login; see Face ID sign-in in [docs/SECURITY.md](docs/SECURITY.md)). That browser-only path runs from the start page, so it works only while the start page is public (an invitation or agent session window); phones with the Tailscale app are unaffected.

The normal QR contains **only the computer's address**, not a credential. A copy does not grant access. Owner access uses either the configured Tailscale account with device approval, or a registered passkey followed by one-time tagged-device admission. Both issue a saved Reach credential bound to that Tailscale device. The local approval grants owner capabilities, including running commands as your OS account; screen viewing/control still have their own switches and permissions.

For automatic reconnection on **iPhone/iPad**, open Tailscale → Settings → **VPN On Demand**, and enable **MagicDNS hostname matching**. Opening the `.ts.net` link can then activate Tailscale. These VPN settings apply when using the separate Tailscale app. Browser-node sign-in is the alternative on supported browsers. See [Tailscale’s iOS instructions](https://tailscale.com/docs/features/client/ios-vpn-on-demand).

**Compatibility:** the new approval flow supports Mac/Linux hosts with a recent Tailscale version that supports Serve Unix socket targets. On sandboxed Mac Tailscale builds, Reach places only its private listener socket in Tailscale’s app-group container; macOS may ask for access. Windows and explicit `--local` mode retain the pairing-code flow. The updated native iOS QR scanner accepts private address QRs after rebuilding the app; Safari works without an app rebuild.

`./reach pair` remains a one-use, ten-minute fallback. With Tailscale approval configured, even a valid pairing code must arrive through the verified Tailscale ingress from the configured owner account; its resulting credential is device-bound. Pairing QRs contain a temporary secret and should not be shared. Older owner sessions must be approved or paired again once after enabling this mode. Existing guest and agent credentials keep their separate scopes and expiry.

Keep the computer awake and the terminal open. **Ctrl+C stops sharing, the companion, and its running jobs/terminals.** On Mac the launcher prevents idle sleep while running, but closing the lid can still put the computer to sleep. The phone can use cellular or another Wi-Fi network. Add the link to your phone’s home screen if desired. The address stays the same while the Tailscale device name and HTTPS port remain unchanged.

```sh
./reach --folder "$HOME/Documents"   # choose shared folders; repeat --folder for more
./reach --local                       # local access only, without a tunnel
./reach --https-port 9443             # if the default private HTTPS port 8443 is occupied
./reach --help
```

New setup makes your whole computer browsable without asking for folder paths: Files starts in **Home**, with **Computer** (or drive locations on Windows) alongside it. This includes mounted volumes reachable under those locations. Your OS permissions still apply; macOS may require Files and Folders or Full Disk Access permission for protected locations. Reach never elevates privileges and excludes its private state. Existing saved folder restrictions remain in effect; run `./reach configure` and choose **All files on this computer (Recommended)** to change them. `--folder` or `REACH_ROOTS` can still restrict browsing. Guest invitations require an explicit location selection; agent profiles keep their folder limits. Paired clients have command execution with your OS account’s permissions; shared folders do not sandbox commands. Choose a trusted phone and use Settings to revoke it. Screen access is off initially and still requires OS permissions. Codex must already be installed and signed in to use its conversations.

### Connection and distribution limits

The default uses [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve) on HTTPS port 8443. Both devices need Tailscale connectivity and an applicable tailnet access rule. HTTPS may need to be enabled by the tailnet owner on first use. The local health listener stays on loopback. Configured owner authentication uses a separate mode-0600 Unix socket in a mode-0700 private directory, so localhost callers cannot forge Tailscale identity headers. It resolves the verified source IP with Tailscale WhoIs and pins the user ID and stable node ID. For its private port, Reach refuses occupied Serve ports or ports configured for public Funnel, monitors its Serve route while running, and never falls back to a public tunnel for its API. Funnel-marked requests are answered only by the start page and the signed agent gateway described below, never by the owner API or a WebSocket. Existing Serve services are not replaced. The route is Tailscale daemon state (a background Serve): it stays while Reach is stopped so the next start reuses it without a gap, and `./reach uninstall` removes it.

**One address, open on demand.** Reach can also publish a start page at `https://<computer>.<tailnet>.ts.net` (port 443) through Tailscale Funnel, but only while an invitation is waiting to be opened or a browser agent's session is live (`scripts/ephemeral-funnel.mjs` switches a background Funnel route on while a window is open and off when it ends; a separate janitor process holds a five-second lease and switches the route off if Reach itself dies). At other times port 443 is closed. While it is up, the internet gets fixed files (the start page, the app's built code, the browser Tailscale client), the two Face ID sign-in endpoints, and the signed agent gateway (`/agent-gateway`, `server/funnel-agent.mjs`): an invited browser agent's API requests arrive as ECDSA-signed envelopes, the gateway accepts a fixed set of paths, and the invitation's own allowlist applies behind it. TLS ends on the Mac. Owner APIs and WebSockets are never answered to the internet. A phone with the Tailscale app on reaches the private address directly (fastest: device to device). A phone without it signs in to Tailscale in the browser from the start page and becomes a device on your tailnet; Reach then runs through that in-page Tailscale connection (relayed by Tailscale, so slower than the app, and large downloads are held in memory). Either way, the computer identifies the device with `tailscale whois` and asks you to approve it. Building the browser client needs Go; `./reach` builds it on first run. If port 443 is used by another service, Reach leaves it alone: invitations over the public link fail with a clear message, and phones need the app.

**Several computers.** Run Reach on each computer. When Reach finds another Reach computer on your Tailscale account, its terminal offers `link <name>`; type it on both computers. Then a phone approved on one is approved on all of them, revoking it on one revokes it everywhere, every computer shows the same link, and the phone's computer switcher lists them all. A computer that isn't linked yet shows as a dimmed chip that says how to link it.

**Invites.** **Invite someone** (on Home, or More → Invite someone): pick the computers, then what they may use (folders, screen watch or control, apps, terminals, AI sessions, or full access) and for how long. Run `./reach invites` once to set up invite keys: the guest then just opens the link, with no Tailscale account or app, while the start page is public (the unopened invitation keeps it up); a guest with the Tailscale app needs no start page. Their device leaves your tailnet when the invitation ends.

The companion accepts only localhost and its explicitly configured device hostname. Browser requests must come from its own origin, the native app origin, or an explicitly configured `REACH_ALLOWED_ORIGINS` entry. If you use one computer's Reach interface to manage another, configure each target's allowlist with the exact trusted source origin, including port. No wildcard HTTPS or `.ts.net` trust is used.
This launcher is ready to use from a source checkout or the portable release folder. Install from source until 0.1.0 is on npm; there is no installer URL.

### Upgrading an existing installation

Stop the old foreground Reach before starting the new one, then run `./reach configure` and `./reach`. Configuration changes take effect on restart. If an old background service owns a TCP Serve route, run `./reach uninstall` from the checkout that installed it before `./reach install` to change to the private socket route. Uninstall ends Reach-owned terminals/jobs. Reach refuses to replace an existing route, even one left by an older version; it never resets your tailnet or other services.

### Legacy Tailscale connection

The previous two-command setup remains available on port 8443. After the launcher has prepared dependencies and the build, stop it and use `npm start` (or `node server/index.mjs`) followed by `npm run share` in another terminal. Tailscale must be installed and connected on both devices. The one-command launcher and legacy server use separate pairing stores (`.reach/quick` and `.reach`); switching requires pairing again.

### Recovering connections and background mode

Screen viewing retries interrupted connections with jittered backoff up to 30 seconds, including after network changes and returning to the phone app. Decoder failures can fall back to still-image streaming; a network interruption alone does not downgrade video. Revoked/expired credentials and disabled screen access stop retries. Desktop control reconnects the same way through a brief interruption (a dropped link, the Mac confirming the phone's identity late): the Mac keeps the control grant for 15 seconds, the phone says "Reconnecting controls…" and resumes without a new tap; pending input is discarded, never replayed. A revoked or expired credential, a takeover or pausing ends control at once. Terminals reconnect to the same live session and use heartbeats to detect silent connection loss.

The launcher keeps local terminals, chats and jobs running through transient Tailscale failures. While the private route cannot be verified, it pauses API/socket access and retries. It recreates only an unused private Serve route and never replaces another service; recovery never opens Funnel, which only an invitation or agent session window does.

On Mac, stop the foreground Reach instance when its work is finished, then install from the **same Reach folder**, using your usual folder and agent-policy options:

```sh
./reach install --folder "$HOME/Documents"
./reach status
./reach pair
```

`install` creates `~/Library/LaunchAgents/com.reach.companion.plist` with `RunAtLoad`, `KeepAlive`, and a five-second restart throttle. Reach starts after you sign in and keeps running when you close Terminal. It uses Reach's checksum-verified private Node runtime, never Homebrew's Node, and saves your install-time PATH so tools can still be found. It preserves `.reach/quick` pairings; if you use `REACH_DATA` or other Reach configuration, install with that same environment. Keep the Reach folder and its private runtime in place.

The service saves a fixed loopback health port and a stable private socket target, and uses [`tailscale serve --bg`](https://tailscale.com/docs/reference/tailscale-cli/serve). The private HTTPS address survives companion restarts and stays the same while the Tailscale device name and HTTPS port are unchanged. Reach reuses only its recorded, exactly matching route; it refuses Funnel, occupied ports, and routes owned by other services. Foreground `./reach` continues to use its temporary Serve route and stops with Ctrl+C.

`./reach status` shows whether launchd is running Reach, the private link, and the log directory. A running process may still be preparing dependencies or reconnecting; wait for **Reach is ready** in `.reach/logs/companion.log`. Errors go to `.reach/logs/companion-error.log`, and dependency/build details to `.reach/setup.log`. Logs are private to your user. First-time setup and macOS Screen Recording, Accessibility, or Automation permissions may still need local attention, especially when switching from Terminal to the background service. Test the phone connection and screen controls before leaving.

One Reach runs per computer. Starting a second one, from any folder, says where the first runs (a Terminal window, the background with no window, or the service) and offers `./reach restart` (stop it and start Reach here) or `./reach stop`. `./reach status`, `./reach stop` and `./reach restart` find Reach whichever folder it was started from. `./reach cli` adds a `reach` command to every Terminal (a link in `~/.local/bin` or another folder of yours on PATH; no sudo, no shell profile changes), so `reach status` works from anywhere.

When you run `./reach restart` in Terminal from another checkout, Reach transfers the stopped instance's verified private route ownership to that checkout and replaces the route's target, keeping the same phone URL. Other services and routes with changed handlers remain protected. Restart uses the source already in the checkout; it does not pull Git updates. Each checkout keeps its own settings and paired phones; use `./reach import <old-folder>` before the first setup in a new checkout to copy them. An installed background service restarts from its installed folder.

Phone interface updates keep the same Home Screen icon. Reach checks when opened, brought to the foreground, restored or reconnected, and every minute while visible. A new interface loads automatically once typing and live streams have finished. **Settings → General → Reach updates** shows its status and offers **Check for updates**. An already-open copy from before this mechanism needs one fresh load; close it from the app switcher and reopen the same icon. Updating the computer's server code still requires updating its checkout/package and restarting Reach.

`./reach approve` reviews pending device requests from the running background host. Select the device, then choose Approve, Deny, or Review later. Approval still requires entering the matching code from the phone. `./reach pair` prints a fresh eight-digit fallback code and QR from the running foreground or background host. It replaces the previous unused code, works once, and expires in ten minutes. Pairing codes are not printed into background service logs. Connect your phone to Tailscale before opening the QR link.

#### Keep the Mac available

```sh
./reach install --folder "$HOME/Documents"
# Or for a foreground session:
./reach
# To restrict sleep prevention to AC power:
./reach --stay-awake
```

A normal `./reach` launch and a new `./reach install` keep **both the system and display awake for the lifetime of Reach**, including on battery. This uses temporary `caffeinate -d -i -s` assertions tied to Reach’s process; it does not change system settings. A failed helper is retried within five seconds. Stopping Reach releases the assertions, including if Reach crashes. Keeping the display awake uses extra battery and leaves the desktop visible locally.

No flag or setup question is required. Older onboarding sleep preferences no longer disable this default. Explicit launch flags still take precedence: `--stay-awake` restricts prevention to AC power; `--no-stay-awake` allows normal idle sleep. Already-installed services with an explicit override in their launch arguments retain that override until reinstalled. `./reach status` reports the policy and whether the running helper is active. Changes take effect when Reach next starts.

**Locked use is not implemented yet.** Sleep prevention does not unlock a Mac: manual locking, independent screen-saver/managed lock policies, lid closure, logout and FileVault still apply. Screen capture/control can become unavailable when locked. Secure locked use is possible with an authorization plug-in, but requires a separate, opt-in native security component; keeping the display awake is not a substitute. See [locked-use implementation requirements](docs/LOCKED_USE.md). The LaunchAgent starts after user sign-in, not at the pre-login FileVault screen.

```sh
./reach uninstall
```

Uninstall stops Reach (ending Reach-owned terminals/jobs), removes the LaunchAgent, and removes **only its verified private Serve route**. Saved pairings and logs remain. If Tailscale is unavailable or the route was changed by someone else, Reach leaves that route and its ownership record untouched; resolve the conflict and retry uninstall. To change installation options, uninstall and reinstall with the new flags. The earlier `--background` and `--stop-background` commands remain aliases.

A network disconnect preserves running sessions; a **companion crash or reboot does not preserve Reach-owned terminal/job processes**. Background mode restores availability, not those processes. A powered-off/sleeping computer, Tailscale sign-out/key expiry, lost OS permissions, or a changed device name can still require local attention. Windows background supervision is not provided by this mode.

### Start at sign-in (legacy server)

After building, from the project folder:

```sh
npm run install-service
```

On macOS this installs a user LaunchAgent and starts it. Prefer `./reach install` for the full launcher and persistent private link; the legacy service does not include that setup. The two modes share a service label, so uninstall the old mode before switching. Stop any manually running copy first. Logs are in `.reach/companion.log` and `.reach/companion-error.log`. On Windows it creates a Startup entry for the current user; run `npm start` for the current session. It does not run as administrator or as a system service.

```sh
npm run uninstall-service
```

To update, stop the companion, pull the source, run `npm ci && npm run build`, and restart. Restarting ends terminal sessions and active command jobs.

## Configuration

Environment variables are read when the companion starts. `REACH_ALLOWED_ORIGINS` is an optional comma-separated list of exact trusted browser origins for cross-computer access:

| Variable          | Default                        | Purpose                                                                                                                                   |
| ----------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`            | `4317`                         | Local HTTP port. Bind address is always `127.0.0.1`.                                                                                      |
| `REACH_NAME`      | Computer hostname              | Friendly device name.                                                                                                                     |
| `REACH_ROOTS`     | Your home directory            | Shared folders, separated by `:` on Mac/Linux or `;` on Windows.                                                                          |
| `REACH_DATA`      | `.reach` in the project folder | Private pairing, hashed credentials, job records, and chat history.                                                                       |
| `REACH_ORIGIN`    | unset                          | The exact remote HTTPS origin. Legacy startup detects the device Tailscale hostname on port 8443; the launcher configures its own origin. |
| `REACH_CODEX`     | Codex CLI / bundled Mac CLI    | Path to the Codex executable.                                                                                                             |
| `REACH_TAILSCALE` | `tailscale`                    | Path to the Tailscale executable.                                                                                                         |
| `REACH_SCREEN`    | `0`                            | Set to `1` to enable screen viewing. Input still requires an explicit control session.                                                    |

Example on Mac:

```sh
REACH_NAME="My Mac" REACH_ROOTS="$HOME/Documents:$HOME/Downloads" npm start
```

PowerShell:

```powershell
$env:REACH_NAME = 'My Windows PC'
$env:REACH_ROOTS = "$HOME\Documents;$HOME\Downloads"
npm start
```

**Access model:** a paired browser receives full companion access. An agent key receives only its selected capability groups. The file browser validates real paths and blocks traversal and symlink escapes from configured roots. **Shared roots are not a shell sandbox:** terminal, command execution, app launching, and screen input have the permissions of the account running Reach. Only grant those capabilities to agents you intend to control that account. File access includes upload and folder creation, not just reads. Reach's only Funnel route is port 443, open only during invitation and agent session windows: it serves the start page's fixed files, the Face ID sign-in endpoints and the signed agent gateway, which carries an invited browser agent's API requests under that invitation's allowlist. The private API port is never on Funnel.

Credentials expire after 30 days and are stored hashed on the companion and as bearer tokens in the paired browser’s local storage. Existing credentials without an expiry expire 30 days after their creation. Pair again or issue a fresh agent key after expiry. Do not pair in a shared/untrusted browser. Use Settings to revoke clients. Revocation closes that client’s terminal sockets and rejects future requests; it does not stop work already started by the client. Agent jobs, terminals, and chats are visible only to their owner and full-access browser clients. Only full-access paired clients can answer Codex approvals. Command-capable agents still execute as the host OS user; API ownership is not OS isolation.

### Screen access

Open **Screen → View screen**. Reach chooses video quality automatically and keeps the desktop front and center. Use **Control**, **Shortcuts**, or fullscreen; keyboard and clipboard open only when needed. Additional display/touch controls and connection details live under **Screen options**.

Tap **Shortcuts** to open Codex, Chrome, Terminal, or another installed app without navigating the desktop. **New Codex session** opens a fresh desktop-app composer. The shortcut icon is also available in the workspace header. These actions require a paired owner, and use a fixed app/action allowlist.

Choose **Control** separately. Direct touch clicks the displayed point; hold and move to drag. Trackpad mode, available under Screen options, moves the cursor with one finger and scrolls with two. Pinch to zoom. Keyboard and clipboard transfers remain explicit.

On macOS, allow Screen Recording for the app running Reach or its capture helper, and Accessibility for desktop control. The native helpers compile on first use and require Apple Command Line Tools. macOS may require reopening the app after permission changes. Reach cannot grant these permissions itself. On Windows, run Reach in an unlocked desktop session; H.264 requires FFmpeg with libx264 on PATH (or `REACH_FFMPEG`). Otherwise Reach uses JPEG compatibility streaming.

One browser controls the computer at a time. Pausing, hiding, disconnecting, switching displays, or leaving releases control. Short-lived control grants, native held-button watchdogs, revocation, and access expiry provide additional cleanup. A guest invited to watch the screen can view only; one invited to watch and control can take the control lease, and the owner can always take it back. Scoped agent keys can view but not control. Browser agents never use this channel: a Full control or Apps preset acts through its own checked path (see [AI browser invitations](#ai-browser-invitations)). Screen sharing is off initially; `REACH_SCREEN=1` enables viewing only.

See [Remote desktop setup, gestures, limits, and validation](docs/REMOTE_DESKTOP.md). Frame rates are targets, not guarantees. There is no audio, lock-screen bypass, or file clipboard synchronization. Windows and physical phone behavior still require device testing.

## Agents

**Invite a command-line agent from your phone:** **Invite someone → Agent → Command line**, name it, choose a folder and what it may do (read, edit, or run commands) and for how long, then **Invite**. Give it the one command shown (it needs Node 18+). It joins your tailnet by itself, even from a machine without Tailscale (once invite links are set up), and prints the line that adds Reach to Claude Code or Codex as an MCP server. The join command downloads its client from the start page, so run it while the start page is public (the unopened invitation keeps it up). It shows in **People with access**, where you can end it. Browser agents (Muse, ChatGPT agent, Grok bots) use **Browser link** and a preset instead; see [AI browser invitations](#ai-browser-invitations). Change anyone's access there too (tap what they can do, for example **Can open files** → **Can edit files**): it applies at once, with no new link. On the agent's side: `node ~/.reach-agent/agent.mjs status | tools | call | leave`.

For the one-command launcher, use `node scripts/agent.mjs connect --name MyAgent --scopes files,exec` with `REACH_URL` set to the printed private URL, then approve on your paired phone. The local `agent-token` command below uses the legacy `.reach` store unless you set `REACH_DATA=.reach/quick`.

Create a credential **on the target computer**:

```sh
npm run agent-token -- --name MyAgent --scopes files,exec
```

The secret is printed once. Store it in your agent’s environment or secret manager, never in a committed config file. Scopes: `files`, `exec`, `terminal`, `apps`, `codex`, `screen`, `apps:drive`. Agent keys cannot administer/revoke other clients. Revoke them from the paired browser’s Settings.

```sh
export REACH_URL='https://my-computer.example.ts.net:8443'
export REACH_TOKEN='the-secret-from-the-computer'
node scripts/agent.mjs device
node scripts/agent.mjs files Documents
node scripts/agent.mjs exec 'pwd' Documents
node scripts/agent.mjs jobs
```

For an MCP-capable agent, configure a **stdio** server that runs `node /absolute/path/to/reach/scripts/mcp.mjs` with `REACH_URL` and `REACH_TOKEN` in its environment. See [the agent guide](docs/AGENTS.md) and [the HTTP API reference](docs/API.md). The MCP adapter does not automatically approve Codex actions; approvals stay with the person in Reach.

## Development and verification

```sh
npm run dev       # backend :4317, Vite :5178
npm run build     # TypeScript + production bundle
npm test          # real HTTP, file, PTY, auth, agent job, Codex-event tests
npm run format
npm run package   # stages a portable release in release/reach
```

No fake devices, shell output, or AI responses are used in the app. Unit tests simulate Codex protocol events; the live integration uses the installed Codex app-server. GitHub Actions exercises builds and tests on macOS, Linux and Windows. Unix permission-hook IPC is tested on Mac/Linux; Windows retains the agent’s local permission prompts.

See [the security review and remaining limitations](docs/SECURITY.md).

## Current limits

- Tailscale must be connected on both devices. Renaming a Tailscale device or changing the HTTPS port changes its address.
- Install from source until 0.1.0 is on npm. There is no signed desktop installer or distributed native phone app. The one-command launcher prepares Node.js automatically from a Reach folder.
- The computer must be awake and the companion running. Reach does not wake sleeping computers.
- Terminal output is capped at 256,000 characters for reconnect replay. Job output is capped at 256 KiB; 200 recent jobs are retained. Jobs allow up to eight concurrent executions and a maximum one-hour timeout.
- In Files, tap **⋯** next to a file and choose **Share** (or tap the share icon in a preview) to open the phone's share sheet. In a phone browser, files up to 20 MB are fetched as soon as you open their actions or preview, so the sheet opens on the first tap; for larger files the button changes to **Tap to share** once the file is ready. On a supported phone browser, the system share sheet offers compatible installed apps such as Messages, Messenger, and Save to Files. Use the private Tailscale HTTPS link in Safari on iPhone or Chrome on Android. Reach shares the file contents, never your pairing credentials or a download link. The original file stays on the computer. Canceling does not download or send anything automatically.
- Direct sharing is limited to 100 MB and browser-supported file types. Share is hidden for larger files and in browsers that can't share files; use **Download**, then share from Files or Downloads. The iOS app also uses the native share sheet; existing app installations need a new native build with the Share and Filesystem plugins.
- Uploads go in 8 MB chunks with progress in the transfer tray and resume after a dropped connection or when you return to the app; they never overwrite an existing file. The computer checks free space first; the default limit is 50 GB per file. In a browser, **Download** hands the file to the browser's own download manager through a link that works for 10 minutes, for that one file, only from the device that asked for it, and only while its pairing is valid. The iPhone app downloads through an iOS background session: it keeps going when you switch apps or lock the phone (as long as Tailscale stays connected) and offers **Save** when done; swiping Reach away in the app switcher stops it, as iOS does for every app. This needs a new build of the iPhone app. Uploads from the phone pause while Reach is in the background and continue where they stopped when you return (if iOS reloaded Reach in the meantime, start the upload again). Reach doesn't publish links anywhere and never puts one in a share sheet.
- Remote desktop uses encoded video over an authenticated WebSocket, with JPEG fallback. It does not yet include audio, WebRTC transport, or unattended lock-screen access.
- Chat lists the Codex threads, Claude Code sessions, Gemini CLI (read only) and OpenClaw that Reach detects on the computer. Sending depends on each agent's adapter; see [agent compatibility](docs/AGENT_COMPATIBILITY.md). Reach does not take over arbitrary programs running in a Terminal.
- Windows and physical-phone behavior require real-device validation; responsive layout alone does not establish device compatibility.

### Let someone in briefly

Tap **Invite someone** on Home (also in **More → Invite someone**), choose the computers, what they may use and for how long, then **Copy invite**. With invite keys set up, the guest just opens the one-use link in a browser while the start page is public (the unopened invitation keeps it up); otherwise they open it from a device that already reaches your computer through Tailscale. They see a countdown and are disconnected from Reach when it ends, even if they reload or reconnect. Change or end their access earlier from **People with access**.

Guests get exactly what you picked: folders (read, or read and write), the screen (watch, or watch and control), chosen apps' windows, their own terminals, AI sessions, or full access (everything you can do except manage access). Expiry does not recall downloaded files; it ends their Reach access, and an invite-key device leaves your tailnet.

## Multiple computers and live connections

Every paired computer has an equal workspace. The computer strip stays available across pages; switching remembers each computer's page, selected terminal/conversation, and file location during the current app visit. Only the foreground computer receives screen input. Switching away closes its video/input channels and releases control; server-side terminals and jobs keep running. Returning to Screen reconnects video; explicitly enable control again. Split-screen control is not included.

Home keeps a large computer illustration when only one computer is connected, with dotted branches to real phones/tablets rather than Files or Codex. Multiple connected computers use the fleet map. Live counts include phones connected to more than one computer. Larger fleets have a searchable list. Counts come from authenticated Reach presence sockets, not saved credentials or Tailscale's online list. Tabs and credentials bound to the same Tailscale node count as one device. Legacy clients without a node binding are grouped per credential on each host, so they cannot be reliably deduplicated across hosts. Regular devices have a **Paired device** badge; temporary guests have an amber **Invited** badge with remaining time, and agents have their own label. These labels come from server-side grants, not client claims. The same device can have different access on each computer. Other devices' activity is labelled per computer; restricted clients can only see their own presence.

Presence reconnects independently for each computer, starting after one second and backing off to ten seconds; coming online triggers a retry. Broken sockets are detected with heartbeat checks within about twenty seconds. Expired/revoked credentials cannot reconnect. Quiet connections send only heartbeat traffic; full presence snapshots are sent when state changes. Update and restart each companion to enable this feature; older hosts may still serve Files/Screen while showing no live presence connection.

For a fleet in Safari/Chrome, use one Reach URL as your workspace and explicitly allow that exact browser origin on each other companion, for example `REACH_ALLOWED_ORIGINS="https://home-mac.example.ts.net:8443" ./reach`. Use your actual private Reach URL, including its port. This permits that Reach page to make authenticated requests; it does not grant credentials, bypass local approval, or expose a public route. The native Reach app uses its existing approved Capacitor origin. Arbitrary websites and other tailnet origins remain blocked by default.

## Contributing and release status

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [release status](docs/OPEN_SOURCE_READINESS.md). The [release procedure](docs/RELEASE.md) covers reproducible packaging; [physical-device acceptance](docs/RELEASE_TESTING.md) covers the checks automation cannot prove. The October 7 audit includes a real file-finding task and an owner-approved Full control run that completed 11 synthetic Safari checks through native input. Display of an owner-prepared synthetic Mail message and normal idle-expiry UI were also observed. Home-root, command-guard, pointer-identity and helper-diagnostic repairs have focused regression coverage. Live results remain partial: separate Apps/multi-agent grants, interruption during active input, those follow-up repairs, broader Mail navigation, physical phones and named external agents still need the recorded checks in the [agent acceptance matrix](docs/AGENT_ACCESS_ACCEPTANCE.md) and release gates.
