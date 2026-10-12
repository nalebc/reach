# Contributing to Reach

Reach is an early-access project. Open an issue describing the problem before a large change, and keep pull requests focused. Use sample data in screenshots and tests; never include invitation links, credentials, private paths, chat transcripts, or personal device details.

## Develop

Use Node.js 22 or newer and the Go version in `tailnet/go.mod`. Install dependencies with `npm ci`. Use `npm run build` to compile the frontend and the `reach` CLI to manage the companion. Read [AGENTS.md](AGENTS.md) before changing a running installation. Work on a test account or disposable folders when exercising computer control.

Before submitting:

```sh
node scripts/check-release.mjs
npm run build:release
npm test
npm audit --audit-level=moderate
npm run package
npm run verify:package
```

Every pull request and merge-queue group runs the required CI and security gates. Linux (Node 22/24) and macOS (Apple Silicon/Intel) run the full guarded suite; Windows runs an explicit blocking portability suite. Every platform builds and clean-installs the release artifacts, including a real terminal smoke check. macOS additionally compiles native permission policies and tests file/script sandboxes, generated-pixel video encoding and plain-text PDF rendering with synthetic data and inert input. A disposable iOS simulator exercises real pairing, authenticated files and native transfer/share bridges. CI lints workflows, blocks moderate-or-higher npm advisories, checks Go vulnerabilities, scans all commit history for secrets and, on a public repository, runs CodeQL and dependency review. Test reports and candidate archives are retained; see [docs/RELEASE.md](docs/RELEASE.md). Test fixtures that look like credentials (API keys, tokens) must be assembled at run time, never spelled out in source: the privacy check and the secret scanners read the source.

Add regression coverage for permission boundaries, protocol handling and behavioral changes. Do not remove a failing security test to make CI green. Record platform-specific checks and anything not tested. Changes to permissions must be enforced on the server, including revocation during asynchronous work.

Describe the problem, resulting behavior, validation, and limitations in the pull request. Contributions are distributed under the project's MIT license; preserve attribution for third-party work. Be respectful and specific in discussions. Security reports follow [SECURITY.md](SECURITY.md), not public bug reports.

CI uses disposable GitHub-hosted runners, read-only permissions for project code, immutable action revisions, and no contributor secrets. Run focused tests with `npm run test:file -- test/name.test.mjs`; every test must use the runaway guard. The Windows list in `.github/scripts/run-tests.mjs` is an explicit portability gate, not a claim that the entire Windows suite passes. New cross-platform behavior should extend that list. Never remove a platform, weaken a guard, or turn a security failure into `continue-on-error` just to merge.

Maintainers must activate [repository protections and the protected release environment](.github/MAINTAINER_SETUP.md). Workflow files alone do not prevent an unsafe merge. The solo-maintainer policy requires pull requests and successful checks without a second-person approval. Publishing separately requires fresh checks, explicit manual maintainer approval, and npm trusted publishing; the owner may approve their own release, and contributor jobs never receive publishing credentials. Real-device permission prompts, biometrics, network enrollment and paid provider sessions still require recorded release qualification.

For workflow changes, run actionlint 1.7.12, then zizmor 1.30.1 with `--persona regular --min-severity low .github/workflows`, and `npm run test:file -- test/ci-policy.test.mjs`. Online audits are required: supply GitHub authentication through the environment, unset `ZIZMOR_OFFLINE` and `ZIZMOR_NO_ONLINE_AUDITS`, and verify the output does not report offline mode. Never put credentials in commands or reports. An offline-only zizmor run cannot verify action tags. Resolve each action version to its full commit SHA (follow annotated tag objects) and keep the version comment.
