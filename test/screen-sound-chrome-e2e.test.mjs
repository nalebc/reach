import test from "node:test";
import assert from "node:assert/strict";
import { toneStability } from "./helpers/tone-stability.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { desktopBinary, windowsBinary } from "../server/desktop-native.mjs";
import { SoundSource } from "../server/screen-sound.mjs";
import { findChrome, launchChrome, openTab } from "./helpers/headless-chrome.mjs";

// The computer's sound in a real browser engine, end to end: the real sound
// helper (scripts/native/screen-sound.swift on a Mac, screen-sound.cs on a
// Windows PC), built as Reach builds it, plays its tone on the clock through
// a real Reach; headless Chrome (muted: nothing plays on this computer)
// loads a page built from the real hook (src/useScreenSound.ts), served with
// the policy Reach gives its own pages, and taps the speaker. Passing means
// the helper's packets crossed the server and the socket, the worklet loaded
// under script-src 'self', and the tone came out of it, steady. Only the OS
// capture itself is left out (no CI runner has speakers or Screen Recording);
// Safari on an iPhone is a different engine: this says nothing about it.
const repo = fileURLToPath(new URL("..", import.meta.url));
const chrome = findChrome();
const required = process.env.CI === "true" && (
  (process.platform === "darwin" && process.env.REACH_TEST_SOUND_CHROME === "1") ||
  (process.platform === "win32" && process.env.REACH_TEST_WINDOWS_DESKTOP === "1")
);
if (required && !chrome) throw Error("The serial native audio validation requires Chrome or Chromium.");
const skip = !chrome
  ? "no Chrome or Chromium on this computer (set REACH_TEST_CHROME to one)"
  : process.platform === "darwin"
    ? process.env.CI === "true" && process.env.REACH_TEST_SOUND_CHROME !== "1" ? "the serial native lane runs clocked browser audio" : false
    : process.platform === "win32"
      ? process.env.REACH_TEST_WINDOWS_DESKTOP === "1" ? false : "the real-Windows lane runs it (it builds the PC's sound helper)"
      : "sound comes from a Mac or a Windows PC";

async function buildPage(dir) {
  const src = path.join(dir, "src");
  fs.mkdirSync(src);
  const abs = (p) => JSON.stringify(path.join(repo, p).split(path.sep).join("/"));
  fs.writeFileSync(
    path.join(src, "main.js"),
    `import React from ${abs("node_modules/react/index.js")};
import { createRoot } from ${abs("node_modules/react-dom/client.js")};
import { useScreenSound } from ${abs("src/useScreenSound.ts")};
// An analyser after the worklet: what the phone's speaker would get; and
// each time the worklet's queue ran dry on a late link ("late").
window.__late = 0;
const connect = AudioWorkletNode.prototype.connect;
AudioWorkletNode.prototype.connect = function (destination, ...rest) {
  this.port.onmessage = (event) => {
    if (event.data?.type === "late") window.__late++;
  };
  const analyser = this.context.createAnalyser();
  analyser.fftSize = 2048;
  connect.call(this, analyser);
  window.__analyser = analyser;
  window.__rate = this.context.sampleRate;
  return connect.call(this, destination, ...rest);
};
window.__level = () => {
  const a = window.__analyser;
  if (!a) return 0;
  const d = new Float32Array(a.fftSize);
  a.getFloatTimeDomainData(d);
  return Math.sqrt(d.reduce((s, v) => s + v * v, 0) / d.length);
};
const token = new URLSearchParams(location.search).get("token");
function App() {
  const sound = useScreenSound({ id: "mac", name: "Mac", url: location.origin, token, platform: "darwin" }, true);
  window.__sound = { state: sound.state, error: sound.error, on: sound.on };
  return React.createElement("button", { onClick: () => (sound.on ? sound.stop() : sound.start()) }, "Sound");
}
createRoot(document.getElementById("root")).render(React.createElement(App));
`,
  );
  fs.writeFileSync(
    path.join(src, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module" src="./main.js"></script></body></html>`,
  );
  const out = path.join(dir, "page");
  const { build } = await import("vite");
  await build({
    configFile: false,
    root: src,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: { outDir: out, emptyOutDir: true, target: "chrome100" },
  });
  return out;
}

test("in a real browser, the speaker plays the real helper's sound under Reach's own page policy", { skip, timeout: 300000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-sound-e2e-"));
  const undo = [];
  t.after(async () => {
    for (const step of undo.reverse()) await step().catch(() => {});
  });
  undo.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  const page = await buildPage(dir);
  // The real helper, its tone on the clock as a capture's packets come.
  const binary = process.platform === "win32"
    ? await windowsBinary({ dataDir: dir }, "screen-sound")
    : await desktopBinary({ dataDir: dir }, "screen-sound");
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    screen: true,
    // Its tailnet name, so its pages carry the policy a phone gets.
    publicOrigin: "https://mac-a.t.ts.net",
    soundFactory: async () => (handlers) => new SoundSource(binary, ["--self-test", "30", "--live"], handlers),
  });
  undo.push(() => reach.close());
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const reachPort = reach.server.address().port;
  // The policy Reach sends with its pages on the tailnet (not its local one).
  const policy = await new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: reachPort, path: "/", headers: { host: "mac-a.t.ts.net" } }, (res) => {
      res.resume();
      resolve(res.headers["content-security-policy"]);
    }).on("error", reject);
  });
  const scripts = policy.split(";").map((part) => part.trim().split(/\s+/))
    .find(([directive]) => directive === "script-src")?.slice(1);
  assert.deepEqual(scripts, ["'self'", "'wasm-unsafe-eval'"],
    "private recovery permits WASM compilation; scripts and worklets stay same-origin without JavaScript eval or inline scripts");
  assert.doesNotMatch(policy, /127\.0\.0\.1/);
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  // The page's own address serves it with that policy; its sound socket
  // goes on to Reach as Tailscale Serve hands a phone's over.
  const server = http.createServer((req, res) => {
    const name = new URL(req.url, "http://x").pathname.replace(/^\/+/, "") || "index.html";
    const file = path.join(page, path.normalize(name));
    if (!file.startsWith(page) || !fs.existsSync(file)) return res.writeHead(404).end();
    res.setHeader("Content-Security-Policy", policy);
    res.setHeader("Content-Type", /\.m?js$/.test(file) ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html");
    res.end(fs.readFileSync(file));
  });
  server.on("upgrade", (req, client, head) => {
    const upstream = net.connect(reachPort, "127.0.0.1", () => {
      const headers = { ...req.headers, host: "mac-a.t.ts.net", origin: "https://mac-a.t.ts.net", "x-forwarded-for": "100.64.0.10" };
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  undo.push(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  const browser = await launchChrome(t, { args: ["--mute-audio", "--autoplay-policy=user-gesture-required"] });
  undo.push(() => browser.close());
  const tab = await openTab(browser);
  await tab.navigate(`http://127.0.0.1:${server.address().port}/?token=${encodeURIComponent(owner.token)}`);
  const tap = async () => {
    const at = await tab.evaluate(`(() => { const r = document.querySelector("button").getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ["mousePressed", "mouseReleased"])
      await tab.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
  };
  const until = async (expression, ms = 15000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = await tab.evaluate(expression);
      if (value) return value;
      if (Date.now() > end) assert.fail(`${expression} never held. Page: ${JSON.stringify(await tab.evaluate("window.__sound"))}; problems: ${JSON.stringify(tab.problems)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const tapped = Date.now();
  await tap();
  await until(`window.__sound?.state === "on"`);
  // Sound within a few seconds: the helper's 440 Hz and 660 Hz, averaged to
  // one channel by the analyser (12000 / 32768 / 2 ≈ 0.18).
  const level = await until(`window.__level() > 0.1 && window.__level()`, 5000);
  const heardIn = Date.now() - tapped;
  assert.ok(level < 0.25, `level ${level}`);
  // Then steady for four seconds, after two to settle: the tone's level at
  // every look, but for one blip at most. A shared CI machine can stall the
  // page once (Oct 14, a macOS runner: one 40 ms gap); a queue that runs dry
  // again and again (a source slower than the clock, as the Oct 13 stand-in
  // was) still fails.
  await new Promise((r) => setTimeout(r, 2000));
  const lateBefore = await tab.evaluate("window.__late");
  const steady = [];
  for (let i = 0; i < 40; i++) {
    steady.push(await tab.evaluate("window.__level()"));
    await new Promise((r) => setTimeout(r, 100));
  }
  const late = (await tab.evaluate("window.__late")) - lateBefore;
  const stability = toneStability(steady, late);
  assert.ok(stability.passed, `levels ${steady.map((v) => v.toFixed(3))}; ran dry ${late} times; blips ${stability.blips}`);
  assert.deepEqual(tab.problems.filter((p) => /Refused|Content Security Policy|worklet/i.test(p)), [], "nothing refused by the page's policy");
  await tap();
  await until(`window.__sound?.state === "off"`);
  await fs.promises.mkdir(path.join(repo, "reports"), { recursive: true });
  await fs.promises.writeFile(
    path.join(repo, "reports", "sound-chrome-e2e.json"),
    JSON.stringify({ host: process.platform, helper: path.basename(binary), heardInMs: heardIn, firstLevel: Number(level.toFixed(3)), steadyLevels: steady.map((v) => Number(v.toFixed(3))), ranDry: late, blips: stability.blips, phoneRate: await tab.evaluate("window.__rate"), chrome: (await browser.send("Browser.getVersion")).product }, null, 2),
  );
});
