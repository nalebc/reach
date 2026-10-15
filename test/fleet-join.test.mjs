import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// The phone joins your linked computers by itself, on a one-use ticket from
// the computer it's signed in to: the linked computer approves it right away
// or refuses. Otherwise nothing is added, and it never waits forever.
const root = fileURLToPath(new URL("..", import.meta.url));
const { createServer } = await import("vite");
const vite = await createServer({
  root,
  configFile: false,
  logLevel: "silent",
  appType: "custom",
  // No WebSocket listener (test/dom/harness.mjs says why).
  server: { middlewareMode: true, hmr: false, ws: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
globalThis.localStorage ??= {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};
const { joinComputer } = await vite.ssrLoadModule("/src/fleet-join.ts");
test.after(() => vite.close());

function computer(script) {
  const seen = [];
  const fetcher = async (url, init = {}) => {
    const route = new URL(url).pathname;
    seen.push([
      init.method || "GET",
      route,
      init.body ? JSON.parse(init.body) : undefined,
    ]);
    const answer = script(route, seen.length);
    const http = answer.http || 200;
    return {
      ok: http < 400,
      status: http,
      json: async () => answer.body ?? answer,
    };
  };
  return { fetcher, seen };
}
const ticket = async () => "t1";
const fast = { sleep: async () => {}, waitMs: 5000, ticket };

test("joins a linked computer that approves at once", async () => {
  let polls = 0;
  const { fetcher, seen } = computer((route) => {
    if (route === "/api/auth/method")
      return { method: "tailscale", eligible: true };
    if (route === "/api/auth/requests")
      return { id: "req-1", secret: "s3cret" };
    polls++;
    return polls < 2
      ? { status: "pending" }
      : {
          status: "approved",
          token: "tok",
          device: {
            id: "dev-b",
            computerId: "cmp-b",
            name: "Mac B",
            platform: "darwin",
          },
        };
  });
  const peer = await joinComputer("https://mac-b.t.ts.net:8443", "My iPhone", {
    fetcher,
    ...fast,
  });
  assert.deepEqual(peer, {
    id: "dev-b",
    computerId: "cmp-b",
    name: "Mac B",
    platform: "darwin",
    url: "https://mac-b.t.ts.net:8443",
    token: "tok",
  });
  assert.deepEqual(seen, [
    ["GET", "/api/auth/method", undefined],
    ["POST", "/api/auth/requests", { name: "My iPhone", ticket: "t1" }],
    ["POST", "/api/auth/requests/req-1", { secret: "s3cret" }],
    ["POST", "/api/auth/requests/req-1", { secret: "s3cret" }],
  ]);
});

test("adds nothing when the computer would need its own approval, declines, or isn't for this account", async () => {
  let clock = 0;
  const pending = computer((route) =>
    route === "/api/auth/method"
      ? { method: "tailscale", eligible: true }
      : route === "/api/auth/requests"
        ? { id: "r", secret: "s" }
        : { status: "pending" },
  );
  assert.equal(
    await joinComputer("https://mac-b.t.ts.net:8443", "My iPhone", {
      fetcher: pending.fetcher,
      ticket,
      sleep: async () => (clock += 700),
      now: () => clock,
      waitMs: 3000,
    }),
    null,
  );
  assert.ok(pending.seen.length <= 8, "stops after the wait");

  const denied = computer((route) =>
    route === "/api/auth/method"
      ? { method: "tailscale", eligible: true }
      : route === "/api/auth/requests"
        ? { id: "r", secret: "s" }
        : { status: "denied" },
  );
  assert.equal(
    await joinComputer("https://mac-b.t.ts.net:8443", "x", {
      fetcher: denied.fetcher,
      ...fast,
    }),
    null,
  );

  const notOwner = computer(() => ({ method: "tailscale", eligible: false }));
  assert.equal(
    await joinComputer("https://mac-b.t.ts.net:8443", "x", {
      fetcher: notOwner.fetcher,
      ...fast,
    }),
    null,
  );
  assert.equal(notOwner.seen.length, 1, "no request is created");

  const refused = computer(() => ({ http: 403, body: { error: "origin" } }));
  assert.equal(
    await joinComputer("https://mac-b.t.ts.net:8443", "x", {
      fetcher: refused.fetcher,
      ...fast,
    }),
    null,
  );

  const bad = computer(() => ({}));
  assert.equal(
    await joinComputer("https://mac-b.t.ts.net:8443/path", "x", {
      fetcher: bad.fetcher,
      ...fast,
    }),
    null,
  );
  assert.equal(
    await joinComputer("http://mac-b.t.ts.net", "x", {
      fetcher: bad.fetcher,
      ...fast,
    }),
    null,
  );
  assert.equal(bad.seen.length, 0);
});

test("never leaves a request waiting: a refused ticket or none to give ends it", async () => {
  const refused = computer((route) =>
    route === "/api/auth/method"
      ? { method: "tailscale", eligible: true }
      : { http: 403, body: { error: "Your other computer didn't vouch for this device." } },
  );
  assert.equal(
    await joinComputer("https://mac-b.t.ts.net:8443", "x", { fetcher: refused.fetcher, ...fast }),
    null,
  );
  assert.deepEqual(
    refused.seen.map(([m, r]) => `${m} ${r}`),
    ["GET /api/auth/method", "POST /api/auth/requests"],
  );
  const none = computer(() => ({ method: "tailscale", eligible: true }));
  assert.equal(
    await joinComputer("https://mac-b.t.ts.net:8443", "x", {
      fetcher: none.fetcher,
      ...fast,
      ticket: async () => { throw Error("Only your own approved devices can join your other computers."); },
    }),
    null,
  );
  assert.deepEqual(none.seen.map(([m, r]) => `${m} ${r}`), ["GET /api/auth/method"]);
});
