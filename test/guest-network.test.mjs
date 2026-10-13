import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transpile } from "./helpers/transpile.mjs";

const outputText = transpile(await fs.readFile(
    new URL("../src/guest-network.ts", import.meta.url),
    "utf8",
  ));
const { observeGuestNetwork } = await import(
  `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
);
class Socket extends EventTarget {
  static OPEN = 1;
  constructor(url, protocols) {
    super();
    if (protocols === "fail")
      throw new DOMException("blocked", "SecurityError");
    this.url = url;
    this.protocols = protocols;
  }
}

test("observes only Tailscale startup; request arguments, responses and socket protocols pass through", async () => {
  const calls = [],
    seen = [];
  const response = new Response("public key");
  const scope = {
    fetch: async (...args) => {
      calls.push(args);
      return response;
    },
    WebSocket: Socket,
  };
  const stop = observeGuestNetwork(scope, (step) => seen.push(step));
  const url = "https://controlplane.tailscale.com/key?v=123";
  const init = { method: "GET", signal: new AbortController().signal };
  assert.equal(await scope.fetch(url, init), response);
  assert.deepEqual(calls[0], [url, init]);
  assert.deepEqual(seen, ["https-connecting", "https-ready"]);
  await scope.fetch("https://owner.tail.ts.net/api/files?private=data");
  await scope.fetch("https://controlplane.tailscale.com.attacker.test/key");
  assert.equal(seen.length, 2);
  const ws = new scope.WebSocket(
    "wss://controlplane.tailscale.com/ts2021?X-Tailscale-Handshake=private",
    ["ts2021"],
  );
  assert.ok(ws instanceof Socket);
  assert.deepEqual(ws.protocols, ["ts2021"]);
  assert.equal(scope.WebSocket.OPEN, 1);
  ws.dispatchEvent(new Event("open"));
  assert.deepEqual(seen.slice(-2), ["socket-connecting", "socket-ready"]);
  assert.doesNotMatch(JSON.stringify(seen), /private|Handshake|https:|wss:/);
  stop();
});

test("reports HTTPS failures without changing the original rejection or exposing its message", async () => {
  const error = Error("sensitive original message"),
    seen = [];
  const scope = {
    fetch: async () => {
      throw error;
    },
    WebSocket: Socket,
  };
  observeGuestNetwork(scope, (step) => seen.push(step));
  await assert.rejects(
    scope.fetch(new Request("https://controlplane.tailscale.com/key")),
    (e) => e === error,
  );
  assert.deepEqual(seen, ["https-connecting", "https-failed"]);
});

test("reports socket blocking, then detaches before the private transport is installed", () => {
  const seen = [],
    nativeFetch = async () => new Response();
  const scope = { fetch: nativeFetch, WebSocket: Socket };
  const stop = observeGuestNetwork(scope, (step) => seen.push(step));
  assert.throws(
    () =>
      new scope.WebSocket("wss://controlplane.tailscale.com/ts2021", "fail"),
    /blocked/,
  );
  assert.deepEqual(seen, ["socket-connecting", "socket-failed"]);
  const ws = new scope.WebSocket("wss://controlplane.tailscale.com/ts2021");
  ws.dispatchEvent(new Event("error"));
  assert.equal(seen.at(-1), "socket-failed");
  stop();
  assert.equal(scope.fetch, nativeFetch);
  assert.equal(scope.WebSocket, Socket);
  const count = seen.length;
  ws.dispatchEvent(new Event("open"));
  assert.equal(seen.length, count);
});

test("diagnostics cannot break networking or overwrite a later transport", async () => {
  const response = new Response("ok");
  const scope = { fetch: async () => response, WebSocket: Socket };
  const stop = observeGuestNetwork(scope, () => {
    throw Error("render failure");
  });
  assert.equal(
    await scope.fetch("https://controlplane.tailscale.com/key"),
    response,
  );
  const replacement = async () => new Response("private");
  scope.fetch = replacement;
  stop();
  assert.equal(scope.fetch, replacement);
});
