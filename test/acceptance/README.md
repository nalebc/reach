# Real Windows acceptance

This lane runs only on a disposable GitHub-hosted `windows-2025` runner. It
installs the published official Codex CLI and a signed official Tailscale MSI,
records their versions/provenance, asks the actual Codex daemon for its endpoint,
and calls Reach's production Codex daemon client without injected dependencies.
Codex runs under a real new standard local Windows account, launched through
`CreateProcessWithLogonW(LOGON_WITH_PROFILE)` on a dedicated private test desktop.
Its random password remains in the launcher process's memory. The worker verifies
its actual SID, Windows elevation/integrity, loaded registry hive, and profile
path against `GetUserProfileDirectoryW` and Windows' `ProfileList` before probing.
The account receives read/execute access to the source and vendor paths and
modify access to acceptance output/scratch only. Cleanup removes its grants,
account, and owned processes; it does not change an existing user's credentials.
Account/process harness failure is reported separately from Codex compatibility.
An observed incompatible endpoint or failed `thread/list` is a failure.
The lane also compiles the actual native socket helper and checks real NTFS
ACL and junction denials without changing the tested endpoint permissions.
Those negative checks do not establish connected foreign-user or elevated-peer
rejection; the separate real Codex probe establishes the permitted peer path.
The report retains the installed vendor's `app-server --help` and
`app-server daemon --help`, exact reported endpoint path, and allowlisted
`lstat`/`stat` kind/size metadata. It never reads endpoint/rendezvous contents.

The separate local smoke starts `reach.cmd --local` in a visible native console,
reads that console through Windows APIs, loads Reach in real Chrome, and uses
real HTTP against Reach for disposable file and native terminal work. Native
screen capture is attempted with Reach's real helper. Those local checks run
with the hosted runner's administrator token; their passes do not establish
standard-user GUI or device parity. They are separate from the Codex account
probe. The lane does not enroll a
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
this workflow and no provider or Tailscale sign-in/enrollment command. Local
Reach pairing and the disposable Windows account use real authentication. The
existing general CI remains required and unchanged.

Artifacts contain an allowlisted vendor report, standard-user worker/harness
reports, and redacted `acceptance.json`. `checkoutCommit` records the checked-out
PR merge commit; `prHeadCommit` separately records the PR source head.
The Actions summary distinguishes `PASS`, `FAIL`, and `BLOCKED`; a passing local
probe never changes a blocked required case to a pass. Full device qualification
remains incomplete until approved real Tailscale identities, public gateway and
provider accounts, and physical iPhone, iPad, and Android clients are available.
Required private → fallback → private, unapproved alternatives, concurrent/held
work, and real-browser cross-port boundaries are listed as blocked prerequisites.
No iPhone Mirroring is used. Raw console buffers, browser profiles, pairing
codes, credentials, screenshots, and Tailscale status payloads are not uploaded.
