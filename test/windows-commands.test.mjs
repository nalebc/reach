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
  // "close", not "exit": only then has all it printed arrived here.
  const exited = once(child, "close");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const statusFile = path.join(state, "host-status.json");
  // Ready once it both noted itself and printed its pairing code. The file
  // and the pipe are separate channels: the file can be seen before the
  // printed lines arrive here (macOS), so wait for the line we assert too.
  const ready = async () => {
    for (const until = Date.now() + 20000; !fs.existsSync(statusFile) || !/Pairing code: \d{4} \d{4}/.test(output); ) {
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
const tailscaleWindows = { skip: process.platform === "win32", timeout: 60000 };
const ORIGIN = `https://${HOST}:8443`;
const backgroundRoute = (target) => ({ TCP: { 8443: { HTTPS: true } }, Web: { [`${HOST}:8443`]: { Handlers: { "/": { Proxy: target } } } } });
// `serve` and `record`: what an earlier Reach or another service left.
function windowsTailscaleReach(t, { serve, record } = {}) {
  const seen = {};
  const started = startCleanReach(t, {
    args: { local: false, stayAwake: false },
    preloads: [AS_WINDOWS],
    // The guidance is printed after the pairing code in a separate stdout
    // write. Wait for the line we assert, not an earlier output chunk.
    ready: /No public internet tunnel is enabled/,
    pair: false,
    prepare: async (root) => {
      seen.root = root;
      seen.fake = await fakeTailscale(root, serve ? { serve } : {});
      if (record) {
        fs.mkdirSync(path.join(root, ".reach"), { recursive: true });
        fs.writeFileSync(path.join(root, ".reach", "serve-owner.json"), JSON.stringify({ version: 1, ...record }));
      }
      return { env: { REACH_TAILSCALE: seen.fake.cli }, preloads: [tailnetPreload(seen.fake.state)] };
    },
  });
  return { seen, started };
}
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (check, what, ms = 10000) => {
  for (const end = Date.now() + ms; !(await check()); ) {
    if (Date.now() > end) throw Error(`timed out waiting: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
// Its one route on the port: a foreground session (held by its own
// `tailscale serve`, no --bg), never a background route left in Tailscale.
const heldRoute = async (fake) => {
  const state = await fake.read();
  assert.equal(state.serve.TCP?.[8443], undefined, "no background route");
  assert.equal(state.serve.Web?.[`${HOST}:8443`], undefined, "no background route");
  assert.ok(!state.calls.some((args) => args.includes("--bg")), "no --bg on Windows");
  const sessions = await fake.sessions();
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  const target = session.config.Web[`${HOST}:8443`].Handlers["/"].Proxy;
  assert.deepEqual(session.args, ["serve", "--https=8443", target]);
  assert.match(target, /^http:\/\/127\.0\.0\.1:\d+$/, "its local address, not a socket");
  return session;
};
const routeGone = async (fake, session) => {
  await until(async () => !(await fake.sessions()).length && !pidAlive(session.pid), "the session to end with Reach");
  const state = await fake.read();
  assert.equal(state.serve.Foreground, undefined);
  assert.equal(state.serve.TCP?.[8443], undefined, "nothing left behind on the port");
  assert.ok(!state.calls.some((args) => args.includes("--bg")));
};

test("Windows, Tailscale mode: the private link to its local address, and a pairing code; no socket, no public link", tailscaleWindows, async (t) => {
  const { seen, started } = windowsTailscaleReach(t);
  const reach = await started;
  const text = reach.output();
  assert.ok(text.includes(`Open on your phone: https://${HOST}:8443\n`), text);
  assert.match(text, /Pairing code: \d{4} \d{4}/);
  // What the phone needs comes before the code and its QR, where a first-time
  // user looks (Oct 11: scanned without the app, "can't connect"), with the
  // account to sign in as and why the browser can't do it here.
  const first = text.indexOf("First, on your phone: install the Tailscale app, sign in as ");
  assert.ok(first > 0 && first < text.indexOf("Code works once"), text);
  assert.match(text, /sign in as \S+@\S+ and turn it on\.\n  On Windows, phones can't sign in from the browser yet\./);
  assert.match(text, /Private Tailscale link: only your Tailscale devices open it/);
  const session = await heldRoute(seen.fake);
  const state = await seen.fake.read();
  assert.ok(!state.calls.some(([command]) => command === "funnel"), "no public link on Windows");
  assert.ok(!state.calls.some((args) => args.some((a) => String(a).startsWith("unix:"))));
  // `stop`, through its file: the route ends with Reach.
  const killed = [];
  const result = await stopReach(seen.root, {
    platform: "win32",
    yes: true,
    print() {},
    state: () => path.join(seen.root, ".reach"),
    table: () => [],
    launchctl: () => "",
    windows: { taskkill: (pid) => killed.push(pid) },
  });
  const [code] = await reach.exited;
  assert.equal(result.stopped, 1);
  assert.deepEqual(killed, [], "it stopped itself");
  assert.equal(code, 0);
  await routeGone(seen.fake, session);
});

test("Windows, Tailscale mode: Reach ended outright (a crash), its route ends too; while it runs, a lost route comes back", tailscaleWindows, async (t) => {
  const { seen, started } = windowsTailscaleReach(t);
  const reach = await started;
  const first = await heldRoute(seen.fake);
  // Its `tailscale serve` ends by itself: Reach holds the route again.
  process.kill(first.pid, "SIGKILL");
  await until(async () => (await seen.fake.sessions()).some((s) => s.pid !== first.pid), "a new session", 40000);
  const second = await heldRoute(seen.fake);
  assert.match(reach.output(), /Private Tailscale connection restored|Private link interrupted/);
  // No stop, no cleanup: the process is gone at once.
  reach.child.kill("SIGKILL");
  await reach.exited;
  await routeGone(seen.fake, second);
});

test("Windows, Tailscale mode: an older Reach's background route, recorded as its own, is replaced by the foreground one", tailscaleWindows, async (t) => {
  const old = "http://127.0.0.1:1";
  const { seen, started } = windowsTailscaleReach(t, { serve: backgroundRoute(old), record: { origin: ORIGIN, target: old } });
  await started;
  const state = await seen.fake.read();
  assert.deepEqual(state.calls.filter(([command, flag]) => command === "serve" && flag === "--https=8443")[0], ["serve", "--https=8443", "off"], "switched off first");
  const session = await heldRoute(seen.fake);
  assert.notEqual(session.config.Web[`${HOST}:8443`].Handlers["/"].Proxy, old);
  assert.equal(fs.existsSync(path.join(seen.root, ".reach", "serve-owner.json")), false, "nothing left to record");
});

test("Windows, Tailscale mode: someone else's route on the port still refuses to start, and is left alone", tailscaleWindows, async (t) => {
  const theirs = backgroundRoute("http://127.0.0.1:3000");
  // Even beside a record of Reach's own (another target): not Reach's route.
  const { seen, started } = windowsTailscaleReach(t, { serve: theirs, record: { origin: ORIGIN, target: "http://127.0.0.1:1" } });
  await assert.rejects(started, /Tailscale port 8443 is already in use/);
  const state = await seen.fake.read();
  assert.deepEqual(state.serve, theirs, "never replaced");
  assert.ok(!state.calls.some(([command, ...rest]) => (command === "serve" || command === "funnel") && rest[0] !== "status" && rest[0] !== "--help"), "nothing changed in Tailscale");
  assert.deepEqual(await seen.fake.sessions(), []);
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
