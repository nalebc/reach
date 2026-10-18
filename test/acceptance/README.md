# Real Windows acceptance

The pull-request lane runs on a disposable GitHub-hosted `windows-2025` runner.
The existing **Windows validation** workflow also offers an explicit
`real_vendors: true` mode on `windows-11-arm`, `windows-2025` or `windows-2022`.
That mode replaces the selected test names with the six actual native security
checks and this same complete vendor/local probe sequence. Installation failure
stops dependent probes and remains a failed run. No credentials are requested.
Both lanes install the published official Codex CLI and a signed official
Tailscale MSI, record their versions/provenance, ask the actual Codex daemon for
its endpoint, and call Reach's production Codex daemon client without injected
dependencies.
The MSI and installed vendor PE machines must match the native Windows CPU
reported by `IsWow64Process2`, rather than an emulated shell's environment.
Reports retain the actual OS version and Node architecture, vendor PE headers,
and live process architecture for the Tailscale service, Codex daemon and
Reach's connected native helper. AnyCPU helper compilation does not imply
native execution: the live helper's emulation state is reported explicitly.
The added live architecture inspection has a 60-second limit. Its containing
standard-user test, npm process, launcher and parent wait each gain those same
60 seconds; existing vendor, daemon-start and RPC deadlines stay unchanged.
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
For the opt-in ARM64 vendor lane, dispatch **Windows validation** with
`runner: windows-11-arm` and `real_vendors: true`, pinned to the reviewed source
branch or release tag. The ordinary selected-tests mode stays unchanged.
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
