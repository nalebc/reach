# Working across agents

Reach's Chat holds every agent's chats on this computer: Codex, Claude Code, Gemini CLI and OpenClaw. Neither app can see the other's chats. Reach can. These features exist because all chats are in one place.

## The features

**1. Keep going when an agent runs out of usage.** When Codex or Claude Code hits its usage limit, the line above the message box offers **Continue in** the other agent. One tap shows what happens; a second tap moves the chat with its history (the same move as ⋯ → Continue in) and tells the new agent to pick up where the chat stopped. Your phone is notified when a chat stops on a usage limit. Reach never moves a chat by itself.

**2. Second opinion.** Under an agent's reply, **Second opinion** asks the other agent to review that turn: what you asked, what it answered, and the diffs of the files it changed. The reviewer starts as a new chat in the same folder. It can read; anything more asks you first. Codex reviews in its read-only sandbox, and Claude Code in Manual mode, which asks before any edit or command. You can have the review sent back to the original chat when it's done (a relay).

**3. Relays.** Set up what happens when a chat's agent finishes: **When done, relay…** above the box while it works, **Relay** under its reply, or ⋯ → **Relay when done**. The sheet draws the relay as a route, from this chat to each step's agent, with one sentence saying what happens. Tap a step to change it, or tap the last place to add the next one. With a reply already there, it can go now or after the next reply:
- **Build it**: a new chat with the other agent gets the reply and carries it out.
- **Build, then review**: as above, then a third chat reviews the builder's work.
- **Build, review, then fix**: the review goes back to the builder to address.
- **Send to a chat**: the reply goes into a chat you pick.

What's set up shows above the box, with Cancel. Each relay sends once. A relay still waiting after a day stops.

**4. Team chats.** In **New chat**, switch **Solo** to **Team**. The agent you picked leads (tap its tile to switch); helpers (Codex, Claude Code, or a second copy of the lead's agent) join along the route. You talk to the lead. The lead hands well-scoped tasks to helpers with Reach's team tools: a build, or a review that only reads. Each helper works in its own chat in the same folder, visible like any other. The lead doesn't wait: when a helper finishes, Reach sends its result back into the lead's chat as a new message, and the lead checks the work and carries on. The lead's chat shows its team at work above the box, with **Stop**. Each helper's chat says whose team it works for, with the way back. You can write in any of them.

**5. Mention a chat.** Type **@** in a message box to pick a chat from any agent, as well as files. Your message goes with that chat's latest request, reply and changed files. The bubble shows the chat's name, not the pasted context.

**6. The All page.** The first page in Chat when more than one agent is installed (swipe right from Codex, or pick **All** in the app menu), for every agent at once, on every computer this phone is paired with:
- **While you were away**: what finished, what failed, what waits on you, and how many files each chat changed since you last looked.
- **Search everything**: one search across Codex and Claude Code conversations (what was said, not tool output or the agents' own notes), plus every chat's name.
- **Teams** at work and **relays** in progress, with Cancel.
- **Projects**: chats grouped by folder across agents, each with its agent, status and the files it changed recently. A warning shows when two chats changed the same file in the last 30 minutes.

With more than one computer, each row shows which computer it's on, and the same folder on two computers is two projects. Tapping a chat on another computer switches Reach to that computer and opens the chat there, the way a notification from it does. If that computer doesn't answer, Reach says so, and picking another computer drops the wait. Each computer shows as soon as it answers; a line under the title names any that didn't, and why: it didn't answer, it wants this phone paired again, or this phone isn't one of its owner's devices.

## Rules Reach follows

- **Nothing starts or sends without you.** Moves, reviews and relays begin with your tap. A relay sends only for the turn it was set up for.
- **A finished turn is checked, not guessed.** Before a relay sends, Reach reads the chat. It must end with a reply that came after your last message (not an error, not a Stop), and still be idle a few seconds later.
- **No new permission.** Reviewers read; anything more asks you. Builders start in Codex's **Approve for me** (or **Ask for approval** when that's off) or Claude Code's **Accept edits**, never Full access or Bypass. Sending to an existing chat uses the same path as typing there from the phone, including its wait while you use the Claude app.
- **Another agent's words are material, not orders.** What one agent wrote reaches the next inside a marked block, introduced as material to work with, not instructions.
- **Bounded.** Chains are at most three steps. Text is clipped to the move limits (the start and end of a long reply, a summary of large diffs).
- **It stops when access does.** A relay checks, when it sends, that the phone that set it up is still an approved owner device and that Reach isn't paused. Otherwise it stops and says why.
- **After a restart.** A relay that was sending when Reach stopped is marked uncertain and never retried automatically. Check the destination chat first.
- **Teams stay bounded.** A team has at most 12 hand-offs and follow-ups, at most 3 helpers at work at once, and helpers can't hand off further. Every tool call checks that the phone that started the team is still an approved owner device and that Reach isn't paused. **Stop** ends it: no more hand-offs or wake-ups, its helpers at work stopped, and its key deleted.
- **Each computer answers for itself.** The All page asks each paired computer directly, with that computer's own credentials; one computer's credentials never go to another. "Since you last looked" is kept per computer, by that computer's clock, and **Got it** marks only the computers that answered. One that refuses this phone isn't asked again until its live connection lets this phone in (or the page is opened again).
- **A team's key is its own.** The lead's tools reach Reach on a private socket in Reach's data folder (readable only by your account), with a random key kept in a file only your account can read. The agent's settings hold that file's path, never the key. A tool call can only start or talk to the team's own helper chats, in the team's folder; it can't pick a folder, a mode or another chat.

## Limits

- Across computers: the All page's away report, search and projects cover every paired computer that answers. The rest stays on the computer you're connected to: relays and teams (and their Cancel and Stop), what **@** offers, where a relay can go, and the count of requests that need you. To act on another computer's relay, open one of its chats first.
- One phone page reads another computer only if that computer lets it in: computers linked with `./reach link` accept each other's pages (or list the address in `REACH_ALLOWED_ORIGINS`). One that doesn't fails the way an offline one does, so the page says it didn't answer.
- The All page appears when the computer you're connected to has more than one agent, whatever the other computers have.
- Overlap warnings compare paths inside the same folder on the same computer. Separate worktrees are separate folders.
- A team's chats stay in Reach while the team runs. The lead's tools exist only in the process Reach runs, and a lead's follow-up must never type into the Claude desktop app. So neither the lead nor its helpers join the Claude app's list, and **Open in app** is refused until you stop the team. If the Codex app takes over a lead's thread, the tools may not be there for turns the app runs. Once a team stops, its lead launches as an ordinary chat again, without the team's instructions or tools.
- Gemini CLI chats are read only, so they can be mentioned, searched and relayed from, but can't receive relays. OpenClaw chats can be mentioned; relays and reviews go to Codex and Claude Code.
- Search reads the agents' own history files and keeps what was said in memory (under 40 MB for 20,000 messages), let go after 20 minutes without a search. The first search after that reads the files again (about 4 seconds for 1.4 GB of history); until it's done, recent chats are found first. Messages are searched up to their first 4,000 characters. OpenClaw conversations aren't searched yet, and Gemini CLI chats are found by name.
- The away report counts files from each finished turn's changes as the agent reported them; what an agent changed through a shell command isn't counted.

## Verification

October 7, 2026. These are automated results against stand-ins, plus measurements on this Mac's real history files. Nothing here has yet run against a live Codex or Claude Code turn.

- **Automated:** `test/turn-watch.test.mjs`, `test/relays.test.mjs`, `test/across-agents.test.mjs`, `test/across-agents-routes.test.mjs`, `test/across-agents-ui.test.mjs` and additions to `test/agent-move-sessions.test.mjs`. They cover:
  - finish detection: blips, stops and errors;
  - relay permissions, one send per step, expiry, lost access and restart uncertainty;
  - quoted-block escapes;
  - the real relay engine behind the HTTP routes, with an owner device and its folder check;
  - mention expansion;
  - journal, overlap and search indexing, including incremental reads, half-written lines and rewritten files;
  - each phone flow through the real components;
  - (October 8) the All page across computers, with stand-ins: one computer that answers (its clock ahead of this one), one that's away, one that refuses this phone, and one whose live connection turned it away. Each computer only ever got its own credentials. Through the whole app, a chat on another computer switched Reach to that computer and was read from there; tapped while that computer didn't answer, picking this computer again kept Reach here.
- **Full suite:** passed on the last commit with only these changes applied, with a production build.
- **Search on this Mac** (about 1.4 GB, 20,000 messages): about 4 s to read everything the first time, about 40 ms per search after, about 36 MB held. Reach's event loop was never held up more than 16 ms while reading.
- **Team tools, checked at no cost, with the real bridge** (`scripts/team-mcp.mjs`, a real key file, socket and team engine):
  - Codex 0.160, in an ephemeral thread (never saved or shown, no turn), started the bridge from the thread's `mcp_servers` config and listed the four team tools as connected. Called through Codex (`mcpServer/tool/call`), `team_roster` came back from Reach's team engine.
  - Claude Code 2.1.291, signed out in a temporary config folder with no model turn, launched with the exact flags Reach uses (team flags last), reported the bridge connected with the four tools.
  - Reach resumes a lead's Codex thread with the same config.
- **Not yet run live:**
  - a real team turn: whether either agent asks for approval before calling a team tool (Claude Code is started with them allowed);
  - a Codex review chat in its read-only sandbox;
  - a Claude Code review in Manual mode;
  - finish detection on real agents, especially Claude app chats, whose status comes from their registry;
  - the usage-limit notification;
  - a physical phone.
- **Claude app chats:** a review sent back (or a relay sent) to a Claude desktop app chat goes through the Claude app's own message box, as a message typed from the phone does. It waits while you use the app; the whole text is set at once, not typed key by key. How the app handles very long text there is untested.
- **Suggested first live check, after restarting Reach:** a second opinion on a throwaway chat, with the review sent back.

## Where it lives

- Server: `server/agent-sessions/relays.mjs` (relays, second opinions, helpers' reports), `teams.mjs`, `team-tools.mjs` and `team-bridge.mjs` (team chats; the lead's bridge is `scripts/team-mcp.mjs`), `turn-watch.mjs` (finished turns), `journal.mjs` (away report), `overlaps.mjs` (projects), `search.mjs`, `chat-context.mjs` (what goes between agents).
- Phone: `src/ChatHub.tsx` (the All page), `src/fleet-chats.ts` (asking every paired computer), `src/Relays.tsx` (second opinion, relays, the route drawing), `src/Teams.tsx` (team chats), `src/MentionMenu.tsx`, `src/UsageStrip.tsx`.
- API: [the HTTP API reference](API.md#working-across-agents).
