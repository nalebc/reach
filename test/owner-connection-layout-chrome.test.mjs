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
for (const platform of ["darwin", "win32"]) test(`connected Home stays clear while enrollment supplies Settings actions (${platform})`, { skip: !binary }, async t => {
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
const platform = new URL(location.href).searchParams.get("host") === "win32" ? "win32" : "darwin";
const peer = { id: "mac", name: platform === "win32" ? "Studio-PC" : "Studio-Mac", url: location.origin, token: "fixture", platform };
const device = { ...peer, ownerConnection: 1, access: { kind: "device", scopes: ${JSON.stringify(ALL_SCOPES)} }, roots: [], memory: { total: 1, free: 1 }, network: { connected: true, peers: [] }, capabilities: { files: true, terminal: true, apps: true, screen: true } };
const sessions = Array.from({ length: 8 }, (_, i) => ({ agent: "claude", id: "fixture-" + i, title: "Project conversation " + (i+1), cwd: "/work/reach", status: "idle", updatedAt: Date.now() - i*60000, createdAt: Date.now(), preview: "", archived: false, inApp: true }));
const routes = { "/api/device": device, "/api/terminals": [], "/api/terminals/desktop": { sessions: [] }, "/api/terminals/agents": { agents: [] }, "/api/handoffs": [], "/api/chats": [], "/api/codex": { sessions: [] }, "/api/activity": { activities: [] }, "/api/sessions": { sessions, errors: {} }, "/api/sessions/health": { agents: [{ agent: "claude", name: "Claude", installed: true, signedIn: true, usable: true, supported: true }] }, "/api/sessions/logos": { version: "1", logos: {} }, "/api/sessions/models": { models: [], modes: [], mode: null }, "/api/sessions/commands": { commands: [] }, "/api/clients": { current: "me", clients: [] }, "/api/browser/agents": { agents: [] }, "/api/agents/shortcuts": { shortcuts: [], running: null }, "/api/agents/services": { access: [] }, "/api/agents/admissions": [], "/api/agents/browser-requests": [], "/api/agents/permissions": { permissions: [] }, "/api/notifications": { items: [] }, "/api/screen/displays": { displays: [] }, "/api/screen/control": { enabled: true } };
window.fetch = async input => new Response(JSON.stringify(routes[new URL(typeof input === "string" ? input : input.url, location.href).pathname] || {}), { headers: { "Content-Type": "application/json" } });
window.WebSocket = class {
  constructor(url) { this.url = url; queueMicrotask(() => { if (!this.closed) this.onopen?.(); }); }
  close() { this.closed = true; }
  send() { if (new URL(this.url).pathname === "/ws/presence") queueMicrotask(() => {
    if (!this.closed) this.onmessage?.({ data: JSON.stringify({ type: "presence", devices: [] }) });
  }); }
};
window.__ownerSetup = { starts: 0, stops: 0, state: { state: "preparing" }, update(state) { this.state = state; this.report?.(state); } };
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
    const route = new URL(req.url, "http://fixture").pathname;
    if (route === "/") return res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/entry.css"><div id="root"></div><script type="module" src="/entry.js"></script>');
    if (route !== "/entry.js" && route !== "/entry.css") return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": route.endsWith("css") ? "text/css" : "text/javascript" });
    // Only these two built files, by fixed name (CodeQL js/path-injection).
    res.end(fs.readFileSync(path.join(dir, "page", route === "/entry.js" ? "entry.js" : "entry.css")));
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
    assert.fail(`Timed out: ${expression}; ${JSON.stringify(tab.problems)}; ${await tab.evaluate("document.body.innerText.slice(0, 2000)")}`);
  };
  // Each target is a fixed element lookup written here, never a value
  // spliced into page code (CodeQL js/bad-code-sanitization).
  // A finger reaches only what's on top where it lands: wait, within the
  // same budget, until the element itself is there (as the journeys' tap
  // does), so a covered or still-moving button is never tapped blind.
  const click = async element => {
    await waitFor(`(() => { const b = ${element}; if (!b) return false; b.scrollIntoView({ block: "nearest" }); const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!hit && b.contains(hit); })()`);
    const at = await tab.evaluate(`(() => { const b = ${element}; b.scrollIntoView({ block: "nearest" }); const r = b.getBoundingClientRect(); return { x: r.x+r.width/2, y:r.y+r.height/2 }; })()`);
    await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
    await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await frame();
  };
  const shot = async name => {
    // Allow the compositor and native touch highlight to settle after a tap.
    // Assertions above wait for their actual UI state, independently of this.
    await tab.evaluate("Promise.all([document.fonts.ready, new Promise(r => setTimeout(r, 120))])");
    await frame();
    await tab.evaluate("(() => { const mask = document.createElement('style'); mask.id = 'fixture-screen-mask'; mask.textContent = 'canvas,video { visibility:hidden !important }'; document.head.append(mask); })()");
    const capture = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await tab.evaluate("document.getElementById('fixture-screen-mask').remove()");
    fs.writeFileSync(path.join(report, name + ".png"), Buffer.from(capture.data, "base64"));
  };
  await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const evidence = [];
  for (const [width, height] of [[320, 740], [390, 844], [768, 1024]]) {
    // A phone held as its size says: without an orientation Chrome reports
    // the computer's (landscape), and Screen then turns to fullscreen by
    // itself and fades its bars, the tab bar with them, on a slow machine
    // before the next tap (macOS CI: Home never came back from Screen).
    await tab.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true,
      screenOrientation: { type: width > height ? "landscapePrimary" : "portraitPrimary", angle: width > height ? 90 : 0 } });
    const safeTop = width < 600 ? 44 : 24;
    await tab.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: safeTop, bottom: 34, left: 0, right: 0 } });
    await tab.navigate(`http://${host}:${server.address().port}/?host=${platform}`);
    await waitFor("!!document.querySelector('.home-live') && __ownerSetup.starts === 1 && document.querySelector('.home-connection-line').textContent.includes('Connected')");
    await frame();
    const reload = await tab.evaluate(`(() => {
      const link = document.querySelector('.workspace-refresh');
      const rect = link.getBoundingClientRect();
      return { width: rect.width, height: rect.height, reachable: link.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)), href: link.href };
    })()`);
    assert.ok(reload.width >= 40 && reload.height >= 40 && reload.reachable, `Reload Reach stays visible and tappable at ${width}px`);
    assert.ok(new URL(reload.href).searchParams.has("reach-reconnect"), "reload makes a fresh document request");
    await shot(`initial-${platform}-${width}`);
    assert.ok(await tab.evaluate("!!document.querySelector('.home-hero')"), await tab.evaluate("document.body.innerText"));
    const home = await tab.evaluate(`(() => {
      const rect = s => document.querySelector(s).getBoundingClientRect().toJSON();
      return { hero: rect('.home-hero'), shortcuts: rect('.home-pinned'), nav: rect('.mobile-nav'), width: document.documentElement.scrollWidth,
        notice: !!document.querySelector('.owner-connection-setup'), loaders: document.querySelectorAll('.connection-state,.connection-loading-dot').length };
    })()`);
    assert.equal(home.notice, false, "preparing standby access does not add a Home card");
    assert.equal(home.loaders, 0, "a usable workspace has no connection loader");
    assert.equal(await tab.evaluate("!!document.querySelector('.connection-attention-dot')"), false, "background work asks for no attention");
    assert.ok(home.width <= width, "Home fits the viewport");
    await tab.evaluate("__ownerSetup.update({state:'signin', url:'https://login.tailscale.com/a/fixture'})");
    await frame();
    assert.equal(await tab.evaluate("!!document.querySelector('.owner-connection-setup')"), false, "standby sign-in does not interrupt Home");
    assert.equal(await tab.evaluate("document.querySelector('.workspace-settings').getAttribute('aria-describedby')"), "owner-connection-attention", "actionable setup has one discoverable Settings cue");
    await click(`document.querySelector('.workspace-settings')`);
    await waitFor("!!document.querySelector('.settings-workspace .owner-connection-setup')");
    assert.equal(await tab.evaluate("!!document.querySelector('.owner-connection-setup').closest('.gs-group').querySelector('.connection-row')"), true, "setup lives with the existing Connection settings");
    await click(`document.querySelector('.owner-connection-setup > summary')`);
    assert.equal(await tab.evaluate("document.querySelector('.owner-connection-details a').href"), "https://login.tailscale.com/a/fixture");
    assert.equal(await tab.evaluate("document.querySelectorAll('.owner-connection-setup .spin,.owner-connection-setup .connection-loading-dot').length"), 0, "Settings offers an action rather than another loader");
    await shot(`setup-open-${platform}-${width}`);
    await click(`document.querySelector('.mobile-nav [aria-label="Home"]')`);
    await waitFor("!!document.querySelector('.home-live')");
    await click(`document.querySelector('.mobile-nav [aria-label="Tools"]')`);
    await waitFor("!!document.querySelector('.tools-page')");
    await click(`document.querySelector('.tool-open[aria-label="Chat"]')`);
    await waitFor("!!document.querySelector('.chat-library')");
    assert.equal(await tab.evaluate("!!document.querySelector('.owner-connection-setup')"), false, "no setup notice above the chat header");
    const chat = await tab.evaluate(`(() => {
      const header = document.querySelector('.chat-mobile-header');
      const quick = document.querySelector('.chat-quick-new');
      const outcome = header?.closest('.chat-library')?.querySelector('.outcome-entry');
      return { width: document.documentElement.scrollWidth, back: document.querySelector('.workspace-back').getBoundingClientRect().toJSON(), header: header?.getBoundingClientRect().toJSON(), outcome: !!outcome, quick: quick?.getBoundingClientRect().toJSON(), nav: document.querySelector('.mobile-nav').getBoundingClientRect().toJSON(), starts: __ownerSetup.starts, stops: __ownerSetup.stops };
    })()`);
    assert.ok(chat.width <= width, "Chat fits the viewport");
    assert.ok(chat.back.y >= safeTop, "Back stays below the phone status area");
    if (chat.header?.height) assert.ok(chat.header.y - chat.back.bottom <= 12, `no redundant gap between Back and the chat header (${JSON.stringify({ width, ...chat })})`);
    assert.equal(chat.outcome, false, "no Outcomes promotion above the chat list");
    assert.equal(chat.starts, 1, "navigation keeps the enrollment subscription");
    assert.equal(chat.stops, 0, "working elsewhere doesn't stop setup");
    if (chat.quick?.height) assert.ok(chat.quick.bottom <= chat.nav.top, "chat action and tabs don't overlap");
    await shot(`chat-${platform}-${width}`);
    await tab.evaluate("__ownerSetup.update({state:'error', message:'Sign-in needs attention.'})");
    await frame();
    assert.equal(await tab.evaluate("!!document.querySelector('.owner-connection-setup')"), false, "setup errors don't interrupt Chat");
    await click(`document.querySelector('.mobile-nav [aria-label="Screen"]')`);
    await waitFor("!!document.querySelector('.page-screen')");
    assert.equal(await tab.evaluate("!!document.querySelector('.owner-connection-setup')"), false, "Screen remains clear of setup");
    await click(`document.querySelector('.mobile-nav [aria-label="Home"]')`);
    await waitFor("!!document.querySelector('.home-live')");
    assert.equal(await tab.evaluate("!!document.querySelector('.owner-connection-setup')"), false, "standby errors do not add a Home warning");
    await click(`document.querySelector('.workspace-settings')`);
    await waitFor("!!document.querySelector('.settings-workspace')");
    assert.equal(await tab.evaluate("!!document.querySelector('.owner-connection-setup')"), true, "actionable setup remains reachable in Settings");
    assert.match(await tab.evaluate("document.querySelector('.owner-connection-setup summary').textContent"), /Needs attention/);
    await click(`document.querySelector('.owner-connection-setup > summary')`);
    await click(`document.querySelector('.owner-connection-details button')`);
    assert.equal(await tab.evaluate("__ownerSetup.starts"), 2, "explicit retry restarts one enrollment watcher");
    assert.equal(await tab.evaluate("__ownerSetup.stops"), 1, "retry retires the previous watcher");
    await tab.evaluate("__ownerSetup.update({state:'ready'})");
    await frame();
    assert.equal(await tab.evaluate("!!document.querySelector('.owner-connection-setup')"), false, "completion removes the reminder");
    assert.equal(await tab.evaluate("!!document.querySelector('.connection-attention-dot')"), false, "finished setup clears the Settings cue");
    evidence.push({ platform, width, home, chat });
  }
  fs.writeFileSync(path.join(report, `layout-${platform}.json`), JSON.stringify({ evidence, problems: tab.problems }, null, 2));
  assert.deepEqual(tab.problems, []);
});
