# Local source reconciliation — October 7, 2026

The owner updated the release cutoff: main should include the reconciled Files, connector and restart changes. The earlier audited tree remains on `codex/audited-release-2026-10-07`; the Files feature checkpoint remains in history and on `codex/ongoing-files-2026-10-07`.

## Scope and preservation

- Inventoried 11 local Git repositories/worktrees and 43 complete source copies, including ignored audit candidates and older saved working copies. Rechecked the earlier 68-workset preservation ledger and its recorded intentional removals and replacements.
- Captured both dirty source roots before integration, including untracked source files. Retained the connector stash and all original checkouts. A new verified private Git bundle preserves all local refs; four earlier bundle/archive checksums also matched. Runtime state, credentials, dependencies and generated outputs are not source changes to publish.
- Old branch source trees match trees retained in main's history, or belong to the preserved pre-authorship history. Replaying that older history would reintroduce superseded implementations. The newer Files backup was rebased onto reconciled main; all 10 connector files were first integrated byte-for-byte from their branch before applying the reviewed fixes below.
- The old host checkout's only extra Files CSS difference was its lack of the newer Send-to-agent error style. Main retains that error style. The connector branch's Files differences were formatting and an obsolete test comment.
- No current source files were discarded. This is not an assertion that every transient historical version is recoverable: the previous audit recorded nine manifest hashes without recoverable file bodies, and those provenance gaps remain. They are listed in the retained local preservation ledger.

## Resulting behavior

- Files has readable phone-sized Markdown, safe GFM rendering, source mode, syntax-highlighted code with line numbers and wrapping, visible Select, filtered selection, and bulk archive extraction. The existing owner-only operation gates, bounded previews and PDF renderer are preserved.
- Agent connector management is integrated. CLI/provider errors avoid credential disclosure, including existing credentials echoed by list/remove or OAuth failures; failed Claude replacements restore the saved user connector; login cancellation and shutdown dispose resources and cannot resurrect a delayed login or dispatch a CLI mutation after discovery. Name-only Codex login notifications require the current flow's callback and confirmed server authentication. Writes recheck authorization before later effects. GitHub CLI token reuse is restricted to the GitHub connector address. Unsupported Windows CLI connector operations are rejected explicitly.
- A foreground restart from another checkout transfers only the stopped Reach instance's exactly verified private route ownership. Launch then replaces its target while retaining the phone URL. Changed routes, other services, public Funnel and cancelled restarts do not gain ownership.
- Explicit `REACH_HOME` and `REACH_DATA` settings survive Terminal and service launch. A new custom state destination also checks the previous checkout's default route record, independently of the caller's state override. An installed background service continues restarting from its installed checkout.
- A restored Home Screen page compares its loaded hashed assets with freshly served HTML instead of assuming its first presence packet describes its loaded build. Inconclusive checks retry on later presence; updates still wait for typing or active streams to finish.
- Subsequent interface checks also run on opening, foreground/page restoration, reconnection and every minute while visible, independently of presence and its origin. Lazy workspace styles do not cause repeated reloads. Updates use the same origin and Home Screen icon, with a fresh navigation URL; Settings shows current/offline/waiting status and a manual check. An already-loaded page predating this mechanism needs one fresh load to acquire it.
- A temporary Claude CLI probe failure now reports a retryable connection-check failure instead of claiming Reach is incompatible. Checked stream failures retain the specific unsupported feature. Installed CLI contract checks remain separate from signed-in desktop or model-turn acceptance.
- App-list API tests use the supplied platform fixture and require the exact invited app, fixing the hosted Windows test's accidental use of real PowerShell discovery.

## Verification boundary

Production builds, the complete Node 22 test suite with native policy/file-boundary/script-sandbox opt-ins, and focused security/lifecycle regressions are run on the reconciled source. Phone-sized Files visuals are inspected using the real components and synthetic files; served production asset bytes are checked against the build.

These checks do not prove that a specific physical phone has refreshed, nor replace physical-device acceptance, permissioned desktop control or independent penetration testing. The original release evidence and remaining gates are in [OPEN_SOURCE_READINESS.md](OPEN_SOURCE_READINESS.md).

## Agent-access integration follow-up

The isolated agent audit was rebased onto completed Safari sizing source `a4074bf`, then onto the newly committed screen-reliability source `76f89e0`. Neither was overwritten. Independent review of the latter covered identity-cache refresh/revocation, client recovery and the native frame-drop contract; one client status defect was repaired before combined qualification at `60a98c1` (1,990 passed, zero failures, seven skips).

Before integration, fresh private snapshots preserved the newer four-file chat-rendering work in the main checkout and eleven changed connector-worktree files, with hashes, modes, index/diffs and verified complete bundles containing 41 refs. The connector branch and later work remain outside this audited cutoff, per the owner's instruction to preserve ongoing changes separately. Active writers can make newer changes after a snapshot; no snapshot is described as preserving future edits. Existing historical preservation and its nine unresolved older manifest-body gaps remain unchanged.

The supported `reach cli` command now links the global launcher to the current working checkout instead of the old checkout. The old checkout remains intact. No host restart was performed by this agent-access integration; loading new server modules requires the normal owner-approved restart.

The completed chat-link and desktop-reconnect branches were subsequently merged with the preserved audit history at `ccc01d7`. Product source `b8ebf36` adds the reviewed lifecycle fixes and passes 2,018 tests with zero failures and seven skips, plus the complete release build. This is the fixed release cutoff; later connector/provider changes are retained separately. A fresh private snapshot captured the connector branch at `38199e5` with its three remaining dirty source files and a verified complete 41-ref bundle. The source and refs stayed unchanged during that capture. Original checkouts, earlier bundles and the previously qualified `7da8cc3` artifact remain available.

After the owner authorized a real-host restart, a hidden-checkout delivery bug was found and fixed at `3e950eb`, with the complete 2,036-test suite (2,029 passed, zero failed, seven skipped). Concurrent work independently advanced local main and the connector branch to `4e13bd9`; those changes remain outside this fixed qualification cutoff. A fresh private snapshot retained that commit, four active main edits and a verified complete 44-ref bundle. The running qualified checkout uses the existing host state, preserving settings and pairings.

## Final chat and invitation reconciliation

The completed source was captured as `5762a95` (27 changed paths) and `bb8c24f` (five subsequent queue-control paths), with verified complete Git bundles and byte-for-byte working-file manifests before integration. The combined audit retains both histories and adds reviewed fixes instead of discarding either version. The old Files history has an already-integrated publication-safe counterpart; the original branch and private history backup remain retained. The nine historical missing manifest bodies recorded above remain unresolved.

The working checkout subsequently received a new shared-connector/OAuth implementation and an active saved-agent-shortcuts feature. These are a later cutoff: private snapshots preserve their current source, and the original checkout remains available for ongoing work. Loading the audited candidate uses the same explicit Reach home/data paths, preserving the owner's existing settings and phone pairing. New code written after a snapshot is not claimed to be part of that snapshot or of the tested candidate.

The completed follow-up `2e567f3` removed connector management. That commit is included by merge, preserving the earlier implementation and audit fixes in history. The connector-specific security test was retired with its deleted implementation; unrelated chat, file, invitation and agent tests remain. The final README and demo follow the resulting interface. Active shortcut and Claude queue edits remain a later, separately preserved cutoff.

The completed remote Claude draft-recovery change `5aca947` and its merge `460369c` are also retained. Integration review keeps the bounded set of confirmed and unconfirmed owned drafts, and increases the bounded native JSON input limit to accommodate valid aggregate Unicode drafts without dropping ownership candidates. Uncertain sends are not retried automatically. The latest separately preserved development snapshot contains 38 dirty paths and a verified complete bundle of 51 refs; the original development checkout remains untouched.

A phone-confirmed agent restart restarts the running checkout. It does not select the checkout that submitted the request. Switching to the audited checkout requires an owner-run Terminal restart from that checkout with the existing explicit home/data settings. A successful source merge or page HTTP response alone is not proof that the audited server modules are loaded.

## Expanded agent-tools cutoff

The owner subsequently requested testing and inclusion of the newly added agent tools. A stable 40-path source snapshot was preserved as `ec37642`, based on local main `2e567f3`, without changing that active checkout or its index. The integrated work includes saved agent tasks, their browser/MCP/CLI discovery, owner controls, a native context guard, Codex owner/follower synchronization and Gemini history notifications. The earlier audited question, queue, effort and fixture-isolation changes are retained through a three-way merge rather than replacing their files with the older development versions.

The pre-feature checkpoint `49342ef` passed 2,186 tests (2,179 passed, zero failed, seven skipped) and its release build. That result is an explicit baseline, not qualification of the expanded feature cutoff. The final expanded source, artifact and live acceptance require their own recorded results. Original source, the snapshot commit and the historical backups remain available.

## OpenClaw follow-up

A subsequent stable snapshot preserved 50 changed paths from the shared checkout. Forty retained the exact previously captured saved-tools/provider bytes; ten added the OpenClaw controls, app-switching/header changes, sample demo data and tests. Source commit `bbdf694` preserves that complete snapshot as a child of `ec37642`, and its three-way merge retains the audited queue/move demo fixtures alongside the new schedule examples. Original shared files and the index were not changed by capture or integration.

The saved-tools/provider checkpoint was separately qualified and pushed as `0716cc3` (2,237 passed, zero failures, seven skips; clean package acceptance). The OpenClaw additions receive their own security/lifecycle review and combined qualification; the earlier count does not qualify them. Later edits made after the snapshot require their own accounting. The nine historical missing intermediate file bodies remain an explicit limitation.

The OpenClaw merge at `2bbd69c` passed 2,280 tests (2,273 passed, zero failed, seven skipped), a release build and the 915-file release privacy guard. Its parent `bbdf694` preserves the exact 50-path source cutoff. Later shared-checkout additions remain in their original checkout and a separate verified 103-path snapshot; they are not silently substituted into the tested tree. The subsequent qualification-record commit changes only documentation.
