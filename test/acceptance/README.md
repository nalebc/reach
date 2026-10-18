# Real Windows acceptance

This lane runs only on a disposable GitHub-hosted `windows-2025` runner. It
installs the published official Codex CLI and a signed official Tailscale MSI,
records their versions/provenance, asks the actual Codex daemon for its endpoint,
and calls Reach's production Codex daemon client without injected dependencies.
An observed incompatible endpoint or failed `thread/list` is a failure.

The separate local smoke starts `reach.cmd --local` in a visible native console,
reads that console through Windows APIs, loads Reach in real Chrome, and uses
real HTTP against Reach for disposable file and native terminal work. Native
screen capture is attempted with Reach's real helper. It does not enroll a
Tailscale device, sign a provider in, run provider inference, or validate a phone.
The local case cannot qualify private Tailscale or Funnel behavior.

Run the **Real Windows acceptance (partial qualification)** pull-request workflow,
or dispatch it after GitHub has registered the workflow on the default branch.
The guarded test command used by the workflow is:

```powershell
npm run test:file -- --test-timeout=900000 --test-concurrency=1 test/acceptance/real-windows.test.mjs
```

The installer is intentionally restricted to GitHub-hosted Windows. No owner
Reach instance is touched. There are no repository/provider/Tailscale secrets in
this workflow and no authentication or enrollment command. The existing general
CI remains required and unchanged.

Artifacts contain an allowlisted vendor report and redacted `acceptance.json`.
The Actions summary distinguishes `PASS`, `FAIL`, and `BLOCKED`; a passing local
probe never changes a blocked required case to a pass. Full device qualification
remains incomplete until approved real Tailscale identities, public gateway and
provider accounts, and physical iPhone, iPad, and Android clients are available.
Required private → fallback → private, unapproved alternatives, concurrent/held
work, and real-browser cross-port boundaries are listed as blocked prerequisites.
No iPhone Mirroring is used. Raw console buffers, browser profiles, pairing
codes, credentials, screenshots, and Tailscale status payloads are not uploaded.
