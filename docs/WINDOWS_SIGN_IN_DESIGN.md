# Phone sign-in from the browser on a Windows host (design)

Status: built on October 12, 2026 (workstream D; its implementation spec, `docs/parity/D-public-door.md`, replaced this proposal) and on by detection since October 13, with no switch (owner: "No flag should exist. We should detect platform and support."). A PC that can't hold the keyed route uses pairing codes and says why. Not yet run on a physical Windows PC: the manual acceptance below is still owed (`docs/FIRST_RUN_MATRIX.md` M8).

## Why Windows needs a different private route

On Mac and Linux, Tailscale Serve proxies to a mode-0600 Unix socket in a 0700 directory (`server/tailscale-auth.mjs` `listenPrivateIngress`). Only tailscaled can be the peer, so Reach trusts Tailscale's identity headers (`Tailscale-User-Login`, `Tailscale-Funnel-Request`, `X-Forwarded-For` → WhoIs). That trust turns on account approval, the Funnel start page where a phone without the Tailscale app signs in from its browser, and invite keys.

On Windows, Serve can't target Unix sockets (Tailscale 1.104 `ipn/serve.go` refuses them there) and Node can't listen on AF_UNIX (`listen(path)` makes a named pipe). A plain loopback listener would let local processes forge identity headers. Reach now uses the keyed proxy route plus a Tailscale peer check described below. When those checks cannot work on a PC, it explains the reason and falls back to pairing codes with the phone's Tailscale app.

## Options

| | Other local user | Tailnet peer / internet | Cost |
| --- | --- | --- | --- |
| **(a) Peer process is tailscaled** (TCP table owner = the Tailscale service, `%ProgramFiles%\Tailscale\tailscaled.exe` as LocalSystem) | Blocked | **Not blocked alone**: a peer's `serve --tcp` / Funnel TCP route to Reach's port reaches it through a tailscaled-owned socket with raw, forgeable headers (`ipnlocal/serve.go` 688-728) | ~50-100 ms per new connection, cached per socket |
| (b) Go forwarder | Same as (a): Serve can only target TCP | Same as (a) | Extra hop on every video byte, another binary |
| (c) Embedded tsnet node | Strongest | Strongest | Second device, new hostname: breaks the one address, passkey RP ID and linked computers |
| **(d) Keyed route**: target `http://127.0.0.1:<ingress>/r-<256-bit key>` | Blocked (LocalAPI refuses other users while a current user is set; tailscaled logs are SYSTEM/Administrators only). Confirm with no current user | Blocked: raw TCP forwards don't carry the key | Pure JS, no per-request cost |

Serve can't add headers, and `--set-path` is stripped before proxying, but the path inside a proxy *target* is prepended to every request (`ipnlocal/serve.go` 978). Setting such a target needs no admin.

## Recommendation: (d) and (a) together, failing closed

- **Key** (new each launch, never written down): proves the request went through tailscaled's header-cleaning HTTP proxy. Checked in constant time and stripped before Express; a wrong key gets 404 and a destroyed socket.
- **Peer check** (`server/tailscaled-peer.mjs`, `netstat -ano` + `sc queryex/qc`, no PowerShell): guards a leaked key. TCP table, then SCM, then TCP table again; cached per socket.
- The key is visible to this Windows user, administrators and Tailscale's logs. Same-user processes stay trusted, as on macOS.

Integration: `server/tailscale-auth.mjs` (`listenKeyedIngress`), `scripts/configure.mjs` (`accountApproval` true on win32 only with `REACH_WINDOWS_ACCOUNT=1`), `scripts/launch.mjs` (keyed target, key redacted from logs and route files, pairing mode if the peer check can't answer), `scripts/persistent-serve.mjs` / `scripts/ephemeral-funnel.mjs` (record `sha256(target)`, never the key), `server/index.mjs` (lift the Windows refusals for invite keys and the start page under the flag).

Turned on by the flag: account approval, the start page and browser sign-in, invite keys, the agent gateway and hosted MCP. Kept off under a later flag: Face ID join (internet to owner access) and linking computers.

## Prerequisite fix (independent of this feature)

Windows' private route used to be background tailscaled state that outlived Reach, pointing at a loopback port another local user could bind after Reach stopped. Routes become foreground Serve sessions owned by a non-detached child, so they end with Reach (see docs/SECURITY.md).

## Tests

- **Unit** (`test/helpers/as-windows.mjs`): missing/wrong/short key → 404 and no WhoIs; right key from a non-tailscaled process → destroyed; key checked on every request of a kept-alive connection; key gone from `req.url` before Express; keyed WebSockets; Funnel-marked requests only reach the start page; `netstat`/`sc` parsing (PID 0, localized state words, service restart, missing service); failed peer check → pairing mode; key never in logs, route files or `status`.
- **Windows CI**: real `netstat`/`sc`; a tiny Go Windows service as LocalSystem connects with the key (positive); a user process with the key and forged headers, raw TCP without the key, and no Tailscale service (negative). CI can't prove real Serve, Funnel, multi-user LocalAPI or phones.
- **Manual acceptance (all must pass before default-on)**, on a real Windows 11 PC, real tailnet, a phone without the Tailscale app:
  1. Start page → browser sign-in → approve → owner API, screen and terminal work; a phone with the app still works.
  2. An invite link joins as `tag:reach-guest`; the device is removed when the invitation ends.
  3. As a second non-admin user: `tailscale serve status --json` (Run unattended off and on); binding the ingress port while Reach runs fails; after stop, `taskkill /F` and reboot the route is gone; the key with forged headers is refused.
  4. A peer's `serve --tcp` to the ingress port is refused.
  5. Sleep/resume and a Tailscale restart: the route comes back.
  6. First-request and WebSocket-open latency recorded.

## Rollout

1. Foreground routes for today's Windows pairing mode (done, Oct 11).
2. (d)+(a) built (Oct 12).
3. On by detection, with no switch, Face ID join and linking computers included (owner, Oct 13). The manual acceptance above is still owed and is recorded in `docs/FIRST_RUN_MATRIX.md` M8 when it runs.
