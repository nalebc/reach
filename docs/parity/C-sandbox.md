> Status: first draft. Its adversarial review (below, `C-sandbox-review.md`) found blockers; the revision is pending. Don't build from this draft until it's revised.

# Windows sandbox: design

Workstream C of the Windows agent-parity program (`docs/WINDOWS_AGENT_PARITY.md`). Scope: the sandbox for agents' and invited people's commands (`/api/jobs`), browser-preset scripts, the Full-control shell, and the Files preset's protected file helper. Platform target: Windows 10 22H2 and Windows 11 (x64, arm64). Nothing here changes a single byte of macOS behaviour — every new path is `process.platform === "win32"` only, and the Mac functions (`agentShellSandbox`, `shellSandboxProfile`, `scriptProfile`, `fileBoundaryProfile`, `createAgentShell`, `desktopBinary`) are left untouched; Windows gets siblings.

## 0. Rule 0 first: what the Mac code actually does

Parity is measured against the Mac code and its tests, not the plan. Four Mac policies, **not one**:

| Mac surface | File | Mac enforcement | Network | Exec / children |
|---|---|---|---|---|
| **Full-control shell** (`reach_shell`) | `server/agent-shell.mjs:42` | **None.** `/bin/zsh -c`, clean env (`:104-107`), process group, time/output limits. `createAgentShell` takes **no** `sandbox` option; the `sandbox`/`sandboxExec` args `test/agent-shell-sandbox.test.mjs:53-54` pass are **ignored**. `agent-shell-sandbox.test.mjs:65` asserts it *reaches* secrets, sockets and code as the OS user. | Full | Full (as owner) |
| **Jobs** (`/api/jobs`, `reach_run_command`) | `server/jobs.mjs:70`, profile `server/agent-shell.mjs:15`, rules `server/browser-private-paths.mjs:24` | **allow-default deny-list** (`(allow default)` + targeted `deny`): denies Reach's dataDir, `.reach`, agentPolicyFile, keychains, browser profiles, Tailscale containers; write-denies code + launch agents + shell rc; socket-denies Reach's sockets; port-denies Reach's port; `deny appleevent-send`; `deny process-exec /usr/bin/open,/usr/bin/osascript`. | Allowed **except** Reach's port + unix sockets | Allowed except `open`/`osascript` |
| **Browser scripts** (approved restricted-terminal scripts) | `server/browser-scripts.mjs:76` `scriptProfile` | **deny-default allow-list**: root is read-write, system roots read+exec, Node runtime read+exec; one process (`deny process-fork`); no network; `deny file-link`; private-name regex denial; guarded hard-links/special files pinned. | **None** | One process, no fork, no `sudo`/`su`/`sandbox-exec` |
| **Files helper** | `server/browser-file-boundary.mjs:16` `fileBoundaryProfile` + `scripts/native/browser-files.swift` | **deny-default**: `deny process-fork process-exec file-link`; root read (+write if mutating); private-name/path denial. Plus the helper's own descriptor-relative `openat(O_NOFOLLOW)` + `F_GETPATH` verification + `nlink==1` regular-file check. | None | None |

The plan's line "the Full-control shell … sandboxed per C" is **drift**. On Windows the Full-control shell gets a **Job Object only** (clean env, limits, kill-on-close), running as the owner's own token — matching the Mac, where it is deliberately unsandboxed. Everything else gets a real sandbox. This is the load-bearing correction; the rest of the design follows from it.

A second consequence: on the Mac the deny-list (jobs) is expressible because the sandbox starts from "allow all" and subtracts. Windows has no allow-default file sandbox primitive. The Windows jobs sandbox is therefore **stricter than the Mac's**: an allow-list (AppContainer + ACL grants on exactly the shared roots). That is a parity *gain* on reads, and must be written into the plan's "what happens instead" table (see §10). We keep the deny guarantees as an additional belt (DENY ACEs over secrets) so the security property is a superset of the Mac's.

## 1. Mechanism: AppContainer (lowbox) + Job Object

Candidates, against the four policies' needs (confine file reads/writes to the shared roots; deny Reach's data, the agent vault, credentials; a network policy; hard kill + resource caps; block surviving child processes; usable by `cmd`/`powershell`/`node`):

| Mechanism | Verdict |
|---|---|
| **Restricted token** (`CreateRestrictedToken`, `SAFER`) | Rejected as the primary boundary. A restricted/low-integrity token stays a normal user principal: it can still `OpenProcess(PROCESS_VM_READ)` Reach's own `node.exe` and read in-memory secrets, and can `SendInput`/clipboard into the owner's windows. Deny-only SIDs + a restricting-SID set can express a deny-list but not the "reads limited to the shared roots" allow-list, and integrity stays medium. Kept only as a hardening layer *inside* the AppContainer where useful. |
| **Windows Sandbox** (`.wsb`) | Rejected. Requires Pro/Enterprise + nested virtualization, is a throwaway VM with its own filesystem (no handle-relative view of the owner's real folders), cold-starts in seconds, and can't share one folder with host ACL semantics. Wrong tool for "run one command against this folder." |
| **AppContainer (lowbox)** | **Chosen.** Low integrity label + a unique **package SID** and capability SIDs. Access to a securable object is the **intersection** of the user/group grant and the AppContainer (package/capability) grant — "AppContainers must be explicitly granted access to a given resource" and "the permitted access is the intersection" ([Launch an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)). So the sandbox reaches a folder only if we add an ACE for its package SID *and* the owner already has access. Isolated from other processes, windows, devices, the network (without the `internetClient` capability) and credentials — exactly the properties the Mac denies. |
| **LPAC** (Less-Privileged AppContainer) | **Chosen for the no-network policies** (scripts, Files helper) and used for jobs/shell-sandbox too. LPAC "cannot open any keys in the registry unless it has the `registryRead` capability and cannot use COM unless it has the `lpacCom` capability" and needs explicit capabilities even for what a regular AppContainer gets for free ([same page](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)). Opt in with `PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT`. We grant explicit named capabilities (`lpacCom`, `registryRead`, `lpacAppExperience`, `lpacInstrumentation`) only as the probe matrix (§9) proves `cmd`/`node` need them to start — fail closed and widen minimally, never to `internetClient` for the no-network policies. |

**Why both AppContainer and a Job Object:** the AppContainer is the *access* boundary (what files/registry/network the process may touch); the Job Object is the *lifecycle and resource* boundary (kill-on-close, process/memory/CPU caps, no breakaway). They are orthogonal and both required.

## 2. The helper: `sandbox.exe`, a C# host

### 2.1 Delivery — compile on the PC with `csc.exe`, same model as Swift on the Mac

The Mac compiles each Swift helper on first use (`server/desktop-native.mjs:12`, `server/native-build.mjs`), caches it by source-hash, prunes older builds. Windows mirrors this exactly, with **workstream A's `windowsBinary(config, kind)`** (which does not exist yet — this design *specifies the interface C needs from A*, it does not add a second build path):

- Compiler: `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, present on every Windows 10/11 (.NET Framework 4.8). **No PowerShell** in the build or run path (plan rule 3: execution policy, cold starts). No downloaded binaries.
- **C# language level: `csc.exe` ships the C# 5 compiler.** No `$"interpolation"`, no `?.`, no expression-bodied members, no `nameof`. The helper source is written to that level. A unit test (`windows-sandbox-helper.test.mjs`) greps the `.cs` source for forbidden constructs so a future edit can't silently require Roslyn.
- Output: `windowsBinary` writes `reach-sandbox-<sha12>.exe` into `config.dataDir`, hashing the `.cs` source exactly as `desktopBinary` hashes the `.swift`. `csc /nologo /optimize+ /platform:anycpu /out:<tmp> sandbox.cs`, then atomic rename, then prune — the `buildNative` contract.
- **Smart App Control / WDAC / signing.** `csc.exe` itself is **not** on Microsoft's App Control recommended block list (verified: the list includes `csi.exe`, `rcsi.exe`, `msbuild.exe`, `aspnet_compiler.exe`, `Microsoft.Workflow.Compiler.exe` — but **not** `csc.exe`) ([Microsoft recommended block rules](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/applications-that-can-bypass-appcontrol)). But a freshly compiled, unsigned `.exe` is exactly what **Smart App Control** blocks in enforcement mode: "Malware, Potentially Unwanted Apps (PUA), and unknown, unsigned code are blocked by default" ([Smart App Control](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview)). So:
  - **Detect SAC before building.** Read `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy` → `VerifiedAndReputablePolicyState` (0 = Off, 1 = Enforce, 2 = Evaluation) ([App Control overview](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/appcontrol)). On `1` (Enforce), **fail closed**: refuse the preset at invitation time with a worded reason ("This PC's Smart App Control blocks Reach's unsigned sandbox helper; turn it off for this account or sign the helper"), never attempt to run an unsigned exe that SAC will kill mid-flight. On `2` (Evaluation) we may build but surface a one-line warning via the owner prompt, because SAC can flip to Enforce.
  - WDAC/AppLocker that an administrator set is out of our control (plan rule 2). If `csc.exe` fails or the produced exe won't launch, map the failure through a `scriptBlocked`-style classifier (reuse `server/powershell.mjs` `SCRIPT_BLOCKED` wording) and refuse with the reason. Never retry, never fall back to an interpreter.
  - Future (workstream A/5): sign the helper with the project's cert so SAC-Enforce PCs work. Out of scope for C; C only has to detect and fail closed.

### 2.2 Why a C# helper and not Node directly

Node can't call `CreateAppContainerProfile`, `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES)`, `NtCreateFile(RootDirectory=…)`, or set DACLs with correct ACE ordering. The helper is the Windows analogue of `browser-files.swift`, extended to also be the *launcher* for the other three surfaces (the Swift side launches nothing — on the Mac, `sandbox-exec` is the launcher; on Windows the launcher is privileged code, so it lives in the helper). One `.cs`, several verbs.

### 2.3 Protocol — Node ⇄ `sandbox.exe`

One helper process per operation (file op, or one command/script/shell run). JSON on stdin, structured result frames out. Mirrors `browser-file-boundary.mjs:67-88`.

**Request (Node → helper stdin, one JSON object, ≤2 MiB):**

```
{ "verb": "file" | "run",
  "op": "read|list|stat|mkdir|touch|rm|cp|write",     // verb=file
  "root": "C:\\Users\\me\\proj", "rootVolume":"…","rootIndex":"…",  // libuv dev/ino, see §7.3
  "path": "sub\\a.txt", "to": "...", "data": "<base64>", "maxBytes": 1048576,
  "privatePaths": ["…"], "privateNames": [".reach","…"], "fullControl": false,

  "mode": "jobs|script|shell",                          // verb=run
  "exe": "C:\\…\\cmd.exe", "argsEncoded": "<base64 UTF-16LE>",  // see §3.1
  "cwd": "C:\\Users\\me\\proj",
  "grants": [ {"root":"C:\\…\\proj","access":"rw"} ],   // folders to ACE for the package SID
  "denies": ["C:\\…\\.reach","C:\\…\\.reach-agent", "…"],// explicit DENY ACEs (secrets)
  "network": false,
  "limits": { "timeoutMs": 60000, "memBytes": 1073741824, "cpuMs": 55000, "activeProcs": 1 },
  "packageMoniker": "reach.sbx.<clientId-hash>" }
```

**Control/result frames (helper → Node):** newline-delimited JSON on **stderr** (so a child's stdout stays a clean byte stream — see §3.2):

```
{"t":"started","pid":1234}
{"t":"error","status":403,"message":"…"}         // worded, bounded to 300 chars
{"t":"exit","code":0,"signal":null,"timedOut":false}
{"t":"result", …}                                 // verb=file payload (base64 data etc.)
```

- **stdin EOF is the kill lifeline.** The helper holds the job handle; if the parent dies, its stdin pipe closes, the helper tears down (closes the last job handle → `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates everything). This is the Windows analogue of the Mac helper's "release on EOF" (`server/desktop-native.mjs:67`).
- Timeouts, output caps and the per-op `check()` revalidation stay in the **Node** layer, unchanged from `browser-file-boundary.mjs:71-88` and `jobs.mjs:82-88` — the helper never decides authorization lifetime.
- Use `/EncodedCommand`-style encoding for all argument passing (`argsEncoded` is base64 of a UTF-16LE command tail, or a pre-split `argv` array the helper hands to `CreateProcessW` as a built `lpCommandLine`). No shell string is ever concatenated.

## 3. The four surfaces on Windows

### 3.1 Jobs — `/api/jobs` (`server/jobs.mjs`, `server/index.mjs:3004`)

Today `jobs.mjs:62-68` spawns `powershell.exe -Command command` **unsandboxed** on win32 and ignores the `sandbox` arg; it is saved from running only because `index.mjs:3018-3019` refuses when `!own && !sandbox` and `jobSandbox()` returns `null` off darwin (`index.mjs:1069`). New design:

- Add a Windows sibling `windowsJobSandbox(config, client, { sockets })` in a new `server/windows-sandbox.mjs` (Mac `agentShellSandbox` untouched). It returns `{ grants, denies, network, packageMoniker, limits }`, **not** a sandbox-exec profile string. `index.mjs:1068-1069` becomes: `darwin → agentShellSandbox`, `win32 → windowsJobSandbox`, else `null`. The fail-closed refusal at `:3018` stays as the backstop for any third platform.
- **`/api/jobs` must pass the client's roots, not just `cwd`.** Today `index.mjs:3004-3021` resolves one `cwd` and passes `{...req.body, cwd}`. An allow-list sandbox needs every shared root to ACE. Extend the POST handler to compute `grants` from `req.client.agentRoots` (for agents) or `config.roots` (devices) intersected with the resolved `cwd`, validated through the existing `validateBrowserRoot`/`resolve`. `denies` = the Windows private-path set (§4.2).
- **The command interpreter.** The Mac runs `$SHELL -lc command`. Parity for a free-form command string on Windows is `cmd.exe /d /s /c` (not PowerShell: execution policy + cold start, plan rule 3; and `reach_run_command`'s contract is "a shell command"). The helper launches `cmd.exe` **inside** the AppContainer + Job Object. `cmd.exe` runs in an AppContainer (proven by the §9 probe matrix). Network: **allowed except Reach's port and sockets** to match the Mac — so jobs get the `internetClient` + `privateNetworkClientServer` capabilities, and Reach's own port/pipe are blocked by a WFP/firewall rule scoped to the package SID (§5). Deny-equivalents for Apple Events / `open` / `osascript`: on Windows the analogues are spawning survivor processes and launching UI/credential surfaces — covered by `activeProcs=1` + `CHILD_PROCESS_RESTRICTED` + the guard data (workstream A).
- **Kill.** `jobs.mjs:131-146` already uses `taskkill /PID /T /F` on win32; with the Job Object the helper's `KILL_ON_JOB_CLOSE` is the real reaper and `taskkill` becomes a belt. `this.running` / status bookkeeping is unchanged.
- **Backgrounding semantics differ — state it.** On the Mac a backgrounded process (`cmd &`) outlives the shell until the deadline (`jobs.test.mjs:25`). With `KILL_ON_JOB_CLOSE`, when `cmd.exe` exits the helper can either (a) close the job immediately (kills survivors) or (b) hold the job open until the Node-side `timeoutMs`. **Decision: (b)** — hold the job until the command completes *and* its output drains or the deadline fires, matching the Mac's `child.on("exit")` grace + `close` model (`jobs.mjs:117-128`). The helper reports the main process's exit code in the `exit` frame; survivors are reaped at job close (deadline or drain). The Windows `jobs.test.mjs` cases currently `skip` on win32 (`:25,:35,:43`) get Windows analogues under `as-windows` + a stub helper (§9).

### 3.2 Full-control shell (`server/agent-shell.mjs`)

Mac: unsandboxed `/bin/zsh`. Windows parity: **Job Object only, as the owner's token, no AppContainer**.

- Add a `run` override path: `createAgentShell` already accepts `run` (`agent-shell.mjs:34`, used by tests and `index.mjs:1072` via `overrides.agentShellRun`). The Windows production `run` launches `cmd.exe /d /s /c <command>` through `sandbox.exe` with `mode:"shell"`: **no** `SECURITY_CAPABILITIES` (so a normal medium-IL process as the owner), but **inside a Job Object** with `KILL_ON_JOB_CLOSE | DIE_ON_UNHANDLED_EXCEPTION | ACTIVE_PROCESS` and process/job memory + per-job CPU-time caps. Clean environment built on the Windows side (the analogue of `agent-shell.mjs:104-107`: `SystemRoot`, `PATH`, `USERPROFILE`, `TEMP`/`TMP`, `COMSPEC`, `REACH_AGENT=1` — and strip every `REACH_*` as the Mac env already omits them).
- The revocation watchdog (`agent-shell.mjs:81-116`, 50 ms `check()`) and output/time limits are **unchanged** — they live in JS and already drive the `run` abort via `AbortController`; on abort the helper gets stdin-EOF and the Job Object kills the tree.
- Helper reaping: the process-group kill `agent-shell.mjs:52` (`process.kill(-pid)`) has no Windows meaning; the Windows `run` closes the helper's stdin and the Job Object does the reaping. `agent-shell.mjs` stays Mac-shaped; the Windows behaviour is entirely in the injected `run`. **No edit to the zsh path.**

### 3.3 Browser scripts (`server/browser-scripts.mjs`)

Mac: deny-default, root rw, no network, one process, no links, guarded hard-links/special files. Windows parity = the **strictest** configuration: **LPAC AppContainer** (no capabilities at all beyond what the probe proves the interpreter needs to start) + Job Object with `ActiveProcessLimit = 1` and `PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED` ("The process being created is not allowed to create child processes … only effective in sandboxed applications (such as AppContainer)" — [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)); **no network capability** and a WFP block over the package SID as defence-in-depth; grants = the one root rw; denies = private paths.

- `validateBrowserScript` (`browser-scripts.mjs:53`) hard-refuses off darwin at `:54` (`!fs.existsSync('/usr/bin/sandbox-exec')`). The Windows build replaces that line's gate with a platform switch: darwin keeps the sandbox-exec check; win32 checks `windowsBinary` availability + SAC state; else refuse. The **validation logic above it is platform-neutral and stays** (program allow-listing, `rejectOutsidePaths`, `rejectProtectedProgram`, root/private checks) — crucial, because it already blocks `reach`/`tailscale`, `..`, `~`, and out-of-root path args, and those tests (`browser-scripts.test.mjs:58,111,120`) are the parity spec.
- **Program resolution** is POSIX today (`browser-scripts.mjs:66-72`: `/usr/bin`, `/bin`, `realpathSync`). Windows needs an analogue: resolve `node` to the real `process.execPath`, resolve a bare program against a **fixed system allow-list** (`%WINDIR%\System32\{where.exe is not it}` — enumerate a small allow-set: `cmd.exe`, `findstr.exe`, `where.exe`, plus a script inside the root), or a `.js`/script inside the root. **Refuse `.bat`/`.cmd` as the program** (BatBadBut / CVE-2024-27980: `cmd.exe` argument parsing can't be safely escaped) and refuse `.ps1`. Pass an absolute `lpApplicationName` to `CreateProcessW`, never a search path. This is a *new Windows branch* in the executable-resolution block; the Mac branch is untouched.
- **`guardedFiles` / hard-links / special files** (`browser-scripts.mjs:125-162`): on the Mac this pre-scan finds `nlink>1` files and FIFOs/sockets and pins their directories. On Windows the equivalent is done in the **helper's grant walk** (§4.1) — the ACL walk skips `NumberOfLinks>1` and reparse points, so a hard-linked outside file never gets the package-SID ACE in the first place. The JS `guardedFiles` stays Mac-only; the Windows design moves the guarantee into the grant step (and tests it, §9).
- `scriptProfile` (the sandbox-exec string, `:76`) is Mac-only and unused on Windows; `executeBrowserScript` (`:168`) gets a win32 branch that calls `sandbox.exe` with `mode:"script"` instead of `spawn('/usr/bin/sandbox-exec', …)`. Env is the already-minimal `browser-scripts.mjs:184` set, Windows-adjusted.

### 3.4 Files helper (`server/browser-file-boundary.mjs` + `scripts/native/browser-files.swift` → `sandbox.exe verb=file`)

Mac: a confined helper doing descriptor-relative `openat(O_NOFOLLOW)`, `F_GETPATH` verification, `nlink==1`. Windows: the same discipline with the NT API, **inside an LPAC AppContainer** (so even a helper bug can't escape the lowbox), with ACEs granting the package SID exactly the one root.

- `browser-file-boundary.mjs` is **already mostly platform-neutral** and built for this: it validates the request in JS, builds `request`, and either calls an injected `run` or spawns a native `binary` (`:69-88`). The non-darwin fail-closed at `:54` (`process.platform !== 'darwin' && typeof run !== 'function'`) becomes `!== 'darwin' && !== 'win32' && …`. The `binary` is `windowsBinary(config,'sandbox')` on win32 (vs `desktopBinary(config,'browser-files')` on darwin). The whole JS contract — op allow-list (`:13`), base64 validation, concurrency bounds (`:43`), `check()` revalidation after close (`:84`, `test:80`) — is reused verbatim.
- The `request.sandbox` field (a sandbox-exec profile) is Mac-specific; on Windows the helper ignores it and uses `grants`/`denies` instead. Keep sending it (harmless) or gate it — cleaner to add `request.grants`/`request.denies` and have the Swift helper ignore those. Either way **no Mac behaviour changes**.
- Full-control Files (`fullControl:true`, `browser-file-boundary.mjs:41,60`) grants the whole drive on the Mac. On Windows a drive-root package-SID ACE is impractical and dangerous; §7.5 covers the honest parity gap.

See §7 for the I/O boundary mechanics — this is the hardest part.

## 4. ACE granting and cleanup (shared infrastructure)

This is the design's main risk (the Mac has no analogue — `sandbox-exec` confines the *process's* view; Windows confines by putting ACEs on the *objects*). Lives in the helper, driven by a **grant ledger** in `config.dataDir`.

### 4.1 The grant walk — handle-based, never tree-propagation

- **Do not use `SetNamedSecurityInfo` with `SE_DACL_AUTO_INHERITED`/tree propagation.** ACLs live on the file object, not the path. If the granted root contains a **hard link** to a file outside the root, blind tree propagation rewrites the *outside* file's DACL — a boundary breach. Microsoft's low-level file security functions (`SetFileSecurity`) "use character strings to identify the securable object" and set the DACL on that one object with no propagation ([Low-level Security Descriptor Functions](https://learn.microsoft.com/en-us/windows/win32/secauthz/low-level-security-descriptor-functions)); that is the primitive we want, applied by our own walk.
- **Walk the tree ourselves, by handle**, the Windows analogue of `guardedFiles`:
  1. Open the root with `NtCreateFile(OBJ_DONT_REPARSE)` (§7.1).
  2. Depth-first with handle-relative opens (RootDirectory-relative, `OBJ_DONT_REPARSE`), so a symlink/junction swapped in mid-walk yields `STATUS_REPARSE_POINT_ENCOUNTERED` and aborts the whole grant (fail closed — the Mac's `scanFailed()` behaviour, `browser-scripts.mjs:120`).
  3. For each file, `GetFileInformationByHandle`: **skip (do not ACE, and refuse the grant) any entry with `nNumberOfLinks > 1`** (hard link — could alias outside) and any reparse point. This is `guardedFiles`'s `nlink>1` rule (`browser-scripts.mjs:149`) moved to the grant.
  4. Add a single **ALLOW** ACE for the package SID (`GENERIC_READ` or `GENERIC_READ|GENERIC_WRITE`) to each object's existing DACL via `GetKernelObjectSecurity`/`SetKernelObjectSecurity` on the handle — preserving existing ACEs, inserting with correct canonical ordering (deny-before-allow).
- **Carve out secrets with inheritable DENY ACEs** placed first in canonical order: an explicit `DENY` for the package SID on each private path that falls inside a granted root (dataDir, agentPolicyFile, `.reach`, the agent vault `~/.reach-agent`, Startup folder, PowerShell profiles under `Documents\WindowsPowerShell` and `Documents\PowerShell`, `.ssh`, and the existing `browserPrivateNames`). A unit test asserts canonical ACE ordering (DENY before ALLOW) so a reorder can't silently grant.
- **Preflight `AccessCheck`.** Before running anything, build the real lowbox token (`CreateProcessAsUser`-style via the package SID) and `AccessCheck` it against every path on the `denies` list. If **any** secret is reachable, abort and refuse with the reason. This is the Windows analogue of the Mac test `agent-shell-sandbox.test.mjs` asserting secrets are denied — but enforced at runtime, fail-closed.

### 4.2 Scope of a grant: per **session**, not per command

- Tree propagation over `node_modules` takes seconds-to-minutes; per-command grants are impractical. Grant **per agent session** against a **stable package SID** derived from the moniker `reach.sbx.<hash(clientId)>` (`DeriveAppContainerSidFromAppContainerName` for an existing profile; `CreateAppContainerProfile` on first use — [Launch an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer)).
- **Grant ledger** `<dataDir>\windows-sandbox\grants.json` (atomic write, `atomicJson`): `{ packageSid, clientId, roots:[…], access, grantedAt }`. Serialize grant/revoke **per root** with a lock file so two concurrent sessions can't race the same tree.
- **Cleanup:**
  - On session **expiry or revocation** (`auth.revoke`, `server/core.mjs:2092`; the `check()` watchdogs already detect it): sweep the ledger, remove the package-SID ACEs from every granted object (same handle-walk, removing the ACE), delete the AppContainer profile (`DeleteAppContainerProfile`).
  - On **startup**: `Jobs` already resets orphaned `running` jobs to `interrupted` (`jobs.mjs:11-14`); add a ledger sweep that revokes every grant whose client is no longer in `auth.list()` or is expired. This is the Windows analogue of the Mac's statelessness (the Mac leaves nothing behind because the sandbox is per-process).
  - **Known residue, stated honestly:** a file the owner *moves out* of a granted root keeps its inherited package-SID ACE (the Mac helper's "directory moved outside the share" test, `browser-file-boundary.test.mjs:85`, has no Windows equivalent for already-applied ACEs). Mitigation: grants are read-only by default and the DENY carve-outs don't move; the package SID is unique per client and deleted on revoke, so a stray ALLOW ACE references a SID that no longer resolves to a live token. The CI escape test (§9) moves a granted file out and confirms a *revoked* session's package SID can't use the residual ACE. Documented in §10.

## 5. Network policy

- **Scripts, Files helper:** no network. LPAC with no `internetClient`/`internetClientServer`/`privateNetworkClientServer` capability → the AppContainer cannot reach the network at all (the Mac scripts' `deny network` and the Files helper's deny-default). Belt: a WFP/firewall block rule scoped to the package SID.
- **Jobs, Full-control shell:** network allowed (Mac jobs allow network; Full control is unsandboxed). Jobs get `internetClient` + `privateNetworkClientServer`; the shell is a normal owner process. **But both must be blocked from Reach's own port and private pipe** (the Mac denies Reach's port + unix sockets, `browser-private-paths.mjs:40-41`). Mechanism:
  - **Loopback.** AppContainers are **denied loopback by default** — "Network communications using an IP loopback address cannot be used for interprocess communication (between two different apps)" ([How to enable loopback / troubleshoot network isolation](https://learn.microsoft.com/nl-nl/previous-versions/windows/apps/hh780593(v=win.10))). Reach listens on `config.host:config.port` and a named pipe (the Windows analogue of the unix socket). **We simply never add a loopback exemption for the jobs package SID.** So a job *cannot* reach Reach on `127.0.0.1` even though it has `internetClient` (which governs outbound non-loopback). This is stronger than the Mac's explicit port-deny and requires no WFP rule for the loopback case. Verified behaviour, confirmed by the §9 probe (do not rely on docs alone — `CheckNetIsolation.exe LoopbackExempt` state varies per machine).
  - **Reach's named pipe** (Tailscale/permission-prompt analogue): the pipe's DACL denies the package SID; AppContainers are isolated from credentials and other apps' objects by default, and an un-exempted AppContainer has no loopback. Belt: name the pipe with a DACL that grants only the owner's SID.
- **Tailscale.** Jobs must not reach `tailscaled`'s local API (the Mac socket-denies it). Tailscale on Windows exposes a local named pipe / localhost port; same loopback-denial + DACL applies. Proven by the §9 probe ("Tailscale's named pipe and Reach's port are refused").

## 6. The Job Object

For jobs, scripts, and the Full-control shell (not the Files helper, which runs one short-lived op). `CreateJobObject` → `SetInformationJobObject(JobObjectExtendedLimitInformation)` with `JOBOBJECT_EXTENDED_LIMIT_INFORMATION.BasicLimitInformation.LimitFlags` ([JOBOBJECT_BASIC_LIMIT_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)):

| Flag | Purpose |
|---|---|
| `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` (0x2000) | "all processes associated with the job terminate when the last handle to the job is closed" — the stdin-EOF / parent-death reaper. |
| `JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION` (0x400) | no WER dialog box stalling a sandboxed crash. |
| `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` (0x8) + `ActiveProcessLimit` | `1` for scripts (one process, like the Mac `deny process-fork`); a small N (e.g. 32) for jobs/shell to allow normal child processes while capping fork bombs. |
| `JOB_OBJECT_LIMIT_PROCESS_MEMORY` (0x100) + `JOB_OBJECT_LIMIT_JOB_MEMORY` (0x200) | per-process and job-wide commit caps (e.g. 1 GiB) — the runaway-memory guardrail the repo cares about. |
| `JOB_OBJECT_LIMIT_JOB_TIME` (0x4) + `PerJobUserTimeLimit` | CPU-time ceiling as a belt under the Node `timeoutMs`. |
| **No** `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, **no** `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` | so no child can detach from the job (the Mac detached-process concern, `browser-scripts.mjs:87-89`). |

- **Assign atomically at creation** via `PROC_THREAD_ATTRIBUTE_JOB_LIST` (Windows 10+, [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)) so there is no unassigned window between `CreateProcess` (suspended) and `AssignProcessToJobObject`.
- **conhost / `ActiveProcessLimit=1`.** A console child can spawn `conhost.exe`, which would count against a limit of 1 and kill the job. **Launch with `DETACHED_PROCESS` (no console) and redirected pipe handles**, and prove with the §9 probe that `cmd`/`node` start without a console under the limit. If the probe shows conhost is unavoidable, raise the script limit to 2 and add a `CHILD_PROCESS_RESTRICTED` belt instead.
- **Handle inheritance.** Pass only the three std pipe handles via `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` with `bInheritHandles=TRUE` — no stray inheritable handle leaks Reach's state into the sandbox ([UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)).

## 7. File I/O boundary (the Files helper, §3.4 mechanics)

Match `browser-files.swift` guarantee-for-guarantee with the NT API.

### 7.1 Handle-relative traversal
- Open the root: `NtCreateFile` with `RootDirectory=NULL`, full path, `OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE`, `FILE_DIRECTORY_FILE`, `FILE_OPEN`. `OBJ_DONT_REPARSE`: "no reparse points will be followed … If any reparses are encountered the attempt will fail and return STATUS_REPARSE_POINT_ENCOUNTERED … used to determine if there are any reparse points in the object's path, in security scenarios" ([_OBJECT_ATTRIBUTES](https://learn.microsoft.com/en-us/windows/win32/api/ntdef/ns-ntdef-_object_attributes)). This is the Windows `O_NOFOLLOW` + the Mac helper's symlink rejection (`browser-files.swift:54-55`).
- Each subsequent component: `NtCreateFile` with `RootDirectory = <parent handle>`, `ObjectName = <single component>`, `OBJ_DONT_REPARSE | OBJ_CASE_INSENSITIVE` — the exact analogue of `openat(parent, part, O_NOFOLLOW)` (`browser-files.swift:55,75`). A parent swapped for a junction mid-traversal fails closed (the Mac "racing parent swaps" test, `browser-file-boundary.test.mjs:63`).

### 7.2 Verify the opened path — defeat 8.3 short names and ADS
- After opening each handle, read its canonical name with `GetFinalPathNameByHandle(FILE_NAME_NORMALIZED | VOLUME_NAME_DOS)` (the `F_GETPATH` analogue, `browser-files.swift:33,66`) and assert it is the root or under `root + "\\"`, **case-insensitively**. `protect()`'s private-name/path check (`browser-files.swift:61-64`) runs against the **normalized** name from the handle, **never the request string** — this is what defeats **8.3 short names** (`SSH~1` opening `.ssh`): the request may say `SSH~1` but the final path normalizes to `.ssh` and the private-name check fires.
- **Reject the `relative()` `:` hole.** `browser-file-boundary.mjs:14` `relative()` currently allows `:`, which on Windows opens an **alternate data stream** (`file.txt:hidden`) or a drive-relative path (`C:foo`). The Windows path validator must reject any `:` in a component (and any component that is a reserved device name `CON/PRN/AUX/NUL/COM1…/LPT1…`, and trailing dots/spaces). This is a JS-side fix in a **win32 branch** of `relative()`; the Mac branch (which correctly treats `:` as an ordinary char) is unchanged. A unit test feeds `safe.txt:evil`, `C:evil`, `a\\..\\b`, `CON`, `a ` (trailing space) and asserts 400.

### 7.3 dev/ino identity must match libuv exactly
`browser-file-boundary.mjs:56-58` computes `rootDev`/`rootIno` from `fs.lstatSync(root, {bigint:true})` and the helper re-checks them (`browser-files.swift:48,58`). libuv's Windows `fs.lstat` fills `st_dev` from `GetFileInformationByHandle().dwVolumeSerialNumber` and `st_ino` from `nFileIndexHigh/Low` (libuv `src/win/fs.c` `fs__stat_handle` / `fs__filetime_to_timet`). The helper must compute its identity the **same way** — `GetFileInformationByHandle` volume serial + file index — or the equality check at `browser-files.swift:58`'s analogue is meaningless. **Marked: proven by test `windows-file-boundary.test.mjs` "helper dev/ino equals node fs.lstat"** (compares the helper's reported ids against `fs.lstatSync(root,{bigint:true})` for the same handle). On ReFS the 128-bit file id doesn't fit libuv's `st_ino`; detect and refuse ReFS roots with a worded reason (fail closed) until a 128-bit path is designed.

### 7.4 Hard links, reparse points, regular-file check
- `isRegular` on the Mac is `S_IFREG && st_nlink == 1` (`browser-files.swift:26`). Windows: after open, `GetFileInformationByHandle` → require `FILE_ATTRIBUTE_REPARSE_POINT` **absent** and `nNumberOfLinks == 1` (reject hard-linked files — the Mac `nlink==1`), and not a directory for file ops. A hard link to an outside file is refused exactly as `browser-files.swift:91` refuses it.
- Writes/creates: `FILE_OPEN` (no create-follows-link), `FILE_CREATE` for new (`O_EXCL` analogue), `OBJ_DONT_REPARSE`. `rm` re-stats by handle + by parent-relative name and compares file id before `unlink` (the Mac `fstatat` + dev/ino compare, `browser-files.swift:169`).

### 7.5 Full-control drive root — honest gap
The Mac Full-control Files grants `/` (`browser-file-boundary.mjs:49`, `browser-files.swift:48`). An AppContainer package-SID ACE on `C:\` is both impractical (whole-volume propagation) and unsafe. **Parity decision:** Full-control Files on Windows runs the helper **without an AppContainer**, as the owner's own medium-IL token (like the Full-control *shell*, §3.2) — the owner has explicitly granted total access, and the helper's handle-relative/no-reparse/no-hardlink discipline still applies for integrity. This matches the Mac's effective behaviour (Full control = OS-user access) and is recorded in §10. Non-Full presets always use the AppContainer + per-root ACEs.

## 8. Integration points (exact)

New file `server/windows-sandbox.mjs` (Windows siblings; no Mac file edited):
- `windowsJobSandbox(config, client, {sockets})` → grant/deny/limit descriptor. Wired at **`server/index.mjs:1068-1069`** (`win32` branch) and consumed at **`server/index.mjs:3014`**; the fail-closed refusal **`server/index.mjs:3018-3019`** stays as backstop.
- `/api/jobs` POST **`server/index.mjs:3004-3024`**: add `grants` from `req.client.agentRoots`/`config.roots` (today only `cwd` is passed, `:3005`).
- `server/jobs.mjs:62-79`: replace the win32 `spawn("powershell.exe", …)` with `spawn(windowsBinary, …)` driving `sandbox.exe mode:"jobs"`; pass the sandbox descriptor (today `sandbox` is accepted at `:32` and **ignored** on win32). `jobs.mjs:33` `sandboxExec` existence check → win32 checks `windowsBinary` + SAC state.
- `server/agent-shell.mjs`: **unchanged**. Windows behaviour injected via `overrides.agentShellRun` at **`server/index.mjs:1072`** → a `run` that calls `sandbox.exe mode:"shell"` (Job Object, owner token, no AppContainer).
- `server/browser-scripts.mjs:54` gate and `:168 executeBrowserScript`: add win32 branches (helper launch); `:66-72` executable resolution gets a Windows allow-list branch; `validateBrowserScript` logic above `:54` reused unchanged.
- `server/browser-file-boundary.mjs:54,69`: add `win32` to the supported platforms; `binary = windowsBinary(config,'sandbox')`; add `request.grants/denies`; win32 branch of `relative()` (`:14`) to reject `:`/reserved names.
- `scripts/native/sandbox.cs` (new): the C# helper. `scripts/native/browser-files.swift` unchanged.
- Workstream A dependency: `windowsBinary(config, kind)` in (or beside) `server/desktop-native.mjs` — the csc.exe build+cache+prune analogue of `desktopBinary`. C depends on A; C does not add a second build path.
- Revocation sweep hooks: ledger cleanup called from the same place `auth.revoke` fires (`server/core.mjs:2092`) and at `Jobs` construction (`server/jobs.mjs:11`) startup.

## 9. Test plan

**Probe matrix — the first CI job, facts no doc settles.** `sandbox.exe --probe` launches `cmd.exe`, `powershell.exe` (5.1), and `node.exe` under (a) regular AppContainer and (b) LPAC, reporting for each: did it start; can it read its granted root; is a non-granted sibling denied; does a console appear under `ActiveProcessLimit=1`; is loopback to a test listener on `127.0.0.1:<port>` refused; is a named pipe with an owner-only DACL refused; can it create a hard link to a file it can't write; does disabling the Base Filtering Engine change network isolation. `pwsh` (7) is tested **only if present** (not on stock Windows). Results pin the minimal capability set and the console strategy; the design's capability list is "widen until the probe is green, never past `internetClient` for no-network policies."

**Unit (host Mac/Linux, `test/helpers/as-windows.mjs` + injected deps), no real Windows needed:**
- `jobs.mjs` win32 branch builds the right helper argv and sandbox descriptor; `sandbox`/`grants` are passed (regression against today's ignored-arg); background + timeout + kill cases ported from `jobs.test.mjs:25,35,43` (skipped on win32 today) using a stub helper that emits the frame protocol.
- `browser-file-boundary.mjs` win32: `relative()` rejects `:`, `C:evil`, reserved names, trailing dot/space; the non-darwin fail-closed path now routes to the helper rather than 503; Full-control vs preset grant/deny sets built correctly; `check()`-after-close still rejects (`browser-file-boundary.test.mjs:80` analogue).
- `browser-scripts.mjs` win32: `validateBrowserScript` still blocks `..`/`~`/out-of-root args, `reach`/`tailscale`, `.bat`/`.cmd`/`.ps1` programs; SAC-Enforce → refuse with reason; executable resolution against the Windows allow-list.
- `windows-sandbox.mjs`: ACE canonical ordering (DENY before ALLOW); ledger grant/revoke/startup-sweep; SAC registry read (0/1/2 → run/refuse/warn) with an injected registry reader.
- Helper source lint: `.cs` contains no C#-6+ construct (so csc.exe can compile it).

**Real-Windows CI (`windows-2025` lane, under Restricted script policy; `test/windows-sandbox-e2e.test.mjs`) — the adversary tries to escape and must be refused:**
1. **Write outside the folders.** A sandboxed job/script writes to `%USERPROFILE%\escape.txt`, to a sibling of the granted root, and to `C:\Windows\Temp` → all denied; files absent afterward.
2. **Read Reach's data.** Read `<dataDir>\clients.json`, `agent-policy.json`, and the agent vault `~\.reach-agent\*` → denied (DENY ACE + preflight `AccessCheck` refuses to even launch if reachable).
3. **Survive the close.** Spawn `start /b ping -t`, a `schtasks /create`, a `wmic process call create`, and a WMI/COM `Win32_Process.Create` → the first is reaped at job close; the process-creation escapes are refused (`CHILD_PROCESS_RESTRICTED` + guard data) and no process outlives the job.
4. **Follow a junction / symlink / hard link.** `mklink /J` a junction inside the root pointing outside, a symlink, and a hard link to an outside secret → traversal fails `STATUS_REPARSE_POINT_ENCOUNTERED` / the hard-linked file is never ACE'd and reads/writes through it fail; the outside file is unchanged (ports `browser-file-boundary.test.mjs:52,63,85` and `browser-scripts.test.mjs:76,91`).
5. **8.3 / ADS / reserved.** `type secret.txt:stream`, `SSH~1\key`, `CON` → refused.
6. **Network.** Job reaches the public internet (allowed) but is refused loopback to Reach's port, Reach's named pipe, and Tailscale's pipe (scripts/Files: no network at all).
7. **Revocation residue.** Grant a root, move a granted file out, revoke the session; confirm the revoked package SID resolves to nothing and the residual ACE grants no live principal access (§4.2 honest gap).
8. **Resource caps.** A fork bomb and a 4 GiB allocation are capped by the Job Object, not the machine (the runaway-memory guardrail).

The shared policy corpus (plan rule 4) — the guard data set — is exercised by the same decisions test the JS and (future) helper run (`test/agent-desktop-policy-native.test.mjs`); workstream C adds the sandbox-launch refusals to it.

## 10. Parity ledger (for `docs/WINDOWS_AGENT_PARITY.md`'s table)

| Mac behaviour | Windows | Note |
|---|---|---|
| Full-control shell unsandboxed, as OS user | Job Object only (kill-on-close, caps), owner token, **no** AppContainer | **Byte-for-byte parity** (Mac is also unsandboxed). Corrects the plan's "sandboxed per C". |
| Jobs: allow-default deny-list, network on | AppContainer allow-list (ACEs on shared roots) + DENY carve-outs + loopback denial | **Stronger** on reads than the Mac; same deny guarantees. Record as a parity *gain*. |
| Scripts: deny-default, no net, one process, no links | LPAC + Job (`ActiveProcessLimit=1`, `CHILD_PROCESS_RESTRICTED`), no capabilities, grant walk skips hard links | Parity. |
| Files helper: confined, descriptor-relative | LPAC + NT handle-relative `OBJ_DONT_REPARSE` + final-path verify | Parity. |
| Full-control Files = whole `/` | Owner-token helper (no AppContainer), same handle discipline | Effective parity; drive-root ACE not used (stated). |
| Nothing left behind (per-process sandbox) | Per-session ACEs + ledger; startup + revoke sweep | **Residue gap:** a file moved out of a root keeps a stale ACE referencing a now-dead package SID. Tested, documented. |
| — | SAC-Enforce PC | **Fail closed:** preset refused with reason until the helper is signed (workstream 5). |
| — | ReFS root (128-bit file id) | **Fail closed** until a 128-bit identity path is designed. |
| — | WDAC/AppLocker blocking csc.exe or the exe | **Fail closed** via `scriptBlocked`-style classifier; never fall back to an interpreter. |

Dependencies out of C's scope but required: workstream A's `windowsBinary` build helper, platform-neutral private-path/guard data (the Windows `denies` set: dataDir, agentPolicyFile, `.reach`, `~/.reach-agent`, Startup, PowerShell profiles, `.ssh`, Credential Manager, browser profiles), and the owner-prompt wording for SAC/WDAC refusals.

---

Key source anchors for the implementer: `server/jobs.mjs:32-79,131-146`; `server/index.mjs:1068-1069,3004-3024`; `server/agent-shell.mjs:15-27,28-42,104-107` (unchanged, inject via `overrides.agentShellRun` at `index.mjs:1072`); `server/browser-scripts.mjs:54,66-72,168-195`; `server/browser-file-boundary.mjs:14,16-29,33-98`; `scripts/native/browser-files.swift` (reference semantics, unchanged); `server/browser-private-paths.mjs:24-43` (Mac deny-list to mirror as a Windows deny set); `server/desktop-native.mjs:12-35` + `server/native-build.mjs` (build model to mirror as `windowsBinary` in workstream A); `server/powershell.mjs` (`scriptBlocked`/`SCRIPT_BLOCKED` wording to reuse).

Sources: [Launch an AppContainer](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer), [JOBOBJECT_BASIC_LIMIT_INFORMATION](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information), [UpdateProcThreadAttribute](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute), [_OBJECT_ATTRIBUTES](https://learn.microsoft.com/en-us/windows/win32/api/ntdef/ns-ntdef-_object_attributes), [Low-level Security Descriptor Functions](https://learn.microsoft.com/en-us/windows/win32/secauthz/low-level-security-descriptor-functions), [Smart App Control](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview), [App Control for Business](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/appcontrol), [Recommended block rules](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/applications-that-can-bypass-appcontrol), [Network isolation / loopback](https://learn.microsoft.com/nl-nl/previous-versions/windows/apps/hh780593(v=win.10)), [NetworkIsolationSetAppContainerConfig](https://learn.microsoft.com/en-us/windows/win32/api/netfw/nf-netfw-networkisolationsetappcontainerconfig).
