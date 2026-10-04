# iPad Desktop mode

Use **Screen → iPad desktop** in the Reach iPad app. This is a native full-screen Mac desktop, separate from the phone touch interface. App mode is not part of this change. Audio is deferred to phase 2.

## Install and connect

1. Update the Mac checkout, run `npm run build`, and restart Reach when it is safe to interrupt its active sessions. The currently running server does not hot-reload backend changes.
2. Connect both devices to Tailscale. Use Reach's private HTTPS Serve URL and pair the iPad. A URL or pairing code does not grant tailnet membership. No Funnel, public port, external media service, or Supabase credential is introduced.
3. Rebuild the native app; a web refresh cannot install the new plugin:

   ```sh
   REACH_APP_URL='https://your-mac.your-tailnet.ts.net:8443' npx cap sync ios
   open ios/App/App.xcodeproj
   ```

   Select your iPad and signing team in Xcode and run. TestFlight distribution still requires your normal signed archive and upload. The unsigned development build used for verification is not a TestFlight release.

   The repository uses the placeholder bundle identifier `com.example.reach`.
   Keep account and signing details local: copy `ios/Signing.local.xcconfig.example`
   to the ignored `ios/Signing.local.xcconfig`, set your own identifier and team,
   and pass it to `xcodebuild -xcconfig ios/Signing.local.xcconfig`. Set the same
   identifier through `REACH_APP_ID` when running Capacitor sync. Do not commit
   Apple account addresses, device identifiers, signing certificates, profiles,
   or generated archives. For an existing installed app, reuse its identifier in
   your local settings to preserve the app identity across builds.

4. Grant Screen Recording and Accessibility to the Reach helpers locally when requested. Enable screen viewing in Reach.
5. In **iPad desktop**, choose **Match iPad** (default) or **Mirror main display**, optionally enable clipboard sync, and choose a shared folder for dropped files. Open the desktop, then tap **Control** to grant its separate input lease.
6. The Mac menu bar shows **Reach • Connected**, with the paired device's name and viewing/controlling state in its menu. **Disconnect remote desktop** ends the session. The desktop never unlocks the Mac or FileVault.

The browser Screen view remains available with WebCodecs H.264 → canvas and JPEG as its compatibility fallback. Native pointer lock, hardware-keyboard handling, and the temporary iPad display require the updated iPad app.

## Display and input

Match iPad creates a temporary 60 Hz HiDPI display at the iPad's native pixel size, up to 3840 pixels per side and nine million pixels. The size is chosen on entry; reopen the mode after changing orientation if you want a new matching resolution. Mirror shares the main display without changing its resolution.

Virtual displays use the undocumented `CGVirtualDisplay` API, runtime checked before use. This is experimental and not an Apple-supported headless guarantee. A headless host attempts a virtual display automatically. If creation is refused, connect an HDMI dummy plug and select Mirror main display. Existing application windows can remain on the physical display when a new display is added; use Mirror to see that workspace.

The display is retained across a short 3.5-second period after the last socket disconnects. Explicit Done, local Disconnect, disabled viewing, revoked credentials, or session expiry disposes of it immediately. A two-second user-activity assertion during cleanup lets WindowServer finish removal if its physical display slept. This may briefly wake the screen; it changes no permanent power or lock settings and cannot unlock the Mac.

Physical keyboard events use HID usages, separate down/up edges, repeats, left/right modifiers, arrows, Escape, navigation, punctuation, keypad keys and F1–F20. macOS applies its selected keyboard layout. The toolbar's **fn** toggle supplies the function modifier when iPadOS consumes the physical Globe key. iPadOS keeps its reserved system shortcuts:

| Mac action                     | Toolbar      | Default alternative       |
| ------------------------------ | ------------ | ------------------------- |
| App switcher                   | Apps         | Control + Option + Tab    |
| Spotlight                      | Search       | Control + Option + Space  |
| Mission Control                | Spaces       | Control + Option + Up     |
| Release remote control/pointer | Stop control | Control + Option + Escape |

**Options** changes the alternative prefix to Option + Shift. Command+C/V/W and other unreserved combinations go to the Mac. Pointer lock is requested while controlling; iPadOS decides whether to grant it. The overlay reports the actual lock state. If it is unavailable, hover positioning remains usable within the desktop image. Left/right/middle buttons, held-button dragging, and scroll deltas use the persistent native input process. GCMouse does not expose physical momentum phases; its delivered deltas are forwarded with bounded began/changed/ended gesture phases, without adding guessed extra inertia. The server protocol also supports explicit momentum phases for clients that provide them.

On EOF, disconnect, native watchdog expiry or lease revocation, all held mouse buttons and keys are released. Input queues are bounded and never replayed after reconnect. Reconnected viewing starts without control: tap Control again. This is deliberate to avoid resuming stale keyboard or pointer actions.

## Clipboard and file drops

Clipboard sync is **off by default**, opt-in for each desktop session, and requires the active control lease. It exchanges text up to 16 KiB and PNG images up to 2 MiB / 16 million pixels. Mac TIFF clipboard images are converted to bounded PNGs. Revisions prevent echo loops and avoid replacing a newer local clipboard with an older server response. iPadOS may request cross-app paste permission. Turn it off by closing the desktop and reopening with the checkbox off.

Drop one file from iPad Files onto the desktop to upload it to the shared folder selected before connecting, using Reach's existing file endpoint and permissions. The 100 MiB limit, filename validation and no-overwrite behavior still apply. This is a folder upload, not arbitrary Finder drop-target injection. Multipart bodies are assembled on disk off the UI thread. Ending the native desktop cancels its outstanding HTTP operations.

## Transport and performance

ScreenCaptureKit produces NV12 video buffers for VideoToolbox hardware H.264. The encoder uses real-time / low-latency rate control, no B-frames, speed priority, and a forced keyframe approximately every two seconds. Every reconnect requests a keyframe. The native view submits compressed samples to AVSampleBufferDisplayLayer; frames do not cross the JavaScript bridge.

Video and input have separate authenticated WebSockets. Both run through private HTTPS/Tailscale Serve. This is TCP over Tailscale, not a new public UDP transport. Frame windows, native decode readiness, input queues, and socket buffering are bounded.

Direct desktop sessions target 60 fps and 16 Mbps at iPad resolution. A peer reported as Relayed starts at 30 fps / 4 Mbps. Congestion reduces delivery rate and encoder bitrate; healthy intervals recover toward the session's ceiling. The source IP comes from Serve's forwarded address and is matched against `tailscale status --json`; unknown peers are labelled Unknown rather than guessing. This diagnostic does not authorize access. The overlay reports delivered frames, actual bytes per second, and frame-acknowledgement latency. ACK latency includes client processing and is **not glass-to-glass latency**.

The native client watches network-path changes and retries after 500 ms. A no-frame watchdog detects a stale connection at roughly 2.5–3.5 seconds. A usable Tailscale path and a still-valid session are required; a longer outage, server restart, session expiry or local revocation requires reopening Desktop mode. First-use helper compilation may take longer than a reconnect. No queued input is retried.

## Prepare a Mac mini

The preparation checklist reads power configuration, FileVault status and display availability. It does not run administrator commands or change system/security preferences.

- Use `./reach install` for the existing launchd background service. Its private Tailscale Serve route persists independently of the app process.
- Use Reach's stay-awake mode to prevent idle system and display sleep. Normal launches default to the whole Reach session, including older saved setups; `--stay-awake` restricts assertions to AC power and `--no-stay-awake` allows normal idle sleep.
- Enable startup after power failure in System Settings → Energy if your Mac supports it. This may require an administrator.
- Keep an appropriate signed-in desktop available. Locking can interrupt capture; Reach cannot bypass it.
- With FileVault, a reboot stops at the disk-unlock password before Reach or Tailscale can run. Someone needs local access.
- Test without a monitor on the actual Mac mini before relying on it away from home. Keep the HDMI dummy fallback available if virtual displays fail on that OS/build.

## Verification

Run the regression suite and native build:

```sh
xcrun swiftc -parse-as-library -O scripts/native/screen-stream.swift -o /tmp/reach-screen-video-test
REACH_TEST_VIDEO_HELPER=/tmp/reach-screen-video-test npm test
npm run build
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -destination 'generic/platform=iOS' -derivedDataPath /tmp/reach-ipad-build \
  CODE_SIGNING_ALLOWED=NO build
```

A synthetic hardware benchmark, without screen capture:

```sh
node scripts/benchmark-desktop.mjs /tmp/reach-screen-video-test 2752 2064 60
```

On the development Mac on 2026-10-03, this generated 300 frames in 5.00 seconds (60.0 fps), with generation + encode + pipe p50 **15.10 ms** and p95 **15.58 ms**. This simple moving-pattern workload is not representative of every desktop workload. It excludes capture, tailnet transport, iPad decoding/display, and physical input. The actual 2752×2064 virtual display was created as 1376×1032 logical HiDPI and successfully removed, restoring the original display count. Physical iPad and headless Mac mini acceptance remain unmeasured.

For glass-to-glass measurement, show a fast-changing frame counter on the Mac and film that screen beside the iPad at 240 fps. Compare the same frame transition across both screens over at least 30 samples; each camera frame is about 4.17 ms. Report median/p95 and the camera quantization, separately for direct LAN and a verified relayed connection. For input-to-photon, film a visible physical key/button actuation and its resulting Mac/iPad change. Do not substitute ACK RTT or the synthetic benchmark for either result.

Before calling hardware acceptance complete, verify: native-resolution sustained LAN video under scrolling/motion; the actual pointer-lock indicator; Command+C/V/W, modifier release, function keys, right-click and window/text dragging; trackpad momentum; clipboard text/images both ways; a file upload; brief network changes; revoked access during held keys; local Disconnect; display teardown; and a monitor-free Mac mini session. Record device/OS/keyboard/mouse models and direct/relay route. Audio, App mode, Windows native desktop mode, multiple monitors, login-window unlocking and FileVault pre-boot are out of scope for this phase.

Implementation references: [Apple pointer-lock behavior](https://developer.apple.com/documentation/uikit/uiviewcontroller/preferspointerlocked), [Chromium's virtual-display API investigation](https://chromium.googlesource.com/chromium/src/+/HEAD/ui/display/mac/test/virtual_display_util_mac.mm), [Tailscale Serve](https://tailscale.com/docs/features/tailscale-serve). No third-party virtual-display implementation is bundled.
