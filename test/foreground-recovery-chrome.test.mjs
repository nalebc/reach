import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { findChrome, launchChrome, openTab } from "./helpers/headless-chrome.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const binary = findChrome();

// Actual browser rendering and HTTP responses; synthetic page content only.
// Offline-copy preparation is inert. No Reach instance or host input starts.
test("foreground recovery handles clipped pages, invalid documents and suspended reads in Chrome", { skip: !binary }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-foreground-bash-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await build({
    stdin: { resolveDir: repo, sourcefile: "foreground-fixture.ts", contents: `
import { pageHasContent } from "./src/page-recovery";
import { pageAnswers, currentPageMatches, checkForUpdates, forgetBuild, getUpdateState } from "./src/build-reload";
window.__foreground = { pageHasContent, pageAnswers, currentPageMatches, checkForUpdates, forgetBuild, getUpdateState };
`, loader: "ts" },
    plugins: [{ name: "inert-offline-copy", setup(b) {
      b.onResolve({ filter: /\/offline-shell$/ }, () => ({ path: "offline-copy", namespace: "inert" }));
      b.onLoad({ filter: /.*/, namespace: "inert" }, () => ({ contents: "export const offlineShellEnabled = () => false; export const prepareInterfaceReload = async () => false;" }));
    } }],
    bundle: true, format: "esm", outfile: path.join(dir, "fixture.js"), logLevel: "silent",
  });
  const html = '<!doctype html><html><head><title>Reach fixture</title><script type="module" src="/assets/r2-index-fixture.js"></script></head><body><div id="root"><button>Working page</button></div></body></html>';
  const worker = fileURLToPath(new URL("../dist/sw.js", import.meta.url));
  assert.ok(fs.existsSync(worker), "npm run build prepares the production service worker");
  let responseMode = "healthy";
  const server = http.createServer((req, res) => {
    if (req.url === "/favicon.ico") return res.writeHead(204).end();
    if (req.url === "/sw.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(fs.readFileSync(worker));
    if (req.url === "/assets/r2-index-fixture.js") return res.writeHead(200, { "Content-Type": "text/javascript" }).end(fs.readFileSync(path.join(dir, "fixture.js")));
    if (req.url.startsWith("/probe") || new URL(req.url, "http://fixture").searchParams.has("navigation")) {
      const invalid = {
        doctype: "<!doctype html>",
        truncated: '<html><head><script type="module" src="/assets/r2-index-fixture.js"></script></head>',
        gateway: "<html><body>Temporary gateway failure</body></html>",
        denied: "<html><head><title>Access denied</title></head><body>Access denied</body></html>",
      };
      return res.writeHead(responseMode === "denied" ? 403 : 200, { "Content-Type": "text/html" }).end(invalid[responseMode] || html);
    }
    res.writeHead(200, { "Content-Type": "text/html" }).end(html);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const browser = await launchChrome(t, { binary });
  t.after(() => browser.close());
  const tab = await openTab(browser);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const until = async expression => {
    const end = Date.now() + 10000;
    while (!await tab.evaluate(expression)) {
      assert.ok(Date.now() < end, expression);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const reset = async () => {
    await tab.navigate(origin);
    await until("!!window.__foreground");
  };

  await t.test("content clipped by its retained app container is visibly blank", async () => {
    await reset();
    assert.equal(await tab.evaluate("__foreground.pageHasContent(document)"), true);
    const result = await tab.evaluate(`(() => {
      document.getElementById("root").style.cssText = "height:0;min-height:0;overflow:hidden";
      return { clipHeight: document.getElementById("root").getBoundingClientRect().height,
        retainedButtonHeight: document.querySelector("button").getBoundingClientRect().height,
        content: __foreground.pageHasContent(document) };
    })()`);
    assert.equal(result.clipHeight, 0, "the actual browser clips the app to zero height");
    assert.ok(result.retainedButtonHeight > 0, "retained descendants still have layout boxes");
    assert.equal(result.content, false, "clipped descendants must not suppress blank-page recovery");
    assert.equal(await tab.evaluate(`document.getElementById("root").style.overflow = "visible"; __foreground.pageHasContent(document)`), true, "visible overflow preserves a working page");
    for (const position of ["fixed", "absolute"]) {
      const escaped = await tab.evaluate(`(() => {
        const root = document.getElementById("root"), button = root.querySelector("button");
        root.style.cssText = "height:0;min-height:0;overflow:hidden";
        button.style.cssText = "position:${position};left:20px;top:20px";
        const rect = button.getBoundingClientRect();
        return { hittable: document.elementFromPoint(rect.left + 2, rect.top + 2) === button, content: __foreground.pageHasContent(document) };
      })()`);
      assert.equal(escaped.hittable, true, `${position}: Chrome paints the positioned control outside the clip`);
      assert.equal(escaped.content, true, `${position}: working controls must preserve the current page`);
      const contained = await tab.evaluate(`(() => {
        const root = document.getElementById("root"), button = root.querySelector("button");
        root.style.${position === "fixed" ? "transform = 'translateZ(0)'" : "position = 'relative'"};
        const rect = button.getBoundingClientRect();
        return { hittable: document.elementFromPoint(rect.left + 2, rect.top + 2) === button, content: __foreground.pageHasContent(document) };
      })()`);
      assert.equal(contained.hittable, false, `${position}: its containing block really clips the control`);
      assert.equal(contained.content, false, `${position}: truly clipped controls still need recovery`);
    }
    await tab.evaluate(`document.getElementById("root").style.cssText = "height:0;min-height:0;overflow:hidden"; document.querySelector("button").style.cssText = ""`);
    assert.equal(await tab.evaluate(`document.getElementById("root").style.overflow = "hidden"; document.body.insertAdjacentHTML("beforeend", '<section role="dialog"><button>Review</button></section>'); __foreground.pageHasContent(document)`), true, "an open dialog outside the clipped app preserves work");
  });

  await t.test("a nonempty HTTP success does not certify a usable replacement interface", async () => {
    await reset();
    for (responseMode of ["doctype", "truncated", "gateway"]) {
      assert.equal(await tab.evaluate("__foreground.pageAnswers(location.origin + '/probe')"), false, responseMode);
      assert.equal(await tab.evaluate("document.querySelector('button').textContent"), "Working page");
    }
    responseMode = "healthy";
    assert.equal(await tab.evaluate("__foreground.pageAnswers(location.origin + '/probe')"), true);
  });

  await t.test("ignored cancellation cannot latch future foreground update checks", async () => {
    await reset();
    for (const phase of ["headers", "body"]) {
      const result = await tab.evaluate(`(async () => {
        const load = async () => ${JSON.stringify(phase)} === "headers" ? new Promise(() => {}) : new Response(new ReadableStream({ start() {} }));
        const bounded = promise => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve("still pending"), 100))]);
        __foreground.forgetBuild();
        __foreground.checkForUpdates({ currentPage: () => __foreground.currentPageMatches(document, load, { timeoutMs: 5 }) });
        const comparison = await bounded(__foreground.currentPageMatches(document, load, { timeoutMs: 5 }));
        const ready = await bounded(__foreground.pageAnswers(location.href, load, 5));
        const state = __foreground.getUpdateState();
        __foreground.checkForUpdates({ currentPage: async () => true });
        await Promise.resolve();
        return { comparison, ready, state, nextState: __foreground.getUpdateState() };
      })()`);
      assert.deepEqual(result, { comparison: null, ready: false, state: "offline", nextState: "current" }, phase);
    }
  });
  await t.test("the production service worker replaces malformed successes with recovery and preserves access denials", async () => {
    await reset();
    await tab.evaluate("void navigator.serviceWorker.register('/sw.js')");
    await until("!!navigator.serviceWorker.controller");
    for (responseMode of ["doctype", "truncated", "gateway"]) {
      await tab.send("Page.navigate", { url: origin + "/?navigation=fixture#saved-view" });
      await until("document.title === 'Reconnecting to Reach'");
      const retry = new URL(await tab.evaluate("document.querySelector('a').href"));
      assert.equal(retry.searchParams.get("navigation"), "fixture");
      assert.equal(retry.hash, "#saved-view");
      responseMode = "healthy";
      await tab.evaluate("document.querySelector('a').click()");
      await until("!!window.__foreground");
    }
    responseMode = "denied";
    await tab.send("Page.navigate", { url: origin + "/?navigation=fixture" });
    await until("document.title === 'Access denied'");
    assert.equal(await tab.evaluate("document.body.textContent.trim()"), "Access denied");
  });
  // The deliberately injected navigation failures log their HTTP statuses;
  // script exceptions and errors from any other request still fail the bash.
  assert.deepEqual(tab.problems.filter(problem =>
    !(/^Failed to load resource: the server responded with a status of (403|503)\b/.test(problem) &&
      problem.includes(origin + "/?navigation=fixture"))), []);
});
