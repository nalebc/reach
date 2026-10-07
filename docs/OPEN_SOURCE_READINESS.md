# Release status — 2026-10-06

Reach 0.1.0 is an early-access release. This page says what has been checked, what has not, and how to describe it. The repository is public. Install from source until 0.1.0 is on npm (`@nalebc/reach`).

## Supported platforms

- **macOS host with an iPhone or Android phone in the browser:** the supported path.
- **Windows host:** experimental. The Windows CI job is not green and no device test is recorded.
- **Linux host:** files and terminals only; no desktop.
- **Native iOS app:** optional developer build, unsigned.

## Verified

- **CI matrix.** `.github/workflows/ci.yml` builds and tests on macOS, Linux and Windows with Node 22, builds the browser Tailscale client, stages the release and smoke-tests its CLI, runs `govulncheck`, and compiles the iOS plugins in an unsigned simulator build. `agent-compatibility.yml` checks the published Claude Code and Codex CLIs without accounts or model calls. The Windows job is not green; read the runs on the exact release commit, not this page.
- **Tests.** 1,741 pass locally on macOS with Node 22, including the preset suites (`test/agent-presets.test.mjs`, `test/agent-guard.test.mjs`, `test/agent-desktop.test.mjs`, `test/agent-shell.test.mjs`, `test/agent-preset-invitations.test.mjs`, `test/agent-preset-desktop-routes.test.mjs`, `test/agent-desktop-policy-native.test.mjs`).
- **Privacy check.** `node scripts/check-release.mjs` passes on the current tree when `REACH_PRIVATE_IDENTIFIERS` (or `.reach/private-identifiers`) lists the owner's identifiers; without such a list it scans only known credential formats and says so. Git history was rewritten before publication so that every commit carries the project identity. The scanner is a guardrail, not a complete secret audit: large and binary files and other secret formats need human review.
- **Dependencies.** `npm audit` reports zero known vulnerabilities for the lockfile (also with `--omit=dev`, 2026-10-06). `govulncheck` on the browser `js/wasm` target finds no reachable affected symbols; the module-level advisory GO-2026-5932 (`golang.org/x/crypto/openpgp`) is not in the dependency graph. These are separate results, not one certification.
- **Artifact.** `npm run verify:package` installs the packed artifact with production dependencies and passes CLI, served interface, authenticated file access and access-denial checks.
- **Muse.** A Full control session with Muse saw the Mac's screen on 2026-10-06. Clicks and typing are not yet recorded.
- **OpenClaw.** Conversations owned by external channels are read-only in Reach; Reach sends only into its own conversations.

## Pending

| Gate | Status |
| --- | --- |
| Device gates | [RELEASE_TESTING.md](RELEASE_TESTING.md) on a real iPhone (Safari, Home Screen app) and an Android phone (Chrome): onboarding, Face ID, notifications, keyboard and scrolling, background and reconnect, files, grants, revocation. Not recorded for this candidate. |
| Windows host | CI not green, no device test. Experimental until both are done. |
| Muse clicks and typing | Record a Full control session in which a click and typed text land in the intended app, a `busy` and a `paused` refusal, the owner-presence pause, and Stop from Settings → Agents. No Grok session is recorded. |
| Security review | Independent review of the on-demand Funnel window, the signed agent gateway (`server/funnel-agent.mjs`), the preset derivation and native per-event checks, the shell deny list and the custom passkey verifier. Use disposable folders and accounts. |
| Repository controls | Private vulnerability reporting and main-branch checks on, now that the repository is public. |
| Public assets | The demo recording predates the preset invitation and shows the older interface; review before reusing it in an announcement. |
| Release artifact | Build and qualify one exact tarball; publish its checksum, platform matrix, known limitations and upgrade/recovery instructions with 0.1.0. |

## How to describe it

- A browser agent (Muse, ChatGPT agent, a Grok bot) is invited with one preset: **Full control**, **Apps**, **Files** or **Read only**. There are no per-action approvals.
- Full control is full control except passwords and Reach. Say that. Do not write "owner approval for sensitive actions", "full access, fully controlled", or "sandbox" for Full control: the deny list stops obvious harm, the shell runs as the owner, and anything running or signed in is open to the agent.
- What stays protected in every preset, never configurable: Reach and Tailscale, password stores and browser password or payment pages, password fields, security prompts and `sudo`, System Settings' privacy panes, Activity Monitor and Force Quit, developer tools, a shell deny list. The owner can hide more apps.
- One agent acts on the Mac at a time; the owner can Pause or Stop it from Settings → Agents; the owner's own hands pause it. Full control and Apps bind the phone that created the invitation.
- Transport: the agent's browser connects through Tailscale Funnel on port 443 to a signed gateway with a fixed path allowlist and the invitation's allowlist behind it; TLS terminates on the Mac. The start page and gateway are public only while an invitation or an agent session is live. A guest without the Tailscale app, Face ID for a new browser and the command-line agent's join command work only in that window; owners with the Tailscale app on their phone are unaffected.
- Muse: say only that a Full control session saw the Mac's screen on 2026-10-06 and that clicks and typing are not yet recorded. Nothing about Grok.
- Command-line agents (Claude Code, Codex) still use read, edit or run roles via Invite someone → Agent → Command line.

See [RELEASE.md](RELEASE.md) for packaging, [BROWSER_AGENT_TOOLS.md](BROWSER_AGENT_TOOLS.md) for the agent contract and [SECURITY.md](SECURITY.md) for the security model and historical findings.
