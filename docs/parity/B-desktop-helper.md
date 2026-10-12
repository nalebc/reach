# Windows agent desktop helper: design (revision 2)

Workstream B of `docs/WINDOWS_AGENT_PARITY.md`. This document is design only: it changes no code and makes no commits. Line numbers refer to the tree at `e95358c3`. They were re-checked on `d5676f16`: since `e95358c3`, only `server/powershell.mjs` (lines added after line 26), `test/remote-desktop.test.mjs` and `test/windows-screen-helpers.test.mjs` changed, and no cited line moved.

Revision 2 resolves the review's blocker, its eleven major findings and its eight minor ones. Each item and where it landed is in §0.1. Questions only the owner can settle are in §16, "Decisions for the owner". Where this design picks a default before the owner decides, it says so.

## 0. Decisions at a glance

| Question | Decision |
|---|---|
| Language and runtime | One file, `scripts/native/agent-desktop.cs`, written in C# 5 for the in-box .NET Framework 4.8/4.8.1. It sits next to `scripts/native/agent-desktop.manifest`. No NuGet packages and no PowerShell. |
| Delivery | **Primary:** the helper is compiled on the PC with the in-box `csc.exe` and cached by source hash. This is rule 3, and it mirrors the Mac's `swiftc`. **Fallback:** an Authenticode-signed prebuilt build of the same source. Its SHA-256 is pinned in the source tree and checked by Node before every spawn (§3.3). It is used only when the PC's code integrity blocks the local build. The fallback needs the owner's decision (§16 D1). Until then, a blocked PC is refused with the reason. |
| Process | Spawned **detached** on win32, so Node's kill-on-close job can't kill the helper before it lets go of held input. The helper releases held input and exits on stdin EOF, and also when Reach's process ends (§2.2, §5.4). |
| Protocol | The same JSON lines as `agent-desktop.swift`: the same ops, request fields, reply fields, refusal `kind`s and wording. Windows adds a few reply fields that the current server ignores (`elevated`, `desktop`, `reachConsole`, `reachHost`). stdin is read as raw bytes and decoded as strict UTF-8, line by line. |
| Reach's own windows | Identified **by console attachment, not by title**. The helper attaches to Reach's console (`AttachConsole(reachPid)`), reads `GetConsoleWindow`, and detaches. A classic console window is matched exactly. When Reach runs inside a terminal app (a pseudo console), every window of that app counts as Reach's. The app is found from the ancestry of Reach's console processes, with fallbacks (§7.3). Narrowing it to one window is §16 D3. The title "Reach" is set on win32 as a second signal. |
| Capture | GDI `BitBlt` of the chosen monitor from the screen DC (`SRCCOPY \| CAPTUREBLT`), per-monitor-v2 DPI aware. In View and Apps, protected windows are painted black from a window inventory. The inventory trusts z-order only among ordinary desktop windows; topmost, shell and immersive windows always count as on top. Full control takes no inventory, as on the Mac. Windows.Graphics.Capture is rejected (§4.1). |
| Titles | Read with `InternalGetWindowText`, which reads the window structure directly and works for windows without a caption. If that is empty, the UIA `Name` is used. A browser or terminal window whose title can't be read is refused. Settings and Control Panel windows get an **effective title** that includes the page shown (§7.4). |
| Input | `SendInput` only: absolute virtual-desk mouse coordinates, `KEYEVENTF_UNICODE` text, one atomic `SendInput` per grapheme or chord. Held buttons and keys are tracked and released on stdin EOF or when Reach exits. The physical keyboard and mouse state is checked before every batch. |
| UIPI and elevation | Rule T: an elevated target is refused. Rule F: while an elevated window is in front, no input is sent at all. Rule S: when the helper itself is elevated, all input is refused (§5.3). |
| Focus | Raise without activating (`SetWindowPos(HWND_TOP, SWP_NOACTIVATE)`, the AXRaise equivalent), then call `SetForegroundWindow` once. If that doesn't land, the reply says `front:false`, as on a Mac. No `AttachThreadInput`, no synthetic Alt, no `SwitchToThisWindow`, no UIA `SetFocus` (§6). |
| Launching | Plain executables start with `CreateProcessW` in the user's normal environment (`CreateEnvironmentBlock`) and are never elevated. A manifest asking for administrator rights is refused before launch, and `ERROR_ELEVATION_REQUIRED` is refused after. Packaged apps go through `IApplicationActivationManager`. `ShellExecuteEx` and `IAssocHandler` are not used (§9). |
| Accessibility | The COM UI Automation client (`CUIAutomation8`, with `IUIAutomation2` timeouts), through hand-declared `[ComImport]` interfaces. A CI test checks them against the Windows SDK IDL. Values are fetched only for elements whose `IsPassword` is false (§8.1). |
| Policy | The Swift `PURE DESKTOP POLICY` section is ported line for line into a `PURE DESKTOP POLICY` section of the C# file. It runs the same shared corpus as Swift and JS, plus a Windows-data corpus. Its Windows-only additions are no-ops on Mac data. |
| Tests | Unit tests with an injected platform and dependencies. The shared corpus is compiled with `csc` on Windows CI. Real-Windows tests run on `windows-2025` and `windows-11-arm` through a test-only medium-integrity launcher, because GitHub's Windows VMs run as administrators with UAC off. There is one negative test per review finding (§13.6). |

### 0.1 Review resolution

| # | Severity | Finding | Resolution | Sections | Status |
|---|---|---|---|---|---|
| 1 | blocker | Nothing identifies Reach's own terminal on Windows | Console attachment gives the exact window for a classic console. For a pseudo console, the host app is found by ancestry, with class and broad fallbacks. Also: a `reach` rules field on win32, the title "Reach" as a second signal, and a close guard for Ctrl+C/D/W/Q, Ctrl+Shift+W and Alt+F4. | §7.3, §7.7, §12 | Resolved; narrowing is D3 |
| 2 | major | Apps-mode painting trusts EnumWindows z-order across bands | Inventory with bands: topmost, shell and immersive windows always count as above, and a `FindWindowEx` walk is unioned in. Thumbnail overlays black out Apps shots. An inventory still incomplete after one retry blacks out View and Apps shots. Full control takes no inventory. | §4.3 | Resolved; the shell list is completed on a real PC |
| 3 | major | Windows without a caption have no title | `InternalGetWindowText`, then UIA `Name`. An unreadable browser or terminal title is refused. Startup self-test. | §2.4, §7.4 | Resolved |
| 4 | major | PFN entries never match AUMIDs; package identity trusted | `e + "!"` match. The image must lie in the package's folder. | §7.1, §7.2 | Resolved |
| 5 | major | Settings private pages never matched | Effective title `Settings — page`, read through UIA; an unreadable page counts as private. Control Panel in Explorer is checked too; applets added to A's data. | §1.3, §7.4 | Resolved; element ids from the runner |
| 6 | major | Allowed Explorer exposes the address bar, the taskbar and Shut Down | Only `CabinetWClass` windows are Explorer the app. Address bands, Run and search take no text. Alt+F4 on the desktop or taskbar is refused. | §7.8 | Resolved; offering Explorer is D5 |
| 7 | major | Paste restore can re-add the owner's password to Clipboard History | The agent's text and the restored text both carry the three exclusion formats. The clipboard is emptied when there was no previous text (Swift :1021). | §5.2 | Resolved |
| 8 | major | open-file checks are lexical and case-sensitive | Canonicalized from a handle (helper) and by realpath (Node), compared case-insensitively. Trailing dots and spaces, ADS, reparse points and hard links refused. Windows protected paths added to A's data. | §1.3, §9, §12 | Resolved |
| 9 | major | Launched apps inherit the stripped environment | `CreateProcessW` with `CreateEnvironmentBlock(own token, FALSE)`; packaged apps through the activation manager. | §2.5, §9 | Resolved |
| 10 | major | No raise; UIA `SetFocus` may synthesize Alt | Raise without activating; UIA `SetFocus` removed; the taskbar sentence corrected. | §6 | Resolved; the raise is measured on the runner |
| 11 | major | WebView2 and ApplicationFrameHost elements are attributed to the wrong process | Nearest native HWND, then `GA_ROOT`, with a verified host. | §7.1 | Resolved; the CI fixture is D6 |
| 12 | major | The signed fallback's verification is circular | SHA-256 pinned per architecture, checked by Node before every spawn. | §3.3 | Resolved, if D1 adopts the fallback |
| 13 | minor | stdin decoded with the console code page; stdout written from two threads | Raw bytes with strict UTF-8 per line; one `outLock`. | §2.1, §2.2 | Resolved |
| 14 | minor | Physical-state check: too narrow, blind under an elevated foreground, wrong layout | Checked before every batch; Rule F; `MapVirtualKeyExW` with the foreground layout. | §5.2, §5.3 | Resolved |
| 15 | minor | Rename, launch classification, AppLocker | Build lock and rename retries; a cache hit counts as success. Spawn errors told apart from early exits. Reasons read from event logs. One rebuild on ENOENT. The AppLocker outcome stated. | §3.1, §3.4 | Resolved; AppLocker is D2 |
| 16 | minor | View refinement rarely applies; race guarantee overstated | One opacity definition with AUTO handled. Titles and a WinEvent counter in the race check. Guarantee reworded. Deterministic fakes. | §4.3, §13.2 | Resolved; refined vs strict is D4 |
| 17 | minor | Launches can raise UAC prompts; the shell thread can wedge | Manifest pre-check and refusal of error 740. The helper exits after a wedge. | §2.2, §9 | Resolved |
| 18 | minor | Gaps in deny lists and detections | Firefox devtools keys, more program extensions, `ActivateForFile`, terminal window classes, and a Windows command deny list required from A. The Squirrel limitation noted. | §1.3, §7.7, §9, §15 | Resolved; the Mac keys are D7 |
| 19 | minor | ValueValue prefetched for password fields; WinVerifyTrust may go online | Two-pass cache; cache-only retrieval with a deadline. | §7.1, §8.1 | Resolved |
| 20 | minor | Tests that can't run or are missing; crash cleanup assumed | Clipboard listener fixture; one case per finding (§13.6); the detached spawn and the watchdog are tested. | §5.4, §13 | Resolved |

## 1. Scope and contracts

### 1.1 What the helper serves

Every op the server sends (`HELPER_OPERATIONS`, `server/agent-desktop.mjs:221`):

`rules, catalog, shot, front, act, open, elements, open-url, browser-check, windows, focus, menus, find, read, open-file, displays, wait-change`

The `act` actions are `move, click, drag, scroll, type (plain, secret, paste), key, menu, element (snapshot+n or ref), press, fill`. `normalizeAction` already checks the shape of all of them (`agent-desktop.mjs:99-213`).

### 1.2 What it must not change

- **macOS:** `scripts/native/agent-desktop.swift` and every macOS code path stay byte-for-byte the same. Server changes live behind `platform === "win32"` branches (§12). The darwin `rules` payload is unchanged; the `reach` field is added on win32 only.
- **No guessing whether the owner is present.** The Mac stopped calling `checkOwner` on Oct 8 (`agent-desktop.swift:773-779`). The Windows helper has no input-timing heuristics. Its physical-state check (§5.2) reads only whether a key is down **right now**, so the agent's keys don't merge with the owner's into a shortcut.
- **Fail closed everywhere.** A target that can't be identified, a title or page that can't be read, an inventory that can't be completed, or a policy field that can't be parsed means refusal (for input) or black (for pixels).

### 1.3 What it needs from workstream A (contract)

A builds these, and B assumes them exactly. Items marked **New** were added in revision 2.

1. **`windowsBinary(config, "agent-desktop")`** in `server/desktop-native.mjs`: compile, cache and launch-classify as specified in §3.4.
2. **`nativeRules(policy, {…, platform})`**, with an explicit `platform` option defaulting to `process.platform`. With `platform: "darwin"` it returns exactly today's data; the shared corpus uses this on both OSes. With `"win32"` it returns the Windows data:
   - `protectedAppIds`: lowercase package family names (matched against AUMIDs as `pfn!…`, §7.2) and `exe:` ids, for example `exe:keepassxc.exe`.
   - `protectedAppNames`: exe base names without `.exe`, for example `1password`, `bitwarden`, `consent`, `credentialuibroker`, `logonui`, `lockapp`, `taskmgr`, `regedit` and `mmc`. **New:** `sechealthui` (Windows Security), `rundll32` (it hosts Control Panel applets), `control`, `systempropertiesremote`, `systempropertiesadvanced`, `systempropertiesprotection`, `netplwiz`, `useraccountcontrolsettings` and `credwiz`.
   - `privatePanes`: page words matched against the effective titles of Settings and Control Panel (§7.4). At least `privacy`, `security`, `accounts`, `sign-in`, `your info`, `other users`, `family`, `network`, `wi-fi`, `ethernet`, `vpn`, `proxy`, `remote`, `for developers`, `advanced`, `recovery`, `firewall`, `sharing`, `user accounts`, `credential` and `tailscale`. A may reuse the Mac words and add these.
   - `protectedTitleWords` additions, for example `credential manager`.
   - Windows `terminalLike` words: `windowsterminal`, `conhost`, `openconsole`, `powershell`, `pwsh`, `cmd.exe`, `wsl`, `mintty` and `git-bash`. The helper also detects terminals by window class (§7.4), which A's list can't express.
   - A new key, **`protectedPublishers`**: lowercase Authenticode signer CNs or package publisher names of password managers.
   - On win32, `allowedApps[].bundleId` is the AUMID for packaged apps and `""` for unpackaged ones. Unpackaged apps therefore match only by full path (§7.1). `hiddenApps` keep their `exe:` bundle ids, so hiding is broad.
   - **New:** `protectedPaths` gains the Windows locations, resolved for the current user. At least:
     - browser profiles: `%LOCALAPPDATA%\Google\Chrome\User Data`, `…\Microsoft\Edge\User Data`, `…\BraveSoftware`, `…\Vivaldi`, `%APPDATA%\Mozilla\Firefox\Profiles` and `%APPDATA%\Opera Software`;
     - `%APPDATA%\Microsoft\Protect` (DPAPI keys), `%APPDATA%\Microsoft\Credentials`, `%LOCALAPPDATA%\Microsoft\Credentials` and `%LOCALAPPDATA%\Microsoft\Vault`;
     - `%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine` (shell history);
     - `%ProgramData%\Tailscale` and `%LOCALAPPDATA%\Tailscale`;
     - the password managers' data folders, `%USERPROFILE%\.ssh`, and Reach's own data folder (already in `browserPaths()`).
3. **New: `protectedPathReason` compares case-insensitively on win32**, as `commandRefusal` already does (`agent-guard.mjs:134-137`). Today it uses a case-sensitive `startsWith` (`agent-guard.mjs:202-209`). The Windows forms of `SECRET_PATH` and `PRIVATE_LIBRARY` (backslashes, `AppData\Local\…`) come with it.
4. **New: a Windows command deny list for typed text.** `typedTextRefusal(…, {platform:"win32"})` must refuse at least:
   - `taskkill`, `tskill`, `Stop-Process` (and its aliases `spps` and `kill`), `wmic process … delete/terminate`, and `Invoke-CimMethod … Terminate`, when aimed at node, Reach, Tailscale or the shell;
   - `shutdown`, `Restart-Computer`, `Stop-Computer`, `logoff` and `rundll32 … LockWorkStation`;
   - `sc`, `net stop`, `reg`, `runas`, `bcdedit`, `netsh`, `schtasks`, `icacls`, `takeown`, `Set-MpPreference`, `Add-MpPreference` and `tailscale`;
   - `Remove-Item -Recurse`, `rd /s` and `del /s` on wide targets;
   - anything that hides its own text: `-EncodedCommand`, `Invoke-Expression` and `iex`.

   The list must also handle Windows path forms and `.exe` suffixes in command names; `baseName` today strips only `/` paths (`agent-guard.mjs:121`). **Until A ships this list, B refuses typed text into terminal-like targets on win32 in non-Full modes** (§12 item 9). B must not rely on the POSIX list.
5. **App ids:** a packaged app is `shell:AppsFolder\<AUMID>`, with `bundleId = <AUMID>`. An unpackaged app is its canonical exe path (`C:\…\app.exe`), with `bundleId = exe:<lowercase file name>`. The catalog, `open`, presets and the hidden list all use this form.
6. **Modifiers:** the helper maps `cmd|command|meta|control|ctrl` to Ctrl and `option|alt` to Alt itself, so it works whether or not the server pre-translates. The Windows key is never sent.
7. **The pause store** is independent of the desktop service. This is A's work, and nothing in B depends on it.

B adds these itself on the server (§12), not through A: the win32 `reach` rules field, the detached spawn, the environment allowlist, and the title "Reach" on win32.

## 2. Process model and wire protocol

### 2.1 Lifecycle (mirrors `agent-desktop.mjs:234-316` and `agent-desktop.swift:1993-2085`)

- There is one helper process per agent session (`session()`, `agent-desktop.mjs:377-392`), plus one for the catalog utility (`agent-desktop.mjs:496`). Each starts with `--reach-pid <process.pid>`.
- **stdin** carries UTF-8 JSON lines.
  - The stream is opened at startup with `Console.OpenStandardInput()`, before anything touches a console. The reader collects raw bytes up to `0x0A`.
  - A line over 262,144 bytes is discarded up to the next newline **before decoding** and answered with `Invalid request.` (`invalid`), as Swift does (`agent-desktop.swift:2002-2003`). A trailing `0x0D` is dropped.
  - Each line is decoded with `new UTF8Encoding(false, true)`. A `DecoderFallbackException` gets `Invalid request.` (`invalid`), and reading carries on with the next line.
  - `Console.In` is never used: it decodes with the console code page.
- **stdout** carries exactly one JSON line per request, ending in `\n` (not `\r\n`).
  - Everything goes through one `StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false))`. Every write and flush is serialized behind one `outLock`, including the flush on the EOF path (§2.2).
  - Nothing else is ever written to stdout. stderr stays empty: no exception text, no titles, no typed text.
- **Replies** are either `{"ok":true,…}` or `{"error":"…","kind":"blocked|paused|retry|busy|invalid|unavailable|setup_required","candidates":[…]}`. These are the same kinds as `KINDS` (`agent-desktop.mjs:17`) and the same catch-all as Swift (`agent-desktop.swift:2077-2081`). Any unexpected exception becomes `{"error":"The PC couldn't do that.","kind":"unavailable"}`.
- **`rules` must come first.** Before it, only `catalog` is answered. Anything else gets `Rules come first.` with kind `invalid` (`agent-desktop.swift:2005-2011`).

### 2.2 Threads (C# 5, .NET Framework)

| Thread | Apartment | Job |
|---|---|---|
| `Main` | `[MTAThread]` | Runs the startup checks (§2.4), then the request loop: it takes lines from the reader queue and processes them one at a time. All UIA client calls happen here. Microsoft directs that UIA calls run on a thread that owns no windows and is MTA ([Understanding Threading Issues](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)). |
| `stdin-reader` | none | Reads raw bytes and frames them into lines (§2.1), feeding a `BlockingCollection<string>` with capacity 4. **On EOF:** `LetGo()` (§5.4), flush stdout under `outLock`, then `TerminateProcess(GetCurrentProcess(), 0)`. This is the Windows equivalent of Swift's SIGTERM handler (`agent-desktop.swift:1996-1999`). On Windows, Node's `child.kill("SIGTERM")` is an abrupt `TerminateProcess`, so no handler could run at that point. The Mac helper exits on EOF **without** calling `letGo` (`agent-desktop.swift:2000`, `2083`), so Windows is stricter here. |
| `watchdog` | none | Holds a handle to Reach's process (from `--reach-pid`), opened with `SYNCHRONIZE \| PROCESS_QUERY_LIMITED_INFORMATION`. That process must have been created before the helper; otherwise the helper exits at once. The thread waits on the handle. **When Reach exits**, including a crash or a Ctrl+C in its terminal, it runs the EOF path. Because the helper is spawned detached (§12), Node's job can't kill it first. |
| `shell` | STA plus `COINIT_DISABLE_OLE1DDE` | Runs AppsFolder enumeration, `IApplicationActivationManager`, `SHOpenFolderAndSelectItems`, `IShellWindows` (Explorer locations, §7.4) and association queries. Work reaches it through a queue with an 8-second deadline, the same as Swift's `open` timeout. **On a missed deadline** the main thread replies `retry` (`The app is taking too long to open.`, as Swift), then runs the EOF path. The next request starts a fresh helper, with no wedged thread left behind. |
| `clipboard` | STA plus a `GetMessage` loop | Owns a message-only window (`HWND_MESSAGE`). It must pump messages, because other apps send it `WM_DESTROYCLIPBOARD` when they empty the clipboard. `OpenClipboard(NULL)` can't be used: with a NULL owner, `SetClipboardData` fails ([OpenClipboard remarks](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openclipboard)). Each paste has a 1-second deadline, because reading delay-rendered data sends `WM_RENDERFORMAT` to the clipboard's owner, which can hang. On a miss, the reply is `retry` (`The clipboard is busy. Type the text instead.`), and then the EOF path runs. |
| `window-events` | STA plus a `GetMessage` loop | Hooks `SetWinEventHook(WINEVENT_OUTOFCONTEXT)` for `EVENT_OBJECT_SHOW/HIDE/LOCATIONCHANGE/NAMECHANGE/REORDER/CLOAKED/UNCLOAKED` and `EVENT_SYSTEM_FOREGROUND`. Each event does `Interlocked.Increment(ref windowRevision)`. The capture race check uses this counter (§4.3 step 4). |
| `uia-events` | MTA | Adds and removes all UIA event handlers. Per the threading doc, they are added and removed on this one thread only. The handlers only do `Interlocked.Increment(ref screenRevision)`. |

### 2.3 JSON

The file contains its own strict RFC 8259 reader and writer in a `// BEGIN JSON … // END JSON` section of about 250 lines.

- **Why not a library:** this removes the `System.Web.Extensions` dependency and gives exact number semantics.
- **Reader rules:** depth at most 32; duplicate keys rejected; numbers parsed to `double`, with an `IsIntegral` flag.
- **`AsInt(object)`** accepts only integral values. Where Swift does `as? Int`, a JSON `1.5` is treated as missing, which matches Swift's exact bridging.
- **Writer rules:** escapes `"`, `\`, U+0000–U+001F, U+2028/2029 and lone surrogates as `\uXXXX`.

### 2.4 Startup (before the first read)

0. **Streams first.** Open stdin and stdout (§2.1) before anything else, so the console probe (§7.3) can't disturb them.
1. **Crash and DPI settings:**
   - `SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX)`.
   - `WerSetFlags(WER_FAULT_REPORTING_FLAG_NOHEAP)`, so a crash report never carries heap memory that may hold vault values ([WerSetFlags](https://learn.microsoft.com/en-us/windows/win32/api/werapi/nf-werapi-wersetflags)).
   - Confirm that the process is Per-Monitor-v2 aware (the manifest sets this, §4.4) with `AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(), DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)`. If it isn't, every op except `catalog` answers `unavailable`.
2. **Title self-test.** Microsoft marks `InternalGetWindowText` "not intended for general use. It may be altered or unavailable in subsequent versions of Windows" ([InternalGetWindowText](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-internalgetwindowtext)).
   - The helper creates a hidden `WS_POPUP` window without `WS_CAPTION`, titled `reach-title-check`, reads the title back with `InternalGetWindowText`, and destroys the window.
   - If the title doesn't match or the entry point is missing, every op except `catalog` answers `This version of Windows changed how window titles are read. Reach can't check windows here yet.` (`unavailable`).
3. **UI Automation:**
   - `CoInitializeEx(MTA)`, then `CoCreateInstance(CLSID_CUIAutomation8)`, falling back to `CLSID_CUIAutomation`.
   - Through `IUIAutomation2`, set `ConnectionTimeout = 1000` ms and `TransactionTimeout = 500` ms. This is the Windows equivalent of `AXUIElementSetMessagingTimeout(…, 0.25)` (`agent-desktop.swift:491`), with per-op deadlines as in Swift.
   - **Interop sanity check:** `GetRootElement().CurrentControlType == UIA_PaneControlTypeId (50033)` and `CurrentNativeWindowHandle == GetDesktopWindow()`. If this fails, the vtable declarations are wrong: `accessibility` is `false`, and every UIA op is refused with `unavailable`.
4. **Own token:** read `TokenIntegrityLevel` and `TokenElevationType` once (§5.3).
5. **Threads:** start `watchdog`, `window-events`, `clipboard`, `shell` and `uia-events`.

The Reach console probe (§7.3) runs at each `rules`, not at startup, because it needs the `reach` field.

### 2.5 Environment: the helper's own, and the one launched apps get

**The helper's own environment** (server side, §12): spawn with `windowsHide: true` and an **allowlisted** environment:

`SystemRoot, windir, SystemDrive, PATH=%SystemRoot%\System32;%SystemRoot%, TEMP, TMP, USERPROFILE, LOCALAPPDATA, APPDATA, HOMEDRIVE, HOMEPATH, USERNAME, USERDOMAIN, PROCESSOR_ARCHITECTURE, NUMBER_OF_PROCESSORS, PATHEXT, ProgramFiles, ProgramFiles(x86), ProgramW6432, CommonProgramFiles, CommonProgramFiles(x86), CommonProgramW6432, ProgramData, ALLUSERSPROFILE, PUBLIC, ComSpec`

The second half of the list (from `ProgramFiles` on) is harmless, and in-process shell code expects it. Never pass `COR_*`, `COMPlus_*`, `DOTNET_*` or `CORECLR_*`: `COR_ENABLE_PROFILING` and `COR_PROFILER` would load a profiler DLL into the helper when its runtime starts.

**Launched apps' environment** (§9): every `CreateProcessW` call the helper makes passes `CREATE_UNICODE_ENVIRONMENT` and a block from `CreateEnvironmentBlock(&block, ownToken, FALSE)`.
- With `bInherit` FALSE, the block does "not inherit the current process' environment" ([CreateEnvironmentBlock](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createenvironmentblock)). It is built from the user's and the system's variables. An app the agent opens therefore gets the user's PATH, `ProgramFiles` and `ComSpec`, just as one the owner opens from Start does.
- Packaged apps are started by the system's activation manager, not as the helper's children.
- If `CreateEnvironmentBlock` fails, the launch is refused (`The PC couldn't prepare that app's settings.`, `unavailable`). It is never retried with the helper's own environment.

## 3. Delivery (question 1)

### 3.1 Evidence

| Environment | csc-compiled, unsigned exe in the user's data dir | Authenticode-signed prebuilt exe | Microsoft source |
|---|---|---|---|
| **Smart App Control (SAC) On** (Windows 11 clean installs) | **Blocked.** "Malware, Potentially Unwanted Apps (PUA), and unknown, unsigned code are blocked by default." A locally built binary has no cloud reputation. | **Allowed**, with no reputation needed: "If the app intelligence service is unable to make a prediction, then Smart App Control will still allow an app to run if it is signed with a certificate issued by a certificate authority (CA) within the Trusted Root Program." | [SAC overview](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview), [Sign for SAC](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/code-signing-for-smart-app-control), [Security book](https://learn.microsoft.com/en-us/windows/security/book/application-security-application-and-driver-control) |
| SAC Evaluation | Runs. In evaluation mode SAC "evaluates your app's signature but doesn't block your app". | Runs | [Test with SAC](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control) |
| SAC Off; enterprise-managed PCs | Runs. SAC is disabled on PCs in enterprise management. | Runs | [Security book](https://learn.microsoft.com/en-us/windows/security/book/application-security-application-and-driver-control) |
| **AppLocker** with default rules (managed PCs) | **Blocked for every owner who runs Reach unelevated**, standard users and administrators alike. The defaults allow Everyone only in `%windir%\*` and `%programfiles%\*`. The default "Administrators: all files" rule doesn't match a UAC-filtered admin token, where Administrators is deny-only (to be confirmed on a real PC, §13.5). Rule S refuses an elevated helper, so **an AppLocker PC with default rules has no working path** without a signed build plus an administrator's publisher rule (§16 D2). | Also blocked by those path rules unless the admin adds a publisher rule; the signature makes that rule possible. | [Executable rules in AppLocker](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/applocker/executable-rules-in-applocker) |
| **App Control for Business (WDAC)** | Blocked under any policy that doesn't allow unsigned code in user directories. The in-box `csc.exe` is not on Microsoft's recommended block list (`csi.exe`, `msbuild.exe` and `dotnet.exe` are), so compiling works but launching fails. | Allowed only if the admin's policy trusts the signer. | [Recommended block rules](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/design/applications-that-can-bypass-appcontrol) |
| **Constrained Language Mode** | Not used directly: the helper never runs in PowerShell. CLM is still a signal. PowerShell enters it automatically "when it's running under a system application control policy" (AppLocker or App Control), which is exactly when an unsigned helper will also be blocked. Reach's PowerShell remote-desktop helpers already fail there (`server/powershell.mjs:20-23`). | Not relevant | [about_Language_Modes](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_language_modes) |
| **Defender** block at first sight | Doesn't apply. It acts on files "downloaded from the Internet, or that originate from the Internet zone", and a compiled file carries no Mark of the Web. | Same | [Block at first sight](https://learn.microsoft.com/en-us/defender-endpoint/configure-block-at-first-sight-microsoft-defender-antivirus) |
| **Defender ASR** "Block executable files … unless they meet a prevalence, age, or trusted list criterion" (`01443614-cd74-433a-b99e-2ecdc07bfc25`, opt-in) | **Blocked** wherever an admin enabled it: a fresh local build has no prevalence. | Depends on cloud trust; not guaranteed. | [ASR reference](https://learn.microsoft.com/en-us/defender-endpoint/attack-surface-reduction-rules-reference) |
| Defender machine-learning false positives on small unsigned tools that read the screen and send input | Possible, with no doc to cite. Defender may also quarantine the file, which then disappears (§3.4 step 7). Measured on a real PC (§13.5). | Less likely; not guaranteed. | — |
| **ARM64 PCs** | Windows 11 ships .NET Framework 4.8.1 ([install table](https://learn.microsoft.com/en-us/dotnet/framework/install/on-windows-and-server)), which "adds native Arm64 support" ([what's new](https://learn.microsoft.com/en-us/dotnet/framework/whats-new/)). AnyCPU .NET Framework apps still run as emulated x64 on Arm64 by default ([dotnet/core#7709](https://github.com/dotnet/core/issues/7709)), and the in-box C# 5 `csc.exe` can't target arm64. So the helper runs under x64 emulation. SendInput, GDI and out-of-process UIA all work there; speed is measured on `windows-11-arm`. | Can be built arm64-native in CI. | as cited |

### 3.2 Rejected options

- **PowerShell `Add-Type`:** fails under CLM, and rule 3 bans PowerShell in agent paths.
- **Hosting the helper as a DLL inside a Microsoft-signed host** (InstallUtil, RegAsm, MSBuild inline tasks): Microsoft lists these application-control bypass hosts for blocking, and Defender treats their use as attack behaviour.
- **Asking users to turn SAC off:** Reach must not tell owners to lower their protection. Settings also treats On→Off as one-way ([test page](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control)).
- **Self-verifying signed binaries** (revision 1's `--verify-self` and embedded source hash): the binary under test would vouch for itself, Node has no WinVerifyTrust, and PowerShell is banned. Replaced by pinned hashes (§3.3).

### 3.3 Recommendation

1. **Primary (phase 2): compile on the PC.**
   - It costs nothing and binds no identity. The binary is exactly the reviewed source, and it is the same model as the Mac (`desktop-native.mjs:14-38`).
   - It works on unmanaged PCs with SAC Off or in Evaluation. That covers the CI runners and most developer and power-user PCs.
2. **Fallback (requires the owner's decision, §16 D1): a signed prebuilt helper.**
   - CI builds it from the same `agent-desktop.cs` and manifest, signs it, and commits it as `scripts/native/bin/{x64,arm64}/agent-desktop.exe`. The SHA-256 of each signed file goes into `scripts/native/bin/agent-desktop.sha256` in the same release commit.
   - **Node verifies it by pinned hash.** Before every spawn, Node copies the prebuilt into the data directory as `reach-agent-desktop-signed-<pin[0..12]>.exe`, if it isn't there yet. It then hashes that cached copy (`crypto.createHash("sha256")` over a file of about 100 KB) and compares the result with the pin for `process.arch`. Any mismatch refuses with `Reach's signed agent helper doesn't match this version of Reach. Reinstall Reach.` (503, `permanent`).
   - **Windows enforces the signature at load** where policy requires it (SAC, or a WDAC or AppLocker publisher rule). The trust anchor is the source tree, the same tree that holds the `.cs` compiled on other PCs.
   - It is used **only** when SAC is On (§3.4 step 2) or when the local build was classified as blocked by policy (§3.4 step 7).
3. **Until the owner decides,** no prebuilt ships. A PC whose policy blocks the local build gets a precise refusal (§3.4) and no workaround.

### 3.4 Build, cache and launch: exact spec for `windowsBinary`

1. **Inputs:** `scripts/native/agent-desktop.cs` plus `scripts/native/agent-desktop.manifest`. The cache file is `<dataDir>\reach-agent-desktop-<sha256(cs‖manifest)[0..12]>.exe`. Older builds are pruned, as `buildNative` does, except a file still in use (EBUSY or EPERM on unlink), which is skipped.
2. **SAC state, read before compiling.**
   - Run `execFile("<SystemRoot>\\System32\\reg.exe", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy", "/v", "VerifiedAndReputablePolicyState"])` with no shell, `windowsHide` and a 5-second timeout. Parse `REG_DWORD 0x…`.
   - If the value is 1 (SAC On; [test page](https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/test-your-app-with-smart-app-control)), use the verified signed fallback if it is present. Otherwise refuse with `Smart App Control on this PC only runs signed programs. This version of Reach can't give agents the screen here yet.` (503, `permanent`).
   - For any other value, or an unreadable one, compile and let launch classification (step 7) decide.
3. **Compiler path:** `%SystemRoot%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`, then `…\Framework\v4.0.30319\csc.exe`. `%SystemRoot%` comes from `process.env.SystemRoot` when that is an existing absolute `X:\…` directory, and is `C:\Windows` otherwise. It never comes from PATH.
4. **Build lock.** Create `<dataDir>\reach-agent-desktop.build.lock` with `fs.openSync(path, "wx")`.
   - If the lock exists and is younger than 180 s, wait in 250 ms steps until the cache file appears or the lock goes away.
   - A lock older than 180 s is stale: remove it and take it.
   - **If the cache file already exists, that counts as success.** A second session never rebuilds.
5. **Command line**, run with `execFile`, no shell, a 120 s timeout and `windowsHide`:

   ```
   csc.exe /nologo /noconfig /target:exe /platform:anycpu /optimize+ /debug- /utf8output /codepage:65001
     /langversion:5 /win32manifest:<manifest> /r:System.dll /r:System.Core.dll /r:System.Drawing.dll
     /out:<dataDir>\<name>.<random>.tmp.exe <cs>
   ```

   Then rename the temporary file to the cache name.
   - On `EBUSY`, `EPERM` or `EACCES`, retry 8 times with a backoff from 100 ms to 1.6 s, because Defender holds a freshly written exe open while it scans it.
   - If the target appears in the meantime, delete the temporary file and count it as success.
   - The compiler prints a banner saying it "only supports language versions up to C# 5"; CI records it.
6. **Compile errors:** the compiler's output (first 20 lines, which never contain secrets) goes to `console.warn`. The user sees `Reach couldn't prepare the agent screen on this PC.`
7. **Launch classification.** Node's spawn error doesn't carry the Win32 code: libuv maps codes such as 1260, 4551 and 577 to `UNKNOWN`. So the reason comes from event logs.

   | What happened | Reply |
   |---|---|
   | `spawn` emits `error` with `ENOENT`, and the cache file is gone (antivirus quarantine) | Rebuild **once** in this Reach run. If it disappears again, refuse with `Windows security removed Reach's agent helper after it was built. Reach can't change that.` (503, `permanent`). |
   | `spawn` emits any other `error` | Policy check (below) |
   | The process exits, with any code, before answering `rules` | Policy check. If no policy event matches: `The PC's agent helper stopped before it was ready.` (503, not permanent) |
   | No `rules` answer within `COLD_START_MS` (60 s, `powershell.mjs:26`) | `The PC's agent helper didn't start in time.` (503, not permanent) |

   **Policy check:** read the newest 20 events of each of three logs with `<SystemRoot>\System32\wevtutil.exe qe <log> /rd:true /c:20 /f:xml` (an exe run with no shell, not PowerShell):
   - `Microsoft-Windows-CodeIntegrity/Operational` (3077, 3033, 3034);
   - `Microsoft-Windows-AppLocker/EXE and DLL` (8004);
   - `Microsoft-Windows-Windows Defender/Operational` (1116, 1117).

   The check looks for an event from the last 30 s that names the helper's file name. A match gives `Windows' application control on this PC (an administrator's policy, Smart App Control or antivirus) blocked Reach's agent helper. Reach can't change that policy.` (503, `permanent`); with SAC state 1, the SAC wording is used instead. If the logs are unreadable (a standard user may lack access; recorded in §13.5) or nothing matches, the non-policy wording is used. Nothing is guessed.

## 4. Capture and masking (question 2)

### 4.1 API choice

| API | Reachable from C# 5 / .NET Framework | Verdict |
|---|---|---|
| `BitBlt` from `GetDC(NULL)` with `SRCCOPY \| CAPTUREBLT` | Plain P/Invoke. `CAPTUREBLT` "Includes any windows that are layered on top of your window" ([BitBlt](https://learn.microsoft.com/en-us/windows/win32/api/wingdi/nf-wingdi-bitblt)). `screen-stream.ps1` and `test/windows-desktop-native.test.mjs:43-77` already show it gives non-black frames on `windows-2025`. | **Chosen.** |
| Windows.Graphics.Capture | Needs WinRT metadata plus D3D11 COM interop (`IGraphicsCaptureItemInterop`, a DXGI device, staging textures), a very large hand-declared vtable surface in C# 5. Worse, Windows draws a yellow border around the captured item ([Screen capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)). Turning it off needs `GraphicsCaptureAccess.RequestAccessAsync(Borderless)`, which prompts the user, **and** the `graphicsCaptureWithoutBorder` package-manifest capability ([IsBorderRequired](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.isborderrequired)), which an unpackaged csc-built exe can't declare. A border flashing on the owner's screen ten times a second is not acceptable. | Rejected. |
| DXGI Desktop Duplication | D3D11 interop, at the same cost as above, and nothing gained for a single screenshot. | Rejected. |
| `PrintWindow(PW_RENDERFULLCONTENT)` per window | Sends a message to each target, so it can stall on hung apps. GPU-composited content is unreliable. | Rejected as a capture source. |

Windows itself removes windows that call `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)`, as some password managers and messengers do. `WDA_MONITOR` windows appear "with no content" ([SetWindowDisplayAffinity](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity)). Microsoft says this is not a guarantee, so Reach's own masking still applies.

### 4.2 Why masking is needed, and the difference from the Mac

On the Mac, ScreenCaptureKit composes the frame *without* the excluded windows, so what is behind them shows (`agent-desktop.swift:1113-1131`). GDI can't remove a window from the composition. The Windows helper therefore **paints black** over every pixel a protected window could contribute. In Apps mode it starts from black and paints back only the allowed apps' pixels.

The guarantee is the same (no protected pixel leaves the PC), delivered by a different mechanism, as the parity rules allow. Two visible differences are written down in §15: black areas where the Mac shows what's behind, and a residual that depends on the owner's choice in §16 D4.

### 4.3 Algorithm: `Shot(rules, maxWidth, monitor)`

The mode semantics come from `agent-desktop.swift:1117`: in Full control nothing is excluded, in View the excluded windows are left out, and in Apps only the allowed apps are included.

1. **Input desktop check.** `OpenInputDesktop(0, false, DESKTOP_READOBJECTS)` and `GetUserObjectInformationW(UOI_NAME)` must give `Default` ([OpenInputDesktop](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openinputdesktop)). If the call fails or returns another name (UAC secure desktop, lock or sign-in screen), refuse with `An administrator prompt, the lock screen or the sign-in screen is up on the PC. The agent waits; the owner answers it at the PC.` (kind `paused`).

2. **Window inventory, snapshot A.**

   **Full control takes no inventory for screenshots.** Nothing is excluded there, as on the Mac (`appReason` and `titleReason` return nil in Full), so the frame is the plain capture of step 3. Steps 2, 4, 5 and 6 apply to View and Apps only.

   **Enumeration.** Two walks, both top to bottom:
   - `L1`: `EnumWindows`. Microsoft notes: "For Windows 8 and later, EnumWindows enumerates only top-level windows of desktop apps" ([EnumWindows](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumwindows)).
   - `L2`: a `FindWindowExW(NULL, previous, NULL, NULL)` walk, meant to catch top-level windows that `EnumWindows` skips. Whether it does on Windows 11 is measured on the runner (§13.4 item 0). The union of both walks is used either way.

   **Incomplete inventory.** A walk can skip or revisit handles when windows change order mid-walk; that is why Microsoft calls `EnumWindows` the more reliable method. So a walk that exceeds 4096 windows or revisits a handle is retried once. If the retry fails too, the inventory is incomplete: the whole monitor is black, and `hidden` reports the count seen.

   **Per window**, record:
   - hwnd and class;
   - pid (§7.1). `ApplicationFrameHost.exe` frames resolve through their child `Windows.UI.Core.CoreWindow`'s pid; if that child is absent, the identity is unknown;
   - `IsWindowVisible`, `IsIconic` and `DWMWA_CLOAKED`. A non-zero cloak value means skip; cloaking covers other virtual desktops and suspended UWP apps ([DWMWINDOWATTRIBUTE](https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwmwindowattribute));
   - the frame: `DWMWA_EXTENDED_FRAME_BOUNDS`, falling back to `GetWindowRect`, intersected with the monitor rect. A window region from `GetWindowRgn`, if any, is kept. **A visible, uncloaked window whose frame can't be read makes the inventory incomplete;**
   - extended styles: `WS_EX_TOPMOST`, `WS_EX_TOOLWINDOW`, `WS_EX_APPWINDOW`, `WS_EX_LAYERED`, `WS_EX_TRANSPARENT` and `WS_EX_NOREDIRECTIONBITMAP`;
   - the layered alpha and color key from `GetLayeredWindowAttributes`. Alpha 0 means skip, as Swift skips alpha 0 (`agent-desktop.swift:638`);
   - `DWMWA_SYSTEMBACKDROP_TYPE` (Windows 11 22621+; `E_INVALIDARG` before that);
   - identity (§7.1), title (§7.4), whether it is one of Reach's windows (§7.3), and the `excluded` and `allowed` decisions.

   **Bands.** Z-order is trusted only where Windows keeps one list:
   - **`desktop` band:** the window is in `L1`, not `WS_EX_TOPMOST`, not a shell surface, and not of an immersive class. The order between two `desktop` windows comes from `L1`.
   - **`top` band:** everything else. That covers topmost windows; every window of a shell or immersive host process; windows of class `Windows.UI.Core.CoreWindow`, `XamlExplorerHostIslandWindow` or any other XAML-island top-level class; and any window found only in `L2`. §7.5 lists the shell and immersive hosts: `ShellExperienceHost`, `ShellHost`, `StartMenuExperienceHost`, `SearchHost`, `SearchApp`, `TextInputHost`, `Widgets`, `LockApp`, plus explorer.exe system surfaces. Toasts, Start, Search, Notification Center, Quick Settings, Widgets and Snap Assist all land in this band.
   - **Ordering rule:** a `top` window counts as above every `desktop` window. Among topmost windows in `L1`, `L1` order holds. A window found only in `L2` counts as above everything.

   **Excluded** windows are masked in View and never painted in Apps. A window is excluded when any of these holds:
   - `appReason(identity) != null`, or `windowTitleReason(effective title, …) != null`;
   - it is one of Reach's windows (§7.3);
   - its identity is unknown;
   - it is a browser- or terminal-like window whose title can't be read (§7.4);
   - in non-Full modes, it is a **thumbnail overlay**: an explorer.exe or shell-host window of class `MultitaskingViewFrame`, `XamlExplorerHostIslandWindow`, `TaskListThumbnailWnd` or `ForegroundStaging`. This is the Windows form of Swift's `dockOverlay`. Task View, Alt+Tab, Snap Assist and taskbar previews draw other windows' content.

   **Allowed** (Apps mode): every top-level window of an allowed process, including its menus and pop-ups, matching ScreenCaptureKit's per-application filter (`agent-desktop.swift:1123-1124`). Excluded windows and explorer.exe system surfaces (§7.8) are never allowed, even when explorer.exe is.

3. **Capture.** Create a 32-bpp top-down DIB section at the monitor's physical size, then `BitBlt(mem, 0, 0, w, h, screenDC, mon.left, mon.top, SRCCOPY|CAPTUREBLT)`. Record `windowRevision` (§2.2) just before.

4. **Snapshot B and the race check.**
   - Take snapshot B. Compare the ordered tuples `(hwnd, frame, visible, cloaked, iconic, ex-styles, title, pid)` of A and B, and compare `windowRevision` with its value before the capture.
   - If either changed, capture again, up to 3 times. After the third time, the whole monitor is black.
   - Masks are computed from the **union** of the excluded and allowed decisions across all snapshots taken.
   - **What this guarantees:** every window present in any snapshot is handled. A window that is created, shown and hidden again within one capture (a few milliseconds), with no WinEvent delivered before snapshot B, could appear in that one frame. The Mac has a comparable gap in View mode, where the exclusion list is read from `SCShareableContent` before the capture (`agent-desktop.swift:1096`, `1113-1119`).

5. **Opacity.** One definition, used by both modes. A window is **positively opaque** when all of these hold:
   - it is visible, not cloaked and not iconic, and its identity is known;
   - it is not `WS_EX_TRANSPARENT` and not `WS_EX_NOREDIRECTIONBITMAP` (DirectComposition content can be see-through);
   - it is not `WS_EX_LAYERED`, or it is layered with `GetLayeredWindowAttributes` succeeding, `LWA_ALPHA` at 255 and no `LWA_COLORKEY`. `UpdateLayeredWindow` windows make that call fail, so they are not opaque;
   - `DWMWA_SYSTEMBACKDROP_TYPE` is `DWMSBT_AUTO` (0), `DWMSBT_NONE` (1), `DWMSBT_MAINWINDOW` (2, Mica) or `DWMSBT_TABBEDWINDOW` (4, Mica Alt), or the attribute is unsupported (before build 22621). AUTO and unsupported count as "no system backdrop", and Mica samples only the desktop wallpaper. `DWMSBT_TRANSIENTWINDOW` (3, Acrylic) blurs what is behind, so it is never opaque;
   - it has no window region;
   - it doesn't belong to one of the `top` band's shell or immersive hosts.

   **Residual (cannot be detected):** a window can be made see-through with `DwmEnableBlurBehindWindow` and per-pixel alpha, or with an acrylic accent set through the undocumented `SetWindowCompositionAttribute`. Windows offers no documented query for either. Such a window is classed as opaque and can show a blended or blurred view of what is behind it. §16 D4 decides whether the refinement below is used despite this.

6. **Masks**, in monitor pixels, built with `CreateRectRgn` and `CombineRgn`:
   - **Full control:** no mask and no inventory, as on the Mac.
   - **View mode** (`readonly`):
     - Default: the mask is the union of the full frames of every excluded window, **whether or not the window is covered**. This is fail-closed.
     - **Refinement** (on by default; strict mode turns it off, §16 D4). It applies only while no thumbnail overlay is visible. A positively opaque window **definitely above** an excluded one may subtract its frame from that window's mask. "Definitely above" means one of two cases: both are in the `desktop` band and the opaque window comes first in `L1`; or the opaque window is topmost in `L1` and the excluded one is in the `desktop` band. The subtracted rectangle is the opaque window's frame shrunk by `8 × dpiScale` px on every side, to allow for Windows 11's rounded corners.
   - **Apps mode:**
     - While a thumbnail overlay is visible on the monitor, the whole monitor is black. This is the Mac's `overview` rule (`agent-desktop.swift:1112`).
     - Otherwise, start fully black and paint back, from the capture, the visible region of every allowed window A. That region is:
       - A's frame;
       - minus the frames of **every** window above A, whatever their opacity;
       - minus the frames of every visible `top`-band window that is not allowed, **wherever it sits in `L1`**;
       - minus the frames of every **excluded** window below A when A is not positively opaque, and always in strict mode.

       Ordinary non-allowed windows below A are **not** subtracted. Subtracting them would black out allowed windows wherever anything lies beneath, the desktop included. A see-through allowed window can therefore show a blended view of ordinary windows beneath it, but never of excluded ones (§15).
7. **Fill** the mask black with `FillRgn`, then draw the cursor with `GetCursorInfo` and `DrawIconEx`, as `screen-stream.ps1` does; the Mac sets `showsCursor = true` (`agent-desktop.swift:1142`).
8. **Redact typed secrets**, the port of `redacted()` (`agent-desktop.swift:1074-1093`). If `typedSecrets` is non-empty, run `ReadScreen(rules, text:false)` on the front window. Every field control (not a password field) whose read value contains `•••` gets its rect, plus 2 px, painted black. This is best effort, as on the Mac.
9. **Scale and encode.** `scale = min(1, maxWidth / monitorWidthPx)`, drawn with `Graphics.DrawImage` at `HighQualityBicubic`, then encoded as JPEG at quality 70 through the GDI+ encoder (the Mac's `compressionFactor 0.7`). The result must stay under 6 MiB; otherwise `The screen couldn't be encoded.` (`unavailable`).
10. **Reply** `{ok, jpeg (base64), width, height, hidden, displayId, displayWidth, displayHeight}`. `hidden` counts the excluded windows on the monitor in View, or the non-included ones in Apps (`agent-desktop.swift:1120-1131`, `1149-1150`).

### 4.4 Multiple monitors and DPI

- **Manifest** `agent-desktop.manifest`, embedded with `/win32manifest`: `<dpiAwareness>PerMonitorV2</dpiAwareness>`, `<dpiAware>true/pm</dpiAware>`, `requestedExecutionLevel level="asInvoker" uiAccess="false"`, Windows 10/11 `supportedOS`, and `longPathAware`. Microsoft recommends setting process DPI awareness in the manifest rather than through the API ([SetProcessDpiAwarenessContext](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setprocessdpiawarenesscontext)).
- With PMv2, window rects, DWM frame bounds, UIA `BoundingRectangle`, `GetCursorPos` and monitor rects are all in **physical pixels of the virtual screen**: one coordinate space, with no conversions.
- **Displays** (the `displays` op, port of `agent-desktop.swift:441-448`): `EnumDisplayMonitors` plus `GetMonitorInfoW(MONITORINFOEX)`.
  - Each monitor's `id` is a stable uint32: the FNV-1a-32 hash of the monitor's device interface path from `EnumDisplayDevicesW(szDevice, 0, EDD_GET_DEVICE_INTERFACE_NAME)`, mapped to 1–4294967295. If two monitors hash the same (astronomically unlikely), the op answers `unavailable`.
  - `main` = `MONITORINFOF_PRIMARY`; `x, y, width, height` = `rcMonitor`, in physical px.
- **Display choice** (port of `chooseDisplay`, `agent-desktop.swift:433-440`, and of request routing, `2013-2015`): the display is chosen per request. An unknown id gets `That display is disconnected. List displays again.` (`retry`). Element and snapshot references remember their display. The default is the primary monitor.
- **Fraction to pixel:** `x = left + min(width-1, floor(nx*width))`, and likewise for y. Swift uses `minX + nx*width` (`agent-desktop.swift:866`); the clamp keeps `nx=1` on the same monitor.

## 5. Input, UIPI and elevation (question 3)

### 5.1 One sink

Every injected event goes through `Post(INPUT[] batch, int pauseAfterMs)`. It is the only caller of `SendInput` in the file. A source-structure test enforces that, as the Mac does for `post()` (`test/agent-desktop-release-native.test.mjs:17-30`).

- `INPUT` is declared with `LayoutKind.Explicit` for the union, and `cbSize = Marshal.SizeOf(typeof(INPUT))` (40 on x64, 28 on x86), because SendInput fails if `cbSize` is wrong ([SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)).
- One batch is one `SendInput` call. Its events "are not interspersed with other keyboard or mouse input events inserted either by the user … or … other calls to SendInput" (same page). So each grapheme, each chord and each click is one atomic batch.
- `Post` runs the **pre-batch checks** (§5.2 physical state, §5.3 Rule F) before every batch, the drag's per-step moves included.
- If the return value is less than the batch length, the reply is `unavailable`, with `Windows refused the input. Look at the screen before trying again.` There is no retry.

### 5.2 Events, the Windows form of `perform` (`agent-desktop.swift:859-1069`)

| Mac | Windows |
|---|---|
| mouse moved / down / up at point (`:880`, `:956-964`) | `MOUSEEVENTF_MOVE \| ABSOLUTE \| VIRTUALDESK` with `dx = ceil((px - vLeft) * 65536 / vWidth)`, and `dy` likewise, so that `floor(dx * vWidth / 65536) == px - vLeft`. Absolute coordinates are normalized to 0–65535, and `VIRTUALDESK` "maps coordinates to the entire desktop" ([MOUSEINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput)). The move and the `LEFTDOWN`/`RIGHTDOWN` share one batch. |
| click count, `clickState` | `count` × [DOWN, UP] in one batch; with `holdMs > 0`, DOWN, sleep, UP. Windows forms double clicks from timing and position, which a tight batch satisfies. |
| flags on mouse events (`:961`) | Modifier key-downs, then the click, then the modifier key-ups in reverse order, all in one batch. |
| drag (`:966-983`) | DOWN at `from` (one batch); an optional hold; `steps` absolute MOVEs with the button held (12, or `durationMs/16` clamped to 12–300); UP at `to`. |
| scroll in pixels (`:987-990`) | MOVE to the point, then `MOUSEEVENTF_WHEEL` with `mouseData = -dy` and `MOUSEEVENTF_HWHEEL` with `mouseData = +dx`, each clamped to ±2000. Positive WHEEL means forward/up, and positive HWHEEL means right ([MOUSEINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-mouseinput)). One unit is about one pixel; 120 is one notch. The match to the Mac's pixel units is approximate and is measured on the real PC (§13.5). |
| typed text (`:1025-1038`) | For each `keyboardChunks` element: one batch of [unit DOWN, unit UP] per UTF-16 unit, with `KEYEVENTF_UNICODE`, `wVk = 0` and `wScan = unit`. Windows delivers `VK_PACKET`, then `WM_CHAR`, to the foreground thread ([KEYBDINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)). A newline is `VK_RETURN` down/up with no modifiers, the port of `plainTextEvent` (`:794-798`). |
| key codes (`:781-789`) | `return/enter`→`VK_RETURN`, `tab`, `space`, `delete/backspace`→`VK_BACK`, `escape/esc`, the arrows, `home/end/pageup/pagedown` and `forwarddelete`→`VK_DELETE` (all with `KEYEVENTF_EXTENDEDKEY`), `f1`–`f11`, and `a`–`z` and `0`–`9` (layout-independent VKs). `=` `-` `]` `[` `'` `;` `\` `,` `/` `.` `` ` `` resolve through `VkKeyScanExW(ch, layout)`, where `layout = GetKeyboardLayout(foregroundThread)`. If the key needs Shift or AltGr, or has no mapping, the reply is `That key isn't on this PC's keyboard layout. Type it as text.` (`invalid`). `wScan` = `MapVirtualKeyExW(vk, MAPVK_VK_TO_VSC, layout)`, using the foreground window's layout, not the helper's own. |
| modifiers (`:843-855`) | `cmd/command/meta/control/ctrl` → `VK_CONTROL`, `shift` → `VK_SHIFT`, `option/alt` → `VK_MENU`. **`VK_LWIN`/`VK_RWIN` are never sent.** |
| paste (`:1006-1021`) | On the clipboard thread, within its 1-second deadline (§2.2): (1) Open the clipboard, with retries (10 × 20 ms). (2) Save the previous `CF_UNICODETEXT`, or note that there was none; only text is saved, as Swift does. (3) `EmptyClipboard`, then set the text **and** all three registered exclusion formats: `ExcludeClipboardContentFromMonitorProcessing` (any data), `CanIncludeInClipboardHistory` = DWORD 0 and `CanUploadToCloudClipboard` = DWORD 0. These keep the item out of Clipboard History and cloud sync ([Clipboard formats](https://learn.microsoft.com/en-us/windows/win32/dataxchg/clipboard-formats)). (4) Close the clipboard and record `seq = GetClipboardSequenceNumber()`. (5) Wait 40 ms, send Ctrl+V as one batch, and wait 250 ms. (6) If the sequence number is still `seq`, nobody else wrote (the equivalent of Swift's "the board still holds the agent's text", `:1021`), so empty the clipboard. If there was previous text, set it back **with the same three exclusion formats**, so restoring never re-adds anything to history or sync. If there was none, the clipboard stays empty, as on the Mac. |

**Physical-state check, before every batch.** This check is Windows only and deterministic. It reads the current key state; it doesn't guess whether the owner is present.
- SendInput "does not reset the keyboard's current state … check the keyboard's state with GetAsyncKeyState … and correct as necessary" ([SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)).
- `Post` reads `GetAsyncKeyState` for `VK_CONTROL`, `VK_MENU`, `VK_SHIFT`, `VK_LWIN`, `VK_RWIN`, `VK_LBUTTON`, `VK_RBUTTON` and `VK_MBUTTON`. For the buttons it reports physical state ([GetAsyncKeyState](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getasynckeystate)).
- If any of them is down and the helper isn't holding it itself, refuse with `A key or button is held down on the PC. The agent's input would mix with it. Try again in a moment.` (`retry`).
- This covers typed chunks (Alt held turns text into menu mnemonics), drags (Ctrl turns a move into a copy), scrolls (Ctrl zooms), keys, clicks and paste.
- The helper never "corrects" by sending key-ups for the owner's keys.
- Microsoft lists cases where the call returns zero, among them "UI Privilege Isolation (UIPI) prevents the calling thread from accessing the foreground thread" (same page). A zero is therefore not proof that nothing is held. Rule F (§5.3) closes that gap.

### 5.3 UIPI and elevated windows

- **Why:** SendInput "is subject to UIPI. Applications are permitted to inject input only into applications that are at an equal or lesser integrity level", and the failure is invisible: "neither GetLastError nor the return value will indicate the failure was caused by UIPI blocking" ([SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput)). Windows has four integrity levels, and elevated users receive High ([Mandatory Integrity Control](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)). An app without UIAccess "cannot access elevated … process UI" ([Security considerations for assistive technologies](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)).
- **Target integrity:** `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)`, `OpenProcessToken(TOKEN_QUERY)`, then `GetTokenInformation(TokenIntegrityLevel)`, giving the last sub-authority RID.
- **Rule T** (every pointer target, focus target and UIA action target):
  - If the target is at High (`0x3000`) or above, or above the helper's own level, refuse with `That window runs as administrator. Windows keeps other programs' clicks and keys out of it, so the agent leaves it to you at the PC.` (`blocked`).
  - If the process or token can't be opened, refuse with `That window belongs to a program Reach can't identify. The agent leaves it alone.` (`blocked`).
- **Rule F** (new; checked in `Post` before every batch): read the integrity of the foreground window's process (`GetForegroundWindow`, then `GA_ROOT`).
  - **No foreground window** (`GetForegroundWindow` returns NULL, as during a switch) counts as "nothing elevated in front". There is then no foreground thread for UIPI to shield, and `Focus()` refuses typing anyway (`Nothing is ready for typing.`).
  - If the foreground process's level is above the helper's own, or the process or its token can't be opened, refuse **every** input batch, pointer included, with `A window running as administrator is in front on the PC. Windows hides the keyboard from Reach while it is, so the agent waits until the owner switches away from it.` (`paused`). Under that foreground the physical-state check can't be trusted (§5.2), so nothing is sent. Reads and screenshots continue.
- **Rule S** (the helper's own token): if its level is High or above, which happens when Reach runs as administrator or when UAC is off for an admin user:
  - `rules` replies `elevated:true`;
  - every `act`, `open*`, `focus`, `find` and `menu` press is refused with `Reach is running as administrator (or User Account Control is off). Agents act only from a standard Reach session.` (`blocked`);
  - screenshots, `front`, `windows` and `read` still work, because they inject nothing.
- **Why all three:** UIPI is the mechanism; the parity table's guardrail ("Refused with the reason, as a guardrail", `docs/WINDOWS_AGENT_PARITY.md`) is the policy. A signed `uiAccess` helper installed in Program Files ([same doc](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-securityoverview)) stays out of scope.
- **Secure desktop:** the check in §4.3 step 1 also runs before every input op. UAC prompts on the secure desktop and the lock screen are unreachable by design.

### 5.4 Holding and letting go (port of `post`/`letGo`, `agent-desktop.swift:800-842`)

```text
static readonly object heldLock;  static bool stopping;
static Dictionary<int,POINT> heldButtons;   // 0=left, 1=right -> last point posted for them
static HashSet<ushort> heldKeys;            // VKs down
Post(batch, pauseMs): pre-batch checks (§5.2, §5.3);
                      lock { if stopping return; SendInput(batch); update held from each event; }
                      then sleep(pauseMs) outside the lock
LetGo(): lock { stopping = true; for each held button: SendInput([MOVE abs to held point + xUP]);
                for each held key: SendInput([key UP]); clear }
```

- `LetGo()` runs, followed by `TerminateProcess(self)`, on any of three triggers:
  - stdin EOF (the server's `stop()`, or Node dying, which closes the pipe);
  - Reach's process ending (`watchdog`);
  - a wedged shell or clipboard thread (§2.2).

  A long `holdMs`, or a drag sleeping on the main thread, doesn't delay this, because the sleep happens outside the lock.
- **Why detached** (§12 item 2): libuv puts every non-detached child into one job with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. When Node dies, that job closes and kills the helper before it can let go, so a held button would stay down. Detached children (`DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`) are not assigned to that job (libuv `src/win/process.c`), so they survive Node long enough to see EOF and let go.
- Server side: on win32, `AgentDesktopHelper.stop()` waits **1500 ms** after `stdin.end()` before calling `child.kill()`. On Windows that kill is a `TerminateProcess` (libuv), after which nothing can release a held button (§12). macOS keeps 300 ms.
- Not covered: the helper being killed outright (Task Manager, antivirus) mid-drag. Then nothing runs, and a held button stays down until the next real click (§15).

## 6. Focus and the foreground lock (question 4)

Microsoft's rules ([SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)): a process can set the foreground window only if no menus are active, the foreground process hasn't locked the foreground, **and** at least one of these holds:

- the lock timeout has expired;
- it is the foreground process;
- it was started by the foreground process;
- there is no foreground window;
- it received the last input event;
- it is being debugged.

"An application cannot force a window to the foreground while the user is working with another window. Instead, Windows flashes the taskbar button." The helper is a background child of Node, so these rules often deny it. Injecting input doesn't help, because the target receives that input, not the helper.

**Design** (port of `focusWindow`, `agent-desktop.swift:1612-1657`, and `waitFront`, `1196-1208`):

1. **Resolve the reference.** Turn the `w-…` ref into `(hwnd, pid, processCreationTime)`. Check `IsWindow`, the same pid and creation time (`GetProcessTimes`), and that the window is still a top-level root. Otherwise reply `That window is gone. List windows again.` (`retry`). Legacy `pid:index` ids are never produced on Windows and are refused the same way.
2. **Policy:** `appReason`, `windowTitleReason` on the effective title (§7.4), Reach's windows (§7.3), the title match (`sameTitle` or prefix, Swift `:1630`), and Rule T.
3. **Restore.** If `IsIconic`, call `ShowWindowAsync(hwnd, SW_RESTORE)`.
4. **Raise without activating**, the equivalent of Swift's `AXRaiseAction` (`agent-desktop.swift:1632`): `SetWindowPos(hwnd, HWND_TOP, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_ASYNCWINDOWPOS)`. The async flag keeps a hung target from blocking the helper. Whether Windows lets a background process reorder another process's window is measured on the runner (§13.4 item 6). If it doesn't, the result is recorded in §15, not worked around.
5. **Activate:** call `SetForegroundWindow(hwnd)` once. There is **no** UIA `SetFocus` fallback: UIA's focus code for top-level windows may synthesize keys to get round the foreground lock, which would bypass `Post` and the "no synthetic Alt" rule. A source test forbids `SetFocus` on any UIA element.
6. **Wait and reply.** Poll for up to 1.5 s in total. The reply carries `front: GetForegroundWindow root == hwnd`.
   - The server already passes `front:false` on to the agent (`agent-desktop.mjs:605`).
   - With the window raised, the agent clicks inside it. That click is real input routed by Windows, so it activates the window normally, and it passes `CheckPoint` because the window is allowed.
   - The taskbar button is **not** a way out in Apps mode: the taskbar is a system surface, refused there (§7.5). If the raise was denied and the window is still covered by non-allowed windows, the agent can't reach it until the owner brings it forward (§15).
7. **Tabs.** A tab (by title or `t-` ref) is chosen through UIA: `SelectionItemPattern.Select()`, falling back to `InvokePattern.Invoke()`, then `LegacyIAccessible.DoDefaultAction()`. It is never chosen with the pointer, matching Swift's `AXPress` (`:1651`).

**Explicitly not used:** `AttachThreadInput`, synthetic Alt presses, `SwitchToThisWindow`, `SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT)`, `LockSetForegroundWindow`, `AllowSetForegroundWindow` tricks, and UIA `SetFocus`. Success rates for `focus`, `open`, `open-url` and `open-file` are measured on the real PC (§13.5). A low rate is a documented gap, not a reason to add hacks.

## 7. Identity and per-event target checks

### 7.1 Process identity: `Identity(pid)`, replacing `appInfo` (`agent-desktop.swift:515-518`)

| Field | Packaged process (`GetApplicationUserModelId` succeeds and the image check below passes) | Unpackaged process |
|---|---|---|
| `bundle` | AUMID (`PFN!AppId`) | `exe:` + lowercase file name |
| `path` (policy path) | `shell:AppsFolder\<AUMID>` (the catalog id) | canonical image path: `QueryFullProcessImageNameW(0)`, then `GetLongPathNameW` |
| `image` | real image path, used for system-surface and publisher checks | same as `path` |
| `name` | package display name, else `FileDescription`, else file base name | `FileDescription` from the version resource, else file base name |
| `publisher` | package publisher's display name | Authenticode signer CN from `WinVerifyTrust` (below) |
| `integrity` | §5.3 | §5.3 |

**Packaged identity is checked, not assumed.** A process started in a package's context can carry that package's identity while running any executable. So the identity counts as packaged only if:
- `GetPackageFullName(hProcess)` gives the package;
- `GetPackagePathByFullName2` gives its install folder and, where the package uses one, its effective folder ([GetPackagePathByFullName2](https://learn.microsoft.com/en-us/windows/win32/api/appmodel/nf-appmodel-getpackagepathbyfullname2));
- the canonical image path lies inside one of those folders, compared case-insensitively on whole path segments.

Otherwise the identity is **unknown**: refused for input, masked in shots. Packages with an external location (sparse packages) fail this check and are refused (§15).

**Publisher.**
- `WinVerifyTrust` runs with `WINTRUST_ACTION_GENERIC_VERIFY_V2`, an embedded signature, `WTD_REVOKE_NONE` and `WTD_CACHE_ONLY_URL_RETRIEVAL`, so nothing is fetched over the network. Then the signer certificate's simple name is read.
- The check runs on a worker thread with a **500 ms deadline**. Results are cached by (volume serial, file index, size, last-write time), never by PID.
- An unsigned file gives `""`. A missed deadline or any other failure gives **unknown**. When `protectedPublishers` is non-empty, an unknown publisher makes the window count as protected for that request. Nothing is cached for it, so the check is tried again next time.

**Embedding hosts** (UIA elements only; §4.3 attributes windows).
- Some elements report the process that hosts them rather than the app: WebView2 content reports `msedgewebview2.exe`, and a packaged app's title bar reports `ApplicationFrameHost.exe`.
- For such an element, the helper walks up UIA parents (at most 60) to the nearest element with a non-zero `NativeWindowHandle`, then takes `GetAncestor(hwnd, GA_ROOT)`. The element is attributed to **that root window's identity** when all of these hold:
  - the element's own process is a verified embedding host. For `msedgewebview2.exe`, the image must lie under the Evergreen WebView2 runtime folder (`%ProgramFiles(x86)%\Microsoft\EdgeWebView\Application\…`) and be signed by Microsoft. For `ApplicationFrameHost.exe`, the image must lie under `%SystemRoot%\System32`;
  - the root window belongs to a different, known process;
  - the element's own identity is not itself protected or hidden.
- Apps that ship a **fixed-version** WebView2 runtime inside their own folder fail the image check and are refused (§15).

Swift never caches identity by PID (`agent-desktop.swift:381-382`, `402-403`), and neither does C#.

`trustedMailIdentity` has no Windows equivalent. `verifiedMail` is always `false`, which is **stricter**: Mail subjects mentioning "reach" are hidden, as on a Mac whose Mail can't be verified. `trustedCursorIdentity` isn't needed, because the cursor is not a window on Windows.

### 7.2 Pure policy port: the `// BEGIN PURE DESKTOP POLICY` section (Swift `:18-355`)

The port is line for line, with these rules for fidelity:

- **`Lower(s)`** = `s.Normalize(FormKC)`, followed by a lowercase that matches Swift and JS: `U+0130 → "i\u0307"`, final sigma by context, otherwise `char.ToLowerInvariant`.
- **Comparisons:** every `Contains`, `StartsWith`, `EndsWith`, `IndexOf` and `==` uses `StringComparison.Ordinal`, because .NET Framework's defaults are culture-sensitive. A source test forbids the defaults inside the section.
- **Regex:** `new Regex(src, IgnoreCase | CultureInvariant, TimeSpan.FromMilliseconds(100))`.
  - A pattern that fails to compile is treated as missing, so `moneyHas` refuses for `move/commit/fieldDeny` (`:249-252`).
  - A `RegexMatchTimeoutException` counts as "matched" for refusing kinds and as "not matched" for allowing kinds, which is fail-closed.
- **`reachHostSubject`, `moneyHost` and `moneyPage`** use a `// BEGIN PURE URL` section containing:
  - an RFC 3986 Appendix B splitter;
  - a validity check equivalent to `URLComponents(string:)`: only RFC 3986 characters, valid `%XX`, brackets only around IPv6 hosts;
  - a strict IPv4 parser (4 decimal octets 0–255, no leading zeros), matching BSD `inet_pton` and Node `isIP`;
  - a strict IPv6 parser (one `::`, at most 8 groups, optional IPv4 tail, no zone).

  `System.Uri` is **not** used: it canonicalizes paths and accepts legacy IPv4 forms like `127.1`.
- **Characters:** `Character.isLetter`, `isNumber` and `isWhitespace` map to `char.IsLetter(string, i)`, `char.IsNumber(string, i)` and `char.IsWhiteSpace`, surrogate-aware.
- **`hideSecrets`:** `Regex.Replace(text, Regex.Escape(secret), "•••", IgnoreCase|CultureInvariant)`. The three-character threshold uses `StringInfo.LengthInTextElements`.
- **Windows extensions inside the section.** Each is a no-op on Mac data, so the shared corpus is unaffected: Mac ids contain no `!`, `\` or `.exe`, and no Mac bundle is a Windows settings id.
  - `fileName(path)` splits on `/` and `\`, and strips `.app` and `.exe`.
  - `protectedApp(bundle, name, path, rules, publisher = "")`:
    - also matches an id entry `e` when `id.StartsWith(e + "!")`, so a package family name protects every app of that package (`agilebits.1password_xxxx` matches `agilebits.1password_xxxx!app`);
    - also refuses with `protectedReason` when `rules.protectedPublishers` contains `Lower(publisher)` and the publisher is non-empty.
  - `settingsApp(bundle)` also accepts `windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel`, `exe:systemsettings.exe`, and the pseudo-bundle `windows.controlpanel`. The native code passes that pseudo-bundle to `titleReason` for Explorer windows showing Control Panel (§7.4); it never appears in an identity.
  - `pointerIdentityKnown` also treats `dwm`, `csrss` and "desktop window manager" identities as unknown: they are the Windows compositor.
  - `secureKeyAllowed(name, command)` is unchanged; `command` = any Ctrl-mapped modifier.

**Native-only rules, kept out of the pure section** so that Swift, C# and JS still decide the shared corpus identically: Reach's windows (§7.3), unreadable titles (§7.4), effective titles (§7.4), terminal window classes (§7.4) and Explorer's fields (§7.8).

### 7.3 Reach's own windows (new; resolves the blocker)

On the Mac, Reach's Terminal window is recognised by its title, which `server/index.mjs:5545-5547` sets on darwin only. On Windows nothing sets a title, and a shell or terminal can change it anyway. So Windows identifies Reach's window **by console attachment** and uses the title only as a second signal.

**What the server sends** (win32 only, §12 item 7): `rules.reach = {pid: process.pid, console: process.stdout.isTTY === true}`.

**Why one console is enough:** Reach's process tree shares one console. `reach.cmd` runs `bootstrap.ps1`, which runs `node bin/reach.mjs`, and the supervisor then starts Reach with `stdio: "inherit"` (`scripts/supervise.mjs:52`). So cmd, PowerShell, the supervisor and Reach are all attached to Reach's console.

**Probe**, at each `rules`, and again (at most every 5 s) whenever the resolved window is no longer valid:

1. **Pin the pid.** Open Reach's process (the same handle the watchdog holds), so its pid can't be reused while the helper runs.
2. **Attach briefly.** Install a console control handler that returns TRUE for every event, so a Ctrl+C or Ctrl+Break in Reach's console while the helper is attached doesn't end the helper. Then call `AttachConsole(pid)`, `hwnd = GetConsoleWindow()`, `GetClassNameW(hwnd)` and `FreeConsole()`.
   - The helper is spawned detached (§12), so it has no console of its own. Microsoft: "If the calling process is already attached to a console, the error code returned is ERROR_ACCESS_DENIED. If the specified process does not have a console, the error code returned is ERROR_INVALID_HANDLE" ([AttachConsole](https://learn.microsoft.com/en-us/windows/console/attachconsole)).
   - The helper's stdin and stdout were opened as pipes before the probe (§2.4) and are never re-read from `GetStdHandle`. A CI test confirms that requests still flow after a probe.
3. **Outcomes**, reported in the `rules` reply as `reachConsole`:

   | Outcome | `reachConsole` | Reach's windows |
   |---|---|---|
   | Class `ConsoleWindowClass` (classic console) | `classic` | Exactly `hwnd`. For console windows, Windows reports a client process (cmd, PowerShell, node) as the owner, so matching by handle is the only exact test. |
   | Class `PseudoConsoleWindow` (Reach runs inside a terminal: Windows Terminal, VS Code or another ConPTY host) | `pseudo` | Microsoft: for a pseudo console, `GetConsoleWindow` "returns a window handle for message queue purposes only" ([GetConsoleWindow](https://learn.microsoft.com/en-us/windows/console/getconsolewindow)). No documented API says which terminal window shows Reach's tab, so the whole **host app** counts as Reach's. How it is found is described below the table. |
   | `AttachConsole` fails with `ERROR_INVALID_HANDLE` and `console:false` (service, background) | `none` | None: Reach has no console window. |
   | Any other failure, or `console:true` with no console found | `unknown` | Fail-closed: every console window and every window of a terminal-like app counts as Reach's (the broad rule below). |

   **Finding the host app** (`pseudo` only). While still attached, the helper calls `GetConsoleProcessList`, which gives the processes attached to Reach's console: cmd, PowerShell, the supervisor and Reach. Then:
   1. **Walk up.** From each of those processes, walk parent pids, using a `CreateToolhelp32Snapshot` process snapshot. Each parent must have been created **before** its child (`GetProcessTimes`), which rules out a reused pid. A parent that fails this check ends the walk.
   2. **Pick the host:** the first ancestor that meets all three conditions:
      - it is not itself attached to Reach's console;
      - it is not a Windows shell process (`explorer.exe`, `svchost.exe`, `sihost.exe` or `services.exe`; reaching one ends the walk with no host);
      - it owns a visible top-level window.

      That is `WindowsTerminal.exe` for Windows Terminal. For VS Code it is the main `Code.exe`: the pty-host process above the shell owns no window, so the walk goes past it.
   3. **Reach's windows** = every top-level window of that host process.
   4. **Fallback by class.** If no host was found, as on default-terminal handoff (the Windows 11 default when `reach.cmd` is double-clicked), every window of class `CASCADIA_HOSTING_WINDOW_CLASS` (Windows Terminal) counts as Reach's, if any exists.
   5. **Broad rule**, if neither of those resolves: every top-level window of every terminal-like process counts as Reach's. Terminal-like means by window class (`CASCADIA_HOSTING_WINDOW_CLASS`, `ConsoleWindowClass`, `PseudoConsoleWindow` or `mintty`) or by identity (A's `terminalLike` list). If A carries the Mac's list over, that list includes VS Code, Cursor, the JetBrains IDEs, Claude and Codex, so they all close too.

   The `rules` reply reports which step decided (`reachHost: "process" | "class" | "broad"`), and CI records it. Narrowing the host app down to one window is §16 D3.
4. **Second signal: titles.** The pure `titleReason` still runs on every title (§7.4). On win32 the server sets `process.title = "Reach"` when stdout is a TTY. Node sets the console title, and terminals show it on the tab unless their profile suppresses application titles (recorded on the runner). A window whose title names Reach is Reach's, as on the Mac.

**Where it applies.** All of these apply in non-Full modes only, as on the Mac, where every Reach guard is `rules.mode != "full"`:
- `check()` refuses with `reachReason` for any window or element whose root is one of Reach's windows. That covers the pointer (`WindowAt` and `RouteAt`), `Focus()` for type and key, `focus`, `menus`, `pressMenu`, `elements`, `find`, `read` and `clickControl`.
- `windows` leaves Reach's windows out, and `front` reports them as blocked.
- Screenshots in View and Apps exclude them (§4.3 step 2).
- **`hostsReach(process)`** (port of `agent-desktop.swift:727-731`) is true when any top-level window of the process is one of Reach's windows, or has a title that gives `reachReason`, or has a UIA `TabItem` whose name does. The tab check covers Windows Terminal tabs; it is bounded to 0.25 s, and hitting the bound counts as hosting Reach.

### 7.4 Titles, effective titles and terminal classes

**`TitleOf(hwnd)`:**
1. Call `SetLastError(0)`, then `InternalGetWindowText`. The reset matters because .NET Framework's P/Invoke doesn't clear the last error before a call, so a stale code could otherwise mark an empty title as unreadable.
   - `InternalGetWindowText` "obtains the window text directly from the window structure associated with the specified window's handle", unlike `GetWindowText`, which sends `WM_GETTEXT` ([InternalGetWindowText](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-internalgetwindowtext)).
   - That matters because, for another process's window, `GetWindowText` "retrieves the window caption text. If the window does not have a caption, the return value is a null string" ([GetWindowTextW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowtextw)). A captionless `WS_POPUP` titled "Password Manager" would otherwise pass every title check.
2. If that is empty and the window is visible on the monitor, use the UIA `Name` of `ElementFromHandle(hwnd)`, under the 500 ms transaction timeout, cached per hwnd for 1 s.
3. **Unreadable** means `InternalGetWindowText` returns 0 with a non-zero `GetLastError`, or UIA fails or times out.
   - For a browser- or terminal-like window, an unreadable title means the window is refused for input and excluded from shots.
   - For other windows it counts as an empty title, as on the Mac (`titleReason` returns nil for an empty title, `agent-desktop.swift:102`), because their identity checks still apply.

**Effective titles** are what `windowTitleReason` receives:
- **Settings** (`settingsApp(bundle)`): the window title is just "Settings", whatever the page, so the effective title is `Settings — <page>`.
  - `<page>` is read through UIA from the selected item of the navigation list (`SelectionItemPattern.IsSelected`), plus the page's breadcrumb or level-1 heading. Example: `Settings — Privacy & security > Location`.
  - Which elements carry these on `windows-2025` and Windows 11 is confirmed on the runner and recorded in a test (§13.4 item 4).
  - **If the page can't be read** (UIA timeout, no selected item and no heading), the window is refused with `protectedReason` and masked. Otherwise the pure `privatePanes` match runs on the effective title.
- **Control Panel in File Explorer:** for an explorer.exe `CabinetWClass` window, the shell thread maps the hwnd to its location through `IShellWindows` and gets the location's parsing name from `SHGetNameFromIDList(SIGDN_DESKTOPABSOLUTEPARSING)`.
  - If the name starts with the Control Panel namespace (`::{26EE0668-A00A-44D7-9371-BEB064C98683}` or `::{21EC2020-3AEA-1069-A2DD-08002B30309D}`), `titleReason(title, "windows.controlpanel", rules)` runs. `privatePanes` then apply to Network Connections, Windows Defender Firewall, User Accounts and similar.
  - If the location can't be read, the same check runs anyway (fail-closed). A folder whose title happens to contain a private word, such as "Network", is then masked.
  - Legacy applets that run as their own processes (`rundll32`, `SystemPropertiesRemote`, `netplwiz`, `mmc`) are protected by name (§1.3).

**Terminal-like.** `terminalLikeApp` (pure) runs on the identity, as on the Mac. In addition (native), a foreground root of window class `ConsoleWindowClass`, `PseudoConsoleWindow`, `CASCADIA_HOSTING_WINDOW_CLASS` or `mintty` is terminal-like whatever process Windows reports. This matters because a console window running `node.exe` or `python.exe` reports that process, not conhost. `front.terminalLike` carries the result to the server's typed-text check.

### 7.5 System surfaces

Apps mode refuses them (`notAllowedReason`). Other modes check only Reach mentions and guarded words. This is Swift's branch at `agent-desktop.swift:670-699`.

Windows system surfaces are identified by an **image path under `%SystemRoot%`** (writable only by administrators):
- explorer.exe windows that are not `CabinetWClass` and not owned by one (§7.8): `Shell_TrayWnd`, `Shell_SecondaryTrayWnd`, `Progman`, `WorkerW`, `NotifyIconOverflowWindow`, the `#32770` "Shut Down Windows" dialog, thumbnail overlays, and any other explorer.exe window;
- `StartMenuExperienceHost.exe`, `SearchHost.exe`, `SearchApp.exe`, `ShellExperienceHost.exe`, `ShellHost.exe`, `Widgets.exe`, `TextInputHost.exe` and `LockApp.exe`.

**The Dock-item URL check** (`:691-696`) has no Windows source. Taskbar labels go only through the `mentionsReach` and guarded-word checks, on UIA `Name`, `HelpText` and `FullDescription`.

### 7.6 `CheckPoint(point, rules, expected, activate)` (port of `agent-desktop.swift:657-725`)

Three views of the point are **all** checked, and any refusal wins:

1. **`WindowAt(point)`**, the "window server view" (port of `:633-648`). Walk the inventory (§4.3) in band order and take the first visible, uncloaked, non-iconic window with alpha > 0 whose frame (and region, if any) contains the point.
   - **Click-through overlays are included**, as Swift includes every layer.
   - If the inventory is still incomplete after its retry, View and Apps refuse with `The window at this point changed while it was checked. Look again.` (`retry`).
   - Full control uses `L1` alone, which is all its compositor allowance needs (`:723`).
2. **`RouteAt(point)`**, Windows only: `WindowFromPoint(point)` then `GetAncestor(GA_ROOT)`, which is the window Windows will actually route the click to. It skips hidden and disabled windows ([WindowFromPoint](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-windowfrompoint)).
   - If its process differs from `WindowAt`'s and `WindowAt`'s window isn't `WS_EX_TRANSPARENT`, refuse with `The window at this point changed while it was checked. Look again.` (`retry`). ApplicationFrameHost frames resolve as in §4.3 on both sides.
   - It is also checked by `check()`, the Reach-window rule and Rule T.
3. **`ElementAt(point)`**: `IUIAutomation.ElementFromPoint`, then `Seen(element)` (port of `seen`, `:521-558`, §8.3), with embedding-host attribution (§7.1).

Then exactly the Swift branches:
- **System surfaces:** §7.5.
- **Unnamed windows** fall back to `hostsReach` (§7.3).
- **Bank sites:** `moneyAt` (§10.2), plus `moneyClickReason` when `activate` is set.
- **Identity resolution:** `pointerIdentityKnown`, `checkExpected` (recorded shortcuts, `agent-desktop.mjs:740`, `agent-shortcuts.mjs:60-78`) and the Full-mode compositor allowance (`:723`), all unchanged.

### 7.7 `Focus(rules, appOnly)` and keys (ports of `agent-desktop.swift:737-772` and `1042-1063`)

**Focus:**
- **Front:** `GetForegroundWindow`, then `GA_ROOT`, gives the front identity and its effective title. If there is no foreground window or its pid is 0, reply `Nothing is ready for typing.` (`retry`).
- **Focused element:** `IUIAutomation.GetFocusedElement()` gives its pid and `Seen`. As a Windows cross-check, `GetGUIThreadInfo(foregroundThread).hwndFocus`, when present, must belong to the same process.
- The branches (pid mismatch, the `appOnly`/Full fallback, the element and app checks) are identical to Swift.
- On top of those come Reach's windows (§7.3), Explorer's fields (§7.8) and Rule T on the foreground process, because keyboard input goes to "the foreground thread's message queue" ([KEYBDINPUT](https://learn.microsoft.com/en-us/windows/win32/api/winuser/ns-winuser-keybdinput)).

**Keys:**
- `command` = any of `cmd/command/meta/control/ctrl`. `control` = `false`, since Ctrl is the only shortcut modifier on Windows. `option` = `option/alt`.
- **Reach close guard**, in non-Full modes, when `hostsReach(target)` is true. Refuse with `reachReason` for:
  - `command` with `q`, `w` or `d`;
  - `command` with `c` (Ctrl+C stops a console program);
  - `command`+`shift` with `w` (closes a Windows Terminal tab);
  - `option` with `f4` (closes the window).

  Ctrl+Break isn't in the server's key set (`agent-desktop.mjs:20-21`). Input into Reach's own windows is refused anyway (§7.3); this guard covers the rest of a process that hosts Reach.
- **Shut-down guard**, in non-Full modes: Alt+F4 while the foreground root is a system surface (the desktop, the taskbar) is refused with `The PC's shut-down and sign-out stay with the owner.` This is the equivalent of `appleMenuReason` (`agent-desktop.swift:1733`).
- **Developer-tools guard**, in non-Full modes, for browsers. Refuse with `protectedReason` for:
  - Ctrl+Shift+I/J/C (Chromium and Firefox);
  - Ctrl+Shift+K/E/Z (Firefox's web console, network and debugger tools);
  - Ctrl+Alt+I/J/C (the Mac rule, mapped).

  F12 isn't in the server's key set. The Mac has the same Firefox gap (§16 D7).
- **Secure fields:** `secureKeyAllowed`, exactly as in Swift.
- **Bank sites:** `moneyKeyReason`, with `moneyBrowserCommands` unchanged. On Windows these are Ctrl+L/W/F/C/A/T; `[` and `]` are harmless there.

### 7.8 File Explorer and other shell fields (new)

The Mac's Finder runs no commands from its fields. File Explorer and every shell address band do. In non-Full modes:

1. **Explorer the app is only its folder windows.** Allowing `exe:explorer.exe` covers `CabinetWClass` windows and the windows they own (properties, copy progress, confirmations). Every other explorer.exe window is a system surface (§7.5): it is never allowed, never painted in Apps mode, and judged as a system surface in `Focus()`.
2. **No text into fields that run things.** If the focused element sits inside any of these:
   - a shell address band: an ancestor with class `Address Band Root`, or the Windows 11 File Explorer address bar (its UIA `AutomationId` is confirmed on the runner and pinned in a test);
   - the Run dialog: a `#32770` titled "Run" and owned by explorer.exe;
   - File Explorer's search box;

   then `type`, `paste` and `fill` are refused, and `key` is allowed only for Tab, Escape and the arrows. The refusal says `That box runs programs on the PC. Open folders by clicking them, or use open_file with reveal.` This holds in any process, because the Open and Save dialogs of allowed apps carry the same address band.
3. **Fail-closed inside Explorer.** In an explorer.exe app window, the only element that accepts text is an editable element inside the folder view (an ancestor of class `SHELLDLL_DefView`, which is the rename box). Every other field refuses text.
4. **Shut down:** Alt+F4 on the desktop or taskbar is refused (§7.7).

Double-clicking a `.bat` or `.exe` in an allowed Explorer still runs it. The Mac is the same: a Finder double-click on a `.command` file runs it in Terminal. Whether to offer Explorer in the Apps picker at all is §16 D5.

## 8. UI Automation design

### 8.1 Interop

- **Declarations:** hand-declared `[ComImport, Guid(...), InterfaceType(InterfaceIsIUnknown)]` interfaces in `// BEGIN NATIVE UIA`.
  - Every member is declared as a method with its **IDL name**, including `get_`/`put_` prefixes, **in IDL vtable order**, up to the last member used. Unused slots stay declared, with exact signatures.
  - HRESULT failures throw `COMException`, which is caught as `retry` or `unavailable`.
- **Interfaces:** `IUIAutomation`, `IUIAutomation2`, `IUIAutomationElement`, `IUIAutomationElementArray`, `IUIAutomationCacheRequest`, `IUIAutomationCondition`, `IUIAutomationTreeWalker`, `IUIAutomationInvokePattern`, `IUIAutomationValuePattern`, `IUIAutomationTogglePattern`, `IUIAutomationSelectionItemPattern`, `IUIAutomationExpandCollapsePattern`, `IUIAutomationScrollItemPattern`, `IUIAutomationLegacyIAccessiblePattern` and `IUIAutomationWindowPattern`. Event handlers use `IUIAutomationFocusChangedEventHandler`, `IUIAutomationStructureChangedEventHandler` and `IUIAutomationPropertyChangedEventHandler`.
- **Client API:** the COM `CUIAutomation`/`IUIAutomation` gateway ([Creating the CUIAutomation object](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-creatingcuiautomation)). The documentation for the managed `System.Windows.Automation` points readers to the Win32 API "for the latest information" ([UIA overview, .NET](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-overview)).
- **`SetFocus` is never called** on any element (§6). A source test enforces this.
- **Caching** cuts cross-process calls: one call returns an element plus the requested properties and patterns ([UIA clients overview](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-clientsoverview)). Every walk uses **two passes**, so a password field's value is never requested:

  | Pass | Properties | How |
  |---|---|---|
  | 1, structure | ControlType 30003, Name 30005, LocalizedControlType 30004, AutomationId 30011, ClassName 30012, BoundingRectangle 30001, ProcessId 30002, NativeWindowHandle 30020, IsEnabled 30010, IsOffscreen 30022, **IsPassword 30019**, HelpText 30013, FullDescription 30159, HeadingLevel 30173, IsDialog 30174, and the IsInvoke/Toggle/SelectionItem/ExpandCollapse/Value-PatternAvailable flags. **No ValueValue.** | `BuildUpdatedCache` per container, scope `TreeScope_Element \| TreeScope_Children`; read `GetCachedChildren`. |
  | 2, values | ValueValue 30045, ValueIsReadOnly 30046 | Only for containers whose pass-1 children include a value-bearing element. `FindAllBuildCache(TreeScope_Children, AndCondition(IsPassword == false, IsValuePatternAvailable == true), valueRequest)`. The condition is part of the request, so password elements are left out of the result. |

- **Never** read `ValuePattern.Value`, ValueValue or `TextPattern` from an element whose `IsPassword` is true. `IsPassword` exists so screen readers can decide "whether the text content of a control should be read aloud" ([IsPassword](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomationelement-get_currentispassword)).
  - All value reads go through one function, `ValueOf(element)`, which checks the cached `IsPassword` first.
  - A source test forbids ValueValue (30045) in any CacheRequest built outside the pass-2 helper, and forbids any direct `CurrentValue` read.

### 8.2 Role mapping (UIA ControlType to AX role string)

Every shared set uses AX role names (`moneyActionRoles`, `moneyFieldRoles`, `labelRoles`, `fieldRoles`, and `FIELD_ROLES` in `agent-desktop.mjs:44`), so the helper emits AX names. Agents then see the same words on both OSes.

| UIA | AX | | UIA | AX |
|---|---|---|---|---|
| Button 50000 | AXButton | | MenuBar 50010 | AXMenuBar |
| SplitButton 50031 | AXMenuButton | | MenuItem 50011 (parent MenuBar) | AXMenuBarItem |
| Hyperlink 50005 | AXLink | | MenuItem 50011 (other) | AXMenuItem |
| CheckBox 50002 (LocalizedControlType "toggle switch") | AXSwitch | | Menu 50009 | AXMenu (skipped, as Swift `:1374`) |
| CheckBox 50002 | AXCheckBox | | Tab 50018 | AXTabGroup |
| RadioButton 50013 | AXRadioButton | | TabItem 50019 | AXTab |
| ComboBox 50003, editable value | AXComboBox | | Slider 50015 | AXSlider |
| ComboBox 50003, otherwise | AXPopUpButton | | Spinner 50016 | AXIncrementor |
| Edit 50004 with IsPassword | AXSecureTextField | | Text 50020 (HeadingLevel set or LocalizedControlType "heading") | AXHeading, read as text |
| Edit 50004 with "search" in LocalizedControlType or AriaRole `searchbox` | AXSearchField | | Text 50020 | AXStaticText |
| Edit 50004 | AXTextField | | Image 50006 | AXImage |
| Document 50030 that is a web page (§10.2) | AXWebArea | | List 50008 | AXList |
| Document 50030, editable | AXTextArea | | ListItem / TreeItem / DataItem | AXRow |
| Document 50030, otherwise | AXGroup | | Table / DataGrid | AXTable |
| ToolBar 50021 | AXToolbar | | Group / Pane / Custom / other | AXGroup |
| Window 50032 | AXWindow | | | |

`pressable(element)` (Swift `:569-572`) is true when Invoke, Toggle, SelectionItem or ExpandCollapse is available, or when `LegacyIAccessible.DefaultAction` is non-empty.

### 8.3 `Seen(element)` and names

- **`Seen(element)`:** walk parents with `ControlViewWalker`, up to 60 steps (`:529`).
  - Identity comes from the element's `ProcessId`, with embedding-host attribution (§7.1).
  - Web-page Documents contribute `url` and `frames` (§10.2).
  - The walk stops at the element whose `NativeWindowHandle` is a top-level root. That root's effective title (§7.4) becomes `title`.
  - Labels and the control are taken as in `:538-550`.
  - The address-bar URL comes from a focused Edit whose value (via `ValueOf`) contains `://` or `:` (`:553-556`).
- **`labelName(element, role, secure)`** (Swift `:1325-1338`) is the first non-empty of:
  - Name;
  - FullDescription;
  - for fields, HelpText (Chromium exposes placeholders there);
  - for Button, PopUpButton, MenuButton, Tab, RadioButton and CheckBox, the Value (via `ValueOf`). Link is excluded, because its Value is its href;
  - HelpText.

  Whitespace is collapsed, the result is cut to at most 120 characters, and `hideSecrets` is applied.

### 8.4 Reads (ports)

- **`ReadScreen`** (`:1341-1433`):
  - The root is the foreground root window's element. There is no separate menu-bar root, because the Win32 menu bar sits inside the window element.
  - `check()` runs on the window first, including the Reach-window rule.
  - Bounds: 6000 nodes, 400 controls, 0.8 s, 500 texts and 20,000 characters.
  - **Visible** means `BoundingRectangle ∩ monitor` is at least 2 px **and** `!IsOffscreen`.
  - Field values for non-password fields come from pass 2 (§8.1).
  - Bank pages mask account numbers.
  - Reading order and truncation are exactly as in Swift.
- **`elements`** = `snapshotPayload` (`:1766-1789`). Snapshot ids are 8 hex digits; refs are `e-`, `w-` or `t-` plus a UUID.
- **References** (port of `rememberElement`/`referencedControl`, `:1274-1301`). The stored element carries its `RuntimeId`, root hwnd, pid with creation time, role, name, context, display and time. A reference is valid only if all of these hold:
  - it is less than 300 s old;
  - the front pid is the same;
  - the root window is the same (compared with `CompareElements`);
  - the role, masked name and masked context are the same;
  - the element is enabled and has a rect;
  - `check(Seen(element))` passes.

  The cache keeps at most 2048 entries and evicts the oldest first.
- **`findControl`, `pickControl`, `nameMatch` and `coveredControl`** are the pure functions, with:
  - `parent` = `ControlViewWalker.GetParentElement`;
  - `equal` = `CompareElements`;
  - `sameApp` = the same attributed identity (§7.1);
  - `overlay` = a ControlType Menu, an IsDialog element, or a Window with `WindowPattern.IsModal`.
- **`clickControl`** (`:1462-1485`): click at the live visible centre through `perform(click)`, so `CheckPoint` and Rule T apply. It never uses `Invoke`, matching the Mac's pointer path.
- **`find`** (`:1794-1866`): bounds of 15,000 nodes and 1.5 s. It scrolls into view with `ScrollItemPattern.ScrollIntoView()` instead of `AXScrollToVisible`, waits 250 ms, then reads again and snapshots.
- **`read`** (`:1870-1934`): in browsers the roots are the web-page Documents (at most 4). Bounds are 20,000 nodes, 60,000 characters and 2.0 s. Role rendering is identical, and a password field reads as `[password field]`.
- **`menus`** (`:1711-1725`):
  - It **reads invisibly** from the classic `HMENU`: `GetMenu(root)`, then `GetMenuItemCount` and `GetMenuItemInfoW` (`MIIM_STRING|MIIM_STATE|MIIM_SUBMENU|MIIM_FTYPE`).
    - Separators are skipped and `&` mnemonics are stripped.
    - The text after `\t` becomes `key`, for example `Ctrl+S` (at most 12 characters).
    - `enabled:false` comes from `MFS_DISABLED` and `checked` from `MFS_CHECKED`. Depth is 0 or 2, as in Swift.
  - The Mac's "skip index 0" (the Apple menu) **does not apply**, because the Windows system menu is not part of `GetMenu`.
  - Without an `HMENU`, it reads the top-level items of a UIA MenuBar child (WinForms, WPF) as `submenu:true`, without expanding them.
  - With neither: `This app has no menu bar to read.` (`retry`).
- **`pressMenu`** (`:1728-1761`):
  - The path is matched on `HMENU` titles with `sameTitle` and `nameMatch`.
  - The guards are the same: dimmed items, submenus, quit/close/exit when the app hosts Reach (§7.3), Reach mentions, protected title words, and "inspect element".
  - It presses through UIA, with no pointer: `ExpandCollapsePattern.Expand()` along the path in the window's MenuBar, then `InvokePattern.Invoke()` on the final item.
  - If the item can't be found or pressed: `That menu item couldn't be pressed. Use its shortcut key instead.` (`retry`).
- **`windows`** (`:1578-1608`):
  - It lists top-level windows in z-order, Alt-Tab style: visible or minimized, not cloaked, no tool windows unless `WS_EX_APPWINDOW`, and either no owner or an invisible owner.
  - Identity comes from §7.1. These are left out entirely: apps with an `appReason`, windows whose effective title gives a title reason, Reach's windows, and explorer.exe system surfaces.
  - Limits: at most 120 windows, 24 per app, and 1.5 s.
  - `dialog` = UIA IsDialog, or a `#32770` with an owner.
  - Browsers add `url` (§10.2) and `tabs`: TabItem names, with selection from `SelectionItemPattern.IsSelected`, at most 30.
- **`front`** (`:1487-1525`) returns the same fields as Swift.
  - `path` is the policy path from §7.1.
  - `terminalLike` includes the window-class rule (§7.4).
  - `layout` = `"{monW},{monH}|{x},{y},{w},{h} of root frame|{x},{y},{w},{h} of focused element|{AX role}|{AutomationId}"`, at most 2000 characters.
  - A hidden app returns exactly the empty-name shape (the L6 rule, `test/agent-desktop-policy-native.test.mjs:48-52`).

### 8.5 `wait-change` (port of `watchScreen`/`waitChange`, `:455-488`)

The `uia-events` thread registers:

- `AddFocusChangedEventHandler` (global);
- for the current foreground root element, `AddStructureChangedEventHandler(TreeScope_Subtree)`;
- `AddPropertyChangedEventHandlerNativeArray(TreeScope_Subtree, [Name, ValueValue, BoundingRectangle])`. This handler only increments a counter; it never reads the changed value.

Each handler increments `screenRevision`. When the foreground root changes, the thread re-registers (`RemoveAllEventHandlers`, then adds the handlers again), and the revision increments, as Swift does when the pid changes. `wait-change` polls the revision every 50 ms for up to `min(400, ms)` and returns `{ok, revision, changed}`.

## 9. Opening apps, URLs and files; the catalog

**One launch model.**
- **A known executable** starts through `CreateProcessW(exe, "\"exe\"[ args]", …, CREATE_UNICODE_ENVIRONMENT, userEnv, workingDir)`. `userEnv` comes from §2.5, the working directory is the exe's directory, and no shell is involved. Two checks keep any launch from raising a UAC prompt:
  - **Manifest pre-check, before launch.** Load the exe as a data file (`LoadLibraryExW(LOAD_LIBRARY_AS_DATAFILE | LOAD_LIBRARY_AS_IMAGE_RESOURCE)`) and read `RT_MANIFEST` resource 1.
    - Refuse if `requestedExecutionLevel` is `requireAdministrator` or `highestAvailable`.
    - Also refuse if the `AppCompatFlags\Layers` registry values (HKCU and HKLM) give the file `RUNASADMIN`.
    - The refusal is `That app asks for administrator rights. The owner opens it at the PC.` (`blocked`). The check works the same whether UAC is on or off.
  - **After launch:** if `CreateProcessW` fails with `ERROR_ELEVATION_REQUIRED` (740), for example because of installer detection, refuse with the same message.
- **A packaged app** goes through `IApplicationActivationManager`:
  - `ActivateApplication(AUMID, args, AO_NONE, out pid)` for apps;
  - `ActivateForFile(AUMID, items, "open", out pid)` for files. It "Activates the specified Windows Store app for the file contract" ([ActivateForFile](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-iapplicationactivationmanager-activateforfile));
  - `ActivateForProtocol` for URLs in a packaged browser.

  The system starts these, with the user's normal environment.
- **Not used:** `ShellExecuteEx` and `IAssocHandler`. Both re-resolve what to run inside shell code, inherit the helper's environment, and may prompt for elevation.
- Everything runs on the shell thread, under its 8-second deadline (§2.2).

**`catalog`** (port of `:1154-1175`), on the shell thread:
- Enumerate `FOLDERID_AppsFolder` (`SHGetKnownFolderItem`, then `IShellItem.BindToHandler(BHID_EnumItems)`).
- For each item, read:
  - the display name (`SIGDN_NORMALDISPLAY`);
  - `PKEY_AppUserModel_ID`;
  - a packaged-app flag (the package full name or `PKEY_AppUserModel_PackageFamilyName` is non-empty);
  - `PKEY_Link_TargetParsingPath`, for desktop shortcuts.
- A packaged item becomes `{id:"shell:AppsFolder\\"+AUMID, bundleId:AUMID}`. A desktop item with an `.exe` target becomes `{id:canonicalExePath, bundleId:"exe:"+file}`. Other targets are skipped.
- `running` says whether any running process's policy path equals the id.
- Sorted by name; at most 1024 items, with names cut to 100 characters.

**`open`** (port of `:1177-1208`):
- Accepts an `id` of either form; anything else gets `Choose an app on this PC.` (`invalid`).
- Runs `appReason` on the computed identity.
- If any visible top-level window of that identity exists, it focuses that window (§6), as macOS activates a running app. Otherwise it launches the app: packaged through `ActivateApplication`, unpackaged through `CreateProcessW` (above).
- An 8 s timeout gives `retry`.
- Replies `{ok, app, bundle, front}`, with `front` from the §6 polling.

**`open-url`** (port of `:1212-1234`):
- The URL is validated as in Swift, plus the `urlReason` check.
- **The browser** is `app` (an exe path or AppsFolder id) or the default.
  - The default packaged browser comes from `AssocQueryStringW(ASSOCF_IS_PROTOCOL, ASSOCSTR_APPID, "https")`. `ASSOCSTR_APPID` is "The AppUserModelID of the app associated with the file type or URI scheme" ([ASSOCSTR](https://learn.microsoft.com/en-us/windows/win32/api/shlwapi/ne-shlwapi-assocstr)). It is used only when it has the `PFN!AppId` shape and that package is installed.
  - Otherwise the default is the unpackaged exe from `ASSOCSTR_EXECUTABLE`.
- It must be a browser identity: one of `chrome.exe`, `msedge.exe`, `firefox.exe`, `brave.exe`, `opera.exe` and `vivaldi.exe`, or one of the package families `TheBrowserCompany.Arc_*`, `Mozilla.Firefox_*` and `DuckDuckGo.DesktopBrowser_*`. This Windows list sits alongside Swift's `browserIds` (`:856`).
- `appReason` runs on the browser.
- **The checked browser is launched:** an unpackaged one with `CreateProcessW(exe, "\"exe\" \"url\"")`, a packaged one with `ActivateForProtocol`. The URL can't contain whitespace or quotes (§12), so it can't inject arguments. On failure: `There is no browser to open it in.` (`unavailable`).

**`open-file`** (port of `:1939-1968`):

1. **Lexical refusals** (also done in Node, §12):
   - the path must be absolute, `X:\…`;
   - UNC and `\\?\`/`\\.\` device paths are refused;
   - a `:` after the drive letter (alternate data streams) is refused;
   - **any path component that ends in a dot or a space** is refused, because Win32 strips them, so `x.exe.` would open `x.exe`;
   - control characters are refused.
2. **Canonicalize from a handle.**
   - Open the path with `CreateFileW(FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS)`. Reparse points are followed. Without `FILE_SHARE_DELETE`, nobody can rename or delete the file while the helper holds it.
   - `GetFinalPathNameByHandleW(FILE_NAME_NORMALIZED | VOLUME_NAME_DOS)` gives the canonical path: long names instead of 8.3 aliases, the real case, junctions and symlinks resolved, with the `\\?\` prefix stripped.
   - `GetFileInformationByHandle`: **refuse if `nNumberOfLinks > 1`**, because a hard link can alias a protected file. Also refuse if the opened object is itself a reparse point.
   - A missing file gives `That file isn't there.` (`invalid`), as Swift does.
3. **Check protected paths again, on the canonical path.** The check runs case-insensitively, using `rules.protectedPaths` and `rules.home` (they already arrive in `nativeRules`, `agent-guard.mjs:248-249`) plus A's Windows patterns. A match refuses with `That path holds your passwords, keys or Reach's own files.` (`blocked`). The **extension** is taken from the canonical path.
4. **Programs** (`programReason`): Swift's `programExtensions` plus {`exe com bat cmd ps1 psm1 psd1 ps1xml psc1 vbs vbe js jse wsf wsh wsc sct hta msi msp mst scr pif lnk url website reg inf cpl msc jar jnlp appref-ms application appx msix appxbundle msixbundle appinstaller library-ms search-ms searchconnector-ms settingcontent-ms diagcab chm ws scf xbap py pyw sh rdp theme themepack deskthemepack iso img vhd vhdx xll xla xlam ppam docm xlsm accde mdb adp cer crt p7b pfx`}. Directories with an extension are refused too. Disk images are on the list because they mount without the Mark of the Web; Office add-ins and macro documents are on it because they run code in apps that pass the runner check.
5. **Reveal, or a directory:** Explorer opens it through `SHOpenFolderAndSelectItems`, after `appReason` on `exe:explorer.exe`.
6. **Otherwise, the default handler**, in this order:
   1. `ASSOCSTR_APPID` for the extension. If it is the `PFN!AppId` of an installed package, run `appReason` on that identity, then `ActivateForFile(AUMID, [the canonical file], "open")`. This is how Windows 11's Notepad, Photos and Media Player open files.
   2. Otherwise, if `ASSOCSTR_DELEGATEEXECUTE` or `ASSOCSTR_DDECOMMAND` is non-empty, refuse with `No app on this PC opens that file.` (`unavailable`). Those handlers run inside shell code that the helper can't check.
   3. Otherwise, parse `ASSOCSTR_COMMAND`. The first token (quoted, or up to the first space) must be an absolute `.exe` path that exists and equals `ASSOCSTR_EXECUTABLE`, compared case-insensitively. Microsoft warns: "Not all app associations have executables" (same page).
      - The remaining tokens may contain only `%1`, `"%1"`, `%L` and `"%L"` (replaced by the quoted canonical path) and `%*` (replaced by nothing). Environment references are expanded. Any other `%` token refuses.
      - The handler's identity must not be protected or hidden (`appReason`), terminal-like, or a runner: `cmd, powershell, pwsh, wscript, cscript, mshta, msiexec, regedit, rundll32, control, mmc, wt, windowsterminal, python, pythonw, node, java, javaw`.
      - Then run the manifest pre-check, and `CreateProcessW` with the substituted command line.
7. The file handle from step 2 is held until the launch returns.

**`browser-check`** (`:2055-2073`) relies on Apple Events; the Windows equivalent is workstream G. Until then it answers `{"error":"Saved browser tools on Windows come with Reach's browser extension, which isn't installed yet.","kind":"setup_required"}`.

## 10. Secrets and bank sites

### 10.1 Vault values (`agent-desktop.mjs:717-736`; Swift `:994-1002`, `:1259-1264`)

- **Secure-field gates** are identical to the Mac's. In non-Full modes, plain text into a password field gets `secureReason`. Vault values never go into terminals, and secrets are never pasted.
- **Remembering and hiding secrets:** `rememberSecret` keeps at most 16 trimmed values of at least three characters each, in memory only. `hideSecrets` applies to every name, value, context, text, menu title, window title and tab title the helper returns. Screenshots get the field black-out of §4.3 step 8.
- **No leaks:** the helper never logs or writes text anywhere. The catch-all reply carries no exception text. WER is set to no-heap (§2.4), and password fields' values are never requested (§8.1).
- **Clipboard:** the owner's previous clipboard text stays in memory only for the length of one paste (§5.2), as on the Mac.

### 10.2 Bank sites read-only (`money-sites.mjs`; Swift `:226-354`, `moneyAt` `:597-622`)

- **Web page:** a UIA `Document` whose ValueValue (via `ValueOf`) is a URL with a scheme (`http:`, `https:`, `about:`, …), or whose `FrameworkId` is `Chrome` or `Gecko`. In Chromium and Firefox, each frame's root document carries its URL as its Value. CI and the real PC check this with Edge, Chrome and Firefox (§13.4).
- **`Seen.frames`** = the URLs of every web-page Document ancestor, innermost first. This is the Windows source for Swift's `s.frames.append(address)` (`:535`).
- **No-tree rule (Windows-specific, fail-closed).** Chromium builds its web tree only after an assistive client asks, as on the Mac (`buildWebTree`, `:574-576`).
  - The first UIA query switches the tree on. The helper waits 300 ms and reads once more.
  - If the browser window still has **no** web-page Document, the rules contain `moneySites`, and the element at the point (or the focused element) isn't inside a TitleBar, ToolBar, Tab or MenuBar ancestor, refuse with `moneyUnreadReason` (`retry`).
  - On the Mac a missing web area meant "browser chrome". On Windows it can mean "tree not built yet", so it is treated as unreadable.
- **Pure ports:** `moneyFrames`, `moneyPage`, `moneyClickReason`, `moneyTypeReason`, `moneyKeyReason` and `maskAccountNumbers`. A drag that starts or ends on a bank page is refused (`:969`), and reads mask account numbers (`:1416-1421`, `:1931`).

## 11. Protocol mapping (question 5)

Reply fields are exactly the Swift ones unless noted. "Same" means the same branch logic, now running on Windows sources.

| Op / action | Swift (file:line) | Windows implementation |
|---|---|---|
| `rules` | parse `1970-1991`; reply `2005-2009` | Same parse, plus `protectedPublishers` and the win32 `reach` field. An unknown `mode` becomes `view`. Runs the Reach console probe (§7.3). Replies `{ok, accessibility: uiaReady, screen: inputDesktopIsDefault, mode, elevated, desktop, reachConsole, reachHost}`. |
| `catalog` | `1154-1175`; `2010` | AppsFolder enumeration (§9) |
| `displays` | `441-448`; `2017` | `EnumDisplayMonitors` / `GetMonitorInfoW`; FNV ids (§4.4) |
| display choice | `433-440`; `2013-2015` | Same rules; refs and snapshots remember their monitor |
| `wait-change` | `455-488`; `2018` | UIA event handlers (§8.5) |
| `shot` | `1095-1151`, `redacted 1074-1093`; `2019-2021` | BitBlt, then inventory, bands and masks, then redaction (§4.3) |
| `front` | `1487-1525`; `2029-2030` | §8.4; hidden-app empty shape preserved; window-class `terminalLike` |
| `act` (entry, `expected`) | `859-874`; `2022-2025` | Same, against `front()`; view mode refuses |
| ↳ `move` | `877-880` | `CheckPoint`, then absolute MOVE |
| ↳ `element` | `881-904` (+ `referencedControl 1285-1301`) | Snapshot or ref re-found via UIA, then `clickControl` |
| ↳ `press` | `905-915` | `ReadScreen`, `findControl` (optional `within`), `clickControl` |
| ↳ `fill` | `916-945` | Per field: find, click, 150 ms, `replace` (Ctrl+A, non-secure), `type`; `submit` sends Enter. Explorer's fields refused (§7.8). |
| ↳ `click` | `946-965` | `CheckPoint(activate)`, Rule T, pre-batch checks, one batch (§5.2) |
| ↳ `drag` | `966-983` | Both endpoints checked; bank refusal; held-button tracking; pre-batch checks per step |
| ↳ `scroll` | `984-990` | WHEEL and HWHEEL (§5.2) |
| ↳ `type` | `991-1039` | `Focus()`; secure, terminal and Explorer-field gates; `moneyAt`/`moneyTypeReason`; `rememberSecret`; paste (with exclusion formats) or Unicode batches |
| ↳ `menu` | `1040-1041` → `pressMenu 1728-1761` | `HMENU` match plus UIA Expand/Invoke (§8.4) |
| ↳ `key` | `1042-1063` | Key map with the foreground layout, Ctrl-mapped chord, `Focus(appOnly)`; Reach-close, shut-down, devtools, secure-key and bank checks; one batch |
| `open` | `1177-1192`, `waitFront 1196-1208`; `2026-2028` | Focus the existing window, or `ActivateApplication` / `CreateProcessW` (§9) |
| `elements` | `1434`, `readScreen 1341-1433`, `snapshotPayload 1766-1789`; `2052-2054` | §8.4 |
| `open-url` | `1212-1234`; `2049-2051` | Association plus browser identity, then `CreateProcessW` of the checked exe or `ActivateForProtocol` |
| `browser-check` | `2055-2073` | `setup_required` until workstream G |
| `windows` | `1578-1608` (+ `windowTabs 1549`, `windowPage 1571`); `2031-2033` | §8.4 |
| `focus` | `1612-1657`; `2034-2036` | §6 (raise, then one `SetForegroundWindow`) |
| `menus` | `1711-1725` (+ `1660-1708`); `2037-2039` | `HMENU` read, UIA MenuBar fallback |
| `find` | `1794-1866`; `2040-2042` | §8.4 |
| `read` | `1870-1934`; `2043-2045` | §8.4 |
| `open-file` | `1939-1968`; `2046-2048` | §9: handle canonicalization, protected paths, then `ActivateForFile` or a parsed `CreateProcessW` |
| per-event checks | `checkPoint 657-725`, `windowAt 633-648`, `check 626-630`, `seen 521-558`, `focus 737-772`, `hostsReach 727-731`, `moneyAt 597-622` | §7, §10 |
| held input | `post 811-829`, `letGo 832-842`, SIGTERM `1996-1999` | `Post`/`LetGo`; EOF, the watchdog or a wedged thread, then `TerminateProcess(self)` |
| pure policy and text | `18-355`, `363-377` | `PURE DESKTOP POLICY` and `PURE DESKTOP TEXT` sections (§7.2) |
| permission gate | `AXIsProcessTrusted`/`CGPreflightScreenCaptureAccess` at `2007`, `2020`, `2023…` | `uiaReady`, input desktop `Default`, title self-test, Rules S and F |
| errors | `2077-2081` | Same shape and kinds |

## 12. Server-side Windows adapter (macOS unchanged)

Every item below is either a `platform === "win32"` branch or a new injected option that defaults to today's behaviour. `createAgentDesktop` and `AgentDesktopHelper` gain `platform = process.platform`.

1. **`available`** (`agent-desktop.mjs:319`): on win32, `!!config.screen` (A and E decide when to enable it). `index.mjs:930` creates the desktop on win32 once workstream E lifts the refusal.
2. **`start`** (`:354-365`):
   - The binary comes from `windowsBinary` (§3.4).
   - Spawn with the arguments `[ "--reach-pid", String(process.pid) ]` and the options `{ stdio: ["pipe","pipe","pipe"], detached: true, windowsHide: true, env: <allowlist §2.5> }`. `detached` gives `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` and keeps the helper out of Node's kill-on-close job (libuv `src/win/process.c`), so the helper outlives a crashed Node long enough to let go of held input (§5.4).
   - The first `send` waits up to `COLD_START_MS`.
   - **Replies:**

     | Condition | Status | Message |
     |---|---|---|
     | `ready.elevated === true && mode !== "view"` | 503 | Rule S wording |
     | `ready.desktop !== "Default"` | 409 | the secure-desktop wording |
     | `ready.accessibility === false && mode !== "view"` | 503 | `Windows UI Automation isn't available to Reach on this PC.` |
     | `ready.screen === false` | 503 | `Windows won't let Reach see the screen right now. Keep the PC signed in and unlocked.` |

     The Mac messages are untouched.
3. **`helperFailure`** (`:222-231`) says "The PC's agent helper …" on win32.
4. **`AgentDesktopHelper.stop`** (`:297-315`): on win32 the grace before `kill` is 1500 ms. The follow-up `SIGKILL` timer ends in the same `TerminateProcess`.
5. **Path validation:**
   - `open` (`:758`) and the `openUrl` browser (`:778`): on win32, accept either a path that is `path.win32.isAbsolute`, normalized, ends in `.exe` and isn't a UNC or device path, or an id matching `^shell:AppsFolder\\[A-Za-z0-9._-]+_[a-z0-9]{13}![A-Za-z0-9._-]+$`.
   - `openFile` (`:663`): absolute `X:\…`, normalized, with no UNC, device or ADS paths, no component ending in a dot or space, and no control characters.
     - Then `fs.realpathSync.native(filePath)` canonicalizes it, and `protectedPathReason` runs on **both** the given and the canonical path (case-insensitive on win32, §1.3 item 3).
     - Whether the native realpath returns long names and resolves junctions is confirmed on the runner. The helper's handle-based check (§9) is authoritative either way.
   - `withBrowser` (`:831`): compare the basename without `.exe`.
6. **`desktop-native.mjs`:** `windowsBinary` (§3.4) sits beside `desktopBinary`; Swift building is untouched.
7. **Rules:** on win32, `session()` sends `{...nativeRules(...), reach: { pid: process.pid, console: process.stdout.isTTY === true }}`. The darwin payload is unchanged.
8. **`server/index.mjs:5547`:** the darwin line stays as it is. A separate win32 line sets `process.title = "Reach"` when `process.stdout.isTTY`; this is the second signal of §7.3.
9. **Typed text into terminals:** on win32, in non-Full presets, if `front.terminalLike === true` and A's Windows deny list (§1.3 item 4) isn't present, `act` refuses `type` (paste included) and `fill` with `Typing commands on this PC needs Reach's Windows command checks, which this version doesn't have yet.` (`blocked`). A unit test asserts the refusal, and that it goes away once the Windows list is injected.

## 13. Test plan (question 6)

Run only with `npm run test:file -- test/<a>.test.mjs …`. Never run `npm test`, never run bare `node --test`, and never run two heavy runs at once.

### 13.1 Unit tests (any OS, injected platform or the `as-windows` preload)

- **`test/agent-desktop-windows.test.mjs`** (new). It uses `createAgentDesktop({screen:true}, {platform:"win32", spawnHelper, …})` with the fake-helper pattern of `test/agent-desktop.test.mjs:10-56`, and checks:
  - `rules` replies with `elevated`, `desktop` and `accessibility` map to the Windows wording; the Mac wording is unchanged under `platform:"darwin"`;
  - the win32 `rules` request carries `reach.pid` and `reach.console`; the darwin request is byte-identical to today's;
  - `helperFailure` says "PC";
  - the stop grace is 1500 ms on win32 and 300 ms on darwin (fake child plus `t.mock.timers`);
  - the spawn options are `detached:true`, `windowsHide:true` and `--reach-pid`;
  - the environment allowlist has no `COR_*`, `COMPlus_*` or `DOTNET_*`, and has `ProgramFiles` and `ComSpec`;
  - `open`, `openUrl` and `openFile` accept and refuse Windows paths: UNC, `\\?\`, ADS, a trailing dot or space, `.app` on win32, and the AUMID shape;
  - `openFile` refuses an upper-case variant of a protected path, and checks the (injected) realpath result too;
  - typed text into a terminal-like front is refused on win32 without the Windows deny list, and allowed once the list is injected;
  - `front`/`windows` filter hidden apps by AUMID bundle.
- **`test/windows-native-build.test.mjs`** (new), with injected `run`, `exists`, `fs` and `events`. It checks:
  - the csc path order and arguments, and the cache name;
  - the build lock: a second caller waits, and a stale lock is taken over;
  - rename retries on `EBUSY`/`EPERM`, and a target that appears meanwhile counting as success;
  - SAC through `reg.exe`: state 1 refuses unless a verified fallback exists, and an unreadable value means compile;
  - classification of a spawn error, an early exit and a timeout: a matching event gives the policy wording, unreadable logs give the generic one;
  - `ENOENT`: rebuilt once, then the quarantine wording;
  - a byte-flipped prebuilt is refused before spawn, with the pin chosen by `process.arch`;
  - no PowerShell anywhere: only `csc.exe`, `reg.exe` and `wevtutil.exe`, each by absolute path.
- **Source-structure tests on `agent-desktop.cs`** (any OS; they only read the file), added to `test/agent-desktop-policy-native.test.mjs` and to the pointer, text, release and focus tests:
  - only `Post` and `LetGo` call `SendInput`; `Post` runs the pre-batch checks first; Rule T runs before every `Post` site;
  - none of these appear: `keybd_event`, `mouse_event`, `SetWindowsHookEx`, `AttachThreadInput`, `SwitchToThisWindow`, `SPI_SETFOREGROUNDLOCKTIMEOUT`, `Process.Start`, `ShellExecute`, `IAssocHandler`, `GetWindowText(`, `Console.In`, UIA `SetFocus`; `VK_LWIN` appears only in `GetAsyncKeyState` reads;
  - an `IsPassword` guard comes before every value read, and ValueValue appears only in the pass-2 helper;
  - `hideSecrets` is applied to texts, values and contexts; `Shot` masks before encoding and calls the redaction;
  - every `CreateProcessW` passes `CREATE_UNICODE_ENVIRONMENT` and an environment block, after the manifest pre-check;
  - the `PURE` section has no P/Invoke, no `System.Uri`, and no culture-sensitive `IndexOf`/`StartsWith`/`Contains`;
  - `front` keeps the hidden-app empty shape; nothing is written to stderr; every stdout write happens under `outLock`.

### 13.2 The shared policy corpus

1. **Data-driven refactor, test code only, in its own commit.** Move the inline Swift cases in `test/agent-desktop-policy-native.test.mjs:94-266` and `test/money-sites.test.mjs:14-170` into `test/helpers/desktop-policy-corpus.mjs`, as arrays of `[fn, args, expected]` plus the emitters `toSwift()` and `toCSharp()`. Prove equivalence on a Mac with `REACH_TEST_APP_NATIVE=1`: the same `OK`, and the same number of `check(` calls before and after.
2. **New compiled test** in the same files: `compiled Windows desktop policy decides the same corpus`, with `skip: process.platform !== "win32" || process.env.REACH_TEST_WINDOWS_NATIVE !== "1"`.
   - It extracts `// BEGIN PURE DESKTOP POLICY … END` (plus `PURE URL` and `PURE DESKTOP TEXT`) from `agent-desktop.cs`, writes `checks.cs` from `toCSharp()`, compiles with `csc /noconfig /r:System.dll /r:System.Core.dll`, runs it, and expects `OK`.
   - Rules come from `nativeRules(…, {platform:"darwin"})`, so identical data reaches Swift, C# and JS.
3. **Windows-data corpus** (JS plus C#, not Swift), built from `nativeRules(…, {platform:"win32"})`. Cases:
   - `C:\Program Files\1Password\app\8\1Password.exe` protected by name;
   - a renamed exe protected by publisher;
   - **a PFN entry protecting an AUMID bundle** (`…_xxxx` against `…_xxxx!app`), and a near-miss (`…_xxxx2!app`) that doesn't match;
   - an app allowed by AUMID in Apps mode;
   - `exe:` bundles of unpackaged apps never satisfying `allowedApps`;
   - `consent`, `credentialuibroker`, `logonui`, `sechealthui` and `rundll32`;
   - `Settings — Privacy & security > Location` and `Settings — Accounts > Sign-in options` refused, and `Settings — System > Display` allowed;
   - `windows.controlpanel` with "Network Connections" refused;
   - `pointerIdentityKnown` refusing dwm and csrss;
   - `Lower()` cases (`İSTANBUL`, final sigma);
   - IPv4 and IPv6 edge cases (`01.1.1.1`, `[::ffff:1.2.3.4]`);
   - the new program extensions (`iso`, `xlam`, `appinstaller`, `rdp`).
4. **Compiled behaviour tests with inert fakes** (C# variants of the Swift ones, with the same skip flag). The production `CheckPoint`, `Focus`, `Perform`, `Post`, `LetGo`, `Shot` masking, `TitleOf`, `Identity` and the Reach console probe all work against injected interfaces, so tests implement fakes instead of extracting text. The interfaces:
   - `IDesktopView`: `Inventory`, `RouteAt`, `ElementAt`, `Foreground`, `FocusedElement`, `Integrity`, `Title`, `PackagePath` and `ConsoleProbe`;
   - `IInputSink`, `IKeyState` and `ICapture`.

   Cases:
   - **pointer:** every case in `test/agent-desktop-pointer-native.test.mjs:105-163`, plus route-mismatch and Rule T cases;
   - **focus:** the cases in `test/agent-desktop-focus-native.test.mjs` (from line 116), plus a foreground at High integrity (Rule F);
   - **text:** the `keyboardChunks` invariants (`test/agent-desktop-text-native.test.mjs:27-46`);
   - **release:** mid-drag, `LetGo` releases at the last point and posts nothing afterwards (`test/agent-desktop-release-native.test.mjs:55-75`). EOF, the watchdog and a wedged shell thread each trigger `LetGo` before termination;
   - **pre-batch checks:** a fake reporting Alt held refuses `type`, `drag`, `scroll` and `paste`; a fake reporting Ctrl held refuses `click`;
   - **masks** (deterministic; these replace the tight-loop case):
     - in a scripted A/B/C snapshot sequence, a protected window that appears in B only is masked;
     - a moved `windowRevision` forces a recapture, and three changes black out the monitor;
     - the opacity table rows: AUTO, unsupported, Acrylic, layered alpha 254, `UpdateLayeredWindow`, `WS_EX_NOREDIRECTIONBITMAP` and a region;
     - in Apps mode, a topmost tool window, a CoreWindow toast and an `L2`-only window over an allowed window are all subtracted;
     - a visible thumbnail overlay blacks out the monitor in Apps mode;
     - in View and Apps, a walk still incomplete after its retry blacks out the monitor; Full control takes no inventory;
     - strict vs refined (D4);
   - **titles:** a captionless popup titled "Password Manager" is excluded; an unreadable browser title is refused; an unreadable Settings page is refused;
   - **identity:** a packaged identity whose image lies outside the package path is unknown. WebView2 and AFH elements are attributed to the root identity, but not when the host image is outside its install folder. A missed publisher deadline counts as protected when `protectedPublishers` is set;
   - **Reach console:**
     - for `classic`, only that hwnd is Reach's;
     - for `pseudo`, the host app's windows, found through a scripted process tree. The tree covers pid reuse caught by creation times, VS Code's windowless pty host being skipped, an `explorer.exe` ancestor falling back to the class rule, and the broad rule when no class matches;
     - for `unknown`, the broad rule; for `none`, nothing;
     - `hostsReach`, and the close guard (Ctrl+C/D/W/Q, Ctrl+Shift+W, Alt+F4).
5. **Interop check** (`skip` unless on win32 with the Windows SDK installed): parse `UIAutomationClient.idl` from `%ProgramFiles(x86)%\Windows Kits\10\Include\<newest>\um\`. For every declared interface, assert the same GUID and the same member names, in the same order, as the C# `[ComImport]` declarations. Property and ControlType ids are checked against `UIAutomationClient.h`.

### 13.3 Real-Windows CI: what the runners are

- GitHub's docs say: "Windows virtual machines are configured to run as administrators with User Account Control (UAC) disabled" ([GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)). Every process there runs at High integrity, so Rule S would refuse all input. Both `windows-2025` and `windows-11-arm` are available to private repositories (same page).
- The existing e2e test proves that the job's desktop is interactive: frames are non-black and clicks reach a window (`test/windows-desktop-e2e.test.mjs`, `ci.yml:158-171`).

**Harness:** a test-only medium-integrity launcher, `test/fixtures/windows/medium-launch.cs`, compiled in the test.

- **Token:** it calls `OpenProcessToken`, then `CreateRestrictedToken(DISABLE_MAX_PRIVILEGE, Administrators as deny-only)`, then `SetTokenInformation(TokenIntegrityLevel, S-1-16-8192)`, then `CreateProcessAsUserW` with inherited std handles. It forwards the exit code.
- **Integrity levels:** the helper **and** the medium fixtures run through it. High-integrity fixtures (launched normally) serve as the elevated targets.
- **UAC:** it is off on the runner, so elevation prompts never appear there. Elevation refusals are asserted through the manifest pre-check, which doesn't depend on UAC (§9).
- **Who is in front.** Rule F refuses all input while a higher-integrity window is in front, and the runner starts with whatever happens to be in front. So:
  - Before each medium-input case, the test process (High integrity) brings the medium target forward with **its own** real click on the target's title bar, through `SendInput`. UIPI lets input pass from higher to lower integrity, and the click activates the window as a person's would. The test then asserts that `GetForegroundWindow()` is the target before the agent's action is sent.
  - Each High-integrity fixture is launched only for its own case (Rule T or Rule F) and closed afterwards, so it can't be left in front.
- **Production code doesn't know it is under test.**

**Fixtures** (`test/fixtures/windows/*.cs`, compiled by the test with the same csc):
- `target`: WinForms, in a known colour; logs its input, and has a `MainMenu`, a `UseSystemPasswordChar` box and a long list;
- `popup`: a captionless `WS_POPUP` titled "Password Manager";
- `topmost-tool`: `WS_EX_TOPMOST | WS_EX_TOOLWINDOW`;
- `console-host`: started with `CREATE_NEW_CONSOLE` and titled "Windows PowerShell", running a child that stands in for Reach;
- `conpty-host`: creates a pseudo console with `CreatePseudoConsole` around a child, and shows a top-level window of class `CASCADIA_HOSTING_WINDOW_CLASS`;
- `clipboard-watch`: `AddClipboardFormatListener`; records the format list on every `WM_CLIPBOARDUPDATE`;
- `ll-hook`: a `WH_KEYBOARD_LL` hook that records every VK it sees;
- `env-report`: writes its own `PATH`, `ProgramFiles` and `ComSpec` to a file;
- `require-admin`: compiled with a `requireAdministrator` manifest;
- `parent-node.mjs`: a throwaway Node process that spawns the helper detached, as the server does.

### 13.4 Real-Windows CI suite

`test/windows-agent-desktop-native.test.mjs`, gated by `REACH_TEST_WINDOWS_DESKTOP=1`, runs on `windows-2025` and on a new `windows-11-arm` job in `windows-validation.yml`. Reports go to `reports/windows-agent-desktop.json`.

0. **Probe.** These are recorded and never fail the run:
   - the OS build, `EnableLUA`, the job's integrity level and elevation type, the input desktop name and the session id;
   - the monitors, with resolution and DPI;
   - the SAC registry state, `citool -lp`, the AppLocker service state, and whether `wevtutil` can read the CodeIntegrity and AppLocker logs;
   - the `csc.exe` path and banner, the .NET release key, and the helper's process architecture (x64-emulated on arm64);
   - the windows that the `FindWindowEx` walk returns but `EnumWindows` doesn't;
   - whether Windows Terminal is installed; the `GetConsoleWindow` class for the console and ConPTY fixtures; the root owner of a `PseudoConsoleWindow`; and which `reachHost` step decided;
   - `ASSOCSTR_APPID`, `ASSOCSTR_COMMAND` and `ASSOCSTR_DELEGATEEXECUTE` for `.txt`, `.png`, `.pdf` and `https`;
   - `WS_EX_NOREDIRECTIONBITMAP` and `DWMWA_SYSTEMBACKDROP_TYPE` for Edge, Chrome, Settings, Explorer and Windows Terminal windows (input to §16 D4);
   - what `fs.realpathSync.native` returns for an 8.3 alias and for a junction.
1. **Build:** `windowsBinary` compiles under the Restricted script policy that the workflow already sets. The first `rules` reply arrives within the cold-start budget, and the compile and first-answer times are recorded.
2. **Screenshots.** The fixtures are `target`, a window titled `Password Manager`, `popup`, an ordinary non-allowed window, `topmost-tool` over the target, and a High-integrity window. All are medium integrity except the last.
   - **View:** the protected window's frame and `popup`'s frame are black, the target is visible, and `hidden ≥ 2`.
   - **Apps** (allowed = the target's exe path): only the target's pixels are non-black, and the part of it under `topmost-tool` is black.
   - **Full control:** no black regions.
3. **Input on the target:**
   - a click (the target logs it), a double click and a right click;
   - `type` of `"café 🙂 日本\nnext"` arrives exactly (it travels as UTF-8 through stdin);
   - a key chord, a drag, and the signs of the scroll directions;
   - **paste:** `clipboard-watch` records the three exclusion formats both on the update carrying the agent's text **and** on the restore of the previous text. When there was no previous text, the clipboard is empty afterwards.
4. **Refusals:**
   - a click on the protected window gives `blocked`, and the target logs nothing;
   - plain text into the `UseSystemPasswordChar` box in Apps mode gives `blocked`;
   - `fill` with `secret:true` succeeds, and the secret is absent from `elements`, `read`, `find`, window titles and the screenshot (the field is black);
   - **Rules T, F and S:**
     - Rule T: a click on the High-integrity window is refused, and nothing arrives;
     - Rule F: with that window in front, a click on the target is refused;
     - Rule S: a helper launched **without** the medium launcher answers `elevated:true` and refuses `act`;
   - `popup` is absent from `windows`, and a click on it is refused;
   - **Reach's console:** `rules.reach.pid` is the `console-host` child, whose window is titled "Windows PowerShell".
     - `focus`, a click, `type`, `key` Ctrl+C and Alt+F4 on that window are all refused with `reachReason`.
     - The window is black in View and absent from `windows`.
     - Requests still flow after the probe;
   - **Pseudo console:** with `rules.reach.pid` set to the `conpty-host` child, every window of the host process is refused and masked;
   - **Settings** (allowed in Apps): the test opens `ms-settings:privacy` and `ms-settings:network`.
     - Click, type and key are refused there, and the window is masked in a View shot.
     - `ms-settings:display` stays usable.
     - The UIA elements used for the page name are pinned here;
   - **Explorer** (allowed in Apps):
     - typing `powershell -c x` into the address bar is refused, and so is Enter;
     - the taskbar is black in an Apps shot;
     - Alt+F4 with the desktop in front is refused;
     - a rename in the folder view works;
   - **open-file:** these are all refused:
     - an upper-case variant of a protected path;
     - an 8.3 alias (`fsutil file setshortname`);
     - a trailing-dot name;
     - a junction parent (`mklink /J`) pointing into a protected folder;
     - a hard link (`mklink /H`) to a protected file;
   - **open** of `require-admin` is refused with the administrator wording before any process starts.
5. **Release:**
   - A drag with `holdMs 5000`, then `stdin.end()`. Within 1 s the target gets MouseUp, `GetAsyncKeyState(VK_LBUTTON)` reports up, and the process exits before the win32 grace ends.
   - **Crash cleanup:** the same drag under `parent-node.mjs`, which the test then kills with `taskkill /F /PID`. Within 1 s the target gets MouseUp and the helper exits.
6. **UIA:**
   - `elements` lists the target's controls with AX roles;
   - `press` by name works, as do `fill` and `find`, which scrolls a long list into view;
   - `read` gives the full text, with `[password field]` for password fields;
   - `windows` omits the protected window;
   - `menus` reads a WinForms `MainMenu` with its accelerator text, and a `menu` press runs the item;
   - `wait-change` returns `changed:true` after the target edits its own text;
   - **`focus`:** `ll-hook` sees **no** `VK_MENU`. Whether a covered allowed window ends up on top (the raise) is recorded. `front` is recorded but not asserted, because of the foreground lock.
7. **Launching:** `env-report` must report `PATH`, `ProgramFiles` and `ComSpec` equal to `CreateEnvironmentBlock`'s values (computed by a fixture) when started in each of three ways:
   - through `open`;
   - through `open-file`, with a test extension registered under `HKCU\Software\Classes`;
   - through `open-url`, compiled as `chrome.exe` in a temporary folder and passed as the explicit browser path. The browser check is by file name, so production code needs no test switch.
8. **Browsers.** The test pre-launches Edge and Chrome with `--no-first-run --user-data-dir=<temp>` on `http://localhost:<port>/` fixture pages, with `moneySites:["localhost"]`. It checks that:
   - the Document URL is read for the page and for an iframe;
   - "Transfer" on a `/transfer` page gives `moneyPageReason`;
   - account numbers are masked in `read`;
   - a click before the tree exists gives `retry`;
   - `open-url` with an explicit browser exe works.

   Firefox is recorded but doesn't gate. **WebView2** is tested here only if §16 D6 allows the fixture; otherwise it is tested on the real PC (§13.5) and with fakes (§13.2 item 4).
9. **Displays:** ids are stable across two calls, and a bogus id gives `retry`.

CI wiring: the Windows lane in `ci.yml` adds `REACH_TEST_WINDOWS_NATIVE=1` and the new files to its existing `npm run test:file -- --test-concurrency=1 …` line. `windows-validation.yml` adds the new files to its default input, plus a `windows-11-arm` matrix entry.

### 13.5 What only a real PC proves (owner acceptance, phase 5)

- **Delivery:**
  - SAC On (the local build blocked, the refusal wording, and the signed fallback if adopted) and SAC Evaluation;
  - AppLocker default rules, for a standard user **and for an unelevated administrator**;
  - which event logs a standard user can read;
  - Defender with cloud protection over a week (no detection or quarantine);
  - the ASR prevalence rule.
- **UAC on:**
  - Task Manager and regedit refused by Rule T, and Rule F while one of them is in front;
  - a UAC prompt and Win+L each giving the secure-desktop wording, for shots and for input;
  - an app with `requireAdministrator`, opened by the agent, refused with no prompt.
- **Reach's terminal:** Reach run in Windows Terminal, in classic conhost and in VS Code's terminal. For each: the `reachConsole` and `reachHost` outcomes, every guard, and whether the pseudo window's root owner names the window holding the tab (input to §16 D3).
- **Mixed DPI and HDR:** with 100% and 150% monitors, clicks land on the intended pixel and masks stay aligned on each; HDR capture works.
- **Foreground lock:** success rates for `focus`, `open`, `open-url` and `open-file` over 50 trials each; whether the background raise works; recovery by a click.
- **Shell bands and overlays:**
  - in Apps mode, a toast (Phone Link), Start, Search, Notification Center, Quick Settings, Widgets and Snap Assist over an allowed window are all black;
  - in View mode, Task View, Alt+Tab, taskbar thumbnails and peek are masked.
- **Opacity:** what the rule decides for Windows Terminal with acrylic, a WinUI 3 app, and Electron and Chromium windows, and whether any of them shows protected pixels (input to §16 D4).
- **Password managers** (1Password, Bitwarden, KeePassXC): identity by name, by publisher and by package family; masking; their own capture exclusion.
- **Settings, Control Panel and Explorer** on Windows 11 24H2 and later:
  - page names for every private page;
  - Network Connections, Firewall and User Accounts opened in Explorer;
  - the id of Explorer's XAML address bar, Explorer tabs, and the Open and Save dialogs of an allowed app.
- **WebView2 apps** (new Outlook, Teams) in Apps mode, plus one fixed-version WebView2 app, which must be refused.
- **Default handlers:** Notepad, Photos and Media Player opening files through `ActivateForFile`.
- **Bank sites** in Edge, Chrome and Firefox: the URL read per frame, sign-in with vault values, and transfer pages refused.
- **Input variety:** IMEs (Japanese, Chinese), non-US keyboard layouts for punctuation keys, the touch keyboard, and RDP and disconnected sessions.
- **ARM64:** the speed of shots and reads under x64 emulation.
- **Full chain:** a physical phone through invite → admission → MCP (workstream F).

### 13.6 One negative test per review finding

| # | Unit or compiled fake | Real-Windows CI |
|---|---|---|
| 1 | Reach console outcomes, `hostsReach`, close guard (§13.2 item 4) | `console-host` and `conpty-host` refusals (§13.4 item 4) |
| 2 | Topmost, CoreWindow and `L2`-only windows subtracted; overlay blacks out Apps | `topmost-tool` black in Apps (§13.4 item 2) |
| 3 | Captionless title excluded; unreadable browser title refused | `popup` black, absent from `windows`, click refused |
| 4 | PFN vs AUMID corpus cases; package image outside its folder → unknown | — (fakes; real PC for password-manager packages) |
| 5 | Settings effective titles in the corpus; unreadable page refused | `ms-settings:privacy`/`network` refused and masked |
| 6 | Explorer field rules on fake trees | address bar, taskbar, Alt+F4 on the desktop |
| 7 | — | `clipboard-watch` formats on set and restore; empty when there was no text |
| 8 | Lexical refusals and realpath in Node | case, 8.3, trailing dot, junction, hard link |
| 9 | Every `CreateProcessW` has an environment block (source test) | `env-report` through `open`, `open-file`, `open-url` |
| 10 | No UIA `SetFocus` (source test) | `ll-hook` sees no `VK_MENU`; raise recorded |
| 11 | Embedding-host attribution and its refusals (fakes) | WebView2 fixture if D6 allows it, else the real PC |
| 12 | Byte-flipped prebuilt refused before spawn | — |
| 13 | Invalid UTF-8 line answered `invalid`, next line works; over-long line | `"café 🙂 日本"` typed exactly |
| 14 | Alt held refuses type, drag, scroll and paste; Rule F | Rule F with the High-integrity window in front |
| 15 | Lock, rename retries, classification, one rebuild on ENOENT | build under the Restricted policy |
| 16 | Snapshot sequences, revision counter, opacity table, strict vs refined | — (fakes replace the tight loop) |
| 17 | Shell-thread deadline → reply, then the EOF path | `require-admin` refused before launch |
| 18 | New extensions, devtools keys, terminal classes (corpus and fakes) | a console window with a `node.exe` client is terminal-like |
| 19 | No ValueValue outside pass 2 (source test); publisher deadline → protected | the secret is absent from every read |
| 20 | — | crash cleanup under `parent-node.mjs` |

## 14. Build order inside workstream B

1. **Skeleton.** In `agent-desktop.cs`: byte-level stdin, `outLock`, JSON, the threads (watchdog included), the startup checks (title self-test included), and `rules`, `displays` and `front` with no input. On the server: `windowsBinary` and the win32 branches (detached spawn, the `reach` field, the environment, the title). Unit tests from 13.1.
2. **Pure policy.** The port, the corpus refactor and the C# corpus (13.2 items 1–3), green on Windows CI.
3. **Seeing the screen.** Identity (packaged-path check, publisher with a deadline, embedding hosts), the Reach console probe, titles and effective titles, the inventory with bands, and capture and masks (`shot`). CI 13.4 items 0–2, plus the Reach-console and popup cases of item 4.
4. **Input.** The input sink, the pre-batch checks, Rules S, T and F, held-state handling, `CheckPoint`, `Focus`, keys, Explorer's fields, and `act` (move, click, drag, scroll, key, type, paste). The compiled fakes (13.2 item 4) and CI 13.4 items 3–5.
5. **UI Automation.** The interop plus the IDL check; `elements`, `press`, `fill`, `find`, `read`, `windows`, `focus`, `menus` and `wait-change`. CI 13.4 item 6, plus the Settings case of item 4.
6. **Bank sites and launching.** The bank-site URL via UIA, with CI 13.4 item 8. The launch model (`open`, `open-url`, `open-file`, `catalog`), with CI 13.4 item 7 and the open-file and require-admin cases of item 4.
7. **Review.** An adversarial security review of the diff (rule 6), then the owner's real-PC run (13.5).

## 15. Known differences to write down (parity table additions)

| Windows behaviour | Why | Instead |
|---|---|---|
| Protected windows are blacked out in screenshots, not removed | GDI can't recompose the screen without a window, and Windows.Graphics.Capture draws a border on unpackaged apps | Same guarantee (no protected pixels leave the PC), but the black areas are visible |
| A protected window covered by other windows is hidden under opaque ones (refined) or is always a black box (strict) | The owner's choice, §16 D4. Refined has a residual: a window made see-through in a way Windows doesn't report can show a blended view of a protected window behind it | — |
| In Apps mode, a see-through allowed window (layered, acrylic) shows a blended view of the ordinary non-allowed windows beneath it, never of protected ones | Subtracting every window beneath would black out the allowed window wherever anything lies behind it, the desktop included | The Mac shows black there |
| While Task View, Alt+Tab, Snap Assist or a taskbar preview is up, Apps-mode screenshots are fully black | They draw every window's content (the Mac's overview rule) | The agent waits until they close |
| A window shown and hidden within one capture can appear in that one frame | GDI has no atomic filter | The Mac's View mode has a comparable gap (its exclusion list is read before the capture) |
| While Reach runs inside Windows Terminal, VS Code or another terminal app (a pseudo console), every window of that app is closed to agents. If the app can't be found, every Windows Terminal window is closed instead; failing that, every terminal-like app, which can include IDEs and the Claude and Codex apps | Windows doesn't say which terminal window shows Reach's tab | §16 D3. In a classic console window, only Reach's window is closed |
| Typing into terminals is refused on Windows until Reach's Windows command checks ship | The command deny list is POSIX-only today | Workstream A, §1.3 item 4 |
| `focus`/`open` may report `front:false` more often than on a Mac, and an allowed window that stays covered can't be reached in Apps mode | The foreground lock ([SetForegroundWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)); the background raise may also be denied (measured) | The agent clicks the raised window; otherwise the owner brings it forward |
| While an elevated window is in front, the agent's input waits | Windows hides the keyboard state from Reach then (UIPI) | The owner switches away from it |
| Elevated windows, UAC prompts and the lock screen are refused | UIPI and the secure desktop | The owner acts at the PC |
| Apps that ask for administrator rights aren't opened by the agent | No UAC prompt may appear on the owner's screen | The owner opens them |
| `menus` works only for apps with a classic or UIA menu bar | Most modern Windows apps have none | `press` / `find` / click |
| File Explorer's address bar, search box and Run take no typing from agents | They run programs | Open folders by clicking, or `open_file` with `reveal` |
| Apps that ship their own WebView2 runtime, and packages with an external location, are refused | Their identity can't be verified | The owner uses them |
| An allowed unpackaged app that updates into a new versioned folder (Squirrel's `app-x.y.z\`) stops matching | Apps are allowed by exact path | The owner picks the app again |
| No Mail-subject title exemption | No verified Windows mail identity exists in the Mac policy | Stricter: such titles are hidden |
| Pasting loses the owner's non-text clipboard contents (images, files) | Only text is saved and restored, as on the Mac | — |
| A helper killed outright mid-drag (Task Manager, antivirus) can leave a button held | Nothing runs after `TerminateProcess` | The next real click releases it. Reach's own exit and crashes are handled (§5.4) |
| PCs with SAC On, or locked down by AppLocker (with default rules, every owner running Reach unelevated) or WDAC, are refused until a signed helper ships | Unsigned local builds are blocked, and Rule S refuses an elevated helper | §16 D1, D2 |
| Saved browser tools (`browser-check`) answer `setup_required` | No Apple Events | Workstream G |

## 16. Decisions for the owner

Each decision says what this design does until the owner decides.

**D1. Signing the helper** (was §3.5). **Decided by the owner, Oct 12: SignPath Foundation, product name "Reach"** (publisher shown as SignPath Foundation; rule 3 amended in `docs/WINDOWS_AGENT_PARITY.md`, policy in `docs/CODE_SIGNING.md`). The options as written:
1. **Whether to sign at all.** The options, all from [Code signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options):
   - **Azure Artifact Signing**, about $9.99/month. Individuals are limited to the USA and Canada; organizations to the USA, Canada, the EU and the UK. No hardware token is needed. It requires a pay-as-you-go Azure subscription and an identity validation that takes a few business days.
   - **An OV certificate**, $150–300 a year. Since June 2023 the private key must be on an HSM or hardware token.
   - **SignPath Foundation**, free for qualifying open-source projects. Check how the publisher name appears.
   - EV no longer gives an instant SmartScreen pass (since 2024), so it isn't worth its premium here.
2. **Whose identity is shown.** The certificate's subject is the owner's legal name or organization. It is permanently visible in every Windows user's file properties and in any App Control publisher rule.
3. **Amending rule 3** ("compiled on first use … no downloaded binaries") to allow a signed prebuilt helper, verified by pinned hash (§3.3), as the fallback.
4. **Key custody:** a GitHub environment with OIDC to Azure, a manual approval gate on release, and a provenance attestation for the signed artifact.
5. **Later:** whether the signed build should become the *preferred* path. It starts faster and draws fewer antivirus heuristics, at the cost of no longer being "built here from source".

*Until decided:* no prebuilt ships, and PCs with SAC On or a blocking policy are refused with the reason.

**D2. AppLocker- and WDAC-managed PCs.** With default AppLocker rules, every owner who runs Reach unelevated is blocked from running the locally built helper (§3.1), and Rule S refuses an elevated helper. The only working path is a signed build (D1) plus an administrator's publisher rule. Options: accept "refused with the reason" on managed PCs, or adopt D1 and document the publisher rule for administrators.

*Until decided:* refused with the reason.

**D3. Terminals while Reach runs in one.** **Decided (owner, Oct 12, parity): the Mac's title rule on both: only the window whose title names Reach is closed; Reach titles its console window "Reach".** When Reach runs in a classic console window, only that window is closed to agents. When it runs inside Windows Terminal, VS Code or another pseudo-console host, Windows doesn't say which window shows Reach's tab. So every window of that host app is closed to agents in non-Full presets: input, screenshots and the window list. For example, all of Windows Terminal, or all of VS Code.

The app is found from the ancestry of Reach's console processes (§7.3). Two fallbacks reach wider:
- On default-terminal handoff, every Windows Terminal window closes.
- If nothing resolves, every terminal-like app closes. With the Mac's `terminalLike` list, that includes VS Code, Cursor, the JetBrains IDEs, Claude and Codex.

Options:
- (a) keep this;
- (b) once the real-PC check (§13.5) shows that the pseudo window's root owner reliably names the hosting window in the Windows Terminal versions Reach supports, close only that window and treat its tabs as Reach's;
- (c) in addition, tell owners in the invite UI that a terminal app is closed while Reach runs inside it.

*Until decided:* (a).

**D4. Covered protected windows: refined or strict.**
- **Refined** (this design's default): a protected window covered by a positively opaque window (§4.3 step 5) shows that window's pixels, as on the Mac. The residual: a window made see-through with `DwmEnableBlurBehindWindow` and per-pixel alpha, or with the undocumented accent policy, can show a blended or blurred view of the protected window behind it. Windows offers no documented way to detect either.
- **Strict:** every protected window is black over its whole frame, wherever it is, and in Apps mode excluded windows are cut out of the allowed windows above them. There is no residual. But Reach's own terminal, always open behind everything, becomes a permanent black box. When it is maximized, View-mode screenshots are fully black.
- **What the runner probe decides.** The opacity rule counts `WS_EX_NOREDIRECTIONBITMAP` windows as not opaque. CI records whether Edge, Chrome, Explorer and Windows Terminal carry that style (§13.4 item 0).
  - If mainstream browsers do carry it, refined behaves like strict exactly where it matters: a maximized browser over Reach's terminal still gives a fully black View frame.
  - The choice then gains a third option: count that style as opaque when the window isn't also `WS_EX_LAYERED`. The residual grows to DirectComposition content that is actually see-through.

*Until decided:* refined. Switching to strict is one constant.

**D5. File Explorer in the Apps picker.** With B's guards, an allowed Explorer can't type into its address bar, Run or search, and never exposes the taskbar or the desktop. A double-click on a `.bat` or `.exe` still runs it, just as a Finder double-click on a `.command` file runs it on the Mac. Options: offer Explorer (Mac parity), or leave `explorer.exe` out of the Windows app picker.

*Until decided:* Explorer is offered, with the guards.

**D6. WebView2 CI fixture.** A csc-built WebView2 window needs the WebView2 SDK's loader, which ships only through NuGet. Options:
- let CI fetch a pinned, hash-checked `Microsoft.Web.WebView2` package for a **test-only** fixture (never shipped, never in agent paths);
- keep the WebView2 case on the real PC and in fakes.

*Until decided:* real PC and fakes.

**D7. Firefox developer-tools keys.** **Decided (owner, Oct 12, parity): refused on both; the Mac gains the refusal in its own change.** Windows refuses Ctrl+Shift+K/E/Z in browsers (§7.7). The Mac has the same gap: Cmd+Opt+K/E/Z aren't refused (`agent-desktop.swift:1052`). Rule 1 keeps macOS byte-for-byte the same in this workstream, so the Mac fix needs its own change and its own decision.

*Until decided:* Windows refuses these keys, and the Mac is unchanged.

## 17. Sources cited

**Microsoft**, linked inline:
- Windows and input: SetForegroundWindow · SendInput · MOUSEINPUT · KEYBDINPUT · GetAsyncKeyState · WindowFromPoint · EnumWindows · GetWindowTextW · InternalGetWindowText · OpenInputDesktop · SetWindowDisplayAffinity · DWMWINDOWATTRIBUTE · BitBlt · SetProcessDpiAwarenessContext.
- Clipboard: OpenClipboard · Clipboard Formats.
- Process, console and launching: WerSetFlags · AttachConsole · GetConsoleWindow · CreateEnvironmentBlock · ASSOCSTR · IApplicationActivationManager::ActivateForFile · GetPackagePathByFullName2.
- Integrity and UI Automation: Mandatory Integrity Control · Security Considerations for Assistive Technologies · UI Automation threading, clients overview, CUIAutomation, IsPassword and the .NET overview.
- Capture: Screen capture and IsBorderRequired.
- Application control: the Smart App Control pages · Windows 11 Security Book · AppLocker executable rules · App Control recommended block rules · about_Language_Modes · Block at first sight · ASR rules reference.
- .NET and signing: .NET Framework install and what's new · Code signing options · Artifact Signing.

**Others:**
- GitHub's runner documentation (UAC disabled, runner labels);
- dotnet/core#7709 (AnyCPU runs as x64 on Arm64);
- libuv `src/win/process.c`: detached children get `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP` and stay out of the `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` job, and `SIGTERM` and `SIGKILL` call `TerminateProcess`.

**Measured on the runner or a real PC, not cited:**
- the `FindWindowEx` walk compared with `EnumWindows`;
- the background raise;
- the pseudo window's root owner;
- Settings page elements;
- the id of Explorer's Windows 11 address bar;
- `ASSOCSTR_APPID` for in-box apps;
- `fs.realpathSync.native` on 8.3 names and junctions;
- event-log readability;
- AppLocker for unelevated administrators.
