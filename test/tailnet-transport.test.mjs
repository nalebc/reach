import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transpile } from "./helpers/transpile.mjs";

// The browser tailnet path (no Tailscale app): requests and WebSockets travel
// through the page's own node. These fakes stand in for the Go side.
async function load(file) {
  const source = await fs.readFile(
    new URL(`../src/${file}`, import.meta.url),
    "utf8",
  );
  let outputText = transpile(source);
  // The transport now shares the original native browser handles with the
  // signed gateway. Keep this pure TS fixture's dependency in the same data
  // module graph, without starting a browser/node or an OS connection.
  if (file === "tailnet-transport.ts") {
    const native = transpile(await fs.readFile(new URL("../src/native-browser.ts", import.meta.url), "utf8"));
    outputText = outputText.replace('from "./native-browser"', `from "data:text/javascript;base64,${Buffer.from(native).toString("base64")}"`);
  }
  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
}
const transport = await load("tailnet-transport.ts");
const flow = await load("start-flow.ts");

function fakeNode() {
  const calls = [];
  const sockets = [];
  const node = {
    calls,
    sockets,
    respond: null,
    fetch(request) {
      calls.push(request);
      let aborted = false;
      return {
        response: new Promise((resolve, reject) =>
          queueMicrotask(() => {
            if (aborted) return reject(Error("context canceled"));
            node.respond
              ? node.respond(request, resolve, reject)
              : reject(Error("dial failed"));
          }),
        ),
        abort: () => {
          aborted = true;
          calls.push("abort");
        },
      };
    },
    websocket(url, cb) {
      const sent = [];
      let closed = 0;
      const socket = {
        url,
        cb,
        sent,
        get closes() {
          return closed;
        },
        send: (d) => sent.push(d),
        close: (code, reason) => {
          closed++;
          sent.push(["close", code, reason]);
        },
        buffered: () => 42,
      };
      sockets.push(socket);
      return socket;
    },
  };
  return node;
}
const head = (status, headers, chunks = []) => {
  const queue = [...chunks];
  const log = [];
  return {
    log,
    status,
    statusText: "OK",
    headers,
    read: async () => {
      log.push("read");
      return queue.length ? new TextEncoder().encode(queue.shift()) : null;
    },
    cancel: () => log.push("cancel"),
  };
};

test("routes only this tailnet's names and Tailscale addresses", () => {
  const routed = transport.tailnetRouter("tail1234.ts.net");
  const yes = [
    "https://mac.tail1234.ts.net:8443/api",
    "wss://mac.tail1234.ts.net:8443/ws/screen",
    "https://100.64.0.1/",
    "https://100.127.255.254/",
  ];
  const no = [
    "https://reach.example/",
    "https://mac.other.ts.net/",
    "https://tail1234.ts.net.evil.test/",
    "https://100.63.0.1/",
    "https://100.128.0.1/",
    "https://login.tailscale.com/",
  ];
  for (const u of yes) assert.equal(routed(new URL(u)), true, u);
  for (const u of no) assert.equal(routed(new URL(u)), false, u);
});

test("fetch through the node returns a real streaming Response", async () => {
  const node = fakeNode();
  let h;
  node.respond = (req, resolve) =>
    resolve(
      (h = head(
        206,
        ["content-type", "application/json", "etag", '"v1"'],
        ['{"a":', "1}"],
      )),
    );
  const response = await transport.tailnetFetch(
    node,
    "https://mac.t.ts.net:8443/api/x",
    {
      method: "POST",
      headers: { Authorization: "Bearer t", Range: "bytes=4-" },
      body: '{"q":1}',
      redirect: "error",
    },
  );
  assert.equal(response.status, 206);
  assert.equal(response.url, "https://mac.t.ts.net:8443/api/x");
  assert.equal(response.headers.get("etag"), '"v1"');
  assert.deepEqual(await response.json(), { a: 1 });
  assert.equal(node.calls.length, 1, "the mutation is dispatched once");
  const sent = node.calls[0];
  assert.equal(sent.method, "POST");
  assert.equal(sent.redirect, "error");
  assert.equal(new TextDecoder().decode(sent.body), '{"q":1}');
  const headers = Object.fromEntries(
    sent.headers.flatMap((v, i, a) => (i % 2 ? [] : [[v, a[i + 1]]])),
  );
  assert.equal(headers.authorization, "Bearer t");
  assert.equal(headers.range, "bytes=4-");
  assert.deepEqual(h.log, ["read", "read", "read"]);
});

test("fetch: a mutation aborted during streaming request body preparation is never dispatched", async () => {
  // Request, body consumption and cancellation are real browser-compatible
  // primitives. Only the Go/WASM dispatch boundary is controlled here; this
  // does not qualify authenticated tailnet or physical-device behavior.
  const node = fakeNode();
  node.respond = (request, resolve) => resolve(head(204, []));
  const controller = new AbortController();
  const reason = new DOMException("Cancelled while preparing the write.", "AbortError");
  let bodyController, beganReading;
  const reading = new Promise((resolve) => { beganReading = resolve; });
  const body = new ReadableStream({
    start(controller) { bodyController = controller; },
    pull() { beganReading(); },
  });
  const request = new Request("https://mac.t.ts.net:8443/api/write", {
    method: "POST",
    body,
    duplex: "half",
    signal: controller.signal,
  });
  const pending = transport.tailnetFetch(node, request).then(
    (response) => ({ response }),
    (error) => ({ error }),
  );
  await reading;
  assert.equal(node.calls.length, 0, "the open body keeps dispatch pending");
  controller.abort(reason);
  bodyController.enqueue(new TextEncoder().encode("write these bytes"));
  bodyController.close();
  const outcome = await pending;
  await outcome.response?.body?.cancel();
  assert.equal(node.calls.length, 0, "cancellation during preparation must prevent the write");
  assert.equal(outcome.error, reason, "preserve the caller's exact cancellation reason");
});

test("fetch: empty bodies, failures and aborts behave like the browser's", async () => {
  const node = fakeNode();
  node.respond = (req, resolve) => resolve(head(204, []));
  const empty = await transport.tailnetFetch(
    node,
    "https://mac.t.ts.net/api/x",
    { method: "DELETE" },
  );
  assert.equal(empty.status, 204);
  assert.equal(empty.body, null);
  assert.equal(node.calls[0].body, null);

  node.respond = null;
  await assert.rejects(
    transport.tailnetFetch(node, "https://mac.t.ts.net/api/x"),
    (e) => e instanceof TypeError,
  );

  const controller = new AbortController();
  node.respond = () => {}; // never answers
  const pending = transport.tailnetFetch(node, "https://mac.t.ts.net/api/x", {
    signal: controller.signal,
  });
  await new Promise((r) => setTimeout(r, 5));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.ok(node.calls.includes("abort"));

  const already = new AbortController();
  already.abort();
  const before = node.calls.length;
  await assert.rejects(
    transport.tailnetFetch(node, "https://mac.t.ts.net/api/x", {
      signal: already.signal,
    }),
    { name: "AbortError" },
  );
  assert.equal(node.calls.length, before, "an aborted request is never sent");
});

test("WebSocket: open, binary types, error before close, real close codes", async () => {
  const node = fakeNode();
  const ws = new transport.TailnetSocket(
    node,
    "wss://mac.t.ts.net:8443/ws/screen",
    "reach.v2",
  );
  const events = [];
  ws.onopen = () => events.push(["open", ws.readyState, ws.protocol]);
  ws.addEventListener("message", (e) =>
    events.push([
      "message",
      e.data instanceof ArrayBuffer
        ? "ab"
        : e.data instanceof Blob
          ? "blob"
          : e.data,
    ]),
  );
  ws.onerror = () => events.push(["error", ws.readyState]);
  ws.onclose = (e) => events.push(["close", e.code, e.reason, e.wasClean]);
  assert.equal(ws.readyState, 0);
  assert.throws(() => ws.send("early"), { name: "InvalidStateError" });
  const s = node.sockets[0];
  assert.deepEqual(s.cb.protocols, ["reach.v2"]);
  s.cb.open("reach.v2");
  s.cb.message("text");
  s.cb.message(new Uint8Array([1, 2]));
  ws.binaryType = "arraybuffer";
  s.cb.message(new Uint8Array([3]));
  assert.equal(ws.bufferedAmount, 42);
  s.cb.close(1006, "", false);
  s.cb.close(1000, "again", true); // ignored: already closed
  assert.deepEqual(events, [
    ["open", 1, "reach.v2"],
    ["message", "text"],
    ["message", "blob"],
    ["message", "ab"],
    ["error", 3],
    ["close", 1006, "", false],
  ]);

  const clean = new transport.TailnetSocket(node, "wss://mac.t.ts.net/ws/x");
  const codes = [];
  clean.onclose = (e) => codes.push([e.code, e.reason, e.wasClean]);
  clean.onerror = () => codes.push("error");
  node.sockets[1].cb.open("");
  clean.close(4001, "bye");
  clean.close(); // idempotent
  assert.equal(clean.readyState, 2);
  assert.deepEqual(node.sockets[1].sent, [["close", 4001, "bye"]]);
  node.sockets[1].cb.close(4001, "bye", true);
  assert.deepEqual(codes, [[4001, "bye", true]]);
});

test("WebSocket: sends keep their order around Blobs; handler errors stay out of Go", async () => {
  const node = fakeNode();
  const ws = new transport.TailnetSocket(node, "wss://mac.t.ts.net/ws/x");
  const s = node.sockets[0];
  s.cb.open("");
  ws.send("a");
  ws.send(new Blob([new Uint8Array([9])]));
  ws.send("b");
  ws.send(new Uint8Array([7, 8]).subarray(1));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(
    s.sent.map((d) => (typeof d === "string" ? d : [...d])),
    ["a", [9], "b", [8]],
  );
  ws.onmessage = () => {
    throw Error("app bug");
  };
  const reported = [];
  const original = globalThis.reportError;
  globalThis.reportError = (e) => reported.push(e.message);
  try {
    assert.doesNotThrow(() => s.cb.message("x"));
  } finally {
    globalThis.reportError = original;
  }
  assert.deepEqual(reported, ["app bug"]);
});

test("installTailnet sends tailnet traffic through the node and the rest natively", async () => {
  const node = fakeNode();
  node.respond = (req, resolve) => resolve(head(200, [], ["ok"]));
  const native = [];
  class NativeSocket {
    constructor(url) {
      native.push(["ws", String(url)]);
    }
  }
  globalThis.window = {
    fetch: async (input) => {
      native.push(["fetch", String(input)]);
      return new Response("native");
    },
    WebSocket: NativeSocket,
  };
  globalThis.location = { href: "https://mac.t.ts.net/" };
  try {
    assert.equal(transport.tailnetBrowser(), false);
    transport.installTailnet(node, "t.ts.net");
    assert.equal(transport.tailnetBrowser(), true);
    assert.equal(
      await (await window.fetch("https://mac.t.ts.net:8443/api/health")).text(),
      "ok",
    );
    assert.equal(
      await (await window.fetch("/reach-start.json")).text(),
      "native",
      "the page's own files stay native",
    );
    assert.equal(
      await (await window.fetch("/assets/api/x.js")).text(),
      "native",
      "only paths that start with Reach's own",
    );
    assert.equal(
      await (await window.fetch("https://example.com/x")).text(),
      "native",
    );
    // One address: Reach answers at the page's own address too, through the node.
    assert.equal(await (await window.fetch("/api/health")).text(), "ok");
    assert.equal(
      await (await window.fetch("https://mac.t.ts.net/api/device")).text(),
      "ok",
    );
    assert.equal(
      await (await window.fetch("https://mac.t.ts.net/download/abc")).text(),
      "ok",
    );
    const ws = new window.WebSocket("wss://mac.t.ts.net:8443/ws/presence");
    assert.ok(ws instanceof transport.TailnetSocket);
    assert.ok(
      new window.WebSocket("wss://mac.t.ts.net/ws/screen") instanceof
        transport.TailnetSocket,
    );
    new window.WebSocket("wss://example.com/x");
    assert.equal(window.WebSocket.OPEN, 1);
    assert.equal(window.WebSocket.CLOSED, 3);
    assert.deepEqual(native, [
      ["fetch", "/reach-start.json"],
      ["fetch", "/assets/api/x.js"],
      ["fetch", "https://example.com/x"],
      ["ws", "wss://example.com/x"],
    ]);
    assert.deepEqual(
      node.calls.map((r) => r.url),
      [
        "https://mac.t.ts.net:8443/api/health",
        "https://mac.t.ts.net/api/health",
        "https://mac.t.ts.net/api/device",
        "https://mac.t.ts.net/download/abc",
      ],
    );
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});

test("start page: config, app-first probe, and where it sends the phone", async () => {
  const good = {
    product: "Reach",
    origin: "https://mac.tail1234.ts.net:8443",
    name: "Owner's MacBook",
    instance: "abc",
    tailnet: { wasm: "reach-tailnet.1a2b.wasm", exec: "wasm_exec.3c4d.js" },
  };
  assert.deepEqual(flow.parseStartConfig(good), good);
  assert.equal(
    flow.parseStartConfig({
      ...good,
      tailnet: { wasm: "../x.wasm", exec: "a.js" },
    }).tailnet,
    null,
  );
  for (const origin of [
    "http://mac.t.ts.net:8443",
    "https://evil.example",
    "https://mac.t.ts.net:8443/path",
    "nope",
  ])
    assert.equal(flow.parseStartConfig({ ...good, origin }), null, origin);
  assert.equal(flow.parseStartConfig({ ...good, product: "Other" }), null);
  assert.equal(flow.tailnetSuffix(good.origin), "tail1234.ts.net");
  // One address: the same computer's name without the port. Anything else is
  // dropped, never trusted, and the page still works through `origin`.
  const one = { ...good, home: "https://mac.tail1234.ts.net" };
  assert.deepEqual(flow.parseStartConfig(one), one);
  assert.equal(flow.ownOrigin(flow.parseStartConfig(one)), one.home);
  assert.equal(flow.ownOrigin(flow.parseStartConfig(good)), good.origin);
  for (const home of [
    "https://other.tail1234.ts.net",
    "http://mac.tail1234.ts.net",
    "https://mac.tail1234.ts.net/",
    "https://mac.tail1234.ts.net/x",
    "nope",
    42,
  ]) {
    const parsed = flow.parseStartConfig({ ...good, home });
    assert.equal(parsed.home, undefined, String(home));
    assert.equal(flow.ownOrigin(parsed), good.origin, String(home));
  }

  const answer =
    (body, ok = true) =>
    async () => ({ ok, json: async () => body });
  assert.equal(
    await flow.probeDirect(good, answer({ product: "Reach", instance: "abc" })),
    true,
  );
  assert.equal(
    await flow.probeDirect(good, answer({ product: "Reach", instance: "old" })),
    false,
    "another Reach must not count",
  );
  assert.equal(await flow.probeDirect(good, answer({}, false)), false);
  assert.equal(
    await flow.probeDirect(good, async () => {
      throw TypeError("offline");
    }),
    false,
  );
  let asked;
  await flow.probeDirect(good, async (url, init) => {
    asked = [url, init.redirect, init.cache];
    throw TypeError("x");
  });
  assert.deepEqual(asked, [
    "https://mac.tail1234.ts.net:8443/api/health",
    "error",
    "no-store",
  ]);

  assert.equal(
    flow.directUrl(good, { pathname: "/", hash: "#pair=12345678" }),
    "https://mac.tail1234.ts.net:8443/#pair=12345678",
  );
  assert.equal(
    flow.directUrl(good, { pathname: "/guest", hash: "#invite=x" }),
    "https://mac.tail1234.ts.net:8443/guest#invite=x",
  );
  assert.equal(
    flow.directUrl(good, { pathname: "/elsewhere", hash: "" }),
    "https://mac.tail1234.ts.net:8443/",
  );

  const status = (peers) => ({ self: { state: "Running" }, peers });
  assert.equal(
    flow.homeReachable(
      status([{ dnsName: "mac.tail1234.ts.net", online: true }]),
      good.origin,
    ),
    "ok",
  );
  assert.equal(
    flow.homeReachable(
      status([{ dnsName: "MAC.tail1234.ts.net.", online: false }]),
      good.origin,
    ),
    "offline",
  );
  assert.equal(
    flow.homeReachable(
      status([{ dnsName: "other.tail1234.ts.net", online: true }]),
      good.origin,
    ),
    "missing",
  );

  assert.equal(
    flow.browserHostname(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
    ),
    "iphone-browser",
  );
  assert.equal(
    flow.browserHostname("Mozilla/5.0 (Linux; Android 15)"),
    "android-browser",
  );
  assert.equal(
    flow.appLink("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"),
    "https://apps.apple.com/app/tailscale/id1470499037",
  );
  assert.equal(
    flow.appLink("Mozilla/5.0 (Linux; Android 15)"),
    "https://play.google.com/store/apps/details?id=com.tailscale.ipn",
  );
  assert.equal(
    flow.appLink("Mozilla/5.0 (X11; Linux x86_64)"),
    "https://tailscale.com/download",
  );
});
