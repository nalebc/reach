# Changelog

All notable changes to Reach are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Reach uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The release workflow
publishes the section whose heading carries the tagged version as the GitHub
release notes, so date the heading before tagging.

## [Unreleased]

### Added

- 2026-10-13: Windows keeps Reach running and reachable as a Mac does.
  `.\reach.cmd setup background` (or `install`) adds a task of yours that
  starts Reach when you sign in, in your session, with no window: the live
  screen and control work while you're signed in, new phones are approved
  with `approve`, and it starts again after a crash. While Reach runs, the PC
  stays awake in the Mac's three modes, and `status` says so. The old
  `npm run install-service` Startup entry, which started a Reach no phone
  could reach, is removed. Built, not yet run on a physical Windows PC.
- 2026-10-13: One Reach per Windows PC, as on a Mac. Reach reads the PC's
  process list, so a second one from any folder is refused with where the
  first runs; `status` shows whichever Reach runs with its routes and sleep
  prevention; `stop` asks first and stops every Reach; an agent's `restart`
  asks on your phone; restarts and phone updates open Reach in a window of
  its own titled Reach; `update` stops Reach before replacing its files. A
  first run sets up while it installs, as on a Mac. Built, not yet run on a
  physical Windows PC.

### Changed

- 2026-10-13: Windows PCs sign phones in from the browser as Macs do, with
  nothing to turn on. `REACH_WINDOWS_ACCOUNT` is gone. Setup asks for your
  Tailscale account, as on a Mac, and a PC paired by code before asks once at
  its next start. Invite links for people and agents, the start page, the
  agent gateway, hosted MCP, Face ID sign-in for a new browser and linked
  computers (a Mac and a PC, or two PCs) come with it. A PC that can't hold
  the route yet uses a pairing code and says why in its terminal,
  `.\reach.cmd status`, `approve`, `link` and on the phone. That covers
  Tailscale older than 1.104 or without its network adapter, Reach's folders
  not private, or Tailscale's own connections not recognised. In the last
  case Reach starts again on pairing codes at once, and tries the route again
  a day later or after Tailscale changes. An older Tailscale no longer stops
  setup: the account is kept and used once Tailscale is updated. Not yet run
  on a physical Windows PC.

## [0.2.0] — 2026-10-13

Faster agents, an owner-first screen with gestures you can feel, modern
sheets, one-tap updates for what Reach drives, and fixes across Face ID,
Windows and chats.

### Added

- 2026-10-13: Reach keeps what it drives in sync. When Codex's service runs
  behind the Codex CLI (0.158 against 0.162, so GPT-6.1 Sol stayed greyed
  out), Needs you, Settings → Updates and Codex's model list say "Update
  Codex's service to use … and newer models" with Update. One tap runs
  `codex app-server daemon update` with the Codex Reach uses, after saying
  which working Codex chats it may stop, then reconnects and reads the
  models again. Claude Code, Codex and OpenClaw updates show in the same
  list, once per version pair. Nothing updates without the owner's tap.
- 2026-10-13: Fork a chat from any message into another app ("Fork chat…" in
  a chat's menu, or from an earlier message). Claude forks natively, keeping
  compaction, thinking and complete tool records; Codex forks through the
  chosen completed turn; OpenClaw takes long tool output split, never
  clipped. Later messages stay out, and the source chat is never rewritten.
- 2026-10-13: The owner comes first on the screen. Input through Reach's screen from the
  owner (or a full-access person) holds every agent off it, its looks
  included (screenshots, describe, read, its live picture), with kind
  `paused`, who is using it and `retryInMs`; agents get it back 2 minutes
  after the last input through Reach, or at once from "Let them back" on the
  quiet "Agents wait · 2 min after you stop" pill. Chats' Claude app messages
  never wait on it. The agent's live picture shows a calm "The owner is using
  the Mac".
- 2026-10-13: Two fingers scroll the computer, up, down and sideways, in every touch mode
  (pinch still zooms), and the bar has a desktop switcher while controlling:
  previous desktop, all windows, next desktop.

### Changed

- 2026-10-13: An invitation nobody ever joined clears itself a day after its
  chance to join ended: an unopened link a day after its join window (a
  person's, a day after their access ran out), an agent's request a day after
  it was declined or ran out. It goes the way removing it does, and the
  security record says "Unopened invitation for <name> cleared". Within the
  day, a new link starts a new window. Anything that joined, or that you
  approved, is never cleared this way. Same on Mac and Windows.
- 2026-10-12: Dependencies: Vite 8, xterm 6 (addon-fit 0.11), esbuild 0.28,
  jsdom 30, lucide-react 1.53, TypeScript 7 and the current GitHub Actions.
  A source checkout now builds on Node 22.12 or newer; `./reach` and
  `reach.cmd` fetch Reach's own Node below that. npm installs still run on any
  Node 22.

- 2026-10-13: OpenClaw's heartbeat: a skipped run is a quiet note in Reach's
  words ("Nothing to check: the heartbeat's task list is empty."), schedules
  OpenClaw owns say to change them in OpenClaw, and the heartbeat turns off
  and on from Reach when one setting (agents.defaults.heartbeat) decides it.

- 2026-10-13: Keys in the screen's menu are a grid of icon tiles, four across
  on a phone, instead of a row of pills that scrolled sideways. Each tile shows
  an icon and a word or two. The exact shortcut is the tile's name and tooltip.
  Eight everyday keys come first: previous and next tab, new tab, close tab,
  switch app, find, undo and Escape. **More** opens the rest in place. The
  "Other keys" list and its **Send key** button are gone. In their place,
  modifier chips (⌘ ⌥ ⌃ ⇧ on a Mac, Win Ctrl Alt Shift on Windows) are held
  with the next key tapped. That one tap sends the combination, and the chips
  then let go. Function keys, letters and digits are one more tap away. The
  commands for the app in front are tiles too, and Keys doesn't repeat one
  they already offer.

- 2026-10-12: Agents on the Mac take one turn per step. Every tool that acts
  (reach_act, press, fill, and opening an app, page, bank, file or window)
  answers with the screen as text once it has settled (about a second after
  an action, up to three after an open), so an agent doesn't look again;
  `describe: false` skips it. After the first look that text is only what
  changed (`+`, `~`, `-` lines; every control not listed keeps its number),
  or all of it with `full: true`; what that spares is counted in the savings
  ledger as `screen-diff`. Each agent's calls are timed, with no content: its
  Activity shows one quiet line per stretch of work, "Reach 0.4 s · agent
  28 s".

- 2026-10-12: An agent too old for Reach is skipped, not offered: Claude Code
  older than 2.1.259, Codex older than 0.148.0, and now OpenClaw older than
  2026.2.26 (its Gateway refuses the v3 device signature Reach joins with).
  New chat, moving a chat, relays, auto-continue and workflows leave it out.
  Where it would be, one line names the version to update to ("Update Claude
  Code to 2.1.259 or newer to use it here."), with **Update** when Reach can
  run that update: the one it already offers for a newer version, or
  OpenClaw's own. Its chats still list and open (a Codex's while its
  session service still starts). A message sent to one is
  refused with the same words, not "Update Reach". A Gateway found too old
  is tried again once a minute, or at once after an update or restart from
  Reach, not on every look.

### Fixed

- 2026-10-13: Swiping back in a chat on the phone could show a blank page and reload Reach instead of going back to the chat list. The entry behind the chat belonged to the page from before a reload, such as an interface rebuild or the phone reloading Reach. Back is now one step of Reach's own stack, in the same page, in every browser. A chat goes back to its list, a page opened from More, Settings or a card goes back to where it was opened, and any tab goes back to Home. Switching tabs adds no step. A chat opened from a notification or link, or reopened after a reload, has its list under it. A rebuild reload first steps back to Home's entry, so no entry of the old page is left behind. A sideways swipe inside the page no longer turns into the browser's back or forward.
- 2026-10-13: Adding Face ID in Settings never worked. The page asked for a new challenge while Face ID was still up, so every answer was refused "for an earlier attempt". After ten tries the button stopped responding, with no message. Turning off "Face ID confirms approvals" failed the same way, and showed "Access expired or was revoked." Now every tap either opens Face ID or says why it can't. Each passkey you add shows a green check with "Added today". The setting uses your device's own name for it: Face ID, Touch ID, fingerprint or face unlock on Android, or Windows Hello. Reach's terminal shows "Reach: Face ID not added: <reason>" for each refused add.
- 2026-10-13: Fullscreen Screen covered the Mac's menu bar and Dock with Reach's own bars.
  They now take the room the picture leaves (a rail at the side on a phone
  turned sideways, rows above and below when upright), and hiding them never
  moves the picture.
- 2026-10-13: Taps that did nothing: every tap now reaches the computer or says why in
  one line, a tap made while control's connection blinks goes once it is back
  (within a second, never later), and click feedback is a small wave in Reach
  green, shown only for a click the computer did (none while only watching).
- 2026-10-13: The live screen on a phone hitched every 10–25 s at full size: the iPhone's
  video decoder kept failing on a 2868×1862 stream (and once at 2150×1396).
  The cause isn't established; as a mitigation, not yet checked on the
  iPhone, phones start at 1920 across, a step down keeps the last picture
  crisp, and the smaller size is remembered for the session. On Windows, a
  sideways scroll now goes the same way as on a Mac.

## [0.1.1] — 2026-10-12

The first release on npm: 0.1.0's publish step failed, so 0.1.0 is a source
tag only.

### Changed

- When the tailnet has HTTPS off, setup opens Tailscale's own page for this
  computer, where one press of **Enable** turns it on, instead of the DNS
  settings page.
- An agent whose Claude Code is older than 2.1.259, or whose Codex is older
  than 0.148.0, is named as too old, with the version to update to, instead of
  failing later. Older versions lack the permission and thread APIs Reach uses;
  each floor was found by running the releases one by one.

### Fixed

- A message typed on the phone while Claude Code 2.1.296 or newer was working
  vanished from the chat although Claude received it. Claude Code now records
  it as a queued prompt without the old marker; Reach shows it again.
- Release workflow: `npm publish` was given `candidate/<file>.tgz`, which npm
  reads as a GitHub repository, not a file. It publishes `./candidate/…` now,
  and a CI policy test refuses a bare path.
- CI: the published-CLI compatibility check tries twice, waits longer and
  quotes the CLI when it fails; the iOS simulator launch gets a third try;
  test fixtures no longer look like Tailscale keys to secret scanners.

## [0.1.0] — 2026-10-12

First public release candidate. Early access: see `docs/RELEASE.md` for the
real-device checks that are still open.

### Added

- Face ID confirms agent approvals, a switch in Settings → Agents for the
  owner's own devices once Face ID is set up on the computer. With it on,
  approving an agent's first connection on the phone asks for Face ID, and the
  computer refuses an approval that doesn't carry its answer; the answer is
  made for that one request, from that one phone, and used once. Denying
  never asks. Turning the switch off takes Face ID too, and the last passkey
  stays while it's on, so a phone in the wrong hands can't lift it with a
  tap. Guests, agents and Face ID-joined browsers can neither use it nor see
  the setting.
- Agent access presets. Inviting a browser agent (Muse, ChatGPT agent, Grok
  bots) is one choice among four presets, Full control, Apps, Files and Read
  only, instead of seven switches and per-action approvals. Scopes, routes,
  tools and the rules sent to the native checker all derive from the preset on
  every request (`server/agent-presets.mjs`); a stored credential cannot grow.
- Always access for a browser agent, next to the 15-minute to 24-hour
  durations: the agent keeps its access until the owner stops it and comes back
  from the same browser with no new invitation. The link still works once, so
  sharing it gives nobody else access. The public link stays up while an agent
  has Always access.
- Reopen link, in Settings → Agents: an agent that changed browsers opens its
  same link again (for 15 minutes, with the owner's code approval) instead of
  getting a new invitation; the browser it used is disconnected.
- One always-protected list that no preset changes: Reach and Tailscale,
  password stores and password fields, security prompts and `sudo`, privacy
  settings, Activity Monitor and Force Quit, developer tools, and a shell deny
  list (disk tools, shutdown, `csrutil`, `tccutil`, `launchctl`, `security`,
  scripted keystrokes, recursive deletes of home or system folders, Reach's own
  addresses, paths to secret files) (`server/agent-guard.mjs`).
- A native per-event checker (`scripts/native/agent-desktop.swift`, one helper
  per session) inspects the real target of every click, key and typed text
  before posting it, pauses while the owner uses the Mac, and leaves protected
  windows out of screenshots.
- Full control adds a shell that runs as the owner from inside a shared folder,
  with a 60 s and 256 KiB limit per command, a log, and the deny list
  (`server/agent-shell.mjs`). Files with editing writes through the sandboxed
  file helper.
- One Mac lease: one agent acts at a time; another agent's action is answered
  `409 busy` with a retry hint. Settings → Agents shows what each agent is
  using and lets the owner pause or stop it; the owner's own input pauses it.
- Preset invitations may last 24 hours over the public link when the server
  allows it (joining stays a 15-minute window; invitations from the earlier
  form keep their one-hour cap).
- The agent screen states why a screenshot was refused or failed and keeps
  refreshing, more slowly, in a hidden tab.
- A Claude Code session started from the phone is named from its first
  message the way the Claude app names its own: Claude Code proposes a title
  and it is written into the transcript, so the app lists the session by name
  instead of "General coding session". Without a proposal, the message's first
  line is the name.
- Release workflow (`.github/workflows/release.yml`): a `v<version>` tag builds,
  tests, packages and verifies once, publishes the verified tarball to npm with
  provenance, and creates the GitHub release with SHA-256 checksums and these
  notes. The tag must equal `v` plus the `package.json` version.
- Repository hygiene: `CODE_OF_CONDUCT.md`, Dependabot for npm, GitHub Actions
  and the Go module, `CODEOWNERS`, issue templates (blank issues off, security
  reports routed to `SECURITY.md`), `.nvmrc`.

### Changed

- Routes are Tailscale daemon state, in every mode on Mac and Linux (on
  Windows the private route lasts only while Reach runs). The private Serve route
  (port 8443) and the on-demand Funnel route (port 443) are background routes:
  a dropped command-line session, a sleep or a Reach restart no longer
  interrupts phones or agents, and an unchanged route is reused without a gap.
  A janitor process (`scripts/funnel-lease-worker.mjs`) holding a five-second
  lease switches the public route off if Reach dies; the private route stays
  while Reach is stopped and `./reach uninstall` removes it. Reach replaces its
  own recorded route when its target changed and never anybody else's. On a
  Mac with the Tailscale app, Reach uses the app's own command line (the one
  that matches the running daemon) and warns once when the command line and
  the daemon differ in version. `./reach status` shows both routes, and
  `tailscale.log` lines carry their time.
- The signed Funnel gateway (one endpoint, P-256 signed POST requests, nonce
  and clock-window replay protection) answers only while an invitation window
  is open; at other times public Funnel requests are refused. Preset agents'
  screen, input, shell and file routes pass through it; each invitation's own
  allowlist still decides.
- Invitations made with the earlier form keep working until they end.
- Notifications say the event and its context. Titles read "chat or agent ·
  event" (Reply needed, Approval needed, Finished, Access request, Connection
  request, Your turn); bodies carry the request itself ("Run npm test in
  project?", "Change 3 files: …?", the question asked), with commands kept
  verbatim and a marker for a multi-line one; the action button says what it
  opens (Reply, Review access, Open live screen, Review restart). Questions
  with a private or several answers get a safe summary, a browser agent's app
  request links to the Home page, the test notification explains what the
  device will receive, and the restart card shows who asked next to "Computer
  restart".
- CI: GitHub Actions pinned to commit SHAs, superseded runs cancelled,
  `npm audit` moved to a separate advisory job, the verified `.tgz` uploaded
  with the portable folder.

### Fixed

- Screen sharing with a browser agent dropped for seconds at a time. The
  foreground `tailscale serve` and `tailscale funnel` processes that carried
  the routes kept exiting (124 and 65 relaunches in one day's log, through a
  Homebrew command line one version apart from the daemon), and a single failed
  status read marked the private link unavailable. Routes are daemon state now,
  the private link needs two failed reads in a row before it is called
  interrupted, and the agent page retries one failed read.
- Stale browser sign-in builds no longer ship: `scripts/build-tailnet.mjs`
  removes `tailnet/dist` outputs the manifest does not list, and
  `npm run verify:package` fails if the tarball carries unlisted files or
  exceeds 30 MB (it prints the size).
- `esbuild` is declared as a devDependency; `scripts/build-agent.mjs` imports
  it directly.
- Third-party notices point to the shipped `server/openclaw-LICENSE.txt`.
- Windows CI: the protected-app tests use a Windows-shaped app path, the real
  terminal test waits for a slow ConPTY shell, and the notification and agent
  ask tests no longer depend on tight wall-clock sleeps.
