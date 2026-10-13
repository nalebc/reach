# Mac control speed audit

October 13, 2026. Reach can already execute several actions per call and return accessibility text with the result. The largest remaining opportunities are to avoid unnecessary observations, target browser documents and app controls directly, and reduce the number of decisions the agent must make between calls.

This covers Reach's public agent catalogs, desktop helper, browser interpreter, hidden app control, transports, files, shell, shortcuts, services, coordination and timing records. It is a source audit with regression tests and transport benchmarks. The measurements below do not include model inference or navigation through real websites during this audit. The complete representative tool inventory and measured results are in [the evidence file](benchmarks/mac-control-audit-2026-10-13.json).

## Current control surfaces

| Surface | Available capabilities | Performance characteristics |
| --- | --- | --- |
| Desktop presets | App and window discovery, focus, URLs, files, menus, multiple displays, screenshots, accessibility text, find, page reading, clicks, stable refs, typing, forms, scrolling, dragging, holds and condition waits | Persistent native helper. Up to ten actions per call. Default final observation is text, with changes where useful. |
| Browser workflows | Nine built-in Gmail and Walmart workflows, user-defined declarative tools, result handles, downloads, attachments and execution receipts | Persistent Chrome/Safari Apple Events worker. Chrome batches load up to ten tabs concurrently, then execute item steps serially. |
| Recorded tasks | Record, save, discover and replay app actions | Reduces agent turns, but replay still uses desktop actions and its descriptions request a separate screenshot afterward. |
| Mac Shortcuts | Discover and run allowed installed Shortcuts; Full control can run all | Useful for completing an app task in one call. |
| Hidden app control | Open an agent-owned app, see it, act, hand it to a person, wait and close | Separate `apps:drive` contract. Single clicks, typing and keys can run directly in the app. Other operations may wait for 15 seconds of owner inactivity. |
| Files and shell | List, search, read and change files; Full control shell; scoped command jobs and terminal reads | Prefer these for file and command tasks. Full control shell has a 60-second limit and a 256 KiB output limit. |
| Services | Discover and request read access to Gmail and Walmart tools | Current connectors wrap the browser workflows; they are not independent provider APIs. |
| Transports | Browser bridge, stdio MCP, hosted HTTP MCP and CLI | Persistent MCP supports one host request per tool call after discovery. The process-per-call CLI does additional discovery and planning. |

Access determines the advertised catalog. The representative Full control catalog with built-in browser tools contains 50 tools; saved tasks and service grants can change that count. Scoped credentials and older invitations have different contracts. See [the catalog](../server/browser-tools.mjs), [MCP adapter](../scripts/mcp-server.mjs), [hidden apps](../server/agent-apps.mjs) and [service connectors](../server/service-connectors.mjs).

## Fixes made during the audit

1. **A loading screen could remain stale until the deadline.** The settling loop trusted missing accessibility notifications and could also return an older read after later notifications. It now periodically refreshes a loading screen and refreshes an invalidated observation at the deadline. A read that itself crosses the deadline is not duplicated. The missed-notification fixture now returns `Ready` at 900 ms instead of spending the 3000 ms budget returning `Loading`.
2. **Large screen text was silently truncated and then treated as fully seen.** The formatter clipped at 30,000 characters before observation code measured its length. The next response could say “Nothing changed” even though the agent had never received many controls. Observation code now measures the complete text, marks truncation, suggests narrowing the query and prevents that partial text from becoming the baseline for automatic changes. `reach_find` uses the same path.
3. **Agent guidance now explains when to omit observation.** It recommends batching, stable refs, relevant text and `describe: false` when only an action receipt is needed. The existing default remains compatible.

Sources: [observation logic](../server/desktop-observation.mjs), [screen formatting](../server/agent-desktop.mjs), [routes](../server/browser-access.mjs), [agent guidance](../server/browser-tools.mjs). Regression coverage: [speed tests](../test/agent-speed.test.mjs) and [observation tests](../test/desktop-observation.test.mjs).

## Highest priority remaining work

| Priority | Finding and consequence | Next change |
| --- | --- | --- |
| High | **Small responses still require a whole accessibility scan.** `query`, `within`, `maxChars` and automatic changes filter an already-read screen. Native traversal has a nominal 800 ms budget, up to 6000 visited nodes and 250 returned controls. An omitted target can require additional looks. | Push scope and target selection into the native reader; return a focused region, field or condition result. Keep a whole-window fallback. |
| High | **Numbered clicks rescan the window.** `snapshot` plus `n` calls `readScreen` again before clicking. Stable refs verify the live element, window, role, label, context and enabled state directly. | Make stable refs the primary examples throughout the catalog and text responses. Retain numbered targeting as a fallback. |
| High | **Observation still uses general settling heuristics.** The default quiet window is 300 ms; app/page opens use an 800 ms minimum unless a change is detected, with budgets of 1 or 3 seconds. Loading is inferred from an English button name beginning with “Stop”. This can delay unrelated screens or miss readiness. | Add explicit result policies: receipt, expected condition, focused changes, full text, image. Prefer a known condition and expose whether the settling budget expired. |
| High | **General browser navigation lacks a public document-scoped DOM interface.** The DOM interpreter is available through saved declarative workflows. An unfamiliar page often sends the agent back through foreground AX controls and screenshots. Browser workflows support Chrome and Safari; batches support Chrome only. | Expose bounded tab/document discovery, semantic reads and actions with live document identity, frame targeting and existing access checks. Reuse the persistent worker and workflow receipts. |
| High | **The hidden-app contract is slower and different.** `reach_app_action` performs a POST, waits a fixed 400 ms, then makes another request for an image unless `see:false`. It lacks the preset interface's text observation and action batching. | Give hidden app sessions action batches and optional text/condition observations in one server response. Preserve direct app input and owner priority. |
| Medium | **Default catalogs are large.** Current representative MCP schemas serialize to 71,879 bytes; compact mode is 24,917 bytes across 12 tools, about 65% smaller. Compact mode is opt-in and some ordinary operations require discovery first. | Use compact mode for compatible clients, measure discovery overhead, and avoid repeating large action schemas. These byte counts are not model token counts or proof of inference savings. |
| Medium | **Some transport paths repeatedly pay startup costs.** Local fixture medians are 67.063 ms for CLI calls and 1.452 ms for warm MCP. Separately, `TunnelAgent` sets `keepAlive:false`; the isolated proxy spawns `tailscale nc` for each new CONNECT. | Prefer persistent MCP for repeated actions. Add a one-request CLI dispatch path and evaluate connection pooling for the scoped proxy, retaining per-request authorization. |
| Medium | **Text entry has predictable fixed costs.** Native typing pauses 3 ms per character chunk: roughly 6 seconds of sleeps for 2000 ordinary characters, plus checks. Form fill adds 150 ms per field. Paste has approximately 306 ms of explicit sleeps, but only restores clipboard text. | Use verified field-value assignment where supported and focus readiness instead of a fixed sleep. Preserve all clipboard formats before expanding paste use; keep secret handling intact. |
| Medium | **Cold helper preparation is on the first action path.** Source builds compile the desktop helper on demand. An existing October 11 toy-app benchmark measured 13.081 seconds for the first observation including compilation. | Prebuild or warm the helper off the first-action path, with clear readiness and permission status. That older measurement is not a current cold-start guarantee. |
| Medium | **Desktop batches do not retain one ownership transaction across their waits.** Individual actions take a 2.5-second lease; a longer condition wait can outlast it. Another agent can then acquire the Mac before a later dependent action. | Add interruptible batch ownership and expected window/field checks between dependent steps. Do not simply shorten leases or remove owner protections. This is a code-path risk, not a reproduced live collision. |
| Medium | **Newer helper failures lose structured diagnostics.** The transport allows diagnostics for only the older operation names. A timeout during `elements` loses the reason, operation and dispatch tuple. `setup_required` is also absent from its allowed kinds. | Share one operation/kind contract between producer and transport so recovery uses explicit causes rather than message parsing. |
| Medium | **Timing is too coarse to rank real task bottlenecks.** Current records separate host response time from the gap before the agent's next call, but not queue, native action, settling, tree traversal and serialization. A partial batch failure can also be an HTTP 200. | Add phase timings, semantic outcome, response size and task completion/retry counts. Benchmark realistic browser and native-app tasks with a model in the loop. |

Evidence: [native read and input paths](../scripts/native/agent-desktop.swift), [desktop ownership](../server/agent-desktop.mjs), [batch routes](../server/browser-access.mjs), [browser workflows](../server/agent-tools.mjs), [browser protocol](../server/tool-protocol.mjs), [MCP image path](../scripts/mcp-server.mjs), [CLI](../scripts/agent-remote.mjs), [proxy client](../scripts/agent-client.mjs), [proxy process](../scripts/agent-network.mjs), [helper build](../server/desktop-native.mjs), [error transport](../server/agent-transport.mjs), [timings](../server/agent-timings.mjs), [earlier native benchmark](benchmarks/native-agent-live-2026-10-11.json).

## Optimal observation behavior

Return the smallest trustworthy result that lets the agent decide its next action. The normal preset response is accessibility text. A screenshot is requested explicitly; the older hidden-app interface is the exception above.

| Task state | Best available response |
| --- | --- |
| Several predictable actions are ready | Batch them in `reach_act`; observe once after the last action. |
| The next decision depends on changed UI | Return changed text or `observe: {query, within, maxChars}`. |
| Success has a known visible condition | Add `waitFor` to the action; narrow the returned observation to the relevant area. |
| No new screen information is needed | Use `describe:false` without an explicit observation or wait. An input receipt alone does not prove the application completed the task. |
| The task depends on visual layout or canvas content | Use `reach_screenshot`; choose sufficient resolution for the target. |
| A direct tool or saved workflow can complete the task | Use it and inspect its structured result. |

Change-only text saves output and model context; it currently does **not** avoid the native tree scan. A genuinely cheap condition-only result needs native target lookup and a result policy that can omit screen serialization. Those are the recommended next implementation steps, alongside the general browser document interface.

## Validation and rollout

The initial focused run passed 85 checks. After adding the deadline test, the final run of the two observation files passed all 22 checks. The separate transport benchmark passed. Tests use the npm runaway guard and inert desktop fixtures. A first sandboxed integration run was blocked by local listener permissions; the authorized rerun passed.

The native worker benchmark used an invalid browser name and never opened or scripted an app. It measured 145.63 ms median for a new process versus 0.36 ms for an already-running worker; this isolates dispatch overhead and does not measure browser work. Existing workers already provide that optimization. Host load was not controlled.

No production timing file was present in either checked Reach state directory. No real website task, native app mutation or model-driven timing trial was performed. Therefore no overall task speedup is claimed.

At the initial status check, Reach reported the main Terminal instance and another background instance from an install-test directory. No instance was stopped or restarted. Server changes need a restart to affect existing sessions; follow the repository's active-session restart procedure.
