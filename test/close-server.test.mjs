import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { closeServer } from "./helpers/close-server.mjs";
import { findChrome, launchChrome, openTab } from "./helpers/headless-chrome.mjs";

// Oct 25: test/terminal-fit-chrome.test.mjs passed its checks on Intel macOS
// CI, then its cleanup's server.close() never returned and the file timed out
// at 180 s. These are the connections that keep a plain close() waiting.
const listen = async (handler = (req, res) => res.end("ok")) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, port: server.address().port };
};
const within = (promise, ms) => Promise.race([
  promise.then(() => "closed"),
  new Promise((resolve) => setTimeout(() => resolve(`still open after ${ms} ms`), ms)),
]);

test("a test server closes at once with idle, unsent and unanswered connections open", async (t) => {
  const { server, port } = await listen((req, res) => {
    if (req.url === "/never") return; // a request that never gets an answer
    res.end("ok");
  });
  const sockets = [];
  t.after(() => { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); });
  // A finished keep-alive request: its socket is idle.
  await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
  // A socket that connects and never sends a request, as a browser's
  // speculative preconnect does.
  const unsent = net.connect(port, "127.0.0.1");
  sockets.push(unsent);
  await new Promise((resolve) => unsent.once("connect", resolve));
  // A request whose answer never comes.
  const pending = net.connect(port, "127.0.0.1");
  sockets.push(pending);
  await new Promise((resolve) => pending.once("connect", resolve));
  pending.write("GET /never HTTP/1.1\r\nHost: test\r\n\r\n");
  await new Promise((resolve) => setTimeout(resolve, 50));
  for (const socket of sockets) socket.on("error", () => {});
  const started = performance.now();
  assert.equal(await within(closeServer(server), 2000), "closed");
  assert.ok(performance.now() - started < 1000, "closing never waits on a connection");
  assert.equal(server.listening, false);
});

test("closing a server that already stopped, or none, is not an error", async () => {
  const { server } = await listen();
  await closeServer(server);
  await closeServer(server);
  await closeServer(undefined);
});

test("a close that can't finish fails fast and says which server", async () => {
  // A server-shaped object whose close never calls back: the helper's own
  // bound, not a hang until the file's timeout.
  const stuck = { listening: true, close() {}, closeAllConnections() {} };
  await assert.rejects(closeServer(stuck, { timeoutMs: 100, label: "page server" }), /page server did not close within 0.1 s/);
});

test("a real browser still holding its connections doesn't delay closing the page's server", {
  skip: !findChrome() && "needs Chrome", timeout: 60000,
}, async (t) => {
  const { server, port } = await listen((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><link rel="preconnect" href="http://127.0.0.1:${port}"><img src="/a.png"><img src="/b.png"><p>page</p>`);
  });
  t.after(() => server.closeAllConnections());
  const browser = await launchChrome(t, {});
  const tab = await openTab(browser);
  await tab.navigate(`http://127.0.0.1:${port}/`);
  assert.equal(await tab.evaluate("document.querySelector('p').textContent"), "page");
  // Chrome is still open, with its connections, as when a test's server
  // cleanup runs before the browser's.
  const started = performance.now();
  assert.equal(await within(closeServer(server), 3000), "closed");
  assert.ok(performance.now() - started < 1000);
});
