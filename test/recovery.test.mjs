import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { once } from "node:events";
import { WebSocket } from "ws";
import { PrivateLinkRecovery } from "../scripts/private-link-recovery.mjs";
import { backgroundPlist } from "../scripts/background-service.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

const loadTS = async (name) => {
  const source = await fs.readFile(
    new URL(`../src/${name}.ts`, import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
};
const { ReconnectTimer, screenCanRetry } = await loadTS("reconnect");
const { DesktopInputQueue } = await loadTS("desktop-input-queue");

test("a live screen's retry waits at most its own cap", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const retry = new ReconnectTimer(() => 1, 4000);
  const delays = [];
  for (let i = 0; i < 6; i++) {
    delays.push(retry.schedule(() => {}));
    t.mock.timers.tick(delays.at(-1));
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 4000, 4000, 4000]);
});

test("a live screen's first retry comes after a quarter second", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const retry = new ReconnectTimer(() => 1, 4000, 250);
  const delays = [];
  for (let i = 0; i < 6; i++) {
    delays.push(retry.schedule(() => {}));
    t.mock.timers.tick(delays.at(-1));
  }
  assert.deepEqual(delays, [250, 500, 1000, 2000, 4000, 4000]);
});

test("recovery backs off to 30s, wakes once, and cancels stale retries", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const retry = new ReconnectTimer(() => 1);
  let runs = 0;
  for (const expected of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    assert.equal(
      retry.schedule(() => runs++),
      expected,
    );
    t.mock.timers.tick(expected);
  }
  assert.equal(runs, 7);
  retry.schedule(() => runs++);
  retry.wake();
  retry.wake();
  t.mock.timers.tick(30000);
  assert.equal(runs, 8);
  retry.schedule(() => runs++);
  retry.cancel();
  t.mock.timers.tick(30000);
  assert.equal(runs, 8);
  retry.reset();
  assert.equal(
    retry.schedule(() => runs++),
    1000,
  );
  retry.cancel();
});

test("screen recovery stops on access denial and supports older hosts", () => {
  for (const status of [400, 401, 403, 404])
    assert.equal(screenCanRetry({ status }), false);
  for (const error of [
    "Access revoked",
    "Access expired",
    "Pair this device again.",
    "Screen viewing is off.",
  ])
    assert.equal(screenCanRetry({ error }), false);
  assert.equal(screenCanRetry({ retryable: false }), false);
  assert.equal(screenCanRetry({ status: 503 }), true);
  assert.equal(screenCanRetry({ error: "Screen capture stopped" }), true);
});

test("failed sends reject the pending input and never replay it", async () => {
  let sends = 0,
    failures = 0;
  const queue = new DesktopInputQueue(
    () => {
      sends++;
      throw Error("disconnected");
    },
    () => failures++,
  );
  await assert.rejects(queue.enqueue({ type: "key", key: "enter" }));
  await assert.rejects(
    queue.enqueue({ type: "text", text: "must not replay" }),
  );
  assert.equal(sends, 1);
  assert.equal(failures, 1);
});

const origin = "https://computer.example.ts.net:8443",
  target = "http://127.0.0.1:5555";
const owned = {
  TCP: { 8443: { HTTPS: true } },
  Web: {
    "computer.example.ts.net:8443": { Handlers: { "/": { Proxy: target } } },
  },
};
test("Tailscale interruption pauses access, preserves the host, and recovers the same private route", async () => {
  let config = owned,
    down = false,
    starts = 0;
  const states = [];
  const recovery = new PrivateLinkRecovery({
    origin,
    target,
    inspect: async () => {
      if (down) throw Error("offline");
      return config;
    },
    restart: async () => {
      starts++;
      config = owned;
    },
    available: (v) => states.push(v),
  });
  await recovery.check();
  // One failed read is noise: the route is daemon state and stays available.
  down = true;
  await recovery.check();
  assert.deepEqual(states, [true]);
  assert.equal(starts, 0);
  // A second miss in a row pauses access and recovers the same route.
  down = false;
  config = {};
  await recovery.check();
  assert.deepEqual(states, [true, false]);
  assert.equal(starts, 1);
  await recovery.check();
  assert.deepEqual(states, [true, false, true]);
  // A single miss later never flips access again.
  down = true;
  await recovery.check();
  assert.deepEqual(states, [true, false, true]);
  recovery.stop();
  await recovery.check();
  assert.equal(states.length, 3);
});
test("recovery never overwrites a conflicting route or enables Funnel", async () => {
  let config,
    starts = 0;
  const states = [];
  const recovery = new PrivateLinkRecovery({
    origin,
    target,
    inspect: async () => config,
    restart: async () => starts++,
    available: (v) => states.push(v),
  });
  for (config of [
    { ...owned, AllowFunnel: { "computer.example.ts.net:8443": true } },
    { TCP: { 8443: { HTTPS: true } } },
    { Foreground: { other: { TCP: { 8443: { HTTPS: true } } } } },
  ]) { await recovery.check(); await recovery.check(); }
  assert.equal(starts, 0);
  assert(states.length > 0 && states.every((v) => v === false));
});
test("a stopped or already checking link cannot spawn another recovery", async () => {
  let resolve,
    starts = 0;
  const recovery = new PrivateLinkRecovery({
    origin,
    target,
    inspect: () => new Promise((r) => (resolve = r)),
    restart: async () => starts++,
    available: () => assert.fail("Stopped"),
  });
  const pending = recovery.check();
  await recovery.check();
  recovery.stop();
  resolve({});
  await pending;
  assert.equal(starts, 0);
});

test("background service preserves scope and paths without copying secrets or recursively installing itself", () => {
  const plist = backgroundPlist(
    {
      local: false,
      port: 4318,
      httpsPort: 9443,
      folders: ["/Users/A&B/My Files"],
      agentPolicyFile: "/private/policy.json",
    },
    "/path with spaces/reach",
    "/node",
    {
      PATH: "/bin",
      REACH_DATA: "/private/state",
      AWS_SECRET_ACCESS_KEY: "NEVER-COPY",
    },
    "/logs",
  );
  assert(plist.includes("<key>KeepAlive</key><true/>"));
  assert(
    plist.includes(
      `<string>${path.join("/path with spaces/reach", "scripts/bootstrap.mjs")}</string>`,
    ),
  );
  assert(plist.includes("/Users/A&amp;B/My Files"));
  assert(plist.includes("/private/policy.json"));
  assert(plist.includes("/private/state"));
  assert(!plist.includes("NEVER-COPY"));
  assert(!plist.includes("--background"));
});

test(
  "suspending transport closes remote sockets but keeps terminal work and credentials alive",
  // Windows needs time to start and reap ConPTY; transport assertions are unchanged.
  { timeout: process.platform === "win32" ? 30000 : 10000 },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-recovery-"));
    const reach = await createReach({
      roots: [dir],
      dataDir: path.join(dir, "private"),
    });
    await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${reach.server.address().port}`;
    const owner = reach.auth.issue("test", ALL_SCOPES);
    const terminal = reach.terminals.create({
      cwd: dir,
      name: "recovery",
      clientId: owner.id,
    });
    const ws = new WebSocket(url.replace("http:", "ws:") + "/ws/terminal");
    try {
      await once(ws, "open");
      const snapshot = once(ws, "message", { signal: t.signal });
      ws.send(
        JSON.stringify({
          type: "auth",
          token: owner.token,
          sessionId: terminal.id,
        }),
      );
      assert.equal(JSON.parse((await snapshot)[0]).type, "snapshot");
      const pong = new Promise((resolve, reject) => {
        t.signal.addEventListener("abort", () => reject(t.signal.reason), { once: true });
        ws.on("message", (data) => {
          if (JSON.parse(data).type === "pong") resolve();
        });
      });
      ws.send(JSON.stringify({ type: "ping" }));
      await pong;
      const closed = once(ws, "close", { signal: t.signal });
      reach.setTransportAvailable(false);
      await closed;
      assert.equal(
        (
          await fetch(url + "/api/device", {
            headers: { Authorization: `Bearer ${owner.token}` },
          })
        ).status,
        503,
      );
      assert.equal(reach.terminals.get(terminal.id).status, "running");
      reach.setTransportAvailable(true);
      assert.equal(
        (
          await fetch(url + "/api/device", {
            headers: { Authorization: `Bearer ${owner.token}` },
          })
        ).status,
        200,
      );
      assert.equal(reach.terminals.get(terminal.id).status, "running");
    } finally {
      ws.terminate();
      await reach.close();
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  },
);
