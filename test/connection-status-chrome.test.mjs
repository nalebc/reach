import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { findChrome, launchChrome, openTab } from "./helpers/headless-chrome.mjs";

// Production connection feedback, mascot and CSS in real Chrome. All states
// are synthetic; this does not start Reach or read any host screen or API.
const repo = fileURLToPath(new URL("..", import.meta.url));
const binary = findChrome();
test("connection feedback fits touch viewports and explains loading, errors and offline states", {
  skip: binary ? false : "no Chrome or Chromium installed",
}, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-connection-layout-"));
  const undo = [() => fs.promises.rm(dir, { recursive: true, force: true })];
  t.after(async () => { for (const stop of undo.reverse()) await stop(); });
  const abs = file => JSON.stringify(path.join(repo, file).split(path.sep).join("/"));
  await build({
    stdin: { resolveDir: repo, sourcefile: "connection-layout.tsx", loader: "tsx", contents: `
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Home, LayoutGrid } from "lucide-react";
import { WorkspaceAtmosphere } from ${abs("src/WorkspaceAtmosphere.tsx")};
import ConnectionStatus from ${abs("src/ConnectionStatus.tsx")};
import MobileNav from ${abs("src/MobileNav.tsx")};
${["styles", "atmosphere", "workspace", "identity", "workspace-pages", "app-style"].map(f => `import ${abs(`src/${f}.css`)};`).join("\n")}
let online = true;
Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
sessionStorage.setItem("reach.arrival.v1", "seen");
function Fixture() {
  const [state, setState] = useState({ error: "", needsApproval: false });
  const counts = window.__counts ||= { retry: 0, connect: 0 };
  window.__connectionFixture = {
    show: value => flushSync(() => setState(value)),
    network: value => { online = value; window.dispatchEvent(new Event(value ? "online" : "offline")); },
  };
  return <div className="app-shell"><div className="main-shell">
    <header className="topbar"><span>Studio-Mac</span></header>
    <main className="main-content page-overview"><ConnectionStatus {...state}
      onRetry={() => counts.retry++} onConnect={() => counts.connect++}/></main>
    <MobileNav current="overview" items={[{ id: "overview", label: "Home", icon: <Home/> }, { id: "tools", label: "Tools", icon: <LayoutGrid/> }]} onNavigate={() => {}}/>
  </div></div>;
}
flushSync(() => createRoot(document.getElementById("root")).render(<WorkspaceAtmosphere><Fixture/></WorkspaceAtmosphere>));
` },
    plugins: [{ name: "local-fonts", setup(b) {
      b.onResolve({ filter: /^\/fonts\.css$/ }, () => ({ path: path.join(repo, "public/fonts.css") }));
    } }],
    bundle: true, outdir: path.join(dir, "page"), entryNames: "entry", format: "esm", jsx: "automatic",
    loader: { ".svg": "dataurl" }, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent",
  });
  const server = http.createServer((req, res) => {
    if (req.url === "/favicon.ico") return res.writeHead(204).end();
    if (req.url === "/") return res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><link rel="stylesheet" href="/entry.css"><div id="root"></div><script type="module" src="/entry.js"></script>');
    if (req.url !== "/entry.js" && req.url !== "/entry.css") return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": req.url.endsWith("css") ? "text/css" : "text/javascript" });
    res.end(fs.readFileSync(path.join(dir, "page", req.url === "/entry.js" ? "entry.js" : "entry.css")));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  undo.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const browser = await launchChrome(t, { binary });
  undo.push(() => browser.close());
  const tab = await openTab(browser);
  const frame = () => tab.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
  const waitFor = async expression => {
    const end = Date.now() + 5000;
    while (Date.now() < end) {
      if (await tab.evaluate(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`Timed out: ${expression}; ${JSON.stringify(tab.problems)}`);
  };
  // Targets are fixed element expressions below, not interpolated selectors.
  const click = async element => {
    await waitFor(`(() => { const b = ${element}; if (!b) return false; b.scrollIntoView({ block: "nearest" }); const r = b.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width/2, r.y + r.height/2); return !!hit && b.contains(hit); })()`);
    const at = await tab.evaluate(`(() => { const b = ${element}; const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`);
    await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
    await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await frame();
  };
  const geometry = () => tab.evaluate(`(() => {
    const rect = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON();
    return { width: document.documentElement.scrollWidth, panel: rect('.connection-state'), copy: rect('.connection-state-copy'), action: rect('.connection-state-actions button'), help: rect('.connection-state-help'), nav: rect('.mobile-nav') };
  })()`);
  const fits = (layout, width, state) => {
    assert.ok(layout.width <= width, `${state}: no horizontal overflow at ${width}`);
    assert.ok(layout.panel.left >= 0 && layout.panel.right <= width, `${state}: panel fits at ${width}`);
    assert.ok(layout.copy.bottom <= layout.nav.top - 8, `${state}: feedback stays above navigation at ${width}`);
    if (layout.action) {
      assert.ok(layout.action.height >= 44, `${state}: retry is a touch target`);
      assert.ok(layout.action.bottom <= layout.nav.top - 8, `${state}: action stays above navigation at ${width}`);
    }
  };
  const report = process.env.REACH_TEST_CONNECTION_LAYOUT_EVIDENCE;
  if (report) fs.mkdirSync(report, { recursive: true });
  const shot = async name => {
    if (!report) return;
    // This fixture has no real screen, device identity or API data to capture.
    await frame();
    const capture = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(report, name + ".png"), Buffer.from(capture.data, "base64"));
  };
  await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  const evidence = [];
  for (const [width, height] of [[320, 740], [390, 844], [768, 1024]]) {
    await tab.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true });
    await tab.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: width < 600 ? 44 : 24, bottom: 34, left: 0, right: 0 } });
    await tab.navigate(`http://127.0.0.1:${server.address().port}/`);
    await waitFor("!!window.__connectionFixture && !!document.querySelector('.courier-actor')");
    await frame();
    assert.equal(await tab.evaluate("document.querySelector('.connection-state h1').textContent"), "Opening your workspace");
    assert.match(await tab.evaluate("document.querySelector('[role=status]').textContent"), /Connecting securely.*Checking your saved access/s);
    assert.equal(await tab.evaluate("!!document.querySelector('.connection-state-help')"), false);
    const progress = await geometry();
    fits(progress, width, "progress");
    assert.equal(await tab.evaluate("document.querySelector('.connection-state .reach-scene').classList.contains('is-playing')"), false);
    assert.equal(await tab.evaluate("getComputedStyle(document.querySelector('.connection-state-status .spin')).animationName"), "none");
    const pose = () => tab.evaluate("document.querySelector('.courier-actor').outerHTML");
    const still = await pose();
    await tab.evaluate("new Promise(r => setTimeout(r, 120))");
    assert.equal(await pose(), still, "Reduce Motion keeps the mascot still");
    assert.equal(await tab.evaluate("document.getAnimations().filter(a => a.playState === 'running' && document.querySelector('.connection-state').contains(a.effect.target)).length"), 0, "Reduce Motion stops all feedback animations");
    await shot(`progress-${width}`);

    const error = "The secure connection could not reach Studio-Mac. Diagnostic code: " + "unavailable-".repeat(14);
    await tab.evaluate(`__connectionFixture.show(${JSON.stringify({ error, needsApproval: false })})`);
    await frame();
    assert.equal(await tab.evaluate("document.querySelector('.connection-state-help').open"), false, "diagnostics start collapsed");
    assert.equal(await tab.evaluate("document.querySelector('.connection-state-help p').checkVisibility()"), false);
    assert.equal(await tab.evaluate("document.querySelector('.connection-state-actions button').textContent"), "Try again");
    const failure = await geometry();
    fits(failure, width, "error");
    await click(`document.querySelector('.connection-state-actions button')`);
    assert.equal(await tab.evaluate("__counts.retry"), 1, "retry calls its handler");
    await click(`document.querySelector('.connection-state-help summary')`);
    assert.equal(await tab.evaluate("document.querySelector('.connection-state-help').open"), true);
    assert.equal(await tab.evaluate("document.querySelector('.connection-state-help p').textContent"), error);
    assert.ok(await tab.evaluate("document.querySelector('.connection-state-help p').getBoundingClientRect().height > 0"));
    assert.ok((await geometry()).width <= width, "expanded long diagnostics wrap without horizontal scrolling");
    await shot(`error-details-${width}`);

    await tab.evaluate("__connectionFixture.show({ error: 'This browser’s access was removed.', needsApproval: true })");
    await frame();
    assert.equal(await tab.evaluate("document.querySelector('.connection-state h1').textContent"), "Let’s reconnect");
    assert.equal(await tab.evaluate("document.querySelector('.connection-state-actions button').textContent"), "Connect again");
    assert.equal(await tab.evaluate("!!document.querySelector('.connection-state-status .spin')"), false, "approval is an action state");
    const denial = await geometry();
    fits(denial, width, "approval");
    await click(`document.querySelector('.connection-state-actions button')`);
    assert.deepEqual(await tab.evaluate("__counts"), { retry: 1, connect: 1 });

    await tab.evaluate("__connectionFixture.show({ error: '', needsApproval: false }); __connectionFixture.network(false)");
    await waitFor("document.querySelector('.connection-state h1').textContent === 'You’re offline'");
    assert.match(await tab.evaluate("document.querySelector('.connection-state-copy').textContent"), /Connect this device to the internet.*Waiting for internet/s);
    assert.equal(await tab.evaluate("!!document.querySelector('.connection-state-status .spin')"), false);
    assert.equal(await tab.evaluate("!!document.querySelector('.connection-state-actions')"), false);
    const offline = await geometry();
    fits(offline, width, "offline");
    await shot(`offline-${width}`);
    await tab.evaluate("__connectionFixture.network(true)");
    await waitFor("document.querySelector('.connection-state h1').textContent === 'Opening your workspace'");
    evidence.push({ width, height, progress, failure, denial, offline });
  }
  await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
  await waitFor("document.querySelector('.connection-state .reach-scene').classList.contains('is-playing')");
  assert.equal(await tab.evaluate("getComputedStyle(document.querySelector('.connection-state-status .spin')).animationName"), "spin", "normal loading has active visual feedback");
  if (report) fs.writeFileSync(path.join(report, "layout.json"), JSON.stringify({ scope: "real Chrome, synthetic states, no physical device or network-path validation", evidence, problems: tab.problems }, null, 2));
  assert.deepEqual(tab.problems, []);
});
