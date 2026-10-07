# Release status — October 7, 2026

Reach 0.1.0 remains an early-access candidate. The repository is currently **private**. Do not describe this audit as complete end-to-end qualification or an independent penetration-test certification. The [October 7 audit](AUDIT_2026-10-07.md) records the fixes, tests, live evidence, limitations and preservation of local work.

## Verified on this candidate

- Node 22.23.3 on macOS ARM64: **1,892 passed, 0 failed, 7 skipped** out of 1,899 tests, with native policy/file-boundary/script-sandbox flags enabled.
- TypeScript, production UI/agent build, Go browser networking build and dependency notices passed.
- A clean production-only install of the packed artifact passed CLI, served UI, authenticated file access and access-denial checks. The final reconciled build was qualified; requalify after any subsequent source edit.
- A real browser agent opened a disposable files invitation, waited for owner approval, read the task and target file, found the requested answer, and left successfully. CLI/MCP tests used actual local HTTP and stdio subprocesses; concurrent-agent security tests passed.
- Real Codex prompt/reply, model/effort observation through a second adapter, read-only permission update and approval cancellation passed in isolated chats. Installed Codex and Claude protocol canaries passed. A real Claude desktop prompt/reply and native model change were read by Reach's adapter.
- Today's terminal stop controls, scrollback, launcher mascot, PDF preview, Markdown formatted/source views, file selection, sharing, Send to agent and Unzip are integrated and preserved in source history. A scrollback cache bug and blank native PDF viewer found during integration were fixed.
- Confirmed authorization, revocation, upload-concurrency, desktop-policy race, screenshot-filter, MCP dispatch, chat-sync, archive extraction, sharing and agent-UI defects were repaired with regressions. Windows path/installer defects and test-fixture cleanup were also corrected; actual Windows CI and host qualification remain separate checks.
- The README has a new roughly 25-second MP4 / 24-second GIF interface tour, including current agent presets. It uses actual browser captures and synthetic data, clearly labeled.
- Dependabot vulnerability alerts are enabled. The candidate install's npm audit reported zero known vulnerabilities. The preceding main commit's Go security and unsigned iOS CI jobs passed; final-commit results are required.

## Release gates

| Gate | Current status / next action |
| --- | --- |
| Concurrent feature work | Connector management and additional file-viewer work began in another working copy after this candidate was tested. Those ongoing edits are preserved separately; they are not qualified or activated by this audit. Finish, review and test them before including them in a release. |
| Repository-wide history privacy | The owner-authorized publication history preserves source and attributes Reach commits to the verified owner. Private backups retain the original history. **Visibility remains blocked:** other remote branches/PR refs and Actions logs/artifacts may retain old personal metadata. Review those hosted copies separately, or publish the verified history to a fresh empty repository while retaining this repository privately. |
| Full desktop control | **Unverified live:** native field detection failed because the audit process lacks Accessibility permission. Run the real capture, click, text, keys, scroll, owner-takeover, pause/revoke and video checks from a permissioned host process. Native policy compilation and simulated input are not substitutes. |
| Claude end-to-end | **Partly verified:** native desktop prompt/reply and model → Reach observation passed. The separate CLI is signed out, and Reach's native write helper lacks Accessibility permission. Model selection is now implemented with exact-chat/menu acknowledgement tests; run real Reach → Claude settings/approval/queue/move/restart checks from a permissioned host before claiming universal sync. |
| Bidirectional app synchronization | Real Codex transport checks and fixture coverage pass; actual desktop GUI ↔ Reach observation for every control and provider is still needed. |
| Physical phones | Follow [RELEASE_TESTING.md](RELEASE_TESTING.md) on real iPhone Safari/Home Screen and Android Chrome: pairing, passkeys, notifications, keyboard, scrolling, network transitions, file sharing and revocation. No candidate device acceptance is recorded. |
| Named external agents | The local browser task passed. Muse/Grok/other remote VM browsers, real Funnel/Tailscale admission and public-window closure need their own recorded results. Do not infer them from local browser success. |
| Platforms | macOS is the primary target. Require final macOS/Linux/Windows CI; Windows remains experimental until a physical-host run also passes. Native iOS remains an unsigned developer build. |
| Repository controls | Secret scanning/push protection was unavailable for this private repository (GitHub 422); branch-protection access was plan-restricted (403). Configure available protection, Code scanning and private vulnerability reporting before public release, without treating Dependabot updates as those controls. |
| Exact release artifact | Rebuild after the final edit, qualify one tarball, publish its checksum, supported-platform matrix, known limitations and recovery instructions. No npm publication or visibility change is part of this audit. |
| Independent security review | Perform a disposable-account live desktop/adversarial review. Full control shell is trusted account access and not a sandbox. |

## Product claims

- On a macOS host, a browser agent receives **Full control**, **Apps**, **Files** or **Read only**. Preset operations do not require per-action approvals. The first invited-agent connection still needs owner approval. Legacy invitations and provider chat approvals have separate contracts.
- Full control commands run with the owner's account rights and can access sensitive files. UI target checks and a command deny list are best-effort guardrails, not confinement. Do not claim “everything except passwords and Reach” is securely isolated.
- Apps restricts native viewing/input to selected apps. Selecting a browser, IDE or terminal also trusts what that app can do. Files without editing is the narrower choice for reading documents.
- Public Funnel serves the limited start/gateway surface only while an invitation or browser-agent session keeps the window open. **Always** access may keep that window open until the owner ends it. Owner APIs and WebSockets remain on private ingress.
- The demo is an interface walkthrough, not proof of live control, physical-phone performance or universal chat synchronization.

See [RELEASE.md](RELEASE.md) for packaging, [BROWSER_AGENT_TOOLS.md](BROWSER_AGENT_TOOLS.md) for tool contracts, and [SECURITY.md](SECURITY.md) for trust boundaries. Raw local audit logs and private workset backups are deliberately excluded from release assets.
