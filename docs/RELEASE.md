# Release verification

Reach ships as a computer companion plus a phone web interface. Native iOS is an optional developer build. Treat 0.1.0 as early access until the real-device checks below are recorded. Automated tests do not certify latency, OS permission dialogs, or every future Claude/Codex update.

## Build and verify a candidate

Use Node.js 22 or newer and Go at the version specified in `tailnet/go.mod`. On Linux, node-pty may need a compiler. From a clean source checkout:

```sh
npm ci
node scripts/check-release.mjs
npm run build:release
npm test
npm audit --audit-level=moderate
npm run package
npm run verify:package
```

`build:release` requires browser networking to build successfully. Packaging rejects missing or stale assets. `verify:package` packs the actual npm artifact, installs it in a temporary directory with production dependencies only, and checks the CLI, served interface, authenticated file listing, and denial of unauthenticated and out-of-root access. It leaves the tarball in `release/`; temporary settings and credentials are removed. Nothing is published and no Tailscale device is enrolled.

The portable folder is `release/reach`. It includes startup scripts, source/build inputs, browser networking, the license, and documentation; it installs its dependencies on first launch. The npm artifact contains built assets and runtime code rather than the React source. Neither includes local Reach state, signing files, or `work/` scratch files.

CI repeats the release checks on macOS, Linux and Windows. A separate unsigned simulator build compiles the iOS plugins. CI configuration in a local checkout is not evidence that those remote jobs have passed: inspect the checks on the exact release commit.

## Native iOS verification

On a Mac with Xcode:

```sh
npm run build
REACH_APP_URL=https://computer.example.ts.net:8443 npx cap sync ios
xcodebuild -project ios/App/App.xcodeproj -scheme App \
  -configuration Release -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

This placeholder URL is only for compilation. For a device build, supply your own private Reach address locally. Generated Capacitor configuration, copied web assets, signing overrides and Xcode user settings are ignored by Git. Never commit an Apple team ID, certificate, provisioning profile, personal device URL, or paired-client state. A successful simulator build does not qualify a TestFlight submission.

## Required real-device checks

Record the candidate's commit or artifact checksum, host OS, agent/app versions, phone model and browser/app version with results. Use disposable files and conversations.

- First setup from an unpaired browser: owner approval, repeat visit, wrong/expired pairing, revocation. Test both Tailscale-app and browser-only connection modes.
- Invite a second person: intended scopes only, expiry, cancel/revoke, no owner settings or cross-folder access. Verify the public start page never serves file, terminal or screen APIs or WebSockets; its optional passkey enrollment endpoints must require valid challenges and verified credentials.
- File upload/download/share; terminal typing, scrolling and reconnection; background the phone and change Wi-Fi to cellular and back.
- Screen permissions, fullscreen, held Backspace, input focus, control lease, disconnect/revoke. Test the locked/sleeping Mac behavior described in the UI; do not claim lock-screen bypass.
- Claude/Codex send, queue, stop, all pages of questions, explicit allow/deny, stale prompts and interrupted delivery. Follow [agent compatibility](AGENT_COMPATIBILITY.md). Confirm a failed chat does not blank Files, Terminal or Screen.
- Background service restart and recovery; uninstall removes only Reach-owned resources. Existing Tailscale Serve routes must survive.
- Physical Windows host and Android phone before describing those paths as device-tested. Keep unsupported/unverified features explicit in release notes.

## Publish only after qualification

Review `docs/SECURITY.md`, the artifact inventory and the privacy check. The scanner is a guardrail, not a complete secret audit. Review images/demo recordings manually. Do not include private logs as public attachments.

Publish the exact tested tarball, rather than rebuilding after qualification. Attach a checksum, supported-platform matrix, known limitations and upgrade/recovery instructions to the release. Publishing to npm/GitHub, uploading a signed app and editing a user's live Tailscale configuration are separate actions from preparing this candidate.
