import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { build } from "esbuild";
import { findChrome, launchChrome, openTab, testCertificate } from "./helpers/headless-chrome.mjs";

// Real HTTPS/WSS, Chrome's renderer suspension and the shared React hook.
// The disposable presence server and relay are fixtures; no OS VPN or
// physical phone is qualified by this check, and no live screen is captured.
const binary = findChrome();
test("real Chrome resumes an open stale feed without reloading work, and aborts a held relay body", {
  skip: !process.env.CI && !binary && "Chrome/Chromium is not installed", timeout: 45000,
}, async t => {
  assert.ok(binary, "actual Chrome is required in CI");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-fleet-resume-"));
  const host = "computer.foreground.ts.net";
  const certificate = await testCertificate(root, host);
  const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
  const bundle = await build({
    stdin: { resolveDir: sourceRoot, contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { useFleetConnections } from './src/useFleetConnections.ts';
      import { tailnetFetch } from './src/tailnet-transport.ts';
      const peer = { id: 'computer', name: 'Disposable host', url: location.origin, token: 'fixture-approval', platform: 'win32' };
      const NativeSocket = WebSocket;
      window.fixtureSockets = [];
      window.WebSocket = class extends NativeSocket {
        constructor(...args) { super(...args); window.fixtureSockets.push(this); }
      };
      function Page() {
        const feeds = useFleetConnections([peer]);
        window.fixtureFeed = feeds.computer;
        return React.createElement('main', null,
          React.createElement('textarea', { id: 'draft', defaultValue: 'draft retained across suspension' }),
          React.createElement('output', null, JSON.stringify(feeds)));
      }
      createRoot(document.getElementById('root')).render(React.createElement(Page));
      window.fixtureAbortBody = async () => {
        let began;
        const started = new Promise(resolve => { began = resolve; });
        let release;
        let cancelled = 0, dispatched = 0;
        const node = { fetch() {
          dispatched++;
          return { abort() {}, response: Promise.resolve({ status: 200, statusText: 'OK', headers: [],
            read() { began(); return new Promise(resolve => { release = resolve; }); }, cancel() { cancelled++; } }) };
        } };
        const controller = new AbortController();
        const response = await tailnetFetch(node, location.origin + '/api/device', { signal: controller.signal });
        const outcome = response.text().then(() => 'completed', error => error.name);
        await started;
        controller.abort(new DOMException('Suspended read cancelled.', 'AbortError'));
        let timer;
        const result = await Promise.race([outcome, new Promise(resolve => { timer = setTimeout(() => resolve('still pending'), 250); })]);
        clearTimeout(timer); release(null); await outcome;
        // Compare with this browser's native Response consumption: Chromium
        // can wrap an errored custom stream in TypeError rather than expose
        // its AbortError directly. The relay must settle identically.
        const expected = await new Response(new ReadableStream({ start(stream) { stream.error(controller.signal.reason); } })).text().then(() => 'completed', error => error.name);
        return { result, expected, cancelled, dispatched };
      };
    ` },
    bundle: true, write: false, platform: "browser", format: "iife", target: "es2022", logLevel: "silent",
  });
  const server = https.createServer(certificate, (req, res) => {
    if (req.url === "/fixture.js") {
      res.writeHead(200, { "Content-Type": "text/javascript" });
      return res.end(bundle.outputFiles[0].text);
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end('<!doctype html><link rel="icon" href="data:,"><div id="root"></div><script src="/fixture.js"></script>');
  });
  const wss = new WebSocketServer({ server, path: "/ws/presence" });
  const messages = [];
  wss.on("connection", ws => ws.on("message", data => {
    const value = JSON.parse(data.toString()); messages.push(value);
    if (value.type === "auth" && value.token === "fixture-approval")
      ws.send(JSON.stringify({ type: "presence", devices: [], changes: { sessions: `revision-${messages.length}` } }));
  }));
  let browser;
  t.after(async () => {
    await browser?.close();
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await launchChrome(t, { binary, hosts: [host], spki: certificate.spki });
  const tab = await openTab(browser);
  await tab.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await tab.navigate(`https://${host}:${server.address().port}/`);
  const until = async expression => {
    const end = Date.now() + 10000;
    while (!await tab.evaluate(expression).catch(() => false)) {
      if (Date.now() > end) assert.fail(`Timed out: ${expression}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  await until("window.fixtureFeed?.state === 'connected'");
  await tab.evaluate("window.fixtureDraft = document.getElementById('draft'); fixtureDraft.value = 'unsent draft'; window.fixtureTicks = 0; window.setInterval(() => window.fixtureTicks++, 50)");
  assert.equal(messages.length, 1);
  await tab.send("Emulation.setFocusEmulationEnabled", { enabled: false });
  await tab.send("Page.setWebLifecycleState", { state: "frozen" });
  const before = await tab.evaluate("window.fixtureTicks");
  await new Promise(resolve => setTimeout(resolve, 8500));
  assert.equal(await tab.evaluate("window.fixtureTicks"), before, "the real renderer's timers were suspended");
  assert.equal(messages.length, 1, "background suspension cannot start connection attempts");
  assert.equal(await tab.evaluate("fixtureSockets[0].readyState"), 1, "the stale socket still reports OPEN");
  await tab.send("Page.setWebLifecycleState", { state: "active" });
  await tab.send("Page.bringToFront");
  await tab.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await until("window.fixtureFeed?.changes?.includes('revision-2')");
  assert.deepEqual(await tab.evaluate("({ retained: fixtureDraft === document.getElementById('draft'), value: fixtureDraft.value, sockets: fixtureSockets.length })"),
    { retained: true, value: "unsent draft", sockets: 2 });
  assert.ok(messages.every(message => message.type === "auth" && message.token === "fixture-approval"), "only the same credential is authenticated; no action is replayed");
  const aborted = await tab.evaluate("fixtureAbortBody()");
  assert.ok(["AbortError", "TypeError"].includes(aborted.expected), "the native stream was aborted");
  assert.deepEqual(aborted, { result: aborted.expected, expected: aborted.expected, cancelled: 1, dispatched: 1 });
});
