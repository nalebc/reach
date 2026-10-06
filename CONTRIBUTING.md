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

Add regression coverage for permission boundaries, protocol handling and behavioral changes. Do not remove a failing security test to make CI green. Record platform-specific checks and anything not tested. Changes to permissions must be enforced on the server, including revocation during asynchronous work.

Describe the problem, resulting behavior, validation, and limitations in the pull request. Contributions are distributed under the project's MIT license; preserve attribution for third-party work. Be respectful and specific in discussions. Security reports follow [SECURITY.md](SECURITY.md), not public bug reports.
