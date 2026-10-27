# Changelog

All notable changes to Reach are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Reach uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). The release workflow
publishes the section whose heading carries the tagged version as the GitHub
release notes, so date the heading before tagging.

## [Unreleased]

## [0.4.4] — 2026-10-26

The iPhone app no longer shows a blank white page after the phone sits idle.

### Fixed

- After the iPhone sat idle, the Reach app could come back as a blank white
  page that only quitting and reopening fixed: iOS had ended the page's
  content process and its reload failed while the computer didn't answer. The
  app now notices an empty or unanswering page when it comes back to the
  front (and every 10 seconds), shows "Reconnecting to your computer…", and
  reopens the same Reach link once the computer answers. The page itself no
  longer reloads for an update while it's put away without an offline copy,
  and reloads in front only once the computer answers. The app part needs a
  new build of the iPhone app.

## [0.4.3] — 2026-10-26

Early-access release: one permanent owner link that works with the phone's
Tailscale app on or off, browser enrollment during owner setup, Tools
navigation, a UI review across the phone's pages, fullscreen Screen like a
video, and Copy selected text on Mac Chrome pages and in apps like Numbers.

### Added

- One permanent owner link per computer. The same link works whether the
  phone's Tailscale app is on, off, absent or on another tailnet; Reach picks
  the best authorized connection itself and returns to the app's when it comes
  back, keeping open work and never replaying an action of unknown result.
- Owner setup prepares and verifies the phone browser's private connection as
  well, including for owners who start with the phone app; existing app-only
  owners are offered the same setup once. The browser registers its own
  non-exportable key, and Reach issues that connection its own credential with
  the same access; guests, restricted devices and agents can't use this.
  While an agent or person is using the computer, the owner's own enrolled
  second connection still gets in (it's checked as that owner's client,
  never by account or device name alone).
- A Tools page, with any tool pinned to Home as a shortcut you can reorder,
  and a menu of your computers.

### Changed

- Home shows what's running on the computer again, as circles under its
  card: a ring turns while an agent or terminal works, pulses amber when it
  needs you, and keeps a check (or "!") for a few minutes after it ends. One
  tap opens it; nothing running, no row. They stay in one row that scrolls
  sideways, and Reach's own launcher windows aren't among them.
- Home's computer card is quieter: no name under it (the top bar has it),
  no "Open screen" pill (tap the preview, or Screen in the bottom bar), and
  its status is one line with nothing to expand.
- The public start page and its fixed files stay available at the owner link
  without a pairing window, so the bookmark always opens; owner APIs and
  WebSockets remain private. Setup shows the phone QR only once that link is
  verified (public DNS, HTTPS and the browser client); a phone already on this
  tailnet can still ask for the private QR by typing `private`.
- Bottom navigation is Home, Screen and Tools; Files, Terminals, Chat and the
  rest open from Tools, and the More sheet is gone. Each open tab remembers
  its views for the session, never requests, results or credentials.
- One look across the phone's pages:
  - Home, Chat and Terminals share one top bar (height, round buttons, title, then the bell and Settings).
  - Terminals keeps the bottom bar over its list, with a back arrow to Tools.
  - With one computer, its name shows once: no top-bar pill, no Files caption, no Chat row.
  - Files names the home folder as Finder and Explorer do.
  - "…is within reach" shows only when it's news.
  - Home's Pause reads Pause or Paused.
  - Agents & people invites with the same "+ Invite" pill as Home.
  - Settings says Face ID in one line, and Fallback as Set up or Ready.
- Settings opens with how this phone reaches the computer, as a dot and a
  word: green for the Tailscale app, amber for Tailscale in the browser or
  the public link, grey when offline. Reach picks the route; nothing to
  switch. About shows the version Reach runs beside "Up to date".
- Screen fullscreen shows the computer alone, upright as well as on its
  side, as a video plays fullscreen: the controls float over the picture
  and fade until it's touched, instead of keeping a bar above and below.
  On its side the picture runs under the home bar. On Android the
  fullscreen button also hides the browser's address bar.
- Home and the computer menu call a public link "Public link", never "Tailscale".

### Fixed

- On a Mac, Copy selected text works on pages in Chrome and in apps that
  don't tell macOS what's selected (Numbers, some Electron apps): Reach asks
  the app in front for its focused element, never another app's, and when
  the app won't say, copies the selection as you would (⌘C) and puts the
  Mac's clipboard back. A hidden password copied that way is the owner's
  alone. A blank selection says to select text first instead of copying a
  blank line. The helper also reads the app in front afresh each time, not
  the one in front when screen control began.
- Escape puts a dragged queued message back even when pressed the moment it
  lifts.

## [0.4.2] — 2026-10-25

Early-access candidate including the file editing, terminal clipboard paste
and Windows setup fixes prepared for the unpublished 0.4.0 and 0.4.1 candidates.
It also recovers local screen-control work omitted from those candidates.
The earlier tags remain unchanged; their detailed changes are recorded below.

### Added

- Set up a browser fallback from the existing private Reach link. The browser
  keeps its own Tailscale identity and separate device approval with the same
  access. Preparing this link also saves Reach's public interface files so it
  can reopen when the native connection is unavailable; computer data and
  credentials are never cached by that preparation. Home suggests this
  one-time setup while the Tailscale app connection is on, so it is ready
  before the app is turned off; Settings keeps the same setup.
- Let agents close their tracked tabs with `reach_close_tabs`, or automatically
  after five minutes without agent activity or when their access ends. Opening
  a sixth tracked tab tries to close its oldest eligible background tab.
  Supported browsers are Chrome on macOS and Chrome/Edge on Windows, with
  their existing browser permissions. Pre-existing, ambiguous, redirected and
  navigated pages are left open, including changed paths, queries or fragments.
  Cleanup waits while the owner is using Reach; uncertain closes are never
  retried automatically.
- Edit UTF-8 text files from Files, preserving Windows line endings and checking
  the original file hash before saving. Unsaved drafts survive closing a preview
  and verified private handoffs; a save still requires an explicit action.
- Paste the phone's clipboard into Reach terminals and the computer's terminal
  tabs. Manual paste stays available when clipboard access is unavailable;
  command-running line breaks require confirmation.

### Fixed

- Reopen a prepared private-port link after the native route disappears,
  authenticate through the browser's own saved approval, and return to native
  automatically. Complete interface versions keep the normal browser security
  policy; interrupted preparation keeps the previous complete version.
- Keep agent desktop tools responsive during concurrent startup, refuse work
  after its grant changes, bound pending native input and report helper
  failures as structured tool errors. Screenshot results must remain fresh.
- Wait for the terminal watcher's process to close before Reach finishes
  shutting down, and prevent queued refreshes or delayed terminal reads from
  starting another helper after shutdown.
- Wait for active file icons, app shortcuts, installed-app catalogs and agent
  logos to finish their native lookups when Reach stops. Refuse queued and
  delayed lookups after shutdown so their Windows helper can be removed.
- Reject non-web site filters for tab cleanup before taking control or sending
  a close. Closing tabs is advertised as a write that can lose unsaved state.
- "Find Gmail message" no longer stops at "The browser has not reached the
  exact requested page." Gmail writes a search's spaces back as `+`, so the
  tool's exact address match never came. Equivalent spelling is accepted only
  within Gmail's single search-query segment. The HTTPS site, account, path
  and query string still match exactly; other pages and route boundaries
  retain exact address matching. The browser document binds to the exact
  reached address, and another search still stops.
- Keep a terminal's last row and column inside its screen above the keys,
  and keep following the newest output when its box is fitted again.
- Recover live screen, sound, control and terminals through a brief identity
  lookup interruption. Deliver nothing until access is confirmed again;
  expiry, revocation and a closing connection still end delivery.
- Keep touch double-clicks paired when a finger drifts or the picture moves,
  prevent delayed synthetic taps from stealing the keyboard, and keep long
  presses and typing ordered during reconnects.
- Preserve known-unsent typing after reconnecting until the user confirms
  the current field. Never replay typing whose delivery is unknown or send
  a waiting draft automatically into a replacement field. With nothing
  waiting, the next tap on a text field types again and an ordinary tap
  dismisses the keyboard; waiting typing can be sent or discarded. Input the
  browser couldn't hand to an already-closing connection counts as never
  sent, not as of unknown delivery. Keep native secure keyboard context
  synchronized with the phone after Return.
- Keep known-unsent typing across verified private handoffs and media gaps.
  A different approved device credential requires Control again, and delayed
  replies from an old grant cannot enable or release its replacement.
- When the native Tailscale route disappears and its address reaches the public
  start page instead, try the browser's separately approved private connection.
  Return to the preferred native route automatically when it is available.
  Owner APIs and WebSockets remain private.
- Read foreground-app context beside the input queue so a slow accessibility
  scan cannot block clicks or keys. A newer authorized control connection can
  replace its predecessor without taking control back from the new window.
- Respect the current Mac keyboard layout for letter and digit keys. Improve
  Windows Unicode typing, console field detection, elevation refusals, wheel
  units and cold helper startup.
- On partially accepted Windows keyboard input, release only the helper's
  accepted unmatched key-down, then stop the uncertain typing sequence.
- Request video keyframes when a viewer actually missed frames and disable
  unsupported long-term references in the Mac encoder.
- Update request parsing, uploads and development HTTP dependencies for current
  security fixes. Build the browser's private Tailscale client with Go 1.27.3,
  including its certificate-verification security update.
- On Windows, quitting Reach now stops and waits for its process-list helper
  (the Claude app checks), so no helper outlives Reach or keeps its program
  file open for an update.
- On Windows, a failed write to agents' browser command log (a full disk) no
  longer blocks their browser commands until Reach restarts, and a log left
  mid-line no longer turns those commands off at every start.
- On phones, typing that waits after a reconnect keeps its "Typing paused"
  line with Send and Discard on screen while the keyboard's key row is up,
  just above the keys instead of hidden or covering them.

### Validation

- Make flaky tests fail only when Reach is wrong: browser-test servers close
  without waiting on idle connections; dropouts are counted against the sound
  player only when its source kept time; fixed sleeps became waits for the
  awaited state; macOS CI runners no longer index with Spotlight, which starved
  the iOS simulator. Every test file now runs on Windows (CI's windows-rest
  job) unless its own platform lane runs it; about 140 first-run failures,
  nearly all tests that assumed a Mac, were fixed at their cause.
- Reach's log names any screen-control action the computer takes 2 s or more
  to do, and screen-control journeys record what ran in the phone page's
  long frames, so a stall says where it came from.
- Restore the source branch's regression tests and include shared identity,
  typing and terminal layout checks in Windows CI. Run the native Windows
  input checks and screen-control journeys with iPhone, iPad and Android
  browser profiles. These profiles simulate clients; they are not physical
  device validation.
- Hosted tests, browser profiles and the iOS simulator do not establish physical
  iPhone/iPad/Android behavior, live authenticated private/public handoffs or
  signed-in provider tasks. Those qualifications remain incomplete.
- Resolve the current Node 24 release for the official OpenClaw compatibility
  check, so an older runner cache cannot violate the vendor's runtime minimum.

## [0.4.1] — 2026-10-19 (unpublished)

Early access: file editing, clipboard paste and Windows setup improvements.
Includes the changes prepared for the unpublished 0.4.0 candidate, whose tag
remains unchanged after its validation failed.

### Added

- Edit text files from Files: Edit in a text or code file's preview opens it in
  a full-screen editor, and Save writes it back to the computer. Saves send the
  hash of the version read, so a file changed on the computer meanwhile is never
  written over; the draft stays to copy. Windows line endings (`\r\n`) are kept.
  Files over 128 KB, files that aren't UTF-8 text and files with mixed line
  endings stay view-only and say why. Edit appears only with access that can
  change files. Unsaved edits ask before closing and come back if the preview
  closes another way.
- Paste into terminals from the phone: a Paste key in the terminal's key row
  sends the phone's clipboard, in terminals Reach started and in the Mac's or
  PC's own terminal tabs. Where the phone won't share its clipboard, a small
  box takes the phone's own paste. A paste whose line breaks would run commands
  asks first, unless the program takes pastes whole (bracketed paste). Control
  characters are removed, and a terminal that isn't connected says so instead
  of keeping the paste for later.

### Fixed

- Recover screen audio using media arrival timing and buffered frames, avoiding
  repeated drains without waiting for an extra whole packet batch. Initial
  buffering stays at 100 ms and the recovery target stays capped at 400 ms.
  Intentional silence and discarded old audio reset the timing history.
- Keep a mobile navigation tap on its intended destination when device details
  add tabs while the finger is down. Cancelled gestures and removed destinations
  do not navigate; keyboard and assistive clicks retain their explicit target.
- Keep a pending clipboard read bound to its original terminal and access.
  Switching terminals or computers, changing access, or closing the view drops
  the old read, including a switch away and back.
- Parse a terminal's saved output before enabling input after connecting.
  Old device-query replies no longer reach the live shell, and terminal queries
  leave the phone's Ctrl key armed for the next typed character. Live queries
  still receive their normal replies.
- Preserve a newer unsaved file draft when an earlier preview's save completes
  after it closes. A confirmed save clears only the draft it saved.
- Keep unsent file and manual-paste drafts across verified, already approved
  private handoffs and late computer-metadata updates. Saves and pastes still
  require a fresh explicit action using the current connection's credentials.
- Keep manual paste text when its terminal is disconnected or its command
  confirmation is declined, so a known-unsent draft can be copied or submitted
  explicitly later.
- Terminal input longer than 32,768 characters (a large paste, from the phone
  or a computer's keyboard) arrives whole, in pieces, instead of being dropped.
- Recognize Windows' same-owner `OWNER RIGHTS` folder permissions and narrowly
  repair the legacy same-owner read grants created by Reach. Foreign ownership,
  broad write access, junctions, hard links and unsafe helper caches remain refused.
- Keep Windows setup and source-checkout update instructions actionable, and
  isolate native helpers from writable checkout files and stale cached builds.
- Show only the current Reach process's link and route status, preventing stale
  readiness left by an earlier run from appearing during startup.
- Read Windows' app catalog and file icons through the existing native shell
  helper, and launch validated app IDs directly, avoiding PowerShell cold-start
  failures while preserving operation deadlines and unknown-action handling.
- Recheck access and pause state after app discovery or helper preparation,
  immediately before opening an app on either Mac or Windows.
- Bound app-launch requests by the authenticated device's identity, preserving
  separate budgets for other devices and refusing excess work before dispatch.
- Validate macOS runtime library inspection before granting isolated scripts
  access to their runtime files; a confirmed read-only inspection timeout has
  one bounded retry for the whole dependency graph.

### Validation and limits

- Simulator checks pin Xcode 26.2 and iOS 26.2 together and require native
  background and resume events; app-launcher completion alone does not
  establish those transitions.
- Release checks run Linux Node 22/24, Apple Silicon and Intel macOS, Windows,
  the iOS simulator, security scans and installed npm/portable artifacts. Windows
  ARM64 native validation is recorded separately from the required x64 lane.
- Hosted browser/OS tests use controlled files, routes and synthetic audio.
  Physical iPhone/iPad/Android, authenticated private → public → private network
  transitions, standard-user GUI parity and full signed-in provider tasks remain
  unqualified. An AppContainer control refusal leaves its escape checks unrun;
  a passing parent does not prove those assertions executed.
- Disposable Windows test browsers join a kernel-owned process job before
  starting, so an exited parent cannot leave descendants holding their pipes
  and temporary profile. Cleanup requires proof that the owned job is empty.
- An additional hosted macOS 26/iOS 26.4.1 cold boot timed out before Reach
  installation, leaving that environment unqualified. The matching 26.2 run
  completed all eight native checks after two initial launch timeouts.
  Simulator startup stability and the earlier hangs' cause remain unproven.
- npm installs update with `reach update`; source installs use `v0.4.1`. Keep
  existing Reach state and restart through the CLI. Restarting ends terminals
  and live screens; invited agents obtain compatible runtime updates from Reach.

## [0.4.0] — 2026-10-19 (unpublished)

The tag did not pass release validation and was not published. Its changes
continue in 0.4.1; the original tag remains unchanged.

## [0.3.3] — 2026-10-18

Early access: includes the Windows QR and Codex connection fixes prepared for
0.3.2. That candidate was not published because its tag checks caught an
intermittent browser-test failure; the `v0.3.2` tag remains unchanged.

### Fixed

- The real-browser CORS fixture uses an embedded favicon and ends bootstrap
  interception before making signed private requests. Controlled tests on real
  Linux Chrome 155 reproduced cancellation with the original bootstrap, while
  both corrected variants passed 20 consecutive runs. The same origin, host,
  permission, signature, replay, pause and revocation assertions remain enforced.
- Show the verified private Tailscale QR while public browser setup waits for
  Funnel approval or DNS, with the phone's Tailscale-app requirement explained.
  The public QR still waits for verified DNS and HTTPS readiness.
- Support Codex's Windows AF_UNIX control socket through a native bridge that
  validates the endpoint directory and the connected peer's Windows account and
  elevation. Existing named pipes remain supported; actions with an unknown
  result are not automatically replayed.

### Validation and limits

- The release tag runs Linux Node 22/24, Apple Silicon and Intel macOS, Windows,
  the iOS simulator, security checks and installed npm/portable artifacts.
- Real Windows Server 2025 testing verified the Codex connection under a standard
  account and six native NTFS ACL/junction checks. Native desktop capture, clicks,
  typing, UI Automation and video also passed; local GUI smoke used the hosted
  administrator account, so standard-user GUI parity remains unverified.
- Windows QR/networking regression tests use simulated Tailscale identities and
  responses. Physical Windows PCs, Windows 10/11 hardware, authenticated private
  → public → private handoffs, sleep/network changes, full signed-in provider
  coding tasks and physical iPhone/iPad/Android acceptance remain incomplete.
  Simulator and browser emulation results do not establish physical-device behavior.
- npm users can update with `reach update`; source installs use `v0.3.3`.
  Keep the existing `.reach` state or configured external state folders and
  restart through the CLI. Restarting ends terminals and live screens.

## [0.3.2] — 2026-10-18

Early access: fixes for Windows phone setup and shared Codex sessions.

### Fixed

- Show the verified private Tailscale QR automatically while public browser
  setup waits for Funnel approval or DNS. The message explains that this link
  needs the phone's Tailscale app. The public browser QR still waits for verified
  DNS and HTTPS readiness; owner APIs and WebSockets stay private.
- Connect to Codex's Windows AF_UNIX control socket instead of rejecting it as
  an invalid named pipe. The native bridge validates the protected endpoint
  directory and the connected peer's Windows account and elevation before
  relaying data. Existing named-pipe connections remain supported. Interrupted
  actions with an unknown result are not replayed automatically.
- Retain bounded simulator launch diagnostics for iOS CI failures. QR and Windows
  console regressions now wait for complete output and the current startup
  prompt without weakening their pairing or approval checks.

### Validation and limits

- [PR #64](https://github.com/nalebc/reach/pull/64) passed all 22 checks before
  merge, covering Linux Node 22/24, Apple Silicon and Intel macOS, Windows,
  the iOS simulator, security scans and installed npm/portable artifacts.
  The release tag reruns checks on the exact versioned candidate.
- Real GitHub Windows Server 2025 testing reproduced the original Codex failure
  and verified the fix with official Codex 0.163.0 under a standard local account,
  including initialize and thread listing. Six real NTFS ACL/junction assertions
  also passed. Separate native desktop checks exercised capture, clicks, typing,
  UI Automation and video. Local GUI smoke checks used the hosted administrator
  account; standard-user GUI parity and full provider coding tasks are unverified.
- Windows QR/networking regression tests use simulated Tailscale identities and
  responses. Real authenticated private → public → private handoffs, physical
  Windows PCs, Windows 10/11 hardware behavior, sleep/network changes and physical
  iPhone/iPad/Android acceptance remain incomplete. Simulator and mobile browser
  emulation results do not establish physical-device behavior.
- npm users can update with `reach update`; source installs use `v0.3.2`.
  Keep the existing `.reach` state or configured external state folders and
  restart through the CLI. Restarting ends terminals and live screens.

## [0.3.1] — 2026-10-17

Early access: private connections recover automatically across supported hosts
and clients. Includes the owned coding tasks, agent tools, file/chat recovery,
Windows setup and version diagnostics prepared for 0.3.0 and 0.2.1; those
candidates were not published to npm or GitHub. Their tags remain unchanged.

### Added

- Invited agents can start, inspect and cancel owned coding tasks in shared
  projects. Durable request IDs, bounded results, invitation scopes and existing
  chat permission defaults apply. Full control invitations include service tools
  that the owner can revoke.
- A documented connection policy makes private preference, authorized fallback,
  automatic recovery and preservation of open work requirements on every device.

### Fixed

- Owner clients prefer native private Tailscale, recover through an already
  approved browser Tailscale connection when available, and return to native
  automatically, including from private workspace deep links. Initial startup
  can also restore a saved approved browser
  when the native device is unapproved or unavailable. Each device keeps its
  own credential and approval; recovery preserves open chats, drafts,
  attachments and pending work.
- A public start page uses its saved native approval before browser sign-in,
  and checks again while waiting. Startup keeps the page's saved credentials
  and restricted permissions, opens the workspace once, and cancels abandoned
  browser or Face ID enrollment when native access returns.
- Browser recovery reads a validated profile snapshot and stops if the saved
  profile changes during loading. Stalled assets have a bounded recovery
  deadline; late completion cannot create a second node. Cancellation also
  works on supported older iOS browsers.
- Agent connections prefer available private routes before their authorized
  public gateway and periodically return to private. Recovery reuses existing
  signing grants and previously configured private clients; it never silently
  approves another device, enrolls a node or replays an action with a lost reply.
  Saved profiles are validated and reused as one bounded snapshot, so replacing
  a state file cannot change the identity during startup.
- Private DNS keeps every eligible address, so an unavailable IPv6 route does
  not discard a working private IPv4 connection in favor of public access.
- Browser agents can use the computer's private gateway across HTTPS ports.
  Preflight and response headers allow only the configured public origin and
  private host; signing grants, scopes and replay protection still apply.
- Losing private Serve no longer disables a healthy authorized public agent
  gateway. Owner APIs and WebSockets remain private, and security stops still
  close affected access.
- Native file downloads and uploads follow the connection bound to their peer,
  including during a handoff. Previously completed native downloads stay usable.
- Private pages supply the fixed browser networking assets needed for recovery.
  Content security policy permits the private Tailscale connection without
  enabling arbitrary scripts or exposing owner APIs publicly.
- The tool-error privacy regression checks the actual error display without
  mistaking a matching number in a run UUID for an exposed native error.

### Validation and limits

- Candidate checks cover Linux on Node 22 and 24, Apple Silicon and Intel macOS,
  Windows, the iOS simulator and clean-installed npm and portable artifacts.
  Connection regression checks also run in the blocking Windows suite.
- iPhone, iPad and Android recovery scenarios use shared client code with
  simulated networking. Hosted runners and the iOS simulator do not establish
  physical-device VPN, cellular, sleep or relay transitions. Physical Windows,
  iPhone, iPad and Android acceptance remains incomplete.
- Destination routes must already be authorized. Different native/browser
  device identities cannot share a device-bound approval. Hosted MCP providers
  control their connector URL and network; Reach cannot switch their network.
- Real Codex and Claude disposable coding tasks were checked on macOS. Grok and
  Muse have not acceptance-tested the new coding tools; Windows provider checks
  remain synthetic. Browser extension store publication remains pending.
- npm users can update with `reach update`; source installs use `v0.3.1`.
  Keep the existing `.reach` state or configured external state folders and
  restart through the CLI. Restarting ends terminals and live screens.

## [0.3.0] — 2026-10-17

Early access: owned coding tasks for invited agents, reliable Windows phone
setup and package version diagnostics. Includes the agent connection, file
transfer and chat recovery fixes prepared for `v0.2.1`; that earlier candidate
was not published to npm or GitHub.

### Added

- Invited agents can start, inspect and cancel owned coding tasks in shared
  projects, with durable request IDs, bounded results, per-agent request limits
  and the existing chat permission defaults.
- Full control invitations include service tools for the agent's session. The
  owner can still revoke a service; narrower invitations retain their approval
  workflow. The agent's guide and phone interface describe the same access.

### Fixed

- Agent CLI, MCP, health and access diagnostics report the loaded package
  version, including standalone agents moved outside the installed package.
- Signed-in service tools use Chrome or Edge on Windows and Chrome or Safari
  on macOS, with the platform's matching app grants and setup guidance.
- CI waits for native watcher registration and isolates launcher-lock fixtures
  from other running tests. Windows console checks follow the explicit private
  QR fallback; stalled iOS launches retain bounded command and simulator evidence.
- Windows phone setup verifies public DNS and HTTPS before showing its browser
  QR, so a link that works only on the PC cannot be handed to a phone without
  Tailscale. Phones on the same Tailscale network retain private access. Busy
  private HTTPS ports recover automatically and the selected port is remembered.
  CI decodes the emitted QR and exercises phone onboarding against source and
  installed packages, including Windows.

### Validation and limits

- Release CI checks Linux on Node 22 and 24, macOS on Apple Silicon and Intel,
  Windows and the iOS simulator, including installed npm and portable artifacts.
  The release tag repeats those checks on the exact candidate before publishing.
- Windows native checks use hosted runners and local browser pages. Physical
  Windows, iPhone, iPad and Android qualification remains incomplete. Mocked
  service checks do not establish live Gmail, Walmart or hosted-agent provider
  compatibility. Native iOS remains an optional developer build.
- Disposable coding fixes and their requested checks were verified with real
  Codex and Claude on macOS. Windows coding-provider tests remain synthetic;
  the new coding tools have not been acceptance-tested through Grok or Muse.
  Claude edits made through shell commands may lack structured file diffs.
- npm users can update with `reach update`; source installs use `v0.3.0`.
  Restart through the CLI and keep the existing `.reach` state or configured
  external state folders. A restart ends terminals and live screens.

## [0.2.1] — 2026-10-16

More reliable agent connections, safer file transfers and chat recovery.
This patch includes the fixes merged in [#52](https://github.com/nalebc/reach/pull/52),
[#53](https://github.com/nalebc/reach/pull/53) and
[#54](https://github.com/nalebc/reach/pull/54).

### Added

- 2026-10-15: People you invite watch and control a Windows PC's screen as
  they do a Mac's. Windows can't leave a window out of the picture, so in
  theirs password managers, Reach's own windows and the rest of what agents
  never see are painted black, in video and still images alike; your own view
  is unchanged. A PC that can't do this says why, and doesn't offer the
  screen to them. A password manager's copied secret stays yours there too.
  Proven on GitHub's Windows 2025, 2022 and 11 on Arm runners; not yet on a
  physical PC.
- 2026-10-15: Agents' saved browser tools on a Windows PC, as on a Mac: the
  same tools, batches, receipts and refusals run in the owner's own Chrome or
  Edge through Reach's new browser extension, which talks only to the Reach on
  that PC (through a small helper Reach registers by itself) and does nothing
  until the owner allows it in Agents → Browser tools. Agents → Browser tools
  says per browser what's left in one tap: Add (opens the store page there),
  Open, or Allow. Proven with real Chrome and Edge on GitHub's Windows
  runners; not yet on a physical PC. The extension waits for the owner to
  publish it on the Chrome Web Store and Edge Add-ons; until then no copy of
  it can connect, and setup says it isn't in the store yet. The Mac keeps
  Apple Events, unchanged.

### Fixed

- Agent credential renewal now checks the original device, key and connector
  before changing credentials. Concurrent requests and browser tabs share renewal
  work, and in-flight calls can finish during the short credential handover.
- A dropped agent connection no longer replays an action whose result is unknown.
  Commands that were never sent can retry; an interrupted answer no longer tells
  the agent that an action definitely did not run.
- File downloads keep the verified file open through transfer. Uploads recheck
  their destination and recover from bounded session loss; cancellation and
  failed setup clean up native transfers.
- Interrupted chat delivery, queued edits and cancellation recover without losing
  the saved outbox or leaving queued work asleep.
- CLI restart flags and folders with spaces, supervisor shutdown during recovery,
  split UTF-8 helper output, primary-pointer filtering and abort cleanup behave
  consistently across their supported paths.
- Agent screenshots preserve binary data and display selection, with a bounded
  image response allowance. Ordinary JSON response limits remain unchanged.
- Already-approved service requests run immediately; service failures give useful
  guidance without exposing private response details.
- 2026-10-15: On a Windows PC, answering the Claude app's consent card
  (letting Claude use apps) from the phone no longer tells the owner to
  install Apple's developer tools on a Mac. It says plainly to answer it in
  the Claude app on the PC, and switches nothing there. Checked with mocked
  tests on GitHub's Windows runners; not tried on a physical PC or with the
  real Claude app's card.

### Validation and limits

- The merged fixes passed the public repository's blocking Linux, macOS (Apple
  Silicon and Intel), Windows and iOS simulator checks, including clean installs
  of the packaged artifacts. Release tags repeat those checks on the exact
  candidate before publishing.
- Physical Windows, iPhone, iPad and Android qualification remains incomplete.
  Automated protocol checks do not establish live Grok or Muse compatibility;
  provider acceptance results must be recorded separately.
- npm users can update with `reach update`; source users can fetch and check out
  `v0.2.1`, then restart through the CLI. A restart ends terminals and live
  screens; keep the existing `.reach` state or configured external state folders.

## [0.2.0] — 2026-10-15

Agents and phones on a Windows PC as on a Mac, faster agents, an
owner-first screen with gestures you can feel, modern sheets, one-tap updates
for what Reach drives, and fixes across Face ID, Windows and chats.

### Added

- 2026-10-14: Agents on a Windows PC work as on a Mac. Each preset (Full
  control, Apps, Files, Read-only) sees and controls only what it may;
  protected windows, password boxes and windows running as administrator stay
  closed; the owner's own input pauses them. Full control's commands reach the
  clipboard and desktop as on a Mac; the other presets keep Windows' limits.
  Proven on GitHub's Windows 2025, 2022 and 11 on Arm runners; not yet on a
  physical PC.
- 2026-10-14: The PC's own terminals (Windows Terminal tabs and classic
  consoles) are listed on the phone's Terminals page and Home, as a Mac's are.
- 2026-10-13: On a Windows PC, as on a Mac (passing on GitHub's Windows
  runner, not yet on a physical PC):
  - Reach's icon in the notification area: on or paused, messages from the
    phone waiting for their Claude app chat, and Pause or Resume.
  - Apps show their own icons and the agents their logos, drawn by Windows.
  - Word, RTF and OpenDocument files preview as text (Word 97-2003's .doc
    stays a download).
  - Voice memos become words on the PC, through Windows' own speech
    recognizer; the recording stays attached when it can't.
  - Reach's terminals open your own shell: Windows Terminal's default
    profile, else PowerShell 7, else Windows PowerShell.
  - Drives attached after Reach started appear in Files.
  - The Claude desktop app's chats, archive and links, whether it came from
    its installer or as a package (Microsoft Store, WinGet).
  - The phone names the launcher as the computer runs it (`reach`, `./reach`
    or `.\reach.cmd`).
- 2026-10-13: OpenClaw on a Windows PC, natively, as on a Mac: installed,
  set up with a model provider's key, given more keys and Telegram, Discord,
  Slack or WhatsApp from the phone, with its health, Doctor, updates and
  Node recovery. Install runs OpenClaw's own PowerShell installer in a Reach
  terminal. OpenClaw needs Node 24.16 or newer: on a PC with an older Node,
  the install sheet says so and Reach first adds a Node for OpenClaw only,
  with OpenClaw's own installer, keeping the PC's Node as it is. Keys go to
  OpenClaw only, never on a command line. Telegram's token file is closed to
  everyone but you, SYSTEM and Administrators. iMessage needs a Mac, and the
  phone says so on a PC. Not yet run on a physical Windows PC.
- 2026-10-14: Beside OpenClaw's own Windows app, Reach uses the Gateway the
  app keeps in WSL instead of setting OpenClaw up a second time: chats,
  keys, Telegram, Doctor and starting the Gateway, with OpenClaw's commands
  run inside the app's WSL distro and every secret on stdin. Discord and
  Slack go through OpenClaw's guided setup there, and repairs and updates
  stay with the app. Not yet run against the app on a physical PC.

- 2026-10-13: Hear the computer on your phone. A speaker in Screen's bar
  plays what the Mac or Windows PC plays, never its microphone, for you and
  people with full access (invited people with less access and agents never
  hear it). It has its own connection, so it never waits behind the picture.
  A Mac uses the Screen Recording permission the picture already has
  (ScreenCaptureKit, macOS 13 or newer); Windows needs none (a loopback of its
  default output). About 0.4 Mbps (IMA ADPCM, 48 kHz stereo), lighter on a
  slow link (24 kHz, then mono), and skipped rather than late. The phone
  plays it about a tenth of a second behind, asking iOS to treat it as media
  playback (Safari 17's audio session) so it should play with the ringer
  switch on silent; not yet tried on an iPhone. Off each time Screen opens; stopped by
  leaving Screen, Pause, or turning screen viewing off; not offered in a
  browser on the computer itself, where it would echo. Checked with a real
  capture on a Mac (macOS 26.6) and end to end in headless Chrome under
  Reach's own page policy; Safari on an iPhone and a real Windows PC are
  still to try.
- 2026-10-14: On a Windows PC, Reach tells when the Claude app is open, from
  the PC's process list (the app's own program, never Claude Code's
  claude.exe): a chat the open app lists isn't deleted under it, and chats
  started from the phone join its list once nobody is at the PC, through the
  import link the Mac's app takes (not yet tried with the Windows app). Unlike a
  Mac, the app's window isn't reloaded after Reach replies yet: it shows
  them once the app is opened again. A Claude Code record whose process id
  Windows has since given to another program no longer makes its chat read
  as held: Reach compares the start Claude Code noted with the PC's own. Not
  yet run on a physical PC.
- 2026-10-13: Windows keeps Reach running and reachable as a Mac does.
  `.\reach.cmd setup background` (or `install`) adds a task of yours that
  starts Reach when you sign in, in your session, with no window: the live
  screen and control work while you're signed in, new phones are approved
  with `approve`, and it starts again after a crash. While Reach runs, the PC
  stays awake in the Mac's three modes, and `status` says so. The old
  `npm run install-service` Startup entry, which started a Reach no phone
  could reach, is removed. Built, not yet run on a physical Windows PC.
- 2026-10-13: One Reach per Windows PC, as on a Mac. Reach reads the PC's
  process list, so a second one from any folder is refused with where the
  first runs; `status` shows whichever Reach runs with its routes and sleep
  prevention; `stop` asks first and stops every Reach; an agent's `restart`
  asks on your phone; restarts and phone updates open Reach in a window of
  its own titled Reach; `update` stops Reach before replacing its files. A
  first run sets up while it installs, as on a Mac. Built, not yet run on a
  physical Windows PC.
- 2026-10-14: A Windows PC's live screen is H.264 video with nothing to
  install, as a Mac's is, instead of still images at up to 20 a second.
  Reach's helper captures with Desktop Duplication (only what changed, the
  pointer drawn from its own shape; GDI where that isn't available) and
  encodes with Media Foundation's H.264 encoder, the graphics card's first,
  else Microsoft's own. As on a Mac it sends nothing while nothing moves,
  says "Windows PC locked" on the lock screen, starts a fresh picture when
  the phone asks, and names its colours (BT.709). Windows N and KN editions
  without the Media Feature Pack, and Windows Server without Media
  Foundation, have no H.264 encoder: there Reach uses FFmpeg's video if it's
  installed, else still images, and its log and the Screen page (Screen
  options → Connection → Video) say which and why. Installing either later
  needs no restart. Proven on GitHub's Windows runner (Microsoft's software
  encoder, through Desktop Duplication and through GDI, every frame decoded
  by Chrome's WebCodecs with its colours); not yet run on a physical PC,
  with a graphics card's encoder, several displays or Remote Desktop.

- 2026-10-13: Reach keeps what it drives in sync. When Codex's service runs
  behind the Codex CLI (0.158 against 0.162, so GPT-6.1 Sol stayed greyed
  out), Needs you, Settings → Updates and Codex's model list say "Update
  Codex's service to use … and newer models" with Update. One tap runs
  `codex app-server daemon update` with the Codex Reach uses, after saying
  which working Codex chats it may stop, then reconnects and reads the
  models again. Claude Code, Codex and OpenClaw updates show in the same
  list, once per version pair. Nothing updates without the owner's tap.
- 2026-10-13: Fork a chat from any message into another app ("Fork chat…" in
  a chat's menu, or from an earlier message). Claude forks natively, keeping
  compaction, thinking and complete tool records; Codex forks through the
  chosen completed turn; OpenClaw takes long tool output split, never
  clipped. Later messages stay out, and the source chat is never rewritten.
- 2026-10-13: The owner comes first on the screen. Input through Reach's screen from the
  owner (or a full-access person) holds every agent off it, its looks
  included (screenshots, describe, read, its live picture), with kind
  `paused`, who is using it and `retryInMs`; agents get it back 2 minutes
  after the last input through Reach, or at once from "Let them back" on the
  quiet "Agents wait · 2 min after you stop" pill. Chats' Claude app messages
  never wait on it. The agent's live picture shows a calm "The owner is using
  the Mac".
- 2026-10-13: Two fingers scroll the computer, up, down and sideways, in every touch mode
  (pinch still zooms), and the bar has a desktop switcher while controlling:
  previous desktop, all windows, next desktop.

### Changed

- 2026-10-14: Reaching Claude's usage limit shows one notice. "Usage is back"
  arrives at the limit's reset time even when Claude's sign-in lapsed, and
  continuing in the same chat waits for the current turn to end.
- 2026-10-14: A Mac installs OpenClaw with OpenClaw's own installer
  (install.sh), as a Windows PC uses install.ps1, so npm 12's script policy
  and Node are handled by OpenClaw. On a Mac or PC whose Node is older than
  24.16, the install sheet says so and Reach first adds a Node for OpenClaw
  only with OpenClaw's own installer, in the same words on both; the
  computer's own Node is never replaced. Updates that need a newer Node are
  recovered the same way on both. Setup no longer starts a second Gateway
  beside one already answering on OpenClaw's port, on a Mac too.
- 2026-10-13: Windows PCs sign phones in from the browser as Macs do, with
  nothing to turn on. `REACH_WINDOWS_ACCOUNT` is gone. Setup asks for your
  Tailscale account, as on a Mac, and a PC paired by code before asks once at
  its next start. Invite links for people and agents, the start page, the
  agent gateway, hosted MCP, Face ID sign-in for a new browser and linked
  computers (a Mac and a PC, or two PCs) come with it. A PC that can't hold
  the route yet uses a pairing code and says why in its terminal,
  `.\reach.cmd status`, `approve`, `link` and on the phone. That covers
  Tailscale older than 1.104 or without its network adapter, Reach's folders
  not private, or Tailscale's own connections not recognised. In the last
  case Reach starts again on pairing codes at once, and tries the route again
  a day later or after Tailscale changes. An older Tailscale no longer stops
  setup: the account is kept and used once Tailscale is updated. Phones that
  joined a PC with a pairing code ask to be approved once, as on a Mac. Not
  yet run on a physical Windows PC.
- 2026-10-13: A linked computer's ticket no longer approves a request made
  from the computer itself (a browser on it): only the code typed there
  does, on a Mac as on a Windows PC. A ticket vouches for a device, never for
  whoever is signed in to it.

- 2026-10-13: An invitation nobody ever joined clears itself a day after its
  chance to join ended: an unopened link a day after its join window (a
  person's, a day after their access ran out), an agent's request a day after
  it was declined or ran out. It goes the way removing it does, and the
  security record says "Unopened invitation for <name> cleared". Within the
  day, a new link starts a new window. Anything that joined, or that you
  approved, is never cleared this way. Same on Mac and Windows.
- 2026-10-12: Dependencies: Vite 8, xterm 6 (addon-fit 0.11), esbuild 0.28,
  jsdom 30, lucide-react 1.53, TypeScript 7 and the current GitHub Actions.
  A source checkout now builds on Node 22.12 or newer; `./reach` and
  `reach.cmd` fetch Reach's own Node below that. npm installs still run on any
  Node 22.

- 2026-10-13: OpenClaw's heartbeat: a skipped run is a quiet note in Reach's
  words ("Nothing to check: the heartbeat's task list is empty."), schedules
  OpenClaw owns say to change them in OpenClaw, and the heartbeat turns off
  and on from Reach when one setting (agents.defaults.heartbeat) decides it.

- 2026-10-13: Keys in the screen's menu are a grid of icon tiles, four across
  on a phone, instead of a row of pills that scrolled sideways. Each tile shows
  an icon and a word or two. The exact shortcut is the tile's name and tooltip.
  Eight everyday keys come first: previous and next tab, new tab, close tab,
  switch app, find, undo and Escape. **More** opens the rest in place. The
  "Other keys" list and its **Send key** button are gone. In their place,
  modifier chips (⌘ ⌥ ⌃ ⇧ on a Mac, Win Ctrl Alt Shift on Windows) are held
  with the next key tapped. That one tap sends the combination, and the chips
  then let go. Function keys, letters and digits are one more tap away. The
  commands for the app in front are tiles too, and Keys doesn't repeat one
  they already offer.

- 2026-10-12: Agents on the Mac take one turn per step. Every tool that acts
  (reach_act, press, fill, and opening an app, page, bank, file or window)
  answers with the screen as text once it has settled (about a second after
  an action, up to three after an open), so an agent doesn't look again;
  `describe: false` skips it. After the first look that text is only what
  changed (`+`, `~`, `-` lines; every control not listed keeps its number),
  or all of it with `full: true`; what that spares is counted in the savings
  ledger as `screen-diff`. Each agent's calls are timed, with no content: its
  Activity shows one quiet line per stretch of work, "Reach 0.4 s · agent
  28 s".

- 2026-10-12: An agent too old for Reach is skipped, not offered: Claude Code
  older than 2.1.259, Codex older than 0.148.0, and now OpenClaw older than
  2026.2.26 (its Gateway refuses the v3 device signature Reach joins with).
  New chat, moving a chat, relays, auto-continue and workflows leave it out.
  Where it would be, one line names the version to update to ("Update Claude
  Code to 2.1.259 or newer to use it here."), with **Update** when Reach can
  run that update: the one it already offers for a newer version, or
  OpenClaw's own. Its chats still list and open (a Codex's while its
  session service still starts). A message sent to one is
  refused with the same words, not "Update Reach". A Gateway found too old
  is tried again once a minute, or at once after an update or restart from
  Reach, not on every look.

### Fixed

- 2026-10-15: An agent or device can start at most 120 commands a minute;
  each command starts a process.
- 2026-10-14: On a slow Windows PC the app list no longer runs out of time on
  every retry: a list that finishes late is kept for the retry.
- 2026-10-14: One Codex chat whose history can't be paged no longer stops
  history for every Codex chat; a failed read shows its error, not
  "Opening…".
- 2026-10-13: Swiping back in a chat on the phone could show a blank page and reload Reach instead of going back to the chat list. The entry behind the chat belonged to the page from before a reload, such as an interface rebuild or the phone reloading Reach. Back is now one step of Reach's own stack, in the same page, in every browser. A chat goes back to its list, a page opened from More, Settings or a card goes back to where it was opened, and any tab goes back to Home. Switching tabs adds no step. A chat opened from a notification or link, or reopened after a reload, has its list under it. A rebuild reload first steps back to Home's entry, so no entry of the old page is left behind. A sideways swipe inside the page no longer turns into the browser's back or forward.
- 2026-10-13: Adding Face ID in Settings never worked. The page asked for a new challenge while Face ID was still up, so every answer was refused "for an earlier attempt". After ten tries the button stopped responding, with no message. Turning off "Face ID confirms approvals" failed the same way, and showed "Access expired or was revoked." Now every tap either opens Face ID or says why it can't. Each passkey you add shows a green check with "Added today". The setting uses your device's own name for it: Face ID, Touch ID, fingerprint or face unlock on Android, or Windows Hello. Reach's terminal shows "Reach: Face ID not added: <reason>" for each refused add.
- 2026-10-13: Fullscreen Screen covered the Mac's menu bar and Dock with Reach's own bars.
  They now take the room the picture leaves (a rail at the side on a phone
  turned sideways, rows above and below when upright), and hiding them never
  moves the picture.
- 2026-10-13: Taps that did nothing: every tap now reaches the computer or says why in
  one line, a tap made while control's connection blinks goes once it is back
  (within a second, never later), and click feedback is a small wave in Reach
  green, shown only for a click the computer did (none while only watching).
- 2026-10-13: The live screen on a phone hitched every 10–25 s at full size: the iPhone's
  video decoder kept failing on a 2868×1862 stream (and once at 2150×1396).
  The cause isn't established; as a mitigation, not yet checked on the
  iPhone, phones start at 1920 across, a step down keeps the last picture
  crisp, and the smaller size is remembered for the session. On Windows, a
  sideways scroll now goes the same way as on a Mac.

## [0.1.1] — 2026-10-12

The first release on npm: 0.1.0's publish step failed, so 0.1.0 is a source
tag only.

### Changed

- When the tailnet has HTTPS off, setup opens Tailscale's own page for this
  computer, where one press of **Enable** turns it on, instead of the DNS
  settings page.
- An agent whose Claude Code is older than 2.1.259, or whose Codex is older
  than 0.148.0, is named as too old, with the version to update to, instead of
  failing later. Older versions lack the permission and thread APIs Reach uses;
  each floor was found by running the releases one by one.

### Fixed

- A message typed on the phone while Claude Code 2.1.296 or newer was working
  vanished from the chat although Claude received it. Claude Code now records
  it as a queued prompt without the old marker; Reach shows it again.
- Release workflow: `npm publish` was given `candidate/<file>.tgz`, which npm
  reads as a GitHub repository, not a file. It publishes `./candidate/…` now,
  and a CI policy test refuses a bare path.
- CI: the published-CLI compatibility check tries twice, waits longer and
  quotes the CLI when it fails; the iOS simulator launch gets a third try;
  test fixtures no longer look like Tailscale keys to secret scanners.

## [0.1.0] — 2026-10-12

First public release candidate. Early access: see `docs/RELEASE.md` for the
real-device checks that are still open.

### Added

- Face ID confirms agent approvals, a switch in Settings → Agents for the
  owner's own devices once Face ID is set up on the computer. With it on,
  approving an agent's first connection on the phone asks for Face ID, and the
  computer refuses an approval that doesn't carry its answer; the answer is
  made for that one request, from that one phone, and used once. Denying
  never asks. Turning the switch off takes Face ID too, and the last passkey
  stays while it's on, so a phone in the wrong hands can't lift it with a
  tap. Guests, agents and Face ID-joined browsers can neither use it nor see
  the setting.
- Agent access presets. Inviting a browser agent (Muse, ChatGPT agent, Grok
  bots) is one choice among four presets, Full control, Apps, Files and Read
  only, instead of seven switches and per-action approvals. Scopes, routes,
  tools and the rules sent to the native checker all derive from the preset on
  every request (`server/agent-presets.mjs`); a stored credential cannot grow.
- Always access for a browser agent, next to the 15-minute to 24-hour
  durations: the agent keeps its access until the owner stops it and comes back
  from the same browser with no new invitation. The link still works once, so
  sharing it gives nobody else access. The public link stays up while an agent
  has Always access.
- Reopen link, in Settings → Agents: an agent that changed browsers opens its
  same link again (for 15 minutes, with the owner's code approval) instead of
  getting a new invitation; the browser it used is disconnected.
- One always-protected list that no preset changes: Reach and Tailscale,
  password stores and password fields, security prompts and `sudo`, privacy
  settings, Activity Monitor and Force Quit, developer tools, and a shell deny
  list (disk tools, shutdown, `csrutil`, `tccutil`, `launchctl`, `security`,
  scripted keystrokes, recursive deletes of home or system folders, Reach's own
  addresses, paths to secret files) (`server/agent-guard.mjs`).
- A native per-event checker (`scripts/native/agent-desktop.swift`, one helper
  per session) inspects the real target of every click, key and typed text
  before posting it, pauses while the owner uses the Mac, and leaves protected
  windows out of screenshots.
- Full control adds a shell that runs as the owner from inside a shared folder,
  with a 60 s and 256 KiB limit per command, a log, and the deny list
  (`server/agent-shell.mjs`). Files with editing writes through the sandboxed
  file helper.
- One Mac lease: one agent acts at a time; another agent's action is answered
  `409 busy` with a retry hint. Settings → Agents shows what each agent is
  using and lets the owner pause or stop it; the owner's own input pauses it.
- Preset invitations may last 24 hours over the public link when the server
  allows it (joining stays a 15-minute window; invitations from the earlier
  form keep their one-hour cap).
- The agent screen states why a screenshot was refused or failed and keeps
  refreshing, more slowly, in a hidden tab.
- A Claude Code session started from the phone is named from its first
  message the way the Claude app names its own: Claude Code proposes a title
  and it is written into the transcript, so the app lists the session by name
  instead of "General coding session". Without a proposal, the message's first
  line is the name.
- Release workflow (`.github/workflows/release.yml`): a `v<version>` tag builds,
  tests, packages and verifies once, publishes the verified tarball to npm with
  provenance, and creates the GitHub release with SHA-256 checksums and these
  notes. The tag must equal `v` plus the `package.json` version.
- Repository hygiene: `CODE_OF_CONDUCT.md`, Dependabot for npm, GitHub Actions
  and the Go module, `CODEOWNERS`, issue templates (blank issues off, security
  reports routed to `SECURITY.md`), `.nvmrc`.

### Changed

- Routes are Tailscale daemon state, in every mode on Mac and Linux (on
  Windows the private route lasts only while Reach runs). The private Serve route
  (port 8443) and the on-demand Funnel route (port 443) are background routes:
  a dropped command-line session, a sleep or a Reach restart no longer
  interrupts phones or agents, and an unchanged route is reused without a gap.
  A janitor process (`scripts/funnel-lease-worker.mjs`) holding a five-second
  lease switches the public route off if Reach dies; the private route stays
  while Reach is stopped and `./reach uninstall` removes it. Reach replaces its
  own recorded route when its target changed and never anybody else's. On a
  Mac with the Tailscale app, Reach uses the app's own command line (the one
  that matches the running daemon) and warns once when the command line and
  the daemon differ in version. `./reach status` shows both routes, and
  `tailscale.log` lines carry their time.
- The signed Funnel gateway (one endpoint, P-256 signed POST requests, nonce
  and clock-window replay protection) answers only while an invitation window
  is open; at other times public Funnel requests are refused. Preset agents'
  screen, input, shell and file routes pass through it; each invitation's own
  allowlist still decides.
- Invitations made with the earlier form keep working until they end.
- Notifications say the event and its context. Titles read "chat or agent ·
  event" (Reply needed, Approval needed, Finished, Access request, Connection
  request, Your turn); bodies carry the request itself ("Run npm test in
  project?", "Change 3 files: …?", the question asked), with commands kept
  verbatim and a marker for a multi-line one; the action button says what it
  opens (Reply, Review access, Open live screen, Review restart). Questions
  with a private or several answers get a safe summary, a browser agent's app
  request links to the Home page, the test notification explains what the
  device will receive, and the restart card shows who asked next to "Computer
  restart".
- CI: GitHub Actions pinned to commit SHAs, superseded runs cancelled,
  `npm audit` moved to a separate advisory job, the verified `.tgz` uploaded
  with the portable folder.

### Fixed

- Screen sharing with a browser agent dropped for seconds at a time. The
  foreground `tailscale serve` and `tailscale funnel` processes that carried
  the routes kept exiting (124 and 65 relaunches in one day's log, through a
  Homebrew command line one version apart from the daemon), and a single failed
  status read marked the private link unavailable. Routes are daemon state now,
  the private link needs two failed reads in a row before it is called
  interrupted, and the agent page retries one failed read.
- Stale browser sign-in builds no longer ship: `scripts/build-tailnet.mjs`
  removes `tailnet/dist` outputs the manifest does not list, and
  `npm run verify:package` fails if the tarball carries unlisted files or
  exceeds 30 MB (it prints the size).
- `esbuild` is declared as a devDependency; `scripts/build-agent.mjs` imports
  it directly.
- Third-party notices point to the shipped `server/openclaw-LICENSE.txt`.
- Windows CI: the protected-app tests use a Windows-shaped app path, the real
  terminal test waits for a slow ConPTY shell, and the notification and agent
  ask tests no longer depend on tight wall-clock sleeps.
