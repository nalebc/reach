import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { cleanPreload } from "./helpers/clean-machine.mjs";
import { fakeTailscale } from "./helpers/fake-tailscale.mjs";
const exec = promisify(execFile);

// Opt in with the archive made by verify:package. This is the real first
// launch: no node_modules, setup stamp or git checkout is carried over.
test("portable archive: first launch installs and builds, serves the phone, and update names the archive", {
  skip: process.platform === "win32" || !process.env.REACH_TEST_PORTABLE_ARCHIVE,
  timeout: 540000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-portable-install-"));
  let child, exited;
  const home = path.join(root, "home"), state = path.join(root, "state");
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      // The launcher supervises bootstrap, which owns the lock. End only
      // this fixture's bootstrap, never a process found on the host.
      try {
        const lock = JSON.parse(await fs.readFile(path.join(state, "launcher.lock"), "utf8"));
        process.kill(lock.pid, "SIGTERM");
      } catch { child.kill("SIGTERM"); }
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await fs.mkdir(home);
  const fake = await fakeTailscale(root);
  await exec("tar", ["-xzf", path.resolve(process.env.REACH_TEST_PORTABLE_ARCHIVE), "-C", root]);
  const app = path.join(root, "reach");
  await assert.rejects(fs.access(path.join(app, "node_modules")));
  await assert.rejects(fs.access(path.join(app, ".git")));
  // No host process inventory, GUI launches, or login shell profiles.
  const preload = path.join(root, "isolated.mjs"), shell = path.join(root, "no-shell");
  await fs.writeFile(shell, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  await fs.writeFile(preload, `import cp from 'node:child_process'; import { syncBuiltinESMExports } from 'node:module';
    const run = cp.execFileSync;
    cp.execFileSync = (file, ...args) => file === '/bin/ps' ? '' : run(file, ...args);
    syncBuiltinESMExports();`);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("REACH_"))),
    HOME: home, SHELL: shell, REACH_HOME: state, REACH_DATA: path.join(state, "quick"),
    REACH_TAILSCALE: fake.cli, REACH_SUPERVISED: "1",
    NODE_OPTIONS: ["--import", cleanPreload, "--import", preload].map(value => JSON.stringify(value)).join(" "),
    npm_config_cache: path.join(root, "npm-cache"), npm_config_update_notifier: "false",
  };
  // Exercise update before the expensive first launch; no network needed.
  const update = await exec("/bin/sh", [path.join(app, "reach"), "update"], { cwd: app, env, timeout: 10000 });
  assert.match(update.stdout, /portable archive/i);
  assert.doesNotMatch(update.stdout, /git pull/);
  child = spawn("/bin/sh", [path.join(app, "reach"), "--local", "--no-stay-awake", "--folder", home], { cwd: app, env, stdio: ["ignore", "pipe", "pipe"] });
  exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", data => { output += data; });
  child.stderr.on("data", data => { output += data; });
  // npm ci fills an empty cache from the registry: usually under a minute,
  // but a slow registry stretched it past 3.5 min in the 0.1.1 PR. A hang still fails.
  for (const until = Date.now() + 480000; !/Pairing code: \d{4} \d{4}/.test(output);) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > until) {
      const log = await fs.readFile(path.join(state, "setup.log"), "utf8").catch(() => "");
      assert.fail(`Portable first launch did not become ready:\n${output.slice(-3000)}\n${log.slice(-3000)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const status = JSON.parse(await fs.readFile(path.join(state, "host-status.json"), "utf8"));
  const page = await fetch(status.localUrl);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), await fs.readFile(path.join(app, "dist/index.html"), "utf8"));
  const stamp = JSON.parse(await fs.readFile(path.join(state, "setup.json"), "utf8"));
  assert.ok(stamp.dependencies && stamp.source && stamp.agent);
  await fs.access(path.join(app, "node_modules", "typescript", "package.json"));
  const log = await fs.readFile(path.join(state, "setup.log"), "utf8");
  assert.match(log, /vite.*build|building for production/i);
  assert.equal((await fake.read()).calls.length, 0, "local first launch never configures Tailscale");
});
