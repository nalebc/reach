# Security policy

Reach can control the signed-in computer account. Use the latest tested main revision during early access; there is no long-term support branch or independent security certification.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/nalebc/reach/security/advisories/new) when available. If that form is unavailable, open an issue asking the maintainer to establish a private reporting channel, without vulnerability details. Do not post exploitation steps, credentials, invitation links, logs, or private files publicly. Private reporting must be enabled before the repository becomes public.

Provide the Reach revision, operating system, affected permission model, a minimal reproduction using synthetic data, and expected versus observed behavior. Do not test against another person's computer. Maintainers will investigate and coordinate disclosure; no response-time guarantee is currently offered.

## Trust boundaries

Read the [security model and review notes](docs/SECURITY.md) and [browser-agent presets and tools](docs/BROWSER_AGENT_TOOLS.md). A browser agent is invited with one preset: **Full control** (screen, mouse, keyboard, files and a shell as the owner), **Apps** (UI access to chosen apps), **Files** (chosen folders, read or read and edit through a sandboxed file helper) or **Read only**. There are no per-action approvals for these presets.

**Full control requires trust equivalent to the signed-in OS account.** Its shell is not sandboxed or confined to shared folders. Commands can read sensitive files, modify Reach and start processes; a deny list cannot reliably prevent that. Full control bypasses protected-window filters, private-file exclusions and command refusals, including for Reach itself and password-manager UI. Secret fields are omitted from action logs where recognized; that is not an access restriction. Signed-in browser sessions and content the agent encounters also remain available to it. Use a separate OS account or isolated computer for untrusted agents.

Apps restricts the native UI surface to selected applications, with filters for known protected windows. Selecting a terminal or IDE still grants whatever commands it can run as the owner. Files has a separate descriptor-based, no-symlink file boundary and kernel sandbox; it does not grant a shell. Command-line agents, guests and owner devices have separate scopes; unrestricted execution and screen control act as the signed-in user. The owner can pause or stop agent input in Settings → Agents. Revocation stops new access and cancels monitored Full control shell process groups, but cannot undo completed actions or guarantee cleanup of deliberately detached processes.

Report a scope bypass, unauthorized approval, replay, credential leak or revoked-session access as a security issue. Dependency checks and regression tests do not replace independent security review or physical-device validation.
