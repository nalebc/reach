import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { findChrome, launchChrome, openTab } from "./helpers/headless-chrome.mjs";

// Oct 27: "the app sometimes freezes: I can scroll but taps and typing do
// nothing". Real Chrome, held as a phone with touch, and the production
// watcher (src/stall-watch.ts): what each kind of freeze reports, that a
// page closed while frozen is reported on its next start (and a normal
// reload or a page put away isn't), and that no report carries the page's
// words. What sends the reports is the page's own stand-in here; the
// computer's side is test/phone-stalls.test.mjs.
const repo = fileURLToPath(new URL("..", import.meta.url));
const binary = findChrome();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a frozen page, a late tap, a layer over the page and a tap without a click are each reported, without the page's words", {
  skip: binary ? false : "no Chrome or Chromium installed", timeout: 120000,
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-stall-watch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const abs = JSON.stringify(path.join(repo, "src/stall-watch.ts").split(path.sep).join("/"));
  await build({
    stdin: { resolveDir: repo, sourcefile: "stall-fixture.ts", loader: "ts", contents: `
import { watchStalls } from ${abs};
window.__sent = [];
watchStalls(async (reports) => { const answer = window.__answer || "taken"; if (answer === "taken") window.__sent.push(...reports); return answer; },
  { page: () => "files", route: () => "browser" });
` },
    bundle: true, outdir: dir, entryNames: "entry", format: "esm", logLevel: "silent",
  });
  const page = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
<body style="margin:0;height:200vh">
<button class="tool-open" aria-label="Secret plan.txt" style="position:absolute;left:40px;top:100px;width:200px;height:60px">Secret words</button>
<div class="eats-click" style="position:absolute;left:40px;top:300px;width:200px;height:60px">Secret note</div>
<script type="module" src="/entry.js"></script></body>`;
  const server = http.createServer((req, res) => {
    if (req.url === "/favicon.ico") return res.writeHead(204).end();
    if (req.url === "/entry.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(fs.readFileSync(path.join(dir, "entry.js")));
    if (req.url === "/" || req.url.startsWith("/?")) return res.writeHead(200, { "Content-Type": "text/html" }).end(page);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchChrome(t, { binary });
  t.after(() => browser.close());
  const tab = await openTab(browser);
  await tab.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: "portraitPrimary", angle: 0 } });
  await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  const sent = () => tab.evaluate("JSON.stringify(window.__sent || [])").then(JSON.parse);
  const until = async (check, what, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const reports = await sent();
      const found = reports.filter(check);
      if (found.length) return found;
      if (Date.now() > end) assert.fail(`${what}: ${JSON.stringify(reports)}`);
      await pause(100);
    }
  };
  const tap = async (x, y) => {
    await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const open = async () => {
    await tab.navigate(origin + "/");
    await until(() => true, "the watcher started", 3000).catch(() => {});
    await tab.evaluate("new Promise((r) => setTimeout(r, 300))");
  };
  await tab.navigate(origin + "/");
  await tab.evaluate("new Promise((r) => setTimeout(r, 500))");

  // The page's own code busy for 1.5 s while in front.
  await tab.evaluate("(() => { const s = performance.now(); while (performance.now() - s < 1500); })()");
  const [stall] = await until((r) => r.kind === "stall", "a stall");
  assert.ok(stall.ms >= 1200 && stall.ms < 3000, `the stall's length: ${stall.ms}`);
  assert.deepEqual([stall.page, stall.route, stall.visible], ["files", "browser", true]);

  // A tap while the page is busy: it reaches the page's code late.
  await tab.evaluate("setTimeout(() => { const s = performance.now(); while (performance.now() - s < 1200); }, 0), true");
  await pause(100);
  await tap(140, 130);
  const [late] = await until((r) => r.kind === "slow-input", "a late tap");
  assert.ok(late.ms >= 700, `the tap's delay: ${late.ms}`);
  assert.equal(late.target, "button.tool-open");

  // A clear layer over the page takes every tap: three taps say what's there.
  await tab.evaluate(`(() => { const d = document.createElement("div"); d.className = "stuck-overlay"; d.style.cssText = "position:fixed;inset:0;z-index:9"; document.body.append(d); })()`);
  for (let i = 0; i < 3; i++) { await tap(140, 130); await pause(150); }
  const [covered] = await until((r) => r.kind === "repeat-taps", "three taps on the layer");
  assert.deepEqual([covered.under, covered.interactive], ["div.stuck-overlay", false]);
  await tab.evaluate(`document.querySelector(".stuck-overlay").remove()`);
  await pause(4100);
  // Three taps on a button that does nothing: the button, which is a control.
  for (let i = 0; i < 3; i++) { await tap(140, 130); await pause(150); }
  const pressed = await until((r) => r.kind === "repeat-taps" && r.under === "button.tool-open", "three taps on the button");
  assert.equal(pressed[0].interactive, true);

  // A tap the page swallowed: no click ever came.
  await tab.evaluate(`document.querySelector(".eats-click").addEventListener("touchend", (e) => e.preventDefault())`);
  await tap(140, 330);
  const [swallowed] = await until((r) => r.kind === "no-click", "a tap without a click");
  assert.equal(swallowed.under, "div.eats-click");

  // Nothing of the page's words or labels in any report.
  const all = JSON.stringify(await sent());
  assert.doesNotMatch(all, /Secret/i);

  // Not taken now (the computer away): kept, and sent after a reload.
  await tab.evaluate(`window.__answer = "later"`);
  await tab.evaluate("(() => { const s = performance.now(); while (performance.now() - s < 1200); })()");
  await pause(1200);
  assert.ok((await tab.evaluate(`JSON.parse(localStorage.getItem("reach.stall.queue") || "[]").length`)) >= 1, "kept for later");
  await open();
  await until((r) => r.kind === "stall", "the kept report sent after the reload");
  assert.equal(await tab.evaluate(`localStorage.getItem("reach.stall.queue")`), null, "sent, then forgotten");
  // That reload was the page going away first: no unclean end.
  assert.equal((await sent()).filter((r) => r.kind === "unclean-end").length, 0);

  // Refused for good (not the owner's device): dropped, not retried.
  await tab.evaluate(`window.__answer = "refused"`);
  await tab.evaluate("(() => { const s = performance.now(); while (performance.now() - s < 1200); })()");
  await pause(1500);
  assert.equal(await tab.evaluate(`localStorage.getItem("reach.stall.queue")`), null, "dropped");

  // Ended while in front, never put away (closed while frozen): said on the
  // next start. Ended after being put away: nothing.
  for (const [state, expected] of [["visible", 1], ["hidden", 0]]) {
    const { identifier } = await tab.send("Page.addScriptToEvaluateOnNewDocument", { source:
      `localStorage.setItem("reach.stall.beat", JSON.stringify({ state: ${JSON.stringify(state)}, at: Date.now() - 5000, page: "screen", route: "app", build: "" }))` });
    await open();
    await tab.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    await tab.evaluate("new Promise((r) => setTimeout(r, 800))");
    const ends = (await sent()).filter((r) => r.kind === "unclean-end");
    assert.equal(ends.length, expected, `${state}: ${JSON.stringify(ends)}`);
    if (expected) {
      assert.deepEqual([ends[0].page, ends[0].route], ["screen", "app"]);
      assert.ok(ends[0].ms >= 4500 && ends[0].ms < 60000, `how long ago it froze: ${ends[0].ms}`);
    }
  }
  assert.deepEqual(tab.problems, []);
});
