import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { build } from "esbuild";
import { desktopConnection } from "../server/desktop-connection.mjs";
import { ScreenControl } from "../server/screen.mjs";
import { closeServer } from "./helpers/close-server.mjs";
import { findChrome, launchChrome, openTab } from "./helpers/headless-chrome.mjs";

// Oct 25, Windows CI (screen control, Android, twice): the phone page ran one
// 3.7 to 4 s task of its own mid-typing. Its heartbeats come from that page's
// script, so the computer heard nothing for 3 s and closed control (1012)
// with the link fine; the letter typed then was lost and the rest of the
// typing paused. Real Chrome and the production input hook against the
// production desktop connection; the computer's helper is a fixture that
// records what it was asked to do (no native input, no Reach process).
const repo = fileURLToPath(new URL("..", import.meta.url));
const binary = findChrome();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, ms = 7000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() >= end) throw Error(`Did not observe ${label} in ${ms / 1000} s`);
    await pause(10);
  }
}
// An approved owner device on every host (Windows' guest screen rule aside).
const phone = { id: "phone", kind: "device", name: "Phone", scopes: ["admin", "screen"] };

function computer(t) {
  const control = new ScreenControl();
  control.acquire(phone, true);
  const done = [];
  const connections = [];
  const files = new Map();
  const server = http.createServer((req, res) => {
    if (req.url === "/favicon.ico") return res.writeHead(204).end();
    const file = files.get(req.url);
    if (!file) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": file.type }).end(file.body);
  });
  const wss = new WebSocketServer({ server, path: "/ws/screen-input" });
  wss.on("connection", (ws) => {
    const connection = { ws, closed: null, readyAt: 0 };
    connections.push(connection);
    // When the computer said ready, and how it ended the connection if it
    // did (a phone's own close isn't this), by the computer's own clock.
    const send = ws.send.bind(ws), close = ws.close.bind(ws);
    ws.send = (data, ...rest) => {
      if (!connection.readyAt && JSON.parse(String(data)).type === "ready") connection.readyAt = Date.now();
      return send(data, ...rest);
    };
    ws.close = (code, reason) => {
      connection.closed ??= { code, reason: String(reason ?? ""), at: Date.now() };
      return close(code, reason);
    };
    desktopConnection(ws, {
      config: { screen: true },
      auth: { verify: (token) => (token === "fixture-token" ? phone : null) },
      control,
      create: async () => ({
        send: async (action) => {
          done.push(action);
          return action.type === "heartbeat" ? { cursor: null } : { ok: true };
        },
        stop() {},
      }),
    });
  });
  t.after(async () => {
    for (const { ws } of connections) ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    await closeServer(server);
    control.clear();
  });
  const listen = () => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
  return { control, done, connections, files, listen };
}

test("a phone page busy for 4 s keeps control: its browser still answers for the link", {
  skip: binary ? false : "no Chrome or Chromium installed", timeout: 120000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-page-stall-"));
  t.after(() => fs.promises.rm(dir, { recursive: true, force: true }));
  const abs = (file) => JSON.stringify(path.join(repo, file).split(path.sep).join("/"));
  await build({
    stdin: { resolveDir: repo, sourcefile: "page-stall-fixture.tsx", loader: "tsx", contents: `
import { createRoot } from "react-dom/client";
import { useDesktopInput } from ${abs("src/useDesktopInput.ts")};
window.__control = { ends: [] };
function Fixture() {
  const input = useDesktopInput({ id: "phone", token: "fixture-token", url: location.origin }, true, "primary",
    (message) => window.__control.ends.push(message));
  Object.assign(window.__control, { ready: input.ready, reconnecting: input.reconnecting, send: input.send });
  return null;
}
createRoot(document.getElementById("root")).render(<Fixture />);
` },
    bundle: true, outdir: dir, entryNames: "entry", format: "esm", jsx: "automatic",
    define: { "process.env.NODE_ENV": JSON.stringify("production") }, logLevel: "silent",
  });
  const mac = computer(t);
  mac.files.set("/", { type: "text/html", body: '<!doctype html><div id="root"></div><script type="module" src="/entry.js"></script>' });
  mac.files.set("/entry.js", { type: "text/javascript", body: fs.readFileSync(path.join(dir, "entry.js")) });
  const origin = await mac.listen();
  const browser = await launchChrome(t, { binary });
  t.after(() => browser.close());
  const tab = await openTab(browser);
  await tab.navigate(origin + "/");
  await until(() => tab.evaluate("window.__control?.ready === true"), "control ready");
  // Heartbeats flowing, as on a phone between taps.
  await until(() => mac.done.filter((a) => a.type === "heartbeat").length >= 3, "the page's heartbeats");

  // The page's own script busy for 4 s: no heartbeat, no message, no timer.
  const busyMs = await tab.evaluate("(() => { const start = performance.now(); while (performance.now() - start < 4000); return performance.now() - start; })()");
  assert.ok(busyMs >= 4000, `the page was busy ${busyMs} ms`);
  const after = await tab.evaluate(`window.__control.send({ type: "text", text: "a" }).then(
    (result) => ({ result, ends: window.__control.ends, reconnecting: window.__control.reconnecting }),
    (error) => ({ failed: error.message, ends: window.__control.ends, reconnecting: window.__control.reconnecting }))`);
  const seen = { after, connections: mac.connections.map((c) => c.closed), done: mac.done.filter((a) => a.type !== "heartbeat") };
  assert.equal(mac.connections[0].closed, null, `the computer kept the connection: ${JSON.stringify(seen)}`);
  assert.equal(mac.connections.length, 1, `no reconnect: ${JSON.stringify(seen)}`);
  assert.equal(after.failed, undefined, `typing after the busy page arrived: ${JSON.stringify(seen)}`);
  assert.deepEqual(after.ends, [], "control never ended on the phone");
  assert.deepEqual(mac.done.filter((a) => a.type === "text").map((a) => a.text), ["a"], "typed once, after the page was free");
  assert.ok(mac.control.holder(), "the phone still holds control");
  assert.deepEqual(tab.problems, []);
});

test("a link that answers nothing still closes 3 s after its last word, retryable", { timeout: 30000 }, async (t) => {
  const mac = computer(t);
  const origin = await mac.listen();
  // A client whose link is gone: it never answers a ping.
  const ws = new WebSocket(origin.replace("http", "ws") + "/ws/screen-input", { autoPong: false });
  t.after(() => ws.terminate());
  const messages = [];
  let pings = 0;
  ws.on("ping", () => pings++);
  ws.on("message", (data) => messages.push(JSON.parse(String(data))));
  const closed = new Promise((resolve) => ws.on("close", (code) => resolve(code)));
  await new Promise((resolve) => ws.once("open", resolve));
  ws.send(JSON.stringify({ type: "auth", token: "fixture-token", display: "primary" }));
  await until(() => messages.some((m) => m.type === "ready"), "ready");
  // Unanswered pings must not keep a dead link on: it closes, and well
  // before this test's own limit.
  const code = await Promise.race([closed, pause(10000).then(() => "still open 10 s on, kept by unanswered pings")]);
  assert.equal(code, 1012);
  const quietMs = mac.connections[0].closed.at - mac.connections[0].readyAt;
  assert.equal(mac.connections[0].closed?.code, 1012);
  assert.match(messages.at(-1).error, /disconnected\. Reconnecting…$/);
  assert.equal(messages.at(-1).retryable, true);
  assert.ok(pings >= 1, "the computer asked for the link before giving up on it");
  // Never sooner than 3 s after its last word (a millisecond's rounding).
  assert.ok(quietMs >= 2990, `closed after ${quietMs} ms of silence`);
  assert.ok(mac.control.holder(), "the lease waits for the phone to come back");
});
