import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { findChrome, launchChrome, openTab } from "./helpers/headless-chrome.mjs";

// The terminal's last line in sight above the keys, in a real browser with
// Reach's own terminal CSS (src/terminals.css), xterm and its fit addon, at
// an iPhone's width: the fit addon measured the terminal's box with its
// padding (everything is border-box), took a row too many, and the prompt
// sat under the "Type, then Enter…" bar (Oct 18, on the owner's iPhone).
const file = (path) => new URL(`../${path}`, import.meta.url);
const page = `<!doctype html><html><head><meta name="viewport" content="width=440">
<link rel="stylesheet" href="/xterm.css"><link rel="stylesheet" href="/terminals.css"><style>
*, *::before, *::after { box-sizing: border-box; } body { margin: 0; }
.terminal-page { position: static; height: 700px; }
.key-row { flex: 0 0 52px; border-top: 1px solid #fff2; }
</style></head><body><div class="terminal-page"><div class="terminal-bar">Terminal</div>
<div class="terminal-screen" id="screen"></div><div class="key-row" id="keys"></div></div>
<script src="/xterm.js"></script><script src="/fit.js"></script><script>
window.check = () => {
  const screen = document.getElementById("screen");
  screen.replaceChildren();
  const term = new Terminal({ fontSize: 12 }), fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(screen);
  fit.fit();
  for (let i = 0; i < 200; i++) term.write("line " + i + " " + "x".repeat(70) + "\\r\\n");
  term.write("LAST %");
  return new Promise((done) => setTimeout(() => {
    const rows = [...screen.querySelectorAll(".xterm-rows > div")];
    const last = rows.at(-1).getBoundingClientRect(), keys = document.getElementById("keys").getBoundingClientRect();
    const text = screen.querySelector(".xterm-screen").getBoundingClientRect(), box = screen.getBoundingClientRect();
    done({ lastBottom: last.bottom, keysTop: keys.top, textRight: text.right, boxRight: box.right, last: rows.at(-1).textContent.trim() });
  }, 300));
};
</script></body></html>`;

test("a terminal's last line stays above the keys, its last column inside the screen", {
  skip: !findChrome() && "needs Chrome",
}, async (t) => {
  const served = {
    "/xterm.js": file("node_modules/@xterm/xterm/lib/xterm.js"),
    "/xterm.css": file("node_modules/@xterm/xterm/css/xterm.css"),
    "/fit.js": file("node_modules/@xterm/addon-fit/lib/addon-fit.js"),
    "/terminals.css": file("src/terminals.css"),
  };
  const server = http.createServer((req, res) => {
    if (served[req.url]) {
      res.setHeader("content-type", req.url.endsWith(".css") ? "text/css" : "text/javascript");
      return res.end(fs.readFileSync(served[req.url]));
    }
    res.setHeader("content-type", "text/html");
    res.end(page);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const browser = await launchChrome(t, {});
  const tab = await openTab(browser);
  await tab.navigate(`http://127.0.0.1:${server.address().port}/`);
  const seen = await tab.evaluate("window.check()");
  assert.equal(seen.last, "LAST %");
  assert.ok(seen.lastBottom <= seen.keysTop, `the last line ends at ${seen.lastBottom}, the keys start at ${seen.keysTop}`);
  assert.ok(seen.textRight <= seen.boxRight + 0.5, `the text ends at ${seen.textRight}, the screen at ${seen.boxRight}`);
});
