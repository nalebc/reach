import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome, openTab } from "./helpers/headless-chrome.mjs";
import { WebSocketServer } from "ws";
import { closeServer } from "./helpers/close-server.mjs";

// The speaker tapped the moment it shows, in a real browser with the real
// hook (src/useScreenSound.ts). React runs a page's effects a moment after
// it puts the page on screen; the hook turned the sound off there for
// another computer, on the first computer too, so a tap in that moment was
// undone and the sound never asked for (Oct 26: macOS CI, Chrome tapped as
// soon as the page loaded; 8 of 20 tries with the page's processor slowed).
// Here every tap comes in that moment: as soon as the button is in the
// page, before React's effects.
const repo = fileURLToPath(new URL("..", import.meta.url));
const abs = (p) => JSON.stringify(path.join(repo, p).split(path.sep).join("/"));

async function buildPage(dir, other) {
  const src = path.join(dir, "src");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "main.js"), `import React from ${abs("node_modules/react/index.js")};
import { createRoot } from ${abs("node_modules/react-dom/client.js")};
import { useScreenSound } from ${abs("src/useScreenSound.ts")};
const urls = { a: location.origin, b: ${JSON.stringify(other)} };
let choose;
function App() {
  const [computer, setComputer] = React.useState("a");
  choose = setComputer;
  const sound = useScreenSound({ id: computer, name: computer, url: urls[computer], token: "test", platform: "darwin" }, true);
  window.__sound = { computer, on: sound.on, state: sound.state, error: sound.error };
  // A new button for each computer, as the screen shows a new one.
  return React.createElement("button", { key: computer, onClick: () => (sound.on ? sound.stop() : sound.start()) }, "Sound");
}
// The tap, the moment the button is in the page: a mutation observer runs
// before React's effects do.
window.__tapOnShow = true;
const root = document.getElementById("root");
new MutationObserver((records) => {
  for (const record of records)
    for (const node of record.addedNodes)
      if (node.nodeName === "BUTTON" && window.__tapOnShow) {
        window.__tapOnShow = false;
        node.click();
      }
}).observe(root, { childList: true, subtree: true });
window.__show = (computer, tap) => { window.__tapOnShow = tap; choose(computer); };
createRoot(root).render(React.createElement(App));
`);
  fs.writeFileSync(path.join(src, "index.html"), `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="./main.js"></script></body></html>`);
  const out = path.join(dir, "page");
  const { build } = await import("vite");
  await build({
    configFile: false, root: src, logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { outDir: out, emptyOutDir: true, target: "chrome100" },
  });
  return out;
}

// A computer that says its sound is ready to each connection that signs in,
// and counts them.
function computer(page) {
  const asked = { sound: 0 };
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://x").pathname.replace(/^\/+/, "") || "index.html";
    const file = page && path.join(page, path.normalize(name));
    if (!file || !file.startsWith(page) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.setHeader("Content-Type", /\.m?js$/.test(file) ? "text/javascript" : "text/html");
    res.end(fs.readFileSync(file));
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (new URL(req.url, "http://x").pathname !== "/ws/screen-sound") return socket.destroy();
    sockets.handleUpgrade(req, socket, head, (ws) => ws.once("message", (data) => {
      if (JSON.parse(String(data)).type !== "auth") return ws.terminate();
      asked.sound++;
      ws.send(JSON.stringify({ type: "ready" }));
    }));
  });
  // Its sound connections first: a browser still holds them.
  const close = async (label) => {
    for (const ws of sockets.clients) ws.terminate();
    await closeServer(server, { label });
  };
  return { server, asked, close };
}

test("a tap on the speaker the moment it shows turns the sound on; another computer starts off", {
  skip: !findChrome() && "needs Chrome",
}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-sound-tap-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const b = computer();
  await new Promise((r) => b.server.listen(0, "127.0.0.1", r));
  t.after(() => b.close("second computer"));
  const a = computer(await buildPage(dir, `http://127.0.0.1:${b.server.address().port}`));
  await new Promise((r) => a.server.listen(0, "127.0.0.1", r));
  t.after(() => a.close("first computer"));
  // A muted browser whose sound may start without a real gesture (the taps
  // here are the page's own clicks).
  const browser = await launchChrome(t, { args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required"] });
  const tab = await openTab(browser);
  const until = async (expression, what) => {
    const end = Date.now() + 15000;
    while (!(await tab.evaluate(expression))) {
      if (Date.now() > end) assert.fail(`${what}. Page: ${JSON.stringify(await tab.evaluate("window.__sound"))}; sound asked of the first computer ${a.asked.sound}, of the other ${b.asked.sound}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  await tab.navigate(`http://127.0.0.1:${a.server.address().port}/`);
  await until(`window.__sound?.computer === "a" && window.__sound.state === "on"`, "the speaker, tapped as it showed, never turned the sound on");

  await tab.evaluate(`window.__show("b", true)`);
  await until(`window.__sound?.computer === "b" && window.__sound.state === "on"`, "another computer's speaker, tapped as it showed, never turned its sound on");

  // Back to the first computer, untapped: its sound waits for a tap.
  const asked = a.asked.sound;
  await tab.evaluate(`window.__show("a", false)`);
  await until(`window.__sound?.computer === "a" && window.__sound.state === "off"`, "the first computer's sound, not tapped again, stayed on");
  assert.deepEqual(await tab.evaluate("window.__sound"), { computer: "a", on: false, state: "off", error: "" });
  assert.equal(a.asked.sound, asked, "nothing asked the first computer for its sound again");
});
