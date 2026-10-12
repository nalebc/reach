# Windows sandbox: design (revision 2)

Status: implementation spec for workstream C of `docs/WINDOWS_AGENT_PARITY.md`. Design only: it changes no code and makes no commits. Line numbers refer to the tree at `33377229`; the cited anchors were re-read for this revision (`server/jobs.mjs`, `server/agent-shell.mjs`, `server/browser-scripts.mjs`, `server/browser-file-boundary.mjs`, `server/browser-private-paths.mjs`, `server/index.mjs:1064-1073,2452-2505,3004-3024`, `server/core.mjs:600-760,2092`, `server/agent-policy.mjs:110-125`, `scripts/native/browser-files.swift`). Nothing here changes a single byte of macOS behaviour: every new path is a `process.platform === "win32"` branch, and the Mac functions (`agentShellSandbox`, `shellSandboxProfile`, `scriptProfile`, `fileBoundaryProfile`, `createAgentShell`, `browserFileOperation`'s darwin path) are left untouched; Windows gets siblings.

Revision 2 resolves the review's three blockers, its eleven majors and its three minors. Each item, the control that closes it, the helper's own self-check and refusal, and the test that proves it are in §0.1. Where this revision reconciles C against the already-revised B and D designs, it adopts their contracts rather than inventing a second one (§0.2). Questions only the owner can settle are in "Decisions for the owner"; every default named there is the fail-closed option.

## 0. Decisions at a glance

| Question | Decision |
|---|---|
| What "sandboxed per C" means | Four Mac policies, not one (§0.3). The Full-control shell gets a **Job Object only**, as the owner's own token — the Mac leaves it unsandboxed, so this is parity, not a weakening. Jobs get a **regular AppContainer** + Job Object. Scripts get an **LPAC AppContainer** + a one-process Job Object. The Files helper is a **broker on the owner's token** (finding 4), not an AppContainer. |
| File confinement primitive | **Per-root capability SIDs** (finding 3): one capability derived from each shared root, ACE'd on that root's tree once at grant time. A launch receives only the capabilities for the client's current roots, so revoking or changing roots takes effect on the next launch with no new walk. Secrets are carved out with DENY ACEs for a fixed Reach-wide capability SID that every Reach-launched token carries. |
| What may be granted | A fixed table of client-kind × surface → grant set (§4.3). A jobs or scripts grant whose root is a drive root, Home, or an ancestor of Home is **refused** with a worded reason (finding 2). Grants are never derived from `config.roots`. |
| The authority on "is a secret reachable" | A preflight `AccessCheck` of the real launch token against every deny path, run under the ACL lock right before `CreateProcess` (findings 1, 14). Whatever mechanism produced an ACE, the launch proceeds only if `AccessCheck` denies every secret. |
| Interpreter for a free-form command | `cmd.exe /d /s /c` for jobs; the Full-control shell interpreter is an owner decision (D-C-1) defaulting to `cmd.exe` (plan rule 3 keeps PowerShell out of agent paths). Own-device jobs keep today's `powershell.exe` path unless changed deliberately (finding 17). |
| Helper | One C# 5 file `scripts/native/sandbox.cs`, built and launched through workstream A's `windowsBinary`/`spawnVerified` and D's `ensurePrivateFolders` (§0.2, §2). No PowerShell, no downloaded binaries. |
| Delivery blocked by policy | Decided by a no-op launch self-test of the built (or signed) helper at every start, classified exactly as B §3.4 does (SAC, App Control, AppLocker, ASR, Controlled Folder Access). Fail closed with the reason; never retry, never fall back to an interpreter (finding 15). |
| Network | No WFP or firewall belts (an unelevated Reach can't install them, finding 9). Scripts and Files get no network capability at all. Jobs get internet; before each jobs launch a runtime self-test inside the AppContainer must find Reach's own listener unreachable on every local address, or the launch is refused. |
| Tests | Unit tests with an injected platform (`test/helpers/as-windows.mjs`) and injected dependencies. Real-Windows escape tests run as a **standard, non-elevated user** under `REACH_TEST_WINDOWS_DESKTOP=1`, reusing D §8's standard-user harness. One negative case per finding (§9.4). |

### 0.1 Review resolution

Each row names the protective control (what is denied and how it is configured), the helper's own setup self-check and its refusal, the test that proves the control, and where the detail lives.

| # | Sev | Control (deny + configuration) | Helper self-check → refusal | Test (file · case) | §§ | Status |
|---|---|---|---|---|---|---|
| 1 | blocker | `appRoot` (code, `node_modules`, `scripts/native/*.cs`), `dataDir`, `.reach`, agent vault, and the Windows persistence points (Startup, both PowerShell profile dirs, Git Bash rc files, `.ssh/authorized_keys`) are in the deny set of all three sandboxed surfaces. No ALLOW ACE is ever written inside those subtrees, even when a granted root contains them. | Preflight `AccessCheck` of the launch token against every deny path; if any is reachable, the launch is refused. | `windows-sandbox.test.mjs` · "a grant whose root contains the checkout denies writes to code and refuses launch when appRoot stays reachable"; real: `windows-sandbox-e2e.test.mjs` · "read Reach's data / write Reach's code" | §3, §4.4, §4.5 | Resolved |
| 2 | blocker | A fixed client-kind × surface → grant-set table. A jobs/scripts grant whose root is a drive root, Home, or an ancestor of Home is refused. Grants never come from `config.roots`. Read-only Files over Home uses the owner-token broker, not ACEs. | The helper refuses a grant request whose root fails the table or the drive/Home test, with the reason; it never walks a drive root. | `windows-sandbox.test.mjs` · "jobs and script grants refuse drive-root, Home and Home-ancestor roots"; `browser-file-boundary.test.mjs` win32 · "read-only Home Files routes to the broker" | §3.1, §4.3 | Resolved; parity break recorded (§10) |
| 3 | blocker | Per-root capability SIDs ACE'd once on the root; a launch gets only the capabilities for current roots. DENY carve-outs target a fixed Reach-wide capability SID. Revoke kills the job first, then removes ACEs, continuing past reparse points. A periodic sweep handles expiry. | On launch the helper diffs current roots against the ledger and finishes any pending revoke before starting; it refuses if the diff can't be completed. | `windows-sandbox.test.mjs` · "changing or revoking roots takes effect on the next launch with no walk"; real: `windows-sandbox-e2e.test.mjs` · "a revoked session's capabilities grant nothing" | §4.1, §4.2, §4.6 | Resolved; moved-file residual is D-C-7 |
| 4 | blocker | The Files helper runs on the owner's token (no AppContainer), keeping the NT handle discipline, final-path verification and the private-name/path check on the normalized name. The AppContainer and ACE walk are dropped for Files. | The helper refuses if it can't open the root by handle, verify its identity, or normalize a component. | `browser-file-boundary.test.mjs` win32 · (ports of `:52,:63,:85`); real: `windows-file-boundary-e2e.test.mjs` | §3.4, §7 | Resolved; lowbox-impersonation variant is D-C-2 |
| 5 | major | Per-surface deny sets mirror the Mac exactly: jobs = `agentShellSandbox`'s read/write lists (so `.git`, `.npmrc`, `.config` inside a root stay usable); scripts and Files = `browserPrivatePaths` + private names. `FILE_DELETE_CHILD` is withheld on directories that contain private names. | After a script run and before closing the job, the helper scans the root for new or renamed private-name entries and fails the run if any appeared. | `browser-scripts.test.mjs` win32 · "a script that creates .npmrc, renames .git aside, or creates .git/config is reported and the run fails"; `windows-sandbox.test.mjs` · "jobs deny set omits in-root private names" | §3.3, §4.4 | Resolved; residual listed (§10) |
| 6 | major | Exact masks: read = `FILE_GENERIC_READ \| FILE_GENERIC_EXECUTE`; write adds `FILE_GENERIC_WRITE \| DELETE`. Directory ACEs are `OI\|CI`; file ACEs are not inheritable. | The helper builds masks from a single table and refuses if an op needs a right the grant lacks. | `windows-sandbox.test.mjs` · "produced SDDL carries the specified masks"; real: `windows-sandbox-e2e.test.mjs` · "create→reopen, rename, delete, and run an in-root program succeed under a write grant" | §4.4 | Resolved |
| 7 | major | Jobs: no child-process restriction; a process cap only as a fork-bomb guard. Scripts: a one-process limit plus `CHILD_PROCESS_RESTRICTED`. The Windows equivalents of `open`/`osascript` are probe-verified refusals via the brokered-launch control (finding 8). | The helper refuses to configure a surface whose process policy doesn't match its mode. | `windows-sandbox.test.mjs` · "jobs allow children; scripts forbid them"; real: part of `windows-sandbox-e2e.test.mjs` · "survive the close" | §3.1, §3.3, §6 | Resolved |
| 8 | major | `JOBOBJECT_BASIC_UI_RESTRICTIONS` (clipboard read/write, handles, desktop, global atoms, system parameters, exit-windows) on jobs, scripts and the shell. Every brokered launch channel is enumerated and treated as a refusal to escape the job. | The helper asserts the UI restrictions are set before launch and refuses otherwise. | real: `windows-sandbox-e2e.test.mjs` · "no new process appears outside the job after a brokered-launch attempt" (process snapshot before/after) | §6 | Resolved; private desktop is D-C-4 |
| 9 | major | No WFP/firewall belts. A runtime self-test inside the jobs AppContainer must find Reach's listener unreachable on every local address (`127.0.0.1`, `::1`, the LAN IP, the tailnet IP and MagicDNS name) before the launch proceeds. | The self-test is fail-closed: any reachable address refuses the launch. | `windows-sandbox.test.mjs` · "a reachable local address refuses the jobs launch (injected probe)"; real: `windows-sandbox-e2e.test.mjs` · "loopback and tailnet to Reach are refused" | §5 | Resolved; LAN/tailnet capability is D-C-3 |
| 10 | major | Jobs run in a regular AppContainer (not LPAC); `TEMP`/`TMP` point at the AppContainer folder; scripts grant the Node runtime directory read+execute or refuse; `JOB_TIME` is dropped (or set ≥ `timeoutMs` × logical CPUs); the Full shell gets no caps and is killed only on abort/timeout; env is built with `CreateEnvironmentBlock(owner token, FALSE)` + `REACH_AGENT=1`; the `reach_shell` tool wording is platform-aware. | The helper refuses a script grant if the Node runtime directory can't be granted. | `browser-scripts.test.mjs` win32 · "a Node runtime that can't be granted refuses the run"; `agent-shell.test.mjs` win32 · "no caps; survivors reaped only at abort/timeout" | §3.1, §3.2, §3.3, §6 | Resolved; profile-read loss is D-C-5 |
| 11 | major | The grant walk skips hard-linked files and name-surrogate reparse points (`IsReparseTagNameSurrogate` plus AppExecLink) and carries on; it refuses only on scan errors or above a bound. Cloud/WOF/dedup tags are treated as data. The root is opened via its device path (or each component relative to its parent with reparse inspection). ReFS identity uses the 128-bit `FILE_ID_INFO`. | The helper refuses on a scan error or above the link/entry bound; it never aborts a whole grant because an ordinary cloud placeholder or pnpm store was present. | `windows-sandbox.test.mjs` · "hard links and name-surrogate reparse points are skipped, not fatal"; real acceptance adds OneDrive KFM, a pnpm project and a Dev Drive (§9.5) | §4.4, §7.3 | Resolved |
| 12 | major | Win32 branches in the JS validators recognize drive-letter, UNC, `\\?\` and backslash paths; strip `.exe`/`.cmd`/`.bat` before the protected-name check; add protected roots (`%WINDIR%`, both Program Files, `%ProgramData%`, the Node runtime dir, `%LOCALAPPDATA%\Programs`); compare case-insensitively. | The validators refuse any path that resolves outside the root or into a protected root, before anyone is asked. | `windows-path-validation.test.mjs` · one case per bypass string; `browser-scripts.test.mjs` win32 · "protected roots and `.cmd`/`.bat`/`.ps1` programs refused" | §3.3, §3.4, §7.2 | Resolved |
| 13 | major | The child inherits only helper-owned pipes (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`), never a control handle. The helper relays child output in length-prefixed frames on one channel; control frames arrive only on the helper's own channel. The request is length-prefixed and stdin then stays open as the lifeline. | The Node side rejects any control frame that arrives on the data channel. | `windows-sandbox.test.mjs` · "a forged exit/result frame on the data channel is rejected"; jobs background/timeout/kill cases ported from `jobs.test.mjs:25,35,43` | §2.3, §3.1 | Resolved |
| 14 | major | One machine-wide ACL-mutation lock; `AccessCheck` re-run under that lock immediately before `CreateProcess`; DENY ACEs explicit and `OI\|CI`; the walk verifies the DENY stays first in canonical order. | The helper refuses the launch if the post-walk ordering check fails or the lock can't be taken. | `windows-sandbox.test.mjs` · "two concurrent grants over nested roots keep the DENY first and refuse on a failed re-check" | §4.5, §4.6 | Resolved |
| 15 | minor | The launch self-test (not the registry alone) decides whether the OS lets the helper run; each failure maps to a worded refusal; the registry read is kept only for wording. | The self-test runs at every start; a blocked helper refuses the surface, never retries, never falls back to an interpreter. | `windows-sandbox.test.mjs` · "a blocked launch (injected classifier) refuses with the policy wording" | §2.2 | Resolved |
| 16 | minor | The escape suite runs as a standard, non-elevated local user; a real-PC checklist (OneDrive KFM, Dev Drive, SAC Evaluation, Controlled Folder Access) is kept for phase 5. | — | `windows-sandbox-e2e.test.mjs` runs under D §8's standard-user harness | §9.3, §9.5 | Resolved |
| 17 | minor | Factual corrections (§0.4); the Windows shell runner is wired through an explicit `win32` branch at `index.mjs:1072`, ignoring the Mac env it is passed; plan/design reconciled on the interpreter; own-device jobs keep today's behaviour with a test. | — | `agent-shell.test.mjs` win32 · "own-device jobs keep powershell.exe unless changed" | §3.2, §8 | Resolved |

### 0.2 Shared contracts adopted from B and D (no second build path)

C depends on workstream A and reuses, unchanged, the contracts the revised B and D designs already pinned:

- **Build and launch** go through A's `windowsBinary(kind, { dir, fresh })` and `spawnVerified(file, sha256, args, options)` exactly as D §4.5 specifies: the helper is compiled (or the SignPath-signed prebuilt is used, plan rule 3 / `docs/CODE_SIGNING.md`) into a folder that `ensurePrivateFolders` protected this launch, never into an unchecked `config.dataDir`; its SHA-256 is re-checked right before every spawn. C adds no second build path and does not write the helper into `config.dataDir`.
- **Private folders.** D §4.5's `ensurePrivateFolders` already tightens Reach's state/data folders to owner-only ACLs each launch and refuses keyed mode if a code folder is writable by another user. C's grant mechanism must keep that checker green (§0.5).
- **Policy classification.** B §3.4's SAC state read and event-log launch classification are the single source of the "blocked by policy" wording; finding 15's self-test reuses it (§2.2).
- **Standard-user CI harness.** D §8 builds a standard, non-elevated user and launches under it. C's escape suite runs through that harness (§9.3), not a third one.

### 0.3 Rule 0 first: four Mac policies, not one

Parity is measured against the Mac code and its tests, not the plan line. The four surfaces differ:

| Mac surface | File | Mac enforcement | Network | Children |
|---|---|---|---|---|
| **Full-control shell** (`reach_shell`) | `server/agent-shell.mjs:42` | **None.** `/bin/zsh -c`, clean env (`:104-107`), process group, time/output limits. `createAgentShell` takes no `sandbox`; the `sandbox`/`sandboxExec` args a test passes are ignored. The test (`agent-shell-sandbox.test.mjs`) asserts it *reaches* secrets, sockets and code as the OS user. | Full | Full (owner) |
| **Jobs** (`/api/jobs`) | `server/jobs.mjs`, `server/agent-shell.mjs:15`, `server/browser-private-paths.mjs:24` | allow-default + targeted DENY: denies `dataDir`, `.reach`, agent policy, keychains, browser profiles, Tailscale containers; write-denies code + launch agents + shell rc; socket-denies Reach's sockets; port-denies Reach's port; denies Apple Events and `open`/`osascript`. It does **not** deny `.git`/`.npmrc`/`.config` inside a shared root. | On, except Reach's port + sockets | On, except `open`/`osascript` |
| **Browser scripts** | `server/browser-scripts.mjs:76` | deny-default allow-list: root read-write, system roots + Node runtime read+exec; one process, no fork; no network; no links; private-name denial; guarded hard-links/special files. | None | One, no fork |
| **Files helper** | `server/browser-file-boundary.mjs:16` + `scripts/native/browser-files.swift` | deny-default; descriptor-relative `openat(O_NOFOLLOW)`, `F_GETPATH` verify, `nlink==1`; private-name/path denial. | None | None |

Two consequences the design is built on. First, the plan's "Full-control shell … sandboxed per C" is drift: on Windows the Full shell gets a Job Object only, as the owner's own token, matching the Mac. Second, Windows has no allow-default file sandbox primitive, so the jobs file boundary is expressed as an allow-list of capability-SID ACEs over exactly the shared roots, which is stricter on reads than the Mac's deny-list — recorded as a parity *gain* in §10, with the Mac's deny guarantees kept as an additional belt.

### 0.4 Factual corrections carried from finding 17

- A low-integrity restricted token cannot read a medium-integrity process's memory (process objects carry `NO_READ_UP`); the earlier rejection reason for restricted tokens was overstated, though the conclusion (AppContainer, not a bare restricted token) stands.
- Windows Sandbox needs Pro/Enterprise and hardware virtualization; nested virtualization matters only inside a VM. It stays rejected (§1).
- libuv fills `st_dev`/`st_ino` from the volume serial and file index, and on newer builds through a by-name fast path, so the identity test must exercise both stat paths (§7.3).
- PowerShell `-Command` is not governed by execution policy; the ban on PowerShell in agent paths stands on cold-start and language-mode grounds (plan rule 3), not execution policy.

### 0.5 Reconciling C's ACEs with D's code-folder checker

D §4.5 refuses keyed mode and invite keys if any non-owner SID holds a write-type right on a code folder (`appRoot`, `bin`, `scripts`, `scripts\native`, `server`, `dist`, `node_modules`). Therefore C's grant mechanism must never place an ALLOW ACE inside `appRoot`, `dataDir`, or the state folder, even when a client's shared root contains the checkout. This is why §4.3 refuses drive-root/Home/Home-ancestor roots for jobs and scripts, and why §4.4 writes no ALLOW inside a private subtree. D's per-launch `icacls /inheritance:r /grant:r` (SIDs only) on Reach's own folders removes any stray inherited ACE there; C does not rely on inheritance into those folders at all. The preflight `AccessCheck` (§4.5) is the final authority regardless of which mechanism produced an ACE. A test asserts D's checker still passes after a C grant over a root that contains the checkout (§9.2).

## 1. Mechanism: AppContainer (jobs, scripts) + Job Object; broker (Files, shell)

Candidates against the four policies' needs:

| Mechanism | Verdict |
|---|---|
| **Bare restricted / low-IL token** | Rejected as the primary boundary. It stays a normal user principal and can send input or clipboard into the owner's windows; its file confinement can't express a reads-limited-to-the-roots allow-list. Kept only as hardening inside the AppContainer where useful (finding 17 corrects the memory-read claim). |
| **Windows Sandbox (`.wsb`)** | Rejected: needs Pro/Enterprise + virtualization, is a throwaway VM with no handle-relative view of the owner's folders (finding 17). |
| **Regular AppContainer + Job Object** | **Jobs.** Low-integrity label, unique package SID, per-root capability SIDs; file access is the intersection of the owner's access and the capability grant, so a folder is reachable only if both allow it. Network via `internetClient` (§5). |
| **LPAC AppContainer + one-process Job Object** | **Scripts.** As above, with no capabilities beyond what the §9.1 probe proves the interpreter needs to start, no network capability, and a one-process limit. |
| **Owner-token broker (no AppContainer)** | **Files helper (finding 4)** and the **Full-control shell.** The confinement is the helper's own NT handle discipline and verification, not a lowbox; this is what the Mac's Full-control effectively is, and it is the only feasible shape for read-only Home Files (§3.4, §7). |

The AppContainer is the access boundary; the Job Object is the lifecycle and resource boundary (kill-on-close, caps, UI restrictions, no breakaway). They are orthogonal and both used for jobs and scripts.

## 2. The helper: `sandbox.cs`, a C# host

### 2.1 Delivery

Built or signed and launched through A's `windowsBinary`/`spawnVerified` into an `ensurePrivateFolders`-protected directory (§0.2). Written to C# 5 for the in-box .NET Framework compiler; a unit test greps the `.cs` for C#-6+ constructs so a future edit can't silently require Roslyn. The helper is never written into an unchecked `config.dataDir`.

### 2.2 Refusing when policy blocks the helper (finding 15)

The decision that the OS will actually run the helper comes from a no-op launch self-test at every start, classified exactly as B §3.4 classifies the desktop helper (SAC state for wording; App Control, AppLocker, ASR and Controlled Folder Access via the event-log check). This is **not** the rejected self-verifying binary of earlier B drafts: that idea had the binary vouch for its own identity; this self-test only asks whether the operating system permits the already-hash-verified helper to launch. Each failure maps to a worded refusal of the sandboxed surface; the launch is never retried and never falls back to an interpreter (plan rule 2). The registry read is kept only to choose wording.

### 2.3 Protocol — Node ⇄ `sandbox.exe` (finding 13)

One helper process per operation (one file op, or one command/script/shell run). The child the helper launches inherits only pipe handles the helper owns, passed through `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`; it never inherits a control handle. The helper relays the child's stdout/stderr to Node as length-prefixed frames on a single data channel; the helper's own control frames (`started`, `error`, `exit`, file `result`) travel only on the helper's own channel. Node rejects any control frame that arrives on the data channel, so a child cannot forge an exit code or a file result. The request is written length-prefixed; stdin then stays open as the end-of-input lifeline, so the helper is not torn down the instant the request is delivered. Timeouts, output caps and the per-op `check()` revalidation stay in the Node layer (`browser-file-boundary.mjs`, `jobs.mjs`), unchanged; the helper never decides authorization lifetime. All argument passing is a pre-split `argv` built into `lpCommandLine`; no shell string is ever concatenated.

## 3. The four surfaces on Windows

### 3.1 Jobs — `/api/jobs`

Today `jobs.mjs` spawns `powershell.exe` unsandboxed on win32 and is saved only because `index.mjs:3019` refuses when there is no sandbox. New design:

- A Windows sibling `windowsJobSandbox(config, client, { sockets })` in a new `server/windows-sandbox.mjs` returns `{ grants, denies, network, capabilities, limits }` (not a profile string). The wiring at `index.mjs:1068-1069` becomes `darwin → agentShellSandbox`, `win32 → windowsJobSandbox`, else `null`; the fail-closed refusal at `:3018-3019` stays for any third platform.
- **Grants come from the client, not `config.roots` (findings 1, 2).** The POST handler computes `grants` from the table in §4.3 against `req.client.agentRoots` (agents) or the device's own roots, intersected with the resolved `cwd`. A jobs grant whose root is a drive root, Home, or an ancestor of Home is refused with a worded reason. `denies` is the Windows private-path set mirroring `agentShellSandbox`'s read/write lists (§4.4) — notably **not** the in-root private names, so `git` and `npm` work as on the Mac (finding 5).
- **Interpreter:** `cmd.exe /d /s /c <command>` inside a **regular AppContainer** (finding 10) + Job Object, launched without a console. Jobs allow child processes (finding 7): no child-process restriction, only a fork-bomb process cap. The Windows analogues of the Mac's `open`/`osascript` denials are the brokered-launch control of finding 8 (§6).
- **Own-device jobs keep today's behaviour (finding 17):** on win32 a device with `admin` still runs `powershell.exe` as today unless the owner deliberately changes it; a test pins this.
- **Background semantics (finding 13):** the helper reports the main process's exit code in its `exit` frame; survivors are reaped at job close (deadline or drain). In `jobs.mjs`'s win32 branch, `end(code)` is driven from that frame plus the existing 1 s grace, keeping the helper alive only to reap survivors at the deadline — so the `jobs.test.mjs:25` background contract holds. The skipped win32 cases (`:25,:35,:43`) get analogues under `as-windows` + a stub helper (§9.1).

### 3.2 Full-control shell (finding 10, 17)

Mac: unsandboxed `/bin/zsh`. Windows parity: **Job Object only, owner token, no AppContainer.**

- The Windows production `run` is injected through an explicit `win32` branch at `index.mjs:1072` (not the test override), and it ignores the Mac env `createAgentShell` passes it. It launches the chosen interpreter (default `cmd.exe`, D-C-1) through `sandbox.exe mode:"shell"` with **no** security capabilities (a medium-IL owner process) inside a Job Object configured for the shell (finding 10): kill-on-close and die-on-unhandled-exception and the UI restrictions, but **no** memory/process/CPU caps, and the job is killed only on abort or timeout — matching the Mac's process-group kill, which lets `start`-ed background apps survive. The env is built with `CreateEnvironmentBlock(owner token, FALSE)` + `REACH_AGENT=1`.
- The 50 ms revocation watchdog and output/time limits in `agent-shell.mjs` are unchanged; on abort the helper gets stdin-EOF and the Job Object reaps the tree. The zsh path is untouched.
- `reach_shell`'s tool description (`browser-tools.mjs:176`) becomes platform-aware (finding 10): on Windows it names a Job Object and the owner's account, not "macOS permissions still apply".

### 3.3 Browser scripts (findings 5, 6, 7, 10, 12)

Mac: deny-default, root read-write, no network, one process, no links. Windows parity = the strictest shape: **LPAC AppContainer** (no capabilities beyond what the probe proves the interpreter needs) + a one-process Job Object with `CHILD_PROCESS_RESTRICTED` (finding 7); grant = the one root; denies = `browserPrivatePaths` + private names (finding 5).

- `validateBrowserScript`'s darwin gate becomes a platform switch: darwin keeps the sandbox-exec check; win32 checks `windowsBinary`/signed-helper availability and the launch self-test; else refuse. The validation logic above the gate (program allow-listing, `rejectOutsidePaths`, `rejectProtectedProgram`, root/private checks) stays — it is the parity spec — but gains win32 branches (finding 12): drive-letter/UNC/`\\?\`/backslash paths recognized, `.exe`/`.cmd`/`.bat` stripped before the protected-name check, protected roots added (`%WINDIR%`, both Program Files, `%ProgramData%`, the Node runtime directory, `%LOCALAPPDATA%\Programs`), case-insensitive comparison. `.bat`/`.cmd` and `.ps1` are refused as the program.
- **Node runtime (finding 10):** scripts grant the resolved Node runtime directory read+execute, or refuse the run with a worded reason if it lives where a capability ACE can't be granted.
- **Masks (finding 6):** read = `FILE_GENERIC_READ | FILE_GENERIC_EXECUTE`, write adds `FILE_GENERIC_WRITE | DELETE`; directory ACEs `OI|CI`, file ACEs non-inheritable. `FILE_DELETE_CHILD` is withheld on directories containing private names (finding 5).
- **Hard links / reparse points (finding 11)** are handled in the grant walk (§4.4), not by a separate JS pre-scan; the Mac `guardedFiles` stays Mac-only.
- **Post-run scan (finding 5):** after the run and before the job closes, the helper scans the root for new or renamed entries with a private name and fails the run if any appeared, so a script can't plant `.npmrc` or swap in a `.git` that would run as the owner later. The remaining gap (a private name created and used within the same run) is listed in §10.

### 3.4 Files helper — owner-token broker (finding 4)

Mac: a confined helper doing descriptor-relative `openat(O_NOFOLLOW)`, `F_GETPATH` verification, `nlink==1`. The earlier "inside an LPAC AppContainer" plan is dropped: Windows can't move a running process into an AppContainer, an LPAC child couldn't load its own image from the denied folder, and read-only Home Files would need the infeasible ACE walk over Home. Instead, **the Files helper runs on the owner's token** and provides the whole boundary in code (§7): NT handle-relative traversal that follows no reparse point, final-path verification of every handle against the root, the private-name/path check on the normalized name, and the hard-link/regular-file check. This is the same shape the draft already used for Full-control Files and the Full-control shell.

- `browser-file-boundary.mjs` is already mostly platform-neutral. Its non-darwin fail-closed at `:54` becomes `!== 'darwin' && !== 'win32' && typeof run !== 'function'`, so on win32 it routes to the helper rather than returning 503; the `:139` test ("non-macOS fails closed") keeps passing because the helper is unavailable in that unit context and the branch still refuses when neither a real win32 helper nor an injected `run` is present. The op allow-list, base64 validation, concurrency bounds and `check()`-after-close are reused verbatim.
- The `request.sandbox` profile field is Mac-specific; on win32 the helper ignores it and uses the request's root plus the normalized private-name/path list. `relative()` gains a win32 branch that rejects a `:` in any component (alternate data streams, drive-relative `C:foo`), reserved device names, and trailing dots/spaces (finding 12, §7.2).
- Parity ledger (§10): the kernel belt the Mac gets from `sandbox_init` is, on Windows, replaced by broker code. An optional lowbox-impersonation hardening of the worker thread is D-C-2.

## 4. Capability granting and cleanup (shared infrastructure)

### 4.1 Per-root capability SIDs (finding 3)

Confinement is by a **custom capability SID per shared root**, created with `DeriveCapabilitySidsFromName("reach.root.<hash(root)>")` (the precedent is Chromium's `lpacChromeInstallFiles`). The capability is ACE'd onto that root's tree once, at grant time. Each AppContainer launch is given, through `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, only the capabilities for the client's *current* roots. So removing or changing a root needs no ACE walk and takes effect on the next launch — the live token simply no longer carries that capability. The package SID stays stable per client; the roots a given launch can touch are controlled entirely by the capability set handed to that launch.

### 4.2 Scope and ledger

Grants are per shared root, recorded in an `ensurePrivateFolders`-protected ledger `<stateDir>\windows-sandbox\grants.json` (atomic write): `{ capabilitySid, root, access, grantedAt }`. ACL mutation is serialized under one machine-wide lock (§4.5). Walks run at **invitation or admission time**, with a size bound and progress, never inside the 10 s Files or 30 s script op timeouts.

### 4.3 What may be granted (findings 1, 2)

A fixed table, refusing anything outside it with a worded reason; grants never come from `config.roots`:

| Client kind | Surface | Grant set |
|---|---|---|
| Invited agent (files/full presets) | jobs, scripts | each `agentRoots` entry that passes the drive/Home test; refuse the grant otherwise |
| Invited agent (readonly/files) | Files | read capability on each `agentRoots` entry; read-only Home via the owner-token broker (no capability ACE) |
| Full guest / full-control | Files, shell | owner-token broker, whole access the owner granted (no AppContainer ACE) |
| Non-admin device | jobs | each device root that passes the drive/Home test |
| Admin device | jobs | today's `powershell.exe` path, unchanged (finding 17) |

A jobs or scripts grant whose root is a drive root, Home, or an ancestor of Home is refused. This closes finding 2 (no walk over Home, no capability ACE on a drive) and finding 1 (a root containing the checkout can still be refused here, and even an allowed root never gets an ALLOW inside `appRoot`/`dataDir`/state). Its parity cost — a non-admin device or full guest whose only roots are Home plus drive letters cannot run jobs on Windows — is recorded in §10.

### 4.4 The grant walk (findings 1, 5, 6, 11)

- The walk never uses tree auto-inheritance to propagate across a path; ACEs are set on each object by handle so a hard link to an outside file can't drag an ACE onto that file. Because an `OI|CI` ACE does not reach *existing* descendants, a one-time handle walk at grant time is still required; it applies the capability ALLOW with the masks of finding 6 to each object.
- The walk **skips** (does not ACE, and does not abort on) hard-linked files and name-surrogate reparse points, continuing the walk; it refuses the grant only on a scan error or above a bound (finding 11). Cloud, WOF and dedup reparse tags are treated as data. The root is opened through its device path so the walk doesn't trip on the volume's own object-manager symlink.
- **No ALLOW is ever written inside a private subtree** — `appRoot`, `dataDir`, the state folder, the agent vault, `.ssh`, the Startup folder, both PowerShell profile directories, Git Bash rc files, or any `browserPrivateNames` component — even when the granted root contains one (findings 1, 5). Secrets additionally carry an explicit `OI|CI` DENY ACE for the fixed Reach-wide capability SID that every Reach-launched token holds, placed first in canonical order; a unit test asserts DENY-before-ALLOW ordering. For jobs, the deny set mirrors `agentShellSandbox`'s read/write lists and **omits** the in-root private names, so ordinary `git`/`npm` keep working (finding 5).

### 4.5 Preflight is the authority (findings 1, 14)

Under the one machine-wide ACL-mutation lock, immediately before `CreateProcess`, the helper builds the real launch token (package SID + the current capability set) and runs `AccessCheck` against every deny path. If any secret is reachable, the launch is refused with the reason — whatever produced the ACEs, and regardless of D's `icacls` having reset inheritance on Reach's own folders. The post-walk ordering check confirms the DENY stayed first; a failure refuses the launch. Re-running `AccessCheck` under the lock closes the lost-update race over nested roots.

### 4.6 Revocation, change and residue (finding 3)

- On a root being removed or a session revoked, the helper **kills the job first**, then removes that root's capability ACEs in a walk that continues past reparse points (never aborting, so a planted junction can't preserve an ACE). Because capabilities are per launch, a change of roots already takes effect on the next launch without any walk; the walk only reclaims the on-disk ACEs.
- Revoke/change hooks are wired where the server already tears sessions down: `endSession`/`endClient` (`index.mjs:2483-2505`), beside the other `cancelClient` calls, and the per-launch capability diff is added to the `changeAccess` job-cancel block (`index.mjs:2452-2459`). Expiry, which fires no event, gets its own periodic sweep. A startup sweep (beside `jobs.mjs:11`'s orphan reset) revokes grants whose client is gone or expired.
- **Residual (D-C-7):** a file the owner moves *out* of a granted root keeps the capability ACE and stays reachable by any live token that still holds that capability, until the session is revoked. The Mac loses access at once. Stated here and offered as an owner decision; the real-Windows test asserts a *revoked* session's capability grants nothing.
- **Probe item, not an assertion:** "a DENY for the Reach-wide capability SID actually denies a token that carries it" is verified by the §9.1 probe, not assumed.

## 5. Network (finding 9)

- **Scripts, Files:** no network. The LPAC scripts AppContainer carries no `internetClient`/`internetClientServer`/`privateNetworkClientServer` capability; the Files broker makes no network calls. No WFP rule is claimed (an unelevated Reach can't install one).
- **Jobs:** internet allowed (`internetClient`), matching the Mac. Reach's own listener must be unreachable from the job. Rather than a firewall belt that Reach can't install, **a runtime self-test runs inside the jobs AppContainer before the launch proceeds**: it attempts to reach Reach's listener on every local address — `127.0.0.1`, `::1`, the PC's LAN IP, and its tailnet IP and MagicDNS name (Tailscale Serve would otherwise present the owner node's identity) — and the launch is refused if any is reachable (fail closed). AppContainers are denied loopback by default and Reach adds no loopback exemption for the package SID, so the expected result is "refused"; the self-test turns that from a doc claim into a per-launch check. Whether jobs get a LAN/tailnet capability at all is D-C-3 (default: internet only).
- **Full-control shell:** a normal owner process; the Mac doesn't block it from Reach's port either, so no block is claimed.
- **Pipes (D/H):** any named pipe Reach exposes must be created with an explicit DACL granting only the owner's SID and must not carry `ALL APPLICATION PACKAGES` or `ALL RESTRICTED APPLICATION PACKAGES` — stated here as a requirement on those workstreams.

## 6. The Job Object (findings 6, 7, 8, 10)

For jobs, scripts and the Full-control shell (the Files broker runs one short op and needs none). Assigned atomically at creation via `PROC_THREAD_ATTRIBUTE_JOB_LIST` so there is no unassigned window; the child is launched detached (no console) with only the helper-owned pipe handles.

| Control | Jobs | Scripts | Full shell |
|---|---|---|---|
| Kill-on-job-close | yes | yes | yes |
| Die-on-unhandled-exception | yes | yes | yes |
| Child-process policy | none; fork-bomb process cap only (finding 7) | one process + `CHILD_PROCESS_RESTRICTED` | none |
| Memory / CPU caps | runaway-memory cap only; **no** `JOB_TIME`, or `JOB_TIME ≥ timeoutMs × logical CPUs` (finding 10) | same | **none** (finding 10) |
| UI restrictions (finding 8) | all of: read/write clipboard, handles, desktop, global atoms, system parameters, exit-windows | same | same |
| Kill timing | at deadline/drain | at completion/timeout | **only on abort or timeout** (finding 10) |
| Breakaway | none | none | none |

**Brokered-launch control (finding 8).** The UI restrictions plus the no-breakaway job mean a child cannot reach the clipboard (the Mac denies the pasteboard to scripts and Files, and vault fills use it), a private desktop (D-C-4), or window messages. Every channel by which a sandboxed process could ask another component to start a process outside the job — shell protocol handlers, COM protocol/launch handlers, the scheduler and WMI COM interfaces, the elevation verb, and the Explorer `start` path — is enumerated as a probe item (§9.1) and as a refusal; the e2e assertion is that **no new process appears outside the job**, checked by a process snapshot before and after, verifying parent and session, not by reproducing any launch recipe.

## 7. File I/O boundary (the owner-token broker, §3.4)

Match `browser-files.swift` guarantee-for-guarantee with the NT API, on the owner's token.

### 7.1 Handle-relative traversal
Open the root, then each component, relative to its parent handle, following no reparse point (the `openat(parent, part, O_NOFOLLOW)` analogue). A parent swapped for a junction mid-traversal fails closed — the Mac "racing parent swaps" guarantee (`browser-file-boundary.test.mjs:63`). To avoid the object-manager symlink at the volume root tripping a whole-path no-reparse open (finding 11), the root is opened via its device path, or each component is opened relative to its parent with reparse inspection of the tag.

### 7.2 Verify the opened path (finding 12)
After opening each handle, read its canonical normalized DOS path and assert, case-insensitively, that it is the root or under `root + "\\"`. The private-name/path check runs against that normalized name, never the request string, which defeats 8.3 short names (a request naming a short alias still normalizes to the real private name). The win32 `relative()` branch rejects a `:` in any component (alternate data streams, drive-relative paths), reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`), and trailing dots or spaces; unit tests feed each form and assert refusal.

### 7.3 Identity must match libuv (finding 17)
`browser-file-boundary.mjs` computes `rootDev`/`rootIno` from `fs.lstatSync(root,{bigint:true})`; the helper re-checks them. The helper must compute identity the same way libuv does (volume serial + file index), and the identity test must exercise **both** of libuv's stat paths — the by-handle path and the newer by-name fast path — so the equality check is meaningful. On ReFS the 128-bit file id doesn't fit libuv's `st_ino`; the helper compares the 128-bit `FILE_ID_INFO` on its own side (finding 11), and a Dev Drive is on the real-PC acceptance list (§9.5).

### 7.4 Hard links, reparse points, regular-file check
After open, require the reparse-point attribute absent and the link count equal to one for file ops (the Mac `nlink==1`), and not a directory. Writes/creates open with no-reparse and create-exclusive for new files; `rm` re-stats by handle and by parent-relative name and compares the file id before unlinking (the Mac `fstatat` + id compare).

## 8. Integration points (macOS unchanged)

New file `server/windows-sandbox.mjs` (Windows siblings; no Mac file edited):

- `windowsJobSandbox(config, client, { sockets })` → `{ grants, denies, network, capabilities, limits }`. Wired at `index.mjs:1068-1069` (`win32` branch), consumed at `index.mjs:3014`; the fail-closed refusal at `:3018-3019` stays as backstop. `/api/jobs` POST (`:3004-3024`) computes `grants` from the §4.3 table, not from `config.roots`.
- `server/jobs.mjs`: the win32 `spawn("powershell.exe", …)` becomes `spawnVerified(sandbox helper, …)` driving `mode:"jobs"` and passing the descriptor (today `sandbox` is accepted and ignored on win32); own-device jobs keep `powershell.exe` (finding 17). The win32 gate checks helper availability + the launch self-test. The background/drain logic gets the finding-13 win32 branch.
- `server/agent-shell.mjs`: unchanged. The Windows `run` is injected through an explicit `win32` branch at `index.mjs:1072`, ignoring the Mac env it is passed (finding 17), calling `mode:"shell"` (Job Object, owner token, no AppContainer).
- `server/browser-scripts.mjs`: win32 branches on the darwin gate and `executeBrowserScript`; the executable-resolution block gets a Windows allow-list branch (finding 12); the validation logic above the gate is reused.
- `server/browser-file-boundary.mjs`: add `win32` to the supported platforms (route to the broker), the win32 `relative()` branch (finding 12), and the win32 request shape (§3.4).
- `scripts/native/sandbox.cs` (new): the C# helper, built/launched via A's `windowsBinary`/`spawnVerified` into an `ensurePrivateFolders`-protected directory. `scripts/native/browser-files.swift` unchanged.
- Revocation/change/expiry hooks: `endSession`/`endClient` (`index.mjs:2483-2505`), the `changeAccess` job-cancel (`:2452-2459`), a periodic expiry sweep, and a startup sweep beside `jobs.mjs:11`.
- Dependencies on A/D: `windowsBinary`/`spawnVerified` (D §4.5), `ensurePrivateFolders` (D §4.5), and B §3.4's SAC/event-log classification.

## 9. Test plan

### 9.1 Probe matrix (facts no doc settles)
`sandbox.exe --probe` launches `cmd.exe` and `node.exe` under (a) a regular AppContainer and (b) LPAC, reporting for each: did it start; can it read its granted root; is a non-granted sibling denied; does a console appear under the one-process limit; is Reach's listener refused on every local address and the tailnet name; is an owner-only-DACL pipe refused; does a DENY for the Reach-wide capability SID actually deny a token carrying it (finding 3); and whether any enumerated brokered-launch channel starts a process outside the job (finding 8). Results pin the minimal capability set; the rule is "widen until the probe is green, never past `internetClient` for the no-network surfaces."

### 9.2 Unit tests (any host, injected platform/deps)
`windows-sandbox.test.mjs`, `browser-file-boundary.test.mjs` (win32), `browser-scripts.test.mjs` (win32), `windows-path-validation.test.mjs`, `agent-shell.test.mjs` (win32), and the helper-source C#-level lint, covering the cases named in the §0.1 table — including the grant-set table refusals (findings 1, 2), the deny-set mirror and post-run scan (finding 5), the SDDL masks (finding 6), the forged-frame rejection (finding 13), the concurrent-grant ordering re-check (finding 14), the injected launch-classifier refusal (finding 15), and **"D's code-folder checker still passes after a C grant over a root containing the checkout"** (§0.5). Every win32 branch is gated by an injected or real `process.platform`; the existing Mac tests are the regression set and must stay green (as in D §7.2).

### 9.3 Real-Windows CI
A new `test/windows-sandbox-e2e.test.mjs` and `test/windows-file-boundary-e2e.test.mjs`, gated by `REACH_TEST_WINDOWS_DESKTOP=1` and run as a **standard, non-elevated local user** through D §8's standard-user harness (GitHub's runners are elevated with UAC off, so an admin token would pass escape tests for the wrong reasons — finding 16). Both files are added to `suites.windows` in `.github/scripts/run-tests.mjs` and to the real-Windows step in `.github/workflows/ci.yml` (alongside the existing `windows-desktop-native`/`windows-desktop-e2e` line), and `test/ci-policy.test.mjs` gains assertions requiring them in both lists.

### 9.4 One negative case per finding
The adversary tries to escape and must be refused: write outside the roots and into `appRoot`/`dataDir` (findings 1, 6); read Reach's data and vault (findings 1, 4); no process survives or appears outside the job after a brokered-launch attempt (findings 7, 8), asserted by process snapshot; a hard link or name-surrogate reparse point is skipped, not fatal, and reads through it fail (finding 11); 8.3/ADS/reserved names refused (finding 12); Reach's listener refused on every local address and the tailnet (finding 9); a revoked session's capabilities grant nothing (finding 3); caps bound a runaway (finding 10); in-root `git`/`npm` succeed while a planted `.npmrc`/`.git` swap is reported and fails the run (finding 5).

### 9.5 Real-PC acceptance (phase 5, not CI)
A checklist CI cannot represent: OneDrive Known Folder Move on Desktop/Documents, a pnpm project (hard-link store), a Dev Drive (ReFS), SAC in Evaluation, and Controlled Folder Access on (findings 11, 16). The shared policy corpus (plan rule 4) is exercised by the same decisions test the JS and Swift helpers run (`agent-desktop-policy-native.test.mjs`), with C's sandbox-launch refusals added.

## 10. Parity ledger (for `docs/WINDOWS_AGENT_PARITY.md`)

| Mac behaviour | Windows | Note |
|---|---|---|
| Full-control shell unsandboxed, OS user | Job Object only (kill-on-close, UI restrictions), owner token, **no** AppContainer, **no** caps, killed only on abort/timeout | **Byte-for-byte parity.** Corrects the plan's "sandboxed per C". |
| Jobs: allow-default deny-list, network on | Regular AppContainer, per-root capability ALLOW + DENY carve-outs + loopback/tailnet self-test | **Stronger** on reads; same deny guarantees. Parity *gain*. |
| Jobs read everything but secrets | AppContainer can't read `%TEMP%`, npm cache, user-scope Node managers, `.gitconfig`, Git Bash unless named | **Parity break (D-C-5):** record the profile-read loss, or grant read ACEs for named tool directories. |
| Non-admin device / full guest jobs over Home+drives | Refused: a jobs grant can't be a drive root, Home, or an ancestor of Home | **Parity break (finding 2):** such clients can't run jobs on Windows. |
| Scripts: deny-default, no net, one process | LPAC + one-process Job (`CHILD_PROCESS_RESTRICTED`), no capabilities, grant walk skips links | Parity. |
| Scripts deny `.git`/`.npmrc`… created during the run | Post-run scan reports and fails; same-run create-and-use not blocked mid-run | **Residual (finding 5):** stated. |
| Files helper: kernel-confined, descriptor-relative | Owner-token broker: NT handle-relative, no-reparse, final-path verify, private-name/path, `nlink==1` | Parity; kernel belt replaced by broker code (finding 4). Lowbox impersonation is D-C-2. |
| Full-control Files = whole drive | Owner-token broker, same handle discipline | Effective parity; no drive-root ACE. |
| Nothing left behind (per-process sandbox) | Per-root capability ACEs + ledger; kill-then-revoke, startup + periodic sweeps | **Residual (D-C-7):** a file moved out of a root stays reachable to a live token holding that capability until revoke. |
| — | SAC-On / App Control / AppLocker / ASR / CFA blocking the helper | **Fail closed** by launch self-test with the policy wording; never fall back (finding 15). Signed helper path per plan rule 3 / `docs/CODE_SIGNING.md`. |
| — | ReFS (128-bit file id) | Handled via `FILE_ID_INFO`; on the real-PC checklist (finding 11). |

Dependencies out of C's scope: A's `windowsBinary`/`spawnVerified`, D's `ensurePrivateFolders`, the Windows guard/private-path data set (dataDir, agent policy, `.reach`, agent vault, Startup, both PowerShell profiles, Git Bash rc, `.ssh/authorized_keys`, Credential Manager, browser profiles), and the owner-prompt wording for blocked-helper refusals.

## Decisions for the owner

Each decision names what ships until the owner decides; every default is the fail-closed option.

- **D-C-1 — Full-control shell interpreter.** The plan's workstream table says `pwsh`; plan rule 3 keeps PowerShell out of agent paths (cold starts, language mode). **Default: `cmd.exe`** for both jobs and the Full shell, consistent and free of execution-policy/cold-start issues. The owner may choose `pwsh` for the Full shell (it runs on the owner token, unsandboxed) knowing the cold-start cost.
- **D-C-2 — Files confinement depth.** **Default: owner-token broker only** (finding 4), the shape that works for read-only Home. The owner may later add lowbox-token impersonation on the worker thread as hardening; it is not required for parity.
- **D-C-3 — Jobs network reach.** **Default: internet only** (`internetClient`), with the local/tailnet self-test refusing any reach to Reach itself. The owner may add a LAN/tailnet capability if jobs need local services; this widens the surface the self-test must keep closed against Reach.
- **D-C-4 — Private desktop.** **Default: UI restrictions on the shared desktop** (finding 8), which already deny clipboard, window messages and desktop switching to jobs and scripts. The owner may add a dedicated `CreateDesktop` for jobs and scripts for defence in depth.
- **D-C-5 — Jobs profile reads.** **Default: record the loss** (the AppContainer can't read `%TEMP%`, caches, user-scope Node managers or `.gitconfig`), so ordinary commands that need them fail with a clear reason. The owner may instead grant read ACEs for a named list of tool/profile directories, widening reads beyond the Mac.
- **D-C-6 — Signed-helper fallback.** Shared with B's D1: the SignPath Foundation signing path (plan rule 3, `docs/CODE_SIGNING.md`) is already the owner's decision; until a signed helper is approved, a PC whose policy blocks the local build is refused with the reason. No separate C decision beyond keeping C's helper in that same pipeline.
- **D-C-7 — Moved-file residual.** **Default: accept and document** (finding 3): a file moved out of a granted root stays reachable to a live token holding that root's capability until the session is revoked. The owner may instead require sessions to re-launch (dropping and re-deriving capabilities) on any owner-initiated move, at the cost of interrupting running work.
