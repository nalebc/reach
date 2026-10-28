import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { closeServer } from "../helpers/close-server.mjs";

// The iPhone's own fullscreen for Reach's live picture (src/watch-fullscreen.ts),
// in real iOS WebKit: Mobile Safari in an iOS simulator, a real UIKit tap on
// the Fullscreen button through XCUITest (REACH_TEST_IOS_PROJECT, its
// testWatchFullscreen), the production module playing a live canvas into a
// video. iOS must begin its own video fullscreen, and its close button must
// bring the page back. Simulated: the touch hardware; real: WebKit, iOS's
// player. (A physical iPhone isn't run.)
const repo = fileURLToPath(new URL("../..", import.meta.url));
const project = process.env.REACH_TEST_IOS_PROJECT;
const simulator = process.env.REACH_TEST_IOS_SIMULATOR;
const asked = process.platform !== "darwin" ? "Mac only" : !project || !simulator ? "set REACH_TEST_IOS_PROJECT and REACH_TEST_IOS_SIMULATOR" : false;

test("iPhone: the Fullscreen button opens iOS's own fullscreen for the live picture, and its close comes back", { skip: asked, timeout: 600000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-watch-ios-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const abs = JSON.stringify(path.join(repo, "src/watch-fullscreen.ts").split(path.sep).join("/"));
  await build({
    stdin: { resolveDir: repo, sourcefile: "watch-fixture.ts", loader: "ts", contents: `
import { prepareWatch, systemVideoFullscreen } from ${abs};
const say = (name, extra = {}) => fetch("/event", { method: "POST", body: JSON.stringify({ name, ...extra }) });
const canvas = document.querySelector("canvas");
const context = canvas.getContext("2d");
let n = 0;
// A live picture: the computer's screen stand-in, a new frame ten times a second.
setInterval(() => { n++; context.fillStyle = "hsl(" + (n * 7 % 360) + ",60%,40%)"; context.fillRect(0, 0, 640, 400); context.fillStyle = "#fff"; context.font = "48px sans-serif"; context.fillText("frame " + n, 40, 120); }, 100);
say("supported", { value: systemVideoFullscreen() });
const watch = prepareWatch(canvas, { entered: () => say("entered"), left: () => say("left") });
const video = document.querySelector(".screen-watch-video");
video.addEventListener("loadedmetadata", () => say("ready", { width: video.videoWidth, height: video.videoHeight }));
document.querySelector("button").addEventListener("click", () => say("tapped", { ok: watch.enter(), readyState: video.readyState }));
` },
    bundle: true, outdir: dir, entryNames: "entry", format: "esm", logLevel: "silent", target: "safari16",
  });
  const page = `<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Watch fixture</title>
<body style="margin:0;background:#101512"><canvas width="640" height="400" style="width:100%"></canvas>
<button aria-label="Enter fullscreen" style="margin:24px;padding:16px 24px;font-size:18px">Fullscreen</button>
<script type="module" src="/entry.js"></script></body>`;
  const state = { supported: null, ready: false, entered: false, left: false, taps: [], scenarios: [], problems: [], shots: [] };
  let done = false;
  const server = http.createServer(async (req, res) => {
    const body = await new Promise((resolve) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { resolve(JSON.parse(s || "{}")); } catch { resolve({}); } }); });
    const reply = (value) => res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(value));
    const route = new URL(req.url, "http://x").pathname;
    if (route === "/") return res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }).end(page);
    if (route === "/entry.js") return res.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(fs.readFileSync(path.join(dir, "entry.js")));
    if (route === "/event") {
      if (body.name === "supported") state.supported = body.value;
      if (body.name === "ready") state.ready = true;
      if (body.name === "entered") state.entered = true;
      if (body.name === "left") state.left = true;
      if (body.name === "tapped") state.taps.push(body);
      return reply({});
    }
    if (route === "/start") return reply({ url: `http://127.0.0.1:${server.address().port}/` });
    if (route === "/state") return reply(state);
    if (route === "/scenario") { state.scenarios.push({ ...body, tree: undefined }); if (body.tree) console.log(`TREE ${body.tree.slice(0, 3000)}`); return reply({}); }
    if (route === "/problem") { state.problems.push(body); return reply({}); }
    if (route === "/shot") {
      const file = path.join(dir, `${body.name}.png`);
      fs.writeFileSync(file, Buffer.from(body.png || "", "base64"));
      state.shots.push(body.name);
      return reply({});
    }
    if (route === "/done") { done = true; return reply({}); }
    reply({ error: "unknown" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => closeServer(server, { label: "watch fixture" }));
  const derived = path.join(os.homedir(), ".reach-dev", "ios-e2e", "dd");
  const env = { ...process.env, TEST_RUNNER_ORACLE_URL: `http://127.0.0.1:${server.address().port}` };
  const xcode = spawn("xcodebuild", ["test-without-building", "-project", project, "-scheme", "AppUi", "-destination", `platform=iOS Simulator,id=${simulator}`,
    "-derivedDataPath", derived, "-only-testing:AppUiUITests/AppUiUITests/testWatchFullscreen", "-parallel-testing-enabled", "NO"], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  xcode.stdout.on("data", (c) => (log += c));
  xcode.stderr.on("data", (c) => (log += c));
  t.after(() => xcode.kill());
  const code = await new Promise((resolve) => xcode.on("exit", resolve));
  const summary = { supported: state.supported, ready: state.ready, entered: state.entered, left: state.left, taps: state.taps, problems: state.problems, scenarios: state.scenarios.map(({ name, entered, buttons }) => ({ name, entered, buttons })) };
  t.diagnostic(JSON.stringify(summary));
  assert.ok(done, `the XCUITest ran to its end (xcodebuild ${code}):\n${log.split("\n").filter((l) => /error|fail|assert|Test Case/i.test(l)).slice(-30).join("\n")}`);
  assert.equal(state.supported, true, "iOS Safari offers a video's own fullscreen and a canvas's stream");
  assert.equal(state.ready, true, "the picture played into the video before the tap");
  assert.equal(state.taps.at(-1)?.ok, true, `the tap went into fullscreen: ${JSON.stringify(state.taps)}`);
  assert.equal(state.entered, true, "iOS began its own fullscreen");
  assert.equal(state.left, true, "its close came back to the page");
  assert.deepEqual(state.problems, []);
});
