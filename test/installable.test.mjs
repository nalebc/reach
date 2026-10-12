import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { stateDir, packaged } from "../scripts/home.mjs";
import { importState } from "../scripts/import-state.mjs";
import {
  NODE_BUILDS,
  NODE_VERSION,
  ensureRuntime,
} from "../scripts/runtime.mjs";
import { parseOptions } from "../scripts/launcher-options.mjs";
import { ensurePtyHelper } from "../server/pty-helper.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const temp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `reach-${name}-`));

test("state stays in a checkout's own folder, and moves to ~/.reach when installed", () => {
  assert.equal(packaged, false, "tests run from a source checkout");
  assert.equal(stateDir("/src/reach", { env: {} }), path.join("/src/reach", ".reach"));
  assert.equal(
    stateDir("/usr/lib/node_modules/@nalebc/reach", {
      installed: true,
      home: "/Users/someone",
      env: {},
    }),
    path.join("/Users/someone", ".reach"),
  );
  assert.equal(
    stateDir("/anything", { installed: true, env: { REACH_HOME: "/tmp/r" } }),
    path.resolve("/tmp/r"),
  );
});

test("import brings paired phones and settings, never paths, logs or caches", () => {
  const from = temp("from"),
    to = path.join(temp("to"), ".reach");
  try {
    const old = path.join(from, ".reach");
    fs.mkdirSync(path.join(old, "quick", "device-requests"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(old, "logs"));
    for (const [file, text] of [
      ["preferences.json", "{}"],
      ["service.json", '{"root":"/old/checkout"}'],
      ["serve-owner.json", "{}"],
      ["host-status.json", "{}"],
      ["launcher.lock", "{}"],
      ["logs/companion.log", "log"],
      ["quick/clients.json", "[]"],
      ["quick/device.json", "{}"],
      ["quick/pairing.json", "{}"],
      ["quick/agent-host.json", '{"dataDir":"/old/checkout/.reach/quick"}'],
      ["quick/reach-input-v2", "binary"],
      ["quick/device-requests/abc.json", "{}"],
    ])
      fs.writeFileSync(path.join(old, file), text);
    fs.symlinkSync(path.join(old, "preferences.json"), path.join(old, "quick", "settings.json"));
    const copied = importState(from, to);
    assert.deepEqual(copied.sort(), [
      "preferences.json",
      "quick/clients.json",
      "quick/device-requests",
      "quick/device.json",
      "quick/settings.json",
    ]);
    // Symlinks are skipped, everything else private.
    assert.equal(fs.existsSync(path.join(to, "quick", "settings.json")), false);
    if (process.platform !== "win32") assert.equal(fs.statSync(to).mode & 0o777, 0o700);
    if (process.platform !== "win32") assert.equal(
      fs.statSync(path.join(to, "quick", "clients.json")).mode & 0o777,
      0o600,
    );
    for (const left of [
      "service.json",
      "serve-owner.json",
      "launcher.lock",
      "logs",
    ])
      assert.equal(fs.existsSync(path.join(to, left)), false, left);
    for (const left of ["pairing.json", "agent-host.json", "reach-input-v2"])
      assert.equal(fs.existsSync(path.join(to, "quick", left)), false, left);
    // Never over existing settings, never from itself or an empty folder.
    assert.throws(() => importState(from, to), /already has Reach settings/);
    assert.throws(
      () => importState(temp("empty"), path.join(temp("x"), ".reach")),
      /No Reach settings/,
    );
    assert.throws(() => importState(to, to), /own settings folder/);
  } finally {
    fs.rmSync(from, { recursive: true, force: true });
  }
});

test("the installed reach pins the same Node.js build as the ./reach script", async () => {
  const script = fs.readFileSync(path.join(repo, "reach"), "utf8");
  assert.equal(script.match(/^VERSION=(.+)$/m)[1], NODE_VERSION);
  const pinned = Object.fromEntries(
    [...script.matchAll(/TARGET=([\w-]+); SHA=([0-9a-f]{64})/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  assert.deepEqual(pinned, NODE_BUILDS);
  // A download that isn't exactly that build is never unpacked.
  const state = temp("runtime");
  try {
    await assert.rejects(
      ensureRuntime(state, {
        platform: "darwin",
        arch: "arm64",
        download: async () => new Response("not node"),
        log: () => {},
      }),
      /checksum mismatch/,
    );
    assert.deepEqual(fs.readdirSync(path.join(state, "runtime")), []);
    await assert.rejects(
      ensureRuntime(state, { platform: "win32", arch: "x64", log: () => {} }),
      /Mac and Linux/,
    );
  } finally {
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test("reach update, import and --version parse", () => {
  assert.equal(parseOptions(["update"]).command, "update");
  assert.equal(parseOptions(["--version"]).version, true);
  const imported = parseOptions(["import", "/some/reach"]);
  assert.equal(imported.command, "import");
  assert.equal(imported.importFrom, path.resolve("/some/reach"));
  assert.throws(() => parseOptions(["import"]), /Name the Reach folder/);
  assert.throws(() => parseOptions(["update", "--local"]), /does not accept/);
});

test("the published package ships the app, never sources or private state, and runs no install script of its own", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(repo, "package.json"), "utf8"),
  );
  assert.equal(pkg.bin.reach, "bin/reach.mjs");
  assert.ok(!pkg.private);
  for (const hook of ["preinstall", "install", "postinstall"])
    assert.equal(pkg.scripts[hook], undefined, hook);
  const bin = path.join(repo, pkg.bin.reach);
  assert.match(fs.readFileSync(bin, "utf8"), /^#!\/usr\/bin\/env node/);
  if (process.platform !== "win32") assert.ok(fs.statSync(bin).mode & 0o111);
  // Only what the server imports is installed on users' machines.
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), [
    "buffer-crc32",
    "express",
    // OpenClaw's config files are JSON5 (server/openclaw.mjs).
    "json5",
    "multer",
    "node-pty",
    "prompts",
    "qrcode-terminal",
    "tar-stream",
    "ws",
    "yauzl",
  ]);
  const packArgs = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const npm = process.env.npm_execpath;
  const command = npm ? process.execPath : process.platform === "win32" ? "cmd.exe" : "npm";
  const args = npm ? [npm, ...packArgs] : process.platform === "win32"
    ? ["/d", "/s", "/c", "npm pack --dry-run --json --ignore-scripts"] : packArgs;
  const [{ files }] = JSON.parse(
    execFileSync(command, args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // A checkout's dist/ can hold recent earlier builds too (they go after
      // a day, scripts/prune-assets.mjs): the listing is long.
      maxBuffer: 256 << 20,
    }),
  );
  const paths = files.map((f) => f.path);
  for (const needed of [
    "bin/reach.mjs",
    "scripts/bootstrap.mjs",
    "scripts/native/app-icon.js",
    "server/index.mjs",
    "package.json",
  ])
    assert.ok(paths.includes(needed), needed);
  for (const forbidden of [
    /^\.reach\//,
    /^src\//,
    /^test\//,
    /^ios\//,
    /^node_modules\//,
    /^scripts\/demo\//,
    /^release\//,
  ])
    assert.ok(!paths.some((p) => forbidden.test(p)), String(forbidden));
});

test("the terminal helper is made executable on start", () => {
  const pkg = temp("pty");
  try {
    const helper = path.join(pkg, "prebuilds", "darwin-arm64", "spawn-helper");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), "{}");
    fs.writeFileSync(helper, "", { mode: 0o644 });
    const resolve = () => path.join(pkg, "package.json");
    assert.equal(
      ensurePtyHelper({ platform: "darwin", arch: "arm64", resolve }),
      null,
    );
    if (process.platform !== "win32") assert.equal(fs.statSync(helper).mode & 0o777, 0o755);
    assert.equal(ensurePtyHelper({ platform: "linux", resolve }), null);
  } finally {
    fs.rmSync(pkg, { recursive: true, force: true });
  }
});


test("source-built node-pty helpers work when prebuilds are absent, and missing helpers are reported", () => {
  const pkg = temp("pty-source");
  try {
    const resolve = () => path.join(pkg, "package.json");
    assert.match(ensurePtyHelper({ platform: "darwin", arch: "arm64", resolve }), /spawn-helper.*Reinstall/);
    const helper = path.join(pkg, "build", "Release", "spawn-helper");
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(helper, "", { mode: 0o644 });
    assert.equal(ensurePtyHelper({ platform: "darwin", arch: "arm64", resolve }), null);
    if (process.platform !== "win32") assert.equal(fs.statSync(helper).mode & 0o777, 0o755);
  } finally { fs.rmSync(pkg, { recursive: true, force: true }); }
});


test("npm's launcher rejects Node 20 before importing or starting Reach", () => {
  const entry = new URL('../bin/reach.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    Object.defineProperty(process.versions, 'node', { value: '20.0.0' });
    process.argv = [process.execPath, 'reach', '--help'];
    await import(${JSON.stringify(entry)});
  `], { env: { ...process.env, REACH_SUPERVISED: '1' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Reach needs Node\.js 22 or newer/);
  assert.doesNotMatch(result.stdout, /Start Reach/);
});

test("a blocked native terminal dependency names npm's script approval repair", async () => {
  const { loadPty } = await import('../server/pty-helper.mjs');
  const problem = Error('Cannot find module ../build/Release/pty.node');
  assert.throws(() => loadPty({ load: () => { throw problem; } }), error => {
    assert.match(error.message, /node-pty.*couldn't load/);
    assert.match(error.message, /npm approve-scripts node-pty/);
    assert.match(error.message, /npm rebuild node-pty/);
    assert.match(error.message, /--allow-scripts=node-pty/);
    assert.equal(error.cause, problem);
    return true;
  });
  const pty = { spawn() {} };
  assert.equal(loadPty({ load: () => pty }), pty);
});


test("server startup reports the native-binding repair before opening a listener", () => {
  const entry = new URL('../server/index.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import Module from 'node:module';
    const original = Module._load;
    Module._load = function(name, ...args) {
      if (name === 'node-pty') throw Error('fixture native binding absent');
      return original.call(this, name, ...args);
    };
    await import(${JSON.stringify(entry)});
  `], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /node-pty couldn't load/);
  assert.match(result.stderr, /npm approve-scripts node-pty/);
});
