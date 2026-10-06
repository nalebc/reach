# Security policy

Reach can control the signed-in computer account. Use the latest tested main revision during early access; there is no long-term support branch or independent security certification.

## Report privately

Use [GitHub private vulnerability reporting](https://github.com/nalebc/reach/security/advisories/new) when available. If that form is unavailable, open an issue asking the maintainer to establish a private reporting channel, without vulnerability details. Do not post exploitation steps, credentials, invitation links, logs, or private files publicly. Private reporting must be enabled before the repository becomes public.

Provide the Reach revision, operating system, affected permission model, a minimal reproduction using synthetic data, and expected versus observed behavior. Do not test against another person's computer. Maintainers will investigate and coordinate disclosure; no response-time guarantee is currently offered.

## Trust boundaries

Read the [security model and review notes](docs/SECURITY.md) and [browser-agent controls](docs/BROWSER_AGENT_TOOLS.md). Browser-agent folder scopes, read commands, approved sandboxed scripts, supervised screen input, and unrestricted owner/CLI access have different boundaries. Screen control and unrestricted shell access can act as the signed-in user. A command denylist does not make those capabilities safe for untrusted agents.

Report a scope bypass, unauthorized approval, replay, credential leak or revoked-session access as a security issue. Dependency checks and regression tests do not replace independent security review or physical-device validation.
