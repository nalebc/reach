import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startDom, settle } from "./dom/harness.mjs";

// One address, in the browser: signed in without the Tailscale app, the page's
// own tailnet node carries Reach's requests. Whether the app is on must still
// be asked over the phone's own connection.
let dom, watchForApp, installTailnet, api;
const native = [];
let appOn = false;
before(async () => {
  dom = await startDom({ mobile: true });
  // The browser's own fetch: the computer answers it only with the app on.
  dom.window.fetch = async (url) => {
    native.push(String(url));
    return appOn
      ? new Response(JSON.stringify({ product: "Reach", instance: "i1" }), { status: 200 })
      : new Response("Not found.", { status: 404 });
  };
  ({ watchForApp } = await dom.load("/src/app-watch.ts"));
  ({ installTailnet } = await dom.load("/src/tailnet-transport.ts"));
  api = await dom.load("/src/api.ts");
});
after(async () => dom?.close());

const config = {
  product: "Reach",
  origin: "https://mac.t.ts.net:8443",
  home: "https://mac.t.ts.net",
  name: "Mac",
  instance: "i1",
  tailnet: null,
};

test("the app-is-on banner asks the phone's own connection, not the page's node", async () => {
  // The page's node always reaches the computer.
  const throughNode = [];
  installTailnet(
    {
      fetch(request) {
        throughNode.push(request.url);
        return {
          response: Promise.resolve({
            status: 200,
            statusText: "OK",
            headers: ["content-type", "application/json"],
            read: (() => {
              let sent = false;
              return async () =>
                sent ? null : ((sent = true), new TextEncoder().encode('{"product":"Reach","instance":"i1"}'));
            })(),
            cancel() {},
          }),
          abort() {},
        };
      },
      websocket() {},
    },
    "t.ts.net",
  );
  // In a browser the global fetch is the window's: now the node's router.
  globalThis.fetch = dom.window.fetch;
  const timer = watchForApp(config, 20);
  try {
    await settle(120);
    const pill = () => dom.document.querySelector(".start-switch");
    assert.equal(pill(), null, "no banner while the app is off");
    assert.ok(native.length >= 2, "checked more than once");
    assert.ok(native.every((u) => u === "https://mac.t.ts.net/api/health"), "at the one address");
    assert.deepEqual(throughNode, [], "never through the page's node");
    appOn = true;
    await settle(80);
    assert.match(pill()?.textContent || "", /Tailscale app is on/);
  } finally {
    clearInterval(timer);
  }
});

// With the app on and signed in from the browser are two Tailscale devices,
// each approved on its own: each way keeps its own saved computers.
test("each way in keeps its own approval: turning the app off and on never asks again", () => {
  const ls = dom.window.localStorage;
  const html = dom.document.documentElement;
  ls.clear();
  const mac = (token) => ({ id: "mac", name: "Mac", url: "https://mac.t.ts.net", token, platform: "darwin" });
  try {
    delete html.dataset.connection; // the Tailscale app
    api.savePeers([mac("APP")]);
    ls.setItem(api.activeKey(), "mac");
    html.dataset.connection = "browser"; // app off: signed in from the browser
    assert.deepEqual(api.readPeers(), [], "the app's approval isn't this browser device's");
    api.savePeers([mac("BROWSER")]);
    ls.setItem(api.activeKey(), "mac");
    delete html.dataset.connection; // app back on
    assert.equal(api.readPeers()[0].token, "APP", "still approved");
    html.dataset.connection = "browser";
    assert.equal(api.readPeers()[0].token, "BROWSER", "and so is the browser way");
    assert.deepEqual(
      Object.keys({ ...ls }).sort(),
      ["reach.active", "reach.browser.active", "reach.browser.devices", "reach.devices"],
    );
  } finally {
    delete html.dataset.connection;
    ls.clear();
  }
});

test("what this address saved before (only ever the browser way) moves to it, once", () => {
  const fake = (entries) => {
    const store = new Map(entries);
    return {
      store,
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
  };
  const s = fake([["reach.devices", "[browser]"], ["reach.active", "mac"]]);
  // The private address (its port) was always the app way; development too.
  api.separateWays(s, { port: "8443", hostname: "mac.t.ts.net" });
  api.separateWays(s, { port: "", hostname: "localhost" });
  assert.equal(s.store.get("reach.devices"), "[browser]", "left alone");
  api.separateWays(s, { port: "", hostname: "mac.t.ts.net" });
  assert.deepEqual(Object.fromEntries(s.store), {
    "reach.browser.devices": "[browser]",
    "reach.browser.active": "mac",
    "reach.ways": "1",
  });
  // Once only: what the app way saves from now on stays its own.
  s.store.set("reach.devices", "[app]");
  api.separateWays(s, { port: "", hostname: "mac.t.ts.net" });
  assert.equal(s.store.get("reach.devices"), "[app]");
  // Never over something the browser way saved already.
  const t = fake([["reach.devices", "[old]"], ["reach.browser.devices", "[kept]"]]);
  api.separateWays(t, { port: "", hostname: "mac.t.ts.net" });
  assert.equal(t.store.get("reach.browser.devices"), "[kept]");
  assert.equal(t.store.has("reach.devices"), false, "the app way starts at Connect");
});

test("clean", () => assert.deepEqual(dom.errors, []));
