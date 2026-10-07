# Reach browser connection experiment

This is a separate proof of concept, not the production onboarding flow. It
runs a Tailscale node **inside the page**, with a private key distinct from the
host's installed Tailscale client. The browser talks to the control plane and
encrypted DERP relays over WebSockets. Reach HTTP and terminal WebSocket traffic
is dialed through that embedded node, never through native browser `fetch` to
the computer and never through a public Reach proxy.

## Build and run

From the Reach repository, after installing its normal npm dependencies:

```sh
node experiments/browser-connect/build.mjs
npx vite --config experiments/browser-connect/vite.config.mjs
```

The first build downloads a checksum-verified official Tailscale source archive,
the Go toolchain required by its pinned `go.mod`, and Go modules verified through
Go's checksum system. Go, Node, and `tar` must be available. The source, tool
outputs, and fixture data are excluded from Git. Tailscale's BSD-3-Clause license
is copied into the static frontend. No new npm dependencies are required.

Open `http://127.0.0.1:5199`, start the browser node, and authorize its Tailscale
sign-in link using the account that owns the test computer. Node keys and Reach
tokens are held in memory. **Reloading requires another sign-in.** Development
hot reload is disabled to avoid discarding a device during approval.

## Disposable host with real Tailscale

In another terminal:

```sh
node experiments/browser-connect/fixture.mjs start
```

This creates a fresh Reach instance with a generated `Welcome.txt`, its own
private data directory, and an unused Tailscale Serve port (8446 by default).
It uses the existing filesystem-protected Unix socket ingress and Tailscale
WhoIs identity checks. It refuses Funnel and existing Serve routes. Screen,
clipboard, and app control are not part of this experiment.

Paste the printed private HTTPS origin into the browser and request access.
Match the displayed code, then approve that specific fixture request:

```sh
node experiments/browser-connect/fixture.mjs status
node experiments/browser-connect/fixture.mjs approve <eight-character-code>
```

Approval grants this browser a normal paired-owner Reach credential on the
**fixture**. Its terminal is a real shell under the current OS user; the shared
folder is not a shell sandbox. Only approve a browser you control.

Read `Welcome.txt`. Open a terminal and run a harmless command such as
`printf 'reach-wasm-ok\n'`. The terminal authenticates in its first frame;
credentials never appear in the WebSocket URL.

Test owner revocation:

```sh
node experiments/browser-connect/fixture.mjs revoke
```

The guest browser should lose its terminal and file access. Subsequent requests
must fail; it must not silently create another credential. Request approval again
to test reconnection. The browser's **Revoke this Reach session** button separately
tests self-revocation and checks that the old credential is rejected.

Stop the test host and remove only its recorded Serve route:

```sh
node experiments/browser-connect/fixture.mjs stop
```

The terminal(s), fixture credentials and generated files are removed on a clean
shutdown. If the test process crashed, rerunning `start` attempts cleanup of its
exact recorded route before starting another. Conflicting routes are left intact.
Use **Disconnect browser node** to log out of the temporary Tailscale node.

## Test from a real phone without installing Tailscale

Build the static frontend:

```sh
npx vite build --config experiments/browser-connect/vite.config.mjs
```

Serve `experiments/browser-connect/dist` from a trusted HTTPS static host that
the phone can reach **before joining Tailscale**. Configure that exact frontend
origin when starting the fixture:

```sh
REACH_BROWSER_ORIGIN=https://your-static-test-host.example \
  node experiments/browser-connect/fixture.mjs start
```

No Reach API is published on that host. No Supabase secret or tailnet management
credential belongs there. Nevertheless, the frontend is security-sensitive:
its JavaScript can use the in-browser node's authority, so host only trusted
builds, without third-party scripts. Enable gzip/Brotli for the WASM asset.

With the phone's Tailscale app absent/off, open the static page, authorize its
embedded node, approve it on the Mac, and repeat the file/terminal/revocation
checks. Compare the server's approved request `identity.nodeId` to the browser
node in Tailscale to confirm that the host's system VPN was not the client path.

## Transport boundaries and limitations

- Source pinned to Tailscale `9128778b6515f32e13d92e7380044fe025f9b08e`.
- Adds authenticated HTTP and terminal WebSocket functions to Tailscale's
  `cmd/tsconnect/wasm` implementation; this is not an upstream-supported generic
  browser networking SDK.
- HTTPS/WSS required, valid `.ts.net` hostnames only, normal TLS validation with
  embedded fallback roots, no redirects, real frontend Origin sent to Reach.
- Only `/api/` requests and `/ws/terminal`; no network-wide browser proxy.
- HTTP deadline 20 seconds, WebSocket handshake 15 seconds, file response cap
  2 MiB, input payload cap 64 KiB, at most four terminal connections.
- Temporary disconnect permits an explicit terminal reconnect. Authentication
  revocation ends all local channels and prevents reconnect until reapproved.
- The browser implementation uses DERP relays. Direct UDP, video throughput,
  Safari background/resume behavior, and mobile input performance remain separate
  acceptance work. This does not establish 60 fps remote desktop performance.
- A Tailscale sign-in is still required. Guest enrollment without a Tailscale
  account is not implemented. Reach grants do not themselves admit tailnet nodes.
- A static HTTPS host is required for first-time remote browser access; the
  private Reach address alone cannot load the frontend on an unjoined phone.

## Automated checks

### Observed integration result (2026-10-03)

Tested the actual compiled WASM in the Codex desktop browser against the
disposable Mac host over its private Tailscale Serve route:

- User authorized the embedded browser's Tailscale sign-in.
- Mac verified the request's Tailscale node ID matched that browser and was
  different from the Mac's installed Tailscale node.
- Local Reach device approval succeeded with the matching verification code.
- Read the actual generated `Welcome.txt` contents.
- Opened a real PTY and received `reach-wasm-ok` from `printf`.
- Reconnected and reapproved after restarting the disposable host, without
  repeating Tailscale sign-in.
- Owner-side fixture revocation removed the browser's file view and disconnected
  its active terminal; the UI required new approval.
- Browser console showed no errors during the final successful test.

This was **not** a physical iPhone/Android test. No public static deployment was
created, no production onboarding was switched, and screen streaming was not
tested. Browser reload currently discards the in-memory identity; the test caught
and disabled development auto-reload for that reason.

### Commands

```sh
node --test test/browser-connect.test.mjs
npm test
```

The WASM build also runs the Go URL-policy tests. JavaScript tests check explicit
WASM routing, private origins, HTTP/terminal revocation, in-flight response
discarding, handshake cancellation, and reconnect rules. These are automated
adapter checks; a successful build is not evidence of a real phone connection.

Upstream references:
- https://github.com/tailscale/tailscale/tree/main/cmd/tsconnect
- https://tailscale.com/docs/features/tailscale-ssh/tailscale-ssh-console
