import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  findChrome,
  launchChrome,
  openTab,
} from "./helpers/headless-chrome.mjs";

// Production Home, shortcuts and Screen controls in real Chrome. API responses,
// preview pixels and input are simulated; no Reach instance or OS control starts.
const repo = fileURLToPath(new URL("..", import.meta.url));
const binary = findChrome();
test(
  "Home and Screen fit phone and tablet widths; shortcuts remain editable by touch",
  { skip: binary ? false : "no Chrome or Chromium installed" },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-home-layout-"));
    const page = path.join(dir, "page");
    const report =
      process.env.REACH_TEST_HOME_LAYOUT_EVIDENCE || path.join(dir, "evidence");
    fs.mkdirSync(report, { recursive: true });
    const undo = [() => fs.promises.rm(dir, { recursive: true, force: true })];
    t.after(async () => {
      for (const fn of undo.reverse()) await fn();
    });
    const abs = (file) =>
      JSON.stringify(path.join(repo, file).split(path.sep).join("/"));
    await build({
      stdin: {
        resolveDir: repo,
        sourcefile: "home-layout-fixture.tsx",
        loader: "tsx",
        contents: `
import React, { useState, useContext } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { Home, MonitorUp, LayoutGrid, Bell, Settings, ChevronDown } from "lucide-react";
import HomeLive from ${abs("src/HomeLive.tsx")};
import { WorkspaceAtmosphere } from ${abs("src/WorkspaceAtmosphere.tsx")};
import { MotionContext } from ${abs("src/motion.ts")};
import Screen from ${abs("src/Screen.tsx")};
import { PinnedTools, usePinnedTools } from ${abs("src/ToolsPage.tsx")};
import MobileNav from ${abs("src/MobileNav.tsx")};
import { workspaceCapabilities } from ${abs("src/capabilities.ts")};
import { computer } from ${abs("test/dom/fakes/computer.mjs")};
${["styles", "atmosphere", "workspace", "identity", "workspace-pages", "app-style", "workspace-navigation"].map((f) => `import ${abs(`src/${f}.css`)};`).join("\n")}
const peer = { id: "mac", url: location.origin, name: "My MacBook Pro", token: "fixture", platform: "darwin" };
const device = { ...peer, roots: [], network: { connected: true, peers: [] }, capabilities: { screen: true, files: true, terminal: true } };
const features = workspaceCapabilities(device);
const routes = { "/api/handoffs": [], "/api/agents/admissions": [], "/api/agents/browser-requests": [], "/api/clients": { clients: [] }, "/api/agents/permissions": { permissions: [] }, "/api/agents/services": { access: [] }, "/api/screen/displays": { displays: [] }, "/api/screen/control": { enabled: true }, "/api/notifications": { items: [] } };
window.fetch = async input => new Response(JSON.stringify(routes[new URL(typeof input === "string" ? input : input.url, location.href).pathname] || {}), { headers: { "Content-Type": "application/json" } });
if (!localStorage.getItem("reach.pinnedTools")) localStorage.setItem("reach.pinnedTools", '["sessions"]');
sessionStorage.setItem("reach.arrival.v1", "seen");
function Fixture() {
 const motion = useContext(MotionContext);
 const [page, setPage] = useState("overview");
 const [pending, setPending] = useState(false);
 const { pinned, toggle, move } = usePinnedTools();
 window.__fixture = { page, toggleMotion: () => flushSync(() => motion.toggle()), show: p => flushSync(() => setPage(p)), needs: () => flushSync(() => setPending(true)), frame: () => computer.frame() };
 return <div className="app-shell"><div className="main-shell">
 <header className="topbar"><button className="workspace-computer"><i className="status-dot"/><span>{device.name}</span><ChevronDown size={16}/></button><div className="topbar-right"><button className="icon-button notification-bell"><Bell size={20}/></button><button className="icon-button workspace-settings"><Settings size={20}/></button></div></header>
 <main className={"main-content page-" + page}>{page === "screen" ? <Screen peer={peer} device={device} toast={() => {}} onChanged={() => {}}/> : <HomeLive features={features} device={device} peer={peer} active="mac" connections={{ mac: { state: "connected", devices: [] } }} connection="Tailscale" chats={[]} pending={pending ? [{ id: "ask", name: "Sam", scopes: ["screen"] }] : []} decide={() => {}} navigate={setPage} openChat={() => {}} refreshSessions={() => {}} toast={() => {}} pinnedTools={<PinnedTools features={features} pinned={pinned} onTogglePin={toggle} onMove={move} onNavigate={() => {}}/>}/>}</main>
 <MobileNav current={page} items={[{ id:"overview", label:"Home", icon:<Home/> },{ id:"screen", label:"Screen", icon:<MonitorUp/> },{ id:"tools", label:"Tools", icon:<LayoutGrid/> }]} onNavigate={setPage}/>
 </div></div>;
}
flushSync(() => createRoot(document.getElementById("root")).render(<WorkspaceAtmosphere><Fixture/></WorkspaceAtmosphere>));
`,
      },
      plugins: [
        {
          name: "simulated-desktop",
          setup(build) {
            build.onResolve({ filter: /\?url/ }, (args) => ({
              path: path.resolve(args.resolveDir, args.path.split("?")[0]),
              namespace: "fixture-url",
            }));
            build.onLoad(
              { filter: /.*/, namespace: "fixture-url" },
              (args) => ({
                contents: fs.readFileSync(args.path),
                loader: "file",
              }),
            );
            build.onResolve({ filter: /^\/fonts\.css$/ }, () => ({
              path: path.join(repo, "public/fonts.css"),
            }));
            for (const [source, fake] of [
              ["useRemoteScreen", "remote-screen"],
              ["useDesktopInput", "desktop-input"],
              ["DesktopSurface", "desktop-surface"],
            ]) {
              build.onResolve(
                { filter: new RegExp(`/${source}(\\.tsx?)?$`) },
                () => ({ path: path.join(repo, `test/dom/fakes/${fake}.mjs`) }),
              );
            }
          },
        },
      ],
      bundle: true,
      outdir: page,
      entryNames: "entry",
      format: "esm",
      jsx: "automatic",
      loader: { ".svg": "dataurl", ".png": "dataurl" },
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    });
    const files = new Map([
      [
        "/",
        {
          type: "text/html",
          body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/entry.css"><div id="root"></div><script type="module" src="/entry.js"></script>',
        },
      ],
      [
        "/entry.js",
        {
          type: "text/javascript",
          body: fs.readFileSync(path.join(page, "entry.js")),
        },
      ],
      [
        "/entry.css",
        {
          type: "text/css",
          body: fs.readFileSync(path.join(page, "entry.css")),
        },
      ],
    ]);
    const server = http.createServer((req, res) => {
      if (req.url === "/favicon.ico") return res.writeHead(204).end();
      const file = files.get(req.url);
      if (!file) return res.writeHead(404).end();
      res.writeHead(200, { "Content-Type": file.type }).end(file.body);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    undo.push(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });
    const browser = await launchChrome(t, { binary });
    undo.push(() => browser.close());
    const tab = await openTab(browser);
    const frame = () =>
      tab.evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
    // Each target is a fixed element lookup written here, never a value
    // spliced into page code (CodeQL #357).
    const click = async (element) => {
      const at = await tab.evaluate(`(() => { const b = ${element}; b.scrollIntoView({ block: "nearest" }); const r = b.getBoundingClientRect(); return { x: r.x+r.width/2, y:r.y+r.height/2 }; })()`);
      await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
      await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await frame();
    };
    await tab.send("Emulation.setTouchEmulationEnabled", {
      enabled: true,
      maxTouchPoints: 5,
    });
    await tab.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    const pause = ms => tab.evaluate(`new Promise(resolve => setTimeout(resolve, ${ms}))`);
    const pose = () => tab.evaluate(`(() => { const actor = document.querySelector('.home-scene .courier-actor'); return [actor.getAttribute('transform'), ...[...actor.querySelectorAll('.actor-arm')].map(a => a.getAttribute('d'))]; })()`);
    const results = [];
    for (const [width, height] of [
      [320, 740],
      [390, 844],
      [768, 1024],
    ]) {
      // The phone's own orientation too: unset, Chrome reports this
      // computer's landscape screen, and Screen reads a phone on its side.
      await tab.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: true,
        screenOrientation: { type: "portraitPrimary", angle: 0 },
      });
      await tab.navigate(`http://127.0.0.1:${server.address().port}/`);
      await frame();
      // Synthetic preview pixels make its alignment with the actual laptop visible.
      await tab.evaluate(
        `(() => { const c = document.querySelector('.home-peek'); c.width = 800; c.height = 500; const ctx = c.getContext('2d'); ctx.fillStyle = '#edf5f1'; ctx.fillRect(0,0,800,500); ctx.fillStyle = '#456b5a'; ctx.fillRect(0,0,800,52); ctx.fillStyle = '#bddace'; ctx.fillRect(20,72,160,408); ctx.fillStyle = '#89b4a1'; for (let i=0;i<5;i++) ctx.fillRect(205,95+i*65,565,25); })()`,
      );
      const result = await tab.evaluate(`(() => {
      const hero = document.querySelector('.home-hero').getBoundingClientRect();
      const nav = document.querySelector('.mobile-nav').getBoundingClientRect();
      const shortcuts = document.querySelector('.home-pinned').getBoundingClientRect();
      return { width: innerWidth, scroll: document.documentElement.scrollWidth, hero: hero.toJSON(), shortcuts: shortcuts.toJSON(), nav: nav.toJSON(), scene: document.querySelector(".home-scene > svg").getAttribute("viewBox"), name: document.querySelector(".home-hero-text h1")?.textContent ?? null, pill: !!document.querySelector(".home-screen-open"), shortcutWidth: document.querySelector(".shortcut-open").getBoundingClientRect().width, mascot: !!document.querySelector('.home-scene .courier-actor'), target: document.querySelector('.home-screen-launch').getBoundingClientRect().height };
    })()`);
      results.push(result);
      const shot = await tab.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      fs.writeFileSync(
        path.join(report, `home-${width}.png`),
        Buffer.from(shot.data, "base64"),
      );
      assert.ok(result.scroll <= width, `no overflow at ${width}`);
      assert.equal(result.scene, "0 -40 400 275", "original laptop and mascot framing");
      // The name is in the top bar only; the card says how it is, and the
      // preview itself opens Screen (also in the bottom bar), no pill.
      assert.equal(result.name, null);
      assert.equal(result.pill, false);
      assert.ok(result.shortcutWidth >= result.shortcuts.width - 1, "a lone shortcut uses the available width");
      assert.ok(result.mascot, "Reach mascot stays in the scene");
      assert.ok(result.target >= 44, "the preview is a touch target for Screen");
      assert.ok(
        result.shortcuts.bottom < height - 65,
        "shortcuts fit in the first screen",
      );
      assert.equal(await tab.evaluate("document.querySelectorAll('button button').length"), 0, "mascot and Screen have independent native buttons");
      const reducedPose = await pose();
      await click(`document.querySelector('[aria-label="Say hello to Reach"]')`);
      assert.equal(await tab.evaluate("window.__fixture.page"), "overview", "greeting never opens Screen");
      assert.equal(await tab.evaluate("document.querySelector('.reach-mascot-feedback').textContent"), "Reach says hello!");
      assert.equal(await tab.evaluate("document.querySelector('.reach-mascot-button').closest('[aria-hidden=true]') === null"), true, "the greeting is accessible");
      await pause(120);
      assert.deepEqual(await pose(), reducedPose, "Reduce Motion keeps the mascot still after a tap");
      assert.equal(await tab.evaluate("getComputedStyle(document.querySelector('.home-hero-scene'), '::before').animationName"), "none");
      const heartShot = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(path.join(report, `greeting-${width}.png`), Buffer.from(heartShot.data, "base64"));
      await click(`document.querySelector('[aria-label="Edit shortcuts"]')`);
      await click(`document.querySelector('[aria-label="Add Files to Shortcuts"]')`);
      await click(`document.querySelector('[aria-label="Move Files earlier"]')`);
      const editShot = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(path.join(report, `shortcuts-${width}.png`), Buffer.from(editShot.data, "base64"));
      await click(`document.querySelector('[aria-label="Done editing shortcuts"]')`);
      assert.deepEqual(
        await tab.evaluate(
          'JSON.parse(localStorage.getItem("reach.pinnedTools"))',
        ),
        ["files", "sessions"],
      );
      await tab.evaluate(
        'localStorage.setItem("reach.pinnedTools", \'["sessions"]\')',
      );
      await tab.evaluate('window.__fixture.show("screen")');
      await frame();
      await click(`document.querySelector('[aria-label="Control"]')`);
      await tab.evaluate("window.__fixture.frame()");
      await frame();
      const controls = await tab.evaluate(
        `(() => { const bar = document.querySelector('.screen-bar'); const box = bar.getBoundingClientRect(); return { box: box.toJSON(), visible: [...bar.querySelectorAll('button')].filter(b => b.getBoundingClientRect().width).map(b => ({ label:b.getAttribute('aria-label'), width:b.getBoundingClientRect().width, height:b.getBoundingClientRect().height })) }; })()`,
      );
      result.controls = controls;
      assert.ok(
        controls.box.left >= 0 && controls.box.right <= width,
        `toolbar fits at ${width}`,
      );
      if (width <= 600) {
        assert.deepEqual(
          controls.visible.map((b) => /fullscreen/.test(b.label) ? "Fullscreen" : b.label),
          [
            "Stop",
            "Open phone keyboard",
            "Pointer mode: Direct touch",
            "Fullscreen",
            "Screen options",
          ],
        );
        assert.ok(
          controls.visible.every((b) => b.height >= 44),
          "phone controls stay finger-sized",
        );
      }
    }
    await tab.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: "portraitPrimary", angle: 0 } });
    await tab.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "no-preference" }] });
    await tab.navigate(`http://127.0.0.1:${server.address().port}/`);
    await frame();
    assert.equal(await tab.evaluate("document.querySelector('.courier-actor').getAttribute('data-action')"), "wave", "Home opens with a welcome wave");
    assert.equal(await tab.evaluate("getComputedStyle(document.querySelector('.home-hero-scene'), '::before').animationName"), "home-glow");
    const waveBefore = await pose();
    await pause(180);
    assert.notDeepEqual(await pose(), waveBefore, "the greeting is actually animated");
    await tab.evaluate(`new Promise((resolve, reject) => {
      const until = performance.now() + 8000;
      const check = () => {
        if (document.querySelector('.courier-actor').getAttribute('data-action') === 'walk') return resolve();
        if (performance.now() > until) return reject(Error('the welcome did not finish'));
        requestAnimationFrame(check);
      };
      check();
    })`);
    const roaming = await pose();
    await pause(180);
    assert.notDeepEqual((await pose())[0], roaming[0], "the existing route resumes after the welcome");
    const at = await tab.evaluate(`(() => { const b = document.querySelector('.reach-mascot-button'); const r = b.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2 }; })()`);
    await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at] });
    await frame();
    const heldPose = await pose();
    await pause(200);
    assert.deepEqual(await pose(), heldPose, "the moving target stays put while pressed");
    await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await frame();
    assert.equal(await tab.evaluate("window.__fixture.page"), "overview");
    assert.equal(await tab.evaluate("document.querySelector('.reach-mascot-feedback').textContent"), "Reach says hello!");
    assert.equal(await tab.evaluate("document.querySelector('.courier-actor').getAttribute('data-action')"), "wave", "a tap waves from the current position");
    await tab.evaluate("window.__previousHeart = document.querySelector('.reach-mascot-heart'); document.querySelector('.reach-mascot-button').focus()");
    await tab.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r", windowsVirtualKeyCode: 13 });
    await tab.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await frame();
    assert.equal(await tab.evaluate("window.__fixture.page"), "overview", "keyboard greeting never opens Screen");
    assert.equal(await tab.evaluate("window.__previousHeart !== document.querySelector('.reach-mascot-heart')"), true, "Enter triggers a fresh greeting");
    await tab.evaluate("document.activeElement.blur(); window.__fixture.toggleMotion()");
    await frame();
    const pausedPose = await pose();
    await pause(180);
    assert.deepEqual(await pose(), pausedPose, "Reach's motion setting also stops the mascot");
    assert.equal(await tab.evaluate("getComputedStyle(document.querySelector('.home-hero-scene'), '::before').animationName"), "none");
    await click(`document.querySelector('.home-screen-launch')`);
    assert.equal(await tab.evaluate("window.__fixture.page"), "screen", "tapping the preview still opens Screen");
    fs.writeFileSync(
      path.join(report, "layout.json"),
      JSON.stringify(
        {
          scope:
            "real Chrome; simulated API, preview and input; no physical devices",
          results,
          problems: tab.problems,
        },
        null,
        2,
      ),
    );
    assert.deepEqual(tab.problems, []);
  },
);
