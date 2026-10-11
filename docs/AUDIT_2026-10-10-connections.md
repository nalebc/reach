# Connections audit — 2026-10-10

Scope: every connection Reach makes or accepts. Each should be encrypted and go through Tailscale, preferring the private tailnet route wherever one exists. Method: four read-only passes over the code: inbound listeners, outbound calls, how agents choose a route, and the phone page with the native helpers. Live checks on this Mac used `lsof` and `tailscale serve status`. High findings were confirmed in the code before fixing. The running Reach was not attacked.

## On this Mac (live)

- Reach has no TCP port facing the network. Tailscale Serve proxies to a Unix socket: `:443` (Funnel, the one address) and `:8443` (tailnet only).
- The OpenClaw Gateway listens on `127.0.0.1` / `::1` only and needs a token.

## Sound

- Nothing disables certificate checks, and nothing sends plain `http`/`ws` beyond loopback. Outbound fetches refuse redirects.
- The public door answers only the start page, the signed agent gateway and Face ID sign-in; anything else gets 404 before parsing. Admin credentials are issued over the tailnet only.
- The page loads nothing from third parties and opens no WebRTC/STUN connections. The native helpers use no network.
- Push payloads are end-to-end encrypted (RFC 8291) and go only to the platform push services.
- Fleet approve/revoke uses port 8443, which is never Funnelled.

## Fixed

| # | Severity | Finding | Fix | Tests |
|---|---|---|---|---|
| H1 | High | **A "Run commands" agent could become an admin device.** The private socket takes the caller's `X-Forwarded-For`, so any process running as you could claim your phone's Tailscale identity. `/api/auth/requests` then auto-approved it as "this same device" or "approved on a linked computer". The Oct 9 brake counted only Apps/Full control agents, and `/api/jobs` ran with no sandbox. | An identity alone approves nothing. Linked computers approve on a one-use ticket that the phone gets with its own credential (`POST /api/fleet/tickets`). The other computer redeems it at the issuer's own address over verified TLS, and it's valid only for the device it was issued to. Revoke-once asks the sender back. `/api/auth/vouched`, `/api/fleet/approved` and `agents-seen.json` are gone. A job from anyone but your own devices runs in the Full control sandbox (Reach's data, socket and Tailscale are out of reach). | `fleet`, `fleet-join`, `same-device`, `agent-invite` |
| M1 | Medium | An existing OpenClaw Gateway bound beyond loopback, or published through Tailscale Serve/Funnel, was shown as healthy. | Refused with the setting to change (`gateway.bind`, `gateway.tailscale.mode`). | `openclaw` |
| M2 | Medium | The page's CSP allowed connections to any `https:`/`wss:` host. | `connect-src` is limited to `*.ts.net`; the start page also gets `*.tailscale.com` for the in-browser node; loopback only in local mode. | `security` |
| M3 | Medium | An agent off the tailnet could stall on the private address (the name resolves to the public relay). | The private address is used only when it resolves into 100.64.0.0/10 or fd7a:115c:a1e0::/48, on a fresh connection, giving up after 5 s without one. | `agent-funnel-tools` |
| M4 | Medium | A hand-typed computer address could be any HTTPS host, and the device token was sent there. | It must end in `.ts.net` (or be loopback in local mode). | `faceid-ui`, `connect-states-ui` |
| L5 | Low | **Downloads an agent runs weren't all checked.** The tools install command dropped its SHA-256 check whenever the computer named no runtime. The tailnet client (WASM and loader) ran unchecked. The `keep` restore command and the owner's "update by hand" command fetched whatever was served. | Invitations always carry the hash of the runtime the start page serves; with no hash there's no command. The runtime carries its tailnet client's SHA-256s (`REACH_TAILNET_PINS`, set at build) and checks downloads and cached copies against them (run from source, the hash in the file names). Every runtime served is kept by its hash (`dist/agent-runtimes/`, newest 50 from 90 days). `keep` and the update command fetch exactly the one they name and check it before replacing anything. | `agent-runtime-pin`, `public-start`, `funnel-agent-integration`, `reach-update-ui`, `invite-ui` |
| L6 | Low | **Any same-user process could post permission prompts to your phone,** and the sandbox didn't cover that socket when it moves to the temp folder (a data folder path too long for a socket). | The sandbox around agents' commands and jobs denies it wherever it is. Your own processes still can: they're you. | `agent-shell-sandbox` |
| L7 | Low | **The isolated agent tailnet's proxy was an open port** (`tailscaled --outbound-http-proxy-listen=127.0.0.1:<port>`): any user on the agent's machine could use the agent's tagged node. | A CONNECT proxy on a socket in the run's owner-only folder, dialing through the daemon with `tailscale nc`, tailnet addresses only; the agent refuses a proxy socket in a folder others can open. *Unverified:* `tailscale nc` against a real userspace daemon (tested with a stand-in CLI). | `agent-cli` |
| L | Low | Tailscale API calls followed redirects; no HSTS; agent `http:` links were tappable; the Claude installer lacked `--proto '=https'`; the Codex daemon socket was unchecked; `restore` and agent links didn't tie addresses to one tailnet; the legacy `agent.mjs` took any HTTPS host. | `redirect: "error"`; HSTS on `*.ts.net`; `http:` agent links shown as text only; https-only curl; the Codex daemon socket must be yours, in a folder no one else can write; `keptAddresses` and the link check require the same tailnet; `REACH_URL` must be `*.ts.net`. | `security`, `agent-markdown-ui`, `agent-install`, `agent-compatibility`, `agent-remote` |

## Not changed (with why)

- **VAPID subject names the tailnet** (`https://<mac>.ts.net`) to the push services. That name is already public through Funnel DNS and certificate logs, and a different subject risks breaking iPhone notifications with no way to check it here.
- **Agent reply text in notifications.** It is end-to-end encrypted to the push service, but it does show on the lock screen. Hiding it is a product choice.
- **A public-link agent's credential works on both routes for its whole life,** even if it only ever uses the tailnet. This is the "Always on both routes" design: the public link is the fallback that keeps the agent working when it can't reach Tailscale. The credential is bound to the agent's own signing key (a copy without the key is useless), traded hourly, and ended by a week unused; strangers get 404 at the door before anything is parsed. Tying it to one route would make the agent stop whenever that route is down.
- **The signed agent gateway also answers on Reach's loopback TCP port.** That's by design and tested. A same-user process can reach the private socket anyway, so blocking it would add nothing.
- **Approving a request still shows the name of the device that asked.** A process on the Mac claiming your phone's identity can now only ask, but its request looks like your phone's. Approve only what you just asked for yourself.
