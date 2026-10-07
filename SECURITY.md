# Security policy

Reach can control the signed-in computer account. Use the latest tested main revision during early access; there is no long-term support branch or independent security certification.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/nalebc/reach/security/advisories/new) when available. If that form is unavailable, open an issue asking the maintainer to establish a private reporting channel, without vulnerability details. Do not post exploitation steps, credentials, invitation links, logs, or private files publicly. Private reporting must be enabled before the repository becomes public.

Provide the Reach revision, operating system, affected permission model, a minimal reproduction using synthetic data, and expected versus observed behavior. Do not test against another person's computer. Maintainers will investigate and coordinate disclosure; no response-time guarantee is currently offered.

## Trust boundaries

Read the [security model and review notes](docs/SECURITY.md) and [browser-agent presets and tools](docs/BROWSER_AGENT_TOOLS.md). A browser agent is invited with one preset: **Full control** (the screen, mouse and keyboard, files, and a shell as the owner), **Apps** (only the chosen apps), **Files** (chosen folders, read or read and edit, changes applied immediately) or **Read only**. There are no per-action approvals. In every preset, Reach and Tailscale, password stores and browser password or payment pages, password fields, security prompts and `sudo`, System Settings' privacy panes, Activity Monitor and Force Quit, developer tools and a shell deny list stay protected; the owner can hide more apps. Nothing else is closed: Full control is full control except passwords and Reach. Anything running or signed in is open to the agent, the shell runs as the owner, and the deny list is not a sandbox. Command-line agents (read, edit or run roles), guests and the owner's own devices have their own boundaries; screen control, the run role and unrestricted owner/CLI access act as the signed-in user. One agent acts on the Mac at a time; the owner can pause or stop it from Settings → Agents, and the owner's own input pauses it.

Report a scope bypass, unauthorized approval, replay, credential leak or revoked-session access as a security issue. Dependency checks and regression tests do not replace independent security review or physical-device validation.
