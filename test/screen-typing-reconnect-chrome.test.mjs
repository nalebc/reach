import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { build } from "esbuild";
import { ScreenControl } from "../server/screen.mjs";
import { findChrome, launchChrome, openTab } from "./helpers/headless-chrome.mjs";

// Real Chromium, Screen/RemoteTyping/useDesktopInput/DesktopInputQueue and a
// loopback WebSocket. Video/audio and the host's acknowledgments are fixtures;
// no Reach process, native desktop input, UIKit, phone or private network runs.
const repo = fileURLToPath(new URL("..", import.meta.url));
const binary = findChrome();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, label) {
  const end = Date.now() + 7000;
  while (!await predicate()) {
    if (Date.now() >= end) throw Error(`Did not observe ${label} in 7 s`);
    await pause(10);
  }
}

test("real input disconnect preserves only never-transmitted typing for an explicit new target", {
  skip: binary ? false : "no Chrome or Chromium installed", timeout: 120000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-typing-reconnect-"));
  const page = path.join(dir, "page");
  const report = process.env.REACH_TEST_TYPING_RECONNECT_EVIDENCE || path.join(repo, "reports", "typing-reconnect-browser");
  fs.mkdirSync(report, { recursive: true });
  const undo = [async () => fs.promises.rm(dir, { recursive: true, force: true })];
  t.after(async () => {
    const errors = [];
    for (const step of undo.reverse()) {
      try { await step(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Typing fixture cleanup failed");
  });
  const abs = (file) => JSON.stringify(path.join(repo, file).split(path.sep).join("/"));
  await build({
    stdin: { resolveDir: repo, sourcefile: "typing-reconnect-fixture.tsx", loader: "tsx", contents: `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import Screen from ${abs("src/Screen.tsx")};
import ${abs("src/workspace.css")};
window.__typing = { toasts: [] };
window.__typing.requests = [];
window.__typing.releases = [];
window.__typing.enables = [];
window.__typing.inputEvents = [];
for (const kind of ["pointerdown", "pointerup", "touchstart", "touchend", "click"])
  document.addEventListener(kind, event => {
    const item = { kind, trusted: event.isTrusted, target: event.target?.tagName,
      className: typeof event.target?.className === "string" ? event.target.className : "",
      onSurface: !!event.target?.closest?.(".remote-stage") };
    if ("clientX" in event) { item.x = event.clientX; item.y = event.clientY; }
    window.__typing.inputEvents.push(item);
    if (window.__typing.inputEvents.length > 24) window.__typing.inputEvents.shift();
  }, { capture: true, passive: true });
window.__typing.sampleTouch = () => {
  const canvas = document.querySelector(".remote-stage canvas"), stage = canvas?.closest(".remote-stage");
  const box = element => { const r = element?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; };
  const rect = box(canvas), surface = box(stage), visual = window.visualViewport;
  const viewport = { width: innerWidth, height: innerHeight, visual: visual ? {
    x: visual.offsetLeft, y: visual.offsetTop, width: visual.width, height: visual.height, scale: visual.scale,
  } : null };
  let candidate = null, hit = null;
  if (rect && surface) {
    const left = Math.max(0, rect.x, surface.x, visual?.offsetLeft || 0);
    const top = Math.max(0, rect.y, surface.y, visual?.offsetTop || 0);
    const right = Math.min(innerWidth, rect.x + rect.width, surface.x + surface.width,
      visual ? visual.offsetLeft + visual.width : innerWidth);
    const bottom = Math.min(innerHeight, rect.y + rect.height, surface.y + surface.height,
      visual ? visual.offsetTop + visual.height : innerHeight);
    if (right - left > 2 && bottom - top > 2) {
      candidate = { x: (left + right) / 2, y: (top + bottom) / 2 };
      hit = document.elementFromPoint(candidate.x, candidate.y);
    }
  }
  const eligible = !!candidate && !!hit && (hit === stage || stage.contains(hit)) &&
    !hit.closest("button, input, textarea, select, a");
  return { point: eligible ? candidate : null, candidate, rect, surface, viewport,
    hit: hit ? { tag: hit.tagName, className: typeof hit.className === "string" ? hit.className : "", onSurface: hit === stage || stage.contains(hit) } : null,
    eligible, now: performance.now() };
};
const fetchActual = window.fetch.bind(window);
window.fetch = (url, init = {}) => {
  window.__typing.requests.push({ url: String(url), method: init.method || "GET", body: init.body });
  const request = fetchActual(url, init);
  if (init.body === '{"enabled":false}') window.__typing.releases.push(request.catch(() => {}));
  if (init.body === '{"enabled":true}') window.__typing.enables.push(request.then(response => response.clone().text()).catch(() => {}));
  return request;
};
function Fixture() {
  const [url, setUrl] = useState(location.origin);
  const [identity, setIdentity] = useState({ id: "fixture", token: "fixture-only" });
  window.__typing.route = next => flushSync(() => setUrl(next));
  window.__typing.grant = next => flushSync(() => { setIdentity(next); setUrl(next.url); });
  return <Screen
  peer={{ ...identity, name: "Fixture", platform: "darwin", url }}
  device={{ id: identity.id, access: identity.access, name: "Fixture", platform: "darwin", capabilities: { screen: true, apps: false }, roots: [] }}
  toast={message => window.__typing.toasts.push(message)} onChanged={() => {}} />;
}
const root = createRoot(document.getElementById("root"));
window.__typing.unmount = () => flushSync(() => root.unmount());
flushSync(() => root.render(<Fixture />));
` },
    plugins: [{ name: "fixture-media-only", setup(builder) {
      builder.onResolve({ filter: /\/useRemoteScreen$/ }, () => ({ path: "video", namespace: "typing-fixture" }));
      builder.onResolve({ filter: /\/useScreenSound$/ }, () => ({ path: "audio", namespace: "typing-fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "typing-fixture" }, ({ path: name }) => ({ loader: "js", resolveDir: repo,
        contents: name === "audio"
          ? 'export const soundSupported = () => false; export const useScreenSound = () => ({ state: "off", error: "", start() {}, stop() {} });'
          : `import { useRef, useState } from "react";
import { flushSync } from "react-dom";
export function useRemoteScreen(peer, enabled, live, display) {
  const [mediaReady, setMediaReady] = useState(true);
  window.__typing.media = ready => flushSync(() => setMediaReady(ready));
  return { canvas: useRef(null), selectedDisplay: display, ready: enabled && live && mediaReady, connecting: false,
    error: "", format: "h264", fps: 60, mbps: 1, updated: Date.now(), width: 1000, height: 600,
    fallback: false, fallbackReason: "", video: "H.264", videoWhy: "" };
}`,
      }));
    } }],
    bundle: true, outdir: page, entryNames: "entry", format: "esm", jsx: "automatic",
    loader: { ".svg": "dataurl" }, define: { "process.env.NODE_ENV": JSON.stringify("production") }, logLevel: "silent",
  });
  const files = new Map([
    ["/", { type: "text/html", body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/entry.css"><style>body{margin:0}.screen-page{height:100vh}</style><div id="root"></div><script type="module" src="/entry.js"></script>' }],
    ["/entry.js", { type: "text/javascript", body: fs.readFileSync(path.join(page, "entry.js")) }],
    ["/entry.css", { type: "text/css", body: fs.readFileSync(path.join(page, "entry.css")) }],
  ]);
  let pageOrigin;
  const apiRequests = [];
  const acceptedTokens = new Map(), pendingEnables = [];
  let deferEnable = false, watchControl = null;
  const serve = (req, res) => {
    if (req.url === "/favicon.ico") return res.writeHead(204).end();
    if (req.url.startsWith("/api/")) {
      const origin = req.headers.origin;
      const record = { method: req.method, path: req.url, host: req.headers.host, origin,
        authorization: req.headers.authorization, requestedHeaders: req.headers["access-control-request-headers"], body: "" };
      apiRequests.push(record);
      if (origin && origin !== pageOrigin) return res.writeHead(403).end();
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", pageOrigin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      }
      if (req.method === "OPTIONS") return res.writeHead(204).end();
      if (!acceptedTokens.get(req.headers.host)?.has(req.headers.authorization?.replace(/^Bearer /, "")))
        return res.writeHead(403, { "Content-Type": "application/json" }).end('{"error":"Fixture credential belongs to another endpoint"}');
      req.on("data", chunk => { record.body += chunk; if (record.body.length > 1024) req.destroy(); });
      req.on("end", () => {
        // The delayed-return regression observes actual ScreenControl lease
        // semantics at request execution, before a held HTTP response arrives.
        if (watchControl && req.url === "/api/screen/control") {
          try { watchControl(record); }
          catch (error) { return res.writeHead(error.status || 500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: error.message })); }
        }
        const body = req.url.startsWith("/api/screen/displays")
          ? { displays: [{ id: "primary", name: "Fixture", primary: true, width: 1000, height: 600, x: 0, y: 0 }] }
          : req.url === "/api/screen/control" ? { enabled: true } : {};
        const finish = () => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
        if (deferEnable && req.url === "/api/screen/control" && record.body === '{"enabled":true}') pendingEnables.push(finish);
        else finish();
      });
      return;
    }
    const file = files.get(req.url);
    if (!file) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": file.type }).end(file.body);
  };
  const servers = [http.createServer(serve), http.createServer(serve)];
  const websockets = servers.map(server => new WebSocketServer({ server, path: "/ws/screen-input" }));
  const connections = [];
  let holdTyping = false, refuseTyping = false, holdFocus = false, windowSize = 1;
  const pendingFocus = [];
  for (const wss of websockets) wss.on("connection", (ws, req) => {
    if (req.headers.origin !== pageOrigin) return ws.close(1008, "Fixture origin refused");
    const connection = { ws, received: [], at: performance.now(), endpoint: req.headers.host, origin: req.headers.origin };
    connections.push(connection);
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      connection.received.push(message);
      if (message.type === "auth") {
        if (!acceptedTokens.get(connection.endpoint)?.has(message.token)) {
          ws.send(JSON.stringify({ type: "error", error: "Fixture credential belongs to another endpoint", retryable: false }));
          return ws.close(4001);
        }
        ws.send(JSON.stringify({ type: "ready", window: windowSize, typing: true, probe: true }));
        ws.send(JSON.stringify({ type: "fields", after: 0, fields: [{ x: 0, y: 0, w: 1, h: 1, secure: false }] }));
      } else if (message.type === "input") {
        const action = message.action;
        if (holdTyping && action.type === "type-edit") return;
        const acknowledge = () => {
          if (ws.readyState !== 1) return false;
          ws.send(JSON.stringify({ type: "ack", id: message.id,
            ...(refuseTyping && action.type === "type-edit" ? { ok: false, error: "Fixture field refused typing" }
              : action.type === "probe" ? { field: true }
              : action.type === "focus" ? { target: { editable: true, focus: `field-${connections.indexOf(connection)}`, secure: false } }
              : { ok: true }) }));
          return true;
        };
        if (holdFocus && action.type === "focus") pendingFocus.push({ connection, acknowledge });
        else acknowledge();
      }
    });
  });
  for (const server of servers) await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origins = servers.map(server => `http://127.0.0.1:${server.address().port}`);
  pageOrigin = origins[0];
  undo.push(async () => {
    for (const connection of connections) connection.ws.terminate();
    for (const wss of websockets) await new Promise((resolve) => wss.close(resolve));
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  const browser = await launchChrome(t, { binary });
  undo.push(() => browser.close());
  const browserVersion = await browser.send("Browser.getVersion");
  const tab = await openTab(browser);
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  const button = (text) => `[...document.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === ${JSON.stringify(text)} || b.textContent.trim() === ${JSON.stringify(text)})`;
  const sink = 'document.querySelector(".remote-keyboard-sink")';
  const typing = (connection) => connection.received.filter(m => m.type === "input" && m.action.type === "type-edit").map(m => m.action);
  const outcomes = [];
  const writeReport = () => {
    const source = Object.fromEntries(["src/Screen.tsx", "src/RemoteTyping.tsx", "src/useDesktopInput.ts", "src/desktop-input-queue.ts"].map(file => [file, crypto.createHash("sha256").update(fs.readFileSync(path.join(repo, file))).digest("hex")]));
    fs.writeFileSync(path.join(report, "browser.json"), JSON.stringify({ browser: browserVersion, platform: process.platform, scope: "real Chromium and production Screen/RemoteTyping/input hook/queue; controlled media, two loopback origins with actual CORS; fixed approved fixture identity/grant, no native desktop, live Tailscale or physical network", source, origins, apiRequests, outcomes, connections: connections.map(c => ({ received: c.received, state: c.ws.readyState, endpoint: c.endpoint, origin: c.origin })), problems: tab.problems }, null, 2) + "\n");
  };
  t.afterEach(writeReport);
  t.after(writeReport);
  const pageOnly = async () => {
    // Complete the old fixture's real release before changing its accepted
    // tokens. This neither mocks fetch nor forgives a crossed credential.
    await tab.evaluate('(async () => { if (window.__typing) { window.__typing.unmount(); await Promise.allSettled(window.__typing.releases); } })()');
    holdTyping = false; refuseTyping = false; holdFocus = false; windowSize = 1; deferEnable = false;
    pendingFocus.length = 0;
    for (const origin of origins) acceptedTokens.set(new URL(origin).host, new Set(["fixture-only"]));
    await tab.navigate(pageOrigin + "/");
    await until(() => tab.evaluate(`!!${button("Control")}`), "Control button");
  };
  const initiatedOff = () => tab.evaluate('window.__typing.requests.filter(r => r.body === \'{"enabled":false}\')');
  const ready = () => until(() => tab.evaluate(`(() => {
    const b = document.querySelector('button[aria-label="Dismiss phone keyboard"]') ||
      document.querySelector('button[aria-label="Open phone keyboard"]');
    return b && !b.disabled;
  })()`), "ready control");
  // A controlled visibility flag drives the actual DOM handler; this is not
  // physical phone backgrounding or a browser permission qualification.
  const visibility = (hidden) => tab.evaluate(`Object.defineProperty(document, "hidden", { configurable: true, value: ${hidden} }); document.dispatchEvent(new Event("visibilitychange"));`);
  const restoreVisibility = () => tab.evaluate('delete document.hidden; document.dispatchEvent(new Event("visibilitychange"));');
  const joinEnables = () => tab.evaluate('(async () => { await Promise.allSettled(window.__typing.enables); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()');
  const touchPoint = async (setup) => {
    let signature = "", since = 0, selected;
    await until(async () => {
      const sample = await tab.evaluate("window.__typing.sampleTouch()");
      setup.samples.push(sample);
      if (setup.samples.length > 12) setup.samples.shift();
      if (!sample.eligible) { signature = ""; return false; }
      const next = JSON.stringify([sample.rect, sample.surface, sample.viewport, sample.point, sample.hit]);
      if (signature !== next) { signature = next; since = sample.now; return false; }
      // Wait across rendered-frame opportunities, rather than sampling a
      // canvas while its ResizeObserver/viewport layout is still changing.
      if (sample.now - since < 32) return false;
      selected = sample.point;
      return true;
    }, "stable visible desktop touch point");
    return selected;
  };
  const fresh = async (initialOrigin = origins[0], window = 1) => {
    await pageOnly();
    windowSize = window;
    const count = connections.length;
    await tab.evaluate(`${button("Control")}.click()`);
    await until(() => connections.length > count && connections.at(-1).received.some(m => m.type === "auth"), "production hook authentication");
    await ready();
    if (initialOrigin !== origins[0]) {
      const before = connections.length;
      await tab.evaluate(`window.__typing.route(${JSON.stringify(initialOrigin)})`);
      await until(() => connections.length > before && connections.at(-1).received.some(m => m.type === "auth"), "initial alternate route");
      await ready();
    }
    const setup = { boundary: "fresh-touch-setup", connection: connections.length - 1, samples: [] };
    outcomes.push(setup);
    try {
      const point = await touchPoint(setup);
      setup.point = point;
      // Exactly one touch. No tap is retried if its delivery is unknown.
      await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
      await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await until(() => connections.at(-1).received.some(m => m.type === "input" && m.action.type === "focus"), "field confirmation");
      await until(() => tab.evaluate(`document.activeElement === ${sink}`), "real browser typing sink");
      return connections.at(-1);
    } finally {
      setup.inputEvents = await tab.evaluate("window.__typing.inputEvents");
    }
  };
  await t.test("touch setup refuses an offscreen or obstructed surface without dispatching input", async () => {
    await pageOnly();
    await tab.evaluate(`${button("Control")}.click()`);
    await ready();
    const setup = { samples: [] };
    await touchPoint(setup);
    const before = await tab.evaluate("window.__typing.inputEvents.length");
    const observed = await tab.evaluate(`(() => {
      const surface = document.querySelector(".remote-stage");
      const transform = surface.style.transform;
      surface.style.transform = "translateX(-10000px)";
      const offscreen = window.__typing.sampleTouch();
      surface.style.transform = transform;
      const cover = document.createElement("div");
      cover.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:auto";
      document.body.append(cover);
      const obstructed = window.__typing.sampleTouch();
      cover.remove();
      return { offscreen, obstructed };
    })()`);
    outcomes.push({ boundary: "touch-setup-negative", observed });
    assert.equal(observed.offscreen.eligible, false);
    assert.equal(observed.offscreen.point, null);
    assert.equal(observed.obstructed.eligible, false);
    assert.equal(observed.obstructed.point, null);
    assert.equal(await tab.evaluate("window.__typing.inputEvents.length"), before, "readiness checks never dispatch an exploratory touch");
  });
  for (const boundary of ["retryable-error", "socket-close"]) await t.test(boundary, async () => {
    const old = await fresh();
    holdTyping = true;
    await tab.send("Input.insertText", { text: "ab" });
    await until(() => typing(old).length === 1, "unknown dispatched ab");
    await tab.send("Input.insertText", { text: "cd" });
    assert.deepEqual(typing(old).map(a => a.text), ["ab"], "window=1 leaves cd never transmitted in the real input queue");
    const before = connections.length;
    if (boundary === "retryable-error") old.ws.send(JSON.stringify({ type: "error", error: "Fixture connection interrupted", retryable: true }));
    else old.ws.close(1012, "Fixture restart");
    await until(() => connections.length > before, "replacement input connection");
    // The same control says Dismiss while the expected sink is preserved.
    // Readiness must not assume that typing has already been destroyed.
    await ready();
    const observed = await tab.evaluate(`({ sinkPresent: !!${sink}, text: document.body.textContent, value: ${sink}?.value })`);
    const freshConnection = connections.at(-1);
    const result = { boundary, observed, oldTransmitted: typing(old), beforeConfirmation: typing(freshConnection) };
    outcomes.push(result);
    assert.equal(observed.sinkPresent, true, "same-event stop and promise rejection must not destroy the known-unsent draft");
    assert.deepEqual(typing(freshConnection), [], "no automatic replay after reconnect");
    holdTyping = false;
    await tab.evaluate(`${button("Send waiting typing to current field")}.click()`);
    await until(() => typing(freshConnection).length, "explicit known-unsent send");
    result.afterConfirmation = typing(freshConnection);
    assert.deepEqual(result.afterConfirmation.map(a => a.text), ["cd"], "only never-transmitted cd is retained; unknown ab is not replayed");
    assert.equal(result.afterConfirmation[0].focus, `field-${connections.indexOf(freshConnection)}`);
  });
  // One real touch on the visible desktop, as in fresh(): never retried.
  const tapSurface = async (boundary) => {
    const setup = { boundary, connection: connections.length - 1, samples: [] };
    outcomes.push(setup);
    setup.point = await touchPoint(setup);
    await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [setup.point] });
    await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    return setup;
  };
  const focusQueries = (connection) => connection.received.filter(m => m.type === "input" && m.action.type === "focus").length;
  await t.test("a reconnect with nothing waiting lets the next field tap type again", async () => {
    const old = await fresh();
    await tab.send("Input.insertText", { text: "ab" });
    await until(() => typing(old).length === 1, "acknowledged ab");
    const before = connections.length;
    old.ws.close(1012, "Fixture restart");
    await until(() => connections.length > before, "replacement input connection");
    await ready();
    const next = connections.at(-1);
    const paused = await tab.evaluate("/Typing paused/.test(document.body.textContent)");
    const setup = await tapSurface("reconnect-nothing-waiting");
    await until(() => focusQueries(next) > 0, "field confirmation on the new connection");
    await until(() => tab.evaluate(`document.activeElement === ${sink}`), "typing sink after the new tap");
    await tab.send("Input.insertText", { text: "xy" });
    await until(() => typing(next).length === 1, "new typing on the new connection");
    Object.assign(setup, { paused, oldTransmitted: typing(old), after: typing(next) });
    assert.equal(paused, true, "the reconnect paused typing first");
    assert.deepEqual(typing(old).map(a => a.text), ["ab"]);
    assert.deepEqual(typing(next).map(a => a.text), ["xy"], "only the new typing; nothing is replayed");
    assert.equal(typing(next)[0].focus, `field-${connections.indexOf(next)}`);
  });
  await t.test("waiting typing survives a field tap and is never sent until Send; Discard lets typing start over", async () => {
    const old = await fresh();
    holdTyping = true;
    await tab.send("Input.insertText", { text: "ab" });
    await until(() => typing(old).length === 1, "unknown dispatched ab");
    await tab.send("Input.insertText", { text: "cd" });
    const before = connections.length;
    old.ws.close(1012, "Fixture restart");
    await until(() => connections.length > before, "replacement input connection");
    await ready();
    holdTyping = false;
    const next = connections.at(-1);
    await until(() => tab.evaluate(`!!${button("Discard waiting typing")}`), "Discard for waiting typing");
    // The pause and its choices are on screen while the phone keyboard and
    // its key row are up, not only in the DOM (the dock is hidden then):
    // each is where a tap lands. One fixed script, no values spliced in.
    const visibility = await tab.evaluate(`(() => {
      const landed = (b) => {
        if (!b) return false;
        const r = b.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest("button") === b;
      };
      return {
        send: landed(document.querySelector('button[aria-label="Send waiting typing to current field"]')),
        discard: landed(document.querySelector('button[aria-label="Discard waiting typing"]')),
        keys: !!document.querySelector(".typing-keys"),
        classes: document.querySelector(".simple-screen")?.className,
        covered: [...document.querySelectorAll(".typing-keys button")].filter((k) => {
          const r = k.getBoundingClientRect();
          return document.elementFromPoint(r.x + r.width / 2, r.y + 4)?.closest("button") !== k;
        }).map((k) => k.textContent),
      };
    })()`);
    outcomes.push({ boundary: "paused-typing-visible", visibility });
    assert.equal(visibility.send, true, `Send is on screen: ${JSON.stringify(visibility)}`);
    assert.equal(visibility.discard, true, `Discard is on screen: ${JSON.stringify(visibility)}`);
    assert.equal(visibility.keys, true, "the key row is up");
    assert.deepEqual(visibility.covered, [], "the pause covers none of the key row's keys");
    const held = await tapSurface("reconnect-waiting-tap");
    await pause(600);
    held.focusQueries = focusQueries(next);
    held.sent = typing(next);
    assert.deepEqual(typing(next), [], "a tap is not consent to send the waiting cd");
    assert.equal(focusQueries(next), 0, "waiting typing keeps its own pause");
    assert.equal(await tab.evaluate(`!!${button("Discard waiting typing")}`), true, "still waiting after the tap");
    await tab.evaluate(`${button("Discard waiting typing")}.click()`);
    await until(() => tab.evaluate(`!${button("Discard waiting typing")} && !/Typing paused/.test(document.body.textContent)`), "discarded");
    const fresh2 = await tapSurface("after-discard-tap");
    await until(() => focusQueries(next) > 0, "field confirmation after Discard");
    await until(() => tab.evaluate(`document.activeElement === ${sink}`), "typing sink after Discard");
    await tab.send("Input.insertText", { text: "zz" });
    await until(() => typing(next).length === 1, "new typing after Discard");
    fresh2.after = typing(next);
    assert.deepEqual(typing(next).map(a => a.text), ["zz"], "discarded cd and unknown ab never reach the computer");
  });
  await t.test("a real typing refusal still closes typing and says why", async () => {
    const connection = await fresh();
    refuseTyping = true;
    await tab.send("Input.insertText", { text: "refused" });
    await until(() => tab.evaluate(`!${sink}`), "typing refusal closes the sink");
    const observed = await tab.evaluate('document.body.textContent');
    outcomes.push({ boundary: "typing-refusal", transmitted: typing(connection), observed });
    assert.match(observed, /Fixture field refused typing/);
  });
  await t.test("an authorization refusal still ends control instead of retaining input for replay", async () => {
    const connection = await fresh();
    holdTyping = true;
    await tab.send("Input.insertText", { text: "unknown" });
    await until(() => typing(connection).length === 1, "dispatched input before revocation");
    connection.ws.send(JSON.stringify({ type: "error", error: "Fixture screen permission revoked", retryable: false }));
    await until(() => tab.evaluate(`!${sink} && /Fixture screen permission revoked/.test(document.body.textContent)`), "authorization refusal");
    const observed = await tab.evaluate(`({ text: document.body.textContent, canConfirm: !!${button("Send waiting typing to current field")} })`);
    outcomes.push({ boundary: "authorization-refusal", transmitted: typing(connection), observed });
    assert.equal(observed.canConfirm, false);
  });
  for (const [from, to] of [[0, 1], [1, 0]]) await t.test(`peer URL ${from ? "return" : "replacement"} preserves queued typing under a fixed fixture grant`, async () => {
    const old = await fresh(origins[from]);
    holdTyping = true;
    await tab.send("Input.insertText", { text: "ab" });
    await until(() => typing(old).length === 1, "dispatched ab before URL handoff");
    await tab.send("Input.insertText", { text: "cd" });
    assert.deepEqual(typing(old).map(a => a.text), ["ab"]);
    const offBefore = (await initiatedOff()).length;
    const before = connections.length;
    await tab.evaluate(`window.__typing.route(${JSON.stringify(origins[to])})`);
    await until(() => connections.length > before && connections.at(-1).received.some(m => m.type === "auth"), "new URL input authentication");
    await ready();
    const next = connections.at(-1);
    const observed = await tab.evaluate(`({ sinkPresent: !!${sink}, value: ${sink}?.value, text: document.body.textContent })`);
    const result = { boundary: `url-${from}-to-${to}`, observed, oldTransmitted: typing(old), beforeConfirmation: typing(next), oldEndpoint: old.endpoint, newEndpoint: next.endpoint };
    outcomes.push(result);
    result.controlOffRequests = (await initiatedOff()).slice(offBefore);
    assert.deepEqual(result.controlOffRequests, [], "a route-only handoff cannot revoke the same grant");
    assert.equal(next.endpoint, new URL(origins[to]).host);
    assert.equal(observed.sinkPresent, true, "URL replacement must preserve the known-unsent draft");
    assert.deepEqual(typing(next), [], "a URL change cannot automatically replay typing");
    assert.equal(await tab.evaluate(`!!${button("Send waiting typing to current field")} && !${button("Send waiting typing to current field")}.disabled`), true);
    holdTyping = false;
    await tab.evaluate(`${button("Send waiting typing to current field")}.click()`);
    await until(() => typing(next).length === 1, "explicit known-unsent send after URL replacement");
    result.afterConfirmation = typing(next);
    assert.deepEqual(result.afterConfirmation, [{ type: "type-edit", delete: 0, text: "cd", focus: `field-${connections.indexOf(next)}` }]);
    assert.ok(apiRequests.some(r => r.host === new URL(origins[1]).host && r.method === "OPTIONS" && r.origin === pageOrigin), "actual browser cross-port preflight ran");
    assert.ok(apiRequests.some(r => r.host === new URL(origins[1]).host && r.method === "GET" && r.path === "/api/screen/displays" && r.origin === pageOrigin), "actual cross-origin API response was consumed");
  });
  await t.test("a media gap holds known-unsent typing until a fresh screen and explicit field confirmation", async () => {
    const connection = await fresh(origins[0], 8);
    holdTyping = true;
    await tab.send("Input.insertText", { text: "ab" });
    await until(() => typing(connection).length === 1, "unknown ab before media gap");
    await tab.evaluate("window.__typing.media(false)");
    await tab.send("Input.insertText", { text: "cd" });
    const before = await tab.evaluate(`({ sinkPresent: !!${sink}, value: ${sink}?.value, text: document.body.textContent })`);
    const result = { boundary: "media-gap", before, beforeConfirmation: typing(connection) };
    outcomes.push(result);
    assert.equal(before.sinkPresent, true, "a freshness refusal must keep the local draft");
    assert.deepEqual(typing(connection).map(a => a.text), ["ab"], "the fresh-screen gate blocks cd before any socket send");
    await tab.evaluate("window.__typing.media(true)");
    await ready();
    assert.equal(await tab.evaluate(`!!${button("Send waiting typing to current field")} && !${button("Send waiting typing to current field")}.disabled`), true);
    assert.deepEqual(typing(connection).map(a => a.text), ["ab"], "media readiness cannot automatically replay typing");
    holdTyping = false;
    await tab.evaluate(`${button("Send waiting typing to current field")}.click()`);
    await until(() => typing(connection).length === 2, "explicit known-unsent send after media gap");
    result.afterConfirmation = typing(connection);
    assert.deepEqual(result.afterConfirmation.map(a => a.text), ["ab", "cd"]);
  });
  await t.test("view-only and superseded pagehide cannot revoke another same-client control", async () => {
    await pageOnly();
    await tab.evaluate('window.dispatchEvent(new Event("pagehide"))');
    const passive = await initiatedOff();
    outcomes.push({ boundary: "view-only-pagehide", initiatedOff: passive });
    assert.deepEqual(passive, [], "view-only window never requested control");
    const connection = await fresh();
    connection.ws.send(JSON.stringify({ type: "error", error: "Control moved", superseded: true }));
    await until(() => tab.evaluate(`!!${button("Control")}`), "superseded control ends");
    const before = (await initiatedOff()).length;
    await tab.evaluate('window.dispatchEvent(new Event("pagehide"))');
    const superseded = (await initiatedOff()).slice(before);
    outcomes.push({ boundary: "superseded-pagehide", initiatedOff: superseded });
    assert.deepEqual(superseded, []);
  });
  await t.test("owned pagehide releases once, while a later unmount or manual Stop cannot release again", async () => {
    await fresh();
    await tab.evaluate('window.dispatchEvent(new Event("pagehide")); window.__typing.unmount()');
    const owned = await initiatedOff();
    outcomes.push({ boundary: "owned-pagehide-unmount", initiatedOff: owned });
    assert.equal(owned.length, 1);
    await fresh();
    await tab.evaluate(`${button("Dismiss phone keyboard")}.click()`);
    await until(() => tab.evaluate(`!!${button("Stop")}`), "Stop control after dismissing typing");
    await tab.evaluate(`${button("Stop")}.click()`);
    await until(() => tab.evaluate(`!!${button("Control")}`), "manual Control off");
    const before = (await initiatedOff()).length;
    await tab.evaluate('window.dispatchEvent(new Event("pagehide"))');
    const afterStop = (await initiatedOff()).slice(before);
    outcomes.push({ boundary: "manual-stop-pagehide", initiatedOff: afterStop });
    assert.deepEqual(afterStop, []);
  });
  await t.test("a delayed old-grant enable success cannot enable or release the replacement grant", async () => {
    await pageOnly();
    deferEnable = true;
    const apiStart = apiRequests.length;
    await tab.evaluate(`${button("Control")}.click()`);
    await until(() => pendingEnables.length, "held original enable response");
    const originalReply = pendingEnables.shift();
    deferEnable = false;
    acceptedTokens.set(new URL(origins[1]).host, new Set(["fixture-new"]));
    await tab.evaluate(`window.__typing.grant(${JSON.stringify({ id: "fixture", token: "fixture-new", url: origins[1] })})`);
    await until(() => tab.evaluate(`!!${button("Control")} && !${button("Control")}.disabled`), "replacement explicit Control");
    await tab.evaluate(`${button("Control")}.click()`);
    await ready();
    const oldOff = () => apiRequests.slice(apiStart).filter(r => r.host === new URL(origins[0]).host && r.body === '{"enabled":false}');
    await until(() => oldOff().length === 1, "old owned-intent release");
    originalReply();
    await until(() => oldOff().length === 2, "late old success compensation");
    const current = await tab.evaluate(`!!${button("Stop")} && !${button("Stop")}.disabled`);
    const requests = apiRequests.slice(apiStart);
    outcomes.push({ boundary: "late-old-enable", currentControl: current, requests });
    assert.equal(current, true);
    assert.equal(requests.some(r => r.host === new URL(origins[1]).host && r.body === '{"enabled":false}'), false);
    assert.equal(requests.some(r => r.host === new URL(origins[1]).host && r.authorization === "Bearer fixture-only"), false);
    assert.ok(oldOff().every(r => r.authorization === "Bearer fixture-only"));
  });
  await t.test("a delayed A enable response cannot revoke a newer owned A lease after an approved A to B to A return", async () => {
    await pageOnly();
    const control = new ScreenControl();
    watchControl = (request) => control.acquire({
      id: request.authorization.replace(/^Bearer /, ""), name: "Fixture", scopes: ["admin", "screen"],
    }, JSON.parse(request.body).enabled);
    try {
      deferEnable = true;
      const apiStart = apiRequests.length;
      await tab.evaluate(`${button("Control")}.click()`);
      await until(() => pendingEnables.length === 1, "held original A enable response");
      const originalReply = pendingEnables.shift();
      assert.equal(control.holder()?.clientId, "fixture-only", "the original enable executed before its response was held");
      deferEnable = false;
      acceptedTokens.set(new URL(origins[1]).host, new Set(["fixture-new"]));
      const workspaceKey = JSON.stringify(["fixture", origins[0], "fixture-only", null, null]);
      await tab.evaluate(`window.__typing.grant(${JSON.stringify({ id: "fixture", token: "fixture-new", workspaceKey, url: origins[1] })})`);
      await until(() => tab.evaluate(`!!${button("Control")} && !${button("Control")}.disabled`), "B requires explicit Control");
      await until(() => control.holder() === null, "original A intent released at the server");
      await tab.evaluate(`${button("Control")}.click()`);
      await ready();
      assert.equal(control.holder()?.clientId, "fixture-new");

      await tab.evaluate(`window.__typing.grant(${JSON.stringify({ id: "fixture", token: "fixture-only", workspaceKey, url: origins[0] })})`);
      await until(() => tab.evaluate(`!!${button("Control")} && !${button("Control")}.disabled`), "return A requires explicit Control");
      await until(() => control.holder() === null, "B intent released at the server");
      await tab.evaluate(`${button("Control")}.click()`);
      await ready();
      assert.equal(control.holder()?.clientId, "fixture-only", "a newer explicit A lease is active");
      const offBefore = (await initiatedOff()).length;
      originalReply();
      // Join the actual held fetch/body and give its production post() handler
      // complete browser turns; this does not wait for an expected forbidden
      // release or accept a timeout as proof that no release happened.
      await tab.evaluate('(async () => { await Promise.allSettled(window.__typing.enables); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()');
      const current = await tab.evaluate(`!!${button("Stop")} && !${button("Stop")}.disabled`);
      const lateOff = (await initiatedOff()).slice(offBefore);
      const requests = apiRequests.slice(apiStart);
      outcomes.push({ boundary: "late-old-enable-after-approved-return", currentControl: current, currentLease: control.holder(), lateOff, requests });
      assert.deepEqual(lateOff, [], "the obsolete A response must not release a newer owned generation of A");
      assert.equal(control.holder()?.clientId, "fixture-only", "the returned A lease remains authorized");
      assert.equal(current, true);
      assert.equal(requests.some(r => r.host === new URL(origins[1]).host && r.authorization === "Bearer fixture-only"), false, "A credentials never move to B");
      assert.equal(requests.some(r => r.host === new URL(origins[0]).host && r.authorization === "Bearer fixture-new"), false, "B credentials never move to A");
    } finally {
      watchControl = null;
      control.clear();
    }
  });
  await t.test("a delayed explicit focus reply on an old URL cannot flush typing after returning to the original route", async () => {
    const old = await fresh();
    holdTyping = true;
    await tab.send("Input.insertText", { text: "ab" });
    await until(() => typing(old).length === 1, "unknown typing before focus handoff");
    await tab.send("Input.insertText", { text: "cd" });
    let before = connections.length;
    await tab.evaluate(`window.__typing.route(${JSON.stringify(origins[1])})`);
    await until(() => connections.length > before, "alternate input route for focus confirmation");
    await ready();
    const alternate = connections.at(-1);
    holdFocus = true;
    await tab.evaluate(`${button("Send waiting typing to current field")}.click()`);
    await until(() => pendingFocus.length === 1, "held alternate-route focus reply");
    const oldFocus = pendingFocus.shift();
    assert.equal(oldFocus.connection, alternate);
    before = connections.length;
    await tab.evaluate(`window.__typing.route(${JSON.stringify(origins[0])})`);
    await until(() => connections.length > before, "returned input route");
    await ready();
    const returned = connections.at(-1);
    const oldReplyDelivered = oldFocus.acknowledge();
    await tab.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const result = { boundary: "delayed-focus-url-return", oldReplyDelivered, oldTransmitted: typing(old), alternateTransmitted: typing(alternate), beforeConfirmation: typing(returned) };
    outcomes.push(result);
    assert.deepEqual(typing(returned), [], "an old focus response cannot authorize typing on a replacement connection");
    assert.equal(await tab.evaluate(`!!${button("Send waiting typing to current field")} && !${button("Send waiting typing to current field")}.disabled`), true);
    holdTyping = false; holdFocus = false;
    await tab.evaluate(`${button("Send waiting typing to current field")}.click()`);
    await until(() => typing(returned).length === 1, "fresh explicit return-route focus confirmation");
    result.afterConfirmation = typing(returned);
    assert.deepEqual(result.afterConfirmation, [{ type: "type-edit", delete: 0, text: "cd", focus: `field-${connections.indexOf(returned)}` }]);
  });
  await t.test("a superseded parked window becoming hidden cannot release the newer same-client lease when its old enable replies", async () => {
    const control = new ScreenControl();
    watchControl = (request) => control.acquire({
      id: request.authorization.replace(/^Bearer /, ""), name: "Fixture", scopes: ["admin", "screen"],
    }, JSON.parse(request.body).enabled);
    try {
      const parked = await fresh();
      await tab.evaluate(`${button("Dismiss phone keyboard")}.click()`);
      await until(() => tab.evaluate(`!!${button("Stop")}`), "Stop before parking the existing socket");
      await tab.evaluate(`${button("Stop")}.click()`);
      await until(() => control.holder() === null && tab.evaluate(`!!${button("Control")} && !${button("Control")}.disabled`), "parked connection without an owned lease");
      deferEnable = true;
      await tab.evaluate(`${button("Control")}.click()`);
      await until(() => pendingEnables.length === 1, "held re-enable response on the parked socket");
      const oldReply = pendingEnables.shift();
      deferEnable = false;
      // A second same-client window's protocol request really reaches this
      // HTTP server and the production ScreenControl grant implementation.
      const other = await fetch(origins[0] + "/api/screen/control", { method: "POST", headers: {
        Authorization: "Bearer fixture-only", "Content-Type": "application/json", Origin: pageOrigin,
      }, body: '{"enabled":true}' });
      assert.equal(other.status, 200);
      await other.json();
      const newLease = control.lease;
      parked.ws.send(JSON.stringify({ type: "error", error: "Control moved", superseded: true }));
      await until(() => tab.evaluate('/Control moved to your other window/.test(document.body.textContent)'), "superseded parked window");
      const offBefore = (await initiatedOff()).length;
      await visibility(true);
      assert.equal(control.lease, newLease, "becoming hidden does not own the superseding lease");
      oldReply();
      await joinEnables();
      const lateOff = (await initiatedOff()).slice(offBefore);
      outcomes.push({ boundary: "superseded-hidden-late-enable", currentLease: control.holder(), lateOff, secondWindowRequest: { method: "POST", token: "fixture-only", endpoint: origins[0] } });
      assert.deepEqual(lateOff, [], "hiding a superseded window must not turn its old enable reply into a release");
      assert.equal(control.lease, newLease, "the other window's actual same-client lease survives");
    } finally {
      await restoreVisibility();
      watchControl = null;
      control.clear();
    }
  });
  await t.test("hiding during an enable unlocks Control after the obsolete response settles", async () => {
    await pageOnly();
    deferEnable = true;
    try {
      await tab.evaluate(`${button("Control")}.click()`);
      await until(() => pendingEnables.length === 1, "held enable before hiding");
      const oldReply = pendingEnables.shift();
      deferEnable = false;
      await visibility(true);
      await visibility(false);
      oldReply();
      await joinEnables();
      const observed = await tab.evaluate(`({ controlPresent: !!${button("Control")}, disabled: ${button("Control")}?.disabled, text: document.body.textContent })`);
      outcomes.push({ boundary: "hidden-pending-enable-busy", observed });
      assert.equal(observed.controlPresent, true);
      assert.equal(observed.disabled, false, "a cancelled enable must not leave Control busy forever");
      await tab.evaluate(`${button("Control")}.click()`);
      await ready();
      assert.equal(await tab.evaluate(`!!${button("Stop")}`), true, "a new explicit request can acquire control");
    } finally { await restoreVisibility(); }
  });
  await t.test("unverified token, host and scope changes invalidate the local draft", async () => {
    const variants = [
      { name: "token", next: { id: "fixture", token: "fixture-new", url: origins[1] } },
      { name: "host", next: { id: "other-fixture", token: "fixture-new", url: origins[1], workspaceKey: "ignored-cross-host" } },
      { name: "scope", next: { id: "fixture", token: "fixture-only", url: origins[0], access: { kind: "device", scopes: ["screen:control"], fullControlVersion: 1 } } },
    ];
    for (const variant of variants) {
      const connection = await fresh();
      holdTyping = true;
      await tab.send("Input.insertText", { text: "ab" });
      await until(() => typing(connection).length === 1, "old unknown input before unverified replacement");
      await tab.send("Input.insertText", { text: "cd" });
      const before = connections.length;
      acceptedTokens.set(new URL(origins[1]).host, new Set(["fixture-new"]));
      await tab.evaluate(`window.__typing.grant(${JSON.stringify(variant.next)})`);
      await until(() => tab.evaluate(`!${sink} && !!${button("Control")}`), "unverified replacement discards old draft");
      outcomes.push({ boundary: `unverified-${variant.name}`, oldTransmitted: typing(connection), replacementConnections: connections.slice(before).map(c => c.received) });
      assert.equal(await tab.evaluate(`!!${button("Send waiting typing to current field")}`), false);
      assert.equal(connections.length, before, "new authority cannot inherit the old held connection");
    }
  });
  await t.test("verified approved token handoff keeps only local draft and requires new Control and field confirmation", async () => {
    const old = await fresh();
    holdTyping = true;
    await tab.send("Input.insertText", { text: "ab" });
    await until(() => typing(old).length === 1, "old-grant unknown input");
    await tab.send("Input.insertText", { text: "cd" });
    acceptedTokens.set(new URL(origins[1]).host, new Set(["fixture-new"]));
    const apiStart = apiRequests.length;
    const before = connections.length;
    const workspaceKey = JSON.stringify(["fixture", origins[0], "fixture-only", null, null]);
    await tab.evaluate(`window.__typing.grant(${JSON.stringify({ id: "fixture", token: "fixture-new", workspaceKey, url: origins[1] })})`);
    await until(() => tab.evaluate(`!!${button("Control")} && !${button("Control")}.disabled`), "new authority needs explicit Control");
    const observed = await tab.evaluate(`({ sinkPresent: !!${sink}, value: ${sink}?.value })`);
    const result = { boundary: "verified-token-handoff", observed, beforeControlConnections: connections.slice(before).map(c => c.received), beforeControlOff: await initiatedOff() };
    outcomes.push(result);
    assert.equal(observed.sinkPresent, true);
    assert.equal(connections.length, before, "workspace continuity cannot acquire the new input lease");
    holdTyping = false;
    await tab.evaluate(`${button("Control")}.click()`);
    await until(() => connections.length > before, "explicit new-grant input connection");
    await ready();
    const next = connections.at(-1);
    assert.deepEqual(typing(next), [], "new Control alone cannot flush the old draft");
    await tab.evaluate(`${button("Send waiting typing to current field")}.click()`);
    await until(() => typing(next).length === 1, "explicit new-grant field confirmation");
    result.afterConfirmation = typing(next);
    assert.deepEqual(result.afterConfirmation.map(a => a.text), ["cd"]);
    assert.equal(next.received.find(m => m.type === "auth").token, "fixture-new");
    assert.equal(next.endpoint, new URL(origins[1]).host);
    assert.ok(apiRequests.slice(apiStart).some(r => r.host === new URL(origins[0]).host && r.authorization === "Bearer fixture-only" && r.body === '{"enabled":false}'));
    assert.equal(apiRequests.slice(apiStart).some(r => r.host === new URL(origins[1]).host && r.authorization === "Bearer fixture-only"), false, "old credentials never move to the new endpoint");
    holdTyping = true;
    await tab.send("Input.insertText", { text: "ef" });
    await until(() => typing(next).length === 2, "unknown input before verified return");
    await tab.send("Input.insertText", { text: "gh" });
    const returnBefore = connections.length;
    await tab.evaluate(`window.__typing.grant(${JSON.stringify({ id: "fixture", token: "fixture-only", workspaceKey, url: origins[0] })})`);
    await until(() => tab.evaluate(`!!${button("Control")} && !${button("Control")}.disabled`), "return grant requires Control");
    assert.equal(connections.length, returnBefore);
    assert.equal(await tab.evaluate(`!!${sink}`), true);
    holdTyping = false;
    await tab.evaluate(`${button("Control")}.click()`);
    await until(() => connections.length > returnBefore, "explicit return-grant input");
    await ready();
    const returned = connections.at(-1);
    assert.deepEqual(typing(returned), []);
    await tab.evaluate(`${button("Send waiting typing to current field")}.click()`);
    await until(() => typing(returned).length === 1, "explicit known-unsent return send");
    result.returned = typing(returned);
    assert.deepEqual(result.returned.map(a => a.text), ["gh"]);
    assert.equal(returned.received.find(m => m.type === "auth").token, "fixture-only");
    await until(() => apiRequests.slice(apiStart).some(r => r.host === new URL(origins[1]).host && r.authorization === "Bearer fixture-new" && r.body === '{"enabled":false}'), "old alternate grant release");
  });
  assert.deepEqual(tab.problems, []);
});
