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
| H2 | Node is missing or older than 22 | Reach downloads its pinned private Node and checks its hash | U | `installable` (version/hash parity) | passed Oct 10 |
| H3 | No internet, or no curl or tar | Says what to do (install curl, or Node.js 22+), not curl's raw error | P, M | `launcher-script`, M7 | fixed, passed Oct 10; on Ubuntu (M7) too |
| H4 | Unsupported OS or CPU | Git Bash on Windows is sent to `.\reach.cmd`; another computer is named, with installing Node.js 22+ yourself as the way | U | `launcher-script` | fixed, passed Oct 10 |
| H5 | `npm ci` or the build fails | Names the likely fix (build tools, internet, disk), then `.reach/setup.log` | P | `setup-blockers` | fixed, passed Oct 10 |
| H6 | No Go toolchain | Reach starts. Without the browser client, phones need the Tailscale app | P | `release-assets` | passed Oct 10 |
| H7 | Reach is already running, or its lock is held | Says where it runs and offers `./reach restart` | P | `instances` | passed Oct 10 |
| H8 | Started from iTerm, VS Code, Warp or Codex on a Mac | Opens a Terminal window and runs there | U | `outside-terminal` | passed Oct 10 |
| H9 | No terminal (no TTY) | Skips the guided setup and names the next step | P | `setup-blockers`, `tailscale-connect`, `first-run-launch` | passed Oct 10 |
| H10 | Ctrl+C at a menu or during a wait | "Paused. Run ./reach to continue."; lock released; resumes at the same step | U, P, M | `setup-blockers`, M7 | fixed, passed Oct 10; in a real terminal on Ubuntu (M7) too |
| H11 | npm global install | Settings and phones live in `~/.reach` | U | `installable` | passed Oct 10 |
| H12 | Checkout under `~/Documents`, `~/Desktop`, `~/Downloads` or iCloud Drive | Detected; background mode explained (see B2) | U | `setup-blockers` | fixed, passed Oct 10 |
| H13 | Linux without a C compiler (node-pty builds from source) | Names the packages to install | U, M | `setup-blockers`, M7 | fixed, passed Oct 10; real npm on Ubuntu (M7) too |
| H18 | Windows, first `.\reach.cmd` in a terminal | The guided setup in two steps: 1. Tailscale on this computer (T17–T21), 2. HTTPS link for your phone (T22). Then the pairing code (T23). No account, invite or background step, and no account settings saved | U | `setup` | partly: setup's Windows steps passed; bootstrap running them on Windows is checked only on a Windows host (M8) |
| H19 | Windows: hints on the first-run path (setup's wait, `pair`, `approve`, `configure`, `link`, `update`) and the phone's ("run … configure", "run … invites") | Name `.\reach.cmd`, never `./reach` | U | `setup`, `tailscale-connect` | partly: every hint uses `command` (`scripts/home.mjs`), checked on this Mac; the literal `.\reach.cmd` only shows on Windows (M8) |
| H14 | First run in a terminal (a checkout) | The install (npm, the phone interface, browser sign-in) runs while setup asks about Tailscale; the first question comes in seconds, not after the install. Nothing the install says interrupts a menu; menus are numbered until it's done. `setup.log` records how long setup and each install part took | U | `first-start`, `prompts` | fixed, passed Oct 10 |
| H15 | Setup done before the install | "Finishing the first install: <part>…", then Reach starts | U | `first-start` | fixed, passed Oct 10 |
| H16 | The install fails during setup (no internet, no compiler) | Setup finishes and is saved; the install's fix is said after it | U | `first-start` | fixed, passed Oct 10 |
| H17 | Ctrl+C during setup while installing | "Paused"; npm and the Go build stop; the next `./reach` installs again and resumes setup | U | `first-start` | fixed, passed Oct 10 (bootstrap's wiring: manual, M6) |

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
| T9 | Mac App Store Tailscale with a short name over 14 characters | Caught in setup, before "Setup complete", with the fix | U | `setup-blockers` | fixed, passed Oct 10 |
| T10 | MagicDNS or HTTPS certificates off | Opens the DNS page and waits | U, M | `setup`, M7 | passed Oct 10; on Ubuntu (M7) HTTPS off passed, MagicDNS off not reproduced |
| T11 | Port 8443 used by another service, by Funnel, or by an older Reach's route | Each gets its exact fix (`tailscale serve --https=8443 off`, `--https-port`) | U | `launcher`, `setup-blockers` | fixed, passed Oct 10 |
| T12 | `--https-port 9443` | Saved, reused on the next start, and used by the invites rule | U | `setup-blockers` | fixed, passed Oct 10 |
| T13 | Port 443 used by another service | Reach runs; phones need the Tailscale app; the terminal says so | U | `first-run-launch` | passed Oct 10 |
| T14 | Funnel not allowed by the tailnet policy | Prints and opens Tailscale's page | U | `first-run-launch` | fixed, passed Oct 10 |
| T15 | Tailscale CLI and daemon versions differ | Warning | U | `first-run-launch` | passed Oct 10 |
| T16 | A full Tailscale-mode start (fake Tailscale) | Reaches "Reach is ready", prints the one address | P | `first-run-launch` | passed Oct 10 |
| T17 | Windows: Tailscale not installed | Menu, then the Windows download page opened and its URL printed. Reach continues once it's installed, without a restart | U | `tailscale-connect` | fixed, passed Oct 10 |
| T18 | Windows: installed, not running | Opens the Tailscale app (`tailscale-ipn.exe`) once, then names the service fix: `net start Tailscale` from a terminal opened as administrator. Without the app: the Start menu, and the same fix. No Mac or Linux words | U | `tailscale-connect` | fixed, passed Oct 10 |
| T19 | Windows: signed out | Runs `tailscale login`, prints and opens the URL | U | `tailscale-connect` | fixed, passed Oct 10 |
| T20 | Windows: switched off | Offers `tailscale up`. If that's refused: the taskbar icon, with the app opened so the icon is there | U | `tailscale-connect` | fixed, passed Oct 10 |
| T21 | Windows: the Tailscale CLI isn't on Reach's PATH (installed while Reach waited) | Found at `%ProgramFiles%\Tailscale\tailscale.exe`, looked up again on every check. Pages open with `explorer.exe`, not `start` (a cmd built-in that cuts links at `&`) | U | `tailscale-connect` | fixed, passed Oct 10 |
| T22 | Windows: MagicDNS or HTTPS certificates off | Opens the DNS page and waits; the wait names `.\reach.cmd` | U | `setup` | fixed, passed Oct 10 |
| T23 | Windows: how phones are approved | With the pairing code. Tailscale-account approval needs Serve to reach Reach through a Unix socket, which Windows lacks. `.\reach.cmd configure` says so; `approve` points to the code and `pair`. Kept on Oct 10, the owner's call | U, P | `setup`, `launcher` (P10) | fixed, passed Oct 10 |
| T24 | Windows, no terminal | Says what's missing, opens nothing | U | `tailscale-connect` | passed Oct 10 |
| T25 | Windows: `.\reach.cmd link` | Refused with why (linking needs Tailscale-account approval), before reading anything | U | `fleet` | fixed, passed Oct 10 |

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
| B4 | Already installed, or installed from another folder | Refused with where it is | U | `service` | passed Oct 10 |

## W. Pairing window

| ID | Case | Expected | Type | Test | Status |
| --- | --- | --- | --- | --- | --- |
| W1 | Interactive start | Opens a 15-minute window; the link and QR are the one address | S, P | `pairing-window`, `phone-link`, `first-run-launch` | fixed, passed Oct 10 |
| W2 | A phone is approved | The window closes; the internet gets "Not found." again | S | `pairing-window` | passed Oct 10 |
| W3 | 15 minutes pass | The window closes | S | `pairing-window` | passed Oct 10 |
| W4 | `./reach pair` | Reopens the window, for a foreground or background Reach | S | `pairing-window` | passed Oct 10 |
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
| P3 | Reach in the background | `./reach approve` | U | `service` | passed Oct 10 |
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
| A4 | Claude Code installed, signed out | Sign in | D | `claude-signed-in-check`, `across-agents-ui` | passed Oct 10 |
| A5 | Claude app without the Claude Code CLI | "Claude Code isn't installed", not "signed out". Sending is blocked unless the Claude app owns the chat | S, D | `first-run-agents`, `agent-session-ui` | fixed, passed Oct 10 |
| A6 | Codex installed, signed out | Sign in | D | `across-agents-ui` | passed Oct 10 |
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
| D2 | No Screen Recording or Accessibility | Each permission named | S | `screen-stream`, `agent-desktop` | passed Oct 10 |
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
| M8 | A fresh Windows 11 user without Tailscale:<br>1. `.\reach.cmd` in PowerShell. The arrow-key menus work.<br>2. The Windows download page opens. After installing, Reach continues without a restart.<br>3. The sign-in page opens. If HTTPS is off, the DNS page opens.<br>4. The pairing code shows. A phone with the Tailscale app pairs with it. | not tested |

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

**Found by a test written first, run, and seen to fail.** The tests ran against the code before this pass, with only the new exports stubbed so the files could load. 8 of the 9 new tests failed there (and T25's, added after, against its old message). T24 passed: it guards what already worked. Then fixed, and all of them passed:

| Row | Found | Fixed in |
| --- | --- | --- |
| H18, T22 | No guided setup on Windows. HTTPS certificates off failed only at Serve, with a link that never opened | `scripts/bootstrap.mjs`, `scripts/setup.mjs` (Windows steps), `scripts/configure.mjs` (`accountApproval`) |
| T17, T21 | No Windows download page. A Tailscale installed while Reach waited stayed invisible: the installer's PATH never reaches a running Reach | `scripts/tailscale.mjs` (Program Files), `scripts/tailscale-connect.mjs` |
| T18, T20 | Windows was told to "Open Tailscale on this computer", and Tailscale's app was never opened | `scripts/tailscale-connect.mjs` |
| T19 | Pages never opened on Windows (`open` and `xdg-open` only) | `scripts/tailscale-connect.mjs` (`pageOpener`), `scripts/setup.mjs`, `scripts/launch.mjs` |
| H19 | `./reach` printed on Windows by setup's wait, `pair`, `approve`, `configure`, `link`, `update` and the service banner, and shown on phones by device approval and invite keys | those files, `server/index.mjs` and `server/guest-keys.mjs`, through `command` |
| T25 | `.\reach.cmd link` on Windows said "Start Reach on this computer first", which could never work there | `scripts/link.mjs` |

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

### Not live until Reach restarts

Interface changes (`src/`, `index.html`) reach phones as soon as they're saved. Server and launcher changes, the pairing window included, take effect at the next `./reach restart`.

### Known limits (not fixed in this pass)

Windows has the guided setup (H18) but approves phones by pairing code (T23); linking computers needs Tailscale-account approval, so `link` says it isn't available there (T25). Invite links for people without the Tailscale app need the public start page, which needs the same socket: setup doesn't offer them on Windows, and the phone's Invite sheet on a Windows host is unchecked. Validation on a real Windows host (M8) is separate work. On Ubuntu, the full start and the phones are still to check (M7). A phone that never installs the Tailscale app can come back only while a pairing window or invitation is open.

This Mac's `dist/` still holds its earlier builds until the next full build prunes them (`./reach` start, or `npm run build`).
