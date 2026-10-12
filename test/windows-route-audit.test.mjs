import test from "node:test";
import assert from "node:assert/strict";
import { foreignIngressRoute } from "../scripts/tailscale.mjs";

// Windows' keyed route (docs/parity/D-public-door.md §4.6): another route in
// Tailscale's serve config leading to Reach's loopback port is a path from
// Tailscale's own process without the key. Reach closes its route while one
// exists, however its host is spelled.
const Q = 51234;
const own = `http://127.0.0.1:${Q}/r-${"k".repeat(43)}`;
const host = "pc.example.ts.net";
const proxyTo = (proxy, port = 9999) => ({ TCP: { [port]: { HTTPS: true } }, Web: { [`${host}:${port}`]: { Handlers: { "/": { Proxy: proxy } } } } });
const forwardTo = (forward, port = 9999) => ({ TCP: { [port]: { TCPForward: forward } } });
const spellings = ["127.0.0.1", "127.1", "LOCALHOST", "localhost", "localhost.", "[::1]", "[::ffff:127.0.0.1]", "0.0.0.0", "pc", `${host}`, "192.168.1.20"];
// The same entry in the background config, a foreground session, or a service.
const placed = (entry) => [entry, { Foreground: { s: entry } }, { Services: { "svc:x": entry } }, { Foreground: { s: { Services: { "svc:y": entry } } } }];

test("a TCP forward or a proxy to Reach's port counts, however its host is spelled, wherever it is", () => {
  for (const name of spellings) {
    for (const entry of [forwardTo(`${name}:${Q}`), proxyTo(`http://${name}:${Q}`), proxyTo(`https+insecure://${name}:${Q}/x`), proxyTo(`${name}:${Q}`)])
      for (const config of placed(entry)) assert.equal(foreignIngressRoute(config, Q, own), true, `${name} ${JSON.stringify(config)}`);
  }
  // Reach's own exact target with the key in a different place is somebody else's.
  for (const config of placed(proxyTo(`http://127.0.0.1:${Q}/r-other`))) assert.equal(foreignIngressRoute(config, Q, own), true);
});

test("Reach's own target, other ports and Unix sockets don't count", () => {
  const ownRoutes = { Foreground: { a: proxyTo(own, 8443), b: { ...proxyTo(own, 443), AllowFunnel: { [`${host}:443`]: true } } } };
  assert.equal(foreignIngressRoute(ownRoutes, Q, own), false);
  for (const entry of [forwardTo("127.0.0.1:22"), proxyTo("http://127.0.0.1:3000"), proxyTo(`http://127.0.0.1:${Q + 1}`), proxyTo("unix:/tmp/reach/s"), proxyTo("http://127.0.0.1")])
    for (const config of placed(entry)) assert.equal(foreignIngressRoute(config, Q, own), false, JSON.stringify(entry));
  // Handlers without a proxy (text, a path, a redirect) lead nowhere.
  assert.equal(foreignIngressRoute({ TCP: { 80: { HTTP: true } }, Web: { [`${host}:80`]: { Handlers: { "/": { Text: "hi" }, "/r": { Redirect: "https://x" }, "/p": { Path: "C:\\x" } } } } }, Q, own), false);
  assert.equal(foreignIngressRoute({}, Q, own), false);
  assert.equal(foreignIngressRoute(null, Q, own), false);
});

test("a route whose port can't be read counts (fail closed); with no own target, every route to the port counts", () => {
  for (const entry of [forwardTo("nonsense"), forwardTo("127.0.0.1:"), proxyTo("http://[bad"), proxyTo("tcp://host"), proxyTo("3000")])
    assert.equal(foreignIngressRoute(entry, Q, own), true, JSON.stringify(entry));
  const ownRoutes = { Foreground: { a: proxyTo(own, 8443) } };
  assert.equal(foreignIngressRoute(ownRoutes, Q, own), false);
  assert.equal(foreignIngressRoute(ownRoutes, Q, ""), true, "Reach stopping: its own route still leads there");
  assert.equal(foreignIngressRoute(ownRoutes, Q), true);
  assert.equal(foreignIngressRoute({}, Q, ""), false);
});
