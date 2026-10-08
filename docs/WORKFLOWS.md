# Workflows

**Status: built, not yet run live** (October 8, 2026). The server part takes effect after a Reach restart. See [Verification](#verification).

A workflow is a plan for a piece of work that several agents carry out, task by task. You write it yourself, or describe the work and an agent drafts it. Either way you see every task, can change any of it, and nothing runs until you tap **Run**.

How it differs from what's already in Chat ([Working across agents](ACROSS_AGENTS.md)):
- **Relay**: one chat's reply goes on to the next agent, up to three steps, set up on that chat.
- **Team chat**: a lead agent decides, as it goes, which helper does what. You talk to the lead.
- **Workflow**: the whole plan is laid out up front, by you or by a planner, and stays in view and editable while it runs. Reach runs it, not an agent.

## What a workflow holds

- A **name**, and the **folder** on this computer where every task's chat starts.
- **Tasks**, in steps. Each task has a name, **what to do** (the full instructions its agent gets), an **agent** (Codex or Claude Code) and a kind: **Build** (may change files) or **Review** (reads only, and reports what it found).
- A step starts when the one above has finished. A task set **With previous** joins the step above and starts with it.

## Making one

**Planned for you.** Chat → **New chat** → **Workflow** (beside Solo and Team), or **New workflow** on the Workflows page. Pick the folder, describe the work ("Add passkey sign-in, with tests") and send. The agent picked at the top plans it: a normal chat in the folder that only reads (Codex in its read-only sandbox, Claude Code in Manual). The workflow's page shows **Planning…**, then the tasks. To change the plan, edit it there, or ask in the planner's chat (**Open chat**). Its next plan replaces the draft, unless you've edited it: then **New plan · Use it** offers the swap.

A plan can set only the tasks: their names, what to do, agent, kind and steps. It never picks the folder, a permission mode or a model; those stay yours. A reply with no plan Reach can use says why on the page, and the draft stays as it was.

**Written yourself.** In New chat on Workflow, **Write tasks myself**. An empty draft offers starting points (**Build, then review**, **Build, review, fix**, **Two reviews**) or an empty task. Tap a task to edit it: its name, what to do, and chips for the agent, Build or Review, With previous, moving it and removing it. Everything is saved as you type.

## Running

Tap **Run**. Each task starts when its step comes, as a new chat in the folder named `Workflow · <task name>`:
- **Build** tasks start the way relay and team builders do: Codex in **Approve for me** (or **Ask for approval** when that's off), Claude Code in **Accept edits**.
- **Review** tasks only read: Codex's read-only sandbox, Claude Code in Manual.
- A task also gets what the steps before it finished with: the last replies and changed files, clipped like a relay's, inside a marked block introduced as material, not instructions.

A task is done when its chat ends with a reply and is still idle a few seconds later, the same check relays use. The next step then starts on its own: a workflow keeps going until it's finished or something goes wrong.

The **Workflows** icon at the top of Chat (beside Search, and in the ☰ menu) opens them all, as **Active**, **Drafts** and **Done**; its count shows how many run or wait on you (amber when one is paused). A workflow's page lists the tasks by step, each with its agent and where it stands (Waiting, Working, Done, Stopped). Tap one for what it finished with and **Open chat**. Every task is a normal chat: read it, write in it. A permission its agent asks for shows in **Needs you**, as any chat's does.

**When something goes wrong** (an error, a usage limit, a chat you stopped, a task that couldn't start), the workflow pauses and your phone is told. The stopped task opens with why, and:
- **Retry** starts it again in a new chat.
- **Skip** goes on without it.
- **Mark done** takes what its chat ends on, once you've sorted it out there.

**Edit** changes the tasks that haven't started (add, remove, move, rewrite); started ones stay as they are. **Stop** stops the tasks at work and never starts the rest; their chats stay. **Run again** copies a finished or stopped workflow as a new draft.

## Rules Reach follows

- **Nothing starts without you.** A planned workflow is a proposal until you tap Run, and every task's full text is on its page. Once you run it, its tasks are your instructions.
- **The planner reads; you decide.** The planner can't change files, and its plan can't choose a folder, mode or model. A file in the project written to steer the planner can, at worst, propose tasks you see before running, and they start at the middle permission level, never Full access or Bypass.
- **No new permission.** Builders and reviewers start like relay steps. Anything more asks you on the phone.
- **One builder in a folder at a time**, across all workflows, so two agents never edit the same files at once. Reviews can run together, and beside a build.
- **Another agent's words are material, not orders.** What one task finished with reaches the next inside a marked block.
- **Bounded.** At most 20 tasks in a workflow, and at most 3 workflow tasks at work at once on a computer. Each task starts once; a retry is your tap. A task that hasn't finished after a day stops, and the workflow pauses.
- **It stops when access does.** Before each task starts, Reach checks that the phone that ran the workflow is still an approved owner device and that Reach isn't paused. Otherwise the workflow pauses and says why.
- **After a restart.** A task that was starting when Reach stopped is marked uncertain and never started again on its own. Check its chat, then Retry, Skip or Mark done.

## Limits (first version)

- One computer: a workflow's tasks run on the computer it was made on.
- Codex and Claude Code only, as planners and as task agents. Gemini CLI and OpenClaw chats can't take messages from Reach yet.
- A later task can't continue in an earlier task's chat (as a relay's fix step goes back to the builder). It gets that task's reply and changed files instead.
- No schedules or triggers. A workflow runs when you tap Run.
- The All page's **While you were away** doesn't list workflows yet (Reach records when one pauses or ends); your phone's notification does, and opens the task's chat.
- A task's chat doesn't link back to its workflow yet; the Workflows icon at the top of Chat has it.

## Verification

October 8, 2026. Automated results against stand-ins; nothing here has run against a live Codex or Claude Code turn.

- **Automated:** `test/workflows.test.mjs` (the engine with the real relay engine: drafts and plans checked, steps, one builder per folder, three at work, pausing, Retry, Skip, Mark done, lost access, the restart rule, Stop, Run again), `test/workflows-routes.test.mjs` (the HTTP routes: owner devices only, the folder check, run once, the planner read-only whatever mode is asked) and `test/workflows-ui.test.mjs` (each phone flow through the real components). The relay engine's own tests pass with its new step.
- **Not yet run live:** a real planner turn (how reliably each agent ends its reply with the plan), real task turns and their finish detection, the notifications, and a physical phone.
- **Suggested first live check, after restarting Reach:** a two-task workflow on a throwaway folder (Build, then review), and watch it finish.

## Where it lives

- Server: `server/agent-sessions/workflows.mjs` (the engine, the plan check, the messages), routes in `server/index.mjs`, and the relay engine's `record` step in `server/agent-sessions/relays.mjs`.
- Phone: `src/Workflows.tsx` and `src/workflows.css`, opened from `src/EverythingChat.tsx` (New chat) and `src/ChatHub.tsx` (the All page).
- API: [the HTTP API reference](API.md#workflows).
