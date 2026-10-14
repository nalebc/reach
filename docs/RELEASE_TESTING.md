# Release acceptance

The configured CI matrix runs the full guarded suite on Linux with Node 22 and 24 and on Apple Silicon and Intel macOS with Node 22. Windows has an explicit blocking portability suite on Node 22. Every lane builds the browser Tailscale client and clean-installs the npm and portable release artifacts; POSIX lanes also exercise the installed onboarding matrix. A separate iOS simulator lane covers pairing, authenticated files and native transfer bridges. Check results on the exact candidate commit: a configured lane is not a recorded pass. These checks do not establish physical-phone onboarding, WebAuthn interoperability or remote-desktop performance. See [release verification](RELEASE.md) for the complete gates and artifact checks.

The [first-run matrix](FIRST_RUN_MATRIX.md) covers what a new person meets before this gate (computer, Tailscale state, agents installed, phone and browser) with the automated test for each case; its manual rows M1–M8 belong with this gate.

## Physical phone gate

Run on a real iPhone with Safari and an Android phone with Chrome before calling the browser connection release-ready. Record the commit, host OS, Tailscale version, phone/browser version and outcome. Use a test folder and a disposable terminal; do not record credentials, QR payloads or private files in reports.

1. Start the release on the host with `./reach` (Windows: `.\reach.cmd`). Keep an existing working configuration intact; use a separate OS account or test computer for a truly fresh setup.
2. Without a Tailscale app on the phone, open the start link. The start page is public only while an invitation is waiting to be opened or a browser agent's session is live, so create a short test invitation first (or use the Tailscale app for this step), and confirm port 443 stops answering once that window ends. Sign in to the test tailnet through the browser, then approve the matching device request locally with `./reach approve`. Confirm a second unapproved browser cannot list files, open a terminal or watch the screen merely by knowing the link.
3. Open a test file, create a terminal, and enable screen viewing/control locally. Type, scroll terminal history, return to the latest output, enter/exit fullscreen and open/close the phone keyboard. Confirm there is no unexpected page zoom or hidden input.
4. Register a passkey from the approved browser. From another supported browser on the phone, use passkey sign-in with no separate Tailscale app. Confirm cancellation, an unregistered passkey and a stale/replayed attempt do not admit a device. This step requires configured, restricted invitation/admission keys, a reviewed tailnet policy, and an open start-page window (an unopened invitation or a live browser agent session), since the Face ID endpoints are public only then.
5. With a terminal and screen open, switch Wi-Fi to cellular and back. Repeat after a brief airplane-mode interruption, after backgrounding the browser for one minute, and after phone lock/unlock. Record actual recovery time and any manual action. Check that reconnect does not duplicate devices or terminal input. Shells should survive a network interruption, not a host companion restart.
6. From the owner browser, remove the passkey used by the second browser. Its existing stream and control must stop, API calls must be denied, and it must not regain access on reload. The separately locally approved owner browser should remain connected. Repeat explicit device revocation during a stream.
7. Invite a guest to only the test folder. Check the guest cannot enter other roots, run commands, control the screen or manage devices. Revoke the guest while connected, then verify expiry with a separate short invitation.
8. Check `./reach status`, then arrange a convenient interruption before using `./reach restart` (Windows: `.\reach.cmd restart`). Approve the pending restart on the phone when requested. Confirm the same address works and approved-device state persists. A terminated Reach PTY must be shown as ended, not as a silently hanging live terminal. Do not expect sessions to survive a host reboot or FileVault pre-boot.

9. Sound (Screen's speaker). Play a video on the host with known speech and music. On the iPhone, tap the speaker: sound within a second, in step with the picture closely enough to follow speech; repeat with the ringer switch on silent (it should still play, as a video does) and with the volume buttons. Then on the Android phone. Lock and unlock the phone, background Reach for a minute and come back: the speaker turns off or carries on, never shows on while silent. Pause Reach on the host: sound stops and the host's recording indicator goes off. Switch the host's output between speakers and headphones (on Windows, the sound follows after a short reconnect). Throttle the link (cellular, or a weak Wi-Fi): sound gets lighter or skips and never runs late, and the picture keeps going. Confirm a guest with screen access sees no speaker. On a Windows host, repeat on a PC with speakers.

Also repeat ordinary owner access with the separate Tailscale app enabled. On a Windows host, exercise its supported pairing path separately; passing the Windows CI job is not an iPhone-to-Windows device test.

## Current security boundary

Read [SECURITY.md](SECURITY.md). The public Funnel surface exists only while an invitation or a browser agent's session is live, and is limited to the start page's fixed files, Face ID admission and the signed agent gateway, which carries an invited browser agent's API requests under that invitation's allowlist; owner APIs and WebSockets require authenticated private ingress. A registered owner passkey is an owner credential, not a guest invitation. Tailnet grants are additive: unrelated broad rules can widen a tagged device's network access. Setup rejects detected broad policies, but limited stored credentials cannot continuously audit later policy changes.

Record device results explicitly as passed, failed or not tested. Automated tests and emulated phone-width pages cannot be substituted for this gate.

## Sound in CI, and what it can't show

CI tests the computer's sound end to end except for the OS capture itself. On the Mac runners, the real Swift helper is built and its tone is played live through a real Reach into headless Chrome under Reach's own page policy, steady at the expected level (`test/screen-sound-chrome-e2e.test.mjs`). On the Windows runner, the PC's own csc.exe builds the C# helper, its tone comes through, and the same browser test plays it; its loopback capture runs until Windows reports no output device (runners have no speakers). The shared server and phone parts run on every lane, and every release's npm and portable artifacts must ship both helpers, ship the worklet as its own file (never an inlined `data:` script) and build and play the helper on the release's own OS (`scripts/smoke-package.mjs`). Real capture needs Screen Recording on a Mac with sound playing, and a PC with an output device; run it on a Mac with:

```sh
REACH_TEST_SOUND_CAPTURE=1 npm run test:file -- test/screen-sound-native.test.mjs
```

Safari on an iPhone, Android browsers and hearing a real PC are step 9 of the physical phone gate above.

## Optional native voice transcription

The ordinary suite uses synthetic microphone and transcription adapters. On a supported macOS host, opt into the separate native speech test with:

```sh
REACH_TEST_VOICE_NATIVE=1 npm run test:file -- --test-timeout=300000 test/voice-messages.test.mjs
```

This synthesizes disposable speech with the system voice, converts that sample and runs the local transcription helper. It does not record the microphone. The first run may download an Apple speech model, and the native case remains skipped in CI. Record its result separately from real microphone, phone permission and provider-message acceptance.
