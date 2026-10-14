import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
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

// Runs one command under a hard limit. execFile's own timeout settles only
// once the killed process closes its pipes: a killed simctl took 17-64 s more
// on hosted runners (Oct 12), enough to sink a retry. This rejects at the
// limit and makes sure the process goes (SIGTERM, then SIGKILL after 5 s).
function run(command, args, limit) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { if (stdout.length < 2 << 20) stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { if (stderr.length < 1 << 16) stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
      child.stdout.destroy();
      child.stderr.destroy();
      reject(Error(`did not finish within ${limit / 1000} s`));
    }, limit);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(Error(`exited with ${signal || code}${stderr.trim() ? `: ${stderr.trim().slice(-400)}` : ""}`));
    });
  });
}

// The CI lane's budget (ci.yml passes --test-timeout=600000; this per-test
// value overrides it, so it must say the same). A passing hosted macos-15 run
// took 179 s: Reach, a new simulator's cold first boot (51 s), trusting the
// test CA, install, launch, then up to 100 s of the page. Slow runs on Oct 12
// spent 77 to over 90 s in the first boot, then hung past 90 s in
// add-root-cert (run 38286105112) or launch (run 38279745481) right after.
// Each simctl step now has its own limit; the ones that are harmless to
// repeat get a few attempts; and no attempt runs past `budget`, which keeps
// 30 s of the test's time for the evidence and cleanup.
const testTimeout = 600000, budget = testTimeout - 30000;
test("iOS simulator pairs through the real UI, reads files and runs native transfer/share bridges", {
  skip: !enabled && "set REACH_TEST_IOS_APP to a simulator App.app", timeout: testTimeout,
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-ios-smoke-"));
  const output = process.env.REACH_TEST_IOS_REPORT;
  if (output) await fs.rm(output, { force: true });
  // Where the time went, in the log as it happens and in the report: phases
  // are the milestones, steps every simctl attempt with its own time and
  // outcome. A timeout ends the test before its report: cleanup then leaves
  // what it has.
  const started = Date.now(), phases = [], steps = [], requests = [];
  let device, runtimeVersion, ready, reported = false;
  const since = from => Math.round((Date.now() - from) / 100) / 10;
  const left = () => started + budget - Date.now();
  const reached = name => {
    const seconds = since(started);
    phases.push({ phase: name, seconds });
    process.stderr.write(`iOS simulator test: ${name} (${seconds} s)\n`);
  };
  // One simctl step. Only steps shown harmless to repeat get more than one
  // attempt: a second add-root-cert of the same CA succeeds and adds nothing,
  // launching a running app returns its pid, install replaces the same app.
  // Each retry waits 5 s longer than the last. The last failure names every
  // attempt; a step that never succeeds fails the test.
  const sim = async (name, args, { limit = 60000, attempts = 1 } = {}) => {
    const tries = [];
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await new Promise(resolve => setTimeout(resolve, Math.min(5000 * (attempt - 1), Math.max(0, left() - 10000))));
      if (left() < 5000) { tries.push(`attempt ${attempt}: the lane's time budget ran out`); break; }
      const allowed = Math.min(limit, left());
      const began = Date.now();
      try {
        const result = await run("xcrun", ["simctl", ...(typeof args === "function" ? args(attempt) : args)], allowed);
        steps.push({ step: name, attempt, seconds: since(began), ok: true });
        process.stderr.write(`iOS simulator test:   ${name}: ${since(began)} s${attempt > 1 ? ` (attempt ${attempt})` : ""}\n`);
        return result;
      } catch (error) {
        steps.push({ step: name, attempt, seconds: since(began), ok: false, error: error.message });
        tries.push(`attempt ${attempt} ${error.message} after ${since(began)} s`);
        process.stderr.write(`iOS simulator test:   ${name}: attempt ${attempt} of ${attempts} ${error.message} (${since(began)} s)\n`);
      }
    }
    throw Error(`simctl ${name} failed: ${tries.join("; ")}`);
  };
  t.after(async () => {
    if (output && !reported) {
      const last = phases.at(-1)?.phase || "nothing";
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.writeFile(output, JSON.stringify({ ok: false, error: `Did not finish. Last step reached: ${last}.`,
        phases, steps, ready, requests, runtime: runtimeVersion, physicalDevice: false }, null, 2) + "\n").catch(() => {});
      if (device) await run("xcrun", ["simctl", "io", device, "screenshot", output.replace(/\.json$/, "") + ".png"], 15000).catch(() => {});
    }
    if (device) {
      await run("xcrun", ["simctl", "shutdown", device], 60000).catch(() => {});
      await run("xcrun", ["simctl", "delete", device], 60000).catch(() => {});
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const reach = await startCleanReach(t, { pair: false, env: { REACH_NAME: "Simulator test computer" } });
  reached("Reach started");
  const upstream = reach.output().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  const code = reach.output().match(/Pairing code: (\d{4}) (\d{4})/)?.slice(1).join("");
  assert.ok(upstream && code, "isolated CLI fixture provides its URL and pairing code");
  await fs.writeFile(path.join(reach.home, "simulator-proof.txt"), "Reach simulator bytes\n");
  const nonce = crypto.randomBytes(16).toString("hex"), probe = `/__simulator_${nonce}`;
  const certificate = path.join(dir, "localhost.pem"), key = path.join(dir, "localhost.key");
  const authority = path.join(dir, "root.pem"), authorityKey = path.join(dir, "root.key");
  const request = path.join(dir, "localhost.csr"), extensions = path.join(dir, "localhost.ext");
  // OpenSSL 1.1.1 adds -addext entries to the runner's configured CA
  // extensions instead of replacing them. Duplicate SKI/basicConstraints
  // make that root unusable as an issuer. Own the whole disposable config.
  const opensslConfig = path.join(dir, "openssl.cnf");
  await fs.writeFile(opensslConfig, "[req]\ndistinguished_name=dn\n[dn]\n");
  // URLSession requires a server-authentication leaf, not a CA reused as the
  // endpoint certificate. Trust only this disposable CA inside our simulator;
  // production certificate validation remains enabled throughout the test.
  await exec("openssl", ["req", "-config", opensslConfig, "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-keyout", authorityKey,
    "-out", authority, "-days", "1", "-subj", `/CN=Reach simulator ${nonce}`,
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
    "-addext", "subjectKeyIdentifier=hash"], { timeout: 10000 });
  await exec("openssl", ["req", "-config", opensslConfig, "-new", "-newkey", "rsa:2048", "-sha256", "-nodes", "-keyout", key,
    "-out", request, "-subj", "/CN=localhost"], { timeout: 10000 });
  await fs.writeFile(extensions, [
    "basicConstraints=critical,CA:FALSE",
    "keyUsage=critical,digitalSignature,keyEncipherment",
    "extendedKeyUsage=serverAuth",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "authorityKeyIdentifier=keyid:always",
    "subjectKeyIdentifier=hash",
  ].join("\n"));
  await exec("openssl", ["x509", "-req", "-in", request, "-CA", authority, "-CAkey", authorityKey,
    "-CAcreateserial", "-out", certificate, "-days", "1", "-sha256", "-extfile", extensions], { timeout: 10000 });
  await exec("openssl", ["verify", "-purpose", "sslserver", "-CAfile", authority, certificate], { timeout: 10000 });
  assert.equal(new crypto.X509Certificate(await fs.readFile(certificate)).checkIP("127.0.0.1"), "127.0.0.1");
  reached("test certificate made");
  let resolveResult, rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  let noteDownload, allowDownload, noteResponse;
  const downloadRequested = new Promise(resolve => { noteDownload = resolve; });
  const downloadAllowed = new Promise(resolve => { allowDownload = resolve; });
  const downloadResponded = new Promise(resolve => { noteResponse = resolve; });
  t.after(() => allowDownload());
  let script = "";
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
      }, "native URLSession download", 120000);
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

  const runtimes = JSON.parse((await sim("list runtimes", ["list", "runtimes", "-j"])).stdout).runtimes;
  const runtime = runtimes.filter(item => item.isAvailable && item.identifier.includes("iOS")
    && (!process.env.REACH_TEST_IOS_RUNTIME || item.version === process.env.REACH_TEST_IOS_RUNTIME)).at(-1);
  assert.ok(runtime, "an iOS simulator runtime is installed");
  runtimeVersion = runtime.version;
  // A fresh runner can still be building/scanning the runtime's shared cache
  // after bootstatus says ready. Wait for this specific runtime's cache; never
  // force a rebuild or touch another simulator's data.
  await sim("runtime shared cache ready", ["runtime", "dyld_shared_cache", "update", runtime.identifier], { limit: 180000 });
  reached("runtime shared cache ready");
  const types = JSON.parse((await sim("list devicetypes", ["list", "devicetypes", "-j"])).stdout).devicetypes;
  const supported = new Set(runtime.supportedDeviceTypes?.map(item => item.identifier));
  const phones = types.filter(item => item.name.startsWith("iPhone") && (!supported.size || supported.has(item.identifier)));
  const type = phones.find(item => item.name === "iPhone 17") || phones[0];
  assert.ok(type, "the selected runtime supports an installed iPhone device type");
  device = (await sim("create", ["create", `Reach isolated smoke ${nonce.slice(0, 6)}`, type.identifier, runtime.identifier])).stdout.trim();
  reached(`simulator created (iOS ${runtime.version}, ${type.name})`);
  await sim("boot", ["boot", device], { limit: 90000 });
  reached("simulator booting");
  // A cold first boot is slow but progressing: 51 to over 90 s on hosted runners.
  await sim("bootstatus", ["bootstatus", device, "-b"], { limit: 240000 });
  reached("simulator booted");
  // bootstatus can finish while the first boot still loads the device, and
  // the next simctl request then hung. Wait until the device runs a process
  // on request: a harmless launchctl list inside it, retried. The PIDs of the
  // services the next steps use are evidence only; securityd and trustd
  // start on demand, so a missing one is not a failure.
  const services = (await sim("readiness (launchctl list in the device)", ["spawn", device, "launchctl", "list"], { limit: 30000, attempts: 4 })).stdout;
  ready = Object.fromEntries(["com.apple.SpringBoard", "com.apple.mobile.installd", "com.apple.securityd", "com.apple.trustd"]
    .map(label => [label, Number(services.match(new RegExp(`^(\\d+)\\s+\\S+\\s+${label.replaceAll(".", "\\.")}$`, "m"))?.[1]) || null]));
  reached(`simulator answers (${Object.entries(ready).map(([label, pid]) => `${label.split(".").at(-1)} ${pid ?? "not running"}`).join(", ")})`);
  // Without this CA the native download fails its TLS check, so the step
  // must succeed: it retries, it is never skipped.
  await sim("keychain add-root-cert", ["keychain", device, "add-root-cert", authority], { limit: 60000, attempts: 3 });
  reached("test certificate trusted in the simulator");
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
  reached("app copied and signed");
  // A slow install took 45 s; a slow launch hung past 90 s on the home
  // screen, the app never started (run 38279745481's screenshot, no requests).
  await sim("install", ["install", device, app], { limit: 150000, attempts: 2 });
  reached("app installed");
  // A fresh device has no running copy to terminate. Stop a half-started copy
  // only on a retry, while retaining the bounded attempts and all app checks.
  await sim("launch", attempt => ["launch", ...(attempt > 1 ? ["--terminate-running-process"] : []), device, bundle], { limit: 75000, attempts: 3 });
  reached("app launched");
  const pageLimit = Math.max(0, Math.min(100000, left()));
  const timer = setTimeout(() => rejectResult(Error(`iOS test page did not report within ${pageLimit / 1000} s`)), pageLimit);
  let report;
  let backgroundedDuringDownload = false;
  try {
    const first = await Promise.race([result.then(report => ({ report })), downloadRequested.then(() => ({ download: true }))]);
    if (first.download) {
      reached("page paired and asked for the native download");
      // The newly created simulator has no user account. Opening its Settings
      // backgrounds only this test app; release the HTTPS response while away.
      await sim("launch Settings", ["launch", device, "com.apple.Preferences"], { attempts: 2 });
      reached("app in the background");
      backgroundedDuringDownload = true;
      allowDownload();
      await Promise.race([downloadResponded, result]);
      reached("download answered");
      await new Promise(resolve => setTimeout(resolve, 1500));
      await sim("reopen the app", ["launch", device, bundle], { attempts: 2 });
      reached("app reopened");
    }
    report = first.report || await result;
    reached("page reported");
  } finally { clearTimeout(timer); allowDownload(); }
  if (output) {
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, JSON.stringify({ ...report, requests, phases, steps, ready, runtime: runtime.version, backgroundedDuringDownload, physicalDevice: false }, null, 2) + "\n");
    reported = true;
    await new Promise(resolve => setTimeout(resolve, 1500));
    await sim("screenshot", ["io", device, "screenshot", output.replace(/\.json$/, "") + ".png"], { limit: 30000, attempts: 2 });
    if (!report.ok && /Native download/.test(report.error)) {
      const logs = await sim("native download log", ["spawn", device, "log", "show", "--last", "1m", "--style", "compact", "--predicate", 'process == "nsurlsessiond" AND (messageType == error OR messageType == fault)']).catch(error => ({ stdout: error.message }));
      await fs.writeFile(output.replace(/\.json$/, "") + ".native.log", logs.stdout);
    }
  }
  assert.equal(report.ok, true, report.error);
  assert.equal(report.platform, "ios");
  assert.equal(backgroundedDuringDownload, true);
  assert.equal(report.checks.length, 8);
  t.diagnostic(JSON.stringify(report));
});
