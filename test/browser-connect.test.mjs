import test from "node:test";
import assert from "node:assert/strict";
import {
  createReachClient,
  privateOrigin,
} from "../experiments/browser-connect/client.mjs";
const origin = "https://mac.example.ts.net:8446";
const response = (status, data) => ({
  status,
  body: Buffer.from(JSON.stringify(data)).toString("base64"),
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

test("browser transport accepts only private HTTPS origins", () => {
  assert.equal(privateOrigin(origin + "/"), origin);
  for (const bad of [
    "http://mac.example.ts.net",
    "https://example.com",
    "https://mac.example.ts.net.evil.test",
    origin + "/api",
    origin + "?token=x",
    "https://user:pass@mac.example.ts.net",
  ])
    assert.throws(() => privateOrigin(bad));
});
test("browser HTTP uses only the explicit WASM adapter; credentials are headers, not URLs", async () => {
  const calls = [];
  const client = createReachClient(
    {
      reachRequest: async (...args) => {
        calls.push(args);
        return response(200, { name: "Test Mac" });
      },
    },
    origin,
  );
  client.authenticate("fixture-token");
  assert.deepEqual(await client.request("/api/device"), { name: "Test Mac" });
  assert.deepEqual(calls, [
    [origin, "/api/device", "GET", "fixture-token", ""],
  ]);
  const broken = createReachClient(
    {
      reachRequest: async () => {
        throw Error("relay unavailable");
      },
    },
    origin,
  );
  await assert.rejects(broken.request("/api/device"), /relay unavailable/);
});
test("revocation clears credentials, closes sockets, rejects stale in-flight replies and prevents reconnect", async () => {
  const pending = deferred();
  let revoked = 0,
    callback;
  const closed = [],
    sent = [];
  const ipn = {
    reachRequest: async (_origin, route) =>
      route === "/api/device"
        ? response(401, { error: "Revoked" })
        : pending.promise,
    reachSocketOpen: async (_origin, cb) => {
      callback = cb;
      return 7;
    },
    reachSocketSend: async (id, data) => {
      sent.push([id, JSON.parse(data)]);
      return true;
    },
    reachSocketClose: (id) => closed.push(id),
  };
  const client = createReachClient(ipn, origin, () => revoked++);
  client.authenticate("fixture-token");
  const socket = await client.terminal("session-1", () => {});
  assert.deepEqual(sent[0], [
    7,
    { type: "auth", token: "fixture-token", sessionId: "session-1" },
  ]);
  const stale = client.request("/api/files");
  await assert.rejects(client.request("/api/device"), /Revoked/);
  pending.resolve(response(200, { items: ["private"] }));
  await assert.rejects(stale, /Access ended/);
  assert.equal(revoked, 1);
  assert.deepEqual(closed, [7]);
  await assert.rejects(
    socket.send({ type: "input", data: "x" }),
    /disconnected/,
  );
  await assert.rejects(
    client.terminal("session-1", () => {}),
    /Approve/,
  );
  callback({ type: "close", code: 4001 });
  assert.equal(revoked, 1);
});
test("terminal revocation stops the client, network failure permits an explicit reconnect", async () => {
  let callback,
    revoked = 0,
    next = 0;
  const ipn = {
    reachSocketOpen: async (_origin, cb) => {
      callback = cb;
      return ++next;
    },
    reachSocketSend: async () => true,
    reachSocketClose: () => {},
  };
  const client = createReachClient(ipn, origin, () => revoked++);
  client.authenticate("fixture-token");
  await client.terminal("one", () => {});
  callback({ type: "close", code: 1006 });
  await client.terminal("one", () => {});
  assert.equal(next, 2);
  callback({ type: "close", code: 4001 });
  assert.equal(revoked, 1);
  await assert.rejects(
    client.terminal("one", () => {}),
    /Approve/,
  );
});
test("disconnect during a pending WebSocket handshake closes the late connection", async () => {
  const dial = deferred(),
    closed = [];
  const client = createReachClient(
    {
      reachSocketOpen: () => dial.promise,
      reachSocketClose: (id) => closed.push(id),
    },
    origin,
  );
  client.authenticate("fixture-token");
  const result = client.terminal("one", () => {});
  client.stop();
  dial.resolve(9);
  await assert.rejects(result, /Access ended/);
  assert.deepEqual(closed, [9]);
});
