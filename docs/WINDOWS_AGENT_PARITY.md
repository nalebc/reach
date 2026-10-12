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

## Rules

1. macOS behaviour stays byte-for-byte the same; every change carries unit tests (`test/helpers/as-windows.mjs`) and real-Windows CI evidence (the `windows-2025` lane, under the Restricted script policy).
2. Fail closed: a helper that can't start, a target it can't identify, a policy it can't read → refuse, with the reason.
3. Windows helpers are C#, compiled on first use with the `csc.exe` every Windows 10/11 ships (.NET Framework 4.8), cached by source hash, exactly as Swift helpers are on a Mac. No PowerShell in agent paths (execution policy, cold starts), no downloaded binaries.
4. One shared policy corpus: the Windows helper runs the same decisions test the Swift helper and the JS policy run (`test/agent-desktop-policy-native.test.mjs`).
5. Nothing is described as working on Windows until its real-Windows test passes. The public door stays behind `REACH_WINDOWS_ACCOUNT=1` until the owner's real-PC acceptance (`docs/WINDOWS_SIGN_IN_DESIGN.md`).
6. Each phase ends with an adversarial security review of its diff.

## Workstreams and order

| # | Workstream | Depends on | Main files |
| --- | --- | --- | --- |
| A | Foundation: per-agent pause store out of the desktop service; platform-neutral app ids and paths (`.exe`, AUMIDs), modifiers (cmd→Ctrl, option→Alt); Windows guard data (password managers, Credential Manager, consent.exe, CredentialUIBroker, LogonUI, Task Manager, regedit, mmc, ms-settings privacy/sign-in/network pages; runas, reg, bcdedit, netsh, sc, schtasks, icacls, takeown, Set-MpPreference); the C# helper build (`windowsBinary`) | — | `agent-desktop.mjs`, `agent-guard.mjs`, `agent-presets.mjs`, `desktop-native.mjs`, `agent-pauses.mjs`, `index.mjs` |
| B | Windows agent desktop helper: filtered screenshot (protected windows masked), SendInput (Unicode text), held buttons released on exit, per-event target check (WindowFromPoint → process image → WinVerifyTrust), UI Automation for describe / find / press / fill / read_page / menus / windows / focus, open app / URL / file, app catalog, secret fills (IsPassword, never echoed), bank-site URL read-only, owner-presence detection (low-level hooks, injected vs physical) | A | new `scripts/native/agent-desktop.cs`, Windows adapter in `agent-desktop.mjs` |
| C | Windows sandbox: AppContainer/LPAC + Job Object runner for agents' commands, scripts and the Full-control shell (pwsh); Files helper with handle-relative I/O (no reparse points or hard links) | A | new `scripts/native/sandbox.cs`, `jobs.mjs`, `browser-scripts.mjs`, `browser-file-boundary.mjs`, `agent-shell.mjs` |
| D | Public door on Windows: keyed Serve route + tailscaled peer check (design: `docs/WINDOWS_SIGN_IN_DESIGN.md`), behind `REACH_WINDOWS_ACCOUNT=1`: invite links, start page, agent gateway, hosted MCP, invite keys | A | `tailscale-auth.mjs`, `launch.mjs`, `configure.mjs`, `index.mjs` refusals |
| E | Presets on Windows: lift the refusals once B/C/D pass; invite UI wording | B, C, D | `browser-access.mjs`, `BrowserInvite.tsx` |
| F | End to end on real Windows CI: invite → admission → MCP tool calls (screenshot, click and type into a test window, guardrail refusals on a password field and a protected window), sandboxed command, Files boundary, per-agent pause, owner presence | B, C, E | `test/windows-agent-e2e.test.mjs`, `ci.yml` |
| G | Saved browser tools: Chrome/Edge extension + native messaging host (replaces JXA) | B | new |
| H | Mac-dialog equivalents via UI Automation (SmartScreen, file security), window-only streaming (one HWND), Claude consent on Claude Desktop, permission hooks over a named pipe restricted to the user's SID | B | various |

Phases: 1) A built, B/C/D designed in detail and reviewed; 2) B, C, D built in parallel worktrees; 3) E + F, iterate on real Windows until green; 4) G, H; 5) the owner's real-PC acceptance (public door, physical phone), then defaults on.

## Owner acceptance on a real Windows PC (end of phase 5)

Invite an agent with each preset over the public link and over the tailnet; the agent screenshots, clicks and types, and is refused on a password field, an administrator prompt and a protected window; Files stays inside its folders; a sandboxed command can't touch Reach's files; pausing the agent and the owner touching the mouse both stop its input at once.
