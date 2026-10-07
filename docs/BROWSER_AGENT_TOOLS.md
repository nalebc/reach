# Scoped tools for browser agents

Create an AI browser invitation in Reach, choose the shared resources, and share **Copy prompt + link** with Muse or another browser bot. Admission still requires the owner to match the connection code. Keep the invited tab open. The message states the issued invitation’s screen permission, actual shared folder paths, shared terminal outputs, and exact command permission. It explicitly says terminal commands cannot leave those folders, even with approval. Long folder lists name the first three and direct the agent to Files for the rest. Selected app viewing and terminal access may be enabled together. Supported read commands run directly inside shared folders; the separate **Commands with approval** grant permits file changes and isolated scripts after exact owner approval. Later unsaved changes in the invite form do not change that message or the issued grant.

Use the **Screen**, **Files**, and **Terminal** tabs. Screen shows only a window from an explicitly allowed app. Host app sharing is view-only; host input is disabled until an isolated execution environment exists. Extra app access appears in Reach as **Allow for this session** / **Deny**. Reach and Tailscale are permanently protected and cannot be requested or approved.

Bots with browser automation can use the same session-bound interface through `window.reach`:

```js
const tools = await window.reach.listTools();
const access = await window.reach.callTool("reach_access", {});
const apps = await window.reach.callTool("reach_apps", {});
```

`listTools()` provides the schemas for selecting an allowed app window, reading its image and requesting another eligible app. Wait for the owner's decision when a request is pending. Never retry partially completed actions automatically.

Available tools depend on the current invitation:

| Tool | Access |
| --- | --- |
| `reach_access` | Current scope, shared roots, expiry |
| `reach_list_files`, `reach_search_files`, `reach_read_file` | Read only inside shared folders |
| `reach_read_terminal` | Output from explicitly shared terminals |
| `reach_terminal_command` | Supported reads run directly inside shared folders; file changes and isolated scripts require the separate grant and owner approval |
| `reach_terminal_history` | This session's command attempts and outcomes |
| `reach_apps`, `reach_app_windows`, `reach_app_screen` | Selected apps and their approved window images |
| `reach_request_app` | Ask the owner for session access to another eligible app |
| `reach_request_action`, `reach_request_batch` | Propose restricted terminal reads; file changes and scripts use single requests only |
| `reach_list_requests`, `reach_cancel_request` | Inspect or stop this session's requests |

`listTools()` returns exact schemas and examples. There is no invitation, owner-approval, generic HTTP, unrestricted file-write, or shell tool in this browser interface. The stdio MCP adapter advertises the same browser tools when connected with a compatible browser credential; existing native-agent profiles retain their own separate permissions. Browser Funnel credentials and their private keys stay in the invited browser and are not exported to MCP.

## Retired desktop access and terminal batches

Whole-desktop browser sharing and its click/type/key/scroll approvals are retired. Existing invitations using `view`, `scroll` or `ask` report screen access as off and require a new **Selected apps** invitation. Both the HTTP routes and approval executor reject the old operations, including previously queued requests. File and terminal permissions remain independently scoped.

Terminal batches contain 1–5 immutable, ordered restricted reads, each with its own root and working directory. One owner approval executes that list once. Requests expire within five minutes or at session expiry; remaining actions expire 30 seconds after execution starts. Permission changes, pause, cancellation, expiry and failure stop remaining work. Completed changes cannot be undone.

The tools reuse the existing signed, expiring Funnel session or private tailnet transport. They create no new public endpoint or standing control grant. Never forward an invitation, session credential, or tool bridge to another agent.

## Terminal commands and scripts

Reads (`pwd`, `cd`, `ls`, `cat`, `head`, `tail`, `wc`, `grep`) use Reach’s bounded implementations and run immediately. Supported file changes (`mkdir`, `touch`, `cp`, `rm`) need one-time owner approval. With **Commands with approval** enabled, other single commands and scripts also appear in Reach with their exact command and working folder and just **Approve once** / **Deny**. No reason form or lasting approval is required. Old read-only and file-change-only invitations do not automatically gain script permission.

Scripts use macOS Seatbelt, enforced before the program starts. A command can read/write the selected shared root; system executables and the trusted runtime libraries are read-only exceptions required to run it. Other personal folders and Reach’s private state are denied, including symlink escapes. Existing extra hard links and special files are inaccessible to scripts; their paths are checked before each run and their containing folders cannot be renamed during execution. A path argument outside the shared folder, including `~`, is refused before approval. Node, system tools, and scripts in the shared folder are supported. No host environment or credentials are inherited. Network access, administrator commands, interprocess control, and launching helper processes are blocked. Reach and Tailscale management commands are rejected before approval as well as at execution; approval never removes the sandbox. Consequently, scripts requiring subprocesses, package installation, or additional runtimes may fail; they never fall back to an unrestricted host shell. Other operating systems fail closed.

Requests expire within five minutes or when the invitation ends. Execution is limited to one process, 30 seconds, and 64 KiB of output. Cancellation, pause, expiry and revocation terminate that process. The command cannot be edited during approval or executed twice. File changes already made cannot be undone by cancellation. This is a filesystem/access sandbox, not a disk or memory quota; approve the actual script’s behavior before running it.

Each command attempt and outcome is kept in a private durable history, filtered to that agent’s session. Reach records an interrupted status after restart instead of replaying unfinished commands. If history cannot be recorded or reaches its bound, new work is blocked.

## Session command approvals

The owner can choose **Always approve this session** for a single terminal command. It remembers the exact command text, arguments, selected root and working directory for this invitation only; it never approves every command, a command prefix, or screen control. Each repeat still runs under the same sandbox, current permissions, limits and command logging. The first run must succeed before the approval is remembered.

Remembered approvals live only in host memory. Expiry, revocation, permission changes, pause or restart clears them; the approving owner must remain authorized. A new invitation always has a new identity and does not inherit past approvals, even when the agent name is identical. Agents cannot approve or extend permissions themselves. A remembered script command can run changed script contents inside the same folder, so keep using Approve once when you need to inspect each revision.

## App access on macOS

Selected apps are **Hidden** or **View only**. Native input is disabled at the route, manager, JavaScript helper wrapper and Swift helper. Old control grants expose at most viewing; new control grants and approval requests fail. Reach, Tailscale, host browsers, embedded webviews, secure fields and protected system apps cannot be shared. Owners can approve viewing of another eligible app for the current invitation only.

The helper requires macOS 14.2+, Screen Recording and Accessibility. It captures one verified signed app window with child windows excluded; it never captures the desktop and hides it later with CSS. Window targets bind the app signature, process launch identity and geometry. Revocation, pause, expiry and permission changes abort helper operations and invalidate targets. Capture checks cannot guarantee atomic semantic redaction of changing pixels; owners should share windows whose entire content is appropriate for the agent.

Create and approve app invitations from a separately trusted phone/computer with native Tailscale. Ordinary Reach APIs, owner admission and download links remain restricted to the pinned approving device while the invitation exists. Revoking or expiring that device ends the agent's app access. Corrupt credential storage fails closed. App credentials bind the exact approving device and policy; older app invitations need replacement after this security update.

App tools: `reach_apps`, `reach_app_windows`, `reach_app_screen`, and `reach_request_app` (view only). Window targets and additional grants are invitation-specific. A new invitation never inherits them. The public guest workspace remains available through the signed, expiring Funnel capability; it grants no owner API access or new invitations.

## Filesystem enforcement

Browser-agent Files, searches, restricted reads and approved mutations use a macOS native helper with descriptor-relative `openat` traversal and `O_NOFOLLOW` at every component. The helper installs a kernel sandbox before operating on shared data. Symlinks, extra hard links, special files and directory swaps cannot broaden access. Requests recheck the live session before releasing output. Platforms without this boundary fail closed.

Choose a project/data folder, such as Desktop or a project beneath it. Home itself, filesystem roots, system/install locations and runtime directories cannot be agent roots. Reach source/state, credentials, browser profiles, shell startup files and Git configuration/hooks are excluded even beneath broader shares. Scripts cannot rename protected ancestors, create hard links, modify trusted runtime libraries or start helper processes. Shared project source remains untrusted code: approval does not make files safe to execute later outside the sandbox.

File downloads are bounded to 25 MiB and text reads to 1 MiB. Native document conversion is unavailable to agents; download the bounded bytes and parse them in the agent's own environment. Explicitly shared terminal output is content access and may contain secrets already printed there.

## Isolation boundary

An app allowlist and Accessibility checks cannot confine the effects of an owner's existing apps. A normal button can launch another app, use IPC, perform network requests or execute code. Browser URL checks additionally race with redirects, background requests and changing pixels. Host app control and host browsers therefore remain unavailable until a separate OS/VM environment or narrow application adapter enforces the intended capabilities. A separate browser profile alone is insufficient for a categorical host/network guarantee.

These restrictions cover browser invitations, including Muse and other bots using that flow. Legacy CLI credentials with `exec`, `terminal` or `apps:drive` are separate high-trust capabilities and must not be represented as equivalent folder sandboxes. This review did not certify those capabilities or privileged local software against compromise.


## Multiple browser agents

Use **Settings → Agents** to invite and manage independent browser sessions. Each card identifies the invitation, its exact folders, permissions, expiry, current folder work, pending connection/action approvals and recent command records. Identical display names never join sessions or share approvals. **Stop** revokes one invitation; **Stop all** confirms the exact displayed session IDs and leaves newer invitations alone. These controls are owner-only and do not manage high-trust legacy CLI credentials.

Approved scripts and file mutations share a server-side writer coordinator. It holds an exclusive lease for the entire granted root, including overlapping parent/child roots and filesystem aliases. Scripts count as writers regardless of their command text. Unrelated folders may progress concurrently; readers remain concurrent and do not receive a consistent filesystem snapshot. Conflicting writers wait in order for at most 30 seconds, with at most 20 waiting globally and three per session. Two scripts may run globally, one per session. Authorization and folder identity are checked while waiting and before execution. Cancelling running work retains its lease until the child process or native helper has actually stopped.

Before and after a writer runs, Reach clears other agents' remembered mutating-command approvals for overlapping folders and cancels their pending or queued mutation/script approvals. They must request fresh approval. This also covers approvals created during another writer's operation and commands still flushing their completion records. The writer's own exact-command approvals remain scoped to its invitation.

Agents always work in the real folders you share; Reach never copies them. Reach controls what an agent can do there: it reads files directly, commands are read-only, and any change waits for your approval, one at a time. Shared folders are intentionally shared data: an approved change is visible to every agent with access to that folder. Reach does not coordinate unsandboxed owner/CLI writes or make script contents immutable. The existing protected-app and view-only restrictions remain enforced. Funnel stays open only while at least one valid invitation or session needs it; a new invitation never extends another session's credential.
