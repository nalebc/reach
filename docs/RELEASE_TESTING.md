# Release acceptance

CI checks macOS, Linux and Windows with Node 22, builds the browser Tailscale client, stages the downloadable release, and smoke-tests its CLI. These checks do not establish physical-phone onboarding, WebAuthn interoperability or remote-desktop performance.

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
8. Restart the companion using the intended foreground/background workflow. Confirm the same address works and approved-device state persists. A terminated Reach PTY must be shown as ended, not as a silently hanging live terminal. Do not expect sessions to survive a host reboot or FileVault pre-boot.

Also repeat ordinary owner access with the separate Tailscale app enabled. On a Windows host, exercise its supported pairing path separately; passing the Windows CI job is not an iPhone-to-Windows device test.

## Current security boundary

Read [SECURITY.md](SECURITY.md). The public Funnel surface exists only while an invitation or a browser agent's session is live, and is limited to the start page's fixed files, Face ID admission and the signed agent gateway, which carries an invited browser agent's API requests under that invitation's allowlist; owner APIs and WebSockets require authenticated private ingress. A registered owner passkey is an owner credential, not a guest invitation. Tailnet grants are additive: unrelated broad rules can widen a tagged device's network access. Setup rejects detected broad policies, but limited stored credentials cannot continuously audit later policy changes.

Record device results explicitly as passed, failed or not tested. Automated tests and emulated phone-width pages cannot be substituted for this gate.

## Optional native voice transcription

The ordinary suite uses synthetic microphone and transcription adapters. On a supported macOS host, opt into the separate native speech test with:

```sh
REACH_TEST_VOICE_NATIVE=1 node --test test/voice-messages.test.mjs
```

This synthesizes disposable speech with the system voice, converts that sample and runs the local transcription helper. It does not record the microphone. The first run may download an Apple speech model, and the native case remains skipped in CI. Record its result separately from real microphone, phone permission and provider-message acceptance.
