import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  funnelRoute,
  PublicLink,
  PORT_TAKEN,
  ensurePersistentFunnel,
  removePersistentFunnel,
  startOrigin,
} from "../scripts/public-link.mjs";
import { assertUnusedPort } from "../scripts/tailscale.mjs";

// The public start link is a Funnel route on 443 to the start-page socket.
// Reach adds it, keeps it up, removes only its own, and never touches
// Reach's private port or anyone else's route.
const origin = "https://mac.tail1.ts.net";
const target = "unix:/tmp/r-abc/p";
const host = "mac.tail1.ts.net:443";
const ours = {
  TCP: { 443: { HTTPS: true } },
  Web: { [host]: { Handlers: { "/": { Proxy: target } } } },
  AllowFunnel: { [host]: true },
};
const privateReach = {
  TCP: { 8443: { HTTPS: true } },
  Web: {
    "mac.tail1.ts.net:8443": {
      Handlers: { "/": { Proxy: "unix:/tmp/r-abc/s" } },
    },
  },
};

test("recognizes exactly Reach's own Funnel route", () => {
  assert.equal(startOrigin("https://mac.tail1.ts.net:8443"), origin);
  assert.equal(funnelRoute({}, origin, target), "free");
  assert.equal(
    funnelRoute({ Foreground: { a: privateReach } }, origin, target),
    "free",
  );
  assert.equal(
    funnelRoute({ Foreground: { a: privateReach, b: ours } }, origin, target),
    "ours",
  );
  assert.equal(funnelRoute(ours, origin, target), "ours");
  const variants = [
    { ...ours, AllowFunnel: {} }, // private Serve on 443, not ours
    {
      ...ours,
      Web: {
        [host]: { Handlers: { "/": { Proxy: "http://127.0.0.1:9000" } } },
      },
    },
    {
      ...ours,
      Web: {
        [host]: {
          Handlers: { "/": { Proxy: target }, "/x": { Proxy: target } },
        },
      },
    },
    { TCP: { 443: { TCPForward: "127.0.0.1:22" } } },
  ];
  for (const v of variants)
    assert.equal(funnelRoute(v, origin, target), "taken", JSON.stringify(v));
  assert.equal(
    funnelRoute({ Foreground: { a: ours, b: variants[1] } }, origin, target),
    "taken",
  );
  // Reach's private port is still refused if Funnel were ever on it.
  assert.throws(
    () =>
      assertUnusedPort(
        { ...privateReach, AllowFunnel: { "mac.tail1.ts.net:8443": true } },
        8443,
      ),
    /Funnel is enabled on port 8443/,
  );
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    child.killed = signal || "SIGTERM";
    child.exitCode = 0;
    queueMicrotask(() => child.emit("close"));
  };
  return child;
}

test("foreground link: starts once, reports Funnel setup, restarts with backoff, never fights another service", async () => {
  let config = {};
  let clock = 1000;
  const spawned = [];
  const reports = [];
  const setup = [];
  const link = new PublicLink({
    origin,
    target,
    inspect: async () => config,
    spawnFunnel: (args) => {
      const child = fakeChild();
      spawned.push({ args, child });
      return child;
    },
    report: (m) => reports.push(m),
    setupUrl: (u) => setup.push(u),
    now: () => clock,
  });
  assert.equal(await link.check(), false);
  assert.deepEqual(
    spawned.map((s) => s.args),
    [["funnel", "--https=443", target]],
  );
  spawned[0].child.stdout.emit(
    "data",
    "Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n https://login.tailscale.com/f/funnel?node=abc\n",
  );
  assert.deepEqual(setup, ["https://login.tailscale.com/f/funnel?node=abc"]);
  assert.equal(await link.check(), false, "still starting: no second process");
  assert.equal(spawned.length, 1);
  config = { Foreground: { x: privateReach, y: ours } };
  assert.equal(await link.check(), true);
  assert.equal(link.live, true);
  // The process died and its route went with it: restart, but not in a tight loop.
  spawned[0].child.exitCode = 1;
  config = { Foreground: { x: privateReach } };
  clock += 10000;
  assert.equal(await link.check(), false);
  assert.equal(spawned.length, 2);
  spawned[1].child.exitCode = 1;
  assert.equal(await link.check(), false);
  assert.equal(spawned.length, 2, "backoff holds the next attempt");
  clock += 60000;
  await link.check();
  assert.equal(spawned.length, 3);
  // Someone else takes 443: report once, never spawn over it.
  spawned[2].child.exitCode = 1;
  config = {
    Web: { [host]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
    TCP: { 443: { HTTPS: true } },
  };
  clock += 60000;
  await link.check();
  await link.check();
  assert.equal(spawned.length, 3);
  assert.deepEqual(reports, [PORT_TAKEN]);
  config = { Foreground: { y: ours } };
  assert.equal(await link.check(), true);
  assert.deepEqual(reports, [PORT_TAKEN, "Public start link restored."]);
  await link.stop();
  assert.equal(await link.check(), true, "after stop, no more changes");
  assert.equal(spawned.length, 3);
});

// One address: the route now points at Reach's own listener. Reach's route
// from before (to the separate start-page socket) is replaced, as recorded
// when Reach added it; a route Reach never recorded is never touched.
test("one address: Reach's own older route is replaced; anyone else's never", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-funnel-"));
  const file = path.join(dir, "funnel-owner.json");
  const now = "unix:/tmp/r-abc/s";
  const route = (proxy) => ({
    TCP: { 443: { HTTPS: true } },
    Web: { [host]: { Handlers: { "/": { Proxy: proxy } } } },
    AllowFunnel: { [host]: true },
  });
  try {
    // Background service: recorded old route -> off, then the new one.
    let config = route(target);
    const ran = [];
    const run = async (args) => {
      ran.push(args);
      config = args.at(-1) === "off" ? {} : route(args.at(-1));
    };
    const inspect = async () => config;
    fs.writeFileSync(file, JSON.stringify({ version: 1, origin, target }));
    assert.equal(
      await ensurePersistentFunnel({ file, origin, target: now, inspect, run }),
      true,
    );
    assert.deepEqual(ran, [
      ["funnel", "--https=443", "off"],
      ["funnel", "--bg", "--https=443", now],
    ]);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).target, now);

    // Not recorded as Reach's (or recorded for another name): never replaced.
    for (const record of [null, { version: 1, origin: "https://other.tail1.ts.net", target }]) {
      config = route(target);
      ran.length = 0;
      if (record) fs.writeFileSync(file, JSON.stringify(record));
      else fs.rmSync(file, { force: true });
      await assert.rejects(
        ensurePersistentFunnel({ file, origin, target: now, inspect, run }),
        { message: PORT_TAKEN },
      );
      assert.deepEqual(ran, [], JSON.stringify(record));
    }

    // Running in the foreground over an older service's recorded route: it
    // goes, the record with it, and the one address starts.
    config = route(target);
    ran.length = 0;
    fs.writeFileSync(file, JSON.stringify({ version: 1, origin, target }));
    const spawned = [];
    const reports = [];
    const link = new PublicLink({
      origin,
      target: now,
      file,
      run,
      inspect,
      spawnFunnel: (args) => (spawned.push(args), fakeChild()),
      report: (m) => reports.push(m),
    });
    assert.equal(await link.check(), false);
    assert.deepEqual(ran, [["funnel", "--https=443", "off"]]);
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(spawned, [["funnel", "--https=443", now]]);
    assert.deepEqual(reports, [], "no port-taken warning for our own route");
    await link.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("background service: adds a recorded Funnel route and removes only that one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-funnel-"));
  const file = path.join(dir, "funnel-owner.json");
  try {
    let config = { ...privateReach };
    const ran = [];
    const run = async (args) => {
      ran.push(args);
      if (args[0] === "funnel" && args.at(-1) === "off")
        config = { ...privateReach };
      else
        config = {
          ...privateReach,
          ...ours,
          TCP: { ...privateReach.TCP, ...ours.TCP },
          Web: { ...privateReach.Web, ...ours.Web },
        };
    };
    const inspect = async () => config;
    assert.equal(
      await ensurePersistentFunnel({ file, origin, target, inspect, run }),
      true,
    );
    assert.deepEqual(ran, [["funnel", "--bg", "--https=443", target]]);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
      version: 1,
      origin,
      target,
    });
    assert.equal(
      await ensurePersistentFunnel({ file, origin, target, inspect, run }),
      true,
    );
    assert.equal(ran.length, 1, "already there: nothing to change");
    assert.equal(
      await removePersistentFunnel({ file, inspect, run }),
      "Public start link removed.",
    );
    assert.deepEqual(ran.at(-1), ["funnel", "--https=443", "off"]);
    assert.equal(fs.existsSync(file), false);
    assert.equal(
      await removePersistentFunnel({ file, inspect, run }),
      "",
      "nothing recorded: nothing removed",
    );

    // Another service on 443 is never replaced, and uninstall leaves it alone.
    const other = {
      TCP: { 443: { HTTPS: true } },
      Web: {
        [host]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
      },
    };
    config = other;
    await assert.rejects(
      ensurePersistentFunnel({ file, origin, target, inspect, run }),
      { message: PORT_TAKEN },
    );
    fs.writeFileSync(file, JSON.stringify({ version: 1, origin, target }));
    const before = ran.length;
    await removePersistentFunnel({ file, inspect, run });
    assert.equal(ran.length, before);
    assert.equal(config, other);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
