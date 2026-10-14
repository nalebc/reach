# Agent access on Windows: parity plan

Goal (owner, Oct 12 2026): an agent gets on a Windows PC exactly what it gets on a Mac, proven end to end on real Windows. Oct 13, widened to everything: "i want full parity with mac, what works in mac should work in windows", and "No flag should exist. We should detect platform and support." Inventory: every Mac capability, its gate and its Windows route, re-checked on `ac2ec2cc`.

## Today on Windows (Oct 13)

- On by detection, with no switch: phone sign-in from the browser, invite links, the start page, the agent gateway, hosted MCP, Face ID join and linked computers (D). A PC that can't hold the keyed route (Tailscale older than 1.104 or without its adapter, Reach's folders not private, Tailscale's connections unrecognised) uses pairing codes and says why. Its unit and launch tests pass on GitHub's Windows runner; the runner's peer-check spike against a real LocalSystem service is being worked on, and no physical PC has run it.
- Built Oct 13 and passing on GitHub's Windows runner (not yet on a physical PC): the Claude desktop app's records, archive and links in either install's folder, and the PC's idle and lock readings (N, part); Reach's terminals in the owner's own shell (#34); drives attached later (#40); the launcher named as the PC runs it (#43); the notification-area icon with Pause and Resume (#16); apps' icons and agents' logos (#28); Word, RTF and OpenDocument previews (#37); voice memos as words (#35).
- Refused: all four browser presets (Full control, Apps, Files, Read only) until B, C and E; agents' and invited people's commands (no sandbox; refused since `aa09b7da` instead of running unsandboxed) until C.
- Built, not yet run on a real PC: the PC's own terminals (T). Windows Terminal tabs and console windows are listed beside Reach's terminals on the Terminals page and Home, read, typed into, brought forward and closed from the phone, and terminal shortcuts open new ones. On by detection; a PC that can't build the helper says why.
- Works: command-line agents over the tailnet for files.
- Built on Oct 13, with no switch, not yet run on a real PC (K, L): background mode and start at sign-in (a Scheduled Task of yours, InteractiveToken), sleep prevention in the Mac's three modes, one Reach per PC from its process list, restarts and updates in Reach's own window, and the first run's install alongside its setup.
- Built, not yet run on a real PC: the PC's own terminals on the phone (T): Windows Terminal tabs and console windows listed, read, typed into, brought forward and closed; terminal shortcuts open new ones.
- Built, not yet run on a real PC: OpenClaw natively, as on a Mac (#15). It's installed, set up and given keys and channels from the phone, and its health and Node recovery work there too. Beside OpenClaw's own Windows app, Reach uses the Gateway the app keeps in WSL. iMessage needs a Mac (below).
- Built Oct 14, passing on GitHub's Windows runner (not yet on a physical PC): the live screen as H.264 with nothing to install (P, #26). Desktop Duplication into Media Foundation's encoder, a graphics card's first, else Microsoft's own; "unchanged" and "locked" as on a Mac. A PC without an H.264 encoder (an N edition, Windows Server without Media Foundation) gets FFmpeg's video or still images, and its Screen page says why. The runner proved Microsoft's software encoder with Desktop Duplication; a graphics card's encoder, several displays, a rotated or HDR display, and Remote Desktop haven't been tried.
- Being built (Oct 14): B, C, U (proof on the runner), J (user journeys). Still to start: E and F after B and C; G and H after B; P's guest mask and owner field probe after B.

## What parity means

Same tools, same answers, same refusals. Where Windows can't do what the Mac does, the agent gets the same guarantee by another mechanism, or the gap is written down here and in the phone's wording, never hidden.

| Not possible on Windows | Why | What happens instead |
| --- | --- | --- |
| Reading or answering UAC prompts | The secure desktop is closed to every app by design | The agent is told an administrator prompt is up and waits; the owner answers at the PC |
| Hidden per-app displays (`apps:drive`, owner profiles only) | Needs an attestation-signed virtual display driver | Apps run on the real screen, as the Apps preset already does on a Mac |
| Acting in elevated (administrator) windows | UIPI; needs a signed `uiAccess` helper installed in Program Files | Refused with the reason, as a guardrail |
| OpenClaw's iMessage channel | OpenClaw's iMessage plugin runs `imsg` on a signed-in Mac (docs.openclaw.ai/plugins/reference/imessage); a Gateway elsewhere reaches iMessage only through a Mac | Where the phone offers other messaging apps, a Windows PC reads "iMessage needs a Mac". Telegram, Discord and Slack (by token) and WhatsApp (by QR) are added from the phone as on a Mac |

## Decisions: the same on Mac and Windows (owner, Oct 12)

"Make the same decisions between Mac and Windows; don't let them diverge." Where a design left a Windows-only choice, it takes the Mac's, or both platforms change together:

| Question | Both platforms |
| --- | --- |
| Reach running inside a terminal app | Only the window whose title names Reach is closed to narrower presets (the Mac's title rule); Reach titles its own console window "Reach" on both |
| Browser developer-tools keys (Firefox Ctrl/Cmd+Shift/Opt+K, E, Z) | Refused on both: the Mac gains the refusal it lacked |
| A browser on the computer itself asking to be approved | Allowed on both; the approval prompt says it came from this computer itself, on both |
| Where account approval is turned on | Saved setup preferences (`./reach setup`), on both; no switch, environment variable or flag anywhere (owner, Oct 13: "No flag should exist") |
| A feature this computer can't support yet | Detected, said with the reason wherever it's asked, and picked up by itself once the computer can (an older Tailscale: pairing codes until it's updated). Never a switch, on either platform (owner, Oct 13) |
| Reach's own files writable by other users of the computer | Same check on both: refused with the reason |
| This computer as a Tailscale exit node | Allowed on both; Windows adds a CI test proving the keyed route stays closed |
| Reach's folders | Owner-only on both (0700 / owner, SYSTEM, Administrators ACL) |
| Company-managed computers blocking Reach's helpers | Refused with the reason on both |
| Protected windows covered by others | The Mac's refined rule on both |
| File manager in the Apps picker | Offered on both (Finder, File Explorer), with the same guards |
| Chats in sync | Always in sync across the agent's app, its CLI and Reach, delivered the same way on both: a reply to a chat the app holds idle goes in at once (the app's idle process is handed over), one it's busy with waits its turn, one a terminal holds is refused with the reason. Never a new wait, queue or refusal on one platform only (owner, Oct 12) |
| One Reach per computer | Machine-wide on both (replaces the per-folder Windows behaviour `docs/FIRST_RUN_MATRIX.md` H20 accepted on Oct 10) |
| Restarts and updates | On both, an agent's `reach restart` asks on the phone, and Reach restarts in a visible window |
| The computer kept awake while Reach runs | On both, with the same three modes, shown by `reach status` |
| Start at sign-in | Offered on both by `./reach setup` |
| Guests' live screen and clipboard | Filtered on both (password managers, Reach's own windows, concealed copies); on Windows refused with the reason until its filter exists (done Oct 12) |
| Files hides what the OS hides | Finder's rule on a Mac; hidden and system attributes on Windows |
| OpenClaw from the phone | Installed, set up and given keys from the phone on both, natively, as on the Mac; written down as a gap only if OpenClaw won't run natively on Windows. It does: OpenClaw documents its native Windows CLI and Gateway. Built Oct 13; only iMessage is a gap (table above). The same on both (owner, Oct 13): OpenClaw's own installer (install.sh, install.ps1); when the computer's Node is older than 24.16, OpenClaw's own Node first, for OpenClaw only, with that installer's Node-only mode, said on the phone first in the same words; the same for update recovery (a Mac falls back to Homebrew's node@24 only for an OpenClaw without install-cli.sh); setup never starts a second Gateway beside one already on its port. Beside OpenClaw's own Windows app, Reach uses the Gateway it keeps in WSL. Not yet the same: on a Mac and a native PC, Discord's and Slack's tokens still go to OpenClaw as arguments (the owner's call); through the Windows app Reach refuses that and points to OpenClaw's guided setup |
| Reach's terminals | The owner's own shell on both: `$SHELL` on a Mac; Windows Terminal's default profile, else PowerShell 7, else Windows PowerShell |
| The live screen's video | H.264 the computer makes itself on both, nothing to install (VideoToolbox; Media Foundation), its colours named BT.709. Where Windows has no H.264 encoder (an N edition without the Media Feature Pack, Windows Server without Media Foundation): FFmpeg's video, else still images, detected and said on the Screen page with why, never a switch (Oct 14) |

Only what Windows itself makes impossible differs (table above): UAC prompts, hidden per-app displays, administrator windows.

## Audit (Oct 12)

`docs/parity/AUDIT.md`: six sweeps of all of Reach, not only agents, verified adversarially. It lists 50 items, two of which block use.

Built on Oct 12, with unit tests. None is proven on real Windows yet (rule 5): GitHub refused every run from 20:08 UTC, because the account is locked for billing.

- #1: new Claude chats in drive-letter folders.
- #5: a locked PC dims the live screen with "Windows PC locked". Two signals are required: the session's lock flag, and the input desktop not being Default.
- #6: agents started in Reach terminals through a PowerShell call.
- #8 (first half): live Claude chats are read from Claude Code's registry, checked against the pid's program. Replies are then delivered exactly as on a Mac. The audit proposed refusing hand-over on Windows; that was reverted by the owner's rule below.
- #12 and #13 (fail-closed halves):
  - guests are refused the Windows screen, both viewing and control;
  - their phones show no Screen, and the invite sheet offers no screen roles.
- #14 (first half): Team is hidden on Windows, which has no team bridge yet.
- #23: Windows command output comes back in UTF-8, and the job tests have Windows twins.
- #25: "Windows PC" on pages every computer shows, with a ratchet test.
- #29: Files hides what Explorer hides.
- #30 and #49: the launcher gets Node for ARM64 too, and its download is quiet, retried, and says so when offline.
- #35: the voice memo mic shows only on a Mac.
- #37: Word and RTF files offer a download off a Mac.
- #38: deleted Claude chats go to the Recycle Bin.
- #39: a busy file gives "open in another program".
- #42: website shortcuts open through Start-Process.
- #44: `reach cli` writes a `reach.cmd`.
- #48: docs.

Built on Oct 13, each with unit tests and its real-Windows test passing on GitHub's windows-2025 runner (not a physical PC):

| Item | What | Runner |
| --- | --- | --- |
| D (no switch) | Browser sign-in, invites, Face ID join, linked computers on by detection; security review fixes | [38509795461](https://github.com/nalebc/reach/actions/runs/38509795461) |
| #9 (part) | The Claude app's records in %APPDATA%\Claude or its package's copy; idle and lock readings (scripts/native/presence.cs); claude:// links through Windows' own handler | [38508473706](https://github.com/nalebc/reach/actions/runs/38508473706) |
| #34, #40, #43 | The owner's shell (Windows Terminal's default profile, else PowerShell 7, else Windows PowerShell); drives attached later; the launcher's name on the phone | [38508476228](https://github.com/nalebc/reach/actions/runs/38508476228) |
| #16 | Reach's icon in the notification area (scripts/native/tray.cs) | [38508861579](https://github.com/nalebc/reach/actions/runs/38508861579) |
| #28 | Apps' icons and agents' logos (scripts/native/app-icons.cs) | [38509987557](https://github.com/nalebc/reach/actions/runs/38509987557) |
| #37 | Word, RTF and OpenDocument text read in JS off a Mac; .doc stays a download | [38510232232](https://github.com/nalebc/reach/actions/runs/38510232232) |
| #35 | Voice memos through System.Speech (scripts/native/transcribe.cs) | [38511383861](https://github.com/nalebc/reach/actions/runs/38511383861) |

Built on Oct 14 (workstream N, second part), with unit tests on this Mac and its real-Windows tests passing on GitHub's windows-2025 runner, not yet on a physical PC.
- Stand-ins named and placed as the app, Claude Code and an Electron helper are: [38583448433](https://github.com/nalebc/reach/actions/runs/38583448433).
- The Claude app itself (`test/windows-claude-app-real.test.mjs`, run only when asked: it downloads the app) passes in [38585021392](https://github.com/nalebc/reach/actions/runs/38585021392):
  - Anthropic's MSIX, Claude 2.37337.1, was installed with Add-AppxPackage as its deployment guide says, then opened from the Start menu's apps folder.
  - Its program is `C:\Program Files\WindowsApps\Claude_2.37337.1.0_x64__pzs8sxrjxfjjc\app\claude.exe`, with family name `Claude_pzs8sxrjxfjjc`.
  - Its data is in the package's own copy, `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude`.
  - It reads as installed before it's first opened.
  - Reach found its running process and its start through the server's own readers.
  - Its installer build (ClaudeSetup.exe, `%LOCALAPPDATA%\AnthropicClaude`) hasn't been run there.

- #9 (rest): whether the Claude app runs, and since when, from the PC's process list (`server/windows-processes.mjs`). The app is its own program by its path: its installer's `%LOCALAPPDATA%\AnthropicClaude\…\claude.exe` or its package's `WindowsApps\Claude_<version>_<arch>__<publisher id>\…`, never one of Electron's `--type=` helpers. Claude Code's own `claude.exe` (its installer's, the app's copy in its data folder, the ones Reach starts) never counts. This makes three things work as on a Mac: a chat the open app lists isn't deleted under it ("delete it there"), chats Reach starts join an open app's list by its import link once nobody is at the PC (the link the Mac's app takes; not yet tried with the Windows app, which no runner has), and the phone knows the app is open. The app's window isn't reloaded after Reach replies yet (H): it shows them once the app is opened again.

Built on Oct 13 (workstreams K and L), with unit tests on this Mac; their real-Windows tests passed on GitHub's Windows runner on Oct 14 (run 38583519240: the process list, status and a second Reach refused, an agent's restart asking, stop, Reach's own window, `powercfg` listing the stay-awake helper, a real background task installed, run, restarted and removed), not yet on a real PC:

- #3: sleep prevention on Windows, in the Mac's three modes: a C# helper (`scripts/native/stay-awake.cs`) holds `SetThreadExecutionState` for the system and the display, says what it holds, and lets go when Reach ends; `reach status` shows it. The lane checks `powercfg /requests`.
- #4: background mode and start at sign-in: `reach install`, `setup background`, `uninstall`, `stop`, `restart` and `update` handle a Scheduled Task of yours (`scripts/windows-task.mjs`): your sign-in, your session's InteractiveToken logon (Tailscale's route check and the desktop need it; never batch or S4U), least privilege, no time limit, on battery. It runs a windowless C# starter (`scripts/native/background.cs`) that runs the launcher with `--service` on Reach's own Node, logs, and starts it again 5 s after it ends unexpectedly. The old `npm run install-service` Startup entry is retired and removed.
- #10: one Reach per computer: the launcher reads the PC's process list (`scripts/native/processes.cs`, `server/windows-processes.mjs`) for lock, status, stop, restart and update; an agent's restart (no terminal, or an editor's or agent's shell, from the parent chain) asks on the phone; `update` stops Reach before npm. Where the list can't be read, the per-folder H20 behaviour, said as such.
- #11: restarts and updates in a visible window: Windows Terminal, else a console window, titled Reach, through cmd's `start` (never a child of the Reach it stops), for `reach restart`, the phone's Restart card and phone updates. A phone update hands the confirmed version to that window as a one-time request, since Windows can't replace a running Reach's files.
- #31: the first run installs while its setup asks, on Windows too.
- #32: `reach status` prints the Mac's lines on Windows (routes, sleep prevention, sign-in).


Workstream D (public door) and the first part of M (coding agents) were merged on Oct 12.

- **D:** on by detection since Oct 13, with no switch, Face ID join and linked computers included (owner: "No flag should exist"). A security review of the switch-free door runs with that change.
- **M:**
  - #2: Codex's session service is reached over a named pipe.
  - #17: Codex and Team pipes are checked. Only one known to be another account's is refused; one that couldn't be checked is used, as on a Mac.
  - #46: the Codex holder.
  - #7: Git for Windows appears in health and installs from the phone.
  - #33: agent updates.
  - #45: Gemini is detected.
  - #14: the team bridge runs on a named pipe.
  - #15 (Oct 13): OpenClaw natively, as its makers document it (docs.openclaw.ai/platforms/windows). The pieces:
    - Install: OpenClaw's own PowerShell installer, without onboarding, in a Reach terminal. On a PC whose Node is older than 24.16, OpenClaw's own Node is added first (its installer's `-NodeOnly`, in `~\.openclaw\tools\cli-node`). The phone says so before the tap.
    - Running it: npm's `openclaw.cmd` is found as the `openclaw.mjs` it runs, also where an install made since Reach started puts it. It's started with a Node OpenClaw accepts, fixed arguments, and no shell.
    - Secrets: keys go only in OpenClaw's own variable or on its stdin. Telegram's token file is closed to all but the owner, SYSTEM and Administrators before the token goes in.
    - Timeouts end the whole process tree.
    - Node recovery after an update runs the installer in OpenClaw's package.
    - OpenClaw's own Windows app (Windows Hub) can keep its Gateway in a locked-down WSL distro of its own (`OpenClawGateway`). Reach uses that Gateway (owner, Oct 13), going by the app's registry (`%APPDATA%\OpenClawTray\gateways.json`: the distro, the Gateway's address, its shared token):
      - Over its WebSocket on loopback: chats, health, logs, WhatsApp, schedules. A record the app reaches at a tailnet address (its Tailscale Serve option) is refused: Reach is the private way in.
      - Inside the distro, as the app itself runs OpenClaw: `wsl.exe -d <distro> --user openclaw -- bash -s`, the script on stdin, fixed words only (wsl.exe rewrites `$` in arguments, never stdin). Keys come on stdin after the script; Telegram's token by bash's own `read` into a file only `openclaw` reads. Nothing goes through `WSLENV`. Covers keys, the default model, Telegram, Doctor, and the Gateway's start and restart.
      - Refused, with the reason: Discord and Slack (OpenClaw takes their tokens only on a command line, and their plugins aren't part of OpenClaw; OpenClaw's guided setup does them over the WebSocket), repairs and updates (the app keeps that Gateway), a second install or setup.
      - The Gateway's token: the app's record keeps it in plaintext and never clears it after pairing (only the one-time bootstrap token goes); a record carried over from the app's older settings may have none, and then it's read from the Gateway's own `openclaw.json` in the distro, with the same checks as this PC's own config.
      - Unproven until a real PC with the app: WSL's localhost forwarding reaching the Gateway as loopback (else it asks to approve Reach as a device, and the phone says to approve it in the app); WSL stopping its VM when the app isn't running (the app keeps it awake; Reach doesn't); wsl.exe's own notes on stdout (Reach drops lines starting `wsl: ` before reading OpenClaw's JSON).
    - Proof so far: `test/windows-openclaw.test.mjs` and `test/windows-openclaw-hub.test.mjs`, in the Windows lane; the WSL scripts run by real bash on Mac and Linux (WSL can't run on GitHub's runners).

Follow-ups the reviews left, both for a real PC:
- **Stale Claude Code record** (built Oct 14; its real-Windows test, that Claude Code's noted start and the PC's list agree to the millisecond, passes on the runner: [38583448433](https://github.com/nalebc/reach/actions/runs/38583448433)). Claude Code on Windows notes its process's start as Windows keeps it (`procStartFt`, GetProcessTimes' 100 ns ticks since 1601, the twin of the Mac's `procStart`). A record now holds its chat only while the PC's process list gives that pid the same start, to the millisecond. A pid Windows has given since to another Claude Code or Node no longer reads as a held chat. Where the list can't be read, tasklist's word (by program only) stands, as before.
- **Silent delete.** A file the Recycle Bin can't take is deleted for good without a word. This happens when the bin is off for that drive or the file is too big for it.

The rest are in workstreams K to W below.

## Rules

0. Parity is measured against what the Mac code and its tests do, not against the docs (they had drifted: `docs/SECURITY.md` promised an owner-presence check the helper no longer runs).
1. macOS behaviour stays byte-for-byte the same; every change carries unit tests (`test/helpers/as-windows.mjs`) and real-Windows CI evidence (the `windows-2025` lane, under the Restricted script policy).
2. Fail closed: a helper that can't start, a target it can't identify, a policy it can't read → refuse, with the reason.
3. Windows helpers are C# (C# 5, .NET Framework 4.8). Owner decision, Oct 12: they are **signed through SignPath Foundation**, product name *Reach* (the certificate names SignPath Foundation as publisher), built by GitHub Actions from this repository, each signing approved by hand, shipped in the npm package and release archives, and run only after Reach checks the SignPath Foundation signature and the release's pinned SHA-256 (`docs/CODE_SIGNING.md`). Without a signed helper (a source checkout, or before SignPath approves Reach), Reach compiles them on first use with the PC's `csc.exe`, cached by source hash as Swift helpers are on a Mac; PCs that only run signed programs then refuse with the reason. No PowerShell in agent paths, nothing downloaded at run time.
4. One shared policy corpus: the Windows helper runs the same decisions test the Swift helper and the JS policy run (`test/agent-desktop-policy-native.test.mjs`).
5. Nothing is described as working on Windows until its real-Windows test passes. Nothing waits behind a switch either: Reach detects what the PC can do, and says why when it can't (owner, Oct 13). The owner's real-PC acceptance (`docs/FIRST_RUN_MATRIX.md` M8) is what lets the docs say "works".
6. Each phase ends with an adversarial security review of its diff.

## Workstreams and order

| # | Workstream | Depends on | Main files |
| --- | --- | --- | --- |
| A | Foundation: per-agent pause store out of the desktop service; platform-neutral app ids and paths (`.exe`, AUMIDs), modifiers (cmd→Ctrl, option→Alt); Windows guard data (password managers, Credential Manager, consent.exe, CredentialUIBroker, LogonUI, Task Manager, regedit, mmc, ms-settings privacy/sign-in/network pages; runas, reg, bcdedit, netsh, sc, schtasks, icacls, takeown, Set-MpPreference); the C# helper build (`windowsBinary`) | — | `agent-desktop.mjs`, `agent-guard.mjs`, `agent-presets.mjs`, `desktop-native.mjs`, `agent-pauses.mjs`, `index.mjs` |
| B | Windows agent desktop helper: filtered screenshot (protected windows masked), SendInput (Unicode text), held buttons released on exit, per-event target check (WindowFromPoint → process image → WinVerifyTrust), UI Automation for describe / find / press / fill / read_page / menus / windows / focus, open app / URL / file, app catalog, secret fills (IsPassword, never echoed), bank-site URL read-only. No guessing the owner's presence from input timing: the Mac stopped doing that on Oct 8 (the owner pauses agents) | A | new `scripts/native/agent-desktop.cs`, Windows adapter in `agent-desktop.mjs` |
| C | Windows sandbox: AppContainer/LPAC + Job Object runner for agents' commands, scripts and the Full-control shell (pwsh); Files helper with handle-relative I/O (no reparse points or hard links) | A | new `scripts/native/sandbox.cs`, `jobs.mjs`, `browser-scripts.mjs`, `browser-file-boundary.mjs`, `agent-shell.mjs` |
| D | Public door on Windows: keyed Serve route + tailscaled peer check (design: `docs/WINDOWS_SIGN_IN_DESIGN.md`), on by detection (Oct 13): invite links, start page, agent gateway, hosted MCP, invite keys, Face ID join, linked computers | A | `tailscale-auth.mjs`, `launch.mjs`, `configure.mjs`, `index.mjs` refusals |
| E | Presets on Windows: lift the refusals once B/C/D pass; invite UI wording | B, C, D | `browser-access.mjs`, `BrowserInvite.tsx` |
| F | End to end on real Windows CI: invite → admission → MCP tool calls (screenshot, click and type into a test window, guardrail refusals on a password field and a protected window), sandboxed command, Files boundary, per-agent pause, phone control and Reach's pause stopping agent input | B, C, E | `test/windows-agent-e2e.test.mjs`, `ci.yml` |
| G | Saved browser tools: Chrome/Edge extension + native messaging host (replaces JXA) | B | new |
| T | The PC's own terminals, as the Mac's Terminal/iTerm2 tabs. Found Oct 12: a tester opened a terminal from the phone and nothing appeared on the laptop. **Built Oct 13, not yet run on a real PC** (`test/windows-terminals-native.test.mjs` drives it on the windows-2025 runner). One C# helper: <br>• **Finds** each console by its window: a classic window (ConsoleWindowClass), or the PseudoConsoleWindow a Windows Terminal tab has, which Windows Terminal owns (tabs handed over as the default terminal included). Windows names the console's first program as the window's, so a console is window + that program + its start time; a reused pid never matches. Reach's own terminals (shells Reach started) and other apps' pseudo consoles (VS Code) aren't listed; administrator consoles can't be, since Windows keeps a normal program out of them. <br>• **Reads** through the console API (AttachConsole, ReadConsoleOutputCharacterW): a console window with its scrollback; a Windows Terminal tab its screen, its scrollback staying in Windows Terminal, as iTerm2 gives only its screen. <br>• **Types** with WriteConsoleInputW, no focus needed. <br>• **Focuses** as B does: raised, then SetForegroundWindow once (a tab chosen by title through UI Automation when only one has it), `front:false` when Windows refuses. <br>• **Closes** a console window with WM_CLOSE, as its close button does. A Windows Terminal tab by ending the programs in it: Windows Terminal then closes just that tab or pane, never its other tabs and never with a question left on the PC; programs started from it that left it go on. <br>• **Opens** `wt.exe -w new new-tab -d <folder>` (its default profile, or the owner's shell running the command), else a console window. PowerShell gets the command encoded, cmd as the rest of its line, so it is only ever the shell's argument. <br>• **Watches** as the same helper run as a watch: console WinEvents for windows, a look once a second at listed Windows Terminal tabs while phones are connected (their consoles don't say when they print). | — | `scripts/native/windows-terminals.cs`, `server/windows-terminals.mjs`, `server/desktop-terminals.mjs`, `server/mac-terminal-watch.mjs`, `server/app-shortcuts.mjs`, `src/Sessions.tsx`, `src/TerminalList.tsx`, `src/MacTerminalView.tsx`, `src/terminal-titles.ts`, `src/capabilities.ts` |
| J | Real user journeys on real Windows and a real Mac: a headless browser drives the actual phone interface against a real Reach on GitHub's windows-2025 and macos-15 runners, page by page (Home, Chat with install and sign-in, Files, Terminals including the computer's own, Screen and control, Apps, Agents & people, invites, updates, pause), with real installers where they're free to run and no stand-in terminals or detection. Each journey runs on both platforms and must end in the same visible result; a step with no visible outcome fails. Found Oct 12: fakes let "installed but not found" and "terminal not on the PC" pass | A | new `test/journeys/*.test.mjs`, `ci.yml` |
| S | Signing: SignPath project *Reach*; a release job builds the helpers on Windows with product metadata *Reach* and the release version, submits them for signing (manual approval), verifies the signature, and adds them and their SHA-256 to the npm package; the server prefers a verified signed helper and falls back to `windowsBinary` | B, owner's SignPath approval | `.github/workflows/release.yml`, `server/desktop-native.mjs`, `scripts/native/*.cs` |
| K | Keep the PC reachable (audit #3, #4, #32): a keep-awake helper with the Mac's three modes; start at sign-in as a per-user Scheduled Task running the real launcher; `reach status` lines. Built Oct 13 | A | `scripts/launch.mjs`, `scripts/stay-awake.mjs`, `scripts/background-service.mjs`, `scripts/windows-task.mjs`, `scripts/setup.mjs`, `scripts/service.mjs`, `scripts/instances.mjs`, `scripts/native/stay-awake.cs`, `scripts/native/background.cs` |
| L | Launcher lifecycle (audit #10, #11, #30, #31, #41, #44, #49): one process inventory for lock, status, stop, restart and update, shipped together with a visible-console restart; `reach cli` shim; bootstrap.ps1 download, ARM64. Built Oct 13 (#30, #41, #44, #49 on Oct 12) | — | `scripts/bootstrap.mjs`, `scripts/stop.mjs`, `scripts/instances.mjs`, `server/windows-processes.mjs`, `scripts/native/processes.cs`, `restart-requests.mjs`, `reach-updates.mjs`, `scripts/bootstrap.ps1` |
| M | Coding agents (audit #2, #7, #8, #14, #15, #17, #33, #45, #46): Codex daemon transport, Git for Windows in health, team bridge on a SID-restricted pipe, pipe owner checks, updates, Gemini/Antigravity/Cursor detection, Codex holder, OpenClaw | — | `agent-sessions/*`, `agent-install.mjs`, `agent-updates.mjs`, `openclaw*.mjs` |
| N | Claude desktop app on Windows (audit #9): its record folder found on a real PC, then list, archive, watching and `claude://` links | — | `agent-sessions/claude-import.mjs`, `agent-sessions/claude.mjs`, `agent-watch.mjs` |
| P | Screen, control and guests (audit #5, #12, #13, #16, #26, #27, #47): guests' mask and concealed clipboard; locked state as the Mac's idle byte; H.264 without FFmpeg; UI Automation in the owner's input helper; tray Pause/Resume | B (classifier, UIA), S | `remote-screen.mjs`, `screen-stream.mjs`, `scripts/native/*.ps1`, `desktop-connection.mjs` |
| W | Wording and conveniences (audit #25, #28, #29, #34–#40, #42, #43, #48): computerWord everywhere with a UI test, icons, hidden files, document text, HEIC, voice, Recycle Bin, shell choice | — | `src/*`, `computer-word.mjs`, `app-icons.mjs`, `document-text.mjs`, `terminal.mjs` |
| U | Proof below the phone (audit #18–#24, #50): stand-in `tailscale.exe`, `reach.cmd` through ConPTY, jobs, Files escapes, `reach-agent`, a Windows `test:ci`, a standard-user run, windows-2022 | — | `.github/scripts/run-tests.mjs`, `.github/workflows/ci.yml`, `test/windows-*.test.mjs` |
| H | Mac-dialog equivalents via UI Automation (SmartScreen, file security), window-only streaming (one HWND), Claude consent on Claude Desktop, the Claude app's own window (View ▸ Reload after Reach replies, its box for drafts, Stop, the model menu: `claude-compose.mjs` and `reloadClaudeWindow` are Mac-only, so a PC takes Stop and the model through Claude Code and keeps drafts on the phone), permission hooks over a named pipe restricted to the user's SID | B | various |

Phases: 1) A built, B/C/D designed in detail and reviewed; 2) B, C, D built in parallel worktrees; 3) E + F, iterate on real Windows until green; 4) G, H; 5) the owner's real-PC acceptance (public door, physical phone), which lets the docs say "works".

## Owner acceptance on a real Windows PC (end of phase 5)

Invite an agent with each preset over the public link and over the tailnet; the agent screenshots, clicks and types, and is refused on a password field, an administrator prompt and a protected window; Files stays inside its folders; a sandboxed command can't touch Reach's files; pausing the agent, taking control from the phone and pausing Reach each stop its input at once.
