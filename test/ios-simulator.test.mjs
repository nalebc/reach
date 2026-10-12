import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startCleanReach } from "./helpers/clean-machine.mjs";

// Opt-in real WKWebView/native-plugin smoke. Uses a new disposable simulator,
// a copied app, synthetic files, and a localhost-only Reach fixture. It never
// touches an existing simulator, Tailscale account, camera, or share recipient.
// Build the app first; REACH_TEST_IOS_APP points to App.app. A temporary TLS
// certificate is trusted only inside the disposable simulator. Native TLS
// checks remain enabled; only the copied shell's local HTTP web view is allowed.
const exec = promisify(execFile);
const enabled = process.platform === "darwin" && !!process.env.REACH_TEST_IOS_APP;

test("iOS simulator pairs through the real UI, reads files and runs native transfer/share bridges", {
  skip: !enabled && "set REACH_TEST_IOS_APP to a simulator App.app", timeout: 240000,
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-ios-smoke-"));
  const output = process.env.REACH_TEST_IOS_REPORT;
  if (output) await fs.rm(output, { force: true });
  const sim = (...args) => exec("xcrun", ["simctl", ...args], { timeout: 90000, maxBuffer: 2 << 20 });
  let device;
  t.after(async () => {
    if (device) {
      await sim("shutdown", device).catch(() => {});
      await sim("delete", device).catch(() => {});
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const reach = await startCleanReach(t, { pair: false, env: { REACH_NAME: "Simulator test computer" } });
  const upstream = reach.output().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  const code = reach.output().match(/Pairing code: (\d{4}) (\d{4})/)?.slice(1).join("");
  assert.ok(upstream && code, "isolated CLI fixture provides its URL and pairing code");
  await fs.writeFile(path.join(reach.home, "simulator-proof.txt"), "Reach simulator bytes\n");
  const nonce = crypto.randomBytes(16).toString("hex"), probe = `/__simulator_${nonce}`;
  const certificate = path.join(dir, "localhost.pem"), key = path.join(dir, "localhost.key");
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
    "-out", certificate, "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE"], { timeout: 10000 });
  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  let noteDownload, allowDownload, noteResponse;
  const downloadRequested = new Promise(resolve => { noteDownload = resolve; });
  const downloadAllowed = new Promise(resolve => { allowDownload = resolve; });
  const downloadResponded = new Promise(resolve => { noteResponse = resolve; });
  t.after(() => allowDownload());
  let script = "";
  const requests = [];
  const handler = async (req, res) => {
    res.on("finish", () => {
      if (req.url.startsWith("/api/")) requests.push({ path: req.url.split("?")[0], status: res.statusCode });
    });
    if (req.url.split("?")[0] === "/api/files/content") {
      noteDownload();
      await downloadAllowed;
      res.on("finish", noteResponse);
    }
    if (req.url === `${probe}/result` && req.method === "POST") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 16384) { res.writeHead(413).end(); return rejectResult(Error("Oversized simulator report")); }
      }
      try { resolveResult(JSON.parse(body)); res.writeHead(204).end(); }
      catch (error) { rejectResult(error); res.writeHead(400).end(); }
      return;
    }
    if (req.url === `${probe}.js`) {
      res.writeHead(200, { "Content-Type": "text/javascript", "Cache-Control": "no-store" }).end(script);
      return;
    }
    if (req.url === "/") {
      const html = await fs.readFile(path.resolve("dist/index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" })
        .end(html.replace("</body>", `<script src="${probe}.js" defer></script></body>`));
      return;
    }
    // This smoke covers pairing and file/native bridges. Other workspace
    // features have their own fixtures; never enumerate the host's live apps,
    // terminals, activity, or capture its screen just to render this test page.
    if (req.url.startsWith("/api/") && !["/api/auth/method", "/api/pair", "/api/device", "/api/files", "/api/files/text", "/api/files/content"].includes(req.url.split("?")[0])) {
      res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "Outside the isolated mobile smoke test." }));
      return;
    }
    // The proxy keeps the synthetic browser and companion on one origin.
    const headers = { ...req.headers, host: new URL(upstream).host };
    if (headers.origin) headers.origin = upstream;
    const forwarded = http.request(upstream + req.url, { method: req.method, headers }, response => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    forwarded.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(forwarded);
  };
  const proxy = http.createServer(handler);
  const downloadProxy = https.createServer({ key: await fs.readFile(key), cert: await fs.readFile(certificate) }, handler);
  proxy.on("clientError", (_error, socket) => socket.destroy());
  downloadProxy.on("clientError", (_error, socket) => socket.destroy());
  await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
  await new Promise(resolve => downloadProxy.listen(0, "127.0.0.1", resolve));
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  t.after(async () => { downloadProxy.closeAllConnections(); await new Promise(resolve => downloadProxy.close(resolve)); });
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  const downloadOrigin = `https://127.0.0.1:${downloadProxy.address().port}`;
  script = `(${async function run({ code, probe, downloadOrigin }) {
    const checks = [];
    const wait = async (get, name, ms = 25000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const value = await get();
        if (value) return value;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw Error(`Timed out: ${name}`);
    };
    const check = (ok, name) => { if (!ok) throw Error(name); checks.push(name); };
    const fill = (input, value) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    try {
      await wait(() => window.Capacitor?.nativePromise, "native bridge");
      const address = await wait(() => document.querySelector('input[type="url"]'), "computer address");
      // The bridge arrives before React finishes attaching its event handlers.
      await new Promise(resolve => setTimeout(resolve, 800));
      fill(address, location.origin);
      const pairing = await wait(() => document.querySelector("input.pair-code"), "pairing form");
      fill(pairing, code);
      await new Promise(resolve => setTimeout(resolve, 100));
      pairing.closest("form").requestSubmit();
      const peer = await wait(() => {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key.endsWith("devices")) continue;
          try { const peers = JSON.parse(localStorage.getItem(key)); if (peers?.[0]?.token) return peers[0]; } catch {}
        }
      }, "paired workspace");
      check(!!peer.token, "real pairing UI saved its credential");
      const headers = { Authorization: "Bearer " + peer.token };
      const file = await fetch("/api/files/text?root=0&path=simulator-proof.txt", { headers });
      check(file.ok && (await file.json()).text === "Reach simulator bytes\n", "authenticated file bytes in WKWebView");
      check((await fetch("/api/files/text?root=0&path=../outside.txt", { headers })).status === 403, "folder traversal refused");
      const native = (plugin, method, args = {}) => window.Capacitor.nativePromise(plugin, method, args);
      const written = await native("Filesystem", "writeFile", { path: "smoke/proof.txt", data: btoa("Native file bytes"), directory: "CACHE", recursive: true });
      const read = await native("Filesystem", "readFile", { path: written.uri });
      check(atob(read.data) === "Native file bytes", "native filesystem write/read preserves bytes");
      const pending = await native("BackgroundTransfer", "finished");
      check(Array.isArray(pending.files) && pending.files.length === 0, "fresh native transfer session has no old files");
      // The actual React workspace subscribes to transfers too. Completed
      // downloads are delivered to listeners instead of the pending queue.
      const completed = new Map(), failures = new Map();
      window.Capacitor.nativeCallback("BackgroundTransfer", "addListener", { eventName: "done" }, value => completed.set(value.id, value));
      window.Capacitor.nativeCallback("BackgroundTransfer", "addListener", { eventName: "failed" }, value => failures.set(value.id, value));
      const download = await native("BackgroundTransfer", "download", { url: downloadOrigin + "/api/files/content?root=0&path=simulator-proof.txt", name: "simulator-proof.txt", headers });
      const finished = await wait(async () => {
        if (failures.has(download.id)) throw Error("Native download failed: " + JSON.stringify(failures.get(download.id)));
        return completed.get(download.id) || (await native("BackgroundTransfer", "finished")).files.find(file => file.id === download.id);
      }, "native URLSession download", 45000);
      const downloaded = await native("Filesystem", "readFile", { path: finished.uri });
      check(atob(downloaded.data) === "Reach simulator bytes\n", "native authenticated download preserves bytes");
      await wait(async () => (await native("App", "getState")).isActive, "app foreground resume");
      check(true, "native app resumes after downloading while backgrounded");
      check((await native("Share", "canShare")).value === true, "native share capability available");
      await fetch(probe + "/result", { method: "POST", body: JSON.stringify({ ok: true, checks, platform: window.Capacitor.getPlatform(), userAgent: navigator.userAgent }) });
      // Open the native sheet for inspection, without selecting a recipient.
      native("Share", "share", { files: [written.uri] }).catch(() => {});
    } catch (error) {
      await fetch(probe + "/result", { method: "POST", body: JSON.stringify({ ok: false, checks, error: error.message }) });
    }
  }.toString()})(${JSON.stringify({ code, probe, downloadOrigin })});`;

  const runtimes = JSON.parse((await sim("list", "runtimes", "-j")).stdout).runtimes;
  const runtime = runtimes.filter(item => item.isAvailable && item.identifier.includes("iOS")
    && (!process.env.REACH_TEST_IOS_RUNTIME || item.version === process.env.REACH_TEST_IOS_RUNTIME)).at(-1);
  assert.ok(runtime, "an iOS simulator runtime is installed");
  const types = JSON.parse((await sim("list", "devicetypes", "-j")).stdout).devicetypes;
  const supported = new Set(runtime.supportedDeviceTypes?.map(item => item.identifier));
  const phones = types.filter(item => item.name.startsWith("iPhone") && (!supported.size || supported.has(item.identifier)));
  const type = phones.find(item => item.name === "iPhone 17") || phones[0];
  assert.ok(type, "the selected runtime supports an installed iPhone device type");
  device = (await sim("create", `Reach isolated smoke ${nonce.slice(0, 6)}`, type.identifier, runtime.identifier)).stdout.trim();
  await sim("boot", device);
  await sim("bootstatus", device, "-b");
  await sim("keychain", device, "add-root-cert", certificate);
  const app = path.join(dir, "App.app");
  await fs.cp(process.env.REACH_TEST_IOS_APP, app, { recursive: true });
  const configFile = path.join(app, "capacitor.config.json");
  const config = JSON.parse(await fs.readFile(configFile, "utf8"));
  config.server = { url: origin, cleartext: true };
  await fs.writeFile(configFile, JSON.stringify(config));
  const plist = path.join(app, "Info.plist");
  await exec("/usr/libexec/PlistBuddy", ["-c", "Add :NSAppTransportSecurity dict", plist]);
  await exec("/usr/libexec/PlistBuddy", ["-c", "Add :NSAppTransportSecurity:NSAllowsArbitraryLoadsInWebContent bool true", plist]);
  const bundle = (await exec("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleIdentifier", plist])).stdout.trim();
  await exec("codesign", ["--force", "--deep", "--sign", "-", "--preserve-metadata=entitlements,flags,runtime", "--generate-entitlement-der", app], { timeout: 30000 });
  await sim("install", device, app);
  await sim("launch", device, bundle);
  const timer = setTimeout(() => rejectResult(Error("iOS test page did not report within 100 seconds")), 100000);
  let report;
  let backgroundedDuringDownload = false;
  try {
    const first = await Promise.race([result.then(report => ({ report })), downloadRequested.then(() => ({ download: true }))]);
    if (first.download) {
      // The newly created simulator has no user account. Opening its Settings
      // backgrounds only this test app; release the HTTPS response while away.
      await sim("launch", device, "com.apple.Preferences");
      backgroundedDuringDownload = true;
      allowDownload();
      await Promise.race([downloadResponded, result]);
      await new Promise(resolve => setTimeout(resolve, 1500));
      await sim("launch", device, bundle);
    }
    report = first.report || await result;
  } finally { clearTimeout(timer); allowDownload(); }
  if (output) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify({ ...report, requests, runtime: runtime.version, backgroundedDuringDownload, physicalDevice: false }, null, 2) + "\n");
    await new Promise(resolve => setTimeout(resolve, 1500));
    await sim("io", device, "screenshot", output.replace(/\.json$/, "") + ".png");
    if (!report.ok && /Native download/.test(report.error)) {
      const logs = await sim("spawn", device, "log", "show", "--last", "1m", "--style", "compact", "--predicate", 'process == "nsurlsessiond" AND (messageType == error OR messageType == fault)').catch(error => ({ stdout: error.message }));
      await fs.writeFile(output.replace(/\.json$/, "") + ".native.log", logs.stdout);
    }
  }
  assert.equal(report.ok, true, report.error);
  assert.equal(report.platform, "ios");
  assert.equal(backgroundedDuringDownload, true);
  assert.equal(report.checks.length, 8);
  t.diagnostic(JSON.stringify(report));
});
