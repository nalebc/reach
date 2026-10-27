import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

// Oct 26, a physical iPhone: after the phone sat idle, the Reach app showed a
// blank white page until it was closed and opened again. iOS ends a web
// page's process to free memory while an app is idle; Capacitor reloads the
// page then, and a reload that finds no network leaves nothing on screen.
// Here, in a real simulator with the real app: the computer stops answering,
// the page's process is ended, and once the computer answers again the app
// opens Reach's page by itself. (Simulator only: a physical iPhone isn't run.)
const exec = promisify(execFile);
const app = process.env.REACH_TEST_IOS_APP;
const runtimeVersion = process.env.REACH_TEST_IOS_RUNTIME;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const simctl = (args, timeout = 120000) => exec("xcrun", ["simctl", ...args], { timeout, maxBuffer: 16 * 1024 * 1024 });

test("the app opens Reach's page again by itself after iOS ends it while the computer can't be reached", {
  skip: process.platform !== "darwin" || !app ? "needs macOS and REACH_TEST_IOS_APP (a simulator build)" : false,
  timeout: 600000,
}, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-ios-recovery-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  // The computer: Reach's page, which says when it's up. Down, it drops
  // every connection, as an unreachable network does.
  let down = false;
  const loads = [], alive = [], refused = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/alive") {
      alive.push(Date.now());
      return res.writeHead(204).end();
    }
    if (url.pathname !== "/") return res.writeHead(404).end();
    loads.push(Date.now());
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end('<!doctype html><meta name="viewport" content="width=device-width"><body><div id="root">Reach</div><script>fetch("/alive?" + Date.now())</script></body>');
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    if (down) {
      refused.push(Date.now());
      return socket.destroy();
    }
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;

  // The real app, opening this computer.
  const copy = path.join(dir, "App.app");
  await fs.cp(app, copy, { recursive: true });
  const configFile = path.join(copy, "capacitor.config.json");
  const config = JSON.parse(await fs.readFile(configFile, "utf8"));
  config.server = { url: origin, cleartext: true };
  await fs.writeFile(configFile, JSON.stringify(config));
  const plist = path.join(copy, "Info.plist");
  await exec("/usr/libexec/PlistBuddy", ["-c", "Add :NSAppTransportSecurity dict", plist]).catch(() => {});
  await exec("/usr/libexec/PlistBuddy", ["-c", "Add :NSAppTransportSecurity:NSAllowsArbitraryLoadsInWebContent bool true", plist]).catch(() => {});
  const bundle = (await exec("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist])).stdout.trim();
  await exec("codesign", ["--force", "--deep", "--sign", "-", "--preserve-metadata=entitlements,flags,runtime", "--generate-entitlement-der", copy], { timeout: 60000 });

  const runtimes = JSON.parse((await simctl(["list", "runtimes", "--json"])).stdout).runtimes
    .filter((r) => r.isAvailable && r.platform === "iOS" && (!runtimeVersion || r.version.startsWith(runtimeVersion)));
  const runtime = runtimes.at(-1);
  assert.ok(runtime, `an iOS ${runtimeVersion || ""} simulator runtime`);
  const type = runtime.supportedDeviceTypes?.find((d) => /^iPhone/.test(d.name))?.identifier || "com.apple.CoreSimulator.SimDeviceType.iPhone-SE-3rd-generation";
  const device = (await simctl(["create", "Reach page recovery test", type, runtime.identifier])).stdout.trim();
  t.after(async () => {
    await simctl(["shutdown", device]).catch(() => {});
    await simctl(["delete", device]).catch(() => {});
  });
  await simctl(["boot", device]);
  await simctl(["bootstatus", device, "-b"], 300000);
  await simctl(["install", device, copy], 300000);
  // simctl can stay open after the app has started (as test/ios-simulator
  // finds): the app opening this computer's page is the proof it launched.
  let launch = null;
  const launching = simctl(["launch", device, bundle], 150000).catch((error) => { launch = error; });
  t.after(() => launching);
  const until = async (check, what, ms) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) assert.fail(`${what} (loads ${loads.length}, page up ${alive.length}, refused ${refused.length}${launch ? `; simctl launch: ${launch.killed ? "still open when stopped" : launch.message}` : ""})`);
      await pause(250);
    }
  };
  await until(() => alive.length >= 1, "the app opened Reach's page", 150000);

  // The computer can't be reached, and iOS ends the page's process.
  // An unreachable network ends the open connections too.
  down = true;
  for (const socket of sockets) socket.destroy();
  const before = { loads: loads.length, alive: alive.length };
  // A simulator's processes are this Mac's: the page's is a WebKit content
  // process under this device's own launchd_sim.
  const processes = (await exec("ps", ["-ax", "-o", "pid=,ppid=,command="], { maxBuffer: 16 * 1024 * 1024 })).stdout
    .split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
  const launchd = processes.find((p) => /launchd_sim/.test(p[3]) && p[3].includes(device));
  assert.ok(launchd, "this simulator's launchd_sim");
  const pids = processes.filter((p) => p[2] === launchd[1] && /com\.apple\.WebKit\.WebContent/.test(p[3])).map((p) => Number(p[1]));
  assert.ok(pids.length >= 1, `the page's process is running under launchd_sim ${launchd[1]}`);
  for (const pid of pids) process.kill(pid, "SIGKILL");
  // Capacitor's reload goes nowhere: the page is gone.
  await until(() => refused.length >= 1, "the app tried to reload the page", 30000);
  await pause(3000);
  assert.equal(alive.length, before.alive, "no page while the computer can't be reached");

  // The computer answers again: the app opens the page by itself.
  down = false;
  const back = Date.now();
  await until(() => alive.length > before.alive, "the app opened Reach's page again on its own", 45000);
  t.diagnostic(JSON.stringify({ refusedWhileDown: refused.length, secondsToRecover: (Date.now() - back) / 1000, killed: pids.length }));
});
