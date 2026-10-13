import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { fakeTailscale } from "./helpers/fake-tailscale.mjs";
const exec = promisify(execFile);

test("npm 12 on Linux: blocked node-pty explains repair and an explicitly approved rebuild starts a terminal", {
  skip: process.platform !== "linux" || process.env.REACH_TEST_NPM12_INSTALL !== "1",
  timeout: 180000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-npm12-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = path.join(root, "home"), prefix = path.join(root, "prefix");
  await fs.mkdir(home);
  const fake = await fakeTailscale(root);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("REACH_") && !key.toLowerCase().startsWith("npm_config_"))),
    HOME: home, REACH_HOME: path.join(root, "state"), REACH_DATA: path.join(root, "state", "quick"),
    REACH_TAILSCALE: fake.cli, npm_config_cache: path.join(root, "npm-cache"), npm_config_update_notifier: "false",
  };
  const npm = args => exec(process.execPath, [process.env.npm_execpath, ...args], { cwd: root, env, timeout: 120000, maxBuffer: 4 << 20 });
  assert.match((await npm(["--version"])).stdout, /^12\./);
  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  const artifact = path.resolve("release", `nalebc-reach-${pkg.version}.tgz`);
  await npm(["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", artifact]);
  const installed = path.join(prefix, "lib/node_modules/@nalebc/reach");
  const entry = pathToFileURL(path.join(installed, "server/terminal.mjs")).href;
  const probe = code => exec(process.execPath, ["--input-type=module", "-e", code], { cwd: root, env, timeout: 20000, maxBuffer: 1 << 20 });
  await assert.rejects(probe(`await import(${JSON.stringify(entry)});`), error => {
    assert.match(error.stderr, /node-pty couldn't load/);
    assert.match(error.stderr, /--allow-scripts=node-pty/);
    return true;
  });
  // Test-only approval, not a change to the project's install policy.
  await npm(["rebuild", "--global", "--prefix", prefix, "--allow-scripts=node-pty", "node-pty"]);
  const result = await probe(`
    import assert from 'node:assert/strict';
    const { Terminals } = await import(${JSON.stringify(entry)});
    const terminals = new Terminals();
    const info = terminals.create({ cwd: process.cwd(), name: 'fixture', clientId: 'fixture', command: "printf 'NPM12_TERMINAL_OK\\\\n'; exit 0" });
    const session = terminals.get(info.id);
    const timer = setTimeout(() => process.exit(1), 10000);
    await session.ended;
    clearTimeout(timer);
    assert.equal(session.exitCode, 0);
    assert.match(session.buffer, /NPM12_TERMINAL_OK/);
    console.log('terminal ready');
  `);
  assert.match(result.stdout, /terminal ready/);
  assert.deepEqual((await fake.read()).calls, []);
});
