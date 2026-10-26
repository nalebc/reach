import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { findChrome, launchChrome, openTab } from "./helpers/headless-chrome.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// The complete App and its production CSS, with simulated API replies,
// enrollment, preview and remote input. No Reach instance or host control.
const repo = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const binary = findChrome();
test("pending owner setup stays below Home content and out of working views", { skip: !binary }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-setup-layout-"));
  const report = process.env.REACH_TEST_SETUP_LAYOUT_EVIDENCE || path.join(dir, "evidence");
  fs.mkdirSync(report, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const abs = file => JSON.stringify(path.join(repo, file).split(path.sep).join("/"));
  await build({
    stdin: { resolveDir: repo, sourcefile: "setup-layout.tsx", loader: "tsx", contents: `
import React from "react";
import { createRoot } from "react-dom/client";
${["styles", "atmosphere", "workspace", "identity", "workspace-pages", "app-style"].map(f => `import ${abs(`src/${f}.css`)};`).join("\n")}
const peer = { id: "mac", name: "Lebdiris-MacBook-Pro", url: location.origin, token: "fixture", platform: "darwin" };
const device = { ...peer, ownerConnection: 1, access: { kind: "device", scopes: ${JSON.stringify(ALL_SCOPES)} }, roots: [], memory: { total: 1, free: 1 }, network: { connected: true, peers: [] }, capabilities: { files: true, terminal: true, apps: true, screen: true } };
const sessions = Array.from({ length: 8 }, (_, i) => ({ agent: "claude", id: "fixture-" + i, title: "Project conversation " + (i+1), cwd: "/work/reach", status: "idle", updatedAt: Date.now() - i*60000, createdAt: Date.now(), preview: "", archived: false, inApp: true }));
const routes = { "/api/device": device, "/api/terminals": [], "/api/terminals/desktop": { sessions: [] }, "/api/terminals/agents": { agents: [] }, "/api/handoffs": [], "/api/chats": [], "/api/codex": { sessions: [] }, "/api/activity": { activities: [] }, "/api/sessions": { sessions, errors: {} }, "/api/sessions/health": { agents: [{ agent: "claude", name: "Claude", installed: true, signedIn: true, usable: true, supported: true }] }, "/api/sessions/logos": { version: "1", logos: {} }, "/api/sessions/models": { models: [], modes: [], mode: null }, "/api/sessions/commands": { commands: [] }, "/api/clients": { current: "me", clients: [] }, "/api/browser/agents": { agents: [] }, "/api/agents/shortcuts": { shortcuts: [], running: null }, "/api/agents/services": { access: [] }, "/api/agents/admissions": [], "/api/agents/browser-requests": [], "/api/agents/permissions": { permissions: [] }, "/api/notifications": { items: [] }, "/api/screen/displays": { displays: [] }, "/api/screen/control": { enabled: true } };
window.fetch = async input => new Response(JSON.stringify(routes[new URL(typeof input === "string" ? input : input.url, location.href).pathname] || {}), { headers: { "Content-Type": "application/json" } });
window.WebSocket = class { close() {} send() {} };
window.__ownerSetup = { starts: 0, stops: 0, state: { state: "signin", url: "https://login.tailscale.com/a/fixture" }, update(state) { this.state = state; this.report?.(state); } };
localStorage.setItem("reach.devices", JSON.stringify([peer]));
localStorage.setItem("reach.active", peer.id);
localStorage.setItem("reach.chatAgent", "claude");
localStorage.setItem("reach.pinnedTools", '["sessions"]');
sessionStorage.setItem("reach.arrival.v1", "seen");
sessionStorage.removeItem("reach.place");
history.replaceState(null, "");
const { default: App } = await import(${abs("src/App.tsx")});
createRoot(document.getElementById("root")).render(<App/>);
` },
    plugins: [{ name: "simulated-host", setup(b) {
      b.onResolve({ filter: /\?url/ }, a => {
        const file = a.path.split("?")[0];
        return { path: file.startsWith(".") ? path.resolve(a.resolveDir, file) : require.resolve(file), namespace: "fixture-url" };
      });
      b.onLoad({ filter: /.*/, namespace: "fixture-url" }, a => ({ contents: fs.readFileSync(a.path), loader: "file" }));
      b.onResolve({ filter: /^\/fonts\.css$/ }, () => ({ path: path.join(repo, "public/fonts.css") }));
      for (const [source, fake] of [["owner-connection", "owner-enrollment"], ["useRemoteScreen", "remote-screen"], ["useDesktopInput", "desktop-input"], ["DesktopSurface", "desktop-surface"]]) {
        b.onResolve({ filter: new RegExp(`/${source}(\\.tsx?)?$`) }, () => ({ path: path.join(repo, `test/dom/fakes/${fake}.mjs`) }));
      }
    } }],
    bundle: true, outdir: path.join(dir, "page"), entryNames: "entry", format: "esm", jsx: "automatic",
    loader: { ".svg": "dataurl", ".png": "dataurl" }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
  });
  const server = http.createServer((req, res) => {
    if (req.url === "/favicon.ico") return res.writeHead(204).end();
    if (req.url === "/") return res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/entry.css"><div id="root"></div><script type="module" src="/entry.js"></script>');
    if (req.url !== "/entry.js" && req.url !== "/entry.css") return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": req.url.endsWith("css") ? "text/css" : "text/javascript" });
    res.end(fs.readFileSync(path.join(dir, "page", req.url.slice(1))));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const host = "reach-layout.test.ts.net";
  const browser = await launchChrome(t, { binary, hosts: [host] });
  const tab = await openTab(browser);
  const frame = () => tab.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  const waitFor = async expression => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (await tab.evaluate(expression)) return;
      await new Promise(r => setTimeout(r, 30));
    }
    assert.fail(`Timed out: ${expression}; ${JSON.stringify(tab.problems)}`);
  };
  const click = async selector => {
    await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`);
    const at = await tab.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); b.scrollIntoView({ block: "nearest" }); const r = b.getBoundingClientRect(); return { x: r.x+r.width/2, y:r.y+r.height/2 }; })()`);
    await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
    await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await frame();
  };
  const shot = async name => {
    // Allow the compositor and native touch highlight to settle after a tap.
    // Assertions above wait for their actual UI state, independently of this.
    await tab.evaluate("Promise.all([document.fonts.ready, new Promise(r => setTimeout(r, 120))])");
    await frame();
    const capture = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(report, name + ".png"), Buffer.from(capture.data, "base64"));
  };
  await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const evidence = [];
  for (const [width, height] of [[320, 740], [390, 844], [768, 1024]]) {
    await tab.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true });
    const safeTop = width < 600 ? 44 : 24;
    await tab.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: safeTop, bottom: 34, left: 0, right: 0 } });
    await tab.navigate(`http://${host}:${server.address().port}/`);
    await waitFor("!!document.querySelector('.owner-connection-setup')");
    await frame();
    await shot(`initial-${width}`);
    assert.ok(await tab.evaluate("!!document.querySelector('.home-hero')"), await tab.evaluate("document.body.innerText"));
    const home = await tab.evaluate(`(() => {
      const rect = s => document.querySelector(s).getBoundingClientRect().toJSON();
      return { hero: rect('.home-hero'), shortcuts: rect('.home-pinned'), notice: rect('.owner-connection-setup'), nav: rect('.mobile-nav'), open: document.querySelector('.owner-connection-setup').open, width: document.documentElement.scrollWidth };
    })()`);
    assert.equal(home.open, false, "setup starts collapsed");
    assert.ok(home.notice.y >= home.shortcuts.bottom, "setup follows the primary Home content");
    assert.ok(home.notice.height <= 96, "pending setup is a compact row");
    assert.ok(home.notice.bottom < home.nav.top, "reminder and navigation don't overlap");
    assert.ok(home.width <= width, "Home fits the viewport");
    await shot(`home-${width}`);
    await click('.owner-connection-setup > summary');
    assert.equal(await tab.evaluate("document.querySelector('.owner-connection-setup').open"), true);
    assert.equal(await tab.evaluate("document.querySelector('.owner-connection-details a').href"), "https://login.tailscale.com/a/fixture");
    await shot(`setup-open-${width}`);
    await click('.mobile-nav [aria-label="Tools"]');
    await waitFor("!!document.querySelector('.tools-page')");
    await click('.tool-open[aria-label="Chat"]');
    await waitFor("!!document.querySelector('.chat-library')");
    assert.equal(await tab.evaluate("!!document.querySelector('.owner-connection-setup')"), false, "no setup notice above the chat header");
    const chat = await tab.evaluate(`(() => {
      const header = document.querySelector('.chat-mobile-header');
      const quick = document.querySelector('.chat-quick-new');
      return { width: document.documentElement.scrollWidth, back: document.querySelector('.workspace-back').getBoundingClientRect().toJSON(), header: header?.getBoundingClientRect().toJSON(), quick: quick?.getBoundingClientRect().toJSON(), nav: document.querySelector('.mobile-nav').getBoundingClientRect().toJSON(), starts: __ownerSetup.starts, stops: __ownerSetup.stops };
    })()`);
    assert.ok(chat.width <= width, "Chat fits the viewport");
    assert.ok(chat.back.y >= safeTop, "Back stays below the phone status area");
    if (chat.header?.height) assert.ok(chat.header.y - chat.back.bottom <= 12, "no redundant gap between Back and the chat header");
    assert.equal(chat.starts, 1, "navigation keeps the enrollment subscription");
    assert.equal(chat.stops, 0, "working elsewhere doesn't stop setup");
    if (chat.quick?.height) assert.ok(chat.quick.bottom <= chat.nav.top, "chat action and tabs don't overlap");
    await shot(`chat-${width}`);
    await tab.evaluate("__ownerSetup.update({state:'error', message:'Sign-in needs attention.'})");
    await frame();
    assert.equal(await tab.evaluate("!!document.querySelector('.owner-connection-setup')"), false, "setup errors don't interrupt Chat");
    await click('.mobile-nav [aria-label="Screen"]');
    await waitFor("!!document.querySelector('.page-screen')");
    assert.equal(await tab.evaluate("!!document.querySelector('.owner-connection-setup')"), false, "Screen remains clear of setup");
    await click('.mobile-nav [aria-label="Home"]');
    await waitFor("!!document.querySelector('.home-live')");
    assert.match(await tab.evaluate("document.querySelector('.owner-connection-setup summary').textContent"), /needs attention/);
    await click('.workspace-settings');
    await waitFor("!!document.querySelector('.settings-workspace')");
    assert.equal(await tab.evaluate("!!document.querySelector('.owner-connection-setup')"), true, "setup is also reachable from Settings");
    await tab.evaluate("__ownerSetup.update({state:'ready'})");
    await frame();
    assert.equal(await tab.evaluate("!!document.querySelector('.owner-connection-setup')"), false, "completion removes the reminder");
    evidence.push({ width, home, chat });
  }
  fs.writeFileSync(path.join(report, "layout.json"), JSON.stringify({ evidence, problems: tab.problems }, null, 2));
  assert.deepEqual(tab.problems, []);
});
