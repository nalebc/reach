# First-run matrix

This matrix covers every way a new person can meet Reach for the first time: the computer they install it on, what they already have on it (Tailscale, agents, developer tools), and the phone they open it from. Each use case lists the result it must give and the test that checks it.

Automated rows run with `npm run test:file -- <file>`. Manual rows need real phones or other computers and are recorded by the person who ran them.

**Status values:**

- **passed** or **failed**: the latest run, with its date.
- **planned**: the test isn't written yet.
- **known limit**: documented, not fixed in this pass.
- **manual**: run on real devices; the result is recorded here.

**Test types:**

| Type | What runs | Where |
| --- | --- | --- |
| U | A pure function | `test/*.test.mjs` |
| S | Reach in-process (`createReach`), real HTTP, injected detectors | `test/*.test.mjs` |
| P | A real child Reach process: temporary home and data, a fake Tailscale (`REACH_TAILSCALE`), a stubbed shell | `test/*.test.mjs` |
| D | Real React components in jsdom (`test/dom/harness.mjs`), fake routes | `test/*-ui.test.mjs` |
| V | The real interface in a browser at 390 px and 320 px, using the demo fixture (`node scripts/demo/start.mjs`) | screenshots |
| M | Physical phones and other computers | recorded below |

**Windows paths run on this Mac too.** `test/helpers/as-windows.mjs`, preloaded into a child Reach, makes its `process.platform` say win32. Reach's own Windows branches run for real, through the real launcher. Since Oct 14 the same tests also run on GitHub's Windows runner with Windows itself: the stand-in Tailscale is a `tailscale.exe` there (`test/fixtures/windows/tailscale-shim.cs`), `.\reach.cmd` runs in a real console (`windows-console`), and Windows' own process list, taskkill and job objects end what they end. A physical PC with real Tailscale and a phone is still M8's.

**Clean-machine tests never trust `PATH`.** Detection goes through the login shell (`$SHELL -lc`) and fixed `/Applications/...` paths, so a test that only empties `PATH` still finds Claude or Codex on a developer's Mac. `test/helpers/clean-machine.mjs` injects every detector instead.

## How the first connection works

1. On the computer: `./reach`. The terminal shows one link and its QR: `https://<computer>.<tailnet>.ts.net`.
2. With the **Tailscale app** on the phone, the link opens Reach directly. This is the fastest way, and it works at any time.
3. Without the app, the same link opens the **start page**. The phone signs in to Tailscale in the browser and joins the tailnet. Nothing is installed.
4. Either way, the phone shows a code. You type it in the terminal to approve the phone, or run `./reach approve` when Reach runs in the background.
5. The start page is public only during a **pairing window**. A window opens for 15 minutes:
   - on every interactive `./reach` start;
   - during setup's phone step;
   - on `./reach pair`.

   It closes when a phone is approved or the time runs out. Outside a window, and outside an invitation or agent session, the internet gets "Not found."
6. **In the browser (no app)**, Reach asks you to get the Tailscale app, so that you can open Reach any time and have a faster connection. It asks right away, then from time to time.
7. **With the app**, Reach offers to add itself to the Home Screen. The Home Screen copy is the same Tailscale device, so it's approved without another code.

## H. Starting Reach on the computer

| ID | Case | Expected | Type | Test | Status |
| --- | --- | --- | --- | --- | --- |
| H1 | Node 22+ is on PATH | Reach uses it | P | CI `./reach --help` | CI only |
| H2 | Node is missing or older than 22.12 | Reach downloads its pinned private Node and checks its hash | U | `installable` (version/hash parity) | passed Oct 10 |
| H3 | No internet, curl, tar, or checksum tool | Names the missing tool before downloading; offers installing it or Node.js 22+. A failed download leaves no partial runtime | P, M | `launcher-script`, M7 | passed Oct 11 (isolated tools); Ubuntu device check remains M7 |
| H4 | Unsupported OS or CPU | Git Bash on Windows is sent to `.\reach.cmd`; another computer is named, with installing Node.js 22+ yourself as the way | U | `launcher-script` | fixed, passed Oct 10 |
| H5 | `npm ci` or the build fails | Names the likely fix (build tools, internet, disk), then `.reach/setup.log` | P | `setup-blockers` | fixed, passed Oct 10 |
| H6 | No Go toolchain | Reach starts. Without the browser client, phones need the Tailscale app | P | `release-assets` | passed Oct 10 |
| H7 | Reach is already running, or its lock is held | Says where it runs and offers restart with the active launcher; a held lock also offers restart | P | `instances`, `windows-commands` | passed Oct 11 (Windows shim; real console remains M8) |
| H8 | Started from iTerm, VS Code, Warp or Codex on a Mac | Opens a Terminal window and runs there | U | `outside-terminal` | passed Oct 10 |
| H9 | No terminal (no TTY) | Skips the guided setup and names the next step | P | `setup-blockers`, `tailscale-connect`, `first-run-launch` | passed Oct 10 |
| H10 | Ctrl+C at a menu or during a wait | "Paused. Run ./reach to continue."; lock released; resumes at the same step | U, P, M | `setup-blockers`, `windows-console`, M7 | fixed, passed Oct 10; in a real terminal on Ubuntu (M7) too; in a real Windows console Oct 14 (`.\reach.cmd` through ConPTY on GitHub's Windows runner, [38587350195](https://github.com/nalebc/reach/actions/runs/38587350195)): at a menu and while waiting, "Paused. Run .\reach.cmd to continue your setup.", the lock goes, nothing starts again (cmd then asks "Terminate batch job (Y/N)?", as for any .cmd) |
| H11 | npm global install | Settings and phones live in `~/.reach` | U | `installable` | passed Oct 10 |
| H12 | Checkout under `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive | Detected; background mode explained (see B2) | U | `setup-blockers` | fixed, passed Oct 10 |
| H13 | Linux without a C compiler, or a node-gyp download fails | Names build packages for a build failure; network failures name the connection fix first | U, M | `setup-blockers`, M7 | passed Oct 11; real compiler failure was checked Oct 10 |
| H18 | Windows, first `.\reach.cmd` in a terminal | The guided setup, as on a Mac: 1. Tailscale on this computer with your account (T17–T21), 2. HTTPS link for your phone (T22), 3. your phone: the one address and browser sign-in, or the pairing code with the reason when this PC can't hold the keyed route yet (T23). Invite links and background mode wait for later, as on a Mac (`.\reach.cmd setup background`: a task of yours at sign-in, H21). The install runs while setup asks, as on a Mac (H14) | U | `setup`, `windows-sign-in`, `first-start`, `prompts`, `windows-console` | changed Oct 13 (no switch, owner; background step and install alongside setup, K and L): setup's Windows steps pass with the Windows shim, `first-start` and `prompts` in the Windows lane; Oct 14, the whole first run through `.\reach.cmd` in a real console on GitHub's Windows runner ([38587350195](https://github.com/nalebc/reach/actions/runs/38587350195)): bootstrap.ps1, the supervisor and Reach, every Tailscale state, its arrow-key menus moved with ↑/↓, the pages it opens, then the QR and pairing code (that runner can't hold the keyed route: no Tailscale service to check its connections); Tailscale and the browser are stand-ins there. A physical PC (M8): a person's own PowerShell window, real Tailscale |
| H19 | Windows: hints on the first-run path (setup's wait, `pair`, `approve`, `configure`, `link`, `update`) and the phone's ("run … configure", "run … invites") | Name `.\reach.cmd`, never `./reach` | U | `setup`, `tailscale-connect`, `windows-commands`, `windows-console` | passed Oct 11 with the Windows shim, including service and linked-computer hints; setup's waits and pause name `.\reach.cmd` in a real Windows console too (Oct 14, [38587350195](https://github.com/nalebc/reach/actions/runs/38587350195)); `pair`, `approve`, `link` and `update` there: M8 |
| H14 | First run in a terminal (a checkout) | The install (npm, the phone interface, browser sign-in) runs while setup asks about Tailscale; the first question comes in seconds, not after the install. Nothing the install says interrupts a menu; menus are numbered until it's done. `setup.log` records how long setup and each install part took | U | `first-start`, `prompts` | fixed, passed Oct 10 |
| H15 | Setup done before the install | "Finishing the first install: <part>…", then Reach starts | U | `first-start` | fixed, passed Oct 10 |
| H16 | The install fails during setup (no internet, no compiler) | Setup finishes and is saved; the install's fix is said after it | U | `first-start` | fixed, passed Oct 10 |
| H17 | Ctrl+C during setup while installing | "Paused"; npm and the Go build stop; the next `./reach` installs again and resumes setup | U | `first-start` | fixed, passed Oct 10 (bootstrap's wiring: manual, M6) |
| H20 | Windows: `.\reach.cmd status`, `stop`, `restart`, `update`, and a second `.\reach.cmd` | One Reach per computer, as on a Mac: Reach reads the PC's process list (a C# helper built on first use), so a second Reach from any folder is refused with where the first runs, `status` names whichever Reach runs with the Mac's lines (routes, sleep prevention, sign-in), and `stop` lists Reach's terminals and asks first (no terminal to ask in needs `--yes`), then asks each Reach through a file it watches; Reach stops as Ctrl+C stops it. One that doesn't is ended only while it's still the very process asked (same id, same start). An agent's `restart` (no terminal, or an editor's or agent's shell, from the process's parents) asks on the phone; the Restart card and phone updates open Reach in its own window titled Reach (Windows Terminal, else a console); `update` stops Reach before npm. Only where the process list can't be read (no C# compiler, a policy that blocks Reach's helpers): the Reach this folder runs, from its own status file, said as such (the Oct 10 behaviour) | U, P | `stop`, `instances`, `windows-commands`, `agent-restart`, `windows-lifecycle`, `windows-processes` | changed Oct 13 (one Reach per computer on both, owner, Oct 12): passes with the process list written out, and the Windows shim for the fallback; passed on GitHub's Windows runner Oct 14 (run 38583519240): the real helper, a second Reach refused, an agent's restart asking, stop and Reach's own window titled Reach; Oct 14 on the runner too ([38585690739](https://github.com/nalebc/reach/actions/runs/38585690739)): a Reach that doesn't stop by itself is ended outright once Windows' own process list still names it, and Windows ends its private route with it; Ctrl+C in a real console stops Reach for good, its lock and status gone ([38587350195](https://github.com/nalebc/reach/actions/runs/38587350195)); a real PC: M8 |
| H21 | Windows: background mode (`.\reach.cmd install`, `setup background`, `uninstall`) | A Scheduled Task of yours at sign-in, in your session (InteractiveToken, never batch or S4U: Tailscale's route check and the desktop need your session), least privilege, no time limit, on battery; it runs a windowless starter that runs the launcher with `--service` on Reach's own Node, logs to `.reach\logs`, starts it again 5 s after it ends unexpectedly. `stop` holds it first; `restart` runs it again; `uninstall` removes it and the old `npm run install-service` Startup entry | U, P | `windows-background`, `setup`, `stop` | built Oct 13: passes with schtasks written out; passed on GitHub's Windows runner Oct 14 (run 38583519240, as an administrator): a real task installed, run once against a stand-in Reach (no window, its output in the logs) and removed, and a restart through it brings its Reach back while a window that Reach opened lives on; a standard account and a real sign-in: M8 |

## T. Tailscale on the computer

| ID | Case | Expected | Type | Test | Status |
| --- | --- | --- | --- | --- | --- |
| T1 | Tailscale not installed | Menu, the download page opened, **and the URL printed** (headless Linux) | U, M | `tailscale-connect`, `setup-blockers`, M7 | fixed, passed Oct 10; on Ubuntu (M7) too |
| T2 | Installed, not running | Mac app: opens it. Linux: `sudo systemctl enable --now tailscaled` | U, M | `tailscale-connect`, M7 | fixed, passed Oct 10; on Ubuntu (M7) the words passed, the command itself wasn't run (no systemd in the test container; apt starts Tailscale itself) |
| T3 | Signed out | Runs `tailscale login`, prints and opens the URL | U | `tailscale-connect` | passed Oct 10 |
| T4 | Waiting for admin approval | Opens the machines page | U | `tailscale-connect` | passed Oct 10 |
| T5 | Switched off | Offers `tailscale up`. The fallback wording fits the OS (no "menu bar icon" on Linux). Linux, refused: the operator command, then Reach tries again and goes on | U, M | `tailscale-connect`, `setup-blockers`, M7 | failed on Ubuntu (M7: never tried again), fixed, passed Oct 10 |
| T6 | Linux user without operator permission | Signed out: `sudo tailscale up --operator=$USER` (Tailscale refuses a signed-out computer to everyone but root, its operator too). Switched off, or already on: `sudo tailscale set --operator=$USER`. Reach goes on once it's done | U, M | `tailscale-connect`, M7 | failed on Ubuntu (M7), fixed, passed Oct 10 |
| T7 | Tagged device, or not a personal account | Retry or set up later | U | `tailscale-auth` | passed Oct 10 |
| T8 | Tailscale too old for socket targets | "Update Tailscale…" | U | `tailscale-auth` | passed Oct 10 |
| T9 | Mac App Store Tailscale with a long account name | Names up to 20 characters fit the shorter socket path; longer paths are caught during setup with the standalone-app fix | U | `setup-blockers` | passed Oct 11 |
| T10 | MagicDNS or HTTPS certificates off | Opens the DNS page and waits | U, M | `setup`, M7 | passed Oct 10; on Ubuntu (M7) HTTPS off passed, MagicDNS off not reproduced |
| T11 | Port 8443 used by another service, by Funnel, or by an older Reach's route | Names `--https-port`, `tailscale funnel --https=8443 off`, or `tailscale serve --https=8443 off`, as appropriate | U | `launcher`, `setup-blockers` | passed Oct 11 |
| T12 | `--https-port 9443` | Saved, reused on the next start, and used by the invites rule | U | `setup-blockers` | fixed, passed Oct 10 |
| T13 | Port 443 used by another service | Reach runs; phones need the Tailscale app; the terminal says so | U | `first-run-launch` | passed Oct 10 |
| T14 | Funnel not allowed by the tailnet policy | Prints and opens Tailscale's page | U | `first-run-launch` | fixed, passed Oct 10 |
| T15 | Tailscale CLI and daemon versions differ | Warning | U | `first-run-launch` | passed Oct 10 |
| T16 | A full Tailscale-mode start (fake Tailscale) | Prints "Open on your phone" with the one address and "Approve new devices here" | P | `first-run-launch` | passed Oct 10 |
| T17 | Windows: Tailscale not installed | Menu, then the Windows download page opened and its URL printed. Reach continues once it's installed, without a restart | U | `tailscale-connect` | fixed, passed Oct 10 |
| T18 | Windows: installed, not running | Opens the Tailscale app (`tailscale-ipn.exe`) once, then names the service fix: `net start Tailscale` from a terminal opened as administrator. Without the app: the Start menu, and the same fix. No Mac or Linux words | U | `tailscale-connect` | fixed, passed Oct 10 |
| T19 | Windows: signed out | Runs `tailscale login`, prints and opens the URL | U | `tailscale-connect` | fixed, passed Oct 10 |
| T20 | Windows: switched off | Offers `tailscale up`. If that's refused: the taskbar icon, with the app opened so the icon is there | U | `tailscale-connect` | fixed, passed Oct 10 |
| T21 | Windows: the Tailscale CLI isn't on Reach's PATH (installed while Reach waited) | Found at `%ProgramFiles%\Tailscale\tailscale.exe`, looked up again on every check. Pages open with `explorer.exe`, not `start` (a cmd built-in that cuts links at `&`) | U | `tailscale-connect`, `windows-console` | fixed, passed Oct 10; on GitHub's Windows runner Oct 14 ([38587350195](https://github.com/nalebc/reach/actions/runs/38587350195)): Tailscale installed while setup waits is found at its next look, no restart; the download, sign-in and HTTPS pages open through `explorer.exe` (a stand-in first on the PATH records them), each once; Tailscale's app opens from Program Files |
| T22 | Windows: MagicDNS or HTTPS certificates off | Opens the DNS page and waits; the wait names `.\reach.cmd` | U | `setup`, `windows-console` | fixed, passed Oct 10; in a real Windows console Oct 14 ([38587350195](https://github.com/nalebc/reach/actions/runs/38587350195)): Tailscale's one-button HTTPS page for this computer opens, and the wait names `.\reach.cmd` |
| T23 | Windows: how phones are approved | By your Tailscale account, as on a Mac, through a keyed route only Tailscale's own service may use (docs/parity/D-public-door.md), found by detection with no switch (owner, Oct 13: "No flag should exist"). A PC that can't hold it uses the pairing code and says why in its terminal, `status`, `approve`, `link` and the phone: Tailscale older than 1.104 or without its network adapter, Reach's folders not private, or Tailscale's own connections not recognised (then Reach starts again on pairing codes at once, and tries the route again a day later or after Tailscale changes). A PC paired by code before is asked for its account once, at its next start | U, P | `windows-sign-in`, `windows-sign-in-launch`, `setup`, `windows-commands` (no account settings), `windows-console` | changed Oct 13; unit and stand-in Tailscale tests pass on a Mac, and on GitHub's Windows runner Oct 14 with its stand-in tailscale.exe ([38583408141](https://github.com/nalebc/reach/actions/runs/38583408141), [38585690739](https://github.com/nalebc/reach/actions/runs/38585690739)): the keyed route, browser sign-in and Funnel held as foreground sessions that Windows ends with Reach (kill-on-close job), each reason for pairing codes, a lost route coming back; in a real console, pairing codes with the reason ([38587350195](https://github.com/nalebc/reach/actions/runs/38587350195)); real Tailscale and a real PC: M8 |
| T24 | Windows, no terminal | Says what's missing, opens nothing | U | `tailscale-connect` | passed Oct 10 |
| T25 | Windows: `.\reach.cmd link` | As on a Mac: lists and links your other Reach computers; a Mac and a PC, or two PCs, share approvals. Refused with why only while the PC is on pairing codes (T23), before reading anything | U | `fleet` | changed Oct 13; passes with Windows' keyed route in this process |
| T26 | Windows: invite links for people and agents without Tailscale | As on a Mac, once Reach's folders are made private (`.\reach.cmd invites` refuses with the folder named otherwise, before saving anything). While the PC is on pairing codes (T23), the phone's Invite sheet says why in one line instead of a setup that can't work, and opens Tailscale sharing; the server says the same wherever it's asked | S, D, U | `guest-keys`, `invite-ui`, `invites-cli`, `windows-sign-in` | changed Oct 13 |

## I. Invite links setup (optional step 3)

| ID | Case | Expected | Type | Test | Status |
| --- | --- | --- | --- | --- | --- |
| I1 | "Later" | Step skipped | U | `setup` | passed Oct 10 |
| I2 | A token without `tskey-api-`, or a 401/403 | A clear message | U | `guest-keys-token` | passed Oct 10 |
| I3 | A new tailnet's default policy (`*` → `*`) | Offers to narrow the default rule and confirms first, as the phone does | U | `invites-cli` | fixed, passed Oct 10 |
| I4 | Cancel at "Add these?" | Skips the invites step only; setup continues | U | `invites-cli`, `setup-blockers` | fixed, passed Oct 10 |
| I5 | A policy that is already narrow | Rules added | U | `invites-cli` | passed Oct 10 |

## B. Background mode (Mac)

| ID | Case | Expected | Type | Test | Status |
| --- | --- | --- | --- | --- | --- |
| B1 | Installed from a normal folder | Service up, link printed, phone approved | U | `setup`, `service` | passed Oct 10 |
| B2 | Installed from a protected folder (`~/Documents`…) | Explains that macOS blocks background apps there, and offers the Terminal window or moving Reach | U | `setup-blockers` | fixed, passed Oct 10 |
| B3 | The service keeps failing | Stops waiting and shows the error log's last line | U | `setup-blockers` | fixed, passed Oct 10 |
| B4 | Already installed, or installed from another folder | Refused with the original folder when known and the plist path; nothing is stopped | U | `service` | passed Oct 11 |

## W. Pairing window

| ID | Case | Expected | Type | Test | Status |
| --- | --- | --- | --- | --- | --- |
| W1 | Interactive start | Opens a 15-minute window; the link and QR are the one address | S, P | `pairing-window`, `phone-link`, `first-run-launch` | fixed, passed Oct 10 |
| W2 | A phone is approved | The window closes; the internet gets "Not found." again | S | `pairing-window` | passed Oct 10 |
| W3 | 15 minutes pass | The window closes | S | `pairing-window` | passed Oct 10 |
| W4 | `./reach pair` | Reopens the window on this computer and prints its own address, even when the fleet home is elsewhere | S | `pairing-window` | passed Oct 11 (two real linked computers remain a manual check) |
| W5 | Background service or no TTY | Never opens a window by itself | P | `first-run-launch`, `phone-link` | passed Oct 10 |
| W6 | Port 443 isn't Reach's | Prints the private 8443 link and says the phone needs the Tailscale app | U | `first-run-launch`, `phone-link` | passed Oct 10 |
| W7 | Public name not published yet | A warning next to the link | U | `public-dns`, `first-run-launch` | passed Oct 10 |
| W9 | A Terminal window Reach opened by itself (a restart from the phone, at sign-in) | No window opens; it says `./reach pair` does | P | `first-run-launch` | passed Oct 10 |
| W10 | Linked computers (the QR is the first computer's link) | Browser sign-in names this computer's own link, where the window is | U | `phone-link` | passed Oct 10 |
| W8 | During a window | Only the start page, Face ID sign-in and the agent gateway answer the internet. Owner APIs and WebSockets don't | S | `pairing-window` | passed Oct 10 |

## P. The phone's first connection

| ID | Case | Expected | Type | Test | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | Tailscale app on, same account | Reach directly, then Connect, a code, approve | D, M | `faceid-ui`, M1 | passed (D) + manual M1 |
| P2 | Tailscale app on, another account | "Connect Tailscale using the account configured on this computer." | S | `tailscale-auth` | passed Oct 10 |
| P3 | Reach in the background | `./reach approve` | U | `tailscale-auth` | passed Oct 10 |
| P4 | No app, during a window | Start page, then Tailscale sign-in in the browser, then approve | D, M | `start-screens-ui`, M2 | passed (D) + manual M2 |
| P5 | No app, outside a window | "Not found." Nothing can be shown publicly; the terminal and README explain `./reach pair` | S, M | `tailscale-auth`, M3 | passed (S) + manual M3 |
| P6 | Each start-page screen | Sign in, Step 1 of 2, Joining, Waiting for approval, Offline, Wrong account, Couldn't start, Connection stopped, Get Tailscale, Agent link, Not available | D | `start-screens-ui` | passed Oct 10 |
| P7 | Each Connect screen | Ready, pending code, declined, expired, interrupted, "Connect your phone first", pairing code | D | `connect-states-ui`, `faceid-ui` | passed Oct 10 |
| P8 | Face ID for a new browser | Admitted with a passkey | S, D | `face-join`, `face-sign-in-ui`, `passkeys*` | passed Oct 10 |
| P9 | Storage blocked or private browsing | No crash screen | D | `start-screens-ui` | fixed, passed Oct 10 |
| P10 | `--local` or a Windows host | Pairing code | P | `launcher` | passed Oct 10 |
| P11 | A second browser on a phone with the app | Approved as the same device | S | `same-device` | passed Oct 10 |
| P13 | The first phone you approve | Sees the screen at once (viewing on); a choice you made in Settings stays; no guest, agent or later device turns it on. Control is one tap in Screen | S | `pairing-window`, `screen`, `integration` | passed Oct 10 |
| P12 | Android Chrome, iPhone Chrome, desktop browsers | Same flows | M | M4, M5 | manual |

## S. Add to Home Screen

| ID | Case | Expected | Type | Test | Status |
| --- | --- | --- | --- | --- | --- |
| S1 | iPhone (Safari or Chrome), app connection, in a tab, owner | A slim prompt; Add shows the two Share steps | D, V | `phone-prompts-ui` | passed Oct 10 |
| S2 | Android Chrome | The browser's own install prompt, kept from page load, including on the start page | D | `phone-prompts-ui` | passed Oct 10 |
| S3 | Opened from the Home Screen (standalone) | Never shown; remembered as added | D | `phone-prompts-ui` | passed Oct 10 |
| S4 | Desktop browser, iOS app build, a guest or an agent | Never shown | D | `phone-prompts-ui` | passed Oct 10 |
| S5 | Browser connection (no app) | Not shown; the Tailscale nudge instead | D | `phone-prompts-ui` | passed Oct 10 |
| S6 | "Not now" | Again after 7 days, at most 3 times. Blocked storage: once per visit | U | `phone-prompts-ui` | passed Oct 10 |
| S7 | Live screen, typing, or an open sheet | Not shown | D | `phone-prompts-ui` | passed (Home only) |
| S8 | The Home Screen copy opens | Approved as the same device without a code | S | `same-device` | passed Oct 10 |
| S9 | Manifest and meta tags | `start_url`, `scope`, `display`, icons, `apple-mobile-web-app-title` | U | `phone-prompts-ui` | fixed, passed Oct 10 |
| S10 | The notification panel's Home Screen row | Still works | D | `notify-settings-ui` | passed Oct 10 |

## N. Get the Tailscale app

| ID | Case | Expected | Type | Test | Status |
| --- | --- | --- | --- | --- | --- |
| N1 | Browser connection, first time in | "Get the Tailscale app to open Reach any time · faster too" | D | `phone-prompts-ui` | passed Oct 10 |
| N2 | Get | App Store on iPhone, Play on Android, the download page elsewhere | U, D | `tailnet-transport`, `phone-prompts-ui` | passed Oct 10 |
| N3 | "Not now" | Again on a visit at least a day later. After 3, only the small "faster with the app" link, which is tappable | U, D | `phone-prompts-ui`, `first-run-chat-ui` | passed Oct 10 |
| N4 | The app comes on | The nudge goes; "Switch to the faster connection" takes over | D | `one-address-ui`, `phone-prompts-ui` | passed Oct 10 |
| N5 | App connection | Never shown | D | `phone-prompts-ui` | passed Oct 10 |
| N6 | More and Settings | Show the same connection as Home: the Tailscale app, or in this browser with Get the app | D | `phone-prompts-ui` | fixed, passed Oct 10 |
| N7 | Only one prompt at a time | Home Screen only on the app connection; Tailscale only in the browser | D | `phone-prompts-ui` | passed Oct 10 |

## A. Agents on a clean computer

| ID | Case | Expected | Type | Test | Status |
| --- | --- | --- | --- | --- | --- |
| A1 | Nothing installed (no Claude Code, Claude app, Codex, Gemini, OpenClaw, Homebrew) | Health lists each as not installed, with no errors. The chat list has no errors. Reach stays up while polled | S, P | `first-run-agents`, `first-run-launch` | fixed, passed Oct 10 |
| A2 | Chat tab, nothing installed | "Add an agent": Claude Code, Codex and OpenClaw with Install, Gemini with a link. No red alert. No Start button before the check finishes | D | `first-run-chat-ui` | fixed, passed Oct 10 |
| A3 | Install, then Check again | The maker's command shown first, run in a Reach terminal, then found | S, D | `agent-install`, `agent-install-ui` | passed Oct 10 |
| A4 | Claude Code installed, signed out | Sign in | D | `claude-signed-in-check`, `agent-session-ui` | passed Oct 10 |
| A5 | Claude app without the Claude Code CLI | "Claude Code isn't installed", not "signed out". Sending is blocked unless the Claude app owns the chat | S, D | `first-run-agents`, `agent-session-ui` | fixed, passed Oct 10 |
| A6 | Codex installed, signed out | Sign in | D | `agent-session-ui` | passed Oct 10 |
| A7 | OpenClaw installed, never set up | "OpenClaw is installed but not set up yet", with setup | S | `first-run-agents` | fixed, passed Oct 10 |
| A8 | OpenClaw set up, Gateway stopped | Start OpenClaw | S | `openclaw` | passed Oct 10 |
| A9 | Gemini only | Read-only tab | S, D | `agent-gemini`, `gemini-chat-ui` | passed Oct 10 |
| A10 | Home, nothing running | The empty text names only what's installed | D | `first-run-chat-ui` | fixed, passed Oct 10 |
| A11 | No npm or Homebrew | "Install Codex needs npm or Homebrew on this Mac." | U | `agent-install` | passed Oct 10 |
| A12 | **Contract:** real server answers into the real Chat components | Same as A2, from `createReach` output rather than hand-written fixtures | S + D | `first-run-chat-ui` | passed Oct 10 |

## D. Desktop features without their prerequisites

| ID | Case | Expected | Type | Test | Status |
| --- | --- | --- | --- | --- | --- |
| D1 | No Apple Command Line Tools | The screen says to install them. Saved tools say why instead of vanishing. Mac prompts retry later. No internal helper names | S, D | `first-run-agents` | fixed, passed Oct 10 |
| D2 | No Screen Recording or Accessibility | Each permission named | S, D | `outside-terminal`, `agent-preset-invitations`, `screen-ask-ui` | passed Oct 10 |
| D3 | Linux host | No Screen tab | U, M | `capabilities`, M7 | fixed (its assertion), passed Oct 10; on Ubuntu (M7) the API says no screen too |
| D4 | Windows without FFmpeg | Compatibility video; FFmpeg installed later is found within minutes, no restart | U | `setup-blockers` | fixed, passed Oct 10 |

## M. Manual checks (real devices)

Record the commit, host OS, Tailscale version, phone and browser, and the result. Use a test folder; don't record codes, QR contents or private files.

| ID | Steps | Result |
| --- | --- | --- |
| M1 | iPhone **with** the Tailscale app:<br>1. `./reach`, scan the QR.<br>2. Connect and approve.<br>3. Home Screen prompt → Add.<br>4. Open the icon. It should be signed in without a code. | not tested |
| M2 | iPhone **without** the app:<br>1. `./reach`, scan the QR within 15 minutes.<br>2. Sign in to Tailscale in Safari, then approve.<br>3. The Tailscale nudge → install the app → "Switch to the faster connection".<br>4. Home Screen prompt. | not tested |
| M3 | iPhone without the app, after the window:<br>1. The link shows "Not found."<br>2. Run `./reach pair`.<br>3. The link works again for 15 minutes. | not tested |
| M4 | Android Chrome with and without the app, including the browser's own install prompt | not tested |
| M5 | Desktop browser on the tailnet: no Home Screen prompt, and no nudge on the app connection | not tested |
| M6 | A fresh macOS user account with nothing installed, Tailscale included:<br>1. `./reach` from `~/reach`. The Tailscale question comes within seconds, while the install runs (H14).<br>2. Ctrl+C at a menu, then `./reach` again (H17).<br>3. `./reach` from `~/Documents/reach`.<br>4. Background mode from each.<br>Record the times `setup.log` gives. | not tested |
| M7 | Ubuntu host, first run:<br>1. `./reach` without build tools, then with them (H13).<br>2. Tailscale missing, installed, not running, signed out, switched off, on without the operator (T1, T2, T5, T6).<br>3. MagicDNS or HTTPS off (T10).<br>4. A full start: the QR shows the one address and a pairing window opens.<br>5. A phone with the Tailscale app, then one without.<br>6. Files and terminals; no Screen. | partial, Oct 10 (Ubuntu 24.04 in a container; see Results). Steps 1–3 and 6 passed after fixes. Steps 4–5 not tested: they need a real tailnet and a phone |
| M8 | A fresh Windows 11 user without Tailscale:<br>1. `.\reach.cmd` in PowerShell. The arrow-key menus work.<br>2. The Windows download page opens. After installing, Reach continues without a restart.<br>3. The sign-in page opens. If HTTPS is off, the DNS page opens.<br>4. Reach asks which Tailscale account to use. Its QR shows the one address: a phone without the Tailscale app signs in from its browser, and is approved by its code here. (With Tailscale older than 1.104: the pairing code, with why; a phone with the app pairs with it.)<br>5. In a second PowerShell: `.\reach.cmd status`, then `.\reach.cmd stop`. Reach stops itself, its terminals too.<br>6. `.\reach.cmd` again from another folder while one runs: refused, naming the first. `.\reach.cmd setup background`, sign out and back in: Reach runs with no window, the phone connects, `powercfg /requests` lists its stay-awake helper, and `.\reach.cmd stop` stops it until the next sign-in. | not tested on a physical PC. On GitHub's Windows runner (Oct 14, [38587350195](https://github.com/nalebc/reach/actions/runs/38587350195)), with stand-ins for Tailscale and the browser: steps 1 to 3 in a real console (`.\reach.cmd` through ConPTY), and step 4 as far as the pairing code with its reason and the QR; Ctrl+C after it stops Reach for good (then cmd asks "Terminate batch job (Y/N)?", as for any .cmd). Step 5's stop and step 6 run there in `windows-commands` and `windows-lifecycle` |

## Results

### October 10, 2026: what was found, and how

**Found by a test written first, run, and seen to fail.** Then fixed, and the same test passed:

| Row | Found | Fixed in |
| --- | --- | --- |
| A1, A12 | On a clean computer the chat list carried "Codex is not installed on this Mac." as an error, shown in red under the setup card. Hand-written fixtures (`errors: {}`) had hidden it; the contract test feeds the real adapter's answer to the real Chat screen | `server/agent-sessions/index.mjs` (not installed is not an error, as health already said) |
| A2 | No way to add an agent when none is installed; a Start button was offered before the computer had said what it has | `src/EverythingChat.tsx` (Add an agent: Claude Code, Codex, OpenClaw with their makers' installers, Gemini's page) |
| A5 | Without the Claude Code CLI (only the Claude app), replying said "Claude Code is signed out" | `server/agent-sessions/index.mjs`, `src/AgentSession.tsx` |
| A7 | OpenClaw installed but never set up showed "OpenClaw was not found" in red above its own setup | `server/openclaw.mjs`, `src/OpenClawSpace.tsx` |
| D1 | Without Command Line Tools, saved-tools setup answered 503 naming an internal helper, and the section vanished; Mac prompts gave up until Reach restarted | `server/tool-setup.mjs`, `src/ToolBrowserSetup.tsx`, `server/desktop-native.mjs`, `server/app-threads.mjs`, `server/mac-prompts.mjs` |
| P9 | A browser refusing site storage (Safari "Block All Cookies") crashed the whole app into "This screen couldn't open" | `src/storage-fallback.ts` (memory for that visit; Connect says it won't be remembered) |
| S9 | No iPhone Home Screen title tag; no manifest description | `index.html`, `start.html`, `public/manifest.webmanifest` |
| T14 | Funnel not allowed: the terminal printed `Command failed: /var/folders/…/tailscale funnel …` and never opened Tailscale's page | `scripts/persistent-serve.mjs` (Tailscale's own words), `scripts/launch.mjs` |

**Found while mapping the code (three read-only passes over setup, the phone flow and agent discovery), with the test written alongside the fix.** No failing run came first; the test now guards it:

| Row | Found | Fixed in |
| --- | --- | --- |
| W1 | A phone without the Tailscale app couldn't join on first run at all: the terminal printed only `:8443`, and the start page was closed | `server/core.mjs` (pairing window), `scripts/launch.mjs`, `scripts/pairing.mjs`, `scripts/setup.mjs` |
| B2 | Background mode from `~/Documents` (where this repository lives) never starts | `scripts/background-service.mjs`, `scripts/setup.mjs`, `scripts/login-start.mjs` (Terminal at sign-in instead) |
| B3 | A background Reach that kept failing left setup waiting five minutes in silence | `scripts/setup.mjs` |
| T9 | App Store Tailscale with an account name over 14 characters failed only after "Setup complete" | `server/tailscale-auth.mjs` (fits up to 20 now), `scripts/setup.mjs` (said during setup) |
| T11 | An earlier Reach's leftover 8443 route got "already in use" with no fix | `scripts/tailscale.mjs` |
| T12 | `--https-port` had to be repeated every start, and the invite rule kept 8443 | `scripts/configure.mjs`, `scripts/bootstrap.mjs` |
| I3, I4 | The terminal invites step always failed on a new tailnet's default policy; Cancel paused the whole setup | `scripts/invites.mjs`, `scripts/setup.mjs` |
| T1, T2, T5, T6 | No printed download link (headless Linux); Mac wording ("menu bar icon") on Linux and Windows; nothing for Linux's operator permission | `scripts/tailscale-connect.mjs` |
| H5, H13 | npm failing (no compiler on Linux, no internet) said only "Setup failed. See setup.log" | `scripts/setup-failure.mjs`, `scripts/bootstrap.mjs` |
| A10 | Home said "Start Codex, Claude Code or a terminal" on a computer with neither | `src/HomeLive.tsx` |
| N6 | More and Settings said "Tailscale" whether the phone used the app or the browser | `src/connection.ts`, `src/MoreSheet.tsx`, `src/App.tsx` |
| D3 | The test meant to keep Chat out of navigation checked a page id ("chat") that doesn't exist, so it passed whatever happened | `test/capabilities.test.mjs` |

D3 was a test that checked a page id that doesn't exist, so it could never fail; it now checks the real one.

**Second round (October 10, "verify remaining"):**

| Row | Found | Fixed in |
| --- | --- | --- |
| Release | A failing test (package contents, ENOBUFS) led here: every build kept all earlier builds' chunks forever (`emptyOutDir: false`, for phones on the previous interface), so a checkout's `dist/` reached 9,854 files and 430 MB, and a package published from it would have been 242 MB against a 30 MB budget. Earlier builds' files now go after a day; a release build keeps only its own | `scripts/prune-assets.mjs`, `vite.config.mjs` (build manifest), `package.json`, `server/live-interface.mjs` |
| H3, H4 | The shell launcher showed curl's raw error without internet or curl, and told Git Bash on Windows that Windows wasn't supported. The new test then caught a bug in the fix: `sh`'s `echo` turned `.\reach.cmd` into a carriage return | `reach` |
| D4 | FFmpeg installed on Windows after Reach started was never noticed until a restart | `server/windows-video.mjs` |
| — | A full run caught Reach still up 4 s after SIGTERM: an interface rebuild (another session had just saved a file) kept running, and stopping waited on it until the launcher's last-resort exit five seconds later | `server/live-interface.mjs` (stopped with Reach, quietly) |
| — | `claude-ui-coordination` still tested the Claude app effort picker another session had deliberately removed (Reach no longer clicks the app's menu) | `test/claude-ui-coordination.test.mjs` |

H10 is tested now too: the launcher's Ctrl+C handler (`scripts/pause-setup.mjs`) gets a real SIGINT, the signal a terminal sends, in a process waiting as setup does: "Paused", exit 130, the lock released.

The new tests also caught two races in the test harness itself (the stand-in Tailscale's state file written by two processes at once; cleanup while Reach's Funnel janitor was still switching the route off), now fixed, and a bug in the prune's first version (a file's compressed copies left behind).

Caught along the way by the existing suite: the first version of "nothing installed" treated "couldn't check" as "missing" (`agent-session-ui`, fixed). Caught by the new tests in new code: the prompts' storage fallback kept stale state while storage worked (`phone-prompts-ui`, fixed).

New since the plan, at the owner's request: the first phone you approve sees the screen at once (P13).

### Full suite, October 10, 2026 (macOS, Node 24)

`npm test`: 3,134 tests, 3,098 passed, 33 skipped, 3 failed, none of them from this work:

- `installable` (package contents): ENOBUFS, described under Known limits.
- `claude-ui-coordination` ("effort waits for desktop control"): another session's unfinished edit to `server/agent-sessions/claude-compose.mjs` removed the method it calls.
- `openclaw-watch` ("a frequent schedule's successes collapse"): passes on its own (three runs out of three); its files are another session's unfinished edit; timing under full-suite load.

An earlier full run had also failed four tests that assumed the screen starts off for the first phone (`screen-stream`, `browser-access`). They now start from an owner who switched it off.

A third full run (after the second round) met another session's unfinished change to the public Funnel door (`keyed`, in `server/core.mjs`, `server/index.mjs` and `server/funnel-agent.mjs`, edited during the run), which fails its own Funnel tests until it's finished. Every test file this work added or changed was then run together: 505 tests, 505 passed.

### October 10, 2026: Windows first run

Before this pass, `.\reach.cmd` on Windows skipped the guided setup and the Tailscale walk-through. A missing or signed-out Tailscale ended Reach with one line: "Tailscale is unavailable" or "Open Tailscale and sign in".

**Found by a test written first, run, and seen to fail.** The tests ran against the code before this pass, with only the new exports stubbed so the files could load. 8 of the 9 new tests failed there. The tests for T25, T26 and H20, added after, failed against the code before them too (1, 3 and 5). T24 passed: it guards what already worked. Then fixed, and all of them passed:

| Row | Found | Fixed in |
| --- | --- | --- |
| H18, T22 | No guided setup on Windows. HTTPS certificates off failed only at Serve, with a link that never opened | `scripts/bootstrap.mjs`, `scripts/setup.mjs` (Windows steps), `scripts/configure.mjs` (`accountApproval`) |
| T17, T21 | No Windows download page. A Tailscale installed while Reach waited stayed invisible: the installer's PATH never reaches a running Reach | `scripts/tailscale.mjs` (Program Files), `scripts/tailscale-connect.mjs` |
| T18, T20 | Windows was told to "Open Tailscale on this computer", and Tailscale's app was never opened | `scripts/tailscale-connect.mjs` |
| T19 | Pages never opened on Windows (`open` and `xdg-open` only) | `scripts/tailscale-connect.mjs` (`pageOpener`), `scripts/setup.mjs`, `scripts/launch.mjs` |
| H19 | `./reach` printed on Windows by setup's wait, `pair`, `approve`, `configure`, `link`, `update` and the service banner, and shown on phones by device approval and invite keys | those files, `server/index.mjs` and `server/guest-keys.mjs`, through `command` |
| T25 | `.\reach.cmd link` on Windows said "Start Reach on this computer first", which could never work there | `scripts/link.mjs` |
| T26 | On a Windows computer the phone offered "Set up invite links", which then failed with "Invite links need Tailscale device approval here." Making a key said "run invites", and `invites` said "Run Reach once first": neither could work | `server/index.mjs`, `src/InviteSheet.tsx`, `src/invite-sheet.css`, `scripts/invites.mjs` |
| H20 | On Windows, `status` said "currently support macOS", and `stop` and `restart` looked for Reach with `/bin/ps`, which Windows doesn't have | `scripts/instances.mjs`, `scripts/stop.mjs`, `scripts/launch.mjs` (the watcher, `startedAt`), `scripts/bootstrap.mjs` |

The real console still needs M8: the menus in PowerShell, `explorer.exe` opening the page, and the Tailscale app's file name (`tailscale-ipn.exe`).

### October 10, 2026: Ubuntu first run (M7, partial)

**Where it ran.** Ubuntu 24.04.5 LTS (arm64) in a Docker container on this Mac, not a VM: no systemd, no desktop (nothing to open a page with), 4 GB of memory. Reach was a copy of the shared checkout as of 11:25, with this pass's fixes copied in. The computer had Ubuntu's own tools only (curl, python3, git), and no compiler at first. Tailscale 1.104.1 came from Tailscale's apt repository, with `tailscaled` started as root by hand, as systemd would. Reach ran as a normal user in a real terminal (tmux). For the signed-in states, the computer joined a throwaway headscale control server on the same Docker network, not the owner's tailnet. Nothing signed in to Tailscale's own service.

**Found on the real host, then fixed.** The unit tests had passed: their fake Tailscale came on by itself after a refusal. The new tests (`tailscale-connect`, "Linux, …") answer as Tailscale did on Ubuntu, and failed against the code before the fix:

| Row | Found | Fixed in |
| --- | --- | --- |
| T6 | Signed out, Tailscale refuses every user but root, its operator too, and forgets the operator until a sign-in is saved. `sudo tailscale set --operator=$USER`, which Reach printed, could never help. `sudo tailscale up --operator=$USER` signs in and keeps the user as operator | `scripts/tailscale-connect.mjs` |
| T5 | Switched off and `tailscale up` refused: after the operator command, Reach said it would go on but never asked again, and waited out its 15 minutes | `scripts/tailscale-connect.mjs` (tries `up` again on each look) |
| T6 | Already on through Tailscale's own Linux steps (`sudo tailscale up`), without the operator: Reach said nothing and went on to Serve, which Tailscale refuses | `scripts/tailscale-connect.mjs` (reads the operator from `tailscale debug prefs`, which leaves it out while unset) |

Each fix was then run on the host: Reach printed the command, it was run in another terminal, and setup went on within seconds.

**Passed on the real host:**

- H13: real `npm ci` failed on node-pty ("not found: make"), and Reach named `build-essential`. With it installed, setup went on.
- H3: no curl gives the new message. Stock Ubuntu 24.04 Desktop ships wget but not curl (its published package list), so a desktop install meets this message on its first run.
- H6: no Go: "phones need the Tailscale app", on every start.
- T1: the download link printed, with nothing to open it.
- T2: the `systemctl` line. The command itself wasn't run (no systemd).
- T10: HTTPS certificates off (headscale has none): the DNS page named, then a wait. MagicDNS off wasn't reproduced: headscale kept sending it on.
- H10: Ctrl+C during the wait: "Paused. Run ./reach to continue your setup.", the lock released.
- D3, files and terminals, with `./reach --local` (pairing code, no Tailscale). The device says `screenSupported: false`, and `/api/screen/displays` answers 501 "Remote desktop currently supports macOS and Windows." Files listed, a folder made, a file uploaded, read and edited. A terminal (node-pty, built from source) ran a command and answered.

**Not tested (needs the owner).** A full Tailscale-mode start (the QR with the one address, the pairing window, Funnel), and phones with and without the Tailscale app: they need a real tailnet and a phone. Without the app also needs Go; any Go 1.21 or newer fetches the version `tailnet/go.mod` names. Also left: the `systemctl` command and MagicDNS off on a real host, and x86-64.

**Seen, not fixed (small).** On Linux, setup's HTTPS step says "(opening it)" but opens nothing. "Opening the Tailscale sign-in page in your browser…" prints just before a refusal. Without Go, "preparing browser sign-in … about 2 minutes" prints on every start.

### October 11, 2026: empty setup through phone approval and a shared file

The new `first-install-e2e` suite starts the actual `bin/reach.mjs` CLI with an empty temporary home: no saved preferences, no onboarding record, no paired devices, and no optional agents or developer tools. It uses an npm-shaped package without `src/`; its built assets and dependencies come from the checkout. The separate `npm run verify:package` check installs the actual tarball with production dependencies in another temporary directory.

Reach's bootstrap, numbered menus, saved settings, Unix-socket ingress, account checks, pairing windows, approval code and file APIs run for real. A stand-in Tailscale executable supplies installation/sign-in states, identities and Serve/Funnel routes. OS page opening and process inventory are simulated, so these tests cannot stop the owner's Reach or change their Tailscale setup.

Each cell below passed on October 11. A desktop prerequisite is completed before any phone can connect. **App** means the phone reaches Reach directly on the tailnet. **Browser** means public start-page access, followed by a simulated browser node joining the owner's account. Both require local approval before reading the shared test file. **Refused** means another account cannot request approval or read files.

| Desktop starts with | Phone app connected to owner | No phone app | Phone app off | Phone signed out | Phone app on another tailnet | Phone uses another account for Reach |
| --- | --- | --- | --- | --- | --- | --- |
| No Tailscale installed | App passed | Browser passed | Browser passed | Browser passed | Browser passed | Refused |
| Installed, signed out | App passed | Browser passed | Browser passed | Browser passed | Browser passed | Refused |
| Installed, switched off | App passed | Browser passed | Browser passed | Browser passed | Browser passed | Refused |
| Installed, daemon closed | App passed | Browser passed | Browser passed | Browser passed | Browser passed | Refused |
| Waiting for admin approval | App passed | Browser passed | Browser passed | Browser passed | Browser passed | Refused |
| Already connected | App passed | Browser passed | Browser passed | Browser passed | Browser passed | Refused |

Those 36 combinations also check that approval closes the public pairing window, `reach pair` reopens it for the next phone, public requests cannot read files, and a device's credential cannot be reused by another Tailscale node.

`first-install-phone-ui` connects the real `start.ts`, `main.tsx`, `ConnectForm` and browser transport to that same real server. It runs eight paths with both iPhone and Android user agents: connected app; no app; app off; app signed out; app on another tailnet; wrong browser account corrected; browser waiting for admin approval; and WebAssembly blocked with an app fallback. Every successful path proceeds from the displayed approval code to authenticated file bytes. Only the post-approval workspace is replaced. These are DOM integration tests, not Safari/Chrome or physical-device tests.

Additional first-install checks cover enabling MagicDNS and HTTPS in sequence, no terminal in six Tailscale states, Funnel refused with a working private app connection, interrupted setup, a changed desktop account, and discovering a per-user Mac app without PATH or an executable override.

The entire 71-check desktop/phone suite also passed against a clean npm install of the 26.6 MB release tarball using `REACH_TEST_PACKAGE`, rather than the checkout's dependencies. This includes starting with Tailscale missing, both DNS switches off and Funnel refused, then enabling each dependency in turn and connecting a phone without installing the phone app.

The opt-in `first-install-source` check also passed on this Mac with `REACH_TEST_SOURCE_INSTALL=1 npm run test:file -- test/first-install-source.test.mjs`. It ran the actual `./reach` shell launcher with Node, npm, Go and Tailscale absent from PATH, in a temporary source checkout without dependencies or built assets. It downloaded and checksum-verified the pinned Node 22.23.3 runtime, ran real `npm ci`, built the interface, completed setup, approved a simulated Tailscale phone, and read the shared test file. Without Go the source build correctly reports that the phone needs the Tailscale app; the npm package ships the browser client and does not require Go. This test requires network access and installs nothing globally.

Four defects were reproduced with failing tests, then fixed:

| Defect | Result after the fix | Files |
| --- | --- | --- |
| Setup resumed at HTTPS after Tailscale signed out kept asking to enable certificates | Recovers the Tailscale connection first, then checks DNS and HTTPS; completed setup steps are preserved | `scripts/setup.mjs` |
| Switching the desktop's Tailscale account left Reach offering a link configured for its old owner | Stops before launch, names both accounts, and points to `reach setup account`; never silently replaces the saved owner | `scripts/configure.mjs`, `scripts/launch.mjs` |
| A Mac app under `~/Applications`, or Homebrew installed after the terminal opened, was missed | Discovers both app locations and Homebrew prefixes, honors an existing PATH CLI after app discovery, and checks again while setup waits | `scripts/tailscale.mjs`, `scripts/tailscale-connect.mjs` |
| Enabling Funnel after startup left the old private link advertised and browser pairing closed | Updates the link and QR as soon as Funnel is ready, preserving the initial pairing window; an expired window or a window closed by approval stays closed, and unattended starts still require `reach pair` | `scripts/launch.mjs` |

**Still requires a live-device pass:** downloading/installing Tailscale through the OS installer, signing into Tailscale's hosted identity provider, real tailnet ACLs and Funnel provisioning, switching Wi-Fi/cellular/VPN on physical iPhone and Android devices, and a native Windows setup. The automated matrix proves Reach's behavior for the supplied states; it does not certify those external systems or replace M6–M8.

### October 11: isolated platforms, native iOS and contribution gates

The later pass installed and exercised actual release archives in disposable Ubuntu 24.04 ARM64 and x86-64 environments, including an unprivileged Linux user. These are containers inside Docker Desktop's Linux VM; x86-64 uses CPU emulation. They do not certify a native Windows desktop, systemd, real Tailscale accounts or physical phones. The installed onboarding matrix passed 70 checks with one Mac-only skip on each Linux architecture and all 71 checks on macOS. A Linux source installation also downloaded its checksum-verified Node runtime, installed dependencies and built Reach with Node/npm/Go absent from PATH. Tailscale identity and phone network states remain fixtures.

A separate [real Tailscale check](benchmarks/tailscale-logged-out-2026-10-11.json) installed checksum-verified vendor binaries in a disposable Linux container. Reach correctly distinguished missing installation, stopped daemon and logged-out daemon as both root and an ordinary user. Networking was disconnected before the daemon started. These four checks exercise production discovery/setup functions, without signing in or joining a tailnet; they do not cover a system package installer, systemd, real phone traffic or Serve/Funnel.

The exact source snapshots, full-suite attempts, targeted follow-ups, skips and archive receipts are recorded separately in [platform validation](benchmarks/platform-validation-2026-10-11.json). A focused pass does not replace a failed full-suite result. The [local release evidence](benchmarks/local-release-validation-2026-10-11.json) records macOS, native helpers and simulator runs without adding overlapping suite counts together.

The real iOS shell passed on fresh, disposable iOS 26.3.1 and 26.4 simulators: the actual pairing UI saved its credential, WKWebView read authenticated file bytes, folder traversal was refused, the native filesystem preserved bytes, and the native URLSession download returned the expected authenticated content. The 26.4 extension held the HTTPS response while Reach was backgrounded by opening Settings, then reopened Reach and verified the bytes and active state. The native share sheet was opened and inspected without choosing a recipient. Only the copied test shell permits local HTTP for the web view; the download uses a temporary HTTPS certificate trusted only in that simulator. Production URL restrictions and TLS validation remain enabled. Simulator execution requires Xcode's local signing (`CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-`); an unsigned compile lacks the linked simulator identity needed by the background service.

This does not test physical-device suspension/OS termination, cellular/VPN transitions, camera scanning, Face ID, push delivery or App Store signing. The simulator's non-file workspace endpoints deliberately return a fixture error so it cannot inspect the host's live terminals, apps, screen or notifications.

This pass found and fixed additional production issues:

| Defect | Verified correction |
| --- | --- |
| Minimal Linux without `SHELL` selected absent `/bin/zsh` | Linux defaults to `/bin/sh`; macOS keeps zsh; explicit shell settings still win. Real installed-package PTYs pass without a test-only shell override. |
| Agent command spawn failure could be returned as success with a null exit code | Startup errors return a safe failure, are logged as failures, and release command capacity. |
| Native download names `.` or `..` could escape the assigned UUID cache folder and reach recursive deletion | Names are confined, persisted IDs and destination directories are validated, symlinks/existing results are refused, and completion never deletes a destination. Compiled Foundation tests exercise real temporary files. |
| Native download URL validation allowed non-HTTP schemes on localhost | Only HTTPS and exact HTTP loopback are admitted; credentials and fragments are rejected. |
| Denied process inspection could report that Reach was stopped and let another launch proceed | Status, start and stop/restart fail with an actionable error when the process inventory is unavailable; an unreadable lock owner keeps its lock. Regression tests use inert process APIs and never stop the user's Reach. |
| Claude's explicit Default permission choice, including fallback for models without Auto, was omitted and replaced by the server's Auto default | The composer sends the explicit selected mode. DOM tests cover new-chat Auto, explicit Default and unsupported-Auto fallback; existing host tests verify Default maps to Manual. |
| Equal filesystem modification times could leave new hosted connectors unavailable and rotated public-door keys cached | All four routing caches use file identity, nanosecond metadata and a successful-write generation. Deterministic same-mtime tests cover new registrations, other-process writes, key rotation/revocation, unavailable stores and recovery. Actual API authorization separately rereads credentials. |
| Grouping workflow chats could move idle siblings ahead of another chat waiting for approval, hiding that approval behind “Show all” | Both chat lists keep approval requests visible beyond the ordinary row budget, including inside folded workflows. Legacy title matching requires one unambiguous Codex task. Real component regressions cover approval/running visibility, expansion, search/archive and matching chat IDs on another computer. |

The native Mac agent pass also fixed cursor-overlay false refusals and Command-modifier leakage during typing; see [agent test evidence](BROWSER_AGENT_TOOLS.md#live-native-follow-up-and-transport-measurements-october-11).

CI now has explicit required Linux, macOS ARM/Intel, Windows portability and iOS simulator lanes, native policy/sandbox checks, installed-package onboarding, dependency/history/workflow scans, and reports retained on failure. Both npm and portable archives are created before their clean-install tests; publishing can copy only the exact bytes bound to successful receipts. Contributor code runs without publishing credentials. The release job uses protected approval and OIDC, with no checkout, dependency installation or lifecycle scripts while publishing.

Workflow files alone do not enforce merges. GitHub initially refused hosted jobs because of account billing/spending limits. After the owner updated billing, the audit job in the fifth attempt of an existing-main run passed at 20:46 UTC. The overall run remained failed because its other refused jobs were not rerun; this historical job result does not establish current billing status or validate the combined-source matrix. The intended open-source repository became public on October 12 (UTC); its main and candidate PR have completed CodeQL analyses, and hosted platform validation is in progress. The earlier private-plan ruleset restriction no longer applies there. Action SHA pinning, the inventoried action allowlist, and the protected manual-approval release environment were enabled and read back. At the owner's request, branch and release-tag protections wait until final validation and main integration; npm trusted publishing still needs its package-side setup. The ruleset separately requires CodeQL findings to pass, because a successful scan can still report vulnerabilities. Follow [.github/MAINTAINER_SETUP.md](../.github/MAINTAINER_SETUP.md) and prove both a failing check and a qualifying security finding block a PR before allowing automatic merges. Repository visibility changed only after history review; no package publication or production Reach restart was performed during testing.

### October 11: Batch 1 setup, install, pairing and CLI regressions

The scoped regressions use temporary homes, mocked services and fake Tailscale. Each behavior fix was reproduced before changing production code. Builds and archive tests run only in a copied checkout. The running Reach and its served files are left alone.

| Finding | Expected result | Test |
| --- | --- | --- |
| S5 | A pairing code on a linked computer uses that computer's own address | `pairing-window` (W4) |
| R1 | A missing node-pty binding names npm's script-approval repair before server startup; Linux npm 12 also tests an explicitly approved rebuild | `installable`, `npm12-install` (Linux CI only) |
| S8, S9 | Portable copies point to the next archive; an unwritable npm prefix names permissions and ownership, or a user-owned prefix | `reach-updates`, `portable-install` |
| S2, S3, S7 | Download prerequisites are checked first, offline cleanup is checked in the failed run's own folder, and a node-gyp network error gets the internet hint | `launcher-script`, `setup-blockers` (H3, H13) |
| S14, S18 | Held locks offer restart; hints use the active command on Windows and npm installs | `windows-commands` (H7, H19) |
| S13, S16, S17 | Serve ignores extra metadata but refuses extra hosts, handlers and Funnel; service refusals identify the folder/plist; Funnel on the private port names its off command | `service`, `setup-blockers` (B4, T11) |
| B2, B3 / S24 | Native and Windows gates each have a CI lane selecting all six formerly orphaned files | `ci-policy` |
| S15 | The extracted portable archive runs its full dependency install and interface build on first local launch; update gives archive guidance | `portable-install` (installed lane) |
| R2 | Committed notices match the npm lock, Go modules and Go runtime; release checks reject drift without rebuilding | `notice-versions` |
| S21 | npm's launcher refuses Node older than 22 before importing Reach | `installable` |
| S19, S22, B1 | Chat tests use `sessions` with an owner positive control; installer UI uses `installPlan`; Home operations use a private fixture with Library | `capabilities`, `agent-install-ui`, `browser-home-preset` |
| R3 | Cold source installation refuses non-Linux hosts before making a fixture or starting a child | `first-install-source` |
| S20, S23 | Matrix rows cite the actual output and tests; install docs give the signed-out operator command and macOS 13 requirement for Tailscale 1.104 | `first-run-docs` |

The earlier macOS cold-source result above is historical evidence, not permission to rerun that harness on a Mac. It is now Linux-only to prevent discovery of a real app-bundled Tailscale. Native/Windows lane selection and the npm 12 Linux lane are configured here; hosted runner results are still needed. A second browser on the same device still needs approval, a passkey or a valid linked-device ticket; grouping devices grants no access. Linux npm 12 keeps its script-approval boundary and Reach explains the explicit native rebuild. Private-socket detection checks the installed CLI's advertised capability and fails closed when absent.

### Not live until Reach restarts

Interface changes (`src/`, `index.html`) reach phones as soon as they're saved. Server and launcher changes, the pairing window included, take effect at the next `./reach restart`.

### Known limits (not fixed in this pass)

Windows has the guided setup (H18) and approves phones by your Tailscale account as a Mac does, through its keyed route; a PC that can't hold that route yet uses the pairing code and says why (T23). Linking computers (T25) and invite links (T26) follow the same rule. People already on your Tailscale can always be invited. On Windows, `status`, `stop`, `restart` and a second start see every Reach on the PC from its process list, as on a Mac; only where that list can't be read do they see the Reach running from the same folder, and say so (H20). Background mode is a task at sign-in (H21). Validation on a real Windows host (M8) is separate work. Ubuntu graphical desktop/service and physical-phone acceptance remain M7; the disposable container launch and onboarding tests above do not replace them. A phone that never installs the Tailscale app can come back only while a pairing window or invitation is open.

This Mac's `dist/` still holds its earlier builds until the next full build prunes them (`./reach` start, or `npm run build`).
