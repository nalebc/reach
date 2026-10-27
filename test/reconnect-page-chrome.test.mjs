import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import express from "express";
import { fileURLToPath } from "node:url";
import { serveBuild } from "../server/delivery.mjs";
import { findChrome, launchChrome, openTab, testCertificate } from "./helpers/headless-chrome.mjs";

// Oct 26, a Home Screen web app on an iPhone: after it sat idle it showed a
// blank white page until it was closed. A load that finds no network shows
// the browser's own failure there (white, in a Home Screen app) unless
// Reach's worker answers it, and the worker was registered only by a page
// that saved its offline copy or turned on notifications. Real Chrome with
// Reach's production build and worker: an owner page that did neither, its
// computer gone, reloads into "Reconnecting to Reach…", and back at the same
// link once the computer answers. (WebKit and a physical iPhone aren't run.)
const binary = findChrome(), dist = fileURLToPath(new URL("../dist/", import.meta.url));

test("an owner page that never saved its offline copy reloads into Reach's reconnecting page, and back once the computer answers", {
  skip: !process.env.CI && !binary && "Chrome/Chromium is not installed", timeout: 90000,
}, async (t) => {
  assert.ok(binary, "actual Chrome is required in CI");
  assert.ok(fs.existsSync(path.join(dist, "sw.js")), "npm run build must prepare the production build first");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-reconnect-page-")), host = "computer.reconnect.ts.net";
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tailnet = path.join(root, "tailnet");
  fs.mkdirSync(tailnet);
  const cert = await testCertificate(root, host);
  const app = express();
  // Reach's interface only: no computer behind it, so nothing is paired.
  app.use("/api", (_req, res) => res.status(503).end());
  serveBuild(app, express, dist, { tailnetDir: tailnet });
  let server, port = 0;
  const sockets = new Set();
  const up = () => new Promise((resolve) => {
    server = https.createServer(cert, app);
    server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
    server.listen(port, "127.0.0.1", () => { port = server.address().port; resolve(); });
  });
  // The computer gone: nothing listens, open connections end.
  const down = () => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve); });
  t.after(() => server?.listening && down());
  await up();
  const browser = await launchChrome(t, { binary, hosts: [host], spki: cert.spki });
  t.after(() => browser.close());
  const tab = await openTab(browser);
  const origin = `https://${host}:${port}`;
  const until = async (expression, what, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await tab.evaluate(expression).catch(() => null);
      if (value) return value;
      if (Date.now() > end) assert.fail(`${what}: ${JSON.stringify(await tab.evaluate("({ url: location.href, title: document.title, text: document.body?.innerText.slice(0, 200) })").catch((error) => error.message))}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  await tab.navigate(origin + "/");
  await until("!!navigator.serviceWorker?.controller", "Reach's worker took the page");
  assert.equal(await tab.evaluate("localStorage.getItem('reach.offline-shell.enabled')"), null, "no offline copy was saved");

  await down();
  await tab.navigate(origin + "/");
  await until("document.title === 'Reconnecting to Reach'", "a load with the computer gone opens Reach's reconnecting page");
  const shown = await tab.evaluate("JSON.stringify({ html: document.documentElement.outerHTML.slice(0, 400), text: document.body.innerText })"); assert.match(JSON.parse(shown).text, /Reconnecting to Reach…/, shown);
  assert.equal(await tab.evaluate("getComputedStyle(document.body).backgroundColor"), "rgb(17, 24, 22)", "Reach's dark page, not a blank one");
  assert.equal(await tab.evaluate("location.href"), origin + "/", "at the same link");

  // The computer answers again: the page retries by itself, at the same link.
  await up();
  await until("document.title !== 'Reconnecting to Reach' && !!document.getElementById('root')", "back on Reach once the computer answers", 20000);
  assert.equal(await tab.evaluate("location.origin"), origin);
});
