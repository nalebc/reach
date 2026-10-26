# Working on Reach (coding agents)

## Product fundamentals

Connection preference is a product requirement on every supported host and client, including iPhone, iPad and Android:

- The laptop keeps Tailscale; the owner's phone does not need the Tailscale app. Once an owner client is enrolled, the same Reach link must work with the phone app installed, absent, disconnected, or connected to another tailnet, provided the laptop is online, Reach is running, access remains authorized, and a supported network path is available.
- Each computer has one stable owner link for setup, bookmarks, QR codes, reopening, and ongoing use. The owner must never choose a private versus public link, change a port, or get a replacement link because the phone's Tailscale state changed. Keep the page's origin and saved authorization stable while selecting transports internally. On a new client, this same link opens the owner sign-in/approval flow; on an enrolled client, it restores access.
- Owner enrollment must prepare and verify an app-independent private browser connection as part of setup. Do not leave an app-first owner dependent on having separately signed in and approved a fallback beforehand. Establish the required identity-specific approvals during owner setup; switching the same enrolled owner client between its authorized paths must need no new invitation, approval, sign-in, reload, or transport choice. Existing app-only owners need an explicit migration path; silently remaining app-dependent does not meet this requirement.
- Prefer an eligible private Tailscale connection. Prefer the native connection, which can use direct device-to-device transport; an encrypted private Tailscale relay remains preferable to a public route.
- Use the authenticated public agent gateway only when no eligible private path is available for that grant. Recheck availability and return to the preferred private path automatically, including after sleep, network changes and reconnection. Do not require a transport switch from the user.
- Eligible means both reachable and authorized. Keep the same invitation, permissions and device binding. Native and browser identities keep separate credentials and must each be authorized. Owner setup may authorize both verified paths of the same owner client together; merely sharing a Tailscale account or device name is not proof of that relationship. Recovery must never transfer a device-bound credential to another identity or silently approve an unrelated device. Guest and agent grants do not inherit owner enrollment privileges.
- Recommend the phone's Tailscale app for a potentially faster direct connection and reliability. Both app and browser connections must be encrypted and authenticated; installing the phone app must not be a condition of owner access.
- Preserve open work across a handoff. Never replay commands, writes, payments or other actions whose delivery/result is unknown merely because the transport changed.
- Owner APIs and WebSockets stay private. A public start page that bootstraps a browser's private Tailscale connection is not permission to expose owner APIs through Funnel.

Changes to connection selection or recovery must cover private → fallback → private, unavailable/unapproved alternatives, concurrent requests, and held work from the previous route. Put shared regression checks in Windows CI as well, and distinguish simulated transports, actual operating-system execution and physical-device validation.
Check browser-enforced connection boundaries in a real browser, including cross-port private gateways; mocked fetch responses cannot verify CORS or browser network permissions.

## Platform support

Build changes for every platform Reach supports. Screen control must cover macOS and Windows hosts and touch clients on iPhone, iPad, and Android. Prefer shared gesture and coordinate logic. When native behavior differs, cover both paths and put the relevant shared and Windows-specific regression tests in Windows CI. Clearly distinguish mocked checks from validation run on the actual operating system.

## Running Reach

One Reach runs per computer. Use the CLI for every start, stop and restart:

- `./reach status`: where Reach runs (a Terminal window, the background, or the service), since when, and its link.
- `./reach restart`: stop it and start it again, in a Terminal window. It asks before closing Reach's terminals.
- `./reach stop`: stop every Reach on this computer.

Never start Reach any other way: no `nohup`, no `&`, no background shell, no `node scripts/bootstrap.mjs`, no `npm run go`. Started without a Terminal window, Reach has no Screen Recording or Accessibility permission (no live screen, no control) and can't approve new phones.

If `./reach` says Reach is already running, don't start another copy. Tell the user where it runs and offer `./reach restart`.

Interface changes (`src/`, `public/`, `index.html`) need no restart: Reach rebuilds them and open phones reload on their own. Only server changes need one. When you run `./reach restart`, it asks the user on their phone (Needs you) and returns; Reach restarts when they tap Restart. Don't run it again while it's waiting.

Restarting ends Reach's terminals and live streams. Run `./reach status` first, and ask the user before restarting while they use it. Never pass `--yes` to `stop` or `restart` (it closes Reach's terminals without asking) unless the user said so.

## Running tests

Run tests through npm so each test process carries the runaway guard (`test/helpers/runaway-guard.mjs`): `npm test` for everything, `npm run test:file -- test/x.test.mjs` for one or a few files. Never bare `node --test`. On Oct 9 failing assertions grew three test processes to 80 GB together and logged the Mac out; the guard keeps any single test under 2 GB.

Don't start a full `npm test` while another one is running on this Mac (check `ps -Ao args | grep "node.*--test"`); run only the files your change touches.
