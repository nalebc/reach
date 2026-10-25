import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { findChrome, launchChrome, openTab } from "./helpers/headless-chrome.mjs";

// Real Chrome touch/click targeting of the actual MobileNav component and its
// production CSS. Only the arrival of device capabilities is controlled. This
// starts no Reach server, native terminal, OS UI or physical phone.
const repo = fileURLToPath(new URL("..", import.meta.url));
const binary = findChrome();

test("MobileNav: a native Chrome tap keeps Tools when startup items move Screen under the finger", { skip: binary ? false : "no Chrome or Chromium installed" }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-mobile-nav-"));
  const page = path.join(dir, "page");
  const report = process.env.REACH_TEST_MOBILE_NAV_EVIDENCE || path.join(repo, "reports", "mobile-nav");
  fs.mkdirSync(report, { recursive: true });
  const undo = [async () => fs.promises.rm(dir, { recursive: true, force: true })];
  t.after(async () => { for (const step of undo.reverse()) await step(); });
  const abs = (file) => JSON.stringify(path.join(repo, file).split(path.sep).join("/"));
  await build({
    stdin: {
      resolveDir: repo,
      sourcefile: "mobile-nav-fixture.tsx",
      loader: "tsx",
      contents: `import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import ${abs("src/workspace.css")};
import MobileNav from ${abs("src/MobileNav.tsx")};
const items = [
  { id: "overview", label: "Home", icon: "H" },
  { id: "screen", label: "Screen", icon: "S" },
  { id: "tools", label: "Tools", icon: "T" },
];
window.__nav = { calls: [], trace: [], changeOnEnd: false };
function Fixture() {
  const [visible, setVisible] = useState(items.filter(item => item.id !== "screen"));
  const [current, setCurrent] = useState("overview");
  window.__nav.full = () => flushSync(() => setVisible(items));
  window.__nav.reset = () => {
    window.__nav.calls = []; window.__nav.trace = []; window.__nav.changeOnEnd = false;
    flushSync(() => { setVisible(items.filter(item => item.id !== "screen")); setCurrent("overview"); });
  };
  return <div className="app-shell"><MobileNav items={visible} current={current}
    onNavigate={id => { window.__nav.calls.push(["go", id]); setCurrent(id); }} /></div>;
}
for (const type of ["pointerdown", "pointerup", "pointercancel", "touchstart", "touchend", "click"]) {
  document.addEventListener(type, event => {
    const button = event.target.closest?.("button");
    const at = event.changedTouches?.[0] || event;
    window.__nav.trace.push({ type, label: button?.getAttribute("aria-label"), x: at.clientX, y: at.clientY, detail: event.detail, trusted: event.isTrusted });
    if (type === "touchend" && window.__nav.changeOnEnd) {
      window.__nav.changeOnEnd = false;
      window.__nav.full();
    }
  }, true);
}
flushSync(() => createRoot(document.getElementById("root")).render(<Fixture />));
window.__nav.ready = true;
`,
    },
    bundle: true,
    outdir: page,
    entryNames: "entry",
    format: "esm",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "silent",
  });
  const files = new Map([
    ["/", { type: "text/html", body: '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/entry.css"><style>body{margin:0;background:#101512}</style><div id="root"></div><script type="module" src="/entry.js"></script>' }],
    ["/entry.js", { type: "text/javascript", body: fs.readFileSync(path.join(page, "entry.js")) }],
    ["/entry.css", { type: "text/css", body: fs.readFileSync(path.join(page, "entry.css")) }],
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
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await tab.navigate(`http://127.0.0.1:${server.address().port}/`);
  const frame = () => tab.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  assert.equal(await tab.evaluate("window.__nav?.ready"), true);
  const outcomes = [];
  for (const update of ["while-held", "after-pointer-up"]) {
    await tab.evaluate("window.__nav.reset()");
    await frame();
    const at = await tab.evaluate(`(() => {
      const button = document.querySelector('[aria-label="Tools"]');
      const r = button.getBoundingClientRect();
      return { x: r.x + 12, y: r.y + r.height / 2, initial: [...document.querySelectorAll("nav button")].map(b => b.getAttribute("aria-label")) };
    })()`);
    if (update === "after-pointer-up") await tab.evaluate("window.__nav.changeOnEnd = true");
    await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: at.x, y: at.y }] });
    if (update === "while-held") {
      await tab.evaluate("window.__nav.full()");
      await frame();
    }
    await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await frame();
    const result = await tab.evaluate(`(() => ({ calls: window.__nav.calls, trace: window.__nav.trace,
      coordinateTarget: document.elementFromPoint(${at.x}, ${at.y})?.closest("button")?.getAttribute("aria-label"),
      final: [...document.querySelectorAll("nav button")].map(b => b.getAttribute("aria-label")) }))()`);
    outcomes.push({ update, at, ...result });
    const shot = await tab.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(report, `${update}.png`), Buffer.from(shot.data, "base64"));
  }
  const evidence = { browser: await browser.send("Browser.getVersion"), platform: process.platform, scope: "actual MobileNav and CSS, native Chrome touch/click; controlled capability arrival; no Reach/native OS/physical phone", outcomes, problems: tab.problems };
  fs.writeFileSync(path.join(report, "native-touch.json"), JSON.stringify(evidence, null, 2) + "\n");
  t.diagnostic(JSON.stringify(outcomes));
  for (const outcome of outcomes) {
    assert.equal(outcome.coordinateTarget, "Screen", "the newly inserted Screen really occupies the original Tools coordinate");
    assert.deepEqual(outcome.calls, [["go", "tools"]], `${outcome.update}: the original Tools action runs exactly once; Screen never runs`);
    assert.equal(outcome.trace.filter(event => event.type === "click").length, 1, "one native compatibility click");
    assert.equal(outcome.trace.find(event => event.type === "click").trusted, true);
  }
  assert.deepEqual(tab.problems, []);
});
