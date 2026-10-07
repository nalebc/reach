# Changelog

All notable changes to Reach are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Reach uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The release workflow
publishes the section whose heading carries the tagged version as the GitHub
release notes, so date the heading before tagging.

## [0.1.0] — unreleased

First public release candidate. Early access: see `docs/RELEASE.md` for the
real-device checks that are still open.

### Added

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

- Routes are Tailscale daemon state, in every mode. The private Serve route
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
