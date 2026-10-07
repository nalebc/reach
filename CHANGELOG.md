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
- Release workflow (`.github/workflows/release.yml`): a `v<version>` tag builds,
  tests, packages and verifies once, publishes the verified tarball to npm with
  provenance, and creates the GitHub release with SHA-256 checksums and these
  notes. The tag must equal `v` plus the `package.json` version.
- Repository hygiene: `CODE_OF_CONDUCT.md`, Dependabot for npm, GitHub Actions
  and the Go module, `CODEOWNERS`, issue templates (blank issues off, security
  reports routed to `SECURITY.md`), `.nvmrc`.

### Changed

- The signed Funnel gateway (one endpoint, P-256 signed POST requests, nonce
  and clock-window replay protection) answers only while an invitation window
  is open; at other times public Funnel requests are refused. Preset agents'
  screen, input, shell and file routes pass through it; each invitation's own
  allowlist still decides.
- Invitations made with the earlier form keep working until they end.
- CI: GitHub Actions pinned to commit SHAs, superseded runs cancelled,
  `npm audit` moved to a separate advisory job, the verified `.tgz` uploaded
  with the portable folder.

### Fixed

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
