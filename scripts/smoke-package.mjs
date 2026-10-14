// Install the actual npm and portable archives outside the checkout, then
// exercise them with synthetic data. Never starts Tailscale or an agent session.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
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
const verification = path.join(output, "package-verification.json");
fs.rmSync(verification, { force: true }); // A failed run must not leave an older passing receipt.
// Managed checkouts and installed tools can live under hidden directories.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), ".reach-package-smoke-"));
const runNpm = (args, cwd = root) => execFileSync(process.execPath, [npm, ...args], {
  cwd, encoding: "utf8", timeout: 180000, maxBuffer: 8 << 20,
  env: { ...process.env, npm_config_cache: path.join(temp, "npm-cache") },
});
try {
const [pack] = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", output]));
const paths = pack.files.map((file) => file.path);
for (const required of ["dist/index.html", "dist/start.html", "dist/agent.mjs", "tailnet/dist/tailnet.json", "scripts/native/input.swift",
  "scripts/native/screen-sound.swift", "scripts/native/screen-sound.cs", "bin/reach.mjs", "docs/THIRD_PARTY_NOTICES.md"])
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
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const portableName = `reach-${pkg.version}-portable.tar.gz`;
  const portableArchive = path.join(output, portableName);
  const portableStage = path.join(output, "reach");
  assert.ok(fs.existsSync(portableStage), "Run npm run package before verify:package to stage the portable distribution.");
  assertReleaseAssets(portableStage);
  // Never extract links or special files from a release archive onto a tester's
  // machine. The portable staging folder contains only ordinary source/assets.
  const ordinaryTree = folder => {
    for (const name of fs.readdirSync(folder)) {
      const file = path.join(folder, name), stat = fs.lstatSync(file);
      assert.ok(stat.isFile() || stat.isDirectory(), `Non-regular portable input: ${path.relative(portableStage, file)}`);
      if (stat.isDirectory()) ordinaryTree(file);
    }
  };
  assert.ok(fs.lstatSync(portableStage).isDirectory(), "Portable staging must be a directory, not a link.");
  ordinaryTree(portableStage);
  execFileSync("tar", ["-czf", portableArchive, "-C", output, "reach"], {
    timeout: 180000, env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const artifact = path.join(output, pack.filename);
  const digest = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const verifiedDigest = digest(artifact), portableDigest = digest(portableArchive);
  // Keep the independent installations out of each other's package scope.
  // In npm 11, --prefix with a different cwd can consult an ancestor manifest
  // and report a false lock mismatch for the nested portable installation.
  const npmInstall = path.join(temp, "npm-install");
  fs.mkdirSync(npmInstall);
  runNpm(["install", "--omit=dev", "--no-audit", "--no-fund", artifact], npmInstall);
  const portableUnpack = path.join(temp, "portable");
  fs.mkdirSync(portableUnpack);
  execFileSync("tar", ["-xzf", portableArchive, "-C", portableUnpack], { timeout: 180000 });
  const portableInstalled = path.join(portableUnpack, "reach");
  assertReleaseAssets(portableInstalled);
  runNpm(["ci", "--omit=dev", "--no-audit", "--no-fund"], portableInstalled);
  const verifyInstalled = (installed, label) => {
    const fixture = path.join(temp, label);
    fs.mkdirSync(fixture);
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("REACH_"))),
      REACH_HOME: path.join(fixture, "state"), NODE_TEST_CONTEXT: "release-smoke",
    };
    const run = (args, timeout = 30000) => execFileSync(process.execPath, args, { cwd: fixture, env, encoding: "utf8", timeout });
    assert.match(run([path.join(installed, "bin/reach.mjs"), "--help"]), /Reach/);
    assert.equal(run([path.join(installed, "bin/reach.mjs"), "--version"]).trim(), pkg.version);
    if (label === "portable-smoke") {
      const launcher = process.platform === "win32" ? "reach.cmd" : "reach";
      if (process.platform !== "win32") assert.ok(fs.statSync(path.join(installed, launcher)).mode & 0o111, "Portable launcher lost its executable mode.");
      const help = process.platform === "win32"
        ? execFileSync(process.env.ComSpec || "cmd.exe", ["/d", "/c", "reach.cmd", "--help"], { cwd: installed, env, encoding: "utf8", timeout: 30000 })
        : execFileSync(path.join(installed, launcher), ["--help"], { cwd: installed, env, encoding: "utf8", timeout: 30000 });
      assert.match(help, /Reach/, "The launcher extracted from the actual portable archive must work.");
    }
    const smoke = String.raw`
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      const started = Date.now();
      const phase = name => console.log(${JSON.stringify(`Release ${label}: `)} + name + ' (' + (Date.now() - started) + 'ms)');
      phase('load installed server');
      const { createReach } = await import(${JSON.stringify(pathToFileURL(path.join(installed, "server/index.mjs")).href)});
      const shared = ${JSON.stringify(path.join(fixture, "shared"))};
      fs.mkdirSync(shared);
      fs.writeFileSync(shared + '/hello.txt', 'Release smoke test');
      phase('create isolated server');
      const app = await createReach({ roots: [shared], dataDir: ${JSON.stringify(path.join(fixture, "private"))}, port: 0 });
      try {
        phase('listen on localhost');
        await new Promise(r => app.server.listen(0, '127.0.0.1', r));
        const base = 'http://127.0.0.1:' + app.server.address().port;
        const request = (route, options = {}) => fetch(base + route, { ...options, signal: AbortSignal.timeout(10000) });
        phase('verify served interface');
        const page = await request('/');
        assert.equal(page.status, 200);
        const html = await page.text();
        const installedDist = ${JSON.stringify(path.join(installed, "dist"))};
        assert.equal(html, fs.readFileSync(installedDist + '/index.html', 'utf8'));
        const assets = [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"?]+)"/g)].map(match => match[1]))];
        assert.ok(assets.length > 0, 'the built page must reference assets');
        for (const asset of assets) {
          const response = await request(asset);
          assert.equal(response.status, 200, asset);
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(installedDist + asset), asset);
        }
        for (const [route, file] of [['/agent-browser', '/agent.html'], ['/files/smoke-deep-link', '/index.html']]) {
          const response = await request(route);
          assert.equal(response.status, 200, route);
          assert.deepEqual(Buffer.from(await response.arrayBuffer()), fs.readFileSync(installedDist + file), route);
        }
        phase('verify file authorization');
        assert.equal((await request('/api/files')).status, 401);
        const owner = app.auth.issue('Release tester', ['files'], 'agent');
        const response = await request('/api/files', { headers: { Authorization: 'Bearer ' + owner.token } });
        assert.equal(response.status, 200);
        const data = await response.json();
        assert.ok(JSON.stringify(data).includes('hello.txt'));
        assert.equal((await request('/api/files?path=..', { headers: { Authorization: 'Bearer ' + owner.token } })).status, 403);
        // Importing node-pty is not enough: an installed native helper can
        // load successfully but fail to spawn (missing executable permission,
        // skipped install scripts, or an unavailable prebuilt binary).
        phase('run packaged native terminal');
        const terminal = app.terminals.create({
          cwd: shared, name: 'Release smoke', clientId: 'release-smoke',
          command: process.platform === 'win32'
            ? 'Write-Output REACH_PACKAGE_TERMINAL_OK; exit 0'
            : "printf 'REACH_PACKAGE_TERMINAL_OK\\n'; exit 0",
        });
        const session = app.terminals.get(terminal.id);
        let timer;
        try {
          await Promise.race([
            session.ended,
            new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Packaged terminal did not finish.')), 10000); }),
          ]);
        } finally { clearTimeout(timer); }
        assert.equal(session.exitCode, 0);
        assert.match(session.buffer, /REACH_PACKAGE_TERMINAL_OK/);
        // The computer's sound as shipped: its worklet a file of its own
        // (inlined as a data: address, the page's policy refuses it) served
        // as script; on a Mac or a PC, the helper builds from this copy and
        // its tone comes through Reach's own reader.
        phase('verify packaged sound');
        const shipped = fs.readdirSync(installedDist + '/assets');
        const worklets = shipped.filter((name) => /^r2-sound-worklet-.+\.js$/.test(name));
        assert.equal(worklets.length, 1, 'the sound worklet ships as one file of its own');
        const naming = shipped.filter((name) => name.endsWith('.js') && fs.readFileSync(installedDist + '/assets/' + name, 'utf8').includes(worklets[0]));
        assert.ok(naming.length > 0, 'the screen loads the shipped worklet');
        for (const name of naming)
          assert.ok(!fs.readFileSync(installedDist + '/assets/' + name, 'utf8').includes('data:text/javascript'), name + ' inlines a script');
        const worklet = await request('/assets/' + worklets[0]);
        assert.equal(worklet.status, 200);
        assert.match(worklet.headers.get('content-type') || '', /javascript/);
        if (process.platform === 'darwin' || process.platform === 'win32') {
          const native = await import(${JSON.stringify(pathToFileURL(path.join(installed, "server/desktop-native.mjs")).href)});
          const { SoundSource } = await import(${JSON.stringify(pathToFileURL(path.join(installed, "server/screen-sound.mjs")).href)});
          const builds = { dataDir: ${JSON.stringify(path.join(fixture, "sound-helper"))} };
          fs.mkdirSync(builds.dataDir);
          const helper = process.platform === 'win32' ? await native.windowsBinary(builds, 'screen-sound') : await native.desktopBinary(builds, 'screen-sound');
          const heard = await new Promise((resolve) => {
            const got = { info: null, packets: 0 };
            new SoundSource(helper, ['--self-test', '0.2'], { onInfo: (info) => (got.info = info), onSamples: () => got.packets++, onEnd: () => resolve(got) });
          });
          assert.deepEqual(heard, { info: { rate: 48000, channels: 2 }, packets: 10 }, 'the shipped sound helper builds and plays its tone');
        }
      } finally {
        phase('close isolated server');
        await app.close();
      }
      phase('finished');
    `;
    // Building the sound helper takes a cold Intel Mac most of a minute.
    run(["--input-type=module", "-e", smoke], 240000);
  };
  verifyInstalled(path.join(npmInstall, "node_modules", ...pkg.name.split("/")), "npm-smoke");
  verifyInstalled(portableInstalled, "portable-smoke");
  assert.equal(digest(artifact), verifiedDigest, "The npm artifact changed while its installed copy was being tested.");
  assert.equal(digest(portableArchive), portableDigest, "The portable archive changed while its extracted copy was being tested.");
  fs.writeFileSync(verification, JSON.stringify({
    filename: pack.filename, sha256: verifiedDigest, version: pkg.version,
    package: pkg.name, commit: process.env.GITHUB_SHA || "local",
    portable: { filename: portableName, sha256: portableDigest },
  }, null, 2) + "\n");
  console.log(`Clean npm and portable archive installs passed: ${pack.filename} (${paths.length} files) and ${portableName}. CLI/portable launcher, all initial UI assets, agent entry, deep links, authenticated files, native terminal startup, the sound worklet and helper, and access boundaries verified under hidden temporary install directories. Both archive hashes are bound to the passing receipt.`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
