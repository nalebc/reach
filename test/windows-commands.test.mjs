import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { stopReach } from "../scripts/stop.mjs";
import { startCleanReach } from "./helpers/clean-machine.mjs";
import { fakeTailscale, tailnetPreload, HOST } from "./helpers/fake-tailscale.mjs";

// First-run matrix H20, wired end to end: a real Reach that takes its Windows
// paths (test/helpers/as-windows.mjs), `.\reach.cmd status` naming it, and
// `stop` asking it through the file it watches, so it stops itself as Ctrl+C
// stops it. Real processes; only process.platform is Windows. Stopping goes
// through stopReach with platform "win32" and no process list, so it can never
// reach a Reach that really runs on this computer.
const AS_WINDOWS = pathToFileURL(path.resolve("test/helpers/as-windows.mjs")).href;

function windowsReach(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-as-windows-"));
  const state = path.join(dir, "state");
  fs.mkdirSync(path.join(dir, "share"));
  const env = { ...process.env, REACH_HOME: state, REACH_DATA: path.join(state, "quick") };
  const entry = pathToFileURL(path.resolve("scripts/launch.mjs")).href;
  const child = spawn(
    process.execPath,
    [
      "--import",
      AS_WINDOWS,
      "--input-type=module",
      "-e",
      `import { launch } from ${JSON.stringify(entry)}; await launch({ local: true, folders: [${JSON.stringify(path.join(dir, "share"))}], port: 0 }, ${JSON.stringify(dir)}); console.log("REACH ENDED");`,
    ],
    { env, stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const statusFile = path.join(state, "host-status.json");
  const ready = async () => {
    for (const until = Date.now() + 20000; !fs.existsSync(statusFile); ) {
      if (child.exitCode !== null || Date.now() > until) throw Error(`Reach did not start:\n${output}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  return { dir, state, env, child, exited, statusFile, ready, output: () => output };
}

const status = (env) =>
  new Promise((resolve, reject) =>
    execFile(process.execPath, ["--import", AS_WINDOWS, "scripts/bootstrap.mjs", "status"], { env, timeout: 20000 }, (error, stdout, stderr) =>
      error ? reject(Object.assign(error, { stderr })) : resolve(stdout.trim()),
    ),
  );

test("Windows, wired: status names the running Reach; stop asks it through its file and it stops itself", { timeout: 60000 }, async (t) => {
  const reach = windowsReach(t);
  await reach.ready();
  // A Windows Reach approves phones with a pairing code (T23).
  assert.match(reach.output(), /Pairing code: \d{4} \d{4}/);
  const host = JSON.parse(fs.readFileSync(reach.statusFile, "utf8"));
  assert.equal(host.pid, reach.child.pid);
  assert.ok(Number.isFinite(host.startedAt), "it says when it started");
  // `.\reach.cmd status`, through the real launcher.
  assert.match(
    await status(reach.env),
    new RegExp(`^Reach: running in a terminal \\(process ${reach.child.pid}\\), since [^\\n]+\\nLink: http://127\\.0\\.0\\.1:\\d+$`),
  );
  const killed = [];
  const result = await stopReach(reach.dir, {
    platform: "win32",
    yes: true,
    print() {},
    state: () => reach.state,
    table: () => [],
    launchctl: () => "",
    windows: { taskkill: (pid) => killed.push(pid) },
  });
  const [code] = await reach.exited;
  assert.equal(result.stopped, 1);
  assert.deepEqual(killed, [], "it stopped itself; nothing was ended");
  assert.equal(code, 0, "stopped as Ctrl+C stops it");
  assert.match(reach.output(), /REACH ENDED/);
  assert.equal(fs.existsSync(reach.statusFile), false, "its status goes with it");
  assert.equal(fs.existsSync(path.join(reach.state, "stop-request.json")), false);
  // And now it isn't running, as status says.
  assert.equal(await status(reach.env), "Reach isn't running from this folder. Start it with .\\reach.cmd.");
});

// First-run matrix T23, in Tailscale mode: a Windows Reach, through a
// stand-in Tailscale (this computer's own is never asked or changed). Its
// route goes to its local address (no Unix socket there), phones join with
// the pairing code, and it opens no public link.
// (The stand-in Tailscale is a #! script: not on a real Windows runner.)
test("Windows, Tailscale mode: the private link to its local address, and a pairing code; no socket, no public link", { skip: process.platform === "win32", timeout: 60000 }, async (t) => {
  let fake;
  const reach = await startCleanReach(t, {
    args: { local: false, stayAwake: false },
    preloads: [AS_WINDOWS],
    // The guidance is printed after the pairing code in a separate stdout
    // write. Wait for the line we assert, not an earlier output chunk.
    ready: /Private Tailscale link · Connect Tailscale on your phone first/,
    pair: false,
    prepare: async (root) => {
      fake = await fakeTailscale(root);
      return { env: { REACH_TAILSCALE: fake.cli }, preloads: [tailnetPreload(fake.state)] };
    },
  });
  const text = reach.output();
  assert.match(text, new RegExp(`Open on your phone: https://${HOST.replace(/\./g, "\\.")}:8443\\n`));
  assert.match(text, /Pairing code: \d{4} \d{4}/);
  assert.match(text, /Private Tailscale link · Connect Tailscale on your phone first/);
  const state = await fake.read();
  const route = state.serve.Web[`${HOST}:8443`].Handlers["/"].Proxy;
  assert.match(route, /^http:\/\/127\.0\.0\.1:\d+$/, "its local address, not a socket");
  assert.ok(!state.calls.some(([command]) => command === "funnel"), "no public link on Windows");
  assert.ok(!state.calls.some((args) => args.some((a) => String(a).startsWith("unix:"))));
});


test("Windows: an occupied launcher lock names restart without starting anything", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "reach-lock-windows-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = path.join(home, "state");
  fs.mkdirSync(state);
  const lock = path.join(state, "launcher.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const result = await new Promise(resolve => execFile(process.execPath,
    ["--import", AS_WINDOWS, "scripts/bootstrap.mjs", "--local"],
    { env: { ...process.env, HOME: home, REACH_HOME: state, REACH_DATA: path.join(state, "quick"), REACH_COMMAND: "" }, timeout: 10000 },
    (error, stdout, stderr) => resolve({ error, text: stdout + stderr })));
  assert.equal(result.error?.code, 1);
  assert.match(result.text, /already starting or running/);
  assert.ok(result.text.includes(".\\reach.cmd restart"), result.text);
  assert.equal(JSON.parse(fs.readFileSync(lock)).pid, process.pid);
});

test("Windows: service guidance uses the active command, and related hints have no hard-coded launcher", async () => {
  const result = await new Promise((resolve, reject) => execFile(process.execPath,
    ["--import", AS_WINDOWS, "--input-type=module", "-e", `
      import { privateNodePath } from './scripts/background-service.mjs';
      try { privateNodePath('/missing-reach-fixture'); } catch (error) { console.log(error.message); }
    `], { env: { ...process.env, REACH_COMMAND: "" }, timeout: 10000 },
    (error, stdout) => error ? reject(error) : resolve(stdout)));
  assert.ok(result.includes(".\\reach.cmd install"), result);
  for (const name of ["invites", "stop", "background-service", "link"]) {
    const source = fs.readFileSync(`scripts/${name}.mjs`, "utf8").split("\n").filter(line => !line.trimStart().startsWith("//")).join("\n");
    assert.doesNotMatch(source, /\.\/reach(?: |\.)|["` ]reach (?:link|setup|restart)/, name);
  }
});
