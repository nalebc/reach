# Open-source readiness — 2026-10-06

Reach is an early-access release candidate. A stable source revision is not the same as a qualified public release. The repository remains private; this work does not publish an npm package, create a public release, or post an announcement.

## Reconciliation

The candidate starts from GitHub main and preserves the newer live-checkout work: simplified invitations and editable grants, browser-agent admission, bounded terminal reads, approved file changes and macOS scripts, session approvals, screen batches, mobile chat/queues/approval cards, direct notification routing, OpenClaw restrictions, the selected pixel logo, and the single-instance launcher.

The saved agent-integration audit was merged against its original baselines, rather than copying an older checkout over newer work. Restored guards cover malformed agent messages, uncertain delivery, stale turn completion, one-shot approvals and durable outbox recovery. The latest folder picker, permission-mode menu, message copying, notification panel and installation-failure tests were included. Three permission-handoff state tests were recovered from the other workspace. Superseded agent-coin UI remains removed. Historical branches and local work artifacts are retained; scratch previews, private state and test logs are excluded from the release.

OpenClaw conversations owned by external channels remain read-only. Reach sends only into its own conversations. Earlier audit text describing external delivery is historical, not a feature promise.

## Checks and repairs

- Production build and TypeScript check pass locally.
- The final local Node 22 run passed 1,425 tests with zero failures and six optional/platform skips. Three subsequently recovered permission-handoff tests also pass. The opt-in native macOS script tests pass, including outside-file, symlink/hardlink, network/helper, environment, revocation and exact-approval checks. CI validates the complete combined suite.
- A clean 298-file npm artifact install with production dependencies passes CLI, UI, authenticated file access and access-denial checks.
- Browser WebAssembly assets are required, checked for source freshness and integrity, and packaged with the application. Portable packaging now includes the agent HTML entry point.
- npm audit reports zero known vulnerabilities for the installed lockfile. This does not cover unknown issues or constitute a security certification.
- Go vulnerability scanning for the browser `js/wasm` target found no affected imported packages or reachable symbols. The module-level advisory GO-2026-5932 concerns `golang.org/x/crypto/openpgp`, which is absent from the dependency graph; there is no patched version for that unmaintained package. CI now repeats this scan.
- Current-tree privacy checks pass. A pattern scan of 1,533 reachable historical blobs (text scanned) found no matches for private keys, AWS/GitHub credentials or Tailscale credentials. Large/binary blobs and arbitrary secret formats need human review.
- Installed Codex 0.160.0 passes seven generated-schema contracts; installed Claude Code 2.1.291 passes an isolated initialization handshake. Neither test sends a model turn. These are protocol checks, not signed-in or physical-phone qualification.
- Existing CI failures revealed POSIX-only fixtures being run as Windows executables, Unix-socket tests on an unsupported Windows ingress, path-separator assumptions, mode-bit assertions on Windows, and a real Windows absolute-folder validation bug. Tests now distinguish platform prerequisites while retaining cross-platform authentication/scope coverage; Codex accepts native absolute paths.
- Contribution guidance, private-reporting instructions, issue/PR templates and bundled-dependency license notices are included. Go/browser and JavaScript notice collection is part of the release build.

## Before a public announcement

| Gate | Status / next action |
| --- | --- |
| Exact-commit CI | Run the macOS/Linux/Windows verification matrix, iOS simulator build and published-agent compatibility workflow on the candidate. Resolve failures before promoting main. |
| Muse and Grok bot | User testing pending. Record provider/app version, host, browser, Reach commit, admission, allowed operations, denied operations, expiry, revocation and a fresh invitation with no inherited approvals. |
| Physical phones | Complete [RELEASE_TESTING.md](RELEASE_TESTING.md) on iPhone Home Screen and Android Chrome: onboarding/passkey, notifications and direct links, keyboard/scroll, background/reconnect, files, grants and revocation. |
| Host support | Test a physical Windows host; CI does not establish desktop or ACL behavior. Browser-agent Unix ingress and approved scripts have narrower host support than basic owner access. Keep that explicit. |
| Security review | Independently review public Funnel admission, the custom passkey verifier, script sandbox boundaries, scope changes and replay/cancellation. Use disposable folders/accounts. Screen control and unrestricted CLI/PTY access can act as the signed-in user. Sharing executable startup files or the Reach installation itself carries additional risk. |
| Repository controls | Enable private vulnerability reporting and main-branch checks before/when making the repository public. GitHub currently returns 404 for reporting status and 403 for branch protection on this private plan. Configure these when the plan/visibility permits them. |
| Public assets | Review the full demo video/GIF and all screenshots for private information; the inspected poster uses sample data. Refresh the older demo labels and logo before using it in the announcement. Review third-party brand usage and generated notices. |
| Release artifact | Build and qualify one exact artifact; publish its checksum, known limitations, platform matrix and upgrade/recovery instructions. No version tag or public release has been created by this audit. |

## Announcement language

Safe description of the implemented model: “Invite a browser-based AI assistant to your computer with selected permissions, owner approval for sensitive actions, and access you can revoke.”

Add “tested with Muse and Grok” only after those tests pass and are recorded. Avoid “full access, fully controlled”: file-scoped commands, sandboxed scripts, supervised desktop input and unrestricted owner/CLI execution provide different boundaries. An approval is consent to an action, not a guarantee about its consequences.

See [RELEASE.md](RELEASE.md) for packaging, [BROWSER_AGENT_TOOLS.md](BROWSER_AGENT_TOOLS.md) for the current agent contract and [SECURITY.md](SECURITY.md) for the security model and historical findings.
