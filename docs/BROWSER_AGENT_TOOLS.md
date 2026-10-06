# Scoped tools for browser agents

Create an AI browser invitation in Reach, choose the shared resources, and share **Copy prompt + link** with Muse or another browser bot. Admission still requires the owner to match the connection code. Keep the invited tab open. The message states the issued invitation’s screen permission, actual shared folder paths, shared terminal outputs, and exact command permission. It explicitly says terminal commands cannot leave those folders, even with approval. Long folder lists name the first three and direct the agent to Files for the rest. Screen input and terminal access may be enabled together. Supported read commands run directly inside shared folders; the separate **Commands with approval** grant permits file changes and isolated scripts after exact owner approval. Later unsaved changes in the invite form do not change that message or the issued grant.

Use the **Screen**, **Files**, and **Terminal** tabs. With screen input enabled, Muse or another bot can click the shared screen directly, type text, or choose a key. Reach stages up to five exact actions and marks click targets on the image. Describe their purpose and choose **Ask approval**. The owner reviews the sequence once in Reach; nothing runs before approval. The workspace shows progress and lets the bot cancel remaining actions.

The screen stays still while preparing a sequence so the marked targets remain reviewable. Files and terminal access still follow the invitation's selected resources. No coordinates, JSON editor, JavaScript, or DevTools are needed for the ordinary screen workflow.

Bots with browser automation can optionally use the same session-bound interface through `window.reach`:

```js
const tools = await window.reach.listTools();
const access = await window.reach.callTool("reach_access", {});
const request = await window.reach.callTool("reach_request_batch", {
  reason: "Enter the document title and confirm it in the reviewed field.",
  actions: [
    { type: "text", text: "Project plan" },
    { type: "key", key: "enter" }
  ]
});
const results = await window.reach.callTool("reach_list_requests", {});
```

A request returns `pending`. Submission never approves it. Wait for the owner's decision in Reach and inspect the final status and every step; never retry pending or partially completed actions automatically.

Available tools depend on the current invitation:

| Tool | Access |
| --- | --- |
| `reach_access` | Current scope, shared roots, expiry |
| `reach_list_files`, `reach_search_files`, `reach_read_file` | Read only inside shared folders |
| `reach_read_terminal` | Output from explicitly shared terminals |
| `reach_terminal_command` | Supported reads run directly inside shared folders; file changes and isolated scripts require the separate grant and owner approval |
| `reach_terminal_history` | This session's command attempts and outcomes |
| `reach_screen` | Screen image, when viewing is granted |
| `reach_scroll` | Automatic scroll only when explicitly granted |
| `reach_request_action`, `reach_request_batch` | Propose exact screen inputs or restricted terminal reads for approval; file changes and scripts use single requests only |
| `reach_list_requests`, `reach_cancel_request` | Inspect or stop this session's requests |

`listTools()` returns exact schemas and examples. There is no invitation, owner-approval, generic HTTP, unrestricted file-write, or shell tool in this browser interface. The stdio MCP adapter advertises the same browser tools when connected with a compatible browser credential; existing native-agent profiles retain their own separate permissions. Browser Funnel credentials and their private keys stay in the invited browser and are not exported to MCP.

## Batch boundaries

A batch contains 1–5 immutable, ordered actions and one reason (12,000 UTF-8 bytes maximum). Screen and restricted-terminal actions cannot be mixed; nested batches and manual shell handoffs are rejected. Each restricted command supplies its own root and cwd. `cd` never changes a later batch action implicitly.

One owner approval executes only that list, once. Screen requests expire within 60 seconds; restricted command requests within five minutes; both are bounded by session expiry. Remaining actions expire 20 seconds after a screen batch starts, or 30 seconds after a restricted-command batch starts.

Reach compares the reviewed starting screenshot before the first screen input. The approved sequence may then change the screen, including operating Terminal or signed-in apps. Reach does not classify arbitrary clicks as safe or dangerous. The owner must review the entire sequence. A new sequence needs a new approval.

Every step rechecks the owner, session, granted scopes/folders, pause state, and existing macOS security-dialog guard. Stop, expiry, revocation, or failure prevents later steps. Already dispatched input may finish and completed actions cannot be undone. Results include `completedCount`, `attemptedCount`, and per-step status/output. Use **Stop remaining actions** in Reach or the screen workspace, or call `reach_cancel_request`, to cancel.

The tools reuse the existing signed, expiring Funnel session or private tailnet transport. They create no new public endpoint or standing control grant. Never forward an invitation, session credential, or tool bridge to another agent.

## Terminal commands and scripts

Reads (`pwd`, `cd`, `ls`, `cat`, `head`, `tail`, `wc`, `grep`) use Reach’s bounded implementations and run immediately. Supported file changes (`mkdir`, `touch`, `cp`, `rm`) need one-time owner approval. With **Commands with approval** enabled, other single commands and scripts also appear in Reach with their exact command and working folder and just **Approve once** / **Deny**. No reason form or lasting approval is required. Old read-only and file-change-only invitations do not automatically gain script permission.

Scripts use macOS Seatbelt, enforced before the program starts. A command can read/write the selected shared root; system executables and the trusted runtime libraries are read-only exceptions required to run it. Other personal folders and Reach’s private state are denied, including symlink escapes. Existing extra hard links and special files cause the script to be rejected. Node, system tools, and scripts in the shared folder are supported. No host environment or credentials are inherited. Network access, administrator commands, interprocess control, and launching helper processes are blocked. Consequently, scripts requiring subprocesses, package installation, or additional runtimes may fail; they never fall back to an unrestricted host shell. Other operating systems fail closed.

Requests expire within five minutes or when the invitation ends. Execution is limited to one process, 30 seconds, and 64 KiB of output. Cancellation, pause, expiry and revocation terminate that process. The command cannot be edited during approval or executed twice. File changes already made cannot be undone by cancellation. This is a filesystem/access sandbox, not a disk or memory quota; approve the actual script’s behavior before running it.

Each command attempt and outcome is kept in a private durable history, filtered to that agent’s session. Reach records an interrupted status after restart instead of replaying unfinished commands. If history cannot be recorded or reaches its bound, new work is blocked.

## Session command approvals

The owner can choose **Always approve this session** for a single terminal command. It remembers the exact command text, arguments, selected root and working directory for this invitation only; it never approves every command, a command prefix, or screen control. Each repeat still runs under the same sandbox, current permissions, limits and command logging. The first run must succeed before the approval is remembered.

Remembered approvals live only in host memory. Expiry, revocation, permission changes, pause or restart clears them; the approving owner must remain authorized. A new invitation always has a new identity and does not inherit past approvals, even when the agent name is identical. Agents cannot approve or extend permissions themselves. A remembered script command can run changed script contents inside the same folder, so keep using Approve once when you need to inspect each revision.
