import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ForegroundServe, createLock } from "../scripts/foreground-serve.mjs";
import { keyRedactor } from "../server/tailscale-auth.mjs";

// Windows' private route (scripts/foreground-serve.mjs) when its `tailscale
// serve` doesn't come up. The route itself is covered end to end in
// windows-commands.test.mjs, against a stand-in Tailscale.
const origin = "https://pc.example.ts.net:8443";
const target = "http://127.0.0.1:4317";
const child = ({ said = "", exitCode = null } = {}) => {
  const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: [] });
  c.kill = (signal = "SIGTERM") => {
    c.killed.push(signal);
    setImmediate(() => c.emit("exit", null, signal));
  };
  if (exitCode !== null)
    setImmediate(() => {
      c.stderr.emit("data", said);
      c.emit("exit", exitCode, null);
    });
  return c;
};
const route = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-foreground-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "serve-owner.json");
};

test("Windows route: Tailscale's refusal is said in its own words, with the page that fixes it", async (t) => {
  const said = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nPC\n";
  const heard = [];
  const spawned = [];
  const serve = new ForegroundServe({
    file: route(t), origin, target, pollMs: 5,
    inspect: async () => ({}),
    spawnServe: (args) => (spawned.push(args), child({ said, exitCode: 1 })),
    output: (text) => heard.push(text),
  });
  await assert.rejects(serve.start(), /Serve is not enabled on your tailnet\. To enable, visit: https:\/\/login\.tailscale\.com\/f\/serve\?node=nPC/);
  assert.deepEqual(spawned, [["serve", "--https=8443", target]], "in the foreground: no --bg");
  assert.equal(heard.join(""), said, "its words reach the log and the setup hint as they come");
  assert.equal(serve.alive, false);
});

test("Windows route: a session that never shows is ended after the wait, never left running", async (t) => {
  let held;
  const serve = new ForegroundServe({
    file: route(t), origin, target, pollMs: 5, waitMs: 50,
    inspect: async () => ({}),
    spawnServe: () => (held = child()),
  });
  await assert.rejects(serve.start(), /Tailscale took too long to answer\./);
  assert.deepEqual(held.killed, ["SIGTERM"]);
  assert.equal(serve.alive, false);
});

// Browser sign-in on Windows (REACH_WINDOWS_ACCOUNT=1): the route's target
// carries its key, the public route is held the same way, and both share one
// lock on Tailscale's serve config (docs/parity/D-public-door.md §4.8).
const KEY = "Abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
const keyed = `http://127.0.0.1:4317/r-${KEY}`;
const redact = keyRedactor(KEY);
const leaks = (text) => {
  for (let i = 0; i + 12 <= KEY.length; i++) if (text.includes(KEY.slice(i, i + 12))) return KEY.slice(i, i + 12);
  return "";
};
const session = (to = keyed, port = 8443) => ({
  Foreground: { s: { TCP: { [port]: { HTTPS: true } }, Web: { [`pc.example.ts.net:${port}`]: { Handlers: { "/": { Proxy: to } } } } } },
});
const live = () => {
  const c = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: [] });
  c.kill = (signal = "SIGTERM") => {
    c.killed.push(signal);
    setImmediate(() => c.emit("exit", null, signal));
  };
  return c;
};
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("keyed: Tailscale's words are redacted line by line, whatever the chunks; thrown and exit reasons too", async (t) => {
  const heard = [];
  let held;
  let config = {};
  const ended = [];
  const serve = new ForegroundServe({
    file: "", origin, target: keyed, pollMs: 5, redact,
    inspect: async () => config,
    spawnServe: () => (held = live()),
    output: (text) => heard.push(text),
    exited: (why) => ended.push(why),
  });
  t.after(() => serve.stop());
  const started = serve.start();
  await tick(10);
  // The key cut across three chunks, then the session shows.
  const said = `Available within your tailnet:\n\nhttps://pc.example.ts.net:8443\n|-- proxy ${keyed}\n\nPress Ctrl+C to exit.\n`;
  const cut = said.indexOf(KEY) + 7;
  held.stdout.emit("data", said.slice(0, cut));
  held.stdout.emit("data", said.slice(cut, cut + 20));
  held.stdout.emit("data", said.slice(cut + 20));
  config = session();
  assert.equal(await started, true);
  assert.equal(leaks(heard.join("")), "");
  assert.match(heard.join(""), /\|-- proxy http:\/\/127\.0\.0\.1:4317\/r-…\n/);
  // A last line with no newline is said, redacted, when it ends.
  held.stderr.emit("data", `serve: ended ${keyed}`);
  held.emit("exit", 1, null);
  assert.equal(leaks(heard.join("")), "");
  assert.match(heard.at(-1), /^serve: ended http:\/\/127\.0\.0\.1:4317\/r-…$/);
  assert.equal(ended.length, 1);
  // A refusal whose key straddles tailscaleSaid's 400-character cut.
  for (const at of [380, 390, 395, 399, 400, 401, 410]) {
    const pad = "x".repeat(at - "error: proxy http://127.0.0.1:4317/r-".length - 10);
    const refused = new ForegroundServe({
      file: "", origin, target: keyed, pollMs: 5, redact,
      inspect: async () => ({}),
      spawnServe: () => {
        const c = live();
        setImmediate(() => {
          c.stderr.emit("data", `error: proxy ${pad}${keyed}/more\n`);
          c.emit("exit", 1, null);
        });
        return c;
      },
    });
    await assert.rejects(refused.start(), (error) => !leaks(error.message) && error.message.length <= 400, String(at));
  }
  // A spawn error after it was up: its message only, redacted.
  const reasons = [];
  let errorChild;
  let up = {};
  const failing = new ForegroundServe({
    file: "", origin, target: keyed, pollMs: 5, redact,
    inspect: async () => up,
    spawnServe: () => {
      setImmediate(() => (up = session()));
      return (errorChild = live());
    },
    exited: (why) => reasons.push(why),
  });
  t.after(() => failing.stop());
  assert.equal(await failing.start(), true);
  errorChild.emit("error", Object.assign(Error(`spawn failed for ${keyed}`), { spawnargs: ["serve", keyed] }));
  assert.equal(reasons.length, 1);
  assert.equal(leaks(reasons[0]), "");
});

test("its command, the session it counts as up and the check before it are passed in; no record file without one", async (t) => {
  const spawned = [];
  const checked = [];
  let config = {};
  const serve = new ForegroundServe({
    file: "", origin: "https://pc.example.ts.net", target: keyed, pollMs: 5,
    args: ["funnel", "--https=443", keyed],
    exact: (c, o, to) => (checked.push([o, to]), !!c.up),
    free: (c) => {
      if (c.taken) throw Error("taken");
    },
    inspect: async () => config,
    run: async () => assert.fail("nothing switched off without a record"),
    spawnServe: (args) => (spawned.push(args), live()),
  });
  t.after(() => serve.stop());
  const started = serve.start();
  await tick(20);
  config = { up: true };
  assert.equal(await started, true);
  assert.deepEqual(spawned, [["funnel", "--https=443", keyed]]);
  assert.ok(checked.length && checked.every(([o, to]) => o === "https://pc.example.ts.net" && to === keyed));
  assert.equal(serve.owns({ up: true }), true);
  const taken = new ForegroundServe({ file: "", origin, target: keyed, free: () => { throw Error("taken"); }, inspect: async () => ({}), spawnServe: (args) => (spawned.push(args), live()) });
  await assert.rejects(taken.start(), { message: "taken" });
  assert.equal(spawned.length, 1);
});

test("told another client is changing the serve config: tried again at once, up to three times", async (t) => {
  const spawned = [];
  let config = {};
  const serve = new ForegroundServe({
    file: "", origin, target: keyed, pollMs: 5, redact,
    inspect: async () => config,
    spawnServe: () => {
      const c = live();
      spawned.push(c);
      if (spawned.length === 1)
        setImmediate(() => {
          c.stderr.emit("data", "Another client is changing the serve config; please try again.\n");
          c.emit("exit", 1, null);
        });
      else setImmediate(() => (config = session()));
      return c;
    },
  });
  t.after(() => serve.stop());
  assert.equal(await serve.start(), true, "no error");
  assert.equal(spawned.length, 2);
  let tries = 0;
  const stubborn = new ForegroundServe({
    file: "", origin, target: keyed, pollMs: 5,
    inspect: async () => ({}),
    spawnServe: () => {
      tries++;
      const c = live();
      setImmediate(() => {
        c.stderr.emit("data", "Another client is changing the serve config; please try again.\n");
        c.emit("exit", 1, null);
      });
      return c;
    },
  });
  await assert.rejects(stubborn.start(), /Another client is changing the serve config/);
  assert.equal(tries, 3);
});

test("two sessions sharing a lock: the second starts once the first shows; one waiting for Funnel lets it go", async (t) => {
  const lock = createLock();
  const order = [];
  let config = {};
  const privateRoute = new ForegroundServe({
    file: "", origin, target: keyed, pollMs: 5, lock,
    inspect: async () => config,
    spawnServe: () => {
      order.push("serve spawned");
      setTimeout(() => {
        order.push("serve shows");
        config = session();
      }, 40);
      return live();
    },
  });
  t.after(() => privateRoute.stop());
  const funnel = new ForegroundServe({
    file: "", origin: "https://pc.example.ts.net", target: keyed, pollMs: 5, lock, waitMs: 30,
    args: ["funnel", "--https=443", keyed], exact: () => false, free: () => {},
    inspect: async () => config,
    spawnServe: () => (order.push("funnel spawned"), live()),
  });
  const first = privateRoute.start();
  const second = funnel.start().catch(() => {});
  await first;
  await second;
  assert.deepEqual(order.slice(0, 3), ["serve spawned", "serve shows", "funnel spawned"]);
  // A Funnel session waiting to be allowed lets the lock go at once, and is
  // kept past waitMs, asked about once.
  const waits = [];
  let waiting;
  const blocked = new ForegroundServe({
    file: "", origin: "https://pc.example.ts.net", target: keyed, pollMs: 5, awaitPollMs: 5, lock, waitMs: 20,
    args: ["funnel", "--https=443", keyed], exact: () => false, free: () => {}, awaitEnable: true,
    awaiting: (url) => waits.push(url),
    inspect: async () => ({}),
    spawnServe: () => {
      waiting = live();
      setImmediate(() => waiting.stdout.emit("data", "Funnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=nPC\n"));
      return waiting;
    },
  });
  const pending = blocked.start();
  let nextConfig = {};
  const next = new ForegroundServe({
    file: "", origin: "https://pc.example.ts.net:9443", target: keyed, pollMs: 5, lock,
    inspect: async () => nextConfig,
    spawnServe: () => {
      setTimeout(() => (nextConfig = session(keyed, 9443)), 10);
      return live();
    },
  });
  t.after(() => next.stop());
  assert.equal(await next.start(), true, "not held up by a session waiting for Funnel");
  await tick(60);
  assert.deepEqual(waits, ["https://login.tailscale.com/f/funnel?node=nPC"]);
  assert.deepEqual(waiting.killed, []);
  assert.equal(blocked.awaitingEnable, true);
  await blocked.stop();
  assert.equal(await pending, false);
});

test("without awaitEnable (the private route), a page to visit doesn't suspend the wait", async (t) => {
  let held;
  const serve = new ForegroundServe({
    file: route(t), origin, target, pollMs: 5, waitMs: 50,
    inspect: async () => ({}),
    spawnServe: () => {
      held = child();
      setImmediate(() => held.stdout.emit("data", "To enable, visit:\n https://login.tailscale.com/f/serve?node=nPC\n"));
      return held;
    },
  });
  await assert.rejects(serve.start(), /To enable, visit: https:\/\/login\.tailscale\.com/);
  assert.deepEqual(held.killed, ["SIGTERM"]);
  assert.equal(serve.awaitingEnable, false);
});
