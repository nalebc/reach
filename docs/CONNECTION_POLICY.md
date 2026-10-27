# Connection fundamentals

These requirements apply to every supported Reach host and client, including macOS and Windows hosts and iPhone, iPad and Android clients.

## Owner access

The laptop keeps Tailscale installed and connected. The Tailscale app on the owner's phone is optional. Once an owner client is enrolled, the owner uses the same Reach link whether the phone app is installed, absent, disconnected, or connected to a different tailnet. Access still requires an online laptop running Reach, a valid owner authorization, and an available supported network path.

Each computer has one stable owner link. Setup, QR codes, bookmarks, home-screen shortcuts, and reopening Reach must use that same address. Enabling, disabling, installing, or removing the phone's Tailscale app must not require a different URL, port, QR code, or bookmark. The owner does not choose between private and public links. Reach selects the underlying transport internally while preserving the page's origin, saved authorization, and open work. A new client opens owner sign-in/approval at this same link; an enrolled client restores its authorized connection there. Knowing the link alone grants no access.

Owner enrollment must establish and verify the app-independent browser connection as part of setup, including when the owner first joins through the phone app. The owner must not discover, after turning the app off, that they needed to sign in and approve a second path beforehand. The initial owner setup can authenticate and authorize both connection identities together, with separate credentials and a verified relationship to the same enrolled owner client. A shared account or matching device name alone cannot establish that relationship. A new browser, cleared identity storage, or revoked access can require enrollment again.

After setup, switching the phone app on or off must automatically select the best authorized connection. It must not require another invitation, approval, sign-in, manual reload, or transport selector. Restoring the app must return to its preferred private route. Closing and reopening Reach must also work without the phone app; fallback is not limited to keeping an already-open tab alive. Existing owners enrolled only through the app need a migration flow that prepares and verifies browser access without discarding their working access.

Recommend the app for a potentially faster direct connection and reliability. Both routes must remain encrypted and authenticated. Browser access is a supported owner experience, not an emergency mode that is unavailable until the owner separately configures it. This requirement does not remove Tailscale from the laptop or make owner APIs public.

## Connection preference

1. Prefer an eligible native private Tailscale connection. Tailscale establishes a direct device-to-device path when possible and uses an encrypted private relay when necessary.
2. A previously approved browser or agent Tailscale connection is the next private option. Its encrypted relay remains a private connection.
3. Use the authenticated public agent gateway only when the grant permits it and eligible private paths are unavailable. Probe for recovery and automatically return to the preferred eligible private connection.

Eligibility includes authorization. An owner credential bound to one Tailscale device cannot be sent under another device's identity. Native and browser devices retain their own credentials and approvals, including when owner setup establishes both together. Recovery uses that established authorization; it cannot silently enroll an unrelated device. A signing-key invitation can use the routes already authorized for that same grant. A private-only credential does not acquire public access or approval for another node during recovery. Guest and agent grants do not inherit owner enrollment privileges.

Browser and operating-system network permissions also remain required. A saved Reach approval does not bypass those permissions.

The signed browser-agent gateway probes the native private route before using public access. A CLI signing-key connection can also restore its own saved embedded private profile and pinned client. Neither flow borrows an owner's or another invitation's browser identity to create an alternative.

A public start page can load the fixed client code and help establish a browser's private Tailscale node. Owner APIs and WebSockets remain private. Hosted MCP services control their configured connector URL and network; Reach cannot change another service's routing or authorize it to join the tailnet.

## Recovery behavior

Connection selection must recover after network changes, foregrounding and Reach restarts. A runtime identifier changes when Reach restarts; authenticated computer and device identity determine which approval can be used.

A public start screen checks its existing native approval before browser sign-in and while waiting. It opens the workspace at the same origin with that exact grant, including restricted permissions. Native and browser startup compete for one workspace; abandoned sign-in or enrollment cannot restart after the native workspace opens.

Restoring an approved browser profile uses one validated snapshot. A changed profile cancels pending startup, and a stalled loader or WebAssembly fetch must release recovery checks after a bounded deadline. A late result cannot construct a second node or overwrite a profile another tab removed.

A handoff preserves open work, including drafts, attachments and pending operations. Existing callbacks retain the transport associated with their credential. Changed routing must never replay a command, write or other action with an unknown result. An authorization denial is authoritative for that request and grant; the action cannot be retried through another route.

At startup, when no native identity is usable, an owner can restore a separately saved and approved browser identity using that identity's own credential. This only authenticates and opens the workspace; it never repeats a denied action or replaces a usable restricted or guest identity with an owner's saved access.

Private Serve recovery and public gateway availability are independent. A private route failure must not disable a healthy authorized public fallback. A security stop, revoked grant or unsafe host configuration still closes the affected access.

Native download managers and XHR cannot use a browser's in-page Tailscale node. Transfers must follow the route bound to their peer; files already completed by the native download manager remain available after a handoff.

## Validation

Owner acceptance must cover the following on macOS and Windows hosts with iPhone, iPad and Android clients:

| Scenario | Required result |
| --- | --- |
| Open the identical owner URL with the phone app on, off, absent, or on another tailnet | Reach opens the appropriate sign-in or existing workspace at the same origin; no alternate address, port, or replacement QR is required. |
| First setup without the phone app | Owner can complete enrollment and use Reach through the private browser connection. |
| First setup with the phone app | Setup also establishes and verifies browser access; the owner is not left with app-only access. |
| Turn the phone app off during use | Switch automatically to the authorized browser connection and preserve open work. |
| Turn the phone app back on | Return automatically to the preferred authorized native connection. |
| Install or enable the phone app after browser-first setup | Use the verified native path for the same enrolled owner client without another invitation or approval; never borrow a different client's credential. |
| Phone app connected to another tailnet | Continue through the authorized browser connection without requiring the owner to change the phone's VPN. |
| Close and reopen Reach with the phone app off | Load the start page and restore the same authorized browser connection. |
| Sleep, foregrounding, Wi-Fi/cellular changes, or host restart | Recheck available paths and reconnect automatically without replaying unknown-result actions. |
| An alternative is unapproved, revoked, expired, or belongs to another client | Do not use it or elevate its permissions; retain another valid authorized path when one exists. |
| Upgrade an existing app-only owner | Preserve existing access and provide a setup migration that establishes and verifies the browser connection. |

Regression coverage must exercise private → fallback → private, unavailable and unapproved alternatives, concurrent calls, previous-route callbacks, unknown action results, and preserved open work. Shared checks belong in Windows CI as well as the macOS/Linux suites.

Distinguish simulated DNS/Tailscale and DOM checks from real browser, operating-system and physical-device validation. Passing hosted runners or an iOS simulator does not establish physical iPhone, iPad, Android or Windows network-transition acceptance. Record the evidence and remaining limits with each release.

## Implementation and validation (2026-10-25)

Owner setup now registers a non-exportable browser signing key over its existing private owner connection. The other private node receives a challenge bound to its verified Tailscale identity, the requested path and a two-minute deadline. The browser signs that challenge and a separately generated credential, persisted before dispatch. The server issues that node its own credential with the source's exact scopes and expiry. Lost replies and concurrent tabs can collect only that same credential; an unrelated node or revoked path cannot use enrollment to replace it. Removing the source approval also invalidates its dependent path.

Registration happens before waiting for browser sign-in. Its receipt is saved with the non-exportable key and bound to the source grant, computer and private origin. Finishing sign-in after native loss, including in a fresh document, can therefore complete the same enrollment without recontacting the source. The server still verifies current source authority and the destination node's signed challenge. An old app-only client with no saved proof uses ordinary browser sign-in and computer approval; it never inherits the native credential. The reconnect view exposes this flow even before a live device has loaded, including Home Screen launches directly into the workspace.

An active app agent's host guard also recognizes the enrolled alternate path of its pinned owner. The two private proof endpoints check that exact owner relationship both when issuing a challenge and when redeeming it. Subsequent owner HTTP requests and WebSocket authentication require the alternate's own node-bound credential; WebSocket upgrades admit only an already enrolled node. Each authorization rechecks the reciprocal approvals, scopes and expiry. An unrelated owner, a matching device name/account, ordinary browser admission or a copied native bearer cannot use this exception. New app invitations still require the trusted native connection. An app-only owner with no saved enrollment proof must return to that connection to prepare it while an app agent is active.

The [setup component](../src/OwnerConnection.tsx) prepares browser access for app-first and existing app-only owners at their permanent owner URL while retaining their working connection. A Tailscale browser sign-in can be needed once during setup. Browser-first owners keep using their browser connection while Reach checks for the optional native path. Enrollment publishes an alternative only after verifying its credential on that path. Guests, restricted devices and agents cannot use owner enrollment.

The [public start page](../server/public-start.mjs) and fixed client assets stay available without a pairing window or door cookie. Owner APIs and WebSockets stay private. Invitation pages and agent grants retain their own admission rules. The launcher verifies browser bootstrap on both host platforms and keeps the permanent link during public-route outages. Historical private-port bookmarks are not permanent owner links; use the canonical link shown by `reach status` for owner setup.

Owner setup also saves the complete public startup code at the permanent origin before browser sign-in finishes. A cold page can then restore access or continue sign-in when native HTTP disappears. This cache contains no owner credentials or workspace data. If code is missing or evicted and HTTP is unavailable, navigation returns a reconnecting page that retries the same document GET; it does not reject the service worker response or replay workspace actions. Every owner page registers this worker, including one that never saved the startup code (an owner from before browser enrollment, or one whose save hasn't finished): a Home Screen web app otherwise showed a blank page for a load that found no network. With nothing saved, the worker answers only that failed navigation. Failed cache preparation continues retrying after enrollment completes.

[Recovery](../src/app-watch.ts) uses only saved, independently verified approvals. A public 404 from a native health probe is expected when the phone app is off; it triggers a check of the approved browser path. Actual actions are not replayed. The app returns to an eligible native path automatically and preserves the workspace across handoffs.

Regression checks cover app-first and browser-first enrollment, no pre-existing fallback, private → browser → private, concurrent enrollment, lost replies, revocation, wrong identities, proof expiry, key persistence and deep links. Real headless Chrome on macOS validates WebCrypto, IndexedDB reloads, TLS and cross-port CORS through the production keyed ingress and owner API middleware. Tailscale identities, DNS, mobile DOMs and network changes in those checks are simulated. The shared suites, including the real-browser check, are selected in Windows CI; this is not evidence of execution on a physical Windows host or an iPhone, iPad or Android phone.

The portless cold-start Chrome check uses the built startup page, production service worker and CacheStorage with real HTTPS connection failures. It verifies unfinished sign-in, cache eviction and automatic recovery at the unchanged URL. Its Tailscale runtime and native grant are modeled; it does not validate physical phone VPN behavior.

The active-agent regression covers native → browser → native with simulated iPhone, iPad and Android transports, revocation during held work, pending proofs and browser-first owner pairs. Real Chrome on macOS verifies concurrent enrollment and persisted recovery through cross-port TLS/CORS with an active app grant, plus actual private WebSocket upgrade/authentication. Existing app-agent isolation and Funnel denial checks pass alongside these tests. The modified suites are already selected in Windows CI; physical phone switching and actual Windows execution remain separate validation.
