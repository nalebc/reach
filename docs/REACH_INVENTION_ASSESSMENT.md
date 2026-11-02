# Reach invention assessment

Assessment date: November 1, 2026. Audience: people doing everyday computer work and developers, through one shared experience. This is product research and a set of proposals, not a release announcement or implementation contract. Competitor behavior below is documented by its makers; these products were not tested in this assessment.

**Recommendation:** explore Reach as the place where a person can try alternative results on their own computer, make a decision that updates the affected work, and turn a successful task into a reusable tool. Keep the task, artifacts and decisions usable when the person changes agents. Test this complete experience before expanding the workflow infrastructure.

The ambition is a meaningful change in how people use computers: describe a job once, inspect actual results, and gradually acquire personal tools for repeated work. Calling it revolutionary requires evidence of repeated usefulness. Neither a feature list nor passing coordination tests establishes that.

## Assessment of the previous direction

The Outcomes implementation pursued one selected idea: give delegated work explicit criteria, recorded evidence, review and owner acceptance. It produced substantial coordination, persistence and UI code. Its automated arithmetic repair demonstrates state transitions and checks against actual candidate files, with simulated providers and isolation. The production runner, trusted profile setup and sealed previews remain unavailable. See [the current validation record](OUTCOMES.md#demonstration-and-validation-status).

This was an engineering foundation, not a broad invention exercise or a compelling completed product demonstration. Four problems with that approach matter:

1. It committed to an answer before comparing different user needs and possible features.
2. It used a tiny coding fixture to demonstrate orchestration, leaving everyday usefulness untested.
3. It treated test coverage as the main progress signal while the live owner journey remained blocked.
4. It put the burden of understanding the result on the owner. A completed run must explain its deliverables, decisions and unresolved work in ordinary language.

Retain useful code and tests. Use revision identity, bounded work, receipts and clear uncertainty behind the next experience where they fit. Further generalization of Outcomes should depend on a demonstrated need; do not remove its safeguards to make a demo appear complete.

## What the market already offers

These are competitive baselines. Availability varies by product, plan and surface. A missing description of a feature is not proof that nobody offers it.

| Product family | What the current primary sources document | Consequence for Reach |
| --- | --- | --- |
| OpenAI ChatGPT Work and Dots | Work can continue across eligible desktop, mobile and web sessions, with approved local resources. Dots can coordinate tasks on a connected personal computer and manage continuing responsibilities. | Phone delegation, local work and persistent agents are not sufficient differentiation. [Work](https://learn.chatgpt.com/docs/get-started-with-work), [connected computers](https://learn.chatgpt.com/docs/dots/computers-and-apps), [tasks](https://learn.chatgpt.com/docs/dots/tasks-and-memory). |
| Anthropic Claude | Remote Control continues local Code sessions. Dispatch delegates desktop work from a phone and returns artifacts; current help says limited beta, unavailable to new users. Artifacts include reusable interfaces, connected apps and stored data. | Neither remote agents nor generated personal interfaces are new by themselves. Dispatch's availability restriction is not a durable product advantage. [Remote Control](https://code.claude.com/docs/en/remote-control), [Dispatch](https://support.claude.com/en/articles/13947068-assign-tasks-from-anywhere-in-claude-cowork), [Artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them). |
| Cursor | Cloud agents use isolated desktops, produce screenshots, videos and logs, and support human desktop takeover. | An agent fixing an app and returning a preview is already a strong incumbent experience. [Capabilities](https://cursor.com/docs/cloud-agent/capabilities). |
| GitHub | Central agent sessions, progress, delegation and review; third-party coding agents are documented as public preview. | A multi-agent task dashboard is a crowded coding category. [Management](https://docs.github.com/en/copilot/concepts/agent-capabilities/choosing-and-delegating-agent-work/agent-management), [third-party agents](https://docs.github.com/en/copilot/concepts/agent-capabilities/about-agents/about-third-party-coding-agents). |
| OpenClaw | Automation, standing intents and resumable workflows with approval checkpoints through the optional Lobster plugin. | Scheduling, orchestration, memory and resumption are baselines. [Automation](https://docs.openclaw.ai/automation), [standing intents](https://docs.openclaw.ai/concepts/standing-intents), [Lobster](https://docs.openclaw.ai/tools/lobster). |
| Microsoft | Copilot Studio automates Windows desktop and web interfaces. Power Automate records desktop actions into editable flows. | Computer use and recording a demonstration already have established substitutes. [Computer use](https://learn.microsoft.com/en-us/microsoft-copilot-studio/computer-use), [recording](https://learn.microsoft.com/en-us/power-automate/desktop-flows/recording-flow). |
| Retool | Natural-language generation of apps connected to resources, alongside agents and workflows. | A generated form with buttons needs a specific advantage in convenience or task continuity. [Apps](https://docs.retool.com/build/apps), [agents](https://docs.retool.com/agents). |
| Perplexity | Portable Computer documents local orchestration, scheduled work and approved escalation to cloud models on supported Windows/Linux hardware. | Local execution and model choice alone are insufficient. Its hardware requirements do not prove Reach will be easier or more reliable. [Portable Computer](https://www.perplexity.ai/en-GB/hub/products/portable-computer). |

**Strongest objection:** model vendors increasingly provide models, memory, tools, remote access and finished artifacts together. Another coordinator introduces setup and another interface. Reach must save meaningful effort on a repeated job, including setup and recovery, to justify that extra product.

## Reach assets worth building on

The working tree already contains these capabilities. Presence in source is not a claim that the running installation has them or that each provider/platform is validated.

| Existing asset | Opportunity and boundary |
| --- | --- |
| Local apps, browser, files and terminals through CLI/MCP | Reach can act where existing work lives. Full control uses the owner's account; it is not a sandbox. [Browser tools and limits](BROWSER_AGENT_TOOLS.md). |
| Phone app access, owner intervention, pause and Needs you | A person can help with the same work an agent is doing. Mac app display behavior must not be assumed on Windows. [App threads](APP_THREADS.md), [guide](GUIDE.md). |
| Cross-agent chats, transfers, reviews and relays | Reuse the adapters and navigation. Transferring conversation text is not yet a portable account of completed and uncertain effects. [Across agents](ACROSS_AGENTS.md). |
| Recorded app tasks and declarative browser tools | Successful work can already become an agent tool. The new opportunity is owner-facing composition, varied-input validation and usable output review, not renaming macros. [Saved tools](GUIDE.md#saved-tools-for-browser-agents). |
| Workflow reports, evidence records, journal and notifications | Reuse them to explain work and preserve uncertainty. Bounded records cannot establish a complete history or universal undo. [Workflows](WORKFLOWS.md#progress-and-completed-results). |

The connection and permission requirements in [AGENTS.md](../AGENTS.md) remain constraints for every proposal. Local files do not imply local-only model processing. Any claim that data stays on the computer must account for the chosen agent and provider.

## Six feature proposals

All six are proposals. Rankings below are product judgments, not customer research or measured market scores. The same entry point should serve both audiences: select the work, describe the result, inspect the outputs and make the necessary decisions. Specialist details can expand inside that experience.

### 1. Try alternatives before choosing

**What the owner does:** asks for two materially different results, opens the actual outputs on the phone, selects one or combines specific parts, and keeps the chosen version.

- Everyday example: prepare a concise and a detailed project proposal from the same brief and figures; compare the rendered documents.
- Developer example: implement two onboarding approaches in separate copies, exercise each actual interface, and select the preferred candidate.
- New value: comparison becomes an ordinary way of working with AI, with the originals protected and the chosen result identified exactly.
- Reuse: files, previews, task orchestration and result identity. Add supported artifact staging, comparable previews and conflict-aware application.
- Boundary: start with copied local artifacts. Sending messages, remote account changes and arbitrary app state cannot be branched or universally undone. Copying a directory does not isolate an unrestricted agent; enforce the write boundary before claiming protection.
- Strongest objection: worktrees, document copies and incumbent previews already cover much of this. Reach must make selection and subsequent work substantially easier on a phone.
- First test: create two real documents and two small web-app variants. An outside edit during review must block replacing the original. Rejecting a variant must leave the original unchanged.

**Assessment:** strongest visible first capability; medium effort for a bounded artifact set, high effort for arbitrary applications.

### 2. Keep successful work as a personal tool

**What the owner does:** after a useful result, taps **Keep as a tool**. Reach proposes a small editable interface with inputs, output previews and a repeat action. The next run uses new inputs without rebuilding the instructions.

- Everyday example: a client image pack with selected folder, image size, naming style, contact sheet and ZIP output.
- Developer example: an asset-preparation or release-check tool with selected project, target, build/test results and preview links. Publishing remains a separate explicit action.
- New value: useful work accumulates into tools the person can inspect, revise and use with a different supported agent.
- Reuse: saved tools, request identity and file operations. Add a constrained owner interface, composition, input validation, versioning and a portable definition without credentials.
- Boundary: a generated button invokes a declared capability; it does not grant arbitrary code new authority. Interface generation and app building are already competitive features.
- Strongest objection: Claude Artifacts, Retool, scripts and existing Reach shortcuts may already be sufficient. Measure the reduction in setup and repeated explanation.
- First test: the owner reruns a saved tool on three previously unseen input sets. The developer must not repair the definition between runs. Invalid inputs must produce a useful explanation.

**Assessment:** strongest repeat-use hypothesis; medium effort if the first interfaces are constrained. A general app generator is premature.

### 3. Decide once and update the affected work

**What the owner does:** answers one understandable question, sees every deliverable that depends on the answer, and can later change that decision.

- Everyday example: choosing a package price updates the proposal, price sheet and presentation draft consistently.
- Developer example: choosing a sign-in approach updates the design, implementation and test plan; outdated outputs are visibly marked until checked again.
- New value: Reach remembers the decision and its consequences across agents, rather than making the person repeat it in several chats.
- Reuse: task dependencies, Needs you and revision records. Add explicit decision references, affected-artifact tracking and invalidation.
- Boundary: a content decision is not permission to send, deploy or buy. Separate actions retain their own authorization. Begin with declared dependencies; inferred relationships can be suggestions.
- Strongest objection: ordinary shared project context may solve most of the problem. A wrong dependency map could spread a mistaken assumption more efficiently.
- First test: one decision affects three outputs; changing it marks all three stale, updates only those outputs and preserves an unrelated deliverable.

**Assessment:** high potential to reduce supervision across both audiences; medium-to-high effort. Automatic dependency discovery remains a research risk.

### 4. Continue the work with another agent

**What the owner does:** changes agents while retaining the objective, artifacts, decisions, unfinished steps and uncertain operations.

- Everyday example: one agent researches a report; another completes it using the same source list and selected draft.
- Developer example: a second provider continues a stalled repair from the current patch and recorded checks.
- New value over existing chat transfer: the state of the work travels, not only a summary of the conversation.
- Add: a bounded work record, capability checks and explicit treatment of unavailable context. Keep credentials and authorizations separate.
- Strongest objection: handoff summaries are cheap, and provider-native state cannot be fully transferred. Seamless continuation is not a safe default when an action may already have happened.
- First test: switch agents at a known pause, then separately at an uncertain dispatch. The latter must hold rather than repeat the action. Compare with manual copy-paste.

**Assessment:** strategically aligned with Reach, but best as support for a visible task rather than the flagship story. Start on one computer.

### 5. Turn a correction into an inspectable lesson

**What the owner does:** fixes a blocked step on the phone; Reach proposes what to remember, where it applies and how to test it. The owner can edit or discard the lesson.

- Everyday example: correct a crop or report-export option once and reuse the preference for that project.
- Developer example: correct a project-specific build sequence and reuse it on later changes.
- New value over recording: a generalized condition and desired result, validated on changed inputs, rather than blind replay of clicks.
- Reuse: Tag in, recorded tasks and saved tools. Add lesson extraction, scope, counterexamples and varied-input checks.
- Strongest objection: existing skills and RPA already teach procedures. A single correction may be an exception, not a rule.
- First test: apply the lesson to three valid variations and one case where it must not apply. A second successful run is required before claiming the agent learned anything useful.

**Assessment:** promising extension after reusable tools; high uncertainty for arbitrary GUI behavior.

### 6. Keep selected work current

**What the owner does:** assigns an ongoing responsibility to a chosen project and sees the useful changes, missing inputs and decisions it produces within a stated time/cost budget.

- Everyday example: keep a weekly review pack current when selected source files change.
- Developer example: keep installation instructions and example projects aligned with a selected API change.
- New value to test: maintain a useful result and explain changed dependencies, rather than repeatedly generating status messages.
- Add: scoped observation, durable scheduling, change attribution and stop conditions. Reuse existing scheduling integrations where appropriate.
- Strongest objection: OpenClaw standing intents and Dots responsibilities already target this space. False alerts and silent maintenance errors can cost more than manual work.
- First test: inject useful, irrelevant and conflicting changes. Measure correct updates, missed work, unnecessary alerts and owner attention.

**Assessment:** ambitious later direction. Defer until a manually started task is reliably useful; no ambient monitoring of the whole computer.

## Priority and investment decision

| Candidate | Owner-visible change | Reach-specific fit | Competitive overlap | Decision |
| --- | --- | --- | --- | --- |
| Try alternatives | High | High | High | Build a bounded demonstrator first |
| Keep as a personal tool | High, if reused | High | High | Pair with the demonstrator; test repeat use |
| Decide once | High on related tasks | High | Medium-to-high; novelty unproven | Add one explicit dependency example |
| Switch agents with work intact | Moderate until a failure | High | High | Support the same demonstration on a second provider |
| Learn from a correction | High if transfer works | High | High | Test on varied inputs before generalizing |
| Keep work current | Potentially high | Medium | Very high | Defer; require evidence of ongoing demand |

The recommended first product direction combines the first two. The third is an expansion test, not a prerequisite for another large framework. Avoid launching six independent features at once.

Work briefings are a requirement across them: **what was requested, what changed, where the outputs are, what is running, and what needs a decision**. This repairs basic comprehensibility and is not itself a revolutionary claim. Reuse the existing inbox and workflow history.

Do not prioritize a new chat aggregator, automatic agent voting, a generic workflow canvas, an unrestricted always-on personal agent, or a promise to undo any computer action. They either overlap heavily with existing products or need guarantees Reach cannot presently support.

## One shared experience and two concrete demonstrations

The proposed work view has five parts: **Goal, Inputs, Alternatives, Result, Use again**. Progress and decisions remain visible throughout. Code, documents and images use suitable inspectors inside this structure; the person should not need to design an agent graph.

### First demonstration: reusable client image pack

Use a designated synthetic folder with several images and a short brief. The owner requests web-ready images, a numbered contact-sheet PDF and a ZIP. Reach produces two actual presentation styles. The owner inspects the files, corrects a crop, keeps one style and saves the task as a tool with folder, size and naming inputs. A different folder is then processed through the saved interface.

This creates visible, usable artifacts without new accounts or external sending. Image utilities already do the transformations; the hypothesis is that creating, inspecting and reusing this personal tool through Reach is easier. Check output counts, dimensions, names, manifest consistency and original-file preservation. A broken image and an output conflict must surface clearly.

### Developer counterpart: reusable app improvement task

Use a disposable web app with a meaningful interface flow. Ask for two alternative onboarding designs, inspect each running result, select one and keep the project-specific checks and preferences as a reusable task. Repeat after changing the input brief. Run the same shared work interface with two supported real providers in separate trials.

The app preview requires an appropriately isolated origin; untrusted generated code must not run with Reach owner credentials. A selected result does not authorize merging or deployment. This test is more demanding than the existing arithmetic fixture and cannot inherit its pass status.

### Expansion demonstration: one decision across outputs

Prepare a fictional product-launch package with a local website, a one-page PDF and a price sheet. Show two actual design alternatives. Ask one shared pricing question, identify the three dependent outputs, and show the effect of changing the answer. No content is published or sent. Use this only after the smaller demonstration works; it tests whether the shared experience scales beyond a single output.

These are proposed demonstrations, not completed tests. A storyboard or mocked interface establishes comprehension only. Real file generation establishes artifact behavior. Real provider turns and physical phones establish additional, separate evidence.

## Evidence required before expansion

Start with a small formative study spanning everyday users and developers. Five participants and ten paired task attempts would be a useful initial experiment, not statistical proof. Recruitment or account access is a separate authorized activity; neither occurred here.

Compare the same job against manual work and the strongest available incumbent using the same inputs. Counterbalance the order to reduce practice effects. Record first-time setup separately from repeat runs, active owner time separately from agent elapsed time, and model/tool costs separately from local runtime costs.

Proposed decision thresholds, not measured results:

- At least eight of ten repeat attempts produce usable artifacts with no developer repairing the saved tool behind the scenes.
- Median active owner time falls by at least half against the best tested baseline on repeat runs; setup and review time are included in the report.
- Owners can identify the requested result, actual changed outputs and unresolved issues in under one minute.
- At least four of five participants choose to reuse the tool for another similar task. A stated preference is weaker evidence than observed repeat use.
- Seeded stale inputs, ambiguous targets and unknown dispatches are never represented as successful. No unauthorized effects in the tested attempts; a small zero-failure sample is not a safety guarantee.
- Physical phone review, actual macOS/Windows behavior and each real provider are reported separately. Missing coverage remains unknown.

Stop or narrow the concept if a saved script, existing agent or artifact app performs the task with comparable effort, if repeat runs need hidden repairs, or if review takes as long as doing the work manually. Test comprehension with a disposable prototype before investing in general engines; test the real provider and artifacts before claiming a working feature.

## Implementation handoff and current status

Start with the existing tool registry and authenticated file views, one supported artifact family, a constrained phone form and explicit result files. Establish enforceable write scope and safe previews for that slice. Use saved request identities and actual check receipts. Add only the coordination required by the demonstration; do not invent a second permission system, inbox or general orchestration engine.

Outcomes may provide useful result and decision records. Its unconfigured production runner remains a blocker wherever its execution guarantees are required. A separate bounded tool experiment must declare its own real guarantees and cannot turn a simulated adapter into production validation.

The assessment created this document only. It preserved existing application changes, used public primary sources and repository inspection, and performed no live Reach lifecycle actions, provider runs, participant contact, publishing or merging. No new production features were implemented. No runtime tests or builds were needed for this documentation-only addition. The proposed demonstrations are not yet ready for live owner testing.
