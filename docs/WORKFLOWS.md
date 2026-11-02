# Workflows

**Status: built, not yet run live** (October 8, 2026). The server part takes effect after a Reach restart. See [Verification](#verification).

A workflow is a plan for a piece of work that several agents carry out, task by task. You write it yourself, or describe the work and an agent drafts it. Either way you see every task, can change any of it, and nothing runs until you tap **Run**.

## Reach Outcomes

An outcome is an optional owner-defined goal and review record attached to a workflow. It adds editable success criteria and evidence requirements; it does not change what an ordinary workflow means. For example, on a synthetic calculator where `2 + 3` incorrectly displays `-1`, an owner can set the goal to repair the calculation, require a pinned check and an independent review, and restrict changed paths to `src/`. Before Run, the outcome editor shows the builder, checker, reviewer, branch plan, permitted paths, deadline and attempt limits. The owner may preapprove at most one repair cycle.

The result view keeps four things separate: whether task turns finished, what checks have recorded, what evidence or review remains uncertain, and whether the owner accepted this exact result revision. It can show recorded independent check status, reviewer findings, provider-reported task diffs/commands, truncation and unknowns. **Accept result** records an owner decision on the current revision; **Request changes** records the decision and creates a new unapproved draft. Acceptance does not merge, apply, push or deploy anything.

The current preview controls link to Files, Apps and Screen. These are authenticated views of current computer state, not sealed previews of the captured result. Full independent logs and sealed artifact downloads/previews are not currently available through the APIs. Provider transcript evidence is explicitly provider-reported and cannot prove final candidate bytes or rule out concurrent edits. Provider display clipping stays visible and does not alone block independently established checks. If the runner cannot establish required evidence, original-turn history is incomplete, required check output is incomplete, a stop/dispatch is uncertain, access is lost or a limit expires, Reach holds for owner inspection; it does not infer success.

Outcome preparation and Run currently require a trusted production runner adapter, which is not installed by default. Until configured, the UI explains the unavailable setup and disables New outcome, Create outcome draft, profile editing, Prepare and Run; direct preparation/Run calls fail closed with `503`. Existing results remain inspectable, and ordinary workflows remain available. When available, New outcome opens a dedicated builder/criteria flow without launching a planner. Profile IDs and digests must come from trusted runner setup; profile provisioning and a picker remain incomplete. Synthetic test adapters do not establish host isolation. The tested app journey uses a tiny synthetic total function (`2 + 3` should be `5`) with actual fixture files and check subprocesses, but simulated provider/reviewer turns and simulated runner isolation. It is not a live-agent or physical-device demonstration. See [Outcome status and evidence](OUTCOMES.md#synthetic-app-repair-regression-fixture) for the exact validation boundary.

How it differs from what's already in Chat ([Working across agents](ACROSS_AGENTS.md)):
- **Relay**: one chat's reply goes on to the next agent, up to three steps, set up on that chat.
- **Team chat**: a lead agent decides, as it goes, which helper does what. You talk to the lead.
- **Workflow**: the whole plan is laid out up front, by you or by a planner, and stays in view and editable while it runs. Reach runs it, not an agent.

## What a workflow holds

- A **name**, and the **folder** on this computer where every task's chat starts.
- **Tasks**, in steps. Each task has a name, **what to do** (the full instructions its agent gets), an **agent** (Codex, Claude Code, or OpenClaw when Reach has its Gateway), a kind: **Build** (may change files) or **Review** (reads only, and reports what it found), and optionally a **model** and **effort** (none: the agent's default).
- A step starts when the one above has finished. A task set **With previous** joins the step above and starts with it.

## Making one

**Planned for you.** Chat → **New chat** → **Workflow** (beside Solo and Team), or **New workflow** on the Workflows page. Pick the folder, describe the work ("Add passkey sign-in, with tests") and send. The agent picked at the top plans it: a normal chat in the folder that only reads (Codex in its read-only sandbox, Claude Code in Manual). The workflow's page shows **Planning…**, then the tasks. To change the plan, edit it there, or ask in the planner's chat (**Open chat**). Its next plan replaces the draft, unless you've edited it: then **New plan · Use it** offers the swap.

A plan can set only the tasks: their names, what to do, agent, kind, steps, and each task's model and effort. It never picks the folder or a permission mode; those stay yours.

**Model and effort per task.** The planner is given the models each agent offers now (ids, names, and each model's effort levels, lowest first) and picks per task by how hard it is to get right, not how long it is:
- **Highest effort, strongest model:** design or architecture choices, changes across many files, security, sign-in, permissions, money or private data, data migrations, concurrency or fragile state, a bug with no known cause, a final review meant to catch subtle mistakes.
- **Middle:** a feature or fix with a clear goal in a few files, tests for decided behaviour, a routine review.
- **Lowest, or a smaller, faster model:** mechanical work (renames, copy and doc updates, config or version bumps, formatting), summaries, gathering facts.
- When unsure, the middle. A review of risky work is at least as high as the build it checks. Not every task at the top. Its summary says which tasks it set high or low, and why.

Reach keeps a planned model only if the agent offers it (confirmed, not a preview) and an effort only if that model lists it; anything else is left out and the agent's default runs. Each task row shows its model and effort; open a task to change them (**Model**, **Effort**). Changing a task's agent puts it back on that agent's default. OpenClaw tasks have neither. A reply with no plan Reach can use says why on the page, and the draft stays as it was.

**Written yourself.** In New chat on Workflow, **Write tasks myself**. An empty draft offers starting points (**Research, then build** when OpenClaw is here, **Build, then review**, **Build, review, fix**, **Two reviews**) or an empty task. Tap a task to edit it: its name, what to do, and chips for the agent, Build or Review, With previous, moving it and removing it. Everything is saved as you type.

## Running

Tap **Run**. Each task starts when its step comes, as a new chat in the folder named `Workflow · <task name>`:
- **Build** tasks start the way relay and team builders do: Codex in **Approve for me** (or **Ask for approval** when that's off), Claude Code in **Auto**.
- **Review** tasks only read: Codex's read-only sandbox, Claude Code in Manual.
- **OpenClaw** tasks start as a new OpenClaw chat of Reach's own, outside the folder, with OpenClaw's own tool rules (Reach has no mode to set there). The message says it isn't in the folder and that its reply stays here, never to a channel. It doesn't hold the folder, so it can run beside a build. See [OpenClaw in relays and workflows](ACROSS_AGENTS.md#openclaw-in-relays-and-workflows).
- A task with a model or effort starts on it. Checked again at its start: if its agent no longer offers that model or effort, the task stops and says so, never running on another.
- A task also gets what the steps before it finished with: the last replies and changed files, clipped like a relay's, inside a marked block introduced as material, not instructions.

A task is done when its chat ends with a reply and is still idle a few seconds later, the same check relays use. The next step then starts on its own: a workflow keeps going until it's finished or something goes wrong. If the owner continues that chat before Reach records the original task completion, Reach pauses the task as uncertain rather than treating the later turn as its result. Inspect its chat and use the ordinary Retry, Skip or Mark done controls; later text cannot replace the original attempt's evidence. Attached outcomes do not allow those controls to bypass their evidence requirements.

The **Workflows** icon at the top of Chat (beside Search, and in the ☰ menu) opens them all, as **Active**, **Drafts** and **Done**; its count shows how many run or wait on you (amber when one is paused). Open a workflow for its overall progress and task results. Every task is also a normal chat: read it or write in it through **Open chat**. A permission its agent asks for shows in **Needs you**, as any chat's does.

### Progress and completed results

Inside a workflow, the run overview shows whether it is running, paused, stopped or completed; how many tasks have finished; and separate completed, skipped, running and waiting counts. The task count describes progress through the plan, not time remaining or independently verified success. Unused conditional outcome branches do not count as completed work. Current task buttons and **View latest task result** open the relevant task in the same workflow.

A completed run opens its latest completed task's retained reply. The task view preserves the available paragraphs, lists reported files, and offers earlier retained attempts when a task was retried. Expand the recorded provider commands and changes to inspect outputs, exit status and diffs; the task's **Open chat** still opens its conversation. The retained reply is what the agent reported or what the owner passed on with **Mark done**. It remains separate from original-turn execution records and independent outcome checks.

The open workflow refreshes every few seconds while visible and when you return to it. **Refresh workflow** requests an immediate update. A failed update stays visible alongside the last available run state, so an old view cannot silently look current. Missing results, shortened retained content and incomplete evidence are labelled; a short preview remains available when the full retained result cannot be loaded, with a retry control.

Ordinary workflow records are bounded local history: finished workflows and drafts are kept for up to a week, with at most fifty retained ordinary workflows. A provider may retain its task chats separately. The overview does not add a permanent archive or change outcome acceptance.

**When something goes wrong** (an error, a usage limit, a chat you stopped, a task that couldn't start), the workflow pauses and your phone is told. The stopped task opens with why, and:
- **Retry** starts it again in a new chat.
- **Skip** goes on without it.
- **Mark done** takes what its chat ends on, once you've sorted it out there.

**Edit** changes the tasks that haven't started (add, remove, move, rewrite); started ones stay as they are. **Stop** stops the tasks at work and never starts the rest; their chats stay. **Run again** copies a finished or stopped workflow as a new draft. A settled outcome can be explicitly deleted, which removes its retained evidence and releases its active quota while keeping a minimal replay-prevention tombstone; pending or uncertain work must be reconciled first. Retry stop targets only the same known outstanding operation. An accepted outcome cannot be cancelled.

## Rules Reach follows

- **Nothing starts without you.** A planned workflow is a proposal until you tap Run, and every task's full text is on its page. Once you run it, its tasks are your instructions.
- **The planner reads; you decide.** The planner can't change files, and its plan can't choose a folder or mode. It may choose each task's model and effort, only from what the agent offers, and you see and can change them before Run. A file in the project written to steer the planner can, at worst, propose tasks you see before running, and they start at the middle permission level, never Full access or Bypass.
- **No new permission.** Builders and reviewers start like relay steps. Anything more asks you on the phone.
- **One builder in a folder at a time**, across all workflows, so two agents never edit the same files at once. Reviews and OpenClaw tasks can run together, and beside a build.
- **Another agent's words are material, not orders.** What one task finished with reaches the next inside a marked block.
- **Bounded.** At most 20 tasks in a workflow, and at most 3 workflow tasks at work at once on a computer. Each task starts once; a retry is your tap. A task that hasn't finished after a day stops, and the workflow pauses.
- **It stops when access does.** Before each task starts, Reach checks that the phone that ran the workflow is still an approved owner device and that Reach isn't paused. Otherwise the workflow pauses and says why.
- **After a restart.** A task that was starting when Reach stopped is marked uncertain and never started again on its own. Check its chat, then Retry, Skip or Mark done.

## Limits (first version)

- One computer: a workflow's tasks run on the computer it was made on.
- Planners are Codex or Claude Code: a planner must look through the project and only read, and OpenClaw can do neither in the folder. A planner may give tasks to OpenClaw when it's here (research or writing that doesn't need the code). Gemini CLI chats can't take messages from Reach yet.
- OpenClaw can't be kept to reading by Reach: a review task asks it to only check. Its exec approvals still ask you.
- A later task can't continue in an earlier task's chat (as a relay's fix step goes back to the builder). It gets that task's reply and changed files instead.
- No schedules or triggers. A workflow runs when you tap Run.
- The All page's **While you were away** doesn't list workflows yet (Reach records when one pauses or ends); your phone's notification does, and opens the task's chat.
- A task's chat doesn't link back to its workflow yet; the Workflows icon at the top of Chat has it.

## Verification

October 8, 2026. Automated results against stand-ins; nothing here has run against a live Codex or Claude Code turn.

- **Automated:** `test/workflows.test.mjs` (the engine with the real relay engine: drafts and plans checked, steps, one builder per folder, three at work, pausing, Retry, Skip, Mark done, lost access, the restart rule, Stop, Run again), `test/workflows-routes.test.mjs` (the HTTP routes: owner devices only, the folder check, run once, the planner read-only whatever mode is asked) and `test/workflows-ui.test.mjs` (each phone flow through the real components). The relay engine's own tests pass with its new step.
- **OpenClaw** (stand-ins): `test/workflows-openclaw.test.mjs` (OpenClaw researching before Claude Code builds, beside a Codex build, its reply passed on; an error paused in Reach's words; Retry with a new request id; Stop; lost access; never a planner). Needs `openClaw` passed to the engines in `server/index.mjs` and OpenClaw in the phone's agent list.
- **Not yet run live:** a real planner turn (how reliably each agent ends its reply with the plan), real task turns and their finish detection, the notifications, and a physical phone.
- **Suggested first live check, after restarting Reach:** a two-task workflow on a throwaway folder (Build, then review), and watch it finish.

October 31, 2026. The ordinary workflow progress and retained-result views have focused synthetic coverage in `test/workflow-run-ui.test.mjs` and `test/workflow-run-browser.test.mjs`. The real components cover completed and running runs, earlier attempts, report/evidence separation, missing-result retries, refresh recovery and preservation of the selected task. Real Chrome checks 320, 390 and 768 pixel layouts, touch inspection, keyboard task opening and progress refresh using synthetic data only. Both suites are selected in Windows CI; registration is not an actual Windows run. These checks do not validate real-provider behavior, OS notifications or physical phones.

## Where it lives

- Server: `server/agent-sessions/workflows.mjs` (the engine, the plan check, the messages), routes in `server/index.mjs`, and the relay engine's `record` step in `server/agent-sessions/relays.mjs`.
- Phone: `src/Workflows.tsx`, `src/WorkflowRunSummary.tsx` and `src/workflows.css`, opened from `src/EverythingChat.tsx` (New chat) and `src/ChatHub.tsx` (the All page).
- API: [the HTTP API reference](API.md#workflows).
