import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { alreadyRunning, describe, reachHosts, stateOf, statusText, whereItRuns, withoutHandover } from "../scripts/instances.mjs";

// One Reach per computer. Agents restarted Reach in the background three times
// in a day (no window: no screen permissions, no device approvals), and the
// user's own ./reach then said only "already starting or running from this
// folder". Every Reach is found from the process list, whatever its folder,
// and a second start says where the first runs and what to do.
const HOME = "/Users/me";
const node = "/opt/homebrew/bin/node";
const table = [
  { pid: 10, ppid: 5, tty: "ttys007", command: `${node} ${HOME}/reach/scripts/bootstrap.mjs` },
  { pid: 11, ppid: 10, tty: "ttys007", command: "tailscale serve --https=8443 unix:/tmp/s" },
  { pid: 20, ppid: 1, tty: "??", command: `${node} ${HOME}/My Projects/reach copy/scripts/bootstrap.mjs --port 4318` },
  { pid: 30, ppid: 1, tty: "??", command: `${node} /usr/local/lib/node_modules/@nalebc/reach/bin/reach.mjs --service` },
  { pid: 40, ppid: 9, tty: "ttys009", command: `${node} ${HOME}/reach/scripts/bootstrap.mjs approve` },
  { pid: 50, ppid: 9, tty: "ttys009", command: `${node} ${HOME}/reach/scripts/bootstrap.mjs status` },
  { pid: 60, ppid: 9, tty: "ttys009", command: `${node} ${HOME}/reach/scripts/bootstrap.mjs --background --port 4318` },
  { pid: 70, ppid: 9, tty: "ttys009", command: `${node} /usr/local/lib/node_modules/@nalebc/reach/bin/reach.mjs -v` },
];
const exists = (p) => p.startsWith("/");

test("every Reach running, whatever its folder (spaces too), and how it runs; commands beside them are not Reaches", () => {
  const hosts = reachHosts(table, { self: 50, exists });
  assert.deepEqual(hosts.map((h) => [h.pid, h.root]), [
    [10, `${HOME}/reach`],
    [20, `${HOME}/My Projects/reach copy`],
    [30, "/usr/local/lib/node_modules/@nalebc/reach"],
  ]);
  assert.deepEqual(hosts.map(whereItRuns), [
    "in a Terminal window (ttys007)",
    "in the background, with no window",
    "as the background service",
  ]);
  assert.deepEqual(hosts[0].descendants.map((d) => d.pid), [11]);
});

test("a second start says where Reach runs and what to run instead", () => {
  const [terminal, hidden] = reachHosts(table, { self: 50, exists });
  const started = new Map([[terminal.pid, new Date(2026, 9, 5, 18, 9).getTime()]]);
  const now = new Date(2026, 9, 5, 19, 0).getTime();
  const one = alreadyRunning([terminal], { command: "reach", started, now, dir: HOME });
  assert.match(one, /^already running in a Terminal window \(ttys007\), since [^,]*:09[^,]*, from ~\/reach\./);
  assert.match(one, /Use that window, or:/);
  assert.match(one, /reach restart +stop it and start Reach here/);
  assert.match(one, /reach stop +stop it/);
  // Hidden in the background: what that costs.
  assert.match(alreadyRunning([hidden], { dir: HOME }), /With no window it can't show or control your screen/);
  // Two at once: all listed, and how to end up with one.
  const two = alreadyRunning([terminal, hidden], { command: "reach", dir: HOME });
  assert.match(two, /^2 copies are running:\n {2}· in a Terminal window[^\n]*\n {2}· in the background, with no window, from ~\/My Projects\/reach copy\nOnly one should run\. Run reach stop/);
});

test("reach status tells what really runs, with its link", { skip: process.platform === "win32" ? "POSIX process discovery" : false }, () => {
  const hosts = reachHosts(table, { self: 50, exists });
  const runtime = () => ({ link: "https://mac.tail.ts.net", awake: { mode: "always", active: true } });
  const text = statusText([hosts[0]], { command: "reach", dir: HOME, runtime });
  assert.equal(text, "Reach: running in a Terminal window (ttys007), from ~/reach\nLink: https://mac.tail.ts.net\nSleep prevention: always · active");
  // Its routes: the private one phones use (and how often it dropped), the public one.
  const now = new Date(2026, 9, 5, 19, 0).getTime();
  const routes = { private: { up: true, since: new Date(2026, 9, 5, 18, 9).getTime(), interruptions: 2 }, public: { open: true, since: new Date(2026, 9, 5, 18, 20).getTime() } };
  assert.match(
    statusText([hosts[0]], { dir: HOME, now, runtime: () => ({ link: "https://mac.tail.ts.net", routes }) }),
    /\nLink: https:\/\/mac\.tail\.ts\.net\nPrivate route: up since [^\n]*:09[^\n]* · 2 interruptions\nPublic link: on since [^\n]*:20[^\n]*, blocked until an invite$/,
  );
  assert.match(
    statusText([hosts[0]], { dir: HOME, runtime: () => ({ routes: { private: { up: false, since: 0, interruptions: 0 }, public: { open: false, since: 0 } } }) }),
    /\nPrivate route: down\nPublic link: off$/,
  );
  assert.match(statusText([hosts[1]], { dir: HOME, runtime: () => ({}) }), /It has no window/);
  assert.match(statusText(hosts, { dir: HOME, runtime: () => ({}) }), /3 copies are running; only one should\./);
  assert.equal(statusText([], { command: "reach" }), "Reach isn't running. Start it with reach.");
  assert.equal(describe(hosts[2], { dir: HOME }), "as the background service, from /usr/local/lib/node_modules/@nalebc/reach");
  // The service writes to files: where they are (an npm install keeps them in ~/.reach).
  assert.match(
    statusText([hosts[2]], { dir: HOME, runtime: () => ({}), state: () => `${HOME}/.reach` }),
    /\nLogs: ~\/\.reach\/logs$/,
  );
  assert.equal(stateOf("/opt/reach", () => false), path.join(os.homedir(), ".reach"));
  assert.equal(stateOf("/src/reach", () => true), "/src/reach/.reach");
});

test("a Reach handing itself to the background service doesn't stop that service from starting", () => {
  // First-run setup picks background mode: ./reach installs the service and
  // stays open until the phone connects. The service must start anyway.
  const hosts = reachHosts(table, { self: 50, exists });
  const files = { [path.join("/state", "handover.pid")]: "10" };
  const read = (f) => {
    if (!(f in files)) throw Object.assign(Error("missing"), { code: "ENOENT" });
    return files[f];
  };
  assert.deepEqual(withoutHandover(hosts, "/state", read).map((h) => h.pid), [20, 30]);
  assert.deepEqual(withoutHandover(hosts, "/elsewhere", read).map((h) => h.pid), [10, 20, 30]);
});

test("a reach restart run in a terminal is the running Reach once it holds its folder's lock", () => {
  // `reach restart` without the service starts Reach in the same process:
  // reach status and reach stop missed it ("Reach isn't running").
  const t = [
    { pid: 70, ppid: 9, tty: "ttys000", command: `${node} ${HOME}/reach/scripts/bootstrap.mjs restart` },
    { pid: 71, ppid: 70, tty: "ttys000", command: "caffeinate -d -i -s" },
  ];
  const hosts = (holder) => reachHosts(t, { self: 1, exists, locked: () => holder });
  // Still stopping the old one (or building): not yet a Reach.
  assert.deepEqual(hosts(null), []);
  // Holding the lock: it is the running Reach, with what it started.
  const [h] = hosts(70);
  assert.equal(h.pid, 70);
  assert.equal(whereItRuns(h), "in a Terminal window (ttys000)");
  assert.deepEqual(h.descendants.map((d) => d.pid), [71]);
});
