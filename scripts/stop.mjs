import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { parseLaunchStatus, serviceLabel } from "./background-service.mjs";
import { loginScript } from "./login-start.mjs";
import { handoffPersistentRoute } from "./persistent-serve.mjs";

// `reach stop` / `reach restart`: every Reach running on this computer (one
// should; any folder), in a terminal tab, started detached, or the background
// service, stops the way
// Ctrl+C stops it (its terminals and jobs end with it), then any helper it
// left behind. Restart starts it again: the background service if that's how
// it ran, otherwise right here in this terminal.

// The processes and every Reach among them (instances.mjs): one Reach per
// computer, so stop and restart reach it whichever folder it came from.
import { processTable, reachHosts, stateOf } from "./instances.mjs";
export { processTable };
// Every Reach running (never this command itself); `root` limits it to one folder's.
export const findReach = (root, table, self = process.pid) => reachHosts(table, { self, root });

// The background service (./reach install), and whether it's this folder's.
export function serviceState(root, { run, home = os.homedir(), uid = process.getuid?.() } = {}) {
  const plist = path.join(home, "Library/LaunchAgents", `${serviceLabel}.plist`);
  const installed = fs.existsSync(plist);
  const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const ours = installed && fs.readFileSync(plist, "utf8").includes(`<key>WorkingDirectory</key><string>${xml(root)}</string>`);
  let loaded = false;
  let pid = null;
  try {
    const status = parseLaunchStatus(run(["print", `gui/${uid}/${serviceLabel}`]));
    loaded = true;
    pid = status.pid || null;
  } catch {
    /* not loaded */
  }
  return { installed, ours, loaded, pid, plist, target: `gui/${uid}/${serviceLabel}`, domain: `gui/${uid}` };
}

const alive = (kill, pid) => {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

export async function stopReach(
  root,
  {
    yes = false,
    restarting = false,
    interactive = !!process.stdin.isTTY,
    print = console.log,
    ask = async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    table = () => processTable(),
    launchctl = (args) => execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    kill = (pid, signal) => process.kill(pid, signal),
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    self = process.pid,
    home,
    uid,
    platform = process.platform,
    graceMs = 15000,
    termMs = 5000,
    state = stateOf,
    handoffRoute = handoffPersistentRoute,
  } = {},
) {
  const hosts = findReach(null, table(), self);
  const service = platform === "darwin" ? serviceState(root, { run: launchctl, home, uid }) : { loaded: false, ours: false };
  // Reach's one background service, whichever folder installed it.
  const serviceRunning = service.loaded;
  if (!hosts.length && !serviceRunning) {
    if (!restarting) print("Reach isn't running.");
    return { stopped: 0, service: false, terminals: 0, serviceInstalled: !!service.ours };
  }
  // What closes with it: said first, and asked about.
  const terminals = hosts.flatMap((h) => h.terminals);
  if (terminals.length && !yes) {
    print(
      `These terminals in Reach close with it:\n${terminals
        .map((t) => `  ${t.shell}${t.running.length ? ` (running ${t.running.join(", ")})` : ""}`)
        .join("\n")}`,
    );
    if (!interactive)
      throw Error(`Reach has ${terminals.length} terminal${terminals.length > 1 ? "s" : ""} open. Run again with --yes to close them too.`);
    const answer = await ask(`${restarting ? "Restart" : "Stop"} Reach anyway? [y/N] `);
    if (!/^y(es)?$/i.test(String(answer).trim())) {
      print("Nothing was stopped.");
      return { cancelled: true, stopped: 0, service: false, terminals: 0 };
    }
  }
  // The background service goes through launchd (it would come back
  // otherwise); a restart starts it again in one step.
  const serviceHost = (h) => serviceRunning && (h.service || h.pid === service.pid);
  if (serviceRunning) launchctl(restarting ? ["kickstart", "-k", service.target] : ["bootout", service.target]);
  // The others the way Ctrl+C stops them; harder only if they hang.
  const others = hosts.filter((h) => !serviceHost(h));
  for (const host of others)
    try {
      kill(host.pid, "SIGINT");
    } catch {}
  const waitGone = async (pids, ms) => {
    for (const until = Date.now() + ms; pids.some((pid) => alive(kill, pid)) && Date.now() < until; ) await wait(200);
    return pids.filter((pid) => alive(kill, pid));
  };
  // A stopped service exits on launchd's word; it's waited for too.
  const gone = restarting ? others : hosts;
  const hostPids = gone.map((h) => h.pid);
  let left = await waitGone(hostPids, graceMs);
  for (const pid of left)
    try {
      kill(pid, "SIGTERM");
    } catch {}
  left = await waitGone(left, termMs);
  for (const pid of left)
    try {
      kill(pid, "SIGKILL");
    } catch {}
  // Helpers a stopped Reach left running (its tunnel, stay-awake, …).
  const leftovers = gone.flatMap((h) => h.descendants.map((d) => d.pid)).filter((pid) => alive(kill, pid));
  for (const pid of leftovers)
    try {
      kill(pid, "SIGTERM");
    } catch {}
  for (const pid of await waitGone(leftovers, 2000))
    try {
      kill(pid, "SIGKILL");
    } catch {}
  if (restarting && !serviceRunning) {
    if ((await waitGone(hostPids, 2000)).length)
      throw Error("Reach did not stop. Its route was not transferred; try again after it exits.");
    const file = path.join(state(root), "serve-owner.json");
    const sources = [...new Set(others.flatMap((host) =>
      // The caller's REACH_HOME may be a new destination. Also inspect the
      // old checkout's default state; handoff verifies exact route ownership.
      [state(host.root), state(host.root, undefined, {})].map((dir) => path.join(dir, "serve-owner.json")),
    ))];
    await handoffRoute({ file, sources });
  }
  const stopped = others.length;
  if (serviceRunning && !restarting)
    print("The background service stopped; it starts again at your next sign-in, or with ./reach restart.");
  if (stopped) print(`Stopped ${stopped === 1 ? "Reach" : `${stopped} Reaches`}${terminals.length ? ` and ${terminals.length} terminal${terminals.length > 1 ? "s" : ""} in it` : ""}.`);
  return { stopped, service: serviceRunning, terminals: terminals.length, serviceInstalled: !!service.ours };
}

// The background service started again (stopped earlier, still installed).
export function startService(root, { launchctl = (args) => execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), home, uid } = {}) {
  const service = serviceState(root, { run: launchctl, home, uid });
  if (!service.ours) throw Error("Reach's background service isn't installed from this folder.");
  if (service.loaded) launchctl(["kickstart", "-k", service.target]);
  else launchctl(["bootstrap", service.domain, service.plist]);
}

// Reach started where it keeps its permissions: Terminal holds Reach's Screen
// Recording and Accessibility, and gives device approvals a place. Asked for
// without a terminal (an agent's restart), it opens one, as at sign-in.
// `args`: what it runs (`restart --yes` once you allowed an agent's restart).
export function startInTerminal(root, { state, args = "", env = process.env, nodeDir = path.dirname(process.execPath), open = (file) => execFileSync("/usr/bin/open", ["-a", "Terminal", file]) } = {}) {
  const file = path.join(state, "start-in-terminal.command");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, loginScript(root, nodeDir, { args, env, restart: true }), { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  open(file);
  return file;
}
