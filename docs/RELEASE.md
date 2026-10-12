# Release verification

Reach ships as a computer companion plus a phone web interface. Native iOS is an optional developer build. Treat 0.1.0 as early access until the real-device checks below are recorded. Automated tests do not certify latency, OS permission dialogs, or every future Claude/Codex update.

## Build and verify a candidate

Use Node.js 22 or newer (`.nvmrc`) and Go at the version specified in `tailnet/go.mod`. On Linux, node-pty may need a compiler. From a clean source checkout:

```sh
npm ci
node scripts/check-release.mjs
npm run build:release
npm test
npm audit --audit-level=moderate
npm run package
npm run verify:package
```

`build:release` requires browser networking to build successfully, and it removes browser sign-in files in `tailnet/dist` that the current manifest does not list, so an earlier build never ships next to the current one. Packaging rejects missing or stale assets. `check-release` also rejects third-party notices whose dependency-lock fingerprint or named npm/Go versions differ; regenerate them with `node scripts/build-notices.mjs` after dependency changes. `verify:package` creates the npm tarball and portable archive before testing either. It installs the npm tarball and extracts the portable archive into separate temporary directories with production dependencies only. Both installs exercise the CLI, served interface, authenticated file listing, native terminal startup, and denial of unauthenticated and out-of-root access; the portable install also executes its extracted launcher. The npm artifact's `tailnet/dist` must contain exactly the manifest's files, and its size must stay under 30 MB (the size is printed).

Verification records both archive SHA-256 hashes before installation, rejects any byte change during testing, and writes a success-only `release/package-verification.json` receipt bound to the source commit. CI copies only those verified archives into the release candidate and checks their hashes again; it never repacks the mutable portable staging directory after testing. Both archives remain in `release/`; temporary settings and credentials are removed. Nothing is published and no Tailscale device is enrolled.

The installed lane also extracts a fresh portable archive with no dependencies or setup stamp, runs its full first local launch (including `npm ci` and the interface build), checks the served page, and verifies the `update` guidance. The Ubuntu/Node 24 lane separately installs with npm 12, checks the blocked node-pty diagnostic, then explicitly approves and rebuilds that dependency in a temporary prefix. This test approval does not choose the project's Linux distribution policy.

The portable folder is `release/reach`. It includes startup scripts, source/build inputs, browser networking, the license, and documentation; it installs its dependencies on first launch. `reach update` points to the release archive rather than git. To replace a portable copy, stop that copy, replace its program files with the new archive in the same folder, and start it again. Keep its `.reach` state folder and any configured external `REACH_HOME`/`REACH_DATA`; neither archive contains saved state. The npm artifact contains built assets and runtime code rather than the React source. Neither includes local Reach state, signing files, or `work/` scratch files.

CI (`.github/workflows/ci.yml`) runs on every PR, merge-group and push to `main` or a release branch. Linux runs the full suite on Node 22 and 24; Apple Silicon and Intel macOS run it on Node 22. Windows has a blocking, explicit portability suite rather than a silently optional full-suite failure. All five lanes build and clean-install the actual package, exercise native terminal startup, and upload checksummed npm/portable archives. POSIX lanes then rerun the first-install/phone matrix against that installed npm artifact; Ubuntu/Node 22 also exercises a source install without preinstalled Node, npm, Go or Tailscale. The latter still simulates Tailscale identity and network enrollment; it is not a real-account test. The portable archive preserves executable modes. macOS also runs compiled policy tests with inert input, real kernel file/script sandbox tests, generated-pixel video encoding, privacy-rule rejection before capture, and plain-text PDF rendering. Native helpers are compiled into a temporary directory and removed after the tests. These checks do not capture or type into an actual desktop.

The iOS lane compiles with local ad-hoc simulator signing, requiring no Apple account. It creates a disposable simulator and exercises the real pairing UI, authenticated file bytes in WKWebView, traversal refusal, native filesystem reads/writes, authenticated URLSession download bytes and native share capability. A temporary local TLS certificate is trusted only in that simulator; the simulator and synthetic data are removed afterward. JUnit, JSON and screenshot evidence remain available after failures, alongside the other lanes' JUnit/TAP reports. Simulator success does not replace physical-device, real-network and provider qualification.

The stable **CI required** check rejects any failed, cancelled, skipped or missing prerequisite: privacy checks, actionlint/zizmor, Go vet/vulnerability scans, npm audit at moderate severity (including build tools), all platform lanes, iOS, and current published agent CLI/protocol compatibility. **Security required** independently requires the full-history secret scan and, when public, CodeQL and PR dependency review. Both gates handle merge queue events. Actions are pinned to immutable revisions; project scripts receive read-only permissions and no secrets. No shared dependency caches enter the release path. Daily agent compatibility and weekly security scans catch upstream changes. Advisory Scorecard publication runs separately in `scorecard.yml`, only for the public default branch; tag releases do not request its OIDC permission.

CI configuration in a local checkout is not evidence that remote jobs passed. Inspect results on the exact candidate commit, and activate the rules in [.github/MAINTAINER_SETUP.md](../.github/MAINTAINER_SETUP.md). The intended open-source repository became public on October 12, 2026 (UTC), enabling its public security checks. The owner requested branch and release-tag protections after validation and main integration finish; those rulesets remain pending that final step. Never report a configured Windows or Intel lane as a completed test before its runner has passed.

### Tag-driven release

`.github/workflows/release.yml` accepts a `v<version>` tag only for a commit already on `main`, with matching package version/repository and dated release notes. It fails closed unless the repository is public and the **npm-release** environment requires explicit maintainer approval, disables administrator bypass and restricts release tags. Under the owner's solo-maintainer policy, the owner may approve their own release; successful checks never replace that manual approval. Configure the environment, immutable tags, branch protections and the npm trusted publisher as described in the maintainer setup. No `NPM_TOKEN` is used. In the commit you tag, also move the source install's `--branch v…` in `README.md` and `docs/GUIDE.md` to the new tag: source installs follow releases, not `main`.

The tag reruns the same platform CI and security workflows with read-only build permissions. It selects the exact verified Ubuntu/Node 22 candidate, checks its source commit and checksums, and creates release notes without rebuilding. After environment approval, a fresh job with publishing authority downloads that immutable same-run artifact, rechecks checksums, creates GitHub provenance attestations, and runs `npm publish --ignore-scripts --provenance --access public` using short-lived OIDC credentials. That job never checks out source, installs dependencies or runs lifecycle scripts. It requires npm 11.5.1 or newer and creates the GitHub release with the same npm tarball, portable archive, `SHA256SUMS`, commit-bound `candidate.json` receipt, and notes. If npm succeeded but GitHub release creation failed, rerunning skips npm publication only when the registry reports the exact candidate version and SHA-512 integrity; mismatches and registry errors fail closed. GitHub recovery uploads only missing assets to an exactly matching draft, verifies all asset digests, and then publishes it. An identical published release is a read-only successful retry. Conflicting metadata or assets, unfinished `starter` uploads, and incomplete published releases stop for maintainer review; no asset is overwritten or deleted and no tag is moved.

Verify a download with `shasum -a 256 -c SHA256SUMS` and `gh attestation verify nalebc-reach-VERSION.tgz --repo OWNER/REPO`. A provenance record identifies the build; it does not replace real-device qualification or a security review.

## Making the repository public

The intended open-source repository is public as of October 12, 2026 (UTC). Secret scanning with push protection, Dependabot alerts/security updates, private vulnerability reporting, outside-contributor workflow approval and the manual-approval release environment have been read back from GitHub. Branch and tag protections are the final pending step after validation and main integration. The checklist below also applies when setting up another repository. Private repository jobs depend on account billing and plan limits; standard GitHub-hosted runners are free for public repositories, which gain the code scanning and repository protections used here.

1. Review the existing history for private data and run `node scripts/check-release.mjs`. Preserve legitimate contributor attribution; do not make public contributions depend on an owner-only identity allowlist. Any necessary history rewrite is a separate, destructive maintenance action and needs explicit coordination.
2. Review `docs/media` and every file the privacy check cannot judge (images, recordings).
3. After it is public, enable in Settings → Code security: secret scanning with push protection, private vulnerability reporting (SECURITY.md promises it) and Dependabot security updates. On the next default-branch push, `security.yml` uploads CodeQL results and `scorecard.yml` publishes Scorecard results.
4. Activate the reviewed [ruleset templates and release environment](../.github/MAINTAINER_SETUP.md). Require pull requests, resolved review threads, **CI required** and **Security required** from GitHub Actions, and the CodeQL findings gate. The solo-maintainer templates do not require a second person's approval and grant no bypass; review contribution diffs before merging. Prove the protections reject a failing contribution before enabling automatic merging.

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
- Invite a second person: intended scopes only, expiry, cancel/revoke, no owner settings or cross-folder access. Verify that port 443 is closed while no invitation or browser agent session is open, and that while one is open the public side serves only the start page's fixed files, the two Face ID endpoints and the signed agent gateway: owner APIs and WebSockets must be refused, Face ID must require a valid challenge and a verified passkey, and the gateway must reject an unsigned or replayed envelope and any path outside the invitation's allowlist.
- File upload/download/share; terminal typing, scrolling and reconnection; background the phone and change Wi-Fi to cellular and back.
- Screen permissions, fullscreen, held Backspace, input focus, control lease, disconnect/revoke. Test the locked/sleeping Mac behavior described in the UI; do not claim lock-screen bypass.
- Claude/Codex send, queue, stop, all pages of questions, explicit allow/deny, stale prompts and interrupted delivery. Follow [agent compatibility](AGENT_COMPATIBILITY.md). Confirm a failed chat does not blank Files, Terminal or Screen.
- Background service restart and recovery; uninstall removes only Reach-owned resources. Existing Tailscale Serve routes must survive.
- Physical Windows host and Android phone before describing those paths as device-tested. Keep unsupported/unverified features explicit in release notes.

## Publish only after qualification

Review `docs/SECURITY.md`, the artifact inventory and the privacy check. The scanner is a guardrail, not a complete secret audit. Review images/demo recordings manually. Do not include private logs as public attachments.

Publish the exact tested tarball, rather than rebuilding after qualification. Attach a checksum, supported-platform matrix, known limitations and upgrade/recovery instructions to the release. Publishing to npm/GitHub, uploading a signed app and editing a user's live Tailscale configuration are separate actions from preparing this candidate.
