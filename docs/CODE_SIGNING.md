# Code signing policy

Status: Reach is applying to the [SignPath Foundation](https://signpath.org) open-source program to sign its Windows helpers. Until that is approved, nothing Reach ships is signed, and Windows PCs that only run signed programs (Smart App Control on, or a company's application-control policy) refuse Reach's agent helpers with the reason.

When approved, every signed Windows file carries this attribution: **Free code signing provided by [SignPath.io](https://signpath.io), certificate by [SignPath Foundation](https://signpath.org).** Windows shows the publisher as *SignPath Foundation* and the product as *Reach*.

## What is signed

Only Reach's own Windows helpers (`scripts/native/*.cs`), built from this repository's source by GitHub Actions on a GitHub-hosted runner, with no third-party binaries inside. Each signing request is approved by hand for that release; nothing is signed automatically. The signed files ship in the npm package and the release archives, and Reach checks each one before running it: a valid signature from SignPath Foundation and the exact SHA-256 recorded for that release. A source checkout can still build the helpers itself with the PC's `csc.exe`.

## Team roles

| Role | Who |
| --- | --- |
| Authors (commit to the repository) | [@nalebc](https://github.com/nalebc) |
| Reviewers (review changes from anyone else) | [@nalebc](https://github.com/nalebc) |
| Approvers (approve each signing request) | [@nalebc](https://github.com/nalebc) |

Everyone in these roles uses multi-factor authentication for GitHub and SignPath. Contributions from others are merged only through reviewed pull requests with the required checks (`.github/MAINTAINER_SETUP.md`).

## Privacy

Reach collects no analytics or telemetry. It runs on your own computer and talks to:

- your own devices, through [Tailscale](https://tailscale.com);
- your phone's browser push service, to deliver the notifications you turn on;
- update sources, to tell you when a newer version exists: the npm registry, GitHub, and the download pages of the agent CLIs you use (Claude Code, Codex, OpenClaw).

Nothing is sent to the Reach project. Agents you invite act only within the access you give them, and you can pause or end that access at any time.
