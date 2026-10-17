# Delegate local coding tasks

An external agent such as Grok or Muse can ask the Codex or Claude Code installation on your computer to work on a project, follow progress, retrieve the result and cancel the task. The coding engine uses your existing local sign-in and account. It must already be installed and ready to use.

These tools are available to agents with current **Full control** access. Apps, Files and Read only do not grant delegation. Older non-browser credentials with the `codex` scope can delegate to Codex only.

| Tool | Purpose |
| --- | --- |
| `reach_start_coding_task` | Start one task in a selected project folder. Returns immediately with a task ID. |
| `reach_get_coding_task` | Read its status, summary, recorded commands and file changes. Optionally wait for an update. |
| `reach_list_coding_tasks` | List the requesting agent's most recent tasks, up to 50 within the response limit. |
| `reach_cancel_coding_task` | Interrupt that task's original turn. Completed actions and file changes remain. |

Each invited agent sees only tasks it created. These tools cannot list your other chats, continue an existing chat, answer an approval prompt, change the engine's permissions or choose arbitrary configuration and CLI options.

## Start and follow a task

Check `reach_access` for the current folder roots. The project is a root index and a relative path, as in Reach's file tools. For example, with a root containing `Projects/demo`, pass these arguments to `reach_start_coding_task`:

```json
{
  "requestId": "demo-login-fix-001",
  "agent": "codex",
  "root": 0,
  "path": "Projects/demo",
  "title": "Fix the login test",
  "task": "Reproduce the failing login test, fix the cause, and run the relevant checks. Report what changed and any remaining failures.",
  "timeoutSeconds": 1800
}
```

Use `"agent": "claude"` for Claude Code. **Reuse the same requestId and arguments after a lost response.** Reach returns the existing task instead of launching it again. Reusing that ID for different arguments is an error.

Read the returned `id` with `reach_get_coding_task`. For efficient progress updates, include the last returned `version` as `after` and set `waitSeconds` to 25. The response arrives when the task changes or that wait ends. Cancellation takes only the task ID.

Task states are `starting`, `running`, `waiting`, `completed`, `failed`, `cancelling`, `cancelled`, `interrupted` and `uncertain`. `waiting` sets `needsOwner: true`: open the local chat in Reach to answer the engine's request. The external agent cannot approve it. `cancellationPending: true` means an interrupt is still unconfirmed, including after a provider error. An uncertain start or stop needs inspection in Reach; it is never automatically retried as a new task.

## Permissions, results and lifecycle

Codex starts in workspace-write mode with user approval for actions requiring it. Claude starts in Manual mode. The owner handles approval cards through Reach's existing Chat interface. The project folder selects where work starts; it is not an additional filesystem sandbox for Claude. Full control already grants trusted access as the owner's OS account.

Results include the agent's summary, command records with their reported status and output, and file-change records with their diffs. An assistant saying tests passed is a claim; only recorded command output supplies execution evidence. Diffs come from that task's transcript, rather than a whole-project diff that could include earlier edits. Some provider tools do not record a diff or command, so the corresponding evidence may be absent.

Results are bounded. `truncated` marks omitted or clipped output; `historyIncomplete` means Reach could not establish complete task history. Reach reads at most 800 transcript items when locating the original task. It never substitutes a later owner's conversation when the original task cannot be found. A finished result is frozen before subsequent chat turns.

At most two tasks per agent and four across Reach can be active. The default deadline is 30 minutes, with a maximum of one hour, further limited by the invitation's expiry and any owner policy. Pausing that agent, ending its access, removing its project or reaching its deadline requests cancellation even if it has disconnected. Credential rotation keeps task ownership. Reach's global pause follows existing chat behavior; use the individual agent's Pause or the task's Cancel to end its delegated work.

Reach persists task IDs before dispatch. Restarted tasks are marked interrupted or uncertain and are not automatically resumed. Shutdown requests an interrupt before releasing the coding-engine connections. If the engine does not acknowledge a stop, Reach keeps that uncertainty visible and retries while running. The ledger retains up to 2,000 tasks; it refuses new work if that history is full or unreadable, preserving the original request IDs.

The transport and lifecycle logic is shared by macOS and Windows hosts. All four tools use the same authorization through stdio MCP, hosted MCP and signed Funnel requests. After upgrading Reach, refresh the agent runtime/tool list to discover them.
