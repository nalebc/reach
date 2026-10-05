import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import {
  backgroundService,
  backgroundPlist,
  privateNodePath,
  parseLaunchStatus,
} from "../scripts/background-service.mjs";
import {
  ensurePersistentRoute,
  removePersistentRoute,
  exactPersistentRoute,
} from "../scripts/persistent-serve.mjs";
import {
  stayAwakeOnAC,
  onACPower,
  keepAwake,
  stayAwakeMode,
  assertionArgs,
} from "../scripts/stay-awake.mjs";
import { pairRunningHost } from "../scripts/pairing.mjs";
import { parseOptions } from "../scripts/launcher-options.mjs";
import { createReach } from "../server/index.mjs";
import { atomicJson } from "../server/core.mjs";
const origin = "https://computer.example.ts.net:8443",
  target = "http://127.0.0.1:54321";
const owned = () => ({
  TCP: { 8443: { HTTPS: true } },
  Web: {
    "computer.example.ts.net:8443": { Handlers: { "/": { Proxy: target } } },
  },
});
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), "reach-service-"));

test("service command parsing keeps foreground defaults and rejects mixed commands", () => {
  assert.equal(parseOptions([]).command, undefined);
  for (const command of ["install", "uninstall", "status", "pair"])
    assert.equal(parseOptions([command]).command, command);
  assert.equal(parseOptions(["install", "--stay-awake"]).stayAwake, true);
  assert.equal(parseOptions(["--stay-awake"]).stayAwake, true);
  for (const args of [
    ["install", "status"],
    ["pair", "--port", "1234"],
    ["install", "--service"],
    ["--background", "--stop-background"],
  ])
    assert.throws(() => parseOptions(args));
});

test("persistent Serve creates only unused routes, reuses only its recorded route, and removes only that route", async () => {
  const dir = await temp(),
    file = path.join(dir, "serve-owner.json");
  let config = {},
    calls = [];
  const run = async (args) => {
    calls.push(args);
    config = args.at(-1) === "off" ? {} : owned();
  };
  const options = { file, origin, target, inspect: async () => config, run };
  try {
    await ensurePersistentRoute(options);
    assert.deepEqual(calls, [["serve", "--bg", "--https=8443", target]]);
    await ensurePersistentRoute(options);
    assert.equal(calls.length, 1);
    if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    // A different port's service is never touched.
    config.TCP[9999] = { HTTPS: true };
    config.Web["other.example.ts.net:9999"] = {
      Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } },
    };
    await removePersistentRoute({
      ...options,
      run: async (args) => {
        calls.push(args);
        delete config.TCP[8443];
        delete config.Web["computer.example.ts.net:8443"];
      },
    });
    assert.deepEqual(calls.at(-1), ["serve", "--https=8443", "off"]);
    assert(config.TCP[9999]);
    await assert.rejects(fs.access(file));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Serve refuses unrecorded matches, conflicts, Funnel, extra handlers and foreground routes", async () => {
  const dir = await temp(),
    file = path.join(dir, "serve-owner.json");
  let config = owned(),
    calls = 0;
  const options = {
    file,
    origin,
    target,
    inspect: async () => config,
    run: async () => calls++,
  };
  try {
    await assert.rejects(ensurePersistentRoute(options), /already in use/);
    atomicJson(file, { origin, target });
    for (config of [
      { ...owned(), AllowFunnel: { "computer.example.ts.net:8443": true } },
      { Foreground: { session: owned() } },
      {
        TCP: { 8443: { HTTPS: true } },
        Web: {
          "computer.example.ts.net:8443": {
            Handlers: {
              "/": { Proxy: target },
              "/other": { Proxy: "http://127.0.0.1:9999" },
            },
          },
        },
      },
    ]) {
      await assert.rejects(ensurePersistentRoute(options));
      await assert.rejects(removePersistentRoute(options));
      await fs.access(file);
    }
    assert.equal(calls, 0);
    assert(
      exactPersistentRoute(
        {
          TCP: { 443: { HTTPS: true } },
          Web: {
            "computer.example.ts.net:443": {
              Handlers: { "/": { Proxy: target } },
            },
          },
        },
        "https://computer.example.ts.net",
        target,
      ),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Serve intent survives a crash after successful background creation", async () => {
  const dir = await temp(),
    file = path.join(dir, "serve-owner.json");
  let config = {},
    calls = 0;
  const options = {
    file,
    origin,
    target,
    inspect: async () => config,
    run: async () => {
      calls++;
      config = owned();
      throw Error("process interrupted");
    },
  };
  try {
    await assert.rejects(ensurePersistentRoute(options), /interrupted/);
    await ensurePersistentRoute(options);
    assert.equal(calls, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("install/status/uninstall preserve private runtime, PATH, scopes, logs, and cleanup order", async () => {
  const root = await temp(),
    home = await temp(),
    calls = [],
    prints = [];
  let loaded = false;
  const deps = {
    platform: "darwin",
    home,
    uid: 501,
    privateNode: () => "/private/reach/runtime/bin/node",
    allocatePort: async () => 54321,
    prepareOrigin: async () => origin,
    env: {
      PATH: "/runtime-prepended:/bin",
      REACH_INSTALL_PATH: "/my tools:/usr/bin:/bin",
      REACH_ROOTS: "/limited",
      AWS_SECRET_ACCESS_KEY: "never-copy",
    },
    print: (s) => prints.push(s),
    run: (args) => {
      calls.push(args);
      if (args[0] === "print") {
        if (!loaded) throw Error("not loaded");
        return "state = running\n pid = 555\n";
      }
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") loaded = false;
      return "";
    },
    waitForStop: async (pid) => {
      assert.equal(pid, 555);
      calls.push(["wait"]);
    },
    removeRoute: async () => {
      assert.equal(loaded, false);
      assert.deepEqual(calls.at(-1), ["wait"]);
      calls.push(["remove-route"]);
      return "route removed";
    },
  };
  try {
    await backgroundService(
      parseOptions(["install", "--stay-awake", "--folder", root]),
      root,
      deps,
    );
    const plist = await fs.readFile(
      path.join(home, "Library/LaunchAgents/com.reach.companion.plist"),
      "utf8",
    );
    assert(
      plist.includes("<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>"),
    );
    assert(plist.includes("<key>ThrottleInterval</key><integer>5</integer>"));
    assert(plist.includes("<string>/private/reach/runtime/bin/node</string>"));
    assert(
      plist.includes("<key>PATH</key><string>/my tools:/usr/bin:/bin</string>"),
    );
    assert(plist.includes("<string>--service</string>"));
    assert(plist.includes("<string>--stay-awake</string>"));
    assert(!plist.includes("never-copy"));
    const logs = path.join(root, ".reach/logs");
    assert(plist.includes(path.join(logs, "companion.log")));
    if (process.platform !== "win32") assert.equal(
      (await fs.stat(path.join(logs, "companion.log"))).mode & 0o777,
      0o600,
    );
    const record = JSON.parse(
      await fs.readFile(path.join(root, ".reach/service.json")),
    );
    assert.equal(record.options.port, 54321);
    assert.equal(record.dataDir, path.join(root, ".reach/quick"));
    const status = await backgroundService(
      parseOptions(["status"]),
      root,
      deps,
    );
    assert.equal(status.running, true);
    assert.equal(status.link, origin);
    assert.equal(status.logs, logs);
    // Once the one address is up, Reach records it: that's the phone's link.
    const hostStatus = path.join(root, ".reach/host-status.json");
    await fs.writeFile(
      hostStatus,
      JSON.stringify({ origin, link: "https://mac.example.ts.net" }),
    );
    assert.equal(
      (await backgroundService(parseOptions(["status"]), root, deps)).link,
      "https://mac.example.ts.net",
    );
    await fs.rm(hostStatus);
    await assert.rejects(
      backgroundService(parseOptions(["install"]), root, deps),
      /already/,
    );
    await backgroundService(parseOptions(["uninstall"]), root, deps);
    await assert.rejects(
      fs.access(
        path.join(home, "Library/LaunchAgents/com.reach.companion.plist"),
      ),
    );
    assert.equal(
      (await backgroundService(parseOptions(["status"]), root, deps)).running,
      false,
    );
    await fs.access(path.join(logs, "companion.log"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("private runtime never resolves to a system/Homebrew symlink", async () => {
  const root = await temp();
  try {
    const bin = path.join(
      root,
      ".reach/runtime/node-v22.23.3-darwin-arm64/bin",
    );
    await fs.mkdir(bin, { recursive: true });
    await fs.symlink(process.execPath, path.join(bin, "node"));
    assert.throws(() => privateNodePath(root, "arm64"), /private Node/);
    assert.equal(parseLaunchStatus("state = waiting\n").running, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stay-awake assertion follows AC power and releases on battery, read error and shutdown", async () => {
  let power = "Now drawing from 'Battery Power'",
    starts = 0,
    kills = 0,
    cancelled = 0,
    fail = false;
  const children = [];
  const awake = stayAwakeOnAC({
    readPower: async () => {
      if (fail) throw Error("no power state");
      return power;
    },
    acquire: () => {
      starts++;
      const c = new EventEmitter();
      c.kill = () => {
        kills++;
      };
      children.push(c);
      return c;
    },
    interval: () => 0,
    cancel: () => cancelled++,
    report: () => {},
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(starts, 0);
  power = "Now drawing from 'AC Power'";
  await awake.check();
  await awake.check();
  assert.equal(starts, 1);
  power = "Now drawing from 'Battery Power'";
  await awake.check();
  assert.equal(kills, 1);
  power = "Now drawing from 'AC Power'";
  await awake.check();
  assert.equal(starts, 2);
  fail = true;
  await awake.check();
  assert.equal(kills, 2);
  fail = false;
  await awake.check();
  awake.stop();
  await awake.check();
  assert.equal(kills, 3);
  assert.equal(starts, 3);
  assert.equal(cancelled, 1);
  assert.equal(onACPower("unknown power source"), false);
});

test("pair works against a running background host, prints QR, replaces codes, expires, and rejects stale instance metadata", async () => {
  const root = await temp(),
    dataDir = path.join(root, ".reach/quick");
  const reach = await createReach({ roots: [root], dataDir });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const localUrl = `http://127.0.0.1:${reach.server.address().port}`;
  const host = {
    localUrl,
    origin: localUrl,
    dataDir,
    instance: reach.instance,
    name: "Test Mac",
  };
  atomicJson(path.join(root, ".reach/host-status.json"), host);
  atomicJson(path.join(root, ".reach/service.json"), {
    installed: true,
    dataDir,
  });
  const messages = [],
    qrs = [];
  const deps = {
    env: {},
    print: (s) => messages.push(s),
    qr: {
      generate: (url, options, print) => {
        qrs.push(url);
        print("QR");
      },
    },
  };
  const pair = async (code) =>
    fetch(localUrl + "/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, name: "test phone" }),
    });
  try {
    const first = await pairRunningHost(root, deps),
      second = await pairRunningHost(root, deps);
    assert.equal((await pair(first.code)).status, 401);
    assert.equal((await pair(second.code)).status, 200);
    assert.equal((await pair(second.code)).status, 401);
    const third = await pairRunningHost(root, deps);
    atomicJson(path.join(dataDir, "pairing.json"), { ...third, expiresAt: 0 });
    assert.equal((await pair(third.code)).status, 401);
    assert(qrs[0].includes("#pair="));
    assert(messages.includes("QR"));
    atomicJson(path.join(root, ".reach/host-status.json"), {
      ...host,
      instance: "old-process",
    });
    await assert.rejects(
      pairRunningHost(root, deps),
      /stopped or still connecting/,
    );
    if (process.platform !== "win32") assert.equal(
      (await fs.stat(path.join(dataDir, "pairing.json"))).mode & 0o777,
      0o600,
    );
  } finally {
    await reach.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("failed service install rolls back and unverified LaunchAgents cannot be stopped", async () => {
  const root = await temp(),
    home = await temp();
  const file = path.join(
    home,
    "Library/LaunchAgents/com.reach.companion.plist",
  );
  const stateFile = path.join(root, ".reach/service.json");
  const previous = { installed: false, origin, options: { port: 54321 } };
  atomicJson(stateFile, previous);
  const deps = {
    platform: "darwin",
    home,
    uid: 501,
    env: {},
    print: () => {},
    privateNode: () => "/private/runtime/bin/node",
    allocatePort: async () => 54321,
    prepareOrigin: async () => origin,
    run: (args) => {
      throw Error(args[0] === "bootstrap" ? "bootstrap failed" : "not loaded");
    },
  };
  try {
    await assert.rejects(
      backgroundService(parseOptions(["install"]), root, deps),
      /bootstrap failed/,
    );
    assert.deepEqual(JSON.parse(await fs.readFile(stateFile)), previous);
    await assert.rejects(fs.access(file));
    const calls = [];
    deps.run = (args) => {
      calls.push(args);
      return "state = running\n pid = 555\n";
    };
    await assert.rejects(
      backgroundService(parseOptions(["uninstall"]), root, deps),
      /ownership cannot be verified/,
    );
    assert.deepEqual(
      calls.map((c) => c[0]),
      ["print"],
    );
    await fs.writeFile(
      file,
      backgroundPlist(
        { folders: [], httpsPort: 8443 },
        "/another-checkout",
        "/private/node",
        {},
        "/logs",
      ),
    );
    await assert.rejects(
      backgroundService(parseOptions(["uninstall"]), root, deps),
      /another checkout/,
    );
    assert.deepEqual(
      calls.map((c) => c[0]),
      ["print", "print"],
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  }
});

test(
  "background launcher starts without stdin, pairs without logging a code, and retains pairing after restart",
  { timeout: 20000, skip: process.platform === "win32" && "Unix SIGTERM launcher shutdown; Windows terminates process trees differently" },
  async () => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const { pathToFileURL } = await import("node:url");
    const { availablePort } = await import("../scripts/background-service.mjs");
    const root = await temp(),
      port = await availablePort();
    const entry = pathToFileURL(path.resolve("scripts/launch.mjs")).href;
    const localUrl = `http://127.0.0.1:${port}`;
    let current;
    const start = async () => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import {launch} from ${JSON.stringify(entry)}; await launch({local:true,service:true,port:${port},folders:[${JSON.stringify(root)}]},${JSON.stringify(root)});`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (c) => {
        output += c;
      });
      child.stderr.on("data", (c) => {
        output += c;
      });
      const exit = once(child, "exit");
      current = { child, exit };
      const deadline = Date.now() + 8000;
      while (!output.includes("Reach is ready")) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw Error(`Background startup failed: ${output}`);
        await new Promise((r) => setTimeout(r, 20));
      }
      assert(!output.includes("Pairing code:"));
      assert(
        !output.includes("Keep this computer awake and this terminal open"),
      );
    };
    const stop = async () => {
      current.child.kill("SIGTERM");
      await current.exit;
    };
    try {
      await start();
      const first = await fs
        .readFile(path.join(root, ".reach/host-status.json"), "utf8")
        .then(JSON.parse);
      const pairing = await pairRunningHost(root, {
        env: {},
        print: () => {},
        qr: { generate: () => {} },
      });
      const response = await fetch(localUrl + "/api/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: pairing.code, name: "phone" }),
      });
      assert.equal(response.status, 200);
      const { token } = await response.json();
      assert(token);
      await stop();
      await assert.rejects(
        fs.access(path.join(root, ".reach/host-status.json")),
      );
      await assert.rejects(fetch(localUrl + "/api/health"));
      await start();
      const second = await fs
        .readFile(path.join(root, ".reach/host-status.json"), "utf8")
        .then(JSON.parse);
      assert.notEqual(second.instance, first.instance);
      assert.equal(second.localUrl, first.localUrl);
      assert.equal(
        (
          await fetch(localUrl + "/api/device", {
            headers: { Authorization: `Bearer ${token}` },
          })
        ).status,
        200,
      );
    } finally {
      if (
        current?.child.exitCode === null &&
        current?.child.signalCode === null
      )
        await stop();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("default session policy protects system and display, preserves opt-outs and persists service flags", () => {
  assert.equal(stayAwakeMode(undefined), "always");
  assert.equal(stayAwakeMode("always"), "always");
  assert.equal(stayAwakeMode(false), "off");
  assert.equal(stayAwakeMode(true), "ac");
  assert.deepEqual(assertionArgs(123), ["-d", "-i", "-s", "-w", "123"]);
  assert.equal(parseOptions(["--stay-awake-always"]).stayAwake, "always");
  for (const [flag, expected] of [
    ["--stay-awake-always", "--stay-awake-always"],
    ["--no-stay-awake", "--no-stay-awake"],
    ["--stay-awake", "--stay-awake"],
  ]) {
    const plist = backgroundPlist(
      parseOptions(["install", flag]),
      "/reach",
      "/private/node",
      {},
      "/logs",
    );
    assert(plist.includes(`<string>${expected}</string>`));
  }
});

test("always-awake mode works on battery without power polling, recovers crashed helpers and releases once", async () => {
  let starts = 0,
    kills = 0,
    polls = 0,
    cancelled = 0,
    tick;
  const children = [],
    states = [];
  const awake = keepAwake({
    readPower: async () => {
      polls++;
      throw Error("unavailable");
    },
    acquire: () => {
      const child = new EventEmitter();
      child.pid = ++starts;
      child.kill = () => {
        kills++;
        child.emit("exit", 0);
      };
      children.push(child);
      return child;
    },
    interval: (fn, ms) => {
      assert.equal(ms, 5000);
      tick = fn;
      return 7;
    },
    cancel: (id) => {
      assert.equal(id, 7);
      cancelled++;
    },
    changed: (state) => states.push(state),
    report: () => {},
  });
  assert.equal(awake.status().active, true);
  assert.equal(polls, 0);
  await awake.check();
  assert.equal(starts, 1);
  children[0].emit("exit", 1);
  assert.equal(awake.status().active, false);
  assert.match(awake.status().error, /retry/);
  tick();
  assert.equal(starts, 2);
  children[0].emit("error", Error("late error"));
  assert.equal(awake.status().pid, 2);
  children[1].emit("error", Error("spawn failed"));
  tick();
  assert.equal(starts, 3);
  awake.stop();
  awake.stop();
  await awake.check();
  assert.equal(kills, 1);
  assert.equal(cancelled, 1);
  assert.equal(states.at(-1).active, false);
  assert.equal(starts, 3);
});

test("disabled and stopped-during-power-check modes never acquire assertions", async () => {
  let complete,
    starts = 0;
  const disabled = keepAwake({
    mode: "off",
    acquire: () => {
      starts++;
    },
    interval: () => assert.fail("off must not poll"),
  });
  disabled.stop();
  const waiting = keepAwake({
    mode: "ac",
    readPower: () =>
      new Promise((r) => {
        complete = r;
      }),
    acquire: () => {
      starts++;
    },
    interval: () => 0,
    cancel: () => {},
  });
  waiting.stop();
  complete("Now drawing from 'AC Power'");
  await new Promise((r) => setImmediate(r));
  assert.equal(starts, 0);
});
