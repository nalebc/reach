# Agent access on Windows: parity plan

Goal (owner, Oct 12 2026): an agent gets on a Windows PC exactly what it gets on a Mac, proven end to end on real Windows. Inventory: every Mac capability, its gate and its Windows route, re-checked on `ac2ec2cc`.

## Today on Windows

- Refused: all four browser presets (Full control, Apps, Files, Read only), invite links, the start page, the agent gateway and hosted MCP (no trusted private ingress), agents' and invited people's commands (no sandbox; refused since `aa09b7da` instead of running unsandboxed).
- Works: command-line agents over the tailnet for files.
- Broken quietly: pausing one agent does nothing off a Mac (the pause store lives in the Mac-only desktop service).

## What parity means

Same tools, same answers, same refusals. Where Windows can't do what the Mac does, the agent gets the same guarantee by another mechanism, or the gap is written down here and in the phone's wording, never hidden.

| Not possible on Windows | Why | What happens instead |
| --- | --- | --- |
| Reading or answering UAC prompts | The secure desktop is closed to every app by design | The agent is told an administrator prompt is up and waits; the owner answers at the PC |
| Hidden per-app displays (`apps:drive`, owner profiles only) | Needs an attestation-signed virtual display driver | Apps run on the real screen, as the Apps preset already does on a Mac |
| Acting in elevated (administrator) windows | UIPI; needs a signed `uiAccess` helper installed in Program Files | Refused with the reason, as a guardrail |

## Decisions: the same on Mac and Windows (owner, Oct 12)

"Make the same decisions between Mac and Windows; don't let them diverge." Where a design left a Windows-only choice, it takes the Mac's, or both platforms change together:

| Question | Both platforms |
| --- | --- |
| Reach running inside a terminal app | Only the window whose title names Reach is closed to narrower presets (the Mac's title rule); Reach titles its own console window "Reach" on both |
| Browser developer-tools keys (Firefox Ctrl/Cmd+Shift/Opt+K, E, Z) | Refused on both: the Mac gains the refusal it lacked |
| A browser on the computer itself asking to be approved | Allowed on both; the approval prompt says it came from this computer itself, on both |
| Where account approval is turned on | Saved setup preferences (`./reach setup`), on both; no Windows-only environment variable once it is accepted |
| Reach's own files writable by other users of the computer | Same check on both: refused with the reason |
| This computer as a Tailscale exit node | Allowed on both; Windows adds a CI test proving the keyed route stays closed |
| Reach's folders | Owner-only on both (0700 / owner, SYSTEM, Administrators ACL) |
| Company-managed computers blocking Reach's helpers | Refused with the reason on both |
| Protected windows covered by others | The Mac's refined rule on both |
| File manager in the Apps picker | Offered on both (Finder, File Explorer), with the same guards |

Only what Windows itself makes impossible differs (table above): UAC prompts, hidden per-app displays, administrator windows.

## Rules

0. Parity is measured against what the Mac code and its tests do, not against the docs (they had drifted: `docs/SECURITY.md` promised an owner-presence check the helper no longer runs).
1. macOS behaviour stays byte-for-byte the same; every change carries unit tests (`test/helpers/as-windows.mjs`) and real-Windows CI evidence (the `windows-2025` lane, under the Restricted script policy).
2. Fail closed: a helper that can't start, a target it can't identify, a policy it can't read → refuse, with the reason.
3. Windows helpers are C# (C# 5, .NET Framework 4.8). Owner decision, Oct 12: they are **signed through SignPath Foundation**, product name *Reach* (the certificate names SignPath Foundation as publisher), built by GitHub Actions from this repository, each signing approved by hand, shipped in the npm package and release archives, and run only after Reach checks the SignPath Foundation signature and the release's pinned SHA-256 (`docs/CODE_SIGNING.md`). Without a signed helper (a source checkout, or before SignPath approves Reach), Reach compiles them on first use with the PC's `csc.exe`, cached by source hash as Swift helpers are on a Mac; PCs that only run signed programs then refuse with the reason. No PowerShell in agent paths, nothing downloaded at run time.
4. One shared policy corpus: the Windows helper runs the same decisions test the Swift helper and the JS policy run (`test/agent-desktop-policy-native.test.mjs`).
5. Nothing is described as working on Windows until its real-Windows test passes. The public door stays behind `REACH_WINDOWS_ACCOUNT=1` until the owner's real-PC acceptance (`docs/WINDOWS_SIGN_IN_DESIGN.md`).
6. Each phase ends with an adversarial security review of its diff.

## Workstreams and order

| # | Workstream | Depends on | Main files |
| --- | --- | --- | --- |
| A | Foundation: per-agent pause store out of the desktop service; platform-neutral app ids and paths (`.exe`, AUMIDs), modifiers (cmd→Ctrl, option→Alt); Windows guard data (password managers, Credential Manager, consent.exe, CredentialUIBroker, LogonUI, Task Manager, regedit, mmc, ms-settings privacy/sign-in/network pages; runas, reg, bcdedit, netsh, sc, schtasks, icacls, takeown, Set-MpPreference); the C# helper build (`windowsBinary`) | — | `agent-desktop.mjs`, `agent-guard.mjs`, `agent-presets.mjs`, `desktop-native.mjs`, `agent-pauses.mjs`, `index.mjs` |
| B | Windows agent desktop helper: filtered screenshot (protected windows masked), SendInput (Unicode text), held buttons released on exit, per-event target check (WindowFromPoint → process image → WinVerifyTrust), UI Automation for describe / find / press / fill / read_page / menus / windows / focus, open app / URL / file, app catalog, secret fills (IsPassword, never echoed), bank-site URL read-only. No guessing the owner's presence from input timing: the Mac stopped doing that on Oct 8 (the owner pauses agents) | A | new `scripts/native/agent-desktop.cs`, Windows adapter in `agent-desktop.mjs` |
| C | Windows sandbox: AppContainer/LPAC + Job Object runner for agents' commands, scripts and the Full-control shell (pwsh); Files helper with handle-relative I/O (no reparse points or hard links) | A | new `scripts/native/sandbox.cs`, `jobs.mjs`, `browser-scripts.mjs`, `browser-file-boundary.mjs`, `agent-shell.mjs` |
| D | Public door on Windows: keyed Serve route + tailscaled peer check (design: `docs/WINDOWS_SIGN_IN_DESIGN.md`), behind `REACH_WINDOWS_ACCOUNT=1`: invite links, start page, agent gateway, hosted MCP, invite keys | A | `tailscale-auth.mjs`, `launch.mjs`, `configure.mjs`, `index.mjs` refusals |
| E | Presets on Windows: lift the refusals once B/C/D pass; invite UI wording | B, C, D | `browser-access.mjs`, `BrowserInvite.tsx` |
| F | End to end on real Windows CI: invite → admission → MCP tool calls (screenshot, click and type into a test window, guardrail refusals on a password field and a protected window), sandboxed command, Files boundary, per-agent pause, phone control and Reach's pause stopping agent input | B, C, E | `test/windows-agent-e2e.test.mjs`, `ci.yml` |
| G | Saved browser tools: Chrome/Edge extension + native messaging host (replaces JXA) | B | new |
| T | The PC's own terminals, as the Mac's Terminal/iTerm2 tabs (`server/desktop-terminals.mjs`, `scripts/native/mac-terminals.js`, `src/Sessions.tsx` "Mac tabs", the Terminals page's default source): list the PC's open console and Windows Terminal tabs, read their text (console API for conhost, UI Automation TextPattern for Windows Terminal), type into them, focus and close them, and open a new visible one in a chosen folder from the phone (`wt.exe -d`, else a console window). Found Oct 12: a tester opened a terminal from the phone and nothing appeared on the laptop | B (helper) | `server/desktop-terminals.mjs`, new `scripts/native/windows-terminals.cs`, `src/Sessions.tsx`, `src/capabilities.ts` |
| J | Real user journeys on real Windows and a real Mac: a headless browser drives the actual phone interface against a real Reach on GitHub's windows-2025 and macos-15 runners, page by page (Home, Chat with install and sign-in, Files, Terminals including the computer's own, Screen and control, Apps, Agents & people, invites, updates, pause), with real installers where they're free to run and no stand-in terminals or detection. Each journey runs on both platforms and must end in the same visible result; a step with no visible outcome fails. Found Oct 12: fakes let "installed but not found" and "terminal not on the PC" pass | A | new `test/journeys/*.test.mjs`, `ci.yml` |
| S | Signing: SignPath project *Reach*; a release job builds the helpers on Windows with product metadata *Reach* and the release version, submits them for signing (manual approval), verifies the signature, and adds them and their SHA-256 to the npm package; the server prefers a verified signed helper and falls back to `windowsBinary` | B, owner's SignPath approval | `.github/workflows/release.yml`, `server/desktop-native.mjs`, `scripts/native/*.cs` |
| H | Mac-dialog equivalents via UI Automation (SmartScreen, file security), window-only streaming (one HWND), Claude consent on Claude Desktop, permission hooks over a named pipe restricted to the user's SID | B | various |

Phases: 1) A built, B/C/D designed in detail and reviewed; 2) B, C, D built in parallel worktrees; 3) E + F, iterate on real Windows until green; 4) G, H; 5) the owner's real-PC acceptance (public door, physical phone), then defaults on.

## Owner acceptance on a real Windows PC (end of phase 5)

Invite an agent with each preset over the public link and over the tailnet; the agent screenshots, clicks and types, and is refused on a password field, an administrator prompt and a protected window; Files stays inside its folders; a sandboxed command can't touch Reach's files; pausing the agent, taking control from the phone and pausing Reach each stop its input at once.
