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

The positive-access review reproduced and repaired early transport timeouts, lost desktop-busy metadata, missing CLI argument schemas, desktop ownership expiring during native operations, Type + Enter continuing after refused typing, Unicode event chunks splitting surrogate pairs, and command-key paste into secure fields. Browser-only agents also gain pointer movement, drag controls, targeted scrolling and app search beyond the first 80 entries. Their regressions use HTTP/DOM fixtures and compiled native pure functions. They do not establish live Mail, native input, or external-network task completion.

Known limitations remain release gates for broad agent claims:

- Window-title heuristics can block ordinary Mail/Notes/browser content containing protected terms, such as “Reach out to Alice” or “replacement keychain.” Hostname substring checks can reject an unrelated URL that merely mentions the host in its path/query. IDE prose is checked like shell input, so documentation examples can be refused. Fixing these requires context-aware checks with both allowed-task and protected-target tests; removing the guards would not qualify the feature.
- Captures and multi-event input are not atomic with focus changes or owner actions. Test and document these interruption limits.
- A successful disposable browser exercise outside Reach qualifies the fixture only. The real invitation, native helper, visible task result, Mail preparation, and separate multi-agent admission must each be recorded before claiming real-host acceptance.

No audit can establish every possible third-party application state. Publish the exercised matrix and remaining limitations rather than an unqualified “everything tested.”
