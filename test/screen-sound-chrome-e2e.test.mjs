import test from "node:test";
import assert from "node:assert/strict";
import { toneStability } from "./helpers/tone-stability.mjs";
import { createToneTiming, observeToneSource } from "./helpers/tone-timing.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { monitorEventLoopDelay } from "node:perf_hooks";
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
import { createToneTiming, observeToneWebSockets, observeTonePort } from ${abs("test/helpers/tone-timing.mjs")};
const timing = createToneTiming();
window.__toneTiming = timing;
let audio;
const clock = () => ({ audioTime: audio?.currentTime, audioFrame: audio && Math.round(audio.currentTime * audio.sampleRate), rate: audio?.sampleRate });
observeToneWebSockets(window, timing, clock);
const observedPorts = new WeakSet();
// An analyser after the worklet: what the phone's speaker would get; and
// each time the worklet's queue ran dry on a late link ("late").
window.__late = 0;
const connect = AudioWorkletNode.prototype.connect;
AudioWorkletNode.prototype.connect = function (destination, ...rest) {
  audio = this.context;
  if (!observedPorts.has(this.port)) {
    observedPorts.add(this.port);
    observeTonePort(this.port, timing, clock);
  }
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
window.__sample = () => timing.sample(window.__level(), clock());
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
  const timing = createToneTiming();
  const eventLoop = monitorEventLoopDelay({ resolution: 10 });
  eventLoop.enable();
  let tab, binary;
  // Fixed numeric stages: build, policy, start/settle, steady, stop, complete.
  let stage = 0, completed = 0;
  const measurements = {};
  const steady = [];
  t.after(async () => {
    eventLoop.disable();
    try {
      // Keep this before all cleanup, including Chrome's own after hook. A
      // failing assertion must retain the same bounded evidence as a pass.
      let browserTiming;
      try { browserTiming = await tab?.evaluate("window.__toneTiming?.snapshot()"); } catch {}
      const ms = (ns) => Number.isFinite(ns) ? ns / 1e6 : 0;
      const nodeEventLoop = {
        count: eventLoop.count, meanMs: ms(eventLoop.mean), maxMs: ms(eventLoop.max),
        p50Ms: ms(eventLoop.percentile(50)), p95Ms: ms(eventLoop.percentile(95)), p99Ms: ms(eventLoop.percentile(99)),
      };
      const helperTiming = timing.snapshot();
      const report = {
        host: process.platform, ...(binary ? { helper: path.basename(binary) } : {}),
        ...measurements,
        steadyLevels: steady.map((v) => Number.isFinite(v) ? Number(v.toFixed(3)) : null),
        timing: { schema: 1, stage, completed, nodeEventLoop, helper: helperTiming, browser: browserTiming || null },
      };
      const summary = (snapshot) => Object.fromEntries(Object.entries(snapshot?.streams || {})
        .filter(([, stream]) => stream.count)
        .map(([kind, stream]) => [kind, { count: stream.count, maxGapMs: Number(stream.maxGapMs.toFixed(3)) }]));
      t.diagnostic(`audio timing ${JSON.stringify({ stage, completed, nodeEventLoop, helper: summary(helperTiming), browser: summary(browserTiming) })}`);
      await fs.promises.mkdir(path.join(repo, "reports"), { recursive: true });
      await fs.promises.writeFile(path.join(repo, "reports", "sound-chrome-e2e.json"), JSON.stringify(report, null, 2));
    } catch {
      t.diagnostic("audio timing report unavailable");
    } finally {
      for (const step of undo.reverse()) await step().catch(() => {});
    }
  });
  undo.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
  const page = await buildPage(dir);
  // The real helper, its tone on the clock as a capture's packets come.
  binary = process.platform === "win32"
    ? await windowsBinary({ dataDir: dir }, "screen-sound")
    : await desktopBinary({ dataDir: dir }, "screen-sound");
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "private"),
    screen: true,
    // Its tailnet name, so its pages carry the policy a phone gets.
    publicOrigin: "https://mac-a.t.ts.net",
    soundFactory: async () => (handlers) => new SoundSource(binary, ["--self-test", "30", "--live"], observeToneSource(handlers, timing)),
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
  stage = 1;
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
  tab = await openTab(browser);
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
  eventLoop.reset();
  stage = 2;
  const tapped = Date.now();
  await tap();
  await until(`window.__sound?.state === "on"`);
  // Sound within a few seconds: the helper's 440 Hz and 660 Hz, averaged to
  // one channel by the analyser (12000 / 32768 / 2 ≈ 0.18).
  const level = await until(`window.__level() > 0.1 && window.__level()`, 5000);
  const heardIn = Date.now() - tapped;
  Object.assign(measurements, { heardInMs: heardIn, firstLevel: Number(level.toFixed(3)) });
  assert.ok(level < 0.25, `level ${level}`);
  // Then steady for four seconds, after two to settle: the tone's level at
  // every look, but for one blip at most. A shared CI machine can stall the
  // page once (Oct 14, a macOS runner: one 40 ms gap); a queue that runs dry
  // again and again (a source slower than the clock, as the Oct 13 stand-in
  // was) still fails.
  await new Promise((r) => setTimeout(r, 2000));
  stage = 3;
  const lateBefore = await tab.evaluate("window.__late");
  for (let i = 0; i < 40; i++) {
    steady.push(await tab.evaluate("window.__sample()"));
    await new Promise((r) => setTimeout(r, 100));
  }
  const late = (await tab.evaluate("window.__late")) - lateBefore;
  const stability = toneStability(steady, late);
  Object.assign(measurements, { ranDry: late, blips: stability.blips });
  assert.ok(stability.passed, `levels ${steady.map((v) => v.toFixed(3))}; ran dry ${late} times; blips ${stability.blips}`);
  assert.deepEqual(tab.problems.filter((p) => /Refused|Content Security Policy|worklet/i.test(p)), [], "nothing refused by the page's policy");
  stage = 4;
  await tap();
  await until(`window.__sound?.state === "off"`);
  Object.assign(measurements, { phoneRate: await tab.evaluate("window.__rate"), chrome: (await browser.send("Browser.getVersion")).product });
  stage = 5;
  completed = 1;
});
