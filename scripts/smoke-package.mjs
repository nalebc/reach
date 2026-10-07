// Install the actual npm artifact outside the checkout, then exercise it with
// synthetic files and credentials. Never starts Tailscale or an agent session.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { assertReleaseAssets } from "./release-assets.mjs";
import { tailnetManifestFiles } from "./build-tailnet.mjs";

// The browser sign-in client dominates the tarball; a second copy of it is the
// usual way to blow past this.
const PACKAGE_BUDGET = 30 * 1024 * 1024;
const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
assertReleaseAssets(root);
const npm = process.env.npm_execpath;
if (!npm) throw Error("Run this check with npm run verify:package.");
const output = path.join(root, "release");
fs.mkdirSync(output, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "reach-package-smoke-"));
const runNpm = (args) => execFileSync(process.execPath, [npm, ...args], {
  cwd: root, encoding: "utf8", timeout: 180000, maxBuffer: 8 << 20,
  env: { ...process.env, npm_config_cache: path.join(temp, "npm-cache") },
});
try {
const [pack] = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", output]));
const paths = pack.files.map((file) => file.path);
for (const required of ["dist/index.html", "dist/start.html", "dist/agent.mjs", "tailnet/dist/tailnet.json", "scripts/native/input.swift", "bin/reach.mjs", "docs/THIRD_PARTY_NOTICES.md"])
  assert.ok(paths.includes(required), `Missing from npm artifact: ${required}`);
for (const file of paths)
  assert.ok(!/(^|\/)(?:\.reach|\.env|work|node_modules|test|ios)(?:\/|$)/.test(file), `Private or development file in artifact: ${file}`);
  // tailnet/dist ships whole: exactly the current manifest's files, no earlier build.
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "tailnet/dist/tailnet.json"), "utf8"));
  const expected = new Set(tailnetManifestFiles(manifest).map((name) => `tailnet/dist/${name}`));
  for (const file of paths)
    if (file.startsWith("tailnet/dist/")) assert.ok(expected.has(file), `Stale browser sign-in build in npm artifact: ${file}`);
  for (const file of expected) assert.ok(paths.includes(file), `Missing from npm artifact: ${file}`);
  console.log(`Packed ${pack.filename}: ${megabytes(pack.size)} (${paths.length} files, ${megabytes(pack.unpackedSize)} unpacked).`);
  assert.ok(pack.size <= PACKAGE_BUDGET, `npm artifact is ${megabytes(pack.size)}; the budget is ${megabytes(PACKAGE_BUDGET)}.`);

  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  runNpm(["install", "--prefix", temp, "--omit=dev", "--no-audit", "--no-fund", path.join(output, pack.filename)]);
  const installed = path.join(temp, "node_modules", ...pkg.name.split("/"));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("REACH_"))),
    REACH_HOME: path.join(temp, "state"), NODE_TEST_CONTEXT: "release-smoke",
  };
  const run = (args) => execFileSync(process.execPath, args, { cwd: temp, env, encoding: "utf8", timeout: 30000 });
  assert.match(run([path.join(installed, "bin/reach.mjs"), "--help"]), /Reach/);
  assert.equal(run([path.join(installed, "bin/reach.mjs"), "--version"]).trim(), pkg.version);
  const smoke = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { createReach } from ${JSON.stringify(pathToFileURL(path.join(installed, "server/index.mjs")).href)};
    const shared = ${JSON.stringify(path.join(temp, "shared"))};
    fs.mkdirSync(shared);
    fs.writeFileSync(shared + '/hello.txt', 'Release smoke test');
    const app = await createReach({ roots: [shared], dataDir: ${JSON.stringify(path.join(temp, "private"))}, port: 0 });
    try {
      await new Promise(r => app.server.listen(0, '127.0.0.1', r));
      const base = 'http://127.0.0.1:' + app.server.address().port;
      assert.equal((await fetch(base + '/')).status, 200);
      assert.equal((await fetch(base + '/api/files')).status, 401);
      const owner = app.auth.issue('Release tester', ['files'], 'agent');
      const response = await fetch(base + '/api/files', { headers: { Authorization: 'Bearer ' + owner.token } });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.ok(JSON.stringify(data).includes('hello.txt'));
      assert.equal((await fetch(base + '/api/files?path=..', { headers: { Authorization: 'Bearer ' + owner.token } })).status, 403);
    } finally { await app.close(); }
  `;
  run(["--input-type=module", "-e", smoke]);
  console.log(`Clean package install passed: ${pack.filename} (${paths.length} files). CLI, UI, authenticated files and access boundaries verified.`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
