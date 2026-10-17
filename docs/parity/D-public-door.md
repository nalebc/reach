# Public door on Windows: design (revision 2)

Status: implementation spec for workstream D in `docs/WINDOWS_AGENT_PARITY.md`, Oct 12 2026, revised after the fix-first review. It replaces the recommendation in `docs/WINDOWS_SIGN_IN_DESIGN.md`.

**Oct 13: no switch.** The owner: "No flag should exist. We should detect platform and support." Wherever this spec says `REACH_WINDOWS_ACCOUNT=1`, read "a Windows PC set up with your account" (`./reach setup`, saved preferences, as on a Mac). Such a PC uses the keyed route when Tailscale (1.104 or newer, with its network adapter), Reach's folders and the peer check allow it, and pairing codes with the reason otherwise. If the route refuses every connection Tailscale makes to it, Reach notes it and starts again on pairing codes at once; it tries the route again a day later or after Tailscale changes (`scripts/launch.mjs`, `sign-in-unrecognised.json`). An older Tailscale no longer stops `configure`: the account is kept, and it says why phones use pairing codes until Tailscale is updated. Face ID join and linked computers (§11, "a later flag") are on too. The rest of this spec describes the Oct 12 state, kept as written.

- It sat behind `REACH_WINDOWS_ACCOUNT=1`, off by default (until Oct 13, above).
- **What it was checked against:**
  - Tailscale v1.104.0 (`~/go/pkg/mod/tailscale.com@v1.104.0`);
  - the gVisor it pins (`gvisor.dev/gvisor@v0.0.0-20260915211658-a6f909f08a72`);
  - the repo at `d5676f16`.
  - §1 says which rows were re-read for this revision.
- **Dependency:** it depends on workstream A's C# helper build (`windowsBinary`), with the requirements stated in §4.5.
- **macOS:** behaviour does not change. Every Mac-side edit below is one of these:
  - a pure move;
  - a new export;
  - an optional parameter whose default is today's behaviour;
  - a conjunct that is always true on darwin.
  - §7.2 is the regression set.
- **Owner decisions:** where the owner must choose, §11 names the default that ships if nothing is said. Every default is the fail-closed option.

## Review resolution

| # | Review item (severity) | Resolution | Where |
|---|---|---|---|
| 1 | The co-bind expectations contradict Microsoft's bind rules (blocker) | Test delivery, not whether the bind succeeds. **Expected:** 127.0.0.1 plain → WSAEADDRINUSE; reuse → WSAEACCES; wildcard `0.0.0.0`/`[::]` binds may succeed but must receive nothing while Reach listens. **D is blocked only if** a specific-address bind succeeds or a connection is misdelivered. The window after a crash is written down. | §1 r21, §2, §8 case 9, §9 4b, §10 |
| 2 | The exit node is a third raw path (major, plausible) | Re-read the source. An advertised default route does put 127.0.0.1 in tailscaled's local nets, but gVisor drops loopback-destination packets on Tailscale's NIC. Keyed mode is refused anyway while advertised routes (from prefs, approved or not) cover loopback, re-checked every 15 s. | §1 r16, §4.1, §4.10, §9 5b, §11 D5 |
| 3 | Other local users arrive keyed, peer-verified and as the owner, through tailscaled's own listener (major) | §2 corrected. Requests are marked "this computer" from the tailscaled-set X-Forwarded-For. By default, new sign-ins from that address are refused. The prompt wording is built either way. Acceptance step 4f added. | §1 r17, §2, §4.2, §4.11, §9 4f, §11 D1 |
| 4 | The state folder has no ACL equivalent, and the helper cache can be replaced (major) | **Each launch:** a SID-only `icacls` on Reach's state and data folders, verified by a freshly compiled C# checker. **Refusal:** keyed mode and invite keys are refused otherwise. **Helpers:** cached inside the protected folder and hashed before each spawn. **Checkout:** a code root writable by others means refuse. **Requirements** are stated on A. | §4.5, §4.10, §4.14, §11 D3, D4 |
| 5 | A time-of-check gap between the peer check and the request (major) | Requests whose socket closed during the check are dropped, and the cache entry is cleared on close. The helper returns the TCP row's creation time, which must not be later than Reach's accept time. Creation time ≥ the process's start time covers PID reuse. | §4.2, §4.4, §6 |
| 6 | Funnel enablement modelled wrongly (major) | All three real behaviours are modelled and tested. A child blocking on enablement is kept, not killed and respawned. | §1 r18, §4.8, §4.9, §7.1 |
| 7 | The CI standard-user harness can go red for reasons unrelated to the code (major, plausible) | A spike first, in the owner-triggered workflow: CreateProcessWithLogonW with explicit desktop ACEs, with INTERACTIVE asserted. The real service SDDL is pinned. The `access` message names non-interactive sessions. | §6, §8 |
| 8 | The route audit misses loopback spellings (minor) | Any TCPForward or Proxy whose port is Q, whatever its host, other than Reach's own exact target. | §4.6 |
| 9 | Redaction runs after truncation (minor) | The redactor is passed into `tailscaleSaid` and `tailscaleJson` before their cuts. It is a key-window redactor and also covers the crash guard. It is active only in keyed mode, so macOS output never changes. | §4.6, §4.7, §4.12, §5 |
| 10 | Both sessions restarting at once collide on the serve-config ETag (minor) | One serve lock, held until the session shows. The ETag message means an immediate retry. | §1 r19, §4.8 |
| 11 | The window at stop and crash (minor) | `stop()` waits (≤ 1.5 s, inside the existing 5 s deadline) until neither session remains, then closes the listener. The crash window is listed. | §4.10, §10 |
| 12 | The flag lives only in the environment (minor) | Launch and the commands say why sign-in is off when preferences exist but the flag is missing. Persisting the opt-in is §11 D2. | §4.10, §4.14, §11 D2 |
| 13 | Version gate, keep-alive, arch, PublicLink (minor) | **Version:** daemon and CLI both ≥ 1.104; newer versions are accepted. **Keep-alive:** the keyed server only, 100 s keep-alive and 105 s headers timeout. **Build:** `/platform:anycpu`, with separate arch errors. **PublicLink:** retired; ForegroundFunnel is built on ForegroundServe. | §4.1, §4.2, §4.4, §4.9 |

## 0. What changes from the earlier design (read first)

1. **The peer check as first designed could never pass.**
   - The Tailscale Windows service process only babysits: it runs `exec.Command(executable, "/subproc", logid)`. The child hosts the LocalAPI, the LocalBackend and the Serve proxy (rev. 1: `cmd/tailscaled/tailscaled_windows.go:207`, `:306-367`, `:430-515`).
   - So the PID from the SCM is the parent, and the socket that reaches Reach belongs to the child.
   - The rule is now: the socket owner is the live Tailscale service process, or its direct child, created after it and running the same executable.
   - A csc-compiled C# helper checks this (plan rule 3), using `GetExtendedTcpTable`, the SCM API and `NtQuerySystemInformation`.
   - netstat and sc parsing survive only as the Windows CI test's independent oracle.
   - New in this revision: the helper also returns the TCP row's creation time (§4.4, §6).
2. **The Funnel route must also be a foreground session.**
   - `EphemeralFunnel` uses `funnel --bg` (`scripts/ephemeral-funnel.mjs:191`) and a forked janitor. On Windows, a crash would leave a background route to `127.0.0.1:<port>/r-<key>` in daemon state, with the key in it.
   - Foreground Funnel works (§1, row 14).
3. **Reach's own code would leak the key.**
   - The leak points: CLI stdout, `tailscaleSaid`, launch's log line, and also truncated error texts and the crash guard.
   - Everything is redacted at source, before any cut (§5).
4. **LocalAPI and other Windows users.** Reach's foreground children hold WatchIPNBus requests for the whole run. That locks every other non-SYSTEM user out of the LocalAPI (§1, row 8).
5. **Raw tailscaled-owned paths to the loopback port.** The peer check passes every one of them, so only the key and these refusals stop them:
   - **A TCP forward or proxy in this PC's own serve config pointing at port Q.** It needs LocalAPI access (the owner, SYSTEM, admins). Stopped by the route audit, whatever the host is spelled (§4.6).
   - **Netstack's local-IP forwarding in userspace mode.** Stopped by refusing keyed mode when `TUN !== true`.
   - **Netstack's subnet and exit forwarding, which Windows uses even in TUN mode.**
     - An advertised default route puts 127.0.0.1 in tailscaled's local nets.
     - Today gVisor drops packets to a loopback destination one layer down (§1, row 16).
     - Reach still refuses keyed mode while advertised routes cover loopback, and re-checks that at runtime.
6. **Face ID join and linking computers stay off on Windows, even with the flag.** In `server/index.mjs`, `fleet` and `faceJoin` are null on win32; `scripts/link.mjs` keeps refusing.
7. **What D alone unlocks:**
   - account approval, the start page and browser sign-in;
   - invite keys and person invites;
   - the gateway and MCP endpoints with their door rules.
   - Hosted MCP and agent invitations both require a preset (`server/agent-presets.mjs:60-66`), and every preset is refused on Windows until E (`server/browser-access.mjs:227-228`, `:244-245`).
   - D therefore proves those flows over the keyed transport on Mac and Linux CI. On real Windows they wait for E.
8. **Other Windows users reach the keyed route through tailscaled itself.**
   - tailscaled listens on the PC's own Tailscale addresses for the machine's own connections (§1, row 17).
   - A request from any local user to `https://<pc>.ts.net:8443`, or to `:443`, arrives keyed, from tailscaled, not Funnel-marked, and with the owner's identity (the WhoIs of the PC's own address).
   - Credentials still need the owner's approval, so this is approval phishing, not a bypass. macOS has the same exposure.
   - D marks these requests and, by default, refuses new sign-ins from them (§4.11, §11 D1).
9. **Reach's Windows state folder has no equivalent of 0700.**
   - The `mode` arguments in `server/core.mjs:79-84` do nothing on Windows, and a checkout under `C:\` inherits Authenticated Users: Modify.
   - D adds `tailscale-oauth.json`, an OAuth client that can mint keys and delete devices.
   - Keyed mode and invite keys therefore require verified private folders, and a checkout that other users can't change (§4.5).
10. **A socket can die while it is being checked.** A peer can reset its connection mid-check, and its address pair can then be reused. §4.2 and §6 close the gap.
11. **Another user's wildcard bind on Q succeeds** (Microsoft's documented rule). Connections to 127.0.0.1:Q still go to Reach's more specific socket. CI and acceptance check delivery, not bind results (§8 case 9).

## 1. Verified against Tailscale v1.104.0

- **Rows 1-15** were checked for revision 1 and are not all re-read here.
- **Rows 16-20** and the parts of rows 11 and 18 marked new were read for this revision.
- **Rows 21-22** were verified on the windows-2025 runner (§8, Oct 13). **Row 23** is still per review. **Row 24** is new, found there.

| # | Claim | Finding | Source |
|---|---|---|---|
| 1 | Serve can't proxy to a Unix socket on Windows | Confirmed | `ipn/serve.go:776-783` |
| 2 | A path inside a proxy target is prepended to every request | Confirmed (`joinURLPath`): target `/r-K` + `/` gives `/r-K/`, and `/api/x?y=1` gives `/r-K/api/x?y=1`. Escaped paths keep their `RawPath`. | `ipn/ipnlocal/serve.go:978`; `net/http/httputil/reverseproxy.go:287-306`, `:339-349` |
| 3 | `--set-path` is stripped before proxying | Confirmed | `ipn/ipnlocal/serve.go:1228-1231` |
| 4 | Identity and Funnel headers can't be forged through the HTTP proxy | Confirmed. `Tailscale-User-*`, `Tailscale-Funnel-Request` and `Tailscale-Headers-Info` are deleted, then set by tailscaled. `Tailscale-App-Capabilities` is deleted. `Forwarded`/`X-Forwarded-*` are deleted, then `X-Forwarded-Host`/`-For` are set from the real connection. | `ipn/ipnlocal/serve.go:1088-1126`, `:1144-1146`; `reverseproxy.go:499-507` |
| 5 | Host header | TCP targets keep the original `Host`, so `validHost`, `public-start` and `hosted-mcp` accept it | `ipn/ipnlocal/serve.go:990-996` |
| 6 | Serve can't add headers | Confirmed | `ipn/serve.go:171-189` |
| 7 | A proxy target needs no admin | Confirmed (admin is needed only for Path handlers and `unix:` targets) | `ipn/localapi/serve.go:80-112`; `ipn/ipnserver/server.go:337-349` |
| 8 | Other Windows users can't use the LocalAPI while Reach runs | Reach's foreground children hold WatchIPNBus for the whole session, so every other non-SYSTEM user is refused. Only `GET /server-status` and `CONNECT` to the log host are answered before that check. | `cli/serve_v2.go:491-511`, `:545-555`; `server.go:152-166`, `:255-285`, `:409-455`; `ipnlocal/local.go:4627-4659` |
| 9 | No current user | The current user is cleared only when no client is connected. Foreground sessions are deleted when their watcher ends, and stale sessions are dropped on reload. | `server.go:440-452`; `local.go:3923` → `ipnlocal/serve.go:442-451`, `:1666-1670` |
| 10 | Who can see the key | **This Windows user:** the children's argv and `serve status`. **Admins/SYSTEM:** persisted foreground configs under `%ProgramData%\Tailscale`. **Tailscale's local and uploaded logs:** `serve: creating a new proxy handler for <backend>`. **The CLI's stdout.** Another standard user can read none of these. | `ipnlocal/serve.go:379-392`, `:1450`, `:1467`; `paths/paths_windows.go:33-98`; `serve_v2.go:1123-1131` |
| 11 | Raw, unkeyed tailscaled-owned paths to `127.0.0.1:<port>` | **TCP forwards** in this PC's own serve config and **LocalAPI dial** both need LocalAPI access. **Userspace networking** forwards any permitted peer's TCP for `<TailscaleIP>:<port>` onto `127.0.0.1:<port>`; status reports it as `TUN:false`. **New:** subnet and exit forwarding in TUN mode on Windows is row 16. | `ipnlocal/serve.go:688-724`; `localapi.go:1304`; `netstack.go:1773-1774`; `cmd/tailscaled/netstack.go:41`; `ipnstate.go:36-38`; `local.go:1500` |
| 12 | The service | Named `Tailscale`, `SERVICE_WIN32_OWN_PROCESS`, LocalSystem. The service process babysits and its `/subproc` child is the daemon. | `tailscaled_windows.go:93`, `:180-215`, `:306-367`, `:430-515`; `install_windows.go:57-66` |
| 13 | Could the LocalAPI pipe prove identity? | Rejected: its DACL grants BUILTIN\Users GENERIC_WRITE, which governs instance creation | `paths/paths.go:24-28`, `:56-58`; `safesocket/pipe_windows.go:44-55`, `:112` |
| 14 | Funnel inside a foreground session | Works | `ipn/serve.go:954-964`; `ipnlocal/serve.go:475` |
| 15 | A foreground listener needs a free port | A background route on 8443 or 443 blocks the session ("listener already exists") | `ipnlocal/serve.go:1781-1797` |
| 16 | **Exit and subnet traffic in TUN mode (new)** | **What lets the packet in:**<br>- Windows handles subnet routes in netstack even in TUN mode, and `ProcessSubnets = onlyNetstack \|\| handleSubnetsInNetstack()`. `shouldProcessInbound` takes any non-local destination when `ProcessSubnets` is set.<br>- An advertised default route (`prefs.AdvertiseRoutes()`, with **no approval check**) adds `shrinkDefaultRoute(...)` to local nets. That removes interface subnets, then re-adds the host IPs.<br>- `interfaceRoutes` keeps the loopback interface's 127.0.0.1, because 127.0.0.1/8 isn't a single IP and `ForeachInterfaceAddress` doesn't skip loopback. `removeFromDefaultRoute` has no 127/8. The filter's `pre()` has no loopback rule.<br>**What stops it today:**<br>- gVisor's IPv4 and IPv6 `HandlePacket` drop a packet with a loopback source or destination on a non-loopback NIC unless `AllowExternalLoopbackTraffic` is set.<br>- Tailscale's NIC reports only `CapabilityRXChecksumOffload`, and the stack uses the default `ipv4.NewProtocol`/`ipv6.NewProtocol`.<br>- So the packet dies before `acceptTCP`. It is one option away from open, so D refuses anyway (§4.1). | `cmd/tailscaled/tailscaled.go:830-841`; `cmd/tailscaled/netstack.go:41-42`; `wgengine/netstack/netstack.go:375`, `:1329`; `wgengine/netstack/link_endpoint.go:320-324`; `ipn/ipnlocal/local.go:3449-3468`, `:3589-3606`, `:3669-3713`; `net/netmon/state.go:184-215`; `wgengine/filter/filter.go:688-720`; gVisor `pkg/tcpip/network/ipv4/ipv4.go:962-974`, `ipv6/ipv6.go:1257-1262` |
| 17 | **tailscaled's own-machine listener (new)** | In TUN mode tailscaled binds OS sockets on every Tailscale IP for each serve port, "purely for connections from the machine itself"; not in userspace mode. A local process connecting to `<pc>.ts.net:8443` or `:443` is served like a peer. Its source is the PC's own Tailscale address, so the identity headers (row 4) name the owner, and it is not Funnel-marked. | `ipn/ipnlocal/serve.go:107-116`, `:282-327` |
| 18 | **Funnel enablement (new)** | `funnel` checks enablement before any session. The interactive flow prints its text and URL on **stdout**. Then it calls `os.Exit(0)` when `!ShouldWait`, or **blocks** on WatchIPNBus until enabled. If the flow itself errors, the old `CheckFunnelAccess` error is returned (stderr, exit 1). `prefs` for §4.1: `tailscale debug prefs` prints `GetPrefs` as JSON, including `AdvertiseRoutes`. | `cli/serve_v2.go:410-415`; `cli/funnel.go:139-162`; `cli/serve_legacy.go:815-857`; `ipn/serve.go:647-664`; `cli/debug.go:633-645` |
| 19 | **Serve-config ETag (new)** | Each CLI reads the config, then sets it with If-Match. On conflict it prints "Another client is changing the serve config; please try again." to stderr and fails. | `cli/serve_v2.go:537-541`; `ipnlocal/serve.go:78-81`, `:371`; `localapi/serve.go:67-68` |
| 20 | **Proxy idle connections (new)** | Serve's backend transport keeps idle connections for 90 s | `ipnlocal/serve.go:1031-1040` |
| 21 | Co-bind by another account | Microsoft, "Using SO_REUSEADDR and SO_EXCLUSIVEADDRUSE" (Enhanced Socket Security). The first socket is default, bound to a specific address (Reach on 127.0.0.1:Q). A second socket from another account gets:<br>- default bind on the wildcard → success;<br>- default bind on the same address → WSAEADDRINUSE;<br>- SO_REUSEADDR on the same address → WSAEACCES.<br>A wildcard socket gets traffic for every address except one bound specifically.<br>**Verified:** another account's `127.0.0.1:Q` gets 10048 plain and 10013 with SO_REUSEADDR; `0.0.0.0:Q` and `[::]:Q` bind plain (SO_REUSEADDR on `0.0.0.0:Q`: 10013) and get no connection while Reach listens. | CI case 9, windows-2025 |
| 22 | Service DACL | `sc create` gives a default DACL that grants query to INTERACTIVE and SERVICE, not Authenticated Users. A process without INTERACTIVE (an OpenSSH session, a scheduled task) may be refused `SERVICE_QUERY_STATUS`.<br>**Verified:** a batch token connects to the service manager, then `OpenService` is refused (5), so the helper says `access`.<br>**Tailscale 1.104.1's MSI** sets the service's DACL itself (`MsiLockPermissionsEx`): the same, plus Users may start it, `D:(A;;CCLCSWRPWPDTLOCRRC;;;SY)(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;BA)(A;;CCLCSWLOCRRC;;;IU)(A;;CCLCSWLOCRRC;;;SU)(A;;RP;;;BU)`, pinned in `test/fixtures/windows/tailscale-service.sddl`. | CI cases 1b and 13, windows-2025 |
| 23 | Session deletion lags the CLI's exit | The session is deleted when the watcher's context ends (row 9), asynchronously. Until then the route still points at Q. | Per review; §4.10 waits for it |
| 24 | **Another account's program in a user's session (new)** | The service manager refuses `SC_MANAGER_CONNECT` (5) to a non-admin program of another account running in the runner's console session, whatever its token: one placed there by the secondary logon service (`CreateProcessWithLogonW`, `runas`) or by SYSTEM's `CreateProcessAsUser`. Its DACL grants CC to Authenticated and Interactive Users. The same interactive token connects in session 0. The session's own user without elevation connects in its own session. Every other call the helper makes, including class 88 on session 0's processes, answers both. | CI cases 1, 1a, 1c, windows-2025 |

## 2. Threat model (keyed mode, flag on)

| Actor | Attempt | Stopped by |
|---|---|---|
| Internet (Funnel) | Any request | The Funnel mark set by tailscaled. The keyed listener hands it only to `publicApp` (the door rules); internet WebSockets are destroyed. Same as macOS. |
| Tailnet peer | Forged identity headers through Serve | tailscaled deletes and resets them (row 4) |
| Tailnet peer | Raw TCP through netstack in userspace mode | Keyed mode refused when `TUN !== true`. Even without that check: no key → 404 and destroyed. |
| Tailnet peer | A crafted packet to `127.0.0.1:Q` through this PC as exit node or subnet router | gVisor drops loopback destinations (row 16). Keyed mode is also refused while advertised routes cover loopback (checked every 15 s; window ≤ 30 s after a runtime change). Without the key → 404 anyway. |
| Tailnet peer | Raw TCP through a TCP forward or proxy the owner set up to Q | No key → 404 and destroyed. The route audit also refuses the private route while it exists, whatever the host spelling (≤ 5 s window). |
| Another standard user on the PC | Connect straight to `127.0.0.1:Q` with forged headers | No key → 404 and destroyed |
| Another standard user | Connect to `127.0.0.1:Q` with a leaked key | The peer check: not tailscaled → destroyed, no bytes sent |
| Another standard user | Go through tailscaled's own listener: `https://<pc>.ts.net:8443` or `:443` | Arrives keyed, peer-verified, with the owner's identity (row 17). Default (§11 D1): `/api/auth/method` says this PC's own browser can't sign in, and new approval requests are refused. Otherwise every request names "this PC itself" at the terminal and on phones. Credentials always need the owner's approval or a passkey. macOS has the same exposure (§10). |
| Another standard user | Read the key through the LocalAPI, logs, argv or the state file | Refused (rows 8-10) |
| Another standard user | Read Reach's state (OAuth client, pairing, device stores) | A protected DACL on the state and data folders, re-applied and verified every launch. Keyed mode and invite keys are refused if it can't be verified (§4.5). |
| Another standard user | Replace a compiled helper (for example a peer check that always answers `t`) | Helpers are built inside the protected folder; the checker is compiled fresh every launch; every spawn re-hashes the file (§4.5) |
| Another standard user | Edit Reach's code in a checkout they can write to | Keyed mode refused while the code root grants write access to anyone but the owner, SYSTEM, Administrators or TrustedInstaller (§4.5, §11 D4) |
| Another standard user | Bind Q while Reach runs | `127.0.0.1:Q`: WSAEADDRINUSE or WSAEACCES. `0.0.0.0:Q`/`[::]:Q`: may bind, but connections to 127.0.0.1:Q still go to Reach (row 21; verified in §8 case 9 and §9 4b). |
| Another standard user | Hold a wildcard bind on Q and wait for Reach to stop | **Graceful stop:** both sessions are gone before the listener closes (§4.10). **Crash:** a sub-second window until tailscaled drops the sessions (§10, risk 3). |
| Leaked key + reset connection | Make the helper vouch for a dead socket whose address pair was reused | The socket must still be open after the check, and the TCP row's creation time must not be later than Reach's accept time (§4.2, §6) |
| Same Windows user, admins, SYSTEM | Anything | Trusted, as root and the same user are on macOS |
| Holder of the key (logs uploaded to Tailscale) | Use it | Needs a raw tailscaled-owned path. TUN mode, the advertised-route refusal and the route audit close those (§10, risk 1). |

## 3. How a request flows (Windows, flag on)

```
phone ─TLS─▶ tailscaled (Serve :8443 or Funnel :443, two foreground sessions held by Reach's children)
      └─▶ GET http://127.0.0.1:<Q>/r-<key>/<path>   (Host kept, identity headers cleaned and set)
Reach keyed ingress (127.0.0.1:<Q>, random port, one per launch; accept time noted per socket):
  0. refuse() (route audit or Tailscale settings)  ✗ → destroy
  1. Key prefix "/r-<key>/" in constant time         ✗ → 404 + destroy (no peer check, no WhoIs)
  2. Peer check, once per socket (cached until close) ✗ → destroy, no response
  3. Socket still open and refuse() still clear       ✗ → destroy
  4. req.url = "/<path>" (before Express: originalUrl and redirects never carry the key)
  5. Funnel-marked → publicApp (door rules) | else mark "this computer" if X-Forwarded-For is
     one of this PC's Tailscale IPs → mark trusted → WhoIs → app/upgrade
```

The main listener `127.0.0.1:<port>` stays as it is. With `tailscaleOwner` set it refuses unauthenticated API calls (`index.mjs:1322`) and still serves `hostedDispatch`, as on macOS.

## 4. File-by-file changes

### 4.1 `scripts/configure.mjs`

- **Line 17-18:** replace `accountApproval`, and add `windowsAccount`, `coversLoopback` and `keyedSupportProblem`.

```js
export const windowsAccount = (env = process.env) => env.REACH_WINDOWS_ACCOUNT === "1";
// Phones approved by your Tailscale account. Windows only behind the flag:
// a keyed route only Tailscale's own process may use (server/tailscaled-peer.mjs).
export const accountApproval = (platform = process.platform, env = process.env) =>
  platform !== "win32" || windowsAccount(env);
const atLeast104 = (version) => {
  const [major, minor] = String(version || "").split(/[.-]/).map(Number);
  return major > 1 || (major === 1 && minor >= 104);
};
// An advertised route that reaches this PC's loopback addresses through
// Tailscale's netstack (docs/WINDOWS_PUBLIC_DOOR.md §1 row 16). Unreadable → true.
export function coversLoopback(prefix) { /* 0.0.0.0/0, ::/0, any IPv4 prefix overlapping
  127.0.0.0/8, any IPv6 prefix containing ::1 or overlapping ::ffff:127.0.0.0/104 */ }
// Windows' keyed route was verified with Tailscale 1.104; that and every newer
// version are accepted (rerun §9 after a major Tailscale change). It also needs
// Tailscale's network adapter, and no advertised route that covers loopback.
export function keyedSupportProblem({ status, prefs, cliVersion } = {}) {
  const daemon = String(status?.Version || "").split("-")[0];
  if (!atLeast104(daemon)) return `Tailscale ${daemon || "?"} is older than 1.104; update Tailscale.`;
  if (!atLeast104(cliVersion)) return `Tailscale's command line (${cliVersion || "?"}) is older than 1.104; update Tailscale.`;
  if (status?.TUN !== true) return "Tailscale runs without its network adapter here (userspace networking).";
  if (!prefs || typeof prefs !== "object" || !("AdvertiseRoutes" in prefs))
    return "Reach couldn't read Tailscale's settings on this PC.";
  if ((prefs.AdvertiseRoutes || []).some(coversLoopback))
    return "This PC offers itself as a Tailscale exit node, or routes a loopback subnet.";
  return "";
}
```

- **Line 143:**

```js
const platform = deps.platform || process.platform;
await (deps.checkSupport || (platform === "win32"
  ? async () => {
      const problem = keyedSupportProblem(await (deps.keyedState || readKeyedState)());
      if (problem) throw Error(`${problem} No settings changed.`);
    }
  : assertSocketSupport))();
```

- `assertSocketSupport` (58-70) never runs on win32.
- **Lines 96-99:**
  - The message is unchanged; it is now reached only with the flag off.
  - When `preferences.json` already exists on win32, one sentence is added: "Browser sign-in was set up here; it needs REACH_WINDOWS_ACCOUNT=1 in this terminal."

### 4.2 `server/tailscale-auth.mjs`

New exports, added after `trustedRequest`. `listenPrivateIngress` (144-208) is not touched.

```js
import crypto from "node:crypto";
export const INGRESS_KEY = /^[A-Za-z0-9_-]{43}$/;               // 256 bits, base64url
export const newIngressKey = () => crypto.randomBytes(32).toString("base64url");
export const keyedTarget = (port, key) => `http://127.0.0.1:${port}/r-${key}`;
// §5. Built only in keyed mode; macOS never has one.
export const keyRedactor = (key) => (text) => String(text ?? "")
  .replaceAll(key, "…")
  .replace(/\/r-[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, "/r-…")
  .replace(/[A-Za-z0-9_-]{12,}/g, (run) => {
    for (let i = 0; i + 12 <= run.length; i++) if (key.includes(run.slice(i, i + 12))) return "…";
    return run;
  });
const thisComputer = new WeakSet();
// A keyed request whose source (set by tailscaled, never by the client: §1 row 4)
// is one of this PC's own Tailscale addresses: any Windows user here could have sent it.
export const thisComputerRequest = (req) => thisComputer.has(req);
// Windows (no Unix socket): Tailscale Serve proxies to a loopback port with the
// key as the target's path; tailscaled prepends it to every request. A request
// counts as Tailscale's only with the key AND from tailscaled's own process.
export async function listenKeyedIngress({ key, app, upgrade, resolveIdentity, publicApp, peerCheck,
  refuse = () => "", onRefused = () => {}, selfIps = () => [], port = 0 }) {
  if (typeof key !== "string" || !INGRESS_KEY.test(key)) throw Error("Reach's private route key is malformed.");
  if (typeof peerCheck?.check !== "function") throw Error("Reach's private route needs Tailscale's connection check.");
  const expected = Buffer.from(`/r-${key}/`, "latin1");           // 47 bytes; Go always sends "/r-K/…"
  const keyed = (req) => typeof req.url === "string" && req.url.length >= expected.length &&
    crypto.timingSafeEqual(Buffer.from(req.url.slice(0, expected.length), "latin1"), expected);
  const strip = (req) => { req.url = req.url.slice(expected.length - 1); };
  const acceptedAt = new WeakMap();                                // socket -> ms, noted on accept
  const verified = new WeakMap();                                  // socket -> Promise<boolean>
  const fromTailscaled = (socket) => {
    let v = verified.get(socket);
    if (!v) {
      verified.set(socket, (v = Promise.resolve()
        .then(() => peerCheck.check(socket, acceptedAt.get(socket)))
        .then((ok) => ok === true, () => false)));
      socket.once("close", () => verified.delete(socket));
    }
    return v;
  };
  // Still the socket that was checked: a client that reset it while the check
  // ran freed its address pair for another connection (§6).
  const open = (socket) => !socket.destroyed && socket.readable && socket.writable;
  const markSource = (req) => {
    const from = req.headers["x-forwarded-for"];
    if (typeof from === "string" && selfIps().includes(from)) thisComputer.add(req);
  };
  const prepare = async (req) => { trusted.add(req); req.reachIdentity = await resolveIdentity(req); };
  const notFound = (req, res) => {
    onRefused("key");
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", Connection: "close" });
    res.end("Not found.", () => req.socket.destroy());
  };
  const server = http.createServer(async (req, res) => {
    const why = refuse();
    if (why) { onRefused(why); return req.socket.destroy(); }
    if (!keyed(req)) return notFound(req, res);
    if (!(await fromTailscaled(req.socket))) { onRefused("peer"); return req.socket.destroy(); }
    if (!open(req.socket) || refuse()) return req.socket.destroy();
    strip(req);
    ingress.add(req);
    if (fromInternet(req)) {
      if (publicApp) return publicApp(req, res);
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found.");
    }
    markSource(req);
    prepare(req).then(() => app(req, res)).catch(() => { res.writeHead(503); res.end(); });
  });
  server.on("connection", (socket) => acceptedAt.set(socket, Date.now()));
  server.on("upgrade", async (req, socket, head) => {
    const why = refuse() || (keyed(req) ? "" : "key");
    if (why) { onRefused(why); return socket.destroy(); }
    if (!(await fromTailscaled(socket))) { onRefused("peer"); return socket.destroy(); }
    if (!open(socket) || refuse()) return socket.destroy();
    strip(req);
    if (fromInternet(req)) return socket.destroy();
    markSource(req);
    prepare(req).then(() => upgrade(req, socket, head)).catch(() => socket.destroy());
  });
  server.on("clientError", (_error, socket) => socket.destroy());   // no bytes to unverified peers
  // Serve keeps idle backend connections for 90 s (§1 row 20). Node's 5 s default
  // means more new connections, each a peer check, and races on reused ones.
  // This server only: macOS's listeners keep their settings.
  server.keepAliveTimeout = 100000;
  server.headersTimeout = 105000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return server;
}
```

Rules this code must keep:

- The key is checked before the peer check, so unauthenticated local processes can't trigger table reads.
- The key is checked on every request, including kept-alive ones.
- The key never reaches anything after `strip`. No message, `onRefused` argument or log line includes `req.url`.
- `refuse()` returns `""`, `"route"` (route audit) or `"settings"` (§4.10). It is checked before and after the peer check.
- A request is dispatched only if its socket is still open after the check. The cache entry dies with the socket.

### 4.3 `server/tailscaled-peer.mjs` (new)

```js
export function createTailscaledPeerCheck({
  platform = process.platform,
  helper,                                    // () => Promise<{ file, sha256 }>: A's windowsBinary in the protected folder (§4.5)
  spawnHelper = ({ file, sha256 }) =>        // re-hashes the file right before every spawn (§4.5)
    spawnVerified(file, sha256, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true }),
  readyMs = 30000, answerMs = 3000, restartMs = 5000, slackMs = 20, now = Date.now,
  onProblem = () => {},                      // (reason) once per distinct reason
} = {}) → { ready(): Promise<{ ok: true } | { ok: false, reason: string }>,
            check(socket, acceptedAt): Promise<boolean>, close(): Promise<void> }
```

- Off win32, `ready()` resolves `{ ok: false, reason: "Windows only." }`, `check()` returns `false` and nothing is spawned.
- `check` is true only for an answer `t:<createdMs>` with `0 < createdMs <= acceptedAt + slackMs` (§6). A missing `acceptedAt` → `false`.
- The service name and image name are constants in the C# source. No environment variable, argv or option changes them.

### 4.4 `scripts/native/tailscaled-peer.cs` (new, compiled by A's `windowsBinary`)

**Requirements:**

- .NET Framework 4.8 or later, using only `mscorlib` and `System`.
- Built `/platform:anycpu` (never `anycpu32bitpreferred`) with `/deterministic` (§4.5).
- At start:
  - `!Environment.Is64BitOperatingSystem` → `error arch`;
  - `IntPtr.Size != 8` → `error arch32` (a build problem, not the PC's).

**P/Invoke:**

- `iphlpapi!GetExtendedTcpTable(IntPtr, ref int, bool, int af = 2 /*AF_INET*/, int cls = 8 /*TCP_TABLE_OWNER_MODULE_ALL*/, uint 0)`.
  - `MIB_TCPTABLE_OWNER_MODULE`: `dwNumEntries`, then rows from offset 8 (the 8-byte alignment of the timestamp).
  - `MIB_TCPROW_OWNER_MODULE` (160 bytes): `state@0`, `localAddr@4`, `localPort@8`, `remoteAddr@12`, `remotePort@16`, `owningPid@20`, `liCreateTimestamp@24` (FILETIME), `OwningModuleInfo@32` (16 × u64, unused).
  - Ports are in network byte order in the low 16 bits.
- `advapi32!OpenSCManagerW(null, null, SC_MANAGER_CONNECT=0x1)`
- `OpenServiceW(h, "Tailscale", SERVICE_QUERY_CONFIG|SERVICE_QUERY_STATUS = 0x5)`
- `QueryServiceStatusEx(SC_STATUS_PROCESS_INFO)`, `QueryServiceConfigW`, `CloseServiceHandle`
- `ntdll!NtQuerySystemInformation`:
  - class 5 (`SystemProcessInformation`), 64-bit offsets: `NextEntryOffset` 0x00, `CreateTime` 0x20, `ImageName` 0x38 (Length u16 @0x38, Buffer @0x40), `UniqueProcessId` 0x50, `InheritedFromUniqueProcessId` 0x58, `SessionId` 0x64. The buffer grows on `STATUS_INFO_LENGTH_MISMATCH`, up to 64 MiB.
  - class 88 (`SystemProcessIdInformation`) gives the NT image path of any PID without opening it.
- `kernel32!QueryDosDeviceW` converts the SCM path's drive to its NT device.

**At start:** run the service check below, then print `ready 1` or `error <code>` (§6).

**Per query** `q <id> <ingressPort> <p1>[,<p2>…]` (≤ 64 ports):

1. **T1:** read the TCP table. The row for each `p` is `local 127.0.0.1:p`, `remote 127.0.0.1:ingressPort`, state 5 (ESTAB) → PID and `created`.
   - No row, or PID 0 → `g`.
   - Several rows with different PIDs → `o`.
   - `created == 0` → `e`.
2. **Service:** RUNNING; `dwServiceType == 0x10`; `dwProcessId = S > 0`; start name `LocalSystem` (case-insensitive); the binary path is quoted or has no spaces; its file name is `tailscaled.exe`.
   - Any failure → `n`; access denied → `e`.
3. **Snapshot (class 5):** P is accepted if `P == S`, or if all of these hold:
   - `parent(P) == S`
   - `CreateTime(P) >= CreateTime(S)` (defeats parent-PID reuse)
   - `ImageName(P)` is `tailscaled.exe`
   - `SessionId(P) == 0`
   - the class-88 NT paths of P and S are equal, and equal to the converted SCM path.
   - In every case, `created >= CreateTime(P)` (a row older than its owning process means a reused PID).
   - Otherwise → `o`.
4. **T2:** read the TCP table again: same row, same PID, same `created`. Read the service again: still running, same S. Otherwise → `g` or `o`.
5. **Answer:** `a <id> <p>:t:<createdMs> …`, or `<p>:<o|g|n|e>`. `createdMs` = (FILETIME − 116444736000000000) / 10000.

**Never:** write files, log, open the network or read anything else. The helper exits on stdin EOF, or on a malformed line (exit code 2).

**Why this is sound:**

- A standard user can't make a child of a LocalSystem service.
- PIDs are unique among live processes, so a child of S created after S is S's.
- The same row and PID before and after the check prove the owner lived across it.
- The row's creation time, no later than Reach's accept time, proves it is the connection Reach accepted, not a later one on a freed address pair (§6).

### 4.5 Private folders and helper builds (new: `server/windows-private-folder.mjs`, `scripts/native/private-folder.cs`)

**Why:** Windows ignores the `0o700`/`0o600` modes Reach passes (`server/core.mjs:79-84`). A checkout outside the user folder keeps its state in `<root>\.reach` with inherited Authenticated Users: Modify. D stores an OAuth client there that can mint keys and delete devices (`server/guest-keys.mjs:14-16`, `:41`).

```js
export async function ensurePrivateFolders({
  protect,               // [stateDir, dataDir]: Reach's own folders, tightened every launch
  check = [],            // [codeRoot]: never changed, only checked for write access by others
  nativeDir,             // <stateDir>\native: where helpers are built (inside `protect`)
  files = [],            // cached helpers to check
  run = execFile, build = windowsBinary, platform = process.platform,
}) → { ok: true, sid } | { ok: false, reason }
```

**Order (each launch with the flag; also `.\reach.cmd invites` before it saves the OAuth client):**

1. **Account SID.** `%SystemRoot%\System32\whoami.exe /user /fo csv /nh`. The last CSV field must match `/^S-1-5-21-\d+-\d+-\d+-\d+$/`; otherwise refuse ("Reach couldn't tell which Windows account it runs as").
2. **Protect, SIDs only.** For each `protect` folder: `mkdirSync`, then `%SystemRoot%\System32\icacls.exe <dir> /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *<sid>:(OI)(CI)F /Q`.
   - Only the exit code is read; nothing is parsed.
   - SIDs are used because account names are localized.
   - Inheritable ACEs propagate to existing children.
3. **Fresh checker.** Build `private-folder.cs` into `nativeDir` under a new unique name, then delete older `private-folder-*.exe`.
   - It is compiled fresh every keyed launch (about 1 s), so a file planted while the folder was open is never run.
4. **Verify.** Run `private-folder.exe <sid> state <dir>… code <dir>… file <helper>…`. It prints `ok` or `open <index> <kind>` (`ace`, `owner`, `reparse`, `limit`, `missing`, `error`), then exits.
   - **State folders:** every entry is walked (≤ 20,000).
     - Every owner must be the user, SYSTEM or Administrators.
     - No allow ACE may grant any access to another SID (inherit-only CREATOR OWNER and OWNER RIGHTS are ignored).
     - No reparse points.
   - **Code folders** (root, `bin`, `scripts`, `scripts\native`, `server`, `dist`, `node_modules`; every file under `bin`, `scripts` and `server`, ≤ 5,000):
     - no allow ACE may grant write-type rights (`FILE_WRITE_DATA`, `FILE_APPEND_DATA`, `DELETE`, `WRITE_DAC`, `WRITE_OWNER`, `FILE_DELETE_CHILD`, `GENERIC_WRITE`, `GENERIC_ALL`) to anyone but the user, SYSTEM, Administrators or TrustedInstaller;
     - owners must be in the same set;
     - read access for others is fine.
   - **Files:** the cached `tailscaled-peer` helper must be private and owned by the user.
5. **Result.** Anything `open` → `{ ok: false, reason }`, naming the folder. Launch falls back to pairing (§4.10), and `invites` refuses to save credentials.
   - Example: "Reach's folder C:\reach can be changed by other people on this PC, so browser sign-in stays off. Move it into your user folder, or install Reach with npm."

**Requirements on workstream A's `windowsBinary` (from D):**

- **Compiler:** `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe` by absolute path, with `/platform:anycpu /deterministic /optimize+ /nologo /noconfig`. Never `anycpu32bitpreferred`.
- **Signature:** `windowsBinary(kind, { dir, fresh = false }) → { file, sha256 }`.
  - `dir` is required, and must be a folder `ensurePrivateFolders` protected this launch. Never `config.dataDir` unchecked: `desktopBinary`'s pattern (`server/desktop-native.mjs:12-20`) is safe on macOS only because of 0700.
  - `fresh: true` → `<kind>-<srcHash12>-<random8>.exe`.
  - Otherwise → `<kind>-<srcHash12>.exe`, plus `<kind>-<srcHash12>.sha256`, written right after the build.
  - A cached build is reused only after this launch's fresh checker has passed on the file and its folder, and its hash matches the manifest.
- **`spawnVerified(file, sha256, args, options)`:** re-reads the file and compares its sha256 right before every spawn, restarts included. A mismatch is refused: "Reach's helper changed on disk."
- **Tests:** A's own tests cover all of this. D's tests (§7) cover the D call sites.

Flag-off Windows (pairing mode) keeps today's state folder as it is. Protecting it is a follow-up outside D (§10).

### 4.6 `scripts/tailscale.mjs`

**`foreignIngressRoute(config, port, ownTarget)`:**

- It looks at the background config, `Foreground[*]` (through `serveConfigs`) and `Services[*]`.
- It returns true if any of these leads to port Q, **whatever its host**:
  - a `TCPForward` whose port (after the last `:`) is `port`;
  - a `Proxy` other than `ownTarget` whose URL port is `port`. Bare `host:port` values are parsed as `tcp://host:port`.
- Spellings it must catch: `127.1`, `LOCALHOST`, `localhost.`, `[::ffff:127.0.0.1]`, `[::1]`, the PC's name and LAN IPs.
- `unix:` values are skipped. Any other value without a readable port counts as foreign (fail closed), and the message says so.
- With `ownTarget = ""`, every route to Q counts. §4.10's stop wait uses that.

**Other changes:**

- `tailscaleJson(args, { redact = (text) => text } = {})`: the raw `why` text is redacted **before** `.split("\n")[0].slice(0, 160)`. The default leaves every existing call and output unchanged.
- `tailscaleCliVersion()`: the first half of `tailscaleVersions()` (lines 47-54), factored out. `tailscaleVersions` uses it unchanged.
- `readKeyedState({ redact } = {})`, which runs these three in parallel:
  - `{ status }` from `tailscaleJson(["status", "--json"], { redact })`;
  - `{ prefs }` from `tailscaleJson(["debug", "prefs"], { redact })`, with a failure giving `null`;
  - `{ cliVersion }` from `tailscaleCliVersion()`.
  - The prefs are never logged.

### 4.7 `scripts/persistent-serve.mjs`

`tailscaleSaid(text, redact = (t) => t)` applies `redact` before splitting and before the 400-character cut. Existing callers pass nothing, so their output is unchanged.

### 4.8 `scripts/foreground-serve.mjs`

None of this touches macOS: `ForegroundServe` is used only on win32. Every new option's default is today's Windows behaviour.

- **New constructor options (22-42):**
  - `args` (default `["serve", `--https=${port}`, target]`)
  - `exact` (default `exactForegroundRoute`)
  - `free` (default `(config) => assertUnusedPort(config, this.port)`)
  - `redact` (default identity)
  - `lock` (default none)
  - `awaitEnable` (default false)
  - `awaiting` (default no-op)
  - `file` may be empty.
- **`owns` (47-49):** uses `this.exact`. **62/103:** `this.exact`. **66-71/74:** only `if (this.file)`. **72:** `this.free(config)`. **76:** `this.spawnServe(this.args)`.
- **Lock:** `open()` runs inside `this.lock` when given. The lock is held from the first `inspect` through the free check and the spawn, until one of these:
  - the route shows in `serve status` (exact);
  - the attempt fails;
  - the child enters awaiting enablement.
  - Launch shares one lock between the private session and the Funnel session (§4.10). The two CLIs then never race on the serve-config ETag (§1, row 19).
- **ETag retry:** a child that exits before the route is up, with "Another client is changing the serve config" in its output, is restarted at once. Up to 3 tries, 250 ms apart, inside the same lock hold. That counts neither as a failure nor towards backoff.
- **Awaiting enablement** (`awaitEnable: true`, Funnel only):
  - when the child is alive and a complete output line matches `https://(login|console).tailscale.com/…`, the `waitMs` deadline is suspended and `this.awaiting(url)` is called once;
  - the child holds the watch and continues once Funnel is enabled (§1, row 18);
  - `stop()` still ends it.
- **Output (78-83):** redacted line by line, because the key can be split across chunks.

```js
let pending = "";
const hear = (chunk) => {
  held.said += chunk;
  pending += chunk;
  const lines = pending.split("\n");
  pending = lines.pop();
  for (const line of lines) { this.output(this.redact(line) + "\n"); this.noticeEnable(line); }
  if (pending.length > 8192) pending = "";   // dropped, never a partial key
};
// on exit: if (pending) this.output(this.redact(pending)); pending = "";
```

- **Errors (90, 100, 110):** `this.exited(this.redact(...))`; `throw Error(tailscaleSaid(held.said, this.redact) || …)`. The redactor runs **before** the cut.
- **Spawn errors:** a raw spawn error is never rethrown, because it carries `.spawnargs`. Only `.code` is kept.

### 4.9 `scripts/public-link.mjs` and `scripts/foreground-funnel.mjs` (new)

**`public-link.mjs`:**

- Gains `exactForegroundFunnel(config, origin, target)`:
  - exactly one serve entry has anything on 443, and it is one of `Object.values(config.Foreground)`;
  - `funnelRoute(entry, origin, target) === "ours"`;
  - the TCP, Web and handler entries each have a single key (as in `exactBackgroundFunnel`).
- **Retire `PublicLink`** (75-191). Nothing runs it any more: only `test/public-link.test.mjs` does. Its foreground role passes to `ForegroundFunnel`, which builds on `ForegroundServe` and its Windows lessons.
- `funnelRoute`, `exactBackgroundFunnel`, `startOrigin` and their tests stay.

**`scripts/foreground-funnel.mjs`** exports `ForegroundFunnel`, with the surface launch uses on `EphemeralFunnel`: `start()`, `ensure()`, `stop()`, `live`, `lastError` and the `changed` callback.

- **Constructor:** `{ origin, target, window, inspect, spawnServe, report, log, changed, redact, lock, now, every, clearEvery, delay, ensureMs = 15000, inspectMs = 10000, waitMs = 20000 }`.
- **One holder:**

```js
new ForegroundServe({ file: "", origin, target, args: ["funnel", "--https=443", target],
  exact: exactForegroundFunnel,
  free: (c) => { if (funnelRoute(c, origin, target) !== "free") throw Error(CONFLICT); },
  redact, lock, awaitEnable: true,
  awaiting: (url) => { this.enableUrl = url; this.warn(`Allow Tailscale Funnel for this computer: ${url}`); },
  output: (t) => log?.write(t), exited: () => { this.live = false; } })
```

- **A 1 s monitor calls `sync()`:**
  - alive and owning the route (inspected at most every `inspectMs`) → `live = true`, `enableUrl = ""`;
  - alive and awaiting enablement → left alone (never killed or respawned);
  - not alive → `holder.start()` with backoff (1.5 s doubling to 60 s), with errors through `warn(redact(message))`;
  - alive but the config is no longer exact → `live = false`, `warn(CONFLICT)`.
- **The three enablement behaviours (§1, row 18):**
  - URL on stdout, then exit 0: thrown as the start error (URL included, redacted), reported once, then backoff.
  - Blocking: awaiting, as above.
  - `CheckFunnelAccess` on stderr, then exit 1: thrown and reported, then backoff.
- **`ensure()`** behaves like `EphemeralFunnel.ensure` (203-214): throw if `window()` isn't open; wait up to `ensureMs`; rethrow `CONFLICT`. With `enableUrl` set it throws "Tailscale Funnel isn't allowed for this computer yet: <url>".
- **`stop()`:** stop the monitor, then `await holder.stop()`, then `live = false`.
- It never uses `--bg`, never forks a janitor and never writes a record file.

### 4.10 `scripts/launch.mjs`

- **Imports:**
  - `keyedSupportProblem` and `windowsAccount` from `./configure.mjs`
  - `newIngressKey`, `keyedTarget` and `keyRedactor` from `../server/tailscale-auth.mjs`
  - `createTailscaledPeerCheck` from `../server/tailscaled-peer.mjs`
  - `ensurePrivateFolders` from `../server/windows-private-folder.mjs`
  - `ForegroundFunnel` from `./foreground-funnel.mjs`
  - `foreignIngressRoute` and `readKeyedState` from `./tailscale.mjs`
- **75 (crash guard):** `let crashRedact = (t) => t;` then `installCrashGuard({ dataDir, supervised, redact: (t) => crashRedact(t) })`. On macOS this is identity, so the output is unchanged (§4.12).
- **80-86** become the block below. On macOS the calls and their order are identical; the win32-only check short-circuits.

```js
let preferences = !options.local && accountApproval() ? readPreferences(root) : null;
// Set up for browser sign-in, started without the flag: say so (never silently).
if (!preferences && process.platform === "win32" && !options.local && !windowsAccount() && fs.existsSync(preferencesFile(root)))
  console.log("Reach: browser sign-in is off: REACH_WINDOWS_ACCOUNT=1 isn't set in this terminal. Phones join with a pairing code and need the Tailscale app.");
const keyedDoor = !!preferences && process.platform === "win32";
const socketPath = preferences && !keyedDoor ? serveSocketPath(root) : null;
let peerCheck = null, ingressKey = "", keyedState = null, signInOff = "";
if (preferences) {
  const status = await tailscaleJson(["status", "--json"]);
  assertOwnerAccount(status, preferences);
  if (!keyedDoor) await assertSocketSupport();
  else {
    // Code-only options (tests); never parsed from argv or env.
    const folders = await (options.privateFolders || ensurePrivateFolders)({
      protect: [privateDir, dataDir], check: [root], nativeDir: path.join(privateDir, "native") });
    keyedState = folders.ok ? await readKeyedState().catch(() => ({ status })) : null;
    if (folders.ok) peerCheck = options.peerCheck || createTailscaledPeerCheck({ helper: folders.helper("tailscaled-peer") });
    const problem = folders.reason || keyedSupportProblem(keyedState) || (await peerCheck.ready()).reason || "";
    if (problem) {
      signInOff = problem;
      console.log(`Reach: browser sign-in is off on this PC for now: ${problem} Phones join with a pairing code and need the Tailscale app.`);
      await peerCheck?.close(); peerCheck = null; preferences = null;
    } else ingressKey = newIngressKey();
  }
}
const redact = ingressKey ? keyRedactor(ingressKey) : (text) => text;
if (ingressKey) crashRedact = redact;
```

- **100:** `const publicStart = (socketPath || ingressKey) && privateOrigin ? startOrigin(privateOrigin) : "";`
- **214-241:**
  - Hoist `startPage` and `const publicApp = startPage ? (req, res) => reach.publicAgent(req, res) || reach.publicFaceId(req, res) || startPage(req, res) : undefined;` out of `if (socketPath)`. This is a pure move: on macOS `publicStart` is empty without a socket.
  - Keep the socket branch, passing `{ publicApp }`.
  - Add:

```js
let ingressPort = 0, foreignRoute = false, routeProblem = "", keyedMisses = 0;
let selfIps = keyedState?.status?.Self?.TailscaleIPs || [];
const refusals = { key: 0, peer: 0, route: 0, settings: 0 };
let refusedSaidAt = 0;
const noteRefusal = (kind) => {
  refusals[kind]++;
  if (Date.now() - refusedSaidAt < 60000) return;
  refusedSaidAt = Date.now();
  const why = { peer: "not from Tailscale's own process", key: "without its key",
    route: "another route leads to it", settings: "Tailscale's settings on this PC don't allow it now" }[kind];
  const line = `Reach: refused a connection to its private route (${why}).`;
  console.warn(line); log?.write(line);
};
if (ingressKey) ingressPort = await reach.listenKeyed({ key: ingressKey, peerCheck, publicApp,
  refuse: () => (foreignRoute ? "route" : routeProblem ? "settings" : ""), onRefused: noteRefusal, selfIps: () => selfIps });
const serveTarget = socketPath ? `unix:${socketPath}` : ingressKey ? keyedTarget(ingressPort, ingressKey) : localUrl;
const routeLabel = ingressKey ? `http://127.0.0.1:${ingressPort}/r-…` : serveTarget;
```

- **`statusFile` (260):** `tailscaleApproval: !!preferences`, so `./reach approve` reports correctly after a fallback. Add `...(process.platform === "win32" && signInOff && { signInOff })` so `.\reach.cmd status` can say why.
- **331-344:**
  - Pass `redact` to `ForegroundServe`.
  - In keyed mode, also pass `lock: serveLock`, where `const serveLock = createLock()` is one promise chain shared with `ForegroundFunnel`.
- **349 and 353:** log `routeLabel` instead of `serveTarget`.
- **354-357 (startTunnel catch):** `error.message = redact(error.message);` before `setupHint`/`throw`.
- **359-369 (recovery):**
  - `inspect: async () => { const c = await tailscaleJson(["serve", "status", "--json"], { redact }); if (ingressKey) noteForeign(c); return c; }`
  - `available: (value) => privateUp(value && !foreignRoute && !routeProblem)`
  - `report` redacts first.
  - `noteForeign(c)` sets `foreignRoute = foreignIngressRoute(c, ingressPort, serveTarget)`. On a false→true change it calls `reach.setTransportAvailable(false)` and reports once: "Another Tailscale route leads to Reach's private port; Reach refuses it until it's removed (tailscale serve status)."
- **Keyed settings monitor** (new, keyed mode only, every 15 s, `unref`):
  - It reads `readKeyedState({ redact })`, then:
    - `selfIps = status.Self.TailscaleIPs`;
    - `setRouteProblem(keyedSupportProblem(state))`.
  - **Failed reads:** a failed read counts as a miss. Two misses in a row → `setRouteProblem("Reach couldn't read Tailscale's settings on this PC.")`. This is the "one failed read says nothing, two do" rule of `PrivateLinkRecovery`, so one slow CLI doesn't drop phones. A read that fails at launch already refused keyed mode above.
  - **`setRouteProblem`:**
    - Non-empty → `reach.setTransportAvailable(false)` and one message: "Browser sign-in paused on this PC: <problem> It resumes by itself once that changes."
    - Cleared → "restored", and recovery makes the transport available again.
  - **What it catches:** `tailscale set --advertise-exit-node`, a Tailscale restart into userspace mode, or a version downgrade while Reach runs.
- **393-396:** when `ingressKey && refusals.peer > 0`, throw instead: "Reach couldn't confirm that its private route comes from Tailscale's own service on this PC, so it stays closed. Start without REACH_WINDOWS_ACCOUNT=1 to use pairing codes."
- **399-441:** hoist the `report` and `changed` callbacks into consts, then:

```js
publicLink = ingressKey
  ? new ForegroundFunnel({ origin: publicStart, target: serveTarget, window: reach.funnelWindow, log, redact, lock: serveLock,
      report: (m) => report(redact(m)), changed })
  : new EphemeralFunnel({ …unchanged… });
```

- **`stop()` (168-184):** the new lines are guarded by `ingressPort`, so macOS is unchanged.

```js
await publicLink?.stop();
recovery?.stop();
clearInterval(keyedMonitor);
// Windows' route ends before Reach's listener does.
await foreground?.stop();
// tailscaled drops a session after its CLI exits (§1 row 23): wait until neither
// session leads to the keyed port, so nobody who binds it next gets a request.
// At most 1.5 s, and never past 4 s into stop(): the 5 s exit deadline (162-167) holds.
if (ingressPort) await routesGone(ingressPort, { until: Math.min(Date.now() + 1500, stopStartedAt + 4000) });
power?.stop();
await reach.close();
await peerCheck?.close();
```

  - `routesGone` polls `serve status` every 100 ms until `!foreignIngressRoute(config, ingressPort, "")`. On timeout it logs "Tailscale still listed Reach's private route; closing anyway." and continues.

### 4.11 `server/index.mjs`

- **10-16:** import `listenKeyedIngress` and `thisComputerRequest`.
- **~172:** `const hostPlatform = overrides.platform || process.platform;`
- **268-276:** `config.tailscaleOwner && config.publicOrigin && hostPlatform !== "win32"`. No linking on Windows yet.
- **293-296:** the Windows sentence only when `hostPlatform === "win32" && !config.tailscaleOwner`.
- **307-315:** `passkeys && guestKeys && hostPlatform !== "win32"`. No Face ID join on Windows yet; `publicFaceId` then answers 404.
- **2624-2625:** `if (!prepareFunnel && hostPlatform === "win32" && !config.tailscaleOwner) throw fail(503, noInviteKeys);`
- **5406-5456:**
  - Extract the door into a closure. This is a pure move of `knownKey`, `doorKeyKnown` and `doorCookie` (5411-5420) and the `publicApp` wrapper (5427-5455).
  - `listenPrivate` keeps setting `privateSocket` as today.

```js
const door = (publicApp) => publicApp && ((req, res) => { /* lines 5428-5454 unchanged */ });
async listenPrivate(socketPath, { publicApp } = {}) { …; privateServer = await listenPrivateIngress({ socketPath, app, upgrade, resolveIdentity, publicApp: door(publicApp) }); },
// Windows (REACH_WINDOWS_ACCOUNT=1): the same door on a keyed loopback route.
async listenKeyed({ key, peerCheck, publicApp, refuse, onRefused, selfIps } = {}) {
  if (!config.tailscaleOwner) throw Error("Configure Tailscale identity first.");
  privateServer = await listenKeyedIngress({ key, peerCheck, refuse, onRefused, selfIps, app, upgrade, resolveIdentity, publicApp: door(publicApp) });
  return privateServer.address().port;
},
```

- **Requests from this PC itself** (§0.8, §11 D1). `fromThisComputer = (req) => hostPlatform === "win32" && thisComputerRequest(req)`. On macOS it is always false, because `listenPrivateIngress` never marks a request.
  - **`THIS_COMPUTER_SIGN_IN = "refuse"`** (a code constant, never env or argv; the default per D1):
    - `GET /api/auth/method` (1306-1320) answers `{ method: "tailscale", eligible: false, thisComputer: true }`, without `login`.
    - `POST /api/auth/requests` (1396) → 403 "New sign-ins from this PC's own browser are off on Windows for now: anyone signed in to Windows here could ask as you. Sign in from your phone."
    - Requests that already carry a device token are unaffected.
  - **`"label"`** (if the owner chooses it):
    - `approvals.request(identity, name, owner, { thisComputer: true })` stores the flag; `server/device-approval.mjs` `request` gains an optional fourth argument and stores the field only when true.
    - `scripts/approve-device.mjs:15` and the phone's approval notification add the line: "From this PC itself: anyone signed in to Windows here could have asked. Approve only if you just asked from this PC's browser."
  - **UI:** `src/ConnectForm.tsx` shows `thisComputer` as "Sign-in from this PC's own browser is off for now. Use your phone." This is an interface change and needs no restart.
- **`close()` (5469)** already closes `privateServer`.
- **Passkeys stay:** Face ID approval of your own devices happens on the private link.

### 4.12 `server/crash-guard.mjs`

- `installCrashGuard({ …, redact = (text) => text })` applies `redact` to the raw stack or message **before** `clean(…, max)` and `firstLine`. That covers stderr, `crash.log` and `last-crash.json`.
- The default is identity, so existing callers and tests are unchanged.

### 4.13 `server/browser-access.mjs`: no change

- 196 and 328 test a `prepareFunnel` closure that `index.mjs` always passes; the refusal lives in that closure (§4.11).
- 227-228 and 244-245 are workstream E.

### 4.14 Other places the flag reaches

- **`scripts/link.mjs:20`:** `if (!accountApproval(deps.platform)) throw` (existing message). Add: `if ((deps.platform || process.platform) === "win32") throw Error("Linking computers isn't available on Windows yet.");`
- **`scripts/invites.mjs:27`:** on win32, run `ensurePrivateFolders` (§4.5) before saving `tailscale-oauth.json`, and refuse with its reason otherwise.
- **`scripts/approve-device.mjs:41`, `scripts/setup.mjs:136`/`:377`/`:389`, `scripts/bootstrap.mjs:713`/`:741`:** they follow `accountApproval`.
- **Same sentence as §4.1 for `invites` and `approve`:** when `preferences.json` exists on win32 but the flag is missing, their refusals add it.
- **`scripts/bootstrap.mjs:247`:** replace `process.platform !== "win32"` with `(await import("./configure.mjs")).accountApproval()`. Source checkouts then build `tailnet/dist` for the start page.
- **The flag across restarts:** a Windows `.\reach.cmd restart` starts Reach again in the same terminal (`bootstrap.mjs:448-492` returns false), so the variable carries over. The phone's Restart path (`index.mjs:4383-4391` → `scripts/stop.mjs:250-257`) opens macOS Terminal and isn't a Windows path today.

### 4.15 Left unchanged on purpose

- `scripts/persistent-serve.mjs`, apart from `tailscaleSaid`'s optional parameter.
- `scripts/ephemeral-funnel.mjs`, `scripts/funnel-lease-worker.mjs`, `scripts/stop.mjs`, `listenPrivateIngress`, `PrivateLinkRecovery`.
- On Windows nothing is recorded: `ForegroundServe` deletes `serve-owner.json`, and `ForegroundFunnel` writes no file.

## 5. The key

- **Lifetime:** 32 random bytes, base64url (43 characters). Made once per launch, after the private folders, the keyed settings and the peer check are confirmed.
- **It lives only in:**
  - the launch closure (`ingressKey`, `serveTarget`, `redact`);
  - the listener closure (`expected`);
  - the two CLI children's argv;
  - tailscaled.
- It is never put in `reach.config`, `host-status.json`, `agent-host.json`, route records, `./reach status`, the crash log or any response.
- **Redactor (`keyRedactor`, §4.2).** It replaces:
  - the key;
  - any `/r-` followed by exactly 43 base64url characters;
  - any run of 12 or more base64url characters that shares a 12-character window with the key.
  - So a key cut at any point is still removed.
  - It exists only when `ingressKey` is set, so macOS output never changes. The darwin socket folder is also named `r-<suffix>` (`serveSocketPath`), so a global pattern would have touched macOS output.
- **Redaction runs at the source, before any truncation:**
  - `ForegroundServe`, line by line, including thrown messages and `exited`, through `tailscaleSaid(text, redact)` before its 400-character cut;
  - every keyed-mode `tailscaleJson` call, before its 160-character cut (this covers V8's JSON-parse snippets);
  - `ForegroundFunnel.warn` and `report`;
  - `PrivateLinkRecovery.report`;
  - the `startTunnel` catch;
  - the keyed settings monitor;
  - launch's own lines (`routeLabel`);
  - the crash guard (`crashRedact`, §4.12).
  - Spawn errors are never serialized (`.spawnargs`).
- **Comparison:** `crypto.timingSafeEqual` on 47 latin1 bytes. The prefix must be exactly `/r-<key>/`.
- **Rotation:** a new key and a new port every launch.
- **Visible to (accepted):** this Windows user, administrators and SYSTEM, and Tailscale's local and uploaded logs (§1, row 10).
- **Tests:** every test that runs a keyed Reach searches the whole temporary state tree, stdout and stderr for the key and for any 12-character substring of it. That includes runs where the key falls across the 400- and 160-character cut points and a forced crash.

## 6. The peer check

**Line protocol** between `server/tailscaled-peer.mjs` and the helper:

| Direction | Line | Notes |
|---|---|---|
| out (once) | `ready 1` or `error <code>` | codes: `no-service`, `not-running`, `not-own-process`, `not-localsystem`, `not-tailscaled`, `access`, `arch`, `arch32` |
| in | `q <id> <ingress> <port>[,<port>]*` | `id` 1..999999999; ports 1..65535; ≤ 64 per line |
| out | `a <id> <port>:<v>( <port>:<v>)*` | `<v>` = `t:<createdMs>` \| `o` \| `g` \| `n` \| `e`. Parsed with `/^a (\d{1,9})((?: \d{1,5}:(?:t:\d{1,15}\|[ogne]))+)$/`. True only for `t` with `0 < createdMs <= acceptedAt + 20`. |

- **Why the accept time:**
  - The kernel frees a reset connection's address pair at once. A key holder could send a full keyed request, reset the connection, and hope tailscaled's next backend connection reuses the pair before the helper reads the table.
  - That connection's row is created after Reach accepted the attacker's socket, so `createdMs > acceptedAt` refuses it.
  - Together with the "still open" check after the await (§4.2), the remaining window is a reuse inside the 20 ms clock slack, before Node has seen the reset (§10, risk 5).
- **Clock slack:** the kernel's timestamp comes from the coarse system clock (≈ 15.6 ms ticks), and `Date.now()` from the same system time. CI case 2 records both values to confirm the slack.

**Reasons shown on fallback:**

| Code | Message |
|---|---|
| `no-service` | "Tailscale isn't installed as a Windows service here." |
| `not-running` | "Tailscale's Windows service isn't running." |
| `not-own-process`, `not-localsystem`, `not-tailscaled` | "Tailscale's Windows service isn't set up the usual way (code)." |
| `access` | "Windows didn't let Reach read Tailscale's service settings. This happens when Reach runs outside a signed-in Windows session (over SSH, or as a scheduled task); start it from a Terminal window on the PC." |
| `arch` | "This Windows isn't 64-bit." |
| `arch32` | "Reach's Tailscale check was built as 32-bit (arch32)." |
| spawn failure | "Reach's Tailscale check couldn't start (code)". This includes Smart App Control or WDAC blocking the helper, and a hash mismatch. |

**Batching:** checks made in the same tick are grouped by ingress port into one `q` line, flushed on `setImmediate`.

**Cache:** a `WeakMap<socket, Promise<boolean>>` in the listener, deleted on the socket's `close`.

**Fail-closed rules:**

| Event | Result |
|---|---|
| Not win32 | `false`, nothing spawned |
| `socket.remoteAddress` or `localAddress` isn't `127.0.0.1` | `false` |
| No `acceptedAt` for the socket | `false` |
| `t` with `createdMs` 0, or later than `acceptedAt + 20` | `false` |
| The socket closed, or `refuse()` turned on, during the check | Request dropped (§4.2) |
| The helper didn't start, or answered `error` at start | `ready()` → `{ ok:false, reason }` → pairing mode |
| No answer within `answerMs` | That batch is `false`; the helper is killed and restarted after `restartMs` (re-hashed first) |
| The helper exits | Everything pending is `false`; `onProblem("stopped")`; restart after `restartMs` |
| A line over 4096 bytes, a stdout buffer over 64 KiB, or a malformed line | The helper is killed; everything pending is `false` |
| An answer for an unknown `id` or port | Ignored (the asked port resolves `false` at timeout) |

**Cost:** one round-trip of a few milliseconds per new backend connection. With the 100 s keep-alive (§4.2), new connections are rare.

## 7. Unit tests (as-windows and injected dependencies)

Run them a few files at a time, never two heavy runs at once:

- `npm run test:file -- test/windows-keyed-ingress.test.mjs test/tailscaled-peer.test.mjs`
- `npm run test:file -- test/foreground-serve.test.mjs test/foreground-funnel.test.mjs`
- `npm run test:file -- test/windows-account-flag.test.mjs test/windows-route-audit.test.mjs`
- `npm run test:file -- test/windows-private-folder.test.mjs test/crash-guard.test.mjs`
- `npm run test:file -- test/windows-account-launch.test.mjs`

**`test/windows-keyed-ingress.test.mjs`** runs `listenKeyedIngress` in-process with fake `peerCheck`, `resolveIdentity`, `app` and `upgrade`.

1. Each of these gives 404, then the socket is destroyed:
   - a missing key; a key one character off; a short key; `/r-`; the key lower-cased; the key in a query string; `/r-<key>x`; absolute-form; `*`.
   - `app`, `resolveIdentity` and `peerCheck` are never called.
2. Right key with `peerCheck` false → the socket is destroyed with zero response bytes.
3. Right key with `peerCheck` true:
   - `app` sees `/api/health?x=1`;
   - `req.originalUrl` has no key;
   - `trustedRequest(req)` is true;
   - `serveRequestHost(req)` equals `X-Forwarded-Host`.
4. Keep-alive:
   - two keyed requests → `peerCheck` called once, with that socket's `acceptedAt`;
   - a third without the key → 404 and destroyed;
   - a new socket → called again;
   - after `close`, the cache entry is gone.
5. Raw-path stand-in: `peerCheck` true but no key → 404 and destroyed.
6. WebSockets:
   - keyed and peer OK → `upgrade` sees the path without the key;
   - no key, peer false, or Funnel-marked → destroyed.
7. Funnel-marked keyed request → `publicApp` only: no `resolveIdentity` and no trusted mark. Without `publicApp` → 404.
8. `/r-K/files/a%2Fb` → `/files/a%2Fb`.
9. A non-ASCII `req.url` of the same length doesn't throw.
10. Malformed HTTP → destroyed.
11. A malformed key, or no `peerCheck` → rejects before anything listens.
12. `refuse()` returns `"route"` or `"settings"` → every request and upgrade is destroyed, with `onRefused(kind)`.
13. **New: socket closed while checking.** `peerCheck` resolves true only after the client has destroyed the socket (and, separately, after `refuse()` turned on) → `app` and `upgrade` are never called.
14. **New: this computer.**
    - `X-Forwarded-For` among `selfIps()` → `thisComputerRequest(req)` true;
    - any other address → false;
    - a Funnel-marked request is never marked.
15. **New:** `server.keepAliveTimeout === 100000` and `headersTimeout === 105000` on the keyed server. `listenPrivateIngress`'s server keeps Node's defaults.

**`test/tailscaled-peer.test.mjs`** uses a fake helper child (an EventEmitter with stdin and stdout streams).

1. Start-up answers:
   - `ready 1` → ok;
   - each `error <code>` → its reason, including `arch32` and the non-interactive `access` text;
   - garbage → not ok;
   - spawn `EACCES` → not ok with the code;
   - a hash mismatch from `spawnVerified` → not ok.
2. Two sockets in one tick → one `q` line; 70 sockets → two lines.
3. **New:** `t:<created>`:
   - true when `created <= acceptedAt + 20`;
   - false when later, when 0, or without `acceptedAt`;
   - `o`, `g`, `n`, `e` and a missing port → false;
   - unknown ids are ignored.
4. Timeout → false, then the helper is killed and restarted after `restartMs` (fake clock). A check during backoff → false.
5. Helper exit with checks pending → all false.
6. Oversized line or buffer → killed, false.
7. `platform: "darwin"` → `ready` not ok, `check` false, `spawnHelper` never called.
8. A non-loopback socket → false, nothing sent.
9. Static check on `scripts/native/tailscaled-peer.cs`:
   - it has the constants `"Tailscale"` and `"tailscaled.exe"`, and table class 8;
   - it has no `GetEnvironmentVariable`, no `File.`/`Directory.` writes and no `Process.Start`.

**`test/foreground-serve.test.mjs`** (extend):

1. Redaction with output split mid-key across chunks: no 12-character substring of the key in the log.
2. **New:** a thrown message whose key straddles the 400-character cut of `tailscaleSaid` → no 12-character substring.
3. `exited` reason redacted.
4. `args`, `exact` and `free` overrides used. `file: ""` → no read or remove.
5. **New ETag:** a child that prints "Another client is changing the serve config; please try again." and exits 1 before the route is up is restarted at once. It succeeds on the second try, with no thrown error and no backoff.
6. **New lock:** two instances sharing a lock.
   - The second spawns only after the first's session shows.
   - A child awaiting enablement releases the lock.
7. **New awaiting:** with `awaitEnable`, a child that prints a login URL and stays alive isn't killed at `waitMs`. `awaiting(url)` is called once. Without `awaitEnable` (today's private session), `waitMs` still applies.
8. Existing cases unchanged.

**`test/foreground-funnel.test.mjs`** (new):

1. Spawns `["funnel", "--https=443", target]` with no `--bg`. `live` becomes true only on `exactForegroundFunnel`.
2. Something else on 443 → `CONFLICT`, nothing spawned, `ensure()` throws `CONFLICT`.
3. The child exits → `live` false → restarted with backoff.
4. **New, the three enablement behaviours (§1, row 18):**
   - (a) text and URL on stdout, exit 0 → reported once with the URL, then backoff, never a respawn loop faster than the backoff;
   - (b) URL on stdout, then blocking → one child kept alive past `waitMs` and never respawned; `ensure()` throws "isn't allowed for this computer yet: <url>"; when the fake enables Funnel, the same child's session appears and `live` turns true;
   - (c) `CheckFunnelAccess` text on stderr, exit 1 → reported, then backoff.
   - In each case, no 12-character substring of the key appears in the output.
5. `ensure()` with the window closed → throws.
6. `stop()` ends the child, and no file is written in the state directory.
7. `exactForegroundFunnel` truth table:
   - background route → false;
   - two entries on 443 → false;
   - extra handler key → false;
   - `AllowFunnel` false → false.

**`test/windows-account-flag.test.mjs`** (new):

1. `accountApproval`:
   - darwin/linux → true whatever the environment;
   - win32 without the flag → false;
   - `"1"` → true;
   - `"true"` or `"yes"` → false.
2. `keyedSupportProblem`:
   - daemon 1.103.x / 1.104.0 / 1.110.1 / 2.0 / missing;
   - CLI older than 1.104 with a new daemon;
   - `TUN` false or missing;
   - `prefs` null, or without `AdvertiseRoutes`;
   - `AdvertiseRoutes` of `0.0.0.0/0`, `::/0`, `127.0.0.0/8`, `127.0.0.1/32`, `::1/128`, `::ffff:127.0.0.0/104`, `garbage` (each → problem), and `10.0.0.0/8` or `192.168.1.0/24` (fine).
3. `configure` with `platform: "win32"`:
   - flag off → existing refusal, plus the extra sentence when `preferences.json` exists;
   - flag on → the keyed check is called and `serve --help` isn't;
   - an old version, or an exit node → throws "No settings changed".
4. `setupLink` on win32 refuses with and without the flag. `setupInvites` on win32 with the flag passes the platform gate, then requires private folders (injected fake: refused → no OAuth file written).
5. `createReach({ platform: "win32", tailscaleOwner, publicOrigin })`:
   - `fleet` null, `guestKeys` present;
   - `publicFaceId` → 404;
   - `GET /api/guests/keys` has no `available: false`;
   - `prepareFunnel` without a controller → the generic 503;
   - without an owner → the Windows sentence.
6. **New: this computer** (keyed transport):
   - the default `"refuse"` → `/api/auth/method` gives `eligible: false, thisComputer: true` with no `login`, and `POST /api/auth/requests` → 403;
   - `"label"` → the request is stored with `thisComputer: true`, and `approve-device`'s prompt shows the line;
   - with `platform: "darwin"` and `listenPrivate`, responses and prompts are byte-identical to today's.

**`test/windows-route-audit.test.mjs`** (new):

- `foreignIngressRoute` is true for a `TCPForward` or a foreign `Proxy` to port Q spelled as `127.0.0.1`, `127.1`, `LOCALHOST`, `localhost.`, `[::1]`, `[::ffff:127.0.0.1]`, `0.0.0.0`, the PC's name, or a bare `host:Q`.
- That holds in the background config, in `Foreground[*]` and in `Services[*]`.
- It is false for Reach's own exact target, other ports and `unix:` targets.
- An unparsable value counts as foreign.
- With `ownTarget = ""`, Reach's own target counts too.

**`test/windows-private-folder.test.mjs`** (new; injected `run` and `build`):

1. The `whoami` CSV is parsed by SID only. A localized account name doesn't matter. A non-`S-1-5-21-` SID → refused.
2. The exact `icacls` argv uses SIDs only, with `/inheritance:r` and `/grant:r`, for both the state and data folders; a non-zero exit → refused.
3. The checker is built with `fresh: true` on every call, and older `private-folder-*.exe` files are removed.
4. Each `open <i> <kind>` → refused, with that folder named. `ok` → `{ ok: true }`.
5. A cached helper with the wrong manifest hash → rebuilt. `spawnVerified` after the file changed → refused.
6. Static check on `private-folder.cs`: no writes; reads only DACLs, owners and attributes.

**`test/crash-guard.test.mjs`** (extend): with `redact` set, a stack carrying the key across the 300- and 8000-character cuts leaves no 12-character substring in stderr, `crash.log` or `last-crash.json`. Without it, the output is byte-identical.

**`test/windows-account-launch.test.mjs`** (new, wired, as-windows with fake Tailscale; skipped on win32 like T23 at `windows-commands.test.mjs:120`):

- **Harness:**
  - `startCleanReach` with `preloads: [AS_WINDOWS]`, `env: { REACH_WINDOWS_ACCOUNT: "1", FAKE_TTY: "1" }`, a `"1.104.0"` scenario, and `.reach/preferences.json` written in `prepare`;
  - the peer check and private folders are injected with `launchCode` (§7.1).
- **Asserts:**
  1. Two live sessions, `["serve", "--https=8443", T]` and `["funnel", "--https=443", T]`, with the same `T` matching `/^http:\/\/127\.0\.0\.1:\d+\/r-[A-Za-z0-9_-]{43}$/`. No `--bg`, no `funnel-owner.json`, no lease worker.
  2. "Open on your phone: https://mac.example.ts.net", with no pairing code.
  3. Through the fake proxy:
     - `GET /api/auth/method` → `{ method: "tailscale", eligible: true }`;
     - Funnel-marked `GET /` with the window open → start page.
  4. Through the fake proxy with `x-fake-from: <the PC's own address>` → `eligible: false, thisComputer: true`.
  5. From the test process, the key with a forged `Tailscale-User-Login` → `ECONNRESET`, plus a refusal line within 1 s.
  6. The key is nowhere under the temporary root (excluding the fake's own state and session files) or in stdout/stderr. This includes after a forced session failure, and after an `etagConflicts: 1` scenario.
  7. **Stop:**
     - both sessions are gone before the keyed listener closes (the fake records session-gone times; the test records the listener's close time, with `sessionLingerMs: 300`);
     - `peerCheck.close` is called;
     - the process exits within 5 s.
- **Fallbacks.** Each of these gives "browser sign-in is off on this PC for now", a pairing code, a target with no `/r-`, no Funnel session and `signInOff` in `host-status.json`:
  - fake check `ready → { ok:false, reason }`;
  - `TUN:false`;
  - daemon `1.90.0`;
  - CLI `1.90.0`;
  - `prefs.AdvertiseRoutes: ["0.0.0.0/0", "::/0"]`;
  - `debug prefs` failing;
  - private folders refused.
- **Flag off with `preferences.json` present** → the "isn't set in this terminal" line, then today's T23 output. Flag off without it → T23 exactly (T23 stays the regression).
- **Route audit at runtime:**
  - a background `--tcp` forward to the ingress port, spelled `127.1:<Q>` → within 10 s "Another Tailscale route leads to Reach's private port", and keyed requests are destroyed;
  - remove it → recovers.
- **Keyed settings at runtime:** set `prefs.AdvertiseRoutes` to `["0.0.0.0/0"]` in the fake → within 20 s "Browser sign-in paused on this PC", and keyed requests are destroyed. Clear it → recovers.
- **Restart collision:** kill both fake children at once with `etagConflicts: 1` → both sessions return within 10 s, with no "Another client" text reported.

### 7.1 Test helpers

- **`test/helpers/fake-tailscale.mjs`:**
  - foreground sessions for `funnel` too, with `AllowFunnel`;
  - `TUN: true` by default, with a scenario override;
  - **new commands and scenarios:**
    - `debug prefs` → scenario `prefs` (default `{ AdvertiseRoutes: null }`), or `prefsFail: true` to fail;
    - `version` → scenario `cliVersion`;
    - `funnelEnable: "exit"` → text and URL on **stdout**, exit 0;
    - `funnelEnable: "wait"` → the same on stdout, then wait until `state.funnelEnabled === true`, then continue to the session;
    - `funnelDenied` keeps its current stderr/exit 1 model (the `CheckFunnelAccess` path), so EphemeralFunnel's macOS tests don't move;
    - `etagConflicts: n` → the first `n` set attempts print the ETag message to stderr and exit 1;
    - `sessionLingerMs` → a dead child's session stays listed that long after the first status read that sees it dead, recording when it went.
  - **The keyed proxy model:** when a foreground target's path starts with `/r-`, the session process runs a small proxy on `127.0.0.1:0` that models tailscaled:
    - it prefixes the target path;
    - it deletes `Tailscale-User-*`, `Tailscale-Funnel-Request`, `Forwarded` and `X-Forwarded-*`;
    - it sets `X-Forwarded-Host` to the Host, and `X-Forwarded-For` to `x-fake-from` or `100.64.0.10`;
    - it sets `Tailscale-Funnel-Request: ?1` for funnel sessions, otherwise `Tailscale-User-Login` from its whois;
    - it records `proxy` and the upstream local ports `from[]` with their connect times.
  - `tailnetPreload` sends keyed targets to the session's `proxy` port.
- **`test/helpers/fake-peer-check.mjs`:** `fakePeerCheck(fakeDir, { problem } = {})` → `{ ready, check: (s, acceptedAt) => …, close }`. `check` is true when a live session's `from[]` holds `s.remotePort` with a connect time ≤ `acceptedAt`.
- **`test/helpers/clean-machine.mjs`:** `startCleanReach` gains `launchCode`, a string of extra option entries evaluated in the `-e` script, for example `peerCheck: …, privateFolders: async () => ({ ok: true, helper: () => async () => ({}) })`.
- **`test/helpers/windows-oracle.mjs`:**
  - `parseNetstat(text)` and `parseScQueryex(text)`, as before;
  - `parseWhoamiGroups(csv)` → SIDs;
  - unit-tested on canned English and German output.
- **`.github/scripts/run-tests.mjs:13-20`:** add `windows-keyed-ingress`, `tailscaled-peer`, `foreground-funnel`, `windows-account-flag`, `windows-route-audit` and `windows-private-folder` to the windows list.

### 7.2 Regression set (unchanged on macOS)

- `npm run test:file -- test/tailscale-auth.test.mjs test/private-ingress-platform.test.mjs`
- `npm run test:file -- test/ephemeral-funnel.test.mjs test/public-link.test.mjs`. `PublicLink`'s cases are removed with the class; the `funnelRoute`/`exactBackgroundFunnel` cases stay.
- `npm run test:file -- test/windows-commands.test.mjs test/first-run-launch.test.mjs`
- `npm run test:file -- test/public-start.test.mjs test/guest-keys.test.mjs`
- `npm run test:file -- test/hosted-mcp.test.mjs test/funnel-agent-integration.test.mjs`
- `npm run test:file -- test/crash-guard.test.mjs test/foreground-serve.test.mjs`

**Keyed transport for the door flows:**

- **Where:** in `hosted-mcp.test.mjs` and `funnel-agent-integration.test.mjs`, parameterize `fixture(t, { transport })`.
- **The `"keyed"` variant uses:**
  - `createReach({ platform: "win32", … })`;
  - `reach.listenKeyed({ key, peerCheck: { check: async () => true }, publicApp })`;
  - requests to `127.0.0.1:<port>/r-<key><route>` with the real `Host`.
- **What it reruns:** the same OAuth, tool-call, gateway and door-refusal flows.
- **Where it runs:** Mac and Linux CI; it is skipped on win32 until E.

## 8. Windows CI: a real LocalSystem service

**Spike first.**

- **Where:** `test/windows-tailscaled-peer.test.mjs` runs first in `windows-validation.yml`, triggered by the owner, with `REACH_TEST_WINDOWS_PEER: "1"`.
- **When it joins `ci.yml`:** after three green runs on windows-2025.
- **Why:** windows-2025 is Windows Server, not Windows 11. Logon rights, the window station and service DACL defaults may differ (§1, rows 21-22).

The test runs only when `process.platform === "win32" && process.env.REACH_TEST_WINDOWS_PEER === "1" && process.env.CI === "true"`.

**Setup** (the runner is elevated):

- **Guard:** `sc.exe query Tailscale` must exit 1060. Otherwise fail with "a real Tailscale service is installed; refusing to touch it".
- **Compile with csc (no downloads):**
  - the helpers through A's `windowsBinary`, into a protected folder;
  - `test/fixtures/windows/fake-tailscaled.cs` → `%ProgramFiles%\ReachPeerCI\tailscaled.exe`, with modes `subproc`, `self`, `nokey`, `linger` and `idle`, as before;
  - `test/fixtures/windows/bind-probe.cs` → `bind-probe.exe <addr> <port> plain|reuse [hold <s>]`.
    - It prints `bound` or `refused <wsaerror>`. While holding, it listens and prints `accepted <remote>` for each connection.
    - `[::]` binds with `IPV6_V6ONLY=0`.
  - `test/fixtures/windows/run-as.cs` (below).
- **Users:** `reachci` (stands in for Reach) and `reachci2` (the other user).
  - Both are standard users with random 24-character passwords, created with `net user … /add`.
  - Cleanup goes in `t.after`.
- **Starting as a standard user with an interactive token (`run-as.cs`):**
  - `run` calls `CreateProcessWithLogonW(LOGON_WITH_PROFILE)` with `lpDesktop = "winsta0\\default"`, after granting the user's SID access to WinSta0 and Default with `SetSecurityInfo` (removed in cleanup). That puts the program in the runner's own session, where the service manager refuses another account's program (§1 row 24). The test uses it for everything except Reach's start check.
  - `system-run`, run from a SYSTEM scheduled task, takes LogonUser's interactive token for the user, puts it in session 0 and starts the program with `CreateProcessAsUser`. SYSTEM holds SeAssignPrimaryTokenPrivilege; an elevated administrator doesn't. Reach (peer-host) runs this way for case 1 and the cases after it.
  - `filtered` runs the runner's own token as UAC hands it to a Terminal that wasn't elevated: Administrators deny-only, privileges dropped, Medium integrity, a default DACL for the account. It runs in the runner's own session, for case 1a.
  - If logon fails with `ERROR_LOGON_TYPE_NOT_GRANTED`, the fixture grants `SeInteractiveLogonRight` with `LsaAddAccountRights` and removes it in cleanup.
  - The child writes `whoami /groups /fo csv`, and the test asserts that S-1-5-4 (INTERACTIVE) is present and enabled.
  - If no interactive token can be had, the test **fails** with that named reason; it doesn't skip.
- **Batch-token variant:** `schtasks /create /ru reachci /rp …` runs the same peer-host with a batch token, for case 1b. reachci gets `SeBatchLogonRight` first, since Windows Server doesn't give it to Users.
- **`test/fixtures/windows/peer-probe.cs`** makes the helper's calls one at a time in each of these contexts and names any refusal. A copy of the helper also runs directly in each, and the test logs its first line.
- **Reach stand-in:** `test/fixtures/windows/peer-host.mjs`.
  - It runs `ensurePrivateFolders` and `listenKeyedIngress` with `createTailscaledPeerCheck` and a recording `app`.
  - It writes `{ port, key, ready }` and an events log (including `acceptedAt` and `createdMs` per socket) to a results directory whose `icacls` grants only SYSTEM, Administrators and `reachci`.
- **Register the fixture:**
  - `sc.exe create Tailscale binPath= "\"%ProgramFiles%\ReachPeerCI\tailscaled.exe\"" type= own start= demand obj= LocalSystem`;
  - then, if `test/fixtures/windows/tailscale-service.sddl` exists (recorded in acceptance step 1), `sc.exe sdset Tailscale <sddl>`;
  - the test logs `sc sdshow Tailscale` either way.

**Cases (all must hold):**

1. `ready` = `{ ok:true }` for reachci with an interactive token in session 0 (`system-run`). This proves the SCM query, the TCP table (class 8) and `NtQuerySystemInformation` work without elevation. Cases 2-13 run against this Reach.
   - 1a. **The runner without elevation, in its own session (`filtered`):** the service manager, the service, the TCP table and class 88 on session 0's processes all answer. The imitation shares the elevated logon's drive map, which a real limited logon has its own of, so `QueryDosDevice` is refused there and Reach says `access`. `ready` is required whenever `QueryDosDevice` answers.
   - 1b. **As the batch-token user, record the result:** `ready` ok, or `access` with the non-interactive message. A wrong or empty message fails the case. On windows-2025: `access`.
   - 1c. **reachci placed in the runner's session by the secondary logon service, record the result:** `ready` ok, or `access`. On windows-2025: `access` (§1 row 24).
2. `sc start Tailscale subproc <url>`:
   - both probes reach `app` as `/probe1` and `/probe2` (key stripped), on one socket, with one helper query;
   - the oracle (`parseNetstat`, `parseScQueryex`, the parent from `pwsh Get-CimInstance Win32_Process`) shows the socket owner is the child and its parent is the service PID;
   - **new:** `createdMs` is nonzero and ≤ `acceptedAt + 20`, with both values logged.
3. `self` mode → accepted.
4. The same exe started directly by the runner → refused (`peer`).
5. Started in session 0 through `Invoke-CimMethod Win32_Process Create` → refused.
6. **Orphans:**
   - `linger` → the orphan is refused (`n`);
   - the service started again in `idle` → the orphan is still refused.
7. `nokey` → 404 and reset; no helper query.
8. From the runner: wrong key → 404 and reset. Right key with forged headers → reset, no response.
9. **Co-bind delivery (rewritten), as `reachci2` while peer-host listens on `127.0.0.1:Q`:**
   - `bind-probe 127.0.0.1 Q plain` → `refused 10048` (WSAEADDRINUSE);
   - `bind-probe 127.0.0.1 Q reuse` → `refused 10013` (WSAEACCES);
   - `bind-probe 0.0.0.0 Q plain hold 30`, `bind-probe 0.0.0.0 Q reuse hold 30` and `bind-probe [::] Q plain hold 30`: the bind result is recorded, whatever it is. For each probe that bound, and while it holds:
     - the `subproc` probes and a runner `GET /r-<key>/api/health` to `127.0.0.1:Q` all reach peer-host's `app`;
     - the probe's log has no `accepted` line;
   - a Node client with the key and forged headers → reset.
   - **This blocks D:** a `127.0.0.1` bind that succeeds, or any `accepted` line while peer-host listens.
   - **Recorded as the documented residual (§10, risk 3), not a failure:** after peer-host stops while a wildcard probe still holds, a connection to `127.0.0.1:Q` lands on the probe.
10. `sc stop` and `sc delete Tailscale` → a fresh peer-host reports `ready` `{ ok:false, reason: "…isn't installed as a Windows service here." }`.
11. **New, private folders.** `C:\ReachPeerCI\open` inherits Authenticated Users: Modify from `C:\`; as `reachci2`, plant `open\.reach\quick\x.json` first.
    - Then, as `reachci`, `ensurePrivateFolders({ protect: [open\.reach, open\.reach\quick], check: [open] })` → refused with `owner` (the planted file) and `ace` (the code root).
    - With the planted file removed and a code root inside `reachci`'s profile → ok.
    - Afterwards `reachci2` can't read `open\.reach\quick\tailscale-oauth.json` (access denied).
12. **New, helper swap.** Overwrite the cached `tailscaled-peer` exe after the build (as admin) → the next spawn is refused ("changed on disk"), and peer-host falls back.
13. **New, Tailscale's own MSI.** Download the current MSI from pkgs.tailscale.com, check its signature is Tailscale Inc.'s, and log its `ServiceInstall`, `ServiceControl` and `MsiLockPermissionsEx` rows. Then install it.
    - Its service is its own process (0x10), LocalSystem, at a quoted path to `tailscaled.exe`.
    - Its daemon is a `tailscaled.exe` child in session 0, created after the service, from the same file.
    - A fresh Reach is `ready` against it.

**`ci.yml`:** after the spike, add to the Windows lane after line 171:

```yaml
      - name: Tailscale peer check against a real LocalSystem service
        if: runner.os == 'Windows'
        shell: pwsh
        run: |
          powershell.exe -NoProfile -Command "Set-ExecutionPolicy Restricted -Scope LocalMachine -Force; Set-ExecutionPolicy Restricted -Scope CurrentUser -Force"
          if ($LASTEXITCODE) { exit 1 }
          npm run test:file -- --test-timeout=300000 --test-concurrency=1 test/windows-tailscaled-peer.test.mjs
        env:
          REACH_TEST_WINDOWS_PEER: "1"
```

- **`windows-validation.yml`:** add `REACH_TEST_WINDOWS_PEER: "1"` to the test step's env.
- **PowerShell:** test-only orchestration uses pwsh 7. Agent paths never use it.
- **What CI can't prove:** real Serve and Funnel, the real service's DACL, multi-user LocalAPI behaviour, tailscaled's own-machine listener, and phones. Those are §9.

## 9. Owner's real-PC acceptance (still pending)

Oct 16: browser sign-in is enabled by default at the owner's request after a Windows user received a private QR that could not open on a phone without Tailscale. The runtime folder, service-peer and keyed-route checks remain mandatory; public DNS and HTTPS readiness now gate the browser QR. The checks below remain outstanding on a physical PC and phone. Mocked startup checks and native CI checks do not establish that this acceptance has passed.

**Setup:**

- Windows 11 (x64 or ARM64) with Tailscale 1.104 or later from the MSI, signed in as the owner.
- A standard local account `reachtest`.
- A phone without the Tailscale app, on cellular.
- A second tailnet device (laptop).
- Reach installed with npm, or a checkout inside the owner's user folder.
- In the owner's Terminal: `$env:REACH_WINDOWS_ACCOUNT = "1"`, `.\reach.cmd configure`, `.\reach.cmd`.
- Run everything twice: with Tailscale's "Run unattended" off, then on.
- Key and port: `tailscale serve status --json` shows `Proxy: http://127.0.0.1:<Q>/r-<key>`.

1. **Self-test:**
   - no "browser sign-in is off" line;
   - record `sc sdshow Tailscale` into `test/fixtures/windows/tailscale-service.sddl`, and note whether AU/BU can query;
   - `tailscale debug prefs` returns JSON with `AdvertiseRoutes`;
   - `icacls <state folder>` lists only SYSTEM, Administrators and the owner;
   - `.\reach.cmd status` shows the link.
2. **Owner sign-in:**
   - start page on the phone → browser sign-in → approve in the terminal → API, screen and terminal all work;
   - a phone with the Tailscale app still works.
3. **Invite keys:**
   - `.\reach.cmd invites` set up;
   - a person's invite link joins as `tag:reach-guest`;
   - the device is removed when the invitation ends.
4. **As `reachtest`** (fast user switching, Reach still running in the owner's session):
   - a. `tailscale.exe serve status --json` → refused.
   - b. `bind-probe.exe 127.0.0.1 <Q> plain` → `refused 10048`; `reuse` → `refused 10013`. Then `bind-probe.exe 0.0.0.0 <Q> plain hold 60`, and the same for `[::]`: record whether it binds. While it holds, the phone's live screen and API keep working, and the probe prints no `accepted` line.
   - c. `curl.exe -sS -m 5 -H "Tailscale-User-Login: <owner>" http://127.0.0.1:<Q>/r-<key>/api/auth/method` → reset or empty reply, plus the refusal line.
   - d. The same with no key → 404.
   - e. After `.\reach.cmd stop`, after `taskkill /F` of Reach's node, and after a reboot:
     - the owner's `serve status` shows nothing on 8443 or 443;
     - the phone gets no page at either address;
     - after `.\reach.cmd stop`, Reach's `tailscale.log` shows the sessions gone before "listener closed";
     - with a wildcard probe held during the `taskkill /F` case, record whether it printed `accepted` (§10, risk 3).
   - f. **New:** `curl.exe -sS https://<pc>.ts.net:8443/api/auth/method` and `https://<pc>.ts.net/api/auth/method`.
     - Default D1 → `eligible:false`, `thisComputer:true`, no `login`.
     - `curl.exe -X POST -H "Content-Type: application/json" -d "{\"name\":\"x\"}" https://<pc>.ts.net:8443/api/auth/requests` → 403.
     - Record both answers.
   - g. **New:** `type <state folder>\quick\tailscale-oauth.json` → access denied.
5. **Raw tailscaled paths:**
   - The owner runs `tailscale serve --bg --tcp=9999 tcp://127.1:<Q>` → within 10 s "Another Tailscale route leads to Reach's private port".
   - From the laptop, `curl -m 5 http://<pc>:9999/r-<key>/api/health` → reset.
   - `tailscale serve --tcp=9999 off` → Reach recovers.
   - b. **New:** `tailscale set --advertise-exit-node` → within 20 s "Browser sign-in paused on this PC", and the phone shows reconnecting. `tailscale set --advertise-exit-node=false` → recovers. (A crafted packet to `127.0.0.1:Q` needs a modified client and isn't attempted here; row 16's gVisor drop is the evidence.)
6. **Resilience:**
   - sleep and resume;
   - `Restart-Service Tailscale` (admin) → both sessions come back with the same key, with no "Another client is changing the serve config" in Reach's output;
   - the phone reconnects within 30 s;
   - a Tailscale restart into a mode with `TUN:false` (if the owner can produce one) → paused, with the reason.
7. **Latency:** 10× `curl -s -o NUL -w "%{time_starttransfer}\n" https://<pc>.ts.net:8443/api/health` from the laptop, cold and warm, flag on vs off, plus WebSocket-open time. Record the numbers.
8. **Key never written:** after a session that includes a Funnel failure, a sign-in failure and an ETag retry, `Get-ChildItem -Recurse -File <state folder>, $env:TEMP | Select-String -SimpleMatch <first 12 characters of key> -List` returns nothing.
9. **Rotation:** restart Reach → a new key and port; the old URL → refused.
10. **Flag off:**
    - pairing code;
    - "REACH_WINDOWS_ACCOUNT=1 isn't set in this terminal";
    - a target with no `/r-`;
    - no Funnel session;
    - preferences kept.
11. **New:** Funnel not yet allowed on a fresh tailnet (if available): one URL shown, and the session comes up after it is allowed, without a restart.

Record the results as a new M-row in `docs/FIRST_RUN_MATRIX.md`.

## 10. Rollout, docs, residual risks

**Order:**

1. Configure gate and keyed settings (§4.1).
2. Private folders, plus A's `windowsBinary` requirements (§4.5).
3. `listenKeyedIngress` with its tests.
4. The peer-check module with its tests.
5. The C# helpers, and the Windows CI spike, then CI.
6. `ForegroundServe` and `ForegroundFunnel`.
7. Launch and index wiring, with the as-windows launch test.
8. Door-flow keyed variants.
9. Owner acceptance.
10. Adversarial security review of the diff (plan rule 6).
11. Default-on only after recorded acceptance and the §11 decisions. The flag then becomes an opt-out.

Face ID join and linking computers get their own flag and acceptance later.

**Docs to update when built:**

- `docs/SECURITY.md`: a Windows keyed-door section covering the key, the peer check, the route audit, the keyed settings, private folders, this-computer requests and the residual risks.
- `docs/WINDOWS_SIGN_IN_DESIGN.md`: point here; (a) is corrected.
- `docs/parity/INVENTORY.md`: the public-door row.
- `docs/FIRST_RUN_MATRIX.md`: the M-row.

**Residual risks (written down, not hidden):**

1. **The key reaches Tailscale's log service** (`ipn/ipnlocal/serve.go:1450`) unless logging is off. A holder still needs a tailscaled-owned raw path:
   - own-config forwards: closed by the audit, with a window of up to 5 s;
   - userspace mode: refused;
   - exit and subnet forwarding: dropped by gVisor today, and refused while advertised, with a window of up to 30 s after a runtime change.
2. **Same-user processes are trusted**, as on macOS.
3. **Wildcard co-binding** of `0.0.0.0:Q`/`[::]:Q` by another user succeeds. Delivery to 127.0.0.1:Q stays with Reach while it listens (CI case 9, step 4b). If Reach crashes, a socket pre-positioned there can catch in-flight phone requests, bearer tokens included, during the sub-second gap before tailscaled drops the sessions. A graceful stop closes this (§4.10). Node can't set `SO_EXCLUSIVEADDRUSE`. Binding the wildcard itself was rejected: it exposes the port to the LAN and to firewall prompts.
4. **Requests from this PC itself** through tailscaled's listener carry the owner's identity (row 17). The default refuses new sign-ins from them (§11 D1). macOS has the same exposure and keeps today's behaviour.
5. **Address-pair reuse** inside the 20 ms clock slack, before Node sees the reset, is not covered. It requires the key and tailscaled picking the freed port within that window.
6. **A future Tailscale process topology:** the backend in the service process is accepted (`P == S`); anything else is refused, with the cause named.
7. **Smart App Control or WDAC** may block the compiled helpers → pairing mode, with the reason shown.
8. **Reach started outside a signed-in Windows session** (SSH, scheduled task), or as another account inside someone's session (Run as different user), lacks the right to query the service → pairing mode, with that reason. Both are verified on windows-2025 (§1 rows 22 and 24).
9. **Sandboxed agent commands (workstream C)** must get neither loopback access nor the right to query Reach's children. The protected state DACL grants nothing to AppContainer SIDs; keep it that way.
10. **WhoIs** goes through a CLI spawn, as on macOS; step 7 measures it.
11. **Flag-off Windows** (pairing mode) keeps its state folder unprotected, as today. That is a follow-up outside D.

## 11. Decisions for the owner

**Decided (owner, Oct 12): the same as the Mac** (`docs/WINDOWS_AGENT_PARITY.md`, Decisions): D1 allowed with the "from this computer itself" note on both; D2 saved preferences as on the Mac once accepted (the environment variable only until the real-PC acceptance); D3 yes; D4 the same check on both platforms; D5 allowed on both, with a Windows CI test proving the keyed route stays closed; D6 unchanged (default-on after the owner's real-PC acceptance). The table below records the original options.

Each decision has a default that ships if the owner says nothing. Each default is the fail-closed choice.

| # | Decision | Default (ships if unanswered) | Alternative | Cost of the default |
|---|---|---|---|---|
| D1 | Sign-ins from this PC's own browser, which any Windows user here can imitate through tailscaled's own-machine listener (§0.8, row 17) | `"refuse"`: new sign-ins and approval requests from the PC's own Tailscale address are refused; already-approved devices keep working | `"label"`: allowed, with every prompt (terminal and phone) saying "From this PC itself: anyone signed in to Windows here could have asked". It can be tightened further so that only the terminal can approve such a request. | The owner can't add a browser on this PC itself. The local URL is no fallback: with `tailscaleOwner` set it refuses `/api` (`index.mjs:1322`). |
| D2 | Whether the opt-in persists | The environment variable only. Launch and the commands say when preferences exist but the flag is missing. | Store the opt-in in `preferences.json` at `configure`, with the flag overriding. Only after D3, since a file would then turn on a security mode. | The flag must be set in each terminal that starts Reach or its commands |
| D3 | Reach tightens its own state and data folders' permissions on Windows (SID-only `icacls`) at every keyed launch and `invites` | Yes, then verify; refuse keyed mode and invite keys if anything foreign remains | Never change permissions: only verify, and print the `icacls` command for the owner to run | Permissions on `.reach` (and `REACH_DATA`, if set) become owner, SYSTEM and Administrators only, like 0700 on macOS |
| D4 | A Reach checkout other Windows users can change (for example under `C:\`) | Refuse keyed mode with the reason (move the checkout into the user folder, or install with npm) | Warn only | Checkouts outside the user folder stay on pairing codes |
| D5 | This PC as a Tailscale exit node, or routing a loopback-covering subnet | Refuse keyed mode while advertised (checked at launch and every 15 s) | Allow, relying on gVisor's drop (row 16) and the key. That should wait for a crafted-packet test. | Using this PC as an exit node means pairing codes for phones |
| D6 | Residual risks 1-11 (§10) | The flag stays off by default until the owner accepts them in writing after §9 | Accept now | Default-on waits for that sign-off |
