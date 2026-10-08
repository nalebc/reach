# Agent access acceptance

Agent readiness requires successful tasks through the access the owner granted. A passing policy test, an app list, or an HTTP 200 alone does not prove that an agent can operate the Mac. Record the tested commit, host OS, browser, transport, preset, granted apps/folders, observed result and failure/recovery for each run. Never record invitation secrets or private screenshots in the repository.

## Permission matrix

| Operation | Full control | Apps | Files | Read only |
| --- | --- | --- | --- | --- |
| View screen / inspect front app | Allowed with protected/hidden windows excluded | Chosen apps only | Not offered | Allowed when shared |
| Open app; click, move, drag, scroll, type, keys | Allowed with protected/hidden targets excluded | Chosen apps only | Denied | Denied |
| List/search/read shared files | Allowed | Denied | Allowed in chosen folders | Allowed in chosen folders |
| Write/copy/remove files, create folders | Allowed through shared-file API | Denied | Only when editing granted | Denied |
| Read terminal output | Owner-chosen terminals | Denied | Denied | Owner-chosen terminals |
| Run shell command | Allowed, 60 seconds / 256 KiB | Denied | Denied | Denied |
| Create invitations, approve connections, manage other agents | Denied | Denied | Denied | Denied |

Full control's shell executes as the owner's OS account. It is not confined to the shared-file API's folder boundary. Deny-list checks are guardrails, not a sandbox. Only grant it to an agent trusted with that account. See [browser-agent tools](BROWSER_AGENT_TOOLS.md) and [security](../SECURITY.md).

## Task-based checks

Run each applicable task through the rendered agent workspace, browser tool bridge, direct credential CLI, invitation CLI and stdio MCP. Some grants and transports support different tools; use their actual discovery result and argument schemas rather than guessing a similarly named tool. Record unavailable combinations explicitly.

1. **Admission and discovery:** owner creates a short-lived invitation; agent joins; owner matches the code; agent discovers its exact preset, expiry, apps and folders. Wrong/replayed/expired invites and owner-only routes must fail. Stale tool references must stop after session end.
2. **Browser:** open the permitted browser by its returned app path, navigate to a synthetic local page, follow links, use Back/Forward, open and close a test tab, fill text/select/checkbox controls, submit a local form, open/close a dialog, scroll a nested region, drag a card, download a dummy file and select a synthetic file. Verify the resulting page and saved file, not just an input acknowledgement.
3. **Typing:** plain text, accents, non-Latin scripts, emoji across event boundaries, multiline text, selection/replacement, shortcuts and undo in disposable fields. A refused Type + Enter must not send Enter or discard the draft. A delayed response must not erase newer edits or duplicate typing.
4. **Apps and Mail:** launch and raise an allowed app, switch between prepared windows, edit a scratch document and reopen its saved content. Prepare a synthetic message or empty test-mail view before sharing Mail, then verify opening and navigation without sending mail or changing accounts. Repeat with an Apps invitation that includes those apps and one that excludes them.
5. **Files and commands:** allowed read/write/search/copy/remove operations on disposable files; denied sibling/private paths and symlinks; read-only rejection; output and exit status; a command longer than 35 seconds but below the 60-second limit; timeout and disconnect recovery without automatic mutation retries; command history and revocation while running.
6. **Several agents:** separate admitted sessions, concurrent screenshots, competing actions, slow app opening, busy metadata and successful retry after re-observing. No native input may overlap another outstanding input, including two calls from the same agent or a helper still exiting after revocation.
7. **Owner interruption:** physical owner input, phone control, per-agent pause/resume, expiry, revocation, changed permissions and host shutdown. Check that queued or retried input does not execute after pause. Already dispatched multi-event OS actions are not atomic; do not claim immediate cancellation of every event.
8. **Recovery:** missing Screen Recording/Accessibility, app launch failure, focus movement, protected window/field, hidden app, throttled screenshot, stale invitation and transport outage must explain what happened and preserve recoverable input. Do not report success without a new observation.

Use isolated synthetic fixtures for negative and destructive-path tests. Real-host tests require the normal owner approval and OS permissions. Never forge production admissions or substitute a different control API for the granted path.

## October 7 follow-up

The positive-access review reproduced and repaired early transport timeouts, lost desktop-busy metadata, missing CLI argument schemas, desktop ownership expiring during native operations, Type + Enter continuing after refused typing, Unicode event chunks splitting surrogate pairs, and command-key paste into secure fields. Browser-only agents also gain pointer movement, drag controls, targeted scrolling and app search beyond the first 80 entries. Their regressions use HTTP/DOM fixtures and compiled native pure functions. That automated evidence alone does not establish live Mail, native input, or external-network task completion. A later pass fixes ordinary HTTP(S) URL path/query mentions being mistaken for Reach addresses, with conservative handling of ambiguous input and shell substitutions. Mail title exceptions require the running process to match Apple’s signing requirement, bundle ID and canonical system path; failed identity checks keep the original refusal. These tests include an actual native rejection of a synthetic process impersonating Mail, but no positive live Mail navigation claim.

The completed chat-link and desktop-reconnect changes received a separate lifecycle review. Reconnect grace timers now belong to the exact control grant they were created for. A replacement input channel waits for the previous native process to exit, rechecks authorization afterward, and discards old queued actions. Agent control and legacy HTTP input remain blocked while that process is stopping. Chat replies and retries belong to their mounted session and credential; late replies cannot update a replacement chat or restart reads after leaving. Regression tests cover these boundaries with inert native processes and rendered React components, not live OS input.

## Real-host Full control run — partial acceptance

A 30-minute Full control invitation was created by the owner, joined normally, and approved after the owner matched its connection code. The permissioned macOS host returned a native 2560 × 1662 screenshot and opened Chrome and Safari. The test controller ran hidden to avoid taking focus from the target browser on the same Mac. The initial lab URL was opened through the granted Reach shell with `open -a Safari http://127.0.0.1:5214/`. All 11 page exercises then used Reach’s admitted native screen/input path only; no direct browser automation completed them. This run does not establish initial address-bar navigation.

The visible receipt at **4:02:39** reported **PASS, 11/11 checks**. Observed results included:

- Three native pointer clicks left the counter at 3. The saved form showed `Zoë García`, `Café déjà vu — 123`, Blue, and the checked confirmation.
- Details revealed `LANTERN-7`, then Summary was selected. The modal showed `MARIGOLD` and was closed through its confirmation control.
- A pointer drag reached the drop zone; the receipt recorded pointer movement, not keyboard placement. The nested log was scrolled to `ORBIT-42`.
- Safari’s native download list showed the 61-byte dummy file. A native file picker selected the 26-byte synthetic `sample.txt`; the fixture verified its content locally. This was not an upload to an external service.

Reach’s Full control shell also created a synthetic test file. The loaded host still refused a file-API read under the Home grant, confirming the admission/operation mismatch addressed by the candidate Home fix. One Type + Enter attempt returned a stopped-helper error: the draft remained available, and separate Type then Enter actions recovered. This records recovery; it does not establish that the stopped-helper failure has been repaired.

**Version boundary:** this run used loaded server source `c348cc6` with UI assets labeled `23c3r2`. The Home, guard/pointer and helper-diagnostic repairs described below were not part of the server loaded for this run. The preceding committed candidate `23c3b6f` passed 2,037 tests (2,030 passed, 0 failed, 7 skipped), its release build and package acceptance; those checks do not qualify later edits. Private receipt evidence is retained outside the repository.

The synthetic Mail message was downloaded and Mail opened, but an unrelated real-account Mail window was initially in front. Automatic approval review blocked further inspection until the owner isolated the synthetic message and replied “Ready” at **4:07**. Reach’s Check front then identified Mail and the Interaction Lab synthetic sample. The native image showed the local message’s `MARIGOLD` subject marker, `ORBIT-42` body marker, and `Zoë García — Café déjà vu` text. This verifies display of the owner-prepared synthetic message; it does not establish autonomous Mail preparation or a complete navigation task. No mail was sent and no account settings changed.

At **4:08**, the invitation reached its normal expiry while idle. The UI reported “Access ended. This browser’s credentials have been removed” and requested a new invitation. This was a read-only observation; no further native actions were attempted. It establishes the observed idle-expiry UI, not revocation or expiry during an in-flight operation.

This run establishes one real-host Full control browser task, display of an owner-prepared synthetic Mail message, and observed idle expiry. It does not establish a separate Apps grant, concurrent independently admitted Full/Apps agents, owner pause/takeover, revocation or expiry during active input, every entry point, or acceptance of the new native fixes. Re-run the relevant matrix after deployment; broader Mail navigation and external-network agent acceptance remain separate gates.

## Later Full control run on `c500772` — partial acceptance

A second owner-approved invitation exercised the qualified `c500772` host on October 7. The rendered agent page listed its allowed apps and exposed live screen, Home files, commands and Saved tools. Saved tools was initially empty. Through the grant, the agent created a disposable folder and file, saved accented Unicode text, and independently read back the exact text and SHA-256 through the granted shell. This qualifies that Home file create/edit/read path on the deployed repair. No personal message, account setting or security prompt was accessed.

Native app opening was only partly qualified: one immediate Check front observation confirmed Safari and the synthetic lab, but later screen and front observations showed Claude again. The cause of that specific transition was not established. Source inspection found an activating Claude refresh restoration and independent chat-switch routines without shared arbitration with desktop control. An acknowledged app-open request alone is not recorded as foreground success.

The run reproduced a Discard recording request rejection and a stale polling warning. The former came from an empty DELETE body rejected by the signed gateway; regression tests now cover the real signed gateway and saved-tool routes. Polling warnings are separated from action outcomes so recovered reads clear the appropriate warning. The app-open receipt now requests screen verification rather than asserting foreground state. A separate compiled native regression exposed input validation accepting mismatched foreground and Accessibility process identities; the repair refuses unknown or mismatched focus before keys or text are dispatched. These follow-up fixes require qualification and live acceptance; they were not loaded during this run.

The follow-up implementation coordinates Claude composition, imports, refresh, question/approval cards and native chat opening with desktop control. Recent authorized screen observations defer background automation for 30 seconds. A changed foreground or selected chat prevents a stale restoration; unknown idle state does not authorize switching. Phone takeover waits for outstanding native work to finish. Preparation-time refusals remain retryable, while acknowledged or uncertain mutations retain their receipts and are not automatically replayed. Inert local HTTP, provider, outbox and terminal regressions exercise these boundaries; they do not establish live foreground stability or make OS events atomic.

A host restart interrupted the unsaved disposable recording and one file attempt. The folder was re-read before retrying that file creation. A file-download attempt had no verified outcome and remains open. At normal invitation expiry, the page reported Access ended and credentials removed; no further granted actions followed. The synthetic file remains for inspection. The run does not qualify native typing, pointer tasks, Apps or multiple admitted agents on this version.

## Repairs following the live run

- **Home grants:** invitation admission and file operations now use the authorized preset consistently. Only Full control and Read only can include the exact Home folder; invalid default or explicit roots are refused before credentials are issued. Private-path checks and the native file boundary remain in force.
- **Command guard:** quoted environment assignments are parsed without mistaking words inside their values for a command. Protected literal paths and embedded command segments remain checked; these checks do not sandbox Full control’s shell.
- **Pointer identity:** pointer actions require an identified app from the checked native observations, and click results report that checked identity. A compositor-only result with no usable app identity is refused. Apps retains its stricter refusal when the topmost compositor has no bundle identity, even if Accessibility identifies a selected app; a live Apps pointer task is still required.
- **Helper diagnostics:** failures now carry a fixed reason, operation and dispatch-state tuple. A write attempt yields `completion_unknown`; queued requests that were never written report `not_dispatched`. Raw native stderr, request payloads and arbitrary exit details are excluded from these diagnostics. Actions are not automatically retried: observe the screen before deciding whether to submit again.

Focused boundary/route, command-guard, compiled inert native-policy, helper-protocol, transport and browser-tool regressions cover these repairs. The cause of the live Type + Enter helper stop remains unknown; improved diagnostics are not evidence that its underlying cause was fixed. These checks do not extend the historical live run to the repaired implementation or establish final release qualification.

Known limitations remain release gates for broad agent claims:

- Window-title heuristics remain conservative outside verified system Mail; ordinary Notes/browser titles containing protected terms can still be blocked. Browser developer-tool titles need stronger window evidence before relaxation. IDE prose is checked like shell input, so documentation examples can be refused.
- The URL improvement is deliberately limited to unambiguous explicit HTTP(S) URLs. Malformed/bare inputs, userinfo and lookalike suffixes retain conservative matching. Noncanonical IP aliases and default-port equivalence are not fully normalized; these guardrails must not be described as complete origin isolation.
- Captures and multi-event input are not atomic with focus changes or owner actions. Test and document these interruption limits.
- The earlier direct browser exercise qualified the fixture only. The subsequent admitted Full control run above establishes native browser input and a visible result, with owner-assisted synthetic Mail display and idle expiry observed separately. Autonomous Mail preparation/navigation, separate Apps/multi-agent admission, and interruption tests remain open.

No audit can establish every possible third-party application state. Publish the exercised matrix and remaining limitations rather than an unqualified “everything tested.”
