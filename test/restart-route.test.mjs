import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicJson } from "../server/core.mjs";
import { stopReach } from "../scripts/stop.mjs";
import { startInTerminal } from "../scripts/stop.mjs";
import { backgroundPlist } from "../scripts/background-service.mjs";
import { handoffPersistentRoute, ensurePersistentRoute } from "../scripts/persistent-serve.mjs";

const origin = "https://computer.example.ts.net:8443";
const oldTarget = "unix:/tmp/old-reach/s";
const newTarget = "unix:/tmp/new-reach/s";
const route = (target) => ({
  TCP: { 8443: { HTTPS: true } },
  Web: { "computer.example.ts.net:8443": { Handlers: { "/": { Proxy: target } } } },
});

test("cross-checkout restart retains the phone URL and replaces the stopped Reach target", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-restart-route-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const oldRoot = path.join(dir, "old"), newRoot = path.join(dir, "new");
  const state = (root) => path.join(root, ".reach");
  const source = path.join(state(oldRoot), "serve-owner.json");
  const file = path.join(state(newRoot), "serve-owner.json");
  atomicJson(source, { version: 1, origin, target: oldTarget });
  let alive = true, config = route(oldTarget);
  const calls = [];
  await stopReach(newRoot, {
    platform: "linux", state, print() {},
    restarting: true,
    table: () => [{ pid: 100, ppid: 1, tty: "ttys000", command: `/node ${oldRoot}/scripts/bootstrap.mjs` }],
    kill(pid, signal) {
      if (signal === "SIGINT") alive = false;
      else if (!alive) throw Object.assign(Error("gone"), { code: "ESRCH" });
    },
    handoffRoute: (options) => {
      assert.equal(alive, false, "transfer only after the previous host exits");
      return handoffPersistentRoute({ ...options, inspect: async () => config });
    },
  });
  assert.deepEqual(JSON.parse(await fs.readFile(file)), { version: 1, origin, target: oldTarget });
  await ensurePersistentRoute({
    file, origin, target: newTarget, inspect: async () => config,
    run: async (args) => {
      calls.push(args);
      config = args.at(-1) === "off" ? {} : route(args.at(-1));
    },
  });
  assert.deepEqual(calls, [["serve", "--https=8443", "off"], ["serve", "--bg", "--https=8443", newTarget]]);
  assert.equal(config.Web["computer.example.ts.net:8443"].Handlers["/"].Proxy, newTarget);
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await fs.access(source); // the previous checkout retains its recovery record
});

test("handoff refuses other services, changed handlers, foreground routes, and public Funnel", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-restart-route-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "old.json"), file = path.join(dir, "new.json");
  atomicJson(source, { version: 1, origin, target: oldTarget });
  const extra = route(oldTarget);
  extra.Web["computer.example.ts.net:8443"].Handlers["/other"] = { Proxy: "http://127.0.0.1:8000" };
  for (const config of [route("http://127.0.0.1:8000"), extra, { Foreground: { session: route(oldTarget) } }, {}]) {
    assert.equal(await handoffPersistentRoute({ file, sources: [source], inspect: async () => config }), false);
    await assert.rejects(fs.access(file));
  }
  await assert.rejects(handoffPersistentRoute({
    file, sources: [source],
    inspect: async () => ({ ...route(oldTarget), AllowFunnel: { "computer.example.ts.net:8443": true } }),
  }), /Funnel/);
  await assert.rejects(fs.access(file));
});

test("same-checkout and local-only restarts need no Tailscale inspection", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-restart-route-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "serve-owner.json");
  atomicJson(file, { version: 1, origin, target: oldTarget });
  const inspect = () => { throw Error("must not inspect"); };
  assert.equal(await handoffPersistentRoute({ file, sources: [file], inspect }), false);
  assert.equal(await handoffPersistentRoute({ file, sources: [path.join(dir, "missing.json")], inspect }), false);
});

test("cancelled restarts and ordinary stops never transfer ownership", async () => {
  for (const restarting of [false, true]) {
    let transfers = 0, kills = 0;
    const done = await stopReach("/new", {
      platform: "linux", restarting, interactive: true,
      print() {}, ask: async () => "n",
      table: () => [
        { pid: 100, ppid: 1, tty: "ttys000", command: "/node /old/scripts/bootstrap.mjs" },
        ...(restarting ? [{ pid: 101, ppid: 100, tty: "ttys001", command: "/bin/zsh" }] : []),
      ],
      kill(pid, signal) {
        if (signal === "SIGINT") kills++;
        else throw Object.assign(Error("gone"), { code: "ESRCH" });
      },
      handoffRoute: async () => { transfers++; },
    });
    assert.equal(transfers, 0);
    assert.equal(kills, restarting ? 0 : 1);
    if (restarting) assert.equal(done.cancelled, true);
  }
});

test("Terminal and service launches retain explicit Reach settings and data paths", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-restart-state-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const env = { REACH_HOME: "/Users/me/shared reach's state", REACH_DATA: "/Users/me/shared data", REACH_SECRET: "must-not-export" };
  const file = startInTerminal("/new", { state: dir, env, open() {} });
  const script = await fs.readFile(file, "utf8");
  assert.ok(script.includes("export REACH_HOME='/Users/me/shared reach'\\''s state'"));
  assert.ok(script.includes("export REACH_DATA='/Users/me/shared data'"));
  assert.equal(script.includes("must-not-export"), false);
  const plist = backgroundPlist({ httpsPort: 8443, folders: [] }, "/new", "/node", env, "/logs");
  assert.ok(plist.includes("<key>REACH_HOME</key><string>/Users/me/shared reach's state</string>"));
  assert.ok(plist.includes("<key>REACH_DATA</key><string>/Users/me/shared data</string>"));
  assert.equal(plist.includes("must-not-export"), false);
});
