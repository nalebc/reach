import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { build } from "esbuild";
import { findChrome, launchChrome, openTab } from "./helpers/headless-chrome.mjs";

// Real Chrome, production TerminalView and xterm's actual parser. The loopback
// server controls historical/live output; a private CSI handler can pause the
// parser to exercise its documented asynchronous write boundary. No native PTY,
// desktop, OS clipboard, phone permission, or physical device is used here.
const repo = fileURLToPath(new URL("..", import.meta.url));
const binary = findChrome();
const DA = "\x1b[c", DSR = "\x1b[5n";
const DA_REPLY = "\x1b[?1;2c", DSR_REPLY = "\x1b[0n";
const hold = (id) => `\x1b[?777;${id}z`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label) {
  const end = Date.now() + 5000;
  while (!await predicate()) {
    if (Date.now() >= end) throw Error(`Did not observe ${label} in 5 s`);
    await pause(10);
  }
}

test("Terminal snapshots cannot answer historical queries into the live shell", { skip: binary ? false : "no Chrome or Chromium installed", timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-terminal-snapshot-"));
  const page = path.join(dir, "page");
  const report = process.env.REACH_TEST_TERMINAL_SNAPSHOT_EVIDENCE || path.join(repo, "reports", "terminal-snapshot");
  fs.mkdirSync(report, { recursive: true });
  const undo = [async () => fs.promises.rm(dir, { recursive: true, force: true })];
  t.after(async () => { for (const step of undo.reverse()) await step(); });
  const abs = (file) => JSON.stringify(path.join(repo, file).split(path.sep).join("/"));
  await build({
    stdin: {
      resolveDir: repo, sourcefile: "terminal-snapshot-fixture.tsx", loader: "tsx",
      contents: `import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import ${abs("src/workspace.css")};
import { TerminalView } from ${abs("src/Sessions.tsx")};
window.__snapshot = { terms: [], holds: [], writes: [], parsed: [], data: [], toasts: [] };
let root;
function Fixture() {
  const [selected, select] = useState("s1");
  return <TerminalView desktopTerminals={false}
    peer={{ id: "fixture", name: "Fixture", platform: "win32", url: location.origin, token: "fixture-token" }}
    sessions={["s1", "s2"].map(id => ({ id, name: id, cwd: "/fixture", status: "running" }))}
    selected={selected} onSelect={select} onNew={() => {}} onRefresh={() => {}}
    toast={text => window.__snapshot.toasts.push(text)} source="reach" setSource={() => {}} onExit={() => {}} />;
}
window.__snapshot.mount = () => {
  if (root) flushSync(() => root.unmount());
  root = createRoot(document.getElementById("root"));
  flushSync(() => root.render(<Fixture />));
};
window.__snapshot.mount();
`,
    },
    plugins: [{
      name: "observe-real-xterm",
      setup(build) {
        build.onResolve({ filter: /^@xterm\/xterm$/ }, () => ({ path: "observed-xterm", namespace: "snapshot-fixture" }));
        build.onLoad({ filter: /.*/, namespace: "snapshot-fixture" }, () => ({
          loader: "js", resolveDir: repo,
          contents: `import { Terminal as ActualTerminal } from ${abs("node_modules/@xterm/xterm/lib/xterm.mjs")};
export class Terminal extends ActualTerminal {
  constructor(options) {
    super(options);
    this.fixtureId = window.__snapshot.terms.push(this) - 1;
    this.onData(data => window.__snapshot.data.push({ term: this.fixtureId, data }));
    this.parser.registerCsiHandler({ prefix: "?", final: "z" }, params => {
      if (params[0] !== 777) return false;
      return new Promise(resolve => window.__snapshot.holds.push({ id: params[1], term: this.fixtureId, release: () => resolve(true) }));
    });
  }
  write(data, done) {
    window.__snapshot.writes.push({ term: this.fixtureId, data });
    super.write(data, () => {
      window.__snapshot.parsed.push({ term: this.fixtureId, data, callback: !!done });
      done?.();
    });
  }
}`,
        }));
      },
    }],
    bundle: true, outdir: page, entryNames: "entry", format: "esm", jsx: "automatic", loader: { ".svg": "dataurl" },
    define: { "process.env.NODE_ENV": JSON.stringify("production") }, logLevel: "silent",
  });
  const files = new Map([
    ["/", { type: "text/html", body: '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/entry.css"><style>body{margin:0;background:#101512}.terminal-page{height:100vh}</style><div id="root"></div><script type="module" src="/entry.js"></script>' }],
    ["/entry.js", { type: "text/javascript", body: fs.readFileSync(path.join(page, "entry.js")) }],
    ["/entry.css", { type: "text/css", body: fs.readFileSync(path.join(page, "entry.css")) }],
  ]);
  const server = http.createServer((req, res) => {
    if (req.url === "/favicon.ico") return res.writeHead(204).end();
    const file = files.get(req.url);
    if (!file) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": file.type }).end(file.body);
  });
  const wss = new WebSocketServer({ server, path: "/ws/terminal" });
  const connections = [];
  wss.on("connection", (ws) => {
    const connection = { ws, received: [] };
    connections.push(connection);
    ws.on("message", (raw) => connection.received.push(JSON.parse(String(raw))));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  undo.push(async () => {
    for (const connection of connections) connection.ws.terminate();
    await new Promise((resolve) => wss.close(resolve));
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const browser = await launchChrome(t, { binary });
  undo.push(() => browser.close());
  const tab = await openTab(browser);
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await tab.navigate(`http://127.0.0.1:${server.address().port}/`);
  const inputs = (connection) => connection.received.filter(message => message.type === "input").map(message => message.data);
  const send = (connection, type, data) => connection.ws.send(JSON.stringify({ type, data, status: "running", heartbeat: true }));
  // Pong follows earlier client frames on the same connection, making the
  // absence of a historical response observable without an arbitrary sleep.
  const drain = (connection) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { connection.ws.off("pong", done); reject(Error("fixture WebSocket pong missing")); }, 2000);
    function done() { clearTimeout(timer); resolve(); }
    connection.ws.once("pong", done);
    connection.ws.ping();
  });
  const parsed = (data) => until(() => tab.evaluate(`window.__snapshot.parsed.some(p => p.data === ${JSON.stringify(data)})`), "actual xterm parse completion");
  const connected = () => tab.evaluate('!document.querySelector(".status-dot").classList.contains("off")');
  const fresh = async () => {
    const count = connections.length;
    await tab.evaluate("window.__snapshot.mount()");
    await until(() => connections.length > count && connections.at(-1).received.some(m => m.type === "auth"), "fresh terminal auth");
    return connections.at(-1);
  };
  await until(() => connections.at(-1)?.received.some(m => m.type === "auth"), "initial terminal auth");
  const outcomes = [];
  t.after(() => {
    fs.writeFileSync(path.join(report, "parser-boundary.json"), JSON.stringify({
      platform: process.platform, scope: "real Chrome/TerminalView/xterm; controlled WebSocket output and explicit parser pause; no native PTY or physical phone", outcomes, problems: tab.problems,
    }, null, 2) + "\n");
  });
  await t.test("first snapshot's DA and DSR are rendered without sending historical input", async () => {
    const connection = connections.at(-1);
    const snapshot = `earlier output${DA}${DSR}\r\n$ `;
    send(connection, "snapshot", snapshot);
    await parsed(snapshot);
    await until(connected, "connected state after parsed snapshot");
    await drain(connection);
    const generated = await tab.evaluate("window.__snapshot.data.map(m => m.data)");
    outcomes.push({ name: "initial-snapshot", generated, sent: inputs(connection) });
    assert.deepEqual(generated, [DA_REPLY, DSR_REPLY], "the real parser generated both historical replies");
    assert.deepEqual(inputs(connection), [], "historical replies never reach the shell");
  });
  await t.test("historical replies leave sticky Ctrl armed for the next actual key", async () => {
    const connection = await fresh();
    const snapshot = `${hold(1)}${DA}\r\n$ `;
    send(connection, "snapshot", snapshot);
    await until(() => tab.evaluate("window.__snapshot.holds.some(h => h.id === 1)"), "paused snapshot parser");
    await tab.evaluate('[...document.querySelectorAll("button")].find(b => b.textContent === "ctrl").click()');
    await tab.evaluate("window.__snapshot.holds.find(h => h.id === 1).release()");
    await parsed(snapshot);
    await until(connected, "connected state after parsed snapshot");
    await drain(connection);
    const armed = await tab.evaluate('document.querySelector("[aria-pressed]").getAttribute("aria-pressed")');
    await tab.evaluate("window.__snapshot.terms.at(-1).focus()");
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "c", code: "KeyC", text: "c", unmodifiedText: "c", windowsVirtualKeyCode: 67 });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "c", code: "KeyC", windowsVirtualKeyCode: 67 });
    await drain(connection);
    outcomes.push({ name: "sticky-ctrl", armedAfterHistory: armed, sent: inputs(connection) });
    assert.equal(armed, "true", "a replayed query does not consume sticky Ctrl");
    assert.deepEqual(inputs(connection), ["\x03"], "the next actual c becomes Ctrl-C exactly once");
  });
  await t.test("live DA and DSR queued after a paused snapshot answer once without consuming Ctrl", async () => {
    const connection = await fresh();
    const snapshot = `${hold(2)}${DA}\r\n$ `;
    send(connection, "snapshot", snapshot);
    await until(() => tab.evaluate("window.__snapshot.holds.some(h => h.id === 2)"), "paused snapshot parser");
    await tab.evaluate('[...document.querySelectorAll("button")].find(b => b.textContent === "ctrl").click()');
    const live = DA + DSR;
    send(connection, "data", live);
    await until(() => tab.evaluate(`window.__snapshot.writes.some(w => w.data === ${JSON.stringify(live)})`), "live write queued behind paused snapshot");
    await tab.evaluate("window.__snapshot.holds.find(h => h.id === 2).release()");
    await parsed(live);
    await drain(connection);
    const armed = await tab.evaluate('document.querySelector("[aria-pressed]").getAttribute("aria-pressed")');
    const replies = inputs(connection);
    await tab.evaluate("window.__snapshot.terms.at(-1).focus()");
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "c", code: "KeyC", text: "c", unmodifiedText: "c", windowsVirtualKeyCode: 67 });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "c", code: "KeyC", windowsVirtualKeyCode: 67 });
    await drain(connection);
    outcomes.push({ name: "queued-live-queries", armedAfterQueries: armed, replies, sent: inputs(connection) });
    assert.deepEqual(replies, [DA_REPLY, DSR_REPLY], "only the two genuine live queries answer, once each");
    assert.equal(armed, "true", "live protocol replies also leave sticky Ctrl for the next typed character");
    assert.deepEqual(inputs(connection), [DA_REPLY, DSR_REPLY, "\x03"], "the actual next c remains Ctrl-C");
  });
  const shot = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(path.join(report, "terminal.png"), Buffer.from(shot.data, "base64"));
  fs.writeFileSync(path.join(report, "browser.json"), JSON.stringify(await browser.send("Browser.getVersion"), null, 2) + "\n");
  assert.deepEqual(tab.problems, []);
});
