# Scoped tools for browser agents

Create an AI browser invitation in Reach, choose the shared resources, and share **Copy prompt + link** with Muse or another browser bot. Admission still requires the owner to match the connection code. Keep the invited tab open. The message states the issued invitation’s screen permission, actual shared folder paths, shared terminal outputs, and exact command permission. It explicitly says terminal commands cannot leave those folders, even with approval. Long folder lists name the first three and direct the agent to Files for the rest. Screen input and terminal access may be enabled together. Supported read commands run directly inside shared folders; the separate **Commands with approval** grant permits file changes and isolated scripts after exact owner approval. Later unsaved changes in the invite form do not change that message or the issued grant.

Use the **Screen**, **Files**, and **Terminal** tabs. Screen shows only a window from an explicitly allowed app. Click the shared window or type into its supported controls directly. Extra app access appears in Reach as **Allow for this session** / **Deny**. Reach and Tailscale are permanently protected and cannot be requested or approved.

Bots with browser automation can use the same session-bound interface through `window.reach`:

```js
const tools = await window.reach.listTools();
const access = await window.reach.callTool("reach_access", {});
const apps = await window.reach.callTool("reach_apps", {});
```

`listTools()` provides the schemas for selecting an allowed app window, reading its image, sending supported inputs and requesting another app. Wait for the owner's decision when a request is pending. Never retry partially completed actions automatically.

Available tools depend on the current invitation:

| Tool | Access |
| --- | --- |
| `reach_access` | Current scope, shared roots, expiry |
| `reach_list_files`, `reach_search_files`, `reach_read_file` | Read only inside shared folders |
| `reach_read_terminal` | Output from explicitly shared terminals |
| `reach_terminal_command` | Supported reads run directly inside shared folders; file changes and isolated scripts require the separate grant and owner approval |
| `reach_terminal_history` | This session's command attempts and outcomes |
| `reach_apps`, `reach_app_windows`, `reach_app_screen`, `reach_app_input` | Selected apps and their approved window controls |
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

Scripts use macOS Seatbelt, enforced before the program starts. A command can read/write the selected shared root; system executables and the trusted runtime libraries are read-only exceptions required to run it. Other personal folders and Reach’s private state are denied, including symlink escapes. Existing extra hard links and special files cause the script to be rejected. Node, system tools, and scripts in the shared folder are supported. No host environment or credentials are inherited. Network access, administrator commands, interprocess control, and launching helper processes are blocked. Reach and Tailscale management commands are rejected before approval as well as at execution; approval never removes the sandbox. Consequently, scripts requiring subprocesses, package installation, or additional runtimes may fail; they never fall back to an unrestricted host shell. Other operating systems fail closed.

Requests expire within five minutes or when the invitation ends. Execution is limited to one process, 30 seconds, and 64 KiB of output. Cancellation, pause, expiry and revocation terminate that process. The command cannot be edited during approval or executed twice. File changes already made cannot be undone by cancellation. This is a filesystem/access sandbox, not a disk or memory quota; approve the actual script’s behavior before running it.

Each command attempt and outcome is kept in a private durable history, filtered to that agent’s session. Reach records an interrupted status after restart instead of replaying unfinished commands. If history cannot be recorded or reaches its bound, new work is blocked.

## Session command approvals

The owner can choose **Always approve this session** for a single terminal command. It remembers the exact command text, arguments, selected root and working directory for this invitation only; it never approves every command, a command prefix, or screen control. Each repeat still runs under the same sandbox, current permissions, limits and command logging. The first run must succeed before the approval is remembered.

Remembered approvals live only in host memory. Expiry, revocation, permission changes, pause or restart clears them; the approving owner must remain authorized. A new invitation always has a new identity and does not inherit past approvals, even when the agent name is identical. Agents cannot approve or extend permissions themselves. A remembered script command can run changed script contents inside the same folder, so keep using Approve once when you need to inspect each revision.

## App access on macOS

New browser invitations can share **Selected apps** with **Hidden**, **View only**,
or **View & control** access. The agent chooses one app window in Screen. Reach
captures that window directly using ScreenCaptureKit; it never sends the desktop
and obscures it in the guest browser. Every native operation verifies the signed
app, process launch identity, exact window, and current geometry. Input uses
Accessibility operations inside that window; there is no global keyboard/mouse
fallback. Secure fields, file dialogs, developer tools and protected apps are
unavailable. macOS 14+, Screen Recording and Accessibility are required.

The agent may request another app or control permission. Reach shows **Allow for
this session** and **Deny**. The grant belongs to the invitation UUID, expires
with it, and is never inherited by another invitation. Additional grants are
memory-only and are forgotten after a Reach restart. Reductions to initial app
permissions are saved, so a restart cannot restore an app the owner hid. Owners can hide an app or
reduce it to view-only in Manage app requests; ending the invitation revokes all
its permissions. Native helper operations are cancelled when access changes.

Create and approve these invitations from the same separately trusted phone or
computer using its native Tailscale connection. While such an invitation exists,
ordinary Reach APIs on this Mac are restricted to the pinned approving Tailscale
node. This includes same-node automatic owner admission and existing owner
sessions. Browser/WASM Tailscale nodes are not approval devices. Agent credentials
continue to reach only explicitly allowed browser endpoints. This relies on the
owner's trusted Tailscale enrollment, not hardware attestation.

This boundary controls which native window pixels and controls Reach exposes.
It does not sandbox the allowed app's effects. An allowed browser includes its
accounts, extensions and websites. Some custom/canvas controls are unsupported;
Reach stops instead of sending an unrestricted click. Read-only metadata and
mocked tests do not substitute for testing capture/input in the actual macOS
permission context.

App tools: `reach_apps`, `reach_app_windows`, `reach_app_screen`, `reach_app_input`,
and `reach_request_app`. The opaque window target comes from `reach_app_windows`;
never supply a PID or native window ID. Use `reach_list_requests` for approval
results. File and terminal tools retain their independent folder limits.

## Protected owner controls

Reach and Tailscale native apps are permanently unavailable to invited browser agents. The catalog, initial selections, stored grants, access requests, approvals, window targets and native helper enforce this independently. Renaming the installed app does not change its signed bundle identity. These protections cannot be overridden by a session approval.

Allowed browser windows must expose a verifiable actual page/document URL. Reach rejects its configured owner origins, Tailscale domains, tailnet/local hosts, literal IP addresses and non-HTTP(S) browser pages. Checks run before and after capture/input, on clicked link ancestors, and against the complete address produced by editing an address field. Unknown page identity fails closed. Unrelated allowed apps still use window-bound capture and Accessibility input.

These browser URL checks are defense in depth, not network isolation or an atomic navigation/capture guarantee. Redirects, background JavaScript, DNS aliases/rebinding and web proxies can issue requests independently of Reach's input checks. A managed isolated browser with enforced network policy is needed for a categorical network guarantee. The owner API's separate device/session authorization remains the hard boundary for Reach management. Reach cannot control the agent's own VM browser. The agent's signed guest workspace intentionally remains reachable through Funnel without granting tailnet membership or owner permissions.
