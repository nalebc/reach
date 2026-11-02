# Outcomes on workflows

Status: guarded coordinator, phone UI and synthetic fixture journey are implemented. The trusted production runner and full evidence browser are still integration work, so production outcome execution remains fail-closed and this does not certify a live-agent demonstration.

### Implemented coordinator and current boundary

Owner contracts, original-turn provider receipts, acceptance policy and the optional one-cycle repair coordinator are implemented in `server/agent-sessions/outcomes.mjs`, `outcome-policy.mjs`, `outcome-coordinator.mjs` and the existing workflow scheduler. Ordinary workflows retain their controls. Attached outcomes cannot bypass policy through ordinary Run, Resume, Retry, Skip or Mark done.

The first executable shape deliberately accepts **one local builder task**. Read-only preparation resolves pinned profiles and distinct build/inspection workspaces, persists their definitions and the full branch plan, and returns it for owner review. The sheet shows the builder, independent checker, separate reviewer, conditional repair/review, allowed paths, deadline, and build/check/review ceilings. Run requires that exact saved contract, workflow plan and preparation digest. Another currently authorized owner device may approve the same prepared plan; execution then remains bound to the device that ran it, with no transfer of its authorization during recovery. It then materializes two tasks, or four with repair approved, in the existing 20-task/three-active-task scheduler. Uncertain agent dispatches continue to occupy concurrency and their execution folder. That folder arbitration remains a workflow rule, **not a global lock across chats, teams, native apps or external writers**.

A trusted **server runner adapter** is required. It must provide `prepare`, `baseline`, `capture`, `check`, `verify`, `stop` and `stopTask`. No production adapter is installed by default: preparation/Run return `503` and cannot dispatch until an enforceable candidate/check runner is configured. The owner UI checks this capability before offering draft creation, profile editing, Prepare or Run; unavailable setup is explained before any project work starts. Existing result inspection remains available. Profile provisioning and a profile picker are not implemented; an integration must supply trusted profile IDs and definition digests rather than asking owners to invent a hash. The coordinator tests inject synthetic adapters; their positive isolation flags are test data, not demonstrated host isolation. Never connect provider transcripts or an HTTP submission body as this adapter.

Adapter obligations for the next implementation task:

- `prepare` is read-only discovery. Return `profiles` with IDs, pinned definition digests, and definitions `{ executable, args, cwd, environment, outputBytes }`, plus distinct validated `buildCwd`, `reviewCwd` and an honest isolation description. Definitions are hashed and presented before Run. Provisioning that executes commands requires its own prior authorization; do not hide it in discovery.
- Baseline and check calls receive a durable `executionId`, cycle, approved contract/preparation, and deadline. Return explicit independent runner receipts with check/profile/candidate bindings, actual exit code, complete bounded log digest and known side-effect disposition. Baseline consumes the same total check budget. Exceptions, missing exits, incomplete output and lost responses hold; they never retry or select repair.
- Capture returns a sealed candidate and manifest digest, artifact kinds, and verified scope, isolation, history and side-effect facts. These facts must be established by the adapter using immutable artifacts and enforceable workspace separation. Folder exclusion and a second model are insufficient. `verify` must revalidate the candidate and all required evidence, including persisted logs/artifacts. It runs before selecting repair and before committing acceptance.
- `stop` targets the exact runner execution ID. `stopTask` receives the exact owned task intent, chat and turn boundary; it must refuse to interrupt later owner work. `{ stopped: true, confirmed: true }` means confirmed termination, not merely a signal sent. Unacknowledged stops become uncertain after a bounded wait. No replacement work follows an unknown stop. Unknown verification work retains the single verification queue slot.

The coordinator persists reservations and counters before dispatch. A baseline with no seeded failure holds before the builder starts. Display/storage clipping in provider transcripts remains visible but does not alone block a candidate established by complete independent checks; incomplete original-turn provenance and unknown required evidence still hold. Review messages may contain prose or fenced JSON around the final report, but the report still passes strict schema and binding checks. A supported explicit failed check can select the one approved repair; review findings currently hold for owner inspection. Repair creates a new Build chat, capture, all approved checks and independent review. Missing evidence, unknown side effects, deadline/attempt exhaustion, access loss, storage failure and uncertain dispatch hold. Startup never replays automation. Independent deadline/access sweeps can interrupt a task/check while the scheduler is awaiting a response. Late callbacks cannot revive cancellation or replace its result. Completed evidence remains inspectable after the automation deadline; acceptance does not dispatch any work.

Implemented routes below are private owner-only. `GET /api/sessions/workflows/outcome-capabilities` reports `executionAvailable` and an unavailable reason; `GET /outcome` also includes these `capabilities`. Remaining paths are relative to `/api/sessions/workflows/:id`:

- `GET /outcome`: durable versions, exact tuple, contract, displayed branch plan/preparation, counts, deadline, separate completion/check/review/acceptance facts and unresolved evidence.
- `POST /outcome`: `{ requestId, expectedVersion, contract }`, draft-only. Creation uses version `0`; edits invalidate preparation. Unknown fields and unpinned definitions fail. Contract records include the authenticated owner actor. Running contracts use Request changes to obtain a new draft.
- `POST /outcome/prepare`: `{ requestId, expectedVersion, contractRevision, contractDigest, planDigest }`. Resolve and persist a reviewable preparation without executing project work.
- `POST /outcome/run`: the preparation request tuple plus `preparedDigest`. Persist Run intent before baseline or task dispatch. Equal request IDs return the historical receipt and current state without replay.
- `POST /outcome/accept`: exact contract/result/evidence tuple, request/version and `acknowledgedLimitationIds: []`. Recheck current owner access and artifact integrity; commit only against the unchanged version. Persist the actor, timestamp and accepted tuple. Acceptance never implies merge, patch application, push, deployment, messaging or another external action.
- `POST /outcome/request-changes`: exact tuple, request/version and optional bounded `note`. Preserve the decision/evidence and create one fresh unapproved draft with the requested text and repair approval cleared. Its durable `draftId` reconciles a lost response or a two-store crash. Repeating the same request returns the same draft, unless the owner explicitly deleted it; that case returns `draftRemoved: true` and never recreates it. Operation lookup preserves the same deletion marker for lost-response recovery. Stale/new or changed-body requests fail with `409`.
- `POST /outcome/observations`: exact tuple, request/version, manual `criterionId`, boolean `passed` and bounded `note`. Record owner testimony; it cannot satisfy an automated check or clear unknown execution.
- `POST /outcome/cancel`: `{ requestId, expectedVersion }`. Persist cancellation before interruption; available during Reach pause. Ordinary workflow Stop also reaches the coordinator after task completion. Return confirmed cancellation or actual uncertainty. Retry stop uses a fresh request ID after the previous stop request is known, targeting only the same outstanding operation. Accepted outcomes refuse cancellation.
- `GET /outcome/operations/:requestId`: historical operation and current version, or `unknown`. An unknown operation is not permission to replay with a fresh ID.
- `GET /tasks/:task/result?attempt=N`: bounded frozen provider receipt plus explicit `source: "provider_reported"`. Transcripts are builder/provider reports, not independent execution evidence. Provider claims/commands cannot supply policy, check verdicts, approvals or broader authorization.

Ledger files retain up to 100 contract revisions, 40 provider receipts, 200 operations and 4 MiB, with 50 active attachments. Missing/corrupt/future data fails closed, `507` blocks unsaved work, and limits refuse new work rather than evicting history. Validated ledgers are cached by file identity/size/change timestamps for polling; changed files are revalidated. A draft creation marker permits retry of the first failed ledger write without resetting a previously established missing ledger. Explicit owner deletion archives an unexecuted draft outside the active quota. For a settled outcome it deletes the ledger and its retained evidence, leaving only a minimal tombstone (workflow/outcome IDs, version/time, operation IDs and body hashes) to prevent replay. Active or uncertain work with an unresolved operation cannot be deleted. A repeated request cannot recreate deleted work. Run/evidence/decision history otherwise remains pinned until explicit owner deletion. Cancellation after acceptance is refused. Run again produces a fresh draft and clears repair preapproval.

Trust-review fixes also preserve ordinary long-turn handoffs independently of evidence pagination, include Claude queued user entries in their original turn, require explicit adapter oldest-page metadata and a Codex dispatch turn pin for complete provenance, hold rather than attribute a later owner turn to the original task, retain early commands before later padding, and flag legacy history incomplete. These are bounded provenance checks, not protection against a builder that can modify its own transcript. Separate immutable runner evidence and real-provider trials remain required.

Focused guarded npm tests cover synthetic execution, repair, exact decisions, persistence/restart, cancellation, revocation, concurrency and lost responses; actual HTTP tests exercise authentication with mocked providers and rendered React tests exercise the pre-Run plan. The new shared tests are in Windows CI. Actual Windows execution/ACLs, live Codex/Claude transcript and dispatch validation, browser-enforced connection boundaries and physical phones remain unperformed. The default production adapter, sealed blob storage/downloads/previews, comprehensive phone evidence inspection, revised-run Continue, safe profile provisioning and downgrade guard remain later work. Unsupported evidence stays unaccepted.

## Purpose and first boundary

An owner should be able to ask from their phone for a bounded local repair, inspect the exact result and its evidence, and decide whether to accept it. Reach coordinates the existing workflow tasks; an agent finishing a turn is only one event in that process.

The preceding research suggests a narrow hypothesis: separately rerunning owner-defined checks on a fixed local result, then presenting the evidence across existing agents, could reduce the owner's verification work. It does not establish unique capabilities or demand. Compare the demonstration with an ordinary build/review workflow and a script-based agent stop hook before claiming differentiation. A separate reviewer or a second model reading the builder's transcript alone does not establish independent execution evidence.

The target contract covers **one local synthetic app repair on one computer**: one builder, a separate check runner, a separate review chat, and at most one preapproved repair. The proposed complete demonstration uses a disposable app containing a failing unit test and a visible UI defect, with synthetic data, and returns a local patch or candidate snapshot, a diff, check records, and before/after app screenshots. This is a target, not current shipped evidence: the implemented fixture is the arithmetic repair described below, and sealed screenshots/previews are not served. Acceptance records the owner's decision; it does not apply a patch, merge, push, deploy, send a message, or publish an app.

Defer schedules and triggers, new connectors, hosted execution, cross-computer orchestration, external delivery, publishing, automatic merging, arbitrary repair loops, and generalized artifact editors. Existing ordinary workflows, relays, teams, coding-task tools and their providers remain available. A workflow task whose chat advances to later owner work now holds for inspection instead of attributing that later reply to its original attempt; ordinary Done/Skip/Retry controls remain available, while attached outcomes retain their stricter evidence barriers. The first outcome journey uses local Codex or Claude Code. OpenClaw remains an ordinary workflow participant; its own workspace and tool rules cannot satisfy this journey's local review contract.

## Existing foundations and gaps

Read this alongside [Coding tasks](CODING_TASKS.md), [Across agents](ACROSS_AGENTS.md), [Connection policy](CONNECTION_POLICY.md), and the repository's [agent instructions](../AGENTS.md).

| Existing surface | Reuse | Do not infer |
| --- | --- | --- |
| `server/agent-sessions/workflows.mjs` | Drafts, owner Run, task steps, agent/model validation, folder arbitration, relay finish observation, chat links | Task `done` means a settled reply; `skipped` also advances a stage. Neither means that criteria passed. |
| Workflow `resultOf()` and handoffs | Builder claims and pointers to conversations | Results can be empty after a read failure; answers, diffs, file lists and earlier handoffs are clipped. They are not a complete evidence ledger. |
| `server/coding-tasks.mjs` | Patterns for durable request IDs, original-turn boundaries, bounded evidence, `truncated`, `historyIncomplete`, and uncertain cancellation | This is invited-agent-owned work with its own access and quotas. Do not route owner outcomes through an invented Full control credential or expand these tools. Recorded command status is not necessarily an exit code. |
| `src/Workflows.tsx` | Existing editor, steps, task chats, save-before-Run, stop/retry controls, peer-aware polling | The existing Done row and Mark done action are task controls, not owner result acceptance. |
| Workflow Review kind | A new review chat using current reviewer permission modes | A reviewer report is an assessment, not a command receipt, sandbox guarantee, or owner approval. |

Keep the workflow and task state enums unchanged. Add outcome state beside them. Outcomes absent from a workflow must take the existing path, without new required fields, approvals, checks, runtime dependencies or UI steps.

## Owner contract

The owner opts in on a draft. An agent may propose text, but only the owner can save the authoritative contract, approve its executable checks and repair policy, and Run it. Merely reading a proposed plan or displaying a checked box is not approval. Version 1 cannot attach an active outcome retrospectively to an already running or finished workflow.

| Field | Contract |
| --- | --- |
| Goal | A short description of the desired observable result, not just tasks to perform. Required. |
| Acceptance criteria | Owner-editable stable IDs, text, required/optional flag, and evidence method: pinned automated check or explicit owner observation. At least one required automated criterion for this journey. A criterion cannot pass from an assistant's assertion. |
| Project and baseline | Owner-selected folder through the existing folder validator, immutable baseline manifest, and a dedicated build workspace. Preserve preexisting edits. Never reset, stash, commit, or include them silently. The first demo starts from a clean disposable fixture; a dirty or unrepresentable baseline blocks setup with a reason. |
| Allowed artifacts | Required and optional artifact kinds, allowed changed source paths, file count/byte limits, and expected provenance. Changed-path restrictions apply to the delta from baseline; the full candidate still includes unchanged inputs needed to build/check it. The list specifies what can constitute the submitted result; it does not grant filesystem access. |
| Checks | Owner-approved runner profile, command/argument vector or pinned harness ID, criterion IDs, working directory relative to the candidate, expected exit/result, environment requirements, timeout and output limit. Show the actual command before Run. No freeform command extracted from a reply or log. |
| Independent review | Required separate local review chat, selected agent/model/effort, scope, and explicit finding format. The same provider is allowed; the builder's own chat is not. Unavailable reviewer means Needs you, never silently omit it. |
| Limits | Overall deadline, per-phase timeouts, maximum build attempts, check runs and review attempts, with finite server ceilings. Waiting, sleep and restart do not reset them. |
| Optional repair | Off by default. The owner may preapprove exactly one additional build attempt for bounded, confirmed failures or actionable review findings under this same contract. Show its scope and cost/time limits before Run. |
| Owner acceptance | A separate explicit action on an exact contract/result/evidence revision. No agent, task status, reviewer, notification or timer can supply it. |

Criteria remain owner-editable. Saving substantive changes after Run creates a new immutable contract revision and pauses further dispatch. It invalidates current eligibility, check aggregation and review, retains all old evidence, and requires an explicit owner Continue for the new revision. In-flight work stays attributed to the old revision; it cannot certify the new one. Inspect or stop that work before resuming. Changing goal, criteria, commands, artifacts, reviewer policy, baseline or remaining task instructions is substantive; renaming the workflow is not.

Contract edits cannot reset attempts, spent time or repair consumption. A larger budget requires a new draft/run after the old work has been reconciled. Narrowing limits applies immediately. Changing a required criterion to optional or removing a failed criterion is visible in revision history and requires fresh verification/review under the new contract; it cannot turn an old failed check into a pass.

### Proposed complete demonstration

This target journey requires a production runner, two acceptance profiles and sealed preview APIs that are not yet implemented. The completed automated arithmetic fixture and its narrower evidence are documented under [Synthetic app-repair regression fixture](#synthetic-app-repair-regression-fixture).

1. The owner chooses the synthetic fixture and writes: “Repair the failing calculation and restore the total on the app screen.” Reach records the clean baseline and pins the acceptance harness definitions. No check command or builder starts yet.
2. The owner reviews the build task, criteria, allowed paths, two required check profiles (unit behavior and browser rendering), required screenshots, separate reviewer and limits. They optionally enable one repair, then tap Run. Baseline checks must now demonstrate the seeded failures before the builder starts; otherwise the run stops as an invalid demonstration.
3. The existing workflow builder works in the dedicated workspace, using existing Build permissions. Its final reply means **Task completed**. Reach captures and hashes the actual candidate independently of the reply, and shows any out-of-scope changes as a blocker.
4. A Reach-controlled runner reconstructs that candidate in a fresh verification workspace. It reruns the pinned checks, captures command receipts and the synthetic app preview, and records baseline/candidate provenance. A separate review chat inspects the candidate diff, full available evidence, contract and gaps.
5. If an eligible failure exists and the owner preapproved repair, Reach sends that evidence as quoted material to one new Build chat. The repair produces a new candidate revision. All required checks and review run again; old green checks do not carry forward.
6. The phone shows the exact diff, before/after preview, each criterion and check result, the review and anything unresolved. It says **Ready for your review** only when eligibility is established. The owner taps **Accept this revision** or leaves it unaccepted. A rejected result remains recorded; rejection cannot start another repair after the allowance is spent.

The initial build and any repair must never edit the authoritative harness, criteria or evidence records. Candidate package scripts and tests are candidate content, not trusted acceptance definitions. For example, `npm test` exiting zero after the builder replaces the test script with a no-op must fail the pinned behavior check. Required dependency versions, test counts or assertions belong in the check profile where relevant. Prefer an external harness for the seeded acceptance cases.

## Four separate facts

Always render these facts separately, including on failure:

| Fact | Meaning |
| --- | --- |
| Task completion | Existing task states, including stopped/skipped/uncertain and which attempt ended. “Completed” only describes the agent turn. |
| Checks | Per-run `queued`, `running`, `passed`, `failed`, `error`, `cancelled`, `unknown` or `stale`. A pass requires an observed exit/result and required output tied to the candidate and approved check definition. Infrastructure failure is `error`; absence of evidence is `unknown`. |
| Unresolved evidence and review | Missing/truncated history, unavailable artifacts, provenance gaps, findings and uncertain actions with explicit blockers and nonblocking limitations. Independent review has `pending`, `running`, `clear`, `findings`, `incomplete` or `stale`; even `clear` is only an assessment. |
| Owner acceptance | `not_accepted`, `accepted`, `rejected` or `stale`, with the exact accepted tuple and a private owner actor/time record. Acceptance never rewrites the other three facts. |

Suggested outcome phases are `draft`, `building`, `checking`, `reviewing`, `repairing`, `needs_owner`, `ready`, `accepted`, `cancelling`, `cancelled`, `uncertain`. These are outcome orchestration labels, not replacements for workflow states. A completed workflow can have an outcome awaiting checks or owner acceptance. A stopped workflow can have useful evidence without an accepted outcome.

Derived readiness requires: an intact candidate and allowed artifact manifest; all required automated checks currently passed; required owner observations recorded; completed independent review with no unresolved blocking findings; no incomplete provenance needed for a required claim; and no active, cancelling or uncertain work that could alter the result. Nonblocking limitations remain visible and must be acknowledged by ID at acceptance. Version 1 has no “accept despite a required check failure” override. The owner can revise the contract and rerun within the limits, or keep the result unaccepted.

Skip and Mark done remain workflow controls. Skipping required outcome work records a gap; neither action can satisfy a check, clear a finding or accept a result. Unused conditional repair/review tasks are different: the coordinator records `not_selected` in the outcome ledger, with a reason, and may use underlying `skipped` solely to settle workflow scheduling. They do not create a gap for a successful initial candidate. A review report that just says “looks good” without identifying the exact candidate and evidence coverage is incomplete. Findings have IDs, severity, affected criterion/artifact and evidence references. Resolution requires new evidence and a recorded review disposition; the builder cannot delete or mark its own findings resolved. An owner may explain a nonblocking disposition but cannot invent a check receipt or erase a technical blocker.

## Result identity and evidence

### Immutable result revisions

Reach, not an agent-supplied filename or branch name, assigns each candidate revision. Its canonical manifest contains the baseline ID/digest, exact source snapshot digest, relative file paths, file kinds/modes and content digests, artifact IDs/digests, and originating workflow/task/attempt IDs. Hash the full declared candidate input set, including unchanged package/configuration files; the allowed changed-path list restricts its delta, not which inputs appear in the manifest. A commit may be included as a locator but cannot substitute for a manifest of the bytes actually checked, including relevant untracked files. Do not attribute existing project changes to this task using a whole-folder diff.

An artifact manifest distinguishes source/result artifacts from evidence generated later (logs, review reports, previews). Evidence has its own revision and digest, so adding a review does not require changing source bytes. Hash algorithms and canonicalization are versioned; examples below abbreviate hashes only for readability. A mutable branch, filesystem path, URL, mtime or workflow update timestamp is not a result revision.

Allowed artifact kinds for version 1 are a local source snapshot or patch/diff, plain-text or structured check logs, a review report, and PNG app screenshots. Use server-generated opaque IDs for retrieval; never accept an arbitrary host path or remote URL as proof. Reject path traversal, symlink/reparse escapes, unresolved submodules, unexpected executable attachments and content beyond the approved bounds. An out-of-scope source edit remains visible as a blocker; do not silently leave it out of the manifest to get a pass. No interactive untrusted HTML preview on Reach's owner origin: use static screenshots and escaped text. Captures must show only the synthetic app. Real owner screens and private artifacts never become fixtures, public reports or uploaded evidence.

### Provenance for every evidence item

Store source type (`agent_claim`, `provider_command`, `provider_change`, `reach_check`, `review_report`, `owner_observation`), workflow/task/attempt IDs, provider/chat/turn/item IDs when available, contract revision, candidate revision, collector identity/version, collection time, and immutable blob digest/size. Record origin and omissions separately from rendered content. Missing provider IDs are explicit, not fabricated.

A `reach_check` receipt additionally includes the approved definition/harness digest, execution ID, actual argument vector, candidate-relative cwd, allowlisted environment fingerprint (no secret values), OS/runtime/dependency/browser versions, start/end timestamps, observed exit code or signal, timeout/cancellation status, output references/digests, truncation and integrity results. A command whose record only says `completed` is not known to have exited zero. Record the process's outcome outside its stdout; output containing “passed” or JSON resembling a receipt cannot create one.

Screenshots identify who captured them, the app route/viewport/browser, baseline or candidate digest, and capture time. Before and after must use the same fixture scenario and declared viewport. Screenshots support visible appearance claims; they do not establish command success or phone/OS compatibility on untested devices.

The reviewer receives the pinned contract, exact baseline/candidate diff and available receipt/artifact references directly. Builder prose is marked as untrusted material, as existing handoffs are. Persist the review's own chat/turn boundary, agent/model where known, candidate/contract digests, `reviewedEvidenceDigest` for its immutable input bundle, inspected scope, findings and explicit omissions. Appending the review creates the final evidence bundle and a new `evidenceDigest`; the review never hashes itself. This append does not invalidate its own coverage. Later evidence that changes the reviewed claims does invalidate that coverage and requires a new review within the remaining budget. A read-only review may request permission according to the provider's existing rules; outcome approval cannot answer it automatically.

### Independence and its limits

The check runner is a separate Reach-controlled execution path, not a command result submitted by the builder or reviewer. It uses a fresh checkout/copy of the sealed candidate, pinned harness outside the candidate, isolated scratch output, a minimal declared environment, and no credentials for owner APIs. Do not share the builder's mutable working directory or treat a Git worktree's shared metadata as an isolation boundary. Checks may execute candidate code; only run the owner's approved local profiles and keep their side effects confined by the actual runner boundary. Deny unapproved install scripts, network use and external services for this fixture.

Verify harness, input and output integrity before and after each run, and again before acceptance. Required source inputs must not change during checking; generated output belongs in declared scratch paths. A changed harness, unexplained concurrent writer or inability to attest the checked bytes yields unresolved evidence, never a pass. Serialize capture/check/review against outcome writers; a separate workspace avoids collisions with unrelated chats, but folder arbitration alone cannot prevent external OS processes from writing.

**This is operational independence, not a malicious-agent sandbox.** Existing Build permissions and processes sharing the owner's OS account may reach other files; a clean checkout, file modes or a digest alone cannot prove the builder was unable to tamper with the runner. Record the enforced isolation and its limits. Do not advertise tamper-proof or “outside the agent's control” verification without a separately validated OS/security boundary. If a required isolation or integrity property cannot be established on a host, report the gap and block that claim; never silently weaken the profile. This layer adds no broader agent permission and does not redesign the current permission system.

### Invalidation and incomplete history

- Source/artifact bytes, baseline, contract or required check definition changed: issue a new revision; previous checks/review become stale for the current result. Acceptance becomes stale for the current view. Keep the original accepted tuple as history, clearly dated.
- New check results, review findings, owner observations or evidence loss: increment evidence revision and invalidate any pending acceptance token. A contradictory new finding cannot sit under an unchanged green badge. Recompute eligibility and require acceptance of the updated bundle.
- Only an unrelated original-project file changes while the sealed candidate remains intact: record divergence before any future apply step, but do not claim the sealed snapshot itself changed. Version 1 does not apply it.
- Required input cannot be hashed or an artifact has been removed: mark it unavailable and block acceptance. Never silently regenerate under an old artifact ID.
- Truncated provider display/storage: show the omission, which is permanent in that bounded receipt. Clipping alone is a nonblocking limitation when independent complete evidence establishes the required claims. Missing original-turn provenance, required artifacts, required unknown exits or uncertain side effects still block. Full retained log/blob links are a target API, not currently available; never imply that clipped provider content can be retrieved today.
- Incomplete original-turn history: set `historyIncomplete` and explain the boundary/collection failure. Preserve known receipts. Never use a later owner's chat turn, a quoted task marker, or a best-effort latest reply to fill the gap. A fresh independent run can establish a criterion even if builder history is incomplete, but cannot prove unknown actions did not happen. Any unknown side effect or missing required provenance remains blocking.

The UI must not suppress omissions merely because all visible check rows are green. A collector error creates a recorded gap, rather than an empty successful bundle. Historical evidence is immutable and superseded explicitly; it is not overwritten to make the latest attempt look complete.

## Bounded execution, repair and cancellation

Version 1 defaults: 30-minute overall automation budget, with a server maximum of 60 minutes; 15 minutes per Build attempt, five minutes per review attempt, and five minutes per check run, each capped by the remaining overall budget. The deadline starts at Run and includes queues, permission waits, sleep and disconnection. It ends dispatch/execution, not the owner's ability to inspect and accept a sealed, completed bundle later. A backward clock jump must not extend a run; if persisted elapsed time cannot be reconciled, stop as uncertain.

There is one initial Build attempt and at most one additional repair attempt. For each candidate/contract pair, each check profile runs once. Each distinct candidate/contract/`reviewedEvidenceDigest` tuple gets at most one review attempt; changed evidence can receive a new review only within the remaining run-wide budget. Repeat verification after a genuine repair is a new candidate cycle. With `N` approved profiles (1–10) and `B` approved Build attempts (1 or 2), the run-wide ceilings are `N × (1 + B)` check dispatches including baseline, and `B` review dispatches. Freeze these totals at Run. A contract edit or owner-made candidate revision may use the remaining allowance after explicit Continue, but never replenishes it; this can leave insufficient allowance for repair. Baseline checks run once before the initial build and count against the overall time and recorded check budget. An infrastructure error or unknown result never triggers an automatic rerun. Persist all dispatch counters, independent of the number of chat references retained. Manual workflow Retry and provider continuation cannot bypass them. More work requires a new explicitly reviewed draft after reconciliation.

Preapproved repair requires all of the following: a confirmed failed criterion or actionable blocking review finding; complete enough evidence to scope the repair; no uncertain action/termination; remaining time and attempt allowance; current originating-owner authorization; and the same approved paths, permissions, criteria and check profiles. Permission requests, access loss, missing evidence, runner errors or availability failures go to Needs you. They are not repair triggers.

Record repair reservation and a unique dispatch ID durably **before** sending anything. Reserve the attempt even if the reply to dispatch is lost. One repair means one new Build chat with the original goal plus the specific failed checks/findings as material, then a fresh capture, full required checks and independent review. It does not mean a loop until green. The unused allowance is not permission for a hidden “fix” after acceptance. Concurrent finish callbacks must be unable to reserve two repairs.

On deadline, owner Cancel, workflow Stop, access revocation or required workspace removal: durably prevent new work first, request interruption of the exact owned turns and check processes, and retain partial evidence. Do not undo file changes or kill unrelated processes. Global Reach pause prevents further outcome dispatch and follows existing chat pause behavior; show any still-running task honestly rather than implying pause terminated it. An owner's workflow Stop must reach the attached outcome even after workflow tasks finished but checks/review are still active.

`cancelling` means interruption requested. `cancelled` requires confirmation that owned work stopped or never started. An unacknowledged stop, provider error, or untracked child process stays `uncertain`/`cancellationPending`; it cannot be accepted or used as permission to start a replacement. Interrupt retries may target the same known original turn/process only. If the chat has continued with owner work, do not stop the later turn. The existing workflow stop result and relay expiry are not proof of process termination; implement outcome supervision explicitly.

## Architecture and persistence

Keep the integration small and server-authoritative:

```text
Workflows.tsx: optional contract + outcome detail + exact acceptance
        |
existing authenticated owner session routes and private connection
        |
outcome coordinator ---- versioned private ledger + immutable blobs
        |
        +-- workflow engine: existing Build/Review chats, limits, modes
        +-- candidate capture: baseline, manifests, content hashes
        +-- check runner: approved profiles, receipts, bounded stop
        +-- review collector: exact turn, findings, coverage
```

Suggested new modules are `server/agent-sessions/outcomes.mjs` for validation/state/dispatch reconciliation and `server/outcome-evidence.mjs` for manifests, blobs and check receipts. A runner adapter can be separate from both. Names are guidance; ownership and boundaries above are required. Reuse provider adapters and normal workflow task machinery; do not create a second chat scheduler or reuse the invited-agent coding-task principal.

Add narrow workflow hooks for before-dispatch checks, server-assigned execution folders, task-attempt events, outcome Stop, and completed-stage candidate capture. Pin validated workspace references at Run: Build/repair uses the dedicated writable build workspace; Review uses a separate inspection copy of the sealed candidate; checks use their own disposable verification copy. Resolve these through the existing folder validation policy and show the assignment to the owner. Agents cannot select arbitrary replacement folders. Preserve the owner-selected project/baseline reference, and retain ordinary workflows' `w.cwd` behavior. A reviewer must never default to inspecting the mutable build folder.

The first template must put a capture/check barrier after each Build and before its Review; do not let ordinary stage advancement race past that barrier. Represent an optional repair as a visible conditional task plus fresh review, bounded by the same coordinator and the workflow's 20-task/three-active-task limits. Unneeded conditional tasks are explicitly `not_selected` as described above. Count outcome reviews/repairs in those limits and retain one builder per execution folder. Check processes get a separate bounded host queue (one verification bundle at a time in version 1). Non-outcome workflows take no new barrier. Normal stop, retry, skip, update and remove endpoints must consult the attachment so an old UI cannot bypass the contract.

The authoritative outcome record lives outside the project and independently of workflow summaries, in private Reach data with owner-only filesystem access (appropriate ACLs on Windows). Use a validated versioned envelope and atomic writes. Persist a state transition plus action intent/request ID before side effects; persist immutable blobs before publishing their manifest references. If the two stores disagree after a crash, reconcile by durable IDs and digests; never infer “not dispatched” from a missing reply. A failed write blocks dispatch and acceptance. Record monotonically increasing state versions across restart; do not reuse the workflow engine's in-memory list revision as an acceptance version.

Compatibility rules:

- Old workflows without an outcome reference load, render, run and copy exactly as before. Never synthesize criteria or retroactive acceptance from old Done records.
- Keep the existing workflow array format. Add a minimal optional outcome reference/capability marker, with details in a versioned outcome ledger. Explicitly update the allowlisted summary/view and UI types; unknown optional data must not be lost by edits or normal saves.
- `again` copies contract text as an unapproved draft, with fresh IDs and no evidence, acceptance, attempts or enabled repair approval. The owner must review and Run again. `remove` must refuse active/uncertain attached work and handle outcome retention deliberately.
- Corrupt, missing or unsupported outcome data blocks the affected outcome and its dispatch, with a repairable error; it must not silently become an ordinary workflow. Unrelated ordinary workflows remain usable. Do not overwrite unreadable ledgers with empty arrays.
- Old clients may read basic task state. The server rejects actions that cannot meet the outcome contract and requests a supported client. A server downgrade is unsupported for active outcomes: block downgrade/start through the compatibility guard until they are stopped and reconciled, or export and remove them explicitly. A marker that old server code simply ignores is not a sufficient downgrade guard.
- Existing workflow retention (roughly a week for inactive entries, with a 50-record slice) and coding-task limits are not outcome retention. Pin attached workflows and their audit references while active, uncertain or awaiting acceptance. Retain outcome manifests, decisions and evidence until explicit owner deletion in version 1; impose advertised finite storage/count limits and refuse new work when full. Do not silently evict evidence to make room. Keep deduplication tombstones when deleting blobs so a late repeated request cannot restart work.

### Recovery and concurrency

On startup, preserve settled `needs_owner` holds and their original reasons when no operation remains pending. Reconcile persisted intents with known provider turns/process receipts. Any dispatch or stop that cannot be established becomes uncertain. Do not automatically resume a build, check or repair after a server restart. Reattaching read-only status observation to a known operation is allowed; replaying its command is not. A fully persisted completed receipt can be recovered after integrity checks without executing again. A waiting verification bundle displays why it is queued without changing its phase; Home and workflow rows say “Waiting for checks” without creating another owner decision; runner waits do not block ordinary workflow scheduling. A held uncertain execution keeps its verification slot until an exact stop is confirmed, and the owner can use Retry stop without dispatching replacement work. Clearing uncertainty requires evidence of the original operation's disposition and candidate integrity; an owner acknowledgement or Mark done alone is insufficient. If its disposition cannot be established, preserve the uncertain record and stop this run. Revalidate acceptance tuples and evidence availability on load.

Use a per-outcome serialized mutation transaction or equivalent compare-and-swap. Every async completion carries contract, candidate, execution and state generation IDs. A callback from an older generation may append historical evidence but cannot revive cancelled work, replace a newer candidate, or accept it. Two phones accepting, a contract edit racing acceptance, and Cancel racing repair reservation all have one deterministic durable winner. Retrying a lost response must return that operation's prior result, subject to current authorization, rather than repeat the side effect.

Transport recovery follows [Connection policy](CONNECTION_POLICY.md) and [AGENTS.md](../AGENTS.md) exactly. Keep the same owner origin/link and enrolled device authorization while selecting eligible native private, browser private, or permitted grant-specific fallback internally. For this owner-only surface, fallback means the authorized app-independent private browser path; public agent gateway fallback remains restricted to eligible agent grants. Outcomes require no phone Tailscale app, new invitation, transport selection or replacement link. Preserve open review state across handoff. A transport change never replays a start, write, command, repair or acceptance whose result is unknown; inspect by its durable request ID. An ineligible/unapproved alternative never inherits credentials or owner privileges.

## Proposed owner-only API extensions

The implemented route inventory is at the top of this document. This original target table is a design reference, not the shipped API: `/continue`, `/reject` and `/artifacts/:artifactId` remain unimplemented; current contract changes after Run use `/request-changes` to create a fresh unapproved draft. Current `/run` requires the preparation digest, and ordinary workflow `/run` cannot bypass it. Paths in the table are relative to `/api/sessions/workflows/:id`. Reuse current session owner/admin device authentication, origin/CSRF checks, folder checks and pause rules. Reads, blob downloads, previews, status feeds and writes are all owner-only. Full control agents, scoped coding-task credentials, guest devices, teams and hosted MCP clients gain no outcome API. Owner APIs and WebSockets remain private; neither the public start page nor the authenticated public agent gateway may proxy these endpoints. Agent-provided results enter through internal provider collectors, never a public “mark passed” endpoint.

| Method/path suffix | Request and behavior |
| --- | --- |
| `GET /outcome` | Current contract, candidate/evidence summaries, all four facts, limits, provenance gaps and durable `version`. No executable action. Absent attachment is explicitly `null`. |
| `POST /outcome` | Create/update owner draft contract with `requestId`, `expectedVersion` (`0` for create) and `contract`; after Run, save a new revision and pause as above. Strict schema rejects permission modes, unknown fields and agent-supplied verdicts. |
| `POST /outcome/run` | Owner-approved contract and workflow plan revision/digest, `requestId`, `expectedVersion`; start through the existing workflow engine. An attached workflow's ordinary `/run` must require the same approved tuple. |
| `POST /outcome/continue` | Explicit owner decision after a contract edit or reconciled pause; exact revisions and remaining budget required. Cannot replay uncertain actions or replenish budgets. |
| `POST /outcome/observations` | An owner-entered observation for one manual criterion and candidate, with artifact references and expected version; recorded as owner testimony, never automated execution. |
| `POST /outcome/accept` | Exact tuple below plus acknowledged nonblocking limitation IDs. Recheck current authorization, integrity and readiness atomically; persist acceptance before replying. |
| `POST /outcome/reject` | Exact tuple and optional owner note; preserves evidence and records rejection. No implicit new work. |
| `POST /outcome/cancel` | Durable cancellation intent; always available to an authorized owner while paused. Return actual cancellation/uncertainty state, not an unconditional success. |
| `GET /outcome/operations/:requestId` | Read an authorized operation's known/pending/uncertain result after a lost response. Unknown is not permission for a new dispatch ID. |
| `GET /outcome/artifacts/:artifactId` | Authorized, bounded immutable content lookup belonging to this outcome; no host-path parameter, redirect, public bearer URL or active HTML. |

Every mutation uses a durable request ID scoped to the outcome/owner operation, a canonical body hash and expected state version. Its identity survives transport changes and credential rotation; it is not keyed to a transient connection token. Same ID/same body returns the prior operation without executing twice; same ID/different body returns `409`. Check current owner access before returning even a cached result. New stale-version requests return `409` plus a safe refresh reason. Malformed contracts return `400`, unauthorized access `401`/`403` under existing conventions, missing artifacts `404`/`410`, unavailable ledger/runner `503`, storage failure `507`, and exhausted quotas `429`. Errors never fabricate a result or downgrade protection.

Illustrative draft (IDs and digests are synthetic placeholders; profiles are pinned, owner-approved definitions, not arbitrary strings to execute):

```json
{
  "requestId": "outcome-contract-001",
  "expectedVersion": 0,
  "contract": {
    "goal": "Repair the calculation and restore the visible total.",
    "criteria": [
      { "id": "c1", "text": "The seeded calculation cases pass.", "required": true, "method": "check", "checkId": "unit" },
      { "id": "c2", "text": "The total is visible at the declared mobile viewport.", "required": true, "method": "check", "checkId": "browser" }
    ],
    "allowedArtifacts": {
      "allowedChangedPaths": ["src/**"],
      "requiredKinds": ["source_snapshot", "diff", "check_log", "review_report", "before_png", "after_png"],
      "maxFiles": 100,
      "maxBytes": 52428800
    },
    "checks": [
      { "id": "unit", "profileId": "synthetic-unit-v1", "definitionDigest": "sha256:unit-placeholder", "timeoutSeconds": 300 },
      { "id": "browser", "profileId": "synthetic-browser-v1", "definitionDigest": "sha256:browser-placeholder", "timeoutSeconds": 300 }
    ],
    "review": { "required": true, "agent": "claude", "separateChat": true },
    "limits": { "wallSeconds": 1800, "buildSeconds": 900, "reviewSeconds": 300, "maxBuildAttempts": 2, "maxTotalCheckRuns": 6, "maxTotalReviewAttempts": 2 },
    "repair": { "preapproved": true, "maxCycles": 1 }
  }
}
```

The API resolves profile IDs to complete displayed definitions before Run. It rejects missing/stale digests, commands without a supported safe runner, inconsistent budgets, or repair enabled with fewer than two allowed Build attempts. In version 1 the single initial build consumes attempt one; repair disabled means one maximum Build attempt. This example allows two baseline checks plus two distinct checks per candidate, at most six total, and two review attempts total. The owner may lower these run-wide totals; the server must never raise them implicitly. Baseline counts are recorded separately for presentation but consume the same total check budget and deadline.

Illustrative completed task with failed outcome evidence:

```json
{
  "workflowState": "done",
  "outcome": {
    "schemaVersion": 1,
    "version": 12,
    "phase": "needs_owner",
    "contractRevision": 1,
    "resultRevision": 1,
    "resultDigest": "sha256:result-placeholder",
    "evidenceRevision": 3,
    "taskCompletion": { "completed": 2, "skipped": 0, "uncertain": 0 },
    "checks": [{ "id": "unit", "status": "passed" }, { "id": "browser", "status": "failed" }],
    "review": { "status": "findings", "blockingFindingIds": ["f1"] },
    "unresolved": [{ "id": "u1", "kind": "criterion_failed", "criterionId": "c2", "blocking": true }],
    "historyIncomplete": false,
    "truncated": false,
    "repair": { "preapproved": false, "cyclesUsed": 0 },
    "acceptance": { "status": "not_accepted", "eligible": false }
  }
}
```

Illustrative later acceptance request for a new, eligible result:

```json
{
  "requestId": "accept-result-002",
  "expectedVersion": 21,
  "contractRevision": 1,
  "contractDigest": "sha256:contract-placeholder",
  "resultRevision": 2,
  "resultDigest": "sha256:result-2-placeholder",
  "evidenceRevision": 7,
  "evidenceDigest": "sha256:evidence-7-placeholder",
  "acknowledgedLimitationIds": []
}
```

Acceptance stores that complete tuple plus the authenticated owner actor, timestamp and request ID; the client cannot choose the actor. The decision is a separate audit record and does not alter the evidence digest it accepts. Rehash/validate the sealed result and required evidence under the same serialized transition. The acceptance response identifies the accepted revision. If anything changed, refuse and show the newer bundle. A repeated acceptance after a lost response returns its historic receipt and current stale/current status, never silently accepts the latest revision. Further content edits create a new unaccepted revision; old acceptance remains visible only for the old bytes.

## Phone presentation

Extend the existing workflow sheet with an optional Goal and criteria panel, limits, allowed result types, reviewer, and the repair switch. Flush pending edits and confirm the exact saved contract/plan before Run, using the existing explicit Run action as approval. Keep ordinary workflow creation unchanged.

During execution, show task progress and outcome phase separately. The result view leads with the candidate revision and diff/preview, followed by criteria, check receipts, separate review, and missing evidence. Use plain labels: “Task completed”, “Checks passed”, “Evidence missing”, “Review found issues”, “Needs you”, “Ready for your review”, “Accepted revision 2”. Do not use a single green Done badge for all of them. Show a short reason when Accept is unavailable, with access to the underlying evidence and task chat.

Keep awaiting-review outcomes visible as active owner work even if underlying tasks are done. Notifications link back to that result, say what needs attention, and contain no sensitive logs or screenshots. Reconnection preserves the viewed revision, scroll position and unsaved owner text; a changed bundle is clearly identified before acceptance. Use accessible labels and touch layouts on iPhone, iPad and Android. No new connection chooser or public preview link.

Navigation integration now uses the existing workflow sheet from Home, each agent's Chat list and All. Compact rows distinguish running, blocked and ready for owner review; attention uses the existing Needs you strip, bell and private journal. Outcome notifications contain fixed copy and an opaque workflow locator (`?page=sessions&workflow=…`), open the current authenticated result, and offer no acceptance or change decision outside that sheet. Task-chat links use persisted current/earlier chat identities, never a title match. Reopening an already-visible result refreshes it while preserving owner text; changed evidence requires explicit inspection again. The same tab remembers the workflow for reloads. Production runner and sealed artifact/log API gaps above remain unchanged.


## Acceptance scenarios and validation

These are required implementation checks, not claims of tests already run.

| Scenario | Required observation |
| --- | --- |
| Ordinary workflow without outcome | Existing create/plan/edit/run/skip/retry/stop/again behavior and permissions pass unchanged; no outcome UI or check dependency. |
| Happy local repair | Baseline shows seeded failures; candidate passes pinned unit/browser cases; diff and synthetic previews match its digest; separate review completes; only explicit owner Accept records acceptance. Run with both Codex and Claude Code as builder in separate trials. |
| False “done” | Builder claims success while a required check fails, removes the test, changes its script to no-op, or supplies forged receipt text. Task may complete; outcome cannot become ready/accepted. |
| Optional repair | Disabled: no automatic extra Build. Unneeded conditional repair/review is `not_selected` and does not block the initial result. Enabled: a confirmed eligible failure consumes one durable reservation, produces a new candidate, reruns all required checks/review. Second failure, duplicate callbacks or manual Retry cannot create a third Build. |
| Exact revision | Source change, required artifact change, criteria edit, later finding, or stale phone tab makes old acceptance fail with conflict. Unrelated original-folder divergence is reported without falsely changing sealed bytes. |
| Concurrent owners/actions | Double Run, two Accepts, edit versus Accept, Stop versus repair, late check after Cancel: one serialized outcome, no lost edits, duplicate work or revived cancellation. |
| Independent provenance | Builder transcript is labelled as such; separately collected check has actual exit/result and versioned harness/candidate digest. Same-chat self-review and unbound “looks good” cannot satisfy review. Review binds its input evidence digest; appending the report preserves coverage, while a later contradictory receipt invalidates it. |
| Incomplete history | Missing original turn, pagination cutoff, clipped output, missing artifact and empty collector result produce visible flags/gaps. Later owner messages never become this attempt's evidence. No unknown exit code becomes zero. |
| Scope and tampering | Out-of-scope edit, symlink/reparse escape, altered harness or concurrent candidate writer blocks acceptance. Unchanged build/config inputs remain in the manifest despite a narrower allowed-change list. Record the actual isolation limit; test denial on each supported host. |
| Cancellation and limits | Cancel during discovery, dispatch, running check, review and repair prevents further starts. Deadline expires across sleep/restart. Lost stop acknowledgement remains uncertain; partial changes/evidence stay. Later owner turns are untouched. |
| Crash and storage failure | Crash before/after intent, provider acknowledgement, blob write and acceptance write; corrupt/future schema, full storage and missing reference. No replay, empty-ledger reset or false acceptance. Unaffected ordinary workflows still work. |
| API permissions | Owner-only reads, mutations, operation lookup and artifacts; guest/Full control/scoped-agent/hosted credentials refused. Public listener and agent gateway cannot serve owner outcome data. Revocation during async discovery or artifact read is enforced. |
| Transport handoff | Private → allowed fallback → private, unavailable/unapproved alternatives, concurrent requests and a held old-route response. Same enrolled client and origin; no replay or stale result replacement. Test an app-absent phone path and app-first enrollment. |
| Persistence and copy | Legacy records load unchanged; outcome survives restart with provenance; Run again is a fresh unapproved draft; old clients cannot bypass barriers; deletion/retention cannot silently drop active work or deduplication history. |
| Preview and phone review | Only synthetic app captures, matching baseline/candidate route and viewport; escaped logs; no script execution on owner origin. Owner can inspect and accept the exact bundle on each touch client. |

Put shared state/evidence/route/UI regressions in Windows CI as well as normal CI. Exercise platform-specific process termination, path boundaries, atomic writes and ACL behavior on actual macOS and Windows. Browser-enforced origins, CORS and private cross-port gateway behavior require a real browser; mocked fetch does not prove them. Label simulated provider/transport tests, actual OS execution, live agent turns and physical iPhone/iPad/Android validation separately. Existing workflow and across-agent docs explicitly record historical stand-in checks; this contract does not upgrade those claims.

Measure the synthetic demonstration: every seeded false-success run blocked; complete required evidence for every ready result; median delegation-to-reviewable bundle at most 15 minutes; at most one owner intervention after initial setup and before final acceptance; phone review under two minutes; zero out-of-scope actions or replayed unknown actions; equivalent results with two builders. Record sample sizes, actual environments, failures and baseline comparison. These are trial targets, not production guarantees. Safety/integrity failures block the demonstration regardless of speed.

Run only relevant tests through `npm run test:file -- ...` and the existing runaway guard; do not launch a second full test suite. Follow the CLI-only start/restart instructions and preserve live sessions. Synthetic journey evidence stays private/untracked unless deliberately safe to publish; never capture or attach the owner's real screen.

## Synthetic app-repair regression fixture

`test/fixtures/outcome-app/` contains only a deliberately broken total, a tiny browser page and a fixed independent check harness. `test/helpers/synthetic-app-repair.mjs` copies the app to disposable build/inspection directories, runs the harness in a bounded Node subprocess, hashes candidate bytes and logs, and drives the real workflow coordinator with simulated provider turns. These test adapters must never be configured as production runners: their positive isolation assertions are simulated, and copies/hash comparisons do not isolate another process running as the same OS user.

The workflow and coding-task families distinguish Codex's recorded exit from Claude's unavailable exit, preserve original-turn failures, and refuse to promote assistant claims to checks or review. The app journey covers approved preparation, baseline failure, build, independent check, separate review, optional single repair, current result and exact owner acceptance. Fault cases include missing/clipped/stale receipts, incomplete original histories, changed candidate bytes, missing logs, concurrent edit reports, check-harness tampering, duplicate requests, cancellation of owned work, restart uncertainty, expired access and competing owner evidence.

`test/outcome-app-repair-routes.test.mjs` uses actual ephemeral authenticated HTTP routes with the fixture coordinator. `test/outcome-app-repair-browser.test.mjs` uses repository headless Chrome, the real result component and those routes through a test-only same-origin proxy. It checks the broken/fixed app DOM, preparation/Run, stale acceptance, explicit current-revision inspection, duplicate taps and durable operation recovery after a clipped successful acceptance response. Existing `workflow-outcome-ui` and `workflow-outcome-browser` regressions retain result-state, narrow-layout, touch and keyboard coverage. No live-screen captures are needed.

These shared checks are selected in `.github/scripts/run-tests.mjs` for Windows CI, with a selection regression in `test/ci-policy.test.mjs`. A browser-unavailable skip is not browser validation. Local runs establish only the host execution actually reported: provider/reviewer turns, access-clock changes and runner isolation remain simulated. Real Codex/Claude trials, production runner enforcement, Windows process/filesystem behavior, browser private-network/CORS boundaries and physical iPhone/iPad/Android review require separate validation. The test proxy provides no transport-security evidence, and this fixture does not remove the production runner's fail-closed boundary.

## Demonstration and validation status

The synthetic demonstration is validated through automated fixture tests, not completed with real agents or a physical phone. The fixture's concrete before/after is deliberately small: `test/fixtures/outcome-app/src/total.mjs` initially subtracts (`2 - 3` yields `-1`); the repaired candidate adds (`2 + 3` yields `5`). The independent harness checks four arithmetic cases. This is a regression fixture, not the proposed 90-second expense-rounding demo; no user study, filming or participant testing has occurred.

The browser journey exercises the broken and repaired fixture DOM, preparation and Run, review state, stale acceptance rejection, explicit revision inspection, duplicate taps and recovery after a clipped successful acceptance response. The current product UI reports runner availability before creation or preparation. The dedicated New outcome composer creates one builder and opens criteria without dispatching a planner; trusted profile provisioning remains incomplete. It shows the saved builder/checker/reviewer branches and limits before Run; on the result it shows task-attributed provider evidence, independent check receipts/status, reviewer findings, unknowns, evidence freshness and revision-bound **Accept result** / **Request changes** actions. The UI explicitly says full independent log content and sealed artifact downloads/before-and-after previews are unavailable. Files/Apps/Screen navigation opens current computer state, not a frozen candidate preview.

Validation reported for this task chain: the synthetic journey and focused regressions passed in guarded npm runs (136 focused tests for the end-to-end fixture task; 204 coordinator/route/UI tests for the preceding implementation task; 63 focused result UI tests including Chrome checks for the result-view task). These are separate handoff-reported batches, not a claim that one combined suite was run here. The fixture uses actual files, bounded Node check subprocesses, ephemeral authenticated HTTP routes, and repository headless Chrome where available. Provider/reviewer turns, runner isolation, and access-clock changes are simulated. The test proxy is same-origin and proves no browser private-network/CORS boundary. Windows CI selection is registered, but actual Windows execution/ACLs were not validated. No physical iPhone, iPad or Android validation, live-agent run, real notification delivery or real-screen capture is claimed.

Final-review UI revalidation on macOS passed 49 guarded DOM/navigation/chat checks across `workflow-outcome-ui`, `outcome-navigation-ui`, `outcome-open-app-ui`, `workflow-chat-groups-ui` and `first-run-chat-ui`, plus both real Chrome outcome suites (two tests, no skips). Chrome inspected the completed arithmetic repair, stale/duplicate acceptance and lost-response recovery, plus the five result states at 320, 390 and 768 pixel widths with keyboard/touch input. No screenshots were captured. The first browser attempt was blocked by sandbox loopback restrictions; the permitted rerun passed. These checks retain simulated provider/reviewer turns and simulated runner isolation.

Task 12 final-review revalidation passed 234 distinct affected tests through guarded npm scripts: 107 state/evidence/scheduling/app-repair/workflow checks; 24 CI-policy and outcome-route checks; 52 coding-task/notification/relay/OpenClaw-workflow checks; the 49 UI checks above; and the two real Chrome journeys. These are separate focused batches, not a full `npm test` run. TypeScript and the production build passed, and whitespace checks passed. An incidental first-run-launch fixture batch initially hit sandbox `uv_uptime` restrictions; its isolated permitted rerun passed all 11 checks, using fake Tailscale and temporary data, and is excluded from the 234 outcome count. No live Reach start, stop or restart was performed.

Task 12 changed files (unrelated working-tree edits were preserved):

- Engine/API: `server/agent-sessions/{workflows,outcome-coordinator,outcome-policy,outcomes,result-evidence}.mjs`, `server/index.mjs`.
- UI: `src/{Workflows,WorkflowOutcome,WorkflowOutcomeEditor,EverythingChat,outcome-navigation}.tsx`.
- Regressions: `test/{outcome-scheduling,outcome-coordinator,workflow-app-repair,outcomes,outcomes-routes,result-evidence,workflow-outcome-ui,workflow-outcome-browser,outcome-navigation-ui,ci-policy}.test.mjs`; shared Windows selection in `.github/scripts/run-tests.mjs`.
- Documentation: `README.md`, `docs/{OUTCOMES,WORKFLOWS,GUIDE}.md`.

The automated synthetic demonstration is ready to inspect as regression evidence. A live owner demonstration is **not ready**: production runner enforcement, trusted profile provisioning, sealed result/log previews and real Codex/Claude trials remain unavailable. In particular, the original-turn request digest still needs validation against each provider's normalized echo; these tests do not establish live anchor fidelity. Windows execution, private-network browser boundaries and physical phones also remain unvalidated.

The Reach Outcomes section in the README, this workflow guide and the user guide describes the implemented UI and limitations. The earlier proposed demonstration's two-check expense app, before/after screenshots and sub-15-minute/intervention targets are proposals only. Current outcome preparation and Run return `503` until a trusted production runner is configured; the test adapter is not production isolation. Claude evidence may lack an exit code; Codex may provide one, but neither provider's transcript proves candidate integrity. Separate review is a judgment, not a sandbox guarantee. Current folder arbitration is not a global lock, so external or concurrent edits remain an uncertainty unless the production runner can detect and contain them.

## Original implementation sequence and remaining work

Steps 1–4 below describe the original plan and are implemented to the extent stated in the current boundary above. They are not a claim that the outstanding runner, sealed evidence APIs or live validation are complete.

1. Add strict contract/evidence schemas, durable versions, private storage, request deduplication and pure readiness/invalidation rules. Prove old workflows are unchanged and corrupt outcome data fails closed.
2. Integrate owner-only routes and narrow workflow barriers. Implement exact candidate capture, bounded check supervision, original-turn provenance and cancellation/restart reconciliation before automatic repair.
3. Add the separate review collector and the one-time preapproved repair transaction. Verify limits, late callbacks and all uncertainty paths; never borrow coding-task agent credentials.
4. Extend `Workflows.tsx` with the optional editor and revision-bound evidence/acceptance view. Keep task completion, check results, unresolved evidence and acceptance distinct throughout.
5. Run the synthetic repair journey with both local builders, record actual validation scope, and compare owner effort with the ordinary workflow/stop-hook baseline. Schedules, connectors, publishing and applying the result remain deferred.

Remaining engineering decisions must be demonstrated rather than assumed: the runner's enforceable isolation on each host, safe profile provisioning/dependency setup, and the compatibility guard for server downgrades. If any is unavailable, expose that limitation and keep the affected outcome unaccepted; do not compensate with broader permissions or optimistic evidence.
