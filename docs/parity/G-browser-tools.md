# G: saved browser tools on Windows

Plan and record for workstream G (docs/WINDOWS_AGENT_PARITY.md). Owner's
decisions, Oct 15 2026: a Reach extension for Chrome and Edge (Manifest V3)
that reaches Reach through native messaging; published by the owner on the
Chrome Web Store and Edge Add-ons; same decisions and same words as the Mac;
no flags; security first, fail closed.

## 1. Definition

On a Windows PC an agent finds, defines, runs and batches `reach.tool.v1`
tools (`reach_tools`, `reach_define_tool`, `reach_tool_<id>`,
`reach_tool_batch`, `reach_tool_operation`) in the owner's own Chrome or
Edge, with their sign-ins, exactly as on a Mac in Chrome or Safari:

- the same definitions, validator (`server/tool-protocol.mjs`) and run ledger
  (`server/agent-tools.mjs`), unchanged;
- the same page interpreter (`toolPageOperation`,
  `server/tool-page-runtime.mjs`), the only code that ever runs in a page;
- the same refusals: allowed websites only, password and sign-in-code fields,
  protected titles, sign-in pages, money sites read-only (the run's
  `checkURL`), the owner's tab never closed, owner takeover cancelling the run;
- the same error codes and fixed messages (`server/tool-browser-driver.mjs`
  `ERRORS`), never browser or page text;
- batches (`reach_tool_batch`) in Chrome and Edge: both name tabs by a stable
  id, as Chrome does on a Mac (Safari, which names tabs by position, stays
  excluded).

**The Mac keeps JXA.** Its path (`scripts/native/tool-browser.js`, Apple
Events, the Automation and "Allow JavaScript from Apple Events" setup) is
unchanged: it needs nothing from a store, it is proven, and Safari has no
equivalent extension route here. The extension is Windows' transport only.
Edge on a Mac is not offered (unchanged).

## 2. Architecture

```
agent ─MCP/HTTP─> Reach server (node.exe)
                    agent-tools.mjs ─> tool-browser-driver.mjs
                                         └─ win32: browser-extension.mjs (bridge)
                                              ║ named pipe \\.\pipe\reach-browser-tools-<hash>
                    reach-browser-host-<hash>.exe  (C#, csc, Reach's data folder)
                                              ║ stdio, native messaging framing
                    Chrome / Edge ─ Reach extension (MV3 service worker)
                                              └─ chrome.scripting (ISOLATED world)
                                                   └─ toolPageOperation (bundled copy)
```

- **Extension** (`browser-extension/`): a service worker
  (`service-worker.js`) that opens one `connectNative` port to
  `com.reach.browser_tools` and keeps it open (an open native port keeps an MV3
  worker alive). It answers Reach's requests with `chrome.tabs`,
  `chrome.windows` and `chrome.scripting.executeScript`, the latter only ever
  with its own bundled `toolPageOperation` (`page-runtime.js`, generated from
  the server's source and checked identical by a test). No `eval`, no remote
  code, no content scripts, no popup.
- **Native host** (`scripts/native/browser-host.cs`): C#, built with Windows'
  own csc into Reach's data folder like every other Windows helper
  (`windowsHelper`, SHA-256 noted), so SignPath can later sign it with the
  rest. Chosen over a Node script behind a `.cmd`: Chrome would start it
  through `cmd.exe` either way, but a `.cmd` cannot be signed, Smart App
  Control judges the program it starts, and a byte relay needs no runtime. It
  never parses tool data: it relays length-prefixed frames between the browser
  (stdin/stdout) and Reach's pipe, checks that the pipe's server is Reach's own
  `node.exe` running as the same Windows user before relaying a byte, and
  stays up while Reach restarts (reconnects with backoff, tells the extension
  `waiting`), so the extension is not left dead after a Reach restart.
- **Bridge** (`server/browser-extension.mjs`): the pipe server, the pairing
  store, the handshake, request ids, timeouts, cancellation, chunking and the
  routing of each request to the right connected profile.
- **Registration** (`server/tool-setup.mjs`, Windows branch): the host's
  manifest (`com.reach.browser_tools.json`, `allowed_origins` = the store listings'
  ids only; the repo build's fixed id is never in it, since anyone can load an
  unpacked copy) is written into Reach's data folder and
  registered per user under
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.reach.browser_tools`
  and `HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.reach.browser_tools`.
  No administrator rights.
- **App identity**: in the agent's app catalog Chrome is `exe:chrome.exe` and
  Edge `exe:msedge.exe` (Start's list, canonical path). The helper's
  `browser-check` (`agent-desktop.cs`) checks the path is that browser and
  within the agent's app access, as the Swift helper checks a bundle.

## 3. Protocol mapping

The JXA worker's operations become extension requests of the same name and
fields; every reply is the same JSON string JXA prints, so the driver's
parsing and error mapping are shared.

| JXA op | Extension |
|---|---|
| `preflight` | Connected + authenticated is the setup check; a normal window must exist (`browser_window_required`), and `window` must still exist. No probe tab. |
| `tabs` | `chrome.tabs.query({})`, normal windows; `{window: windowId, tab: tabId, index, url, title}`. Without the `tabs` permission, only `https:` tabs carry url and title (the only ones a tool can match). |
| `create` | `chrome.tabs.create` in the last focused normal window (`active: !background`), or `chrome.windows.create` when none |
| `info` | `chrome.tabs.get`, window id checked |
| `navigate` | `expectedURL`/`expectedDocument` checked, `chrome.tabs.update({url})` |
| `focus` | `tabs.update({active})` + `windows.update({focused})` |
| `evaluate` (source string) | replaced by `page` with the request object: `executeScript({func: toolPageOperation, args: [request], world: "ISOLATED", frameIds: [0]})` |
| document check (source string) | `document` op, a fixed function reading the interpreter's state |
| `close` | refused `owner_tab` when `behind` and the tab is active; `chrome.tabs.remove` |

The isolated world keeps the interpreter's state (`__reach_tool_protocol_v1__`:
the bound document, item handles, effects, downloads) out of the page's reach;
on a Mac the same function runs through Apple Events.

Messages (JSON, native messaging framing, ≤ 1 MB toward the browser):

- host → Reach: `{type:"host", origin}` first (origin as Chrome passed it).
- Reach → extension: `{type:"challenge", nonce}`; extension → Reach:
  `{type:"hello", installId, browser, version, nonce, proof?}`.
- `{type:"ready", proof}` (Reach's proof), `{type:"paired", secret, nonce}`,
  `{type:"unknown"}`, `{type:"waiting"}` (from the host).
- `{type:"request", id, request}` / `{type:"response", id, raw}`;
  `{type:"cancel", id}`; `{type:"chunk", id, index, count, data}` for any
  Reach → extension message over 512 KB (an 8 MB attachment), reassembled by
  the extension before use.
- `{type:"focus"}` (extension → Reach): the profile the owner last used, where
  a new tab opens.

## 4. Security model

- **Who may connect.** Only the listed extension ids can start the host
  (Chrome's `allowed_origins`). Only Reach's own `node.exe`, as the same user,
  is accepted as the pipe server by the host. Web pages cannot reach either.
- **Pairing, with the owner's approval.** An extension without a secret says
  hello with `pair`; Reach shows that browser as "asks to connect" in
  Agents → Browser tools; the owner's tap (Allow) makes Reach generate a
  32-byte secret, keep it in `browser-extension.json` (owner-only, never
  logged, never shown), and hand it to that extension once. Every later
  connection is a mutual HMAC-SHA256 challenge (each side proves the secret
  over both nonces) before a single request is accepted; the extension also
  refuses requests until Reach has proven itself, so a squatted pipe cannot
  drive the browser. A wrong proof closes the connection. A secret Reach no
  longer knows is forgotten and pairing starts over (the owner taps again).
- **Minimum permissions**: `nativeMessaging`, `scripting`, `storage`,
  `alarms`, host access `https://*/*` only (tools are HTTPS-only by protocol).
  No `tabs`, no `<all_urls>`, no `http:`, no `cookies`, no `webRequest`, no
  content scripts. Not allowed in incognito unless the owner turns it on.
- **Same rules as the Mac**: the server decides everything (definitions,
  origins, money sites, private titles, sign-in pages, full vs apps); the
  extension runs only the fixed interpreter, which refuses password and
  sign-in-code fields unless the agent has Full control, exactly as on a Mac.
  Vault values are never part of tools (they fill through the desktop helper),
  and tool results never carry browser exception text.
- **Fail closed**: no host, no connection, no pairing, an unproven peer, an
  unknown reply or a timeout is `setup_required`/`uncertain`, never a guess.
  An attempted effect without an answer is `uncertain` and never repeated.

## 5. Setup on the phone

Same row, same place (Agents → Browser tools), shown once an agent's tool
needed a browser. Per browser, one button:

| State | Words | Button |
|---|---|---|
| store listing not published yet | "Reach's extension isn't in the Chrome Web Store yet." | none |
| not added | "Add Reach's extension to Edge" | **Add**: opens the store page in that browser on the PC (the owner clicks Add to Edge there) |
| added, browser closed | "Open Edge on the PC" | **Open**: starts it |
| asks to connect | "Edge's extension asks to connect" | **Allow**: the pairing above |
| connected | "Ready" | none |

An agent's `reach_request_permission` (`need: browser-tools`) brings the same
one tap to Needs you. Reach registers the host by itself at start and before
each step; nothing for the owner to switch on.

## 6. Tests

- Everywhere (mocked): `browser-extension-bridge` (the real bridge over a
  real local socket, the real extension service worker in a VM with a fake
  `chrome`, the host framing in JS): pairing only after approval, requests
  refused before proof, wrong proofs closed, unknown origins refused,
  chunking of 8 MB attachments, timeouts `uncertain`, cancellation, no secret
  or page text in any error. `browser-extension`: generated runtime identical
  to the source, the manifest's exact permissions, no eval or remote code,
  every operation against a fake `chrome`, the store package without `key`.
  `tool-browser-safety` runs its fixed-error checks through both transports.
  `tool-setup` and `agent-tools` cover the Windows branch (Edge in the
  catalog, batches in Edge, `.exe` batch tabs kept across restarts).
- Real Windows (`windows-browser-tools-native`, gated on
  `REACH_TEST_WINDOWS_DESKTOP`): the host built with csc and registered in
  HKCU, real Chrome and real Edge each started with a fresh profile and the
  unpacked extension, paired, then a saved tool replayed through
  `createAgentTools` against a local HTTPS test page (a public-looking name
  mapped to 127.0.0.1 in that browser only), plus the refusals: another
  website, a password field, a money site, the owner's tab.

## 7. What needs the owner

1. Chrome Web Store and Edge Add-ons developer accounts; upload
   `npm run build:extension` output (`dist-extension/reach-browser-extension-<version>.zip`),
   with the listing and permission justifications in `browser-extension/STORE.md`.
2. Once each listing exists, its id and page URL go into
   `server/browser-extension-ids.mjs` (`EXTENSION_STORES`). Until then setup
   says the extension isn't in the store yet and no extension can connect.
   The repo build's fixed id (`REPO_EXTENSION_ID`) is accepted only where a
   caller names it on purpose: the tests' bridge and host registration.
3. SignPath signing of `reach-browser-host-*.exe` with the other helpers.
4. A run on a physical PC with the store builds.
