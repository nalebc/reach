# Reach HTTP API

Base URL: `https://computer.tailnet.ts.net:8443`. Every API endpoint except `/api/health` and `/api/pair` requires `Authorization: Bearer TOKEN`. Remote clients must use HTTPS. Requests and responses are JSON unless indicated. Errors have `{ "error": "message" }` and an appropriate HTTP status.

## Pairing and identity

- `GET /api/health` — product and version, no personal information.
- `POST /api/pair` — `{code, name}`. Exchanges the single-use local code for `{token, clientId, device}`. Codes expire after ten minutes; five attempts per minute per transport address. Native clients and browsers use the same API.
- `GET /api/device` — device metadata, capabilities, shared folder roots, Tailscale state.
- `GET /api/clients` — full-access browser clients only.
- `DELETE /api/clients/:id` — revoke a credential and close its open terminal sockets.

Device responses include an installation `id` and a `computerId` derived from a hash of the OS machine identity. Resetting Reach's data changes the installation ID but normally preserves the computer identity. If the OS identity cannot be read, Reach retains its saved identity or falls back to the installation ID. OS reinstalls or cloned machine identities may require manual reconciliation. Neither identifier authorizes access; pairing credentials remain required. Clients use this identity to keep one computer entry across pairings, preferring connections that successfully authenticate. Display names never determine identity, and terminal/chat sessions remain separate.

Device `capabilities` combine credential scopes with host support. `screen` means supported and viewing enabled; `screenSupported` means this OS supports screen access and the credential has screen scope. `codex` means the credential has Codex scope and a local executable is detected (cached for 30 seconds); clients also check `/api/codex/status` for account readiness before offering conversations. `tools.codex.installed` is returned only to clients with Codex scope. Capability discovery never authorizes an operation: every endpoint keeps its existing scope and lease checks.

## Files — scope `files`, or agent `files:read` / `files:write`

`root` is the numeric shared-folder ID returned by `/api/device`; default `0`. For profiled agents, these indices refer only to that credential's allowed folders. `path` is relative to that folder. URL-encode query parameters. Absolute paths, traversal outside roots, and symlinks outside roots are rejected. Companion-private data and the agent policy file are excluded. GET/HEAD require `files:read`; mutations require `files:write`. The legacy `files` scope includes both.

- `GET /api/files?root=0&path=Documents&hidden=0` — `{items, path, truncated}`. Each item includes name, path, type, size, modified. Up to 2,000 directory entries.
- `GET /api/files/text?root=0&path=Documents/example.txt` — `{text}`, up to 1 MB. Binary previews are rejected.
- `GET /api/files/icons?types=folder,pdf,docx` — `{icons: {[type]: dataUrl | null}}`: the icon the computer's own file manager shows for each type (Finder on Mac, Explorer on Windows, the desktop icon theme on Linux). Up to 64 types: `folder`, `file`, or a lowercase extension of up to 16 letters/digits. Containers and machines without an icon set return `null`, and clients keep their built-in icons. Clients cache these on the device and refresh weekly.
- `GET /api/files/document-text?root=0&path=Documents/Contract.docx` — `{text}` extracted from a `.doc`, `.docx`, `.rtf` or `.odt` file (Mac, via `textutil`; 501 elsewhere) for preview and copy. Documents up to 25 MB, text up to 1 MB. Read-only: the response has no `sha256`, so it can never be written back over the document.
- `PUT /api/files/text?root=0&path=notes.txt` — `{text,sha256}`. The GET response also includes `sha256`; supply that last-read value to avoid overwriting an intervening edit. Existing text files only, new text up to 128 KiB, no NUL bytes. Atomic replacement; changed content returns 409. Concurrent malicious local filesystem races are outside this guarantee.
- `GET /api/files/content?root=0&path=Documents/example.pdf` — binary attachment. Supports `Range` (206) with `If-Range`, so clients resume a dropped download only while the file is unchanged.
- `GET /api/files/download-link?root=0&path=Documents/example.pdf` — `{url, expiresIn}`: a `/download/<token>` link for the browser's own download manager. Tokens are 256-bit, in memory only, valid 10 minutes, and name one file. Each use re-verifies the issuing credential from its hash (revocation, expiry, Tailscale identity and node, guest folders, agent policy), re-resolves the path, and refuses a file modified since (410). Responses are `attachment` and `no-store`, and support `Range`.
- `POST /api/files/uploads` — `{root, path, name, size}` starts a resumable upload: `{id, offset, chunk}`. Checks the name, that it doesn't exist yet (409), and free space on the computer (507). Default limit 50 GB; at most 8 uploads at once per credential.
- `PUT /api/files/uploads/:id?offset=N` — raw bytes (`application/octet-stream`), up to 16 MB, exactly at the offset the computer has; otherwise 409 with `{offset}` to continue from. Returns `{offset}`.
- `GET /api/files/uploads/:id` — `{offset, size}`, to resume after a dropped connection.
- `POST /api/files/uploads/:id/complete` — publishes the file once every byte has arrived; never over an existing file (409); 404 if the folder no longer exists. `DELETE /api/files/uploads/:id` cancels. Upload sessions belong to the credential that started them, and partial files are removed when finished, cancelled, idle for a day, or when Reach restarts.
- `POST /api/files/upload?root=0&path=Downloads` — multipart field `file`, max 100 MB. Existing names produce 409. Hidden filenames are rejected for uploads.
- `POST /api/files/folder` — `{root, path, name}`.

## Command jobs — scope `exec`

```http
POST /api/jobs
Authorization: Bearer TOKEN
Content-Type: application/json

{"command":"git status --short","root":0,"path":"Documents/project","timeoutMs":60000}
```

Returns **202** and `{id, clientId, command, cwd, status, createdAt, output, exitCode, timeoutMs}`. Run commands only with the user's authorization. Commands run as the companion's OS user, not in a container or a filesystem sandbox.

- `GET /api/jobs` — own jobs; full-access browsers can see all.
- `GET /api/jobs/:id` — poll output/status; complete jobs include `finishedAt`.
- `DELETE /api/jobs/:id` — cancel the job/process tree.

States: `running`, `completed`, `failed`, `timed_out`, `cancelled`, `interrupted`. Timeout 1 second–1 hour; eight concurrent jobs. A restart marks formerly running jobs interrupted. Output retains the latest 256 KiB.

## Terminals — scope `terminal`

- `GET /api/terminals` — list live and exited session metadata.
- `POST /api/terminals` — `{root, path, name}`; starts a real PTY.
- `DELETE /api/terminals/:id` — stop its shell.

Connect to `wss://computer.tailnet.ts.net:8443/ws/terminal`. Authenticate in the **first message**, within five seconds:

```json
{ "type": "auth", "token": "TOKEN", "sessionId": "ID" }
```

Do not place tokens in URLs. Incoming: `snapshot` (buffer and status), `data` (output and sequence number), `exit` (exitCode), `error`. Outgoing after authentication:

```json
{"type":"input","data":"pwd\r"}
{"type":"resize","cols":90,"rows":28}
```

Closing the socket does not kill the terminal. Reconnect with the same session ID for a fresh snapshot. Companion restarts do end terminals. Maximum 12 running terminals; input frames up to 32 KiB.

### Existing Mac terminals — scopes `terminal` and `admin`

These endpoints control Apple Terminal tabs and iTerm2 panes outside Reach. Discovery does not launch apps and may request macOS Automation permission. The Mac terminal UI discovers on opening, refreshes the list every five seconds, and reads selected output about every 1.5 seconds. Background/hidden views pause polling. They do not attach to, resize, or replace the underlying PTY. Output is visible text only (up to 128,000 characters); input is text plus Enter. No terminal contents or sent text are added to Reach's activity log. Scoped agents cannot access these endpoints. Desktop sessions are not killed when Reach stops.

- `GET /api/terminals/desktop` — `{sessions,providers}`. Each session has opaque `id`, `provider`, `name`, and `tty`. Each provider includes its running state or a permission/error message. Re-discover after a companion restart. IDs include the native app's launch identity and tab/pane identity; titles and tab positions are not identities.
- `POST /api/terminals/desktop` — `{provider:"terminal"|"iterm2"}`. Explicitly opens a new window; may launch the selected app.
- `GET /api/terminals/desktop/:id` — `{text}` for that existing session.
- `POST /api/terminals/desktop/:id/send` — `{text}` (1–16,000 characters; non-whitespace, no control codes except tabs/newlines). Goes to the currently running program, which may not be a shell. Do not automatically retry a send after a timeout: it may already have been delivered.
- `POST /api/terminals/desktop/:id/focus` — brings that session to the front on the Mac.
- `POST /api/terminals/desktop/:id/close` — `{confirm:true}`. Requests closing only that tab/pane. Running work can stop; closing the terminal that runs Reach also disconnects the companion. The native app may show a close confirmation on the Mac.

Only one native terminal operation runs at a time; concurrent calls receive 409. Native operations time out after 15 seconds. Revocation is checked before dispatch and before returning results; already-dispatched commands cannot be undone. Display names are never used to select a target. Unsupported hosts receive 409.

## Apps — scope `apps`

- `GET /api/apps` — installed `{id, name}` entries.
- `POST /api/apps/launch` — `{id}` from the app list. Launches on the computer's desktop.
- `POST /api/apps/icons` — owner only (`admin` and `apps`). `{ids}`, 1–64 ids from the app list. Returns `{icons: {[id]: dataUrl | null}}` with 128 px PNG logos (Mac only; `null` elsewhere). Ids that aren't installed are omitted and never reach the native reader. Concurrent requests share one native lookup. Clients keep the logos on the device and refresh them weekly.

## Codex — scope `codex`

- `GET /api/codex/status` — installed/running and signed-in state.
- `GET /api/chats` — Reach chat summaries.
- `POST /api/chats` — `{root, path, name}`.
- `GET /api/chats/:id` — transcript, status, pending approvals, errors. Poll at ~1 second while active.
- `POST /api/chats/:id/messages` — `{text}`.
- `POST /api/chats/:id/stop` — interrupt the current turn.
- `POST /api/chats/:id/approvals/:requestId` — `{decision:"accept"}` or `{decision:"decline"}` for command/file approvals; `{answers:{questionId:"answer"}}` for user questions. Never grant an approval without the user's authorization.

Unknown approval types fail closed. The MCP adapter intentionally omits approval-granting tools.

## Screen — scope `screen`, viewing must be enabled

`GET /api/screen/displays` returns the current display IDs, names, primary flag, and bounds. Requires enabled viewing and `screen` scope.

`WS /ws/screen` uses the same exact Host/Origin and Funnel restrictions as the terminal socket. Authenticate within five seconds with `{type:"auth",token:"...",protocol:2,display:"primary",quality:"balanced",format:"h264"}`. Display is `primary` or an ID from the display list; quality is `auto` (used by the UI), `saver`, `balanced`, or `smooth`; format is `h264` or `jpeg`. Credentials never appear in the URL. The ready message includes the resolved display, negotiated format, target fps, width, and bitrate. Windows without FFmpeg negotiates JPEG.

Binary packets start with a uint32 big-endian sequence ID. JPEG packets contain the image after this prefix. H.264 packets contain another uint32 big-endian JSON header length, then `{key,timestamp,width,height,codec}`, then Annex B encoded bytes. Timestamps are microseconds. Keyframes contain parameter sets. ACK with `{type:"ack",id}` after admitting into a bounded decoder queue (JPEG: after drawing); use `keyframe:true` when recovery needs an IDR. Each viewer has at most six unacknowledged packets and an outgoing-buffer threshold; slow viewers resume at a keyframe. Invalid ACKs close the session; an outstanding packet times out after ten seconds. Up to four protocol-2 viewers share capture for identical display/quality/format settings. The legacy JPEG protocol remains available to old clients with its separate four-viewer limit and one-frame acknowledgment window. Frame bodies are capped at 8 MiB.

Access is rechecked before every delivered frame; expiry/revocation/disablement closes streams. Last-viewer disconnect stops that group's native capture. Errors arrive as `{type:"error",error:"..."}` followed by closure. Video grants no input permission.

`WS /ws/screen-input` requires `admin` + `screen`, enabled viewing, and a separately acquired `/api/screen/control` grant. Authenticate with `{type:"auth",token:"...",display:"42"}`. Use the display ID resolved by the video ready message. Ready includes an initial normalized cursor position when available. Ready advertises `window:8` and `typing:true` when focused typing is supported. Send up to eight unacknowledged `{type:"input",id,action}` messages with strictly increasing integer IDs. Match `{type:"ack",id,...result}` by ID: coalesced motion may be acknowledged before an earlier native action completes. Older servers without `window` require one outstanding action. The host dispatches serially, coalesces consecutive queued moves, and rejects excessive or stale queued input. A second input socket for the same client is rejected. Actions are:

- `move`, `down`, `up`, `click`: normalized finite `x,y` in `[0,1]`, `button: "left"|"right"`, click `count:1|2`.
- `scroll`: finite `dx,dy`, each between -120 and 120.
- `key`: letter, digit, F1–F12, navigation key, space, enter, tab, escape, backspace, or delete; unique `modifiers` from `meta,alt,control,shift`.
- `text`: UTF-8 text up to 8 KiB.
- `focus`: optional normalized `x,y` click coordinates. Returns `target:{editable:false}` or `target:{editable:true,focus,secure}` using OS accessibility metadata. Coordinates must fall within the focused field. No field contents are returned.
- `type-edit`: `{focus,delete,text}` requires the current focus token, deletes 0–256 characters by Backspace, then inserts up to 8,000 UTF-8 bytes. `key` also accepts `focus` to guard Enter/Backspace/Tab dispatch. Tokens are scoped to the native input helper; they do not replace owner authentication or the control lease.
- `selection-read`: explicitly reads the currently focused app’s accessible selected text, capped at 16 KiB; password fields are rejected. No selection/unsupported app returns an error, never stale clipboard contents.
- `clipboard-read`: returns text, capped at 16 KiB. `clipboard-write`: text up to 16 KiB. Neither is automatic.
- `release`: release held mouse buttons. `heartbeat`: keep the active control connection alive without generating input.

Successful actions renew the existing control lease; the browser sends idle heartbeats every 500 ms. Revocation/expiry are checked before and after native actions and at least every 500 ms. Idle connections close after three seconds. Native helpers release held buttons after two seconds without messages, and on normal shutdown. Payload/rate limits apply; clipboard data is never returned after a failed authorization recheck. Already-dispatched OS actions cannot be recalled.

- `GET /api/screen` — primary-display JPEG, only while screen viewing is enabled in Settings or by `REACH_SCREEN=1`, and the OS permits capture. No-store response; overlapping requests share a capture.
- `POST /api/screen/control` — `{enabled:true}` acquires/renews a 30-second input grant for the authenticated full-access paired browser. Requires `admin` as well as `screen` scope. Returns `{enabled:true,expiresAt}`; another controller receives 409. `{enabled:false}` releases the caller's grant. Renew every 10 seconds while the viewer is active. Grants are memory-only and do not survive restart.
- `POST /api/screen/input` — requires the caller's unexpired control grant plus enabled screen viewing. Accepts `{type:"click",x:0.5,y:0.5,button:"left",count:1}` (normalized coordinates; left/right; count 1 or 2), `{type:"scroll",delta:-3}` (integer -10 through 10, nonzero; positive scrolls up), `{type:"text",text:"hello"}` (max 2,000 characters), or `{type:"key",key:"enter"}`. Returns 409 while another native input operation or a persistent input channel is active. Permission is rechecked before dispatch, including after helper compilation.

Keys: enter, backspace, tab, escape, left, right, up, down. Mac capture needs Screen Recording permission; input also needs Accessibility. Windows needs an unlocked interactive desktop. No lock-screen bypass. Revoke a client or disable screen viewing to invalidate its control grant. Already-dispatched OS input cannot be undone.

### Apps on your phone — scopes `admin` + `screen`, Mac only

Each app opened on the phone runs on the Mac on its own hidden display (macOS `CGVirtualDisplay`, checked at runtime), in a window shaped like the phone. Only that window is streamed. See [Apps on your phone](APP_THREADS.md).

- `GET /api/screen/apps` — this computer's app threads, newest first: `{id,appId,name,state,createdAt}` plus, while `running`, `display`, `region:{x,y,w,h}` (the window, in display points), `size:{w,h}` (the hidden display) and `scale`. States: `starting`, `running`, `paused` (after a restart or "Return all"; reopen with POST), `closed` (the app closed its window).
- `POST /api/screen/apps` — `{appId,width,height}`: an `id` from `GET /api/apps` and the phone's usable screen in points (200–1000). Opens the app on a hidden display, or resumes its existing thread, and returns the thread. Browsers, Finder and Terminal get a new window; other apps lend their main window and get it back. Up to four threads. 404 for unknown apps, 501 off macOS, 403 with screen viewing off or without Accessibility for Reach.
- `PATCH /api/screen/apps/:id` — `{width,height}` after the phone rotates: reshapes the window (the display is already sized for both orientations).
- `POST /api/screen/apps/:id/activate` — brings the app forward on the Mac.
- `POST /api/screen/apps/:id/quit` — `{confirm}`: quits the app like ⌘Q. Returns `{confirm:true,others}` without quitting when the app also has windows on the Mac's own screens (send again with `confirm:true`), `{quit:true}` once it quit, or `{quit:false,waiting:true}` while it asks something (unsaved work); the thread ends when it quits. Apps that quit on the Mac end their threads too.
- `GET /api/screen/apps/:id/fields` — `{fields:[{x,y,w,h,secure}],complete}`: the window's visible text fields in points from its top-left (a bounded accessibility walk), so a tap on one can open the phone keyboard within the tap.
- `DELETE /api/screen/apps/:id` — gives it back: a window Reach opened is closed (if closing is blocked, it moves to the main screen instead), a lent window returns to its exact frame. Returns `{closed,returned}`.

Video: `WS /ws/screen` with `thread:"<id>"` in the auth message streams that window only, at its full Retina resolution, 60 fps and up to 12 Mbps, without the pointer; the usual auto mode lowers frame rate and bitrate on a slow connection. A window change or rotation ends the stream as retryable (reconnect for the new crop); returning the app ends it for good. Input: the existing `WS /ws/screen-input` with the thread's `display`; map 0..1 window coordinates through `region` and `size`. Presence `changes` include `apps` for owners. Hidden displays are omitted from `GET /api/screen/displays`.

### Temporary guest access

- `POST /api/guests` (admin): `{name, ttlSeconds, roots: [0], write: true, screen: false}`. Returns `{invitation, clientId, expiresAt, scopes, url}`. `roots` uses the owner's `/api/device` root IDs. Duration must be an integer from 60 to 86400 seconds. Only the explicitly selected file permissions and optional view-only screen access are granted.
- Send the guest `https://<reach-host>/guest#invite=<invitation>`. The time window starts when the invitation is created.
- `POST /api/guest/redeem` (no credential): `{invitation}`. Atomically exchanges a one-use invitation for `{token, clientId, expiresAt, device}` without extending expiry.
- `GET /api/clients` (admin) includes guest expiry, kind, and `invited`, `accepted`, or `expired` status, never invitation hashes. `accepted` means redeemed, not currently online.
- `DELETE /api/clients/:id` (admin) revokes an unused invitation or active guest.
- `DELETE /api/device/access` revokes the calling credential (guest Leave action).

`/api/device` includes `access.kind`, `access.scopes`, and `access.expiresAt`. Expired credentials return 401, including after restart. Active transfers and streams are cut off; no refresh or renewal endpoint exists. Tailscale membership is managed separately.

### Owner app shortcuts

`GET /api/apps/shortcuts` lists runnable installed-app actions, supported fixed integrations and saved custom shortcuts as `{id,name,detail,kind,suggested?,custom?}`. Only an installed app named Codex enables its built-in actions; ChatGPT alone does not. Uninstalled apps and custom shortcuts pointing to them are excluded. `POST /api/apps/shortcuts` accepts only `{id}` from this list. `codex-new` opens a fresh desktop composer through a fixed deep link; app actions launch an installed app. Website shortcuts open an explicitly saved HTTP(S) link on the computer, without shell interpolation or server-side fetching.

Custom shortcut management (all require `admin` and `apps` scopes):

- `GET /api/apps/shortcuts/custom`: saved definitions with `available` state, including unavailable apps so owners can repair or remove them.
- `POST /api/apps/shortcuts/custom`: `{name,type:"app",actionId}` or `{name,type:"website",url}`. Include an existing `id` to edit. Names are 1–60 characters; at most 50 entries are saved per computer. App actions must exist in its built-in catalog. Links are HTTP(S), up to 2,048 characters, without embedded credentials or control characters.
- `DELETE /api/apps/shortcuts/custom/:id`: remove a saved shortcut.

Definitions persist in private `shortcuts.json`; paired owners on that computer share them. Guests and scoped agents cannot list, create, edit, delete or launch these shortcuts. Authorization is rechecked after discovery and immediately before mutations/dispatch. App discovery is cached for up to 30 seconds. Shell commands, arbitrary URL schemes, app arguments and automatic prompt submission are unsupported.

## Tailscale owner approval (configured Mac/Linux launcher)

- `GET /api/auth/method` returns `method: "tailscale" | "pairing"`, `eligible`, and the verified login only to an eligible owner. It grants no resource access.
- `POST /api/auth/requests` with `{name}` creates a five-minute local approval request. Returns `{id, secret, verification, expiresAt}`. Requires verified private Tailscale ingress and the configured owner identity.
- `POST /api/auth/requests/:id` with `{secret}` polls that request from the same Tailscale node/user. Returns `{status}` or `{status: "approved", token, device}`. Keep the claimant secret out of query strings/logs. Retry the same request after a dropped response.
- Approval/denial happens locally via `./reach approve` or the foreground terminal. No HTTP endpoint can approve an owner.

The usual Bearer credential is still required after approval. Owner credentials are additionally bound to the verified Tailscale user and node on HTTP and WebSockets. Do not proxy these endpoints through a generic TCP listener or trust caller-provided identity headers. Guest and agent enrollment APIs remain separate.

### Live device presence

`WS /ws/presence` uses the existing private transport, Host/Origin validation, Funnel rejection, and Tailscale identity verification. Authenticate within five seconds with `{type:"auth",token,kind:"phone"|"tablet"|"computer"}`. `kind` is presentation metadata, never an authorization or identity claim. Tokens are sent in the first message, never in URLs. No command or control capability is conferred by this socket.

The server sends `{type:"presence",devices:[{id,name,kind,self,activity,access:[{kind,expiresAt}]}]}` when the snapshot changes. Activity is `connected`, `viewing`, `controlling`, or `terminal`, derived from live channels and control leases. Owners see live participants; restricted clients only see their own device. Tailscale-bound credentials group by a hash of verified user/node identity; otherwise IDs are credential-local. Closed connections leave the snapshot; duplicated tabs do not inflate counts. Credentials are rechecked every two seconds, deletion closes their sockets, and ping/pong checks detect dead connections within about twenty seconds. This endpoint does not enumerate the tailnet or disclose saved, disconnected credentials.

Presence `access.kind` is `paired`, `invited`, or `agent`, derived exclusively from server-side credentials. A deduplicated node retains every distinct live grant kind/expiry; it is never silently promoted from invited to paired. Guest pages open a presence socket after redemption and close it when their session ends.
