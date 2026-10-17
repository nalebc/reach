# Connection fundamentals

These requirements apply to every supported Reach host and client, including macOS and Windows hosts and iPhone, iPad and Android clients.

1. Prefer an eligible native private Tailscale connection. Tailscale establishes a direct device-to-device path when possible and uses an encrypted private relay when necessary.
2. A previously approved browser or agent Tailscale connection is the next private option. Its encrypted relay remains a private connection.
3. Use the authenticated public agent gateway only when the grant permits it and eligible private paths are unavailable. Probe for recovery and automatically return to the preferred eligible private connection.

Eligibility includes authorization. An owner credential bound to one Tailscale device cannot be sent under another device's identity. Native and browser devices retain their own approvals. A signing-key invitation can use the routes already authorized for that same grant. A private-only credential does not acquire public access or approval for another node during recovery.

The signed browser-agent gateway probes the native private route before using public access. A CLI signing-key connection can also restore its own saved embedded private profile and pinned client. Neither flow borrows an owner's or another invitation's browser identity to create an alternative.

A public start page can load the fixed client code and help establish a browser's private Tailscale node. Owner APIs and WebSockets remain private. Hosted MCP services control their configured connector URL and network; Reach cannot change another service's routing or authorize it to join the tailnet.

## Recovery behavior

Connection selection must recover after network changes, foregrounding and Reach restarts. A runtime identifier changes when Reach restarts; authenticated computer and device identity determine which approval can be used.

A handoff preserves open work, including drafts, attachments and pending operations. Existing callbacks retain the transport associated with their credential. Changed routing must never replay a command, write or other action with an unknown result. An authorization denial is authoritative for that request and grant; the action cannot be retried through another route.

At startup, when no native identity is usable, an owner can restore a separately saved and approved browser identity using that identity's own credential. This only authenticates and opens the workspace; it never repeats a denied action or replaces a usable restricted or guest identity with an owner's saved access.

Private Serve recovery and public gateway availability are independent. A private route failure must not disable a healthy authorized public fallback. A security stop, revoked grant or unsafe host configuration still closes the affected access.

Native download managers and XHR cannot use a browser's in-page Tailscale node. Transfers must follow the route bound to their peer; files already completed by the native download manager remain available after a handoff.

## Validation

Regression coverage must exercise private → fallback → private, unavailable and unapproved alternatives, concurrent calls, previous-route callbacks, unknown action results, and preserved open work. Shared checks belong in Windows CI as well as the macOS/Linux suites.

Distinguish simulated DNS/Tailscale and DOM checks from real browser, operating-system and physical-device validation. Passing hosted runners or an iOS simulator does not establish physical iPhone, iPad, Android or Windows network-transition acceptance. Record the evidence and remaining limits with each release.
