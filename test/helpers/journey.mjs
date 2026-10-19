import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { firstInstall, setupMenu } from "./first-install.mjs";
import { HOST } from "./fake-tailscale.mjs";
import { findChrome, launchChrome, openTab, testCertificate } from "./headless-chrome.mjs";
import { computerWord } from "../../server/computer-word.mjs";
import { safeNativeCall, safeFailureExtra } from "./journey-native-diagnostics.mjs";

// The user journeys (test/journeys): the actual phone interface, in a real
// browser, against a real Reach on this computer, page by page, exactly as
// someone with a phone uses it. Each journey runs on a Mac and on a Windows
// PC and must end in the same visible result on both; a step whose outcome
// the phone doesn't show fails.
//
// Real: Reach's own first install (test/helpers/first-install.mjs, `real`),
// its server and built interface, this computer's files, shell, terminals,
// screen, apps and agents. Stand-ins: Tailscale (no tailnet here; its
// command line and Serve, test/helpers/fake-tailscale.mjs) and the phone
// (headless Chrome as an iPhone: its screen size, touch and Safari's name;
// Safari itself and a physical phone are not this).
export const windows = process.platform === "win32";
export const word = computerWord();
// What needs a desktop session (the screen, input, the computer's own
// windows) runs on a real Windows PC only when asked (CI's real-Windows step
// and windows-validation.yml); on a Mac, always.
export const desktop = !windows || process.env.REACH_TEST_WINDOWS_DESKTOP === "1";
export const needsDesktop = desktop ? false : "needs the PC's desktop (REACH_TEST_WINDOWS_DESKTOP=1)";
// On a Mac the desktop is its owner's: a step that brings a window up (and
// so takes the focus) runs only while nobody has used it for two minutes.
// A click a journey made itself (markInput) isn't someone using it.
const inputMark = path.join(os.tmpdir(), "reach-journeys-input.json");
export function macInUse() {
  if (process.platform !== "darwin") return false;
  try {
    const out = execFileSync("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], { encoding: "utf8", timeout: 5000 });
    const idle = Number(/"HIDIdleTime" = (\d+)/.exec(out)?.[1]) / 1e9;
    if (!Number.isFinite(idle)) return "this Mac's idle time couldn't be read";
    if (idle >= 120) return false;
    let mine = 0;
    try {
      mine = JSON.parse(fs.readFileSync(inputMark, "utf8")).at;
    } catch {}
    // The last input was a journey's own click, nothing since.
    if (mine && Math.abs((Date.now() - mine) / 1000 - idle) < 5) return false;
    return `someone is using this Mac (input ${Math.round(idle)} s ago)`;
  } catch {
    return "this Mac's idle time couldn't be read";
  }
}
export const markInput = () => fs.writeFileSync(inputMark, JSON.stringify({ at: Date.now() }));

// One journey at a time on the desktop (a window of its own, clicks through
// Reach): another test file waits its turn, so no two put windows in the
// same place. Taken for the test, given back when it ends. On a Mac someone
// came back to meanwhile, the test is skipped, saying so: false.
const turnLock = path.join(os.tmpdir(), "reach-journeys-desktop.lock");
export async function desktopTurn(t) {
  for (const end = Date.now() + 600000; ; await sleep(500)) {
    try {
      fs.mkdirSync(turnLock);
      fs.writeFileSync(path.join(turnLock, "pid"), String(process.pid));
      break;
    } catch {
      // Its holder gone (a test ended outright): the turn is free.
      try {
        process.kill(Number(fs.readFileSync(path.join(turnLock, "pid"), "utf8")), 0);
      } catch (error) {
        if (error.code === "ESRCH") fs.rmSync(turnLock, { recursive: true, force: true });
      }
      if (Date.now() > end) throw Error("Another journey kept the desktop for ten minutes.");
    }
  }
  t.after(() => fs.rmSync(turnLock, { recursive: true, force: true }));
  const busy = macInUse();
  if (busy) t.skip(busy);
  return !busy;
}
const chrome = findChrome();
const serialWindows = process.platform === "win32" && process.env.CI === "true";
if (serialWindows && process.env.REACH_TEST_WINDOWS_DESKTOP === "1" && !chrome)
  throw Error("The serial Windows phone journeys require Chrome or Chromium.");
export const skip = serialWindows && process.env.REACH_TEST_WINDOWS_DESKTOP !== "1"
  ? "the serial Windows native lane runs every phone journey"
  : !chrome
  ? "no Chrome or Chromium on this computer (set REACH_TEST_CHROME to one)"
  : !["darwin", "win32"].includes(process.platform)
    ? "the journeys run on a Mac or a Windows PC"
    : false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = promisify(execFile);
export const marker = (kind) => `reach-${kind}-${crypto.randomBytes(4).toString("hex")}`;
// The lines a terminal shows, each trimmed.
export const lines = (text) => String(text).split("\n").map((line) => line.trim());

// A window on the computer's main display that turns from orange to green
// when a click reaches it, above every other window: on a Mac
// test/fixtures/mac/click-target.swift, built as Reach builds its helpers;
// on a PC a WinForms window, in physical pixels. Returns its middle as a
// share of the display ({ x, y }, 0 to 1), a spot inside it away from the
// middle (`aside`), and how many clicks reached it
// (read on the computer, apart from Reach). Gone when the test ends.
const WINDOWS_TARGET = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class ReachJourneyDpi { [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr v); }
'@
[ReachJourneyDpi]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$out = $env:REACH_TARGET_OUT
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'; $f.TopMost = $true; $f.StartPosition = 'Manual'; $f.ShowInTaskbar = $false
$f.Left = 160; $f.Top = 200; $f.Width = 420; $f.Height = 260
$f.BackColor = [System.Drawing.Color]::FromArgb(255, 140, 0)
$script:clicks = 0
$f.Add_MouseDown({ $script:clicks++; $f.BackColor = [System.Drawing.Color]::FromArgb(0, 190, 50); [IO.File]::WriteAllText("$out.clicks", [string]$script:clicks) })
$f.Add_Shown({ $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; [IO.File]::WriteAllText("$out.ready", "$($f.Left + $f.Width / 2 - $b.Left),$($f.Top + $f.Height / 2 - $b.Top),$($b.Width),$($b.Height),$($f.Width),$($f.Height)") })
$timer = New-Object System.Windows.Forms.Timer; $timer.Interval = 120000; $timer.Add_Tick({ $f.Close() }); $timer.Start()
[System.Windows.Forms.Application]::Run($f)
`;
export async function clickTarget(t, dir) {
  const out = path.join(dir, "target");
  let child;
  if (windows) {
    child = (await import("node:child_process")).spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-EncodedCommand", Buffer.from(WINDOWS_TARGET, "utf16le").toString("base64")],
      { env: { ...process.env, REACH_TARGET_OUT: out }, stdio: "ignore" },
    );
  } else {
    const binary = path.join(dir, "click-target");
    await run("/usr/bin/xcrun", ["swiftc", "-O", path.resolve("test/fixtures/mac/click-target.swift"), "-o", binary], { timeout: 180000 });
    child = (await import("node:child_process")).spawn(binary, [out], { stdio: "ignore" });
  }
  t.after(() => child.kill());
  for (const end = Date.now() + 60000; !fs.existsSync(`${out}.ready`); await sleep(100))
    if (Date.now() > end || child.exitCode !== null) throw Error("The click target didn't open.");
  const [x, y, width, height, w, h] = fs.readFileSync(`${out}.ready`, "utf8").split(",").map(Number);
  const readyAt = Date.now();
  const clicks = () => (fs.existsSync(`${out}.clicks`) ? Number(fs.readFileSync(`${out}.clicks`, "utf8")) : 0);
  return {
    at: { x: x / width, y: y / height },
    // Inside it, away from its middle (where the pointer ends up).
    aside: { x: (x + w / 4) / width, y: (y + h / 4) / height },
    clicks,
    snapshot: () => {
      let count = null;
      try { const value = clicks(); if (Number.isFinite(value)) count = value; } catch {}
      return { ageMs: Date.now() - readyAt, alive: child.exitCode === null && child.signalCode === null,
        exitCode: child.exitCode, signalCode: child.signalCode, clicks: count, lifetimeMs: 120000 };
    },
  };
}

// A terminal window opened on the computer itself, as its owner opens one,
// titled `title`: on a Mac a new Terminal window (Terminal's own scripting,
// a login shell and nothing else running in it); on a Windows PC a console
// window as the Run box opens one (conhost started by the shell: started by
// Node it would get pipes for handles and show no window). Only this window
// is ever touched, found by its own tty or process; it's gone when the test
// ends, whatever happens. `open()` says whether it's still on the computer.
export async function computerTerminal(t, title) {
  if (windows) {
    const system = path.join(process.env.SystemRoot || "C:\\Windows", "System32");
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `(Start-Process -FilePath '${path.join(system, "conhost.exe")}' -ArgumentList '${path.join(system, "cmd.exe")} /d /k title ${title}' -PassThru).Id`],
      { windowsHide: true, timeout: 60000 },
    );
    const pid = Number(stdout.trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0, `the console window started: ${stdout}`);
    t.after(() => run("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {}));
    return {
      open: async () => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
    };
  }
  const tell = async (body) => (await run("/usr/bin/osascript", ["-e", `tell application "Terminal"\n${body}\nend tell`], { timeout: 30000 })).stdout.trim();
  const tty = await tell(`set t to do script ""\nset custom title of t to "${title}"\nreturn tty of t`);
  assert.match(tty, /^\/dev\/ttys\d+$/, "a new Terminal window");
  const each = (then) => `repeat with w in windows\nrepeat with t in tabs of w\nif tty of t is "${tty}" then\n${then}\nend if\nend repeat\nend repeat`;
  // Its window has only this tab: Terminal closes windows, not tabs.
  t.after(() => tell(each("close w\nreturn")).catch(() => {}));
  return { open: async () => (await tell(`${each('return "open"')}\nreturn "gone"`)) === "open" };
}

// Where a run's screenshots go: reports/journeys/<platform>-<journey>-<step>.png
// (the Windows workflows keep reports/).
const reports = path.resolve("reports", "journeys");

// The phones a journey can be: iPhone by default.
export const PHONES = {
  iPhone: {
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
    platform: "iPhone",
    width: 390,
    height: 844,
    scale: 3,
  },
  Android: {
    userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l",
    width: 412,
    height: 915,
    scale: 2.625,
  },
};

// Tailscale Serve as a phone on the tailnet reaches it: TLS on the
// computer's name, then the route Reach holds now (its socket on a Mac; its
// local port, or tailscaled's keyed proxy, on Windows), with the phone's
// address and its user's login as Serve gives them, and nothing the phone
// sent in their place. One server per port the phone asks for.
function serveStandIn(fake, { tls, ip }) {
  const target = async (port) => {
    const key = `${HOST}:${port}`;
    const routes = await fake.read();
    const proxy = [routes.serve, ...Object.values(routes.serve.Foreground || {})]
      .map((serve) => serve?.Web?.[key]?.Handlers?.["/"]?.Proxy)
      .find(Boolean);
    if (!proxy) return null;
    const identity = { "x-forwarded-for": ip, "tailscale-user-login": "owner@example.test", "tailscale-user-name": "Owner" };
    if (proxy.startsWith("unix:")) return { socketPath: proxy.slice(5), headers: identity };
    // A Windows Reach's keyed route: through the stand-in for tailscaled's
    // proxy, which puts the key in front and adds the identity itself.
    if (/^http:\/\/127\.0\.0\.1:\d+\/r-/.test(proxy)) {
      const session = (await fake.sessions()).find((s) => s.config?.Web?.[key] && s.proxy);
      return session && { host: "127.0.0.1", port: session.proxy, headers: { "x-fake-from": ip } };
    }
    const url = new URL(proxy);
    return { host: url.hostname, port: Number(url.port), headers: identity };
  };
  const clean = (headers) =>
    Object.fromEntries(
      Object.entries(headers).filter(([name]) => !/^(tailscale-|x-forwarded-|forwarded$|x-fake-from$)/i.test(name)),
    );
  const servers = new Map();
  // Every socket it holds, the phone's and Reach's, ended with it: a live
  // screen's socket to Reach never keeps a test waiting.
  const open = new Set();
  const held = (socket) => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
    return socket;
  };
  const server = (port) => {
    if (servers.has(port)) return servers.get(port);
    const answer = https.createServer({ key: tls.key, cert: tls.cert }, async (req, res) => {
      const to = await target(port).catch(() => null);
      if (!to) return res.writeHead(502).end("No route on this port.");
      const { headers, ...where } = to;
      const forward = http.request({ ...where, path: req.url, method: req.method, headers: { ...clean(req.headers), ...headers } }, (back) => {
        res.writeHead(back.statusCode, back.headers);
        back.pipe(res);
      });
      forward.on("error", () => res.destroy());
      req.pipe(forward);
    });
    answer.on("upgrade", async (req, client, head) => {
      client.on("error", () => {});
      const to = await target(port).catch(() => null);
      if (!to) return client.destroy();
      const upstream = held(to.socketPath ? net.connect(to.socketPath) : net.connect(to.port, to.host));
      upstream.on("error", () => client.destroy());
      client.on("error", () => upstream.destroy());
      upstream.once("connect", () => {
        const lines = Object.entries({ ...clean(req.headers), ...to.headers }).flatMap(([k, v]) => (Array.isArray(v) ? v.map((one) => `${k}: ${one}`) : [`${k}: ${v}`]));
        upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
        if (head?.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
    });
    answer.on("tlsClientError", () => {});
    servers.set(port, answer);
    return answer;
  };
  // Chrome's proxy: the computer's name on its ports reaches the stand-in,
  // and nothing else goes anywhere, so no test traffic leaves this computer.
  const proxy = http.createServer((req, res) => res.writeHead(403).end());
  proxy.on("connect", (req, socket, head) => {
    held(socket).on("error", () => {});
    const [host, port] = req.url.split(":");
    if (host !== HOST || !/^\d+$/.test(port || "")) return socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) socket.unshift(head);
    server(Number(port)).emit("connection", socket);
  });
  return {
    proxy,
    close: async () => {
      for (const socket of open) socket.destroy();
      proxy.closeAllConnections?.();
      await new Promise((resolve) => proxy.close(resolve));
      for (const answer of servers.values()) {
        answer.closeAllConnections?.();
        await new Promise((resolve) => answer.close(resolve));
      }
    },
  };
}

// openssl for the test certificate: on the PATH, or Git for Windows' own.
function opensslFor() {
  if (!windows) return "openssl";
  const dirs = (process.env.Path || process.env.PATH || "").split(";").filter(Boolean);
  const found = [
    ...dirs.map((dir) => path.join(dir, "openssl.exe")),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "usr", "bin", "openssl.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "OpenSSL", "bin", "openssl.exe"),
  ].find((file) => fs.existsSync(file));
  return found || "openssl";
}

// A first install of Reach on this computer, set up as its owner would on a
// first run, until it waits for a phone. Returns the install (first-install's
// handle), the address the phone is told to open, and how this computer
// lets a new phone in: a code the owner types into Reach (Mac), or the
// pairing code Reach shows (Windows, when it can't hold its keyed route on
// a PC without Tailscale's service, as GitHub's runner is).
export async function startComputer(t) {
  // Tailscale's current version: what a PC gets today.
  const reach = await firstInstall(t, { real: true, tailscale: { version: "1.104.0" } });
  await setupMenu(reach, /Which Tailscale account should Reach use\?/);
  const phoneStep = await reach.until(/▸ 3\. Your phone/, 120000);
  assert.ok(phoneStep);
  if (windows) {
    // These desktop journeys model a phone on this PC's private tailnet.
    // Their Tailscale stand-in has no Windows service, so browser sign-in
    // stays off. Wait for the input prompt before requesting the private
    // fallback; no automatic QR is allowed on this unavailable ingress path.
    await reach.until(/Press Enter for a new pairing code\. Type pause to pause\. Ctrl\+C stops sharing and Reach\./, 120000);
    assert.match(reach.output(), /The private QR needs the Tailscale app on this computer's network/);
    assert.doesNotMatch(reach.output(), /Pairing code:/);
    reach.answer("private");
  }
  const said = await reach.until(/Open on your phone: (https:\/\/\S+)/, 120000);
  const origin = said[1].replace(/\/$/, "");
  const [, a, b] = await reach.until(/Pairing code: ?(\d{4}) ?(\d{4})|Type a device request code to approve/, 60000);
  return { reach, origin, ...(a ? { pairing: a + b } : { approval: true }) };
}

// The phone, signed in to the computer as a new phone is: it opens the link,
// then is let in the way the computer says (the code it shows typed into
// Reach, or Reach's pairing code typed into it). Returns the page and what a
// journey does with it.
export async function phone(t, computer, { name = t.name, kind = "iPhone", ip = "100.64.0.21" } = {}) {
  const device = PHONES[kind];
  const dir = fs.mkdtempSync(path.join(computer.reach.temp, "phone-"));
  const tls = await testCertificate(dir, HOST).catch(async (error) => {
    if (!windows) throw error;
    // testCertificate runs `openssl`; Windows may have it only in Git's folder.
    const { execFile } = await import("node:child_process");
    const run = (await import("node:util")).promisify(execFile);
    const openssl = opensslFor();
    const crypto = await import("node:crypto");
    const key = path.join(dir, "tls.key"), cert = path.join(dir, "tls.pem"), conf = path.join(dir, "tls.cnf");
    fs.writeFileSync(conf, `[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=${HOST}\n[ext]\nsubjectAltName=DNS:${HOST}\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`);
    await run(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-keyout", key, "-out", cert, "-config", conf], { timeout: 20000, windowsHide: true });
    const pem = fs.readFileSync(cert);
    const spki = new crypto.X509Certificate(pem).publicKey.export({ type: "spki", format: "der" });
    return { key: fs.readFileSync(key), cert: pem, spki: crypto.createHash("sha256").update(spki).digest("base64") };
  });
  const serve = serveStandIn(computer.reach.fake, { tls, ip });
  let browser;
  // Register cleanup before Chrome starts: a failed launch must also release
  // the listening proxy, otherwise this test process lives until its timeout.
  t.after(async () => {
    try { await browser?.close(); } finally { await serve.close(); }
  });
  await new Promise((resolve) => serve.proxy.listen(0, "127.0.0.1", resolve));
  browser = await launchChrome(t, {
    spki: tls.spki,
    args: [`--proxy-server=http://127.0.0.1:${serve.proxy.address().port}`, "--lang=en-US"],
  });
  const tab = await openTab(browser);
  await tab.send("Emulation.setUserAgentOverride", { userAgent: device.userAgent, platform: device.platform, acceptLanguage: "en-US" });
  await tab.send("Emulation.setDeviceMetricsOverride", {
    width: device.width,
    height: device.height,
    deviceScaleFactor: device.scale,
    mobile: true,
    screenWidth: device.width,
    screenHeight: device.height,
  });
  await tab.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await tab.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_TRACE });
  const page = phonePage(t, tab, { name, origin: computer.origin });
  // The page's own questions (confirm: "Close it?"), answered yes as a
  // person would, each kept for the step that asked it.
  browser.on("Page.javascriptDialogOpening", (params, from) => {
    if (from !== tab.sessionId) return;
    page.dialogs.push(params.message);
    void tab.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
  });
  // What the page asked the computer, for a failed step's message.
  await tab.send("Network.enable");
  const asked = new Map(), failed = new Map();
  const failedRequest = (requestId, request) => {
    failed.set(requestId, request);
    if (failed.size > 20) failed.delete(failed.keys().next().value);
  };
  browser.on("Network.requestWillBeSent", ({ requestId, request }, from) => {
    if (from !== tab.sessionId || !/\/(api|ws)\//.test(request.url)) return;
    asked.set(requestId, { at: Date.now(), method: request.method, path: new URL(request.url).pathname });
    if (asked.size > 60) asked.delete(asked.keys().next().value);
  });
  browser.on("Network.responseReceived", ({ requestId, response }, from) => {
    if (from !== tab.sessionId || !asked.has(requestId)) return;
    const request = asked.get(requestId);
    request.status = response.status;
    if (response.status >= 400) failedRequest(requestId, request);
  });
  browser.on("Network.loadingFailed", ({ requestId, errorText, canceled, blockedReason }, from) => {
    if (from !== tab.sessionId || !asked.has(requestId)) return;
    const request = asked.get(requestId);
    request.failed = /^net::ERR_[A-Z0-9_]{1,48}$/.test(errorText || "") ? errorText : "request failed";
    request.cancelled = !!canceled;
    if (/^[a-zA-Z-]{1,64}$/.test(blockedReason || "")) request.blockedReason = blockedReason;
    failedRequest(requestId, request);
  });
  page.requests = () => [...asked.values()];
  page.failedRequests = () => [...failed.values()];
  page.nativeCalls = computer.reach.nativeCalls;
  // What the phone downloads lands in a folder of this test's own:
  // [{ name, state, file }], `state` "completed" once all of it is there.
  const downloads = fs.mkdtempSync(path.join(computer.reach.temp, "downloads-"));
  await browser.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: true });
  const got = [];
  browser.on("Browser.downloadWillBegin", ({ guid, suggestedFilename }) => got.push({ guid, name: suggestedFilename, file: path.join(downloads, suggestedFilename) }));
  browser.on("Browser.downloadProgress", ({ guid, state }) => {
    const one = got.find((d) => d.guid === guid);
    if (one) one.state = state;
  });
  page.downloads = () => got;
  // A permission the phone's browser asks the person for (reading the
  // clipboard), given as they would give it.
  page.grant = (permissions) =>
    browser.send("Browser.grantPermissions", { origin: computer.origin, permissions });
  await page.open("/");
  await signIn(page, computer);
  return page;
}

async function signIn(page, computer) {
  if (computer.approval) {
    // The page asks by itself, then shows the code to type into Reach.
    const code = await page.see(() => document.querySelector(".approval-code")?.textContent?.trim(), "the code to type on the computer", 60000);
    assert.match(code, /^[a-f0-9]{8}$/);
    await page.skipIntro();
    computer.reach.answer(code);
  } else {
    await page.see(/Pairing code/, "the pairing code form", 60000);
    // How to get a fresh code, as this computer gives one.
    await page.see(/For a fresh one, run (reach|\.\/reach|\.\\reach\.cmd) pair on your computer\./, "how to get a fresh code");
    // The form is already mounted underneath the first-time scene. Wait for
    // that scene to finish before a real finger can reach the pairing form.
    await page.skipIntro();
    await page.shot("connect");
    await page.fill("input.pair-code", computer.pairing);
    await page.tap("Connect computer");
  }
  // Leaving Connect can precede the first authenticated /api/device response.
  // These journeys approve an owner: Chat appears only once those details are
  // loaded. Measure navigation after that, so the bar cannot expand between
  // measuring a button and dispatching touchStart to its old coordinate.
  // MobileNav's separate native-touch test exercises changes during a press.
  await page.see(() => !document.querySelector(".connect-flow, .welcome, input.pair-code") &&
    document.querySelector('nav.mobile-nav button[aria-label="Chat"]'), "signed in, with the approved computer's details", 60000);
}

// The colour a PNG shows at its middle: { r, g, b } (8-bit RGB or RGBA,
// as Chrome's screenshots are).
function middleOfPng(png) {
  let at = 8, width = 0, height = 0, type = 0;
  const data = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const kind = png.toString("latin1", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      type = body[9];
    } else if (kind === "IDAT") data.push(body);
    at += 12 + length;
  }
  const channels = type === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rows = [];
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels] : 0;
      const up = previous[i];
      const corner = i >= channels ? previous[i - channels] : 0;
      const p = left + up - corner;
      const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner) ? left : Math.abs(p - up) <= Math.abs(p - corner) ? up : corner;
      line[i] = (line[i] + [0, left, up, (left + up) >> 1, paeth][filter]) & 255;
    }
    rows.push(line);
    previous = line;
  }
  const row = rows[height >> 1];
  const x = (width >> 1) * channels;
  return { r: row[x], g: row[x + 1], b: row[x + 2] };
}

// What the page did, for a failed step's message: each click it got (on
// what, where), each history step and each load, oldest first, in
// sessionStorage so a reload keeps it. Labels only: a button's own label or
// its first words, never a field's value.
const PAGE_TRACE = `(() => {
  const KEY = "journey.trace";
  const at = () => Math.round(performance.timeOrigin + performance.now()) % 1000000;
  const read = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || "[]"); } catch { return []; } };
  const add = (entry) => { try { const all = read(); all.push(at() + " " + entry.slice(0, 240)); sessionStorage.setItem(KEY, JSON.stringify(all.slice(-40))); } catch {} };
  const label = (el) => {
    const b = el && el.closest ? el.closest("button, a, [role=button], [role=tab], [role=menuitem], li, dialog, nav, header, main") || el : el;
    if (!b || !b.tagName) return String(b);
    const words = (b.getAttribute("aria-label") || (b.tagName === "INPUT" || b.tagName === "TEXTAREA" ? "" : b.innerText) || "").replace(/\\s+/g, " ").trim().slice(0, 40);
    return b.tagName.toLowerCase() + (b.className && typeof b.className === "string" ? "." + b.className.trim().split(/\\s+/).slice(0, 2).join(".") : "") + (words ? " '" + words + "'" : "");
  };
  add("load " + location.pathname + location.search);
  addEventListener("click", (e) => add("click " + (e.isTrusted ? "" : "(script) ") + label(e.target) + " at " + Math.round(e.clientX) + "," + Math.round(e.clientY)), true);
  for (const type of ["pointerdown", "pointerup", "touchstart", "touchend"]) {
    addEventListener(type, (e) => {
      const point = e.changedTouches?.[0] || e;
      add(type + " " + (e.isTrusted ? "" : "(script) ") + label(e.target) + " at " + Math.round(point.clientX) + "," + Math.round(point.clientY));
    }, { capture: true, passive: true });
  }
  addEventListener("popstate", (e) => add("popstate " + JSON.stringify(e.state && (e.state.page || e.state)).slice(0, 60)), true);
  for (const name of ["pushState", "replaceState"]) {
    const original = history[name];
    history[name] = function (state, ...rest) { add(name + " " + JSON.stringify(state && (state.page || state)).slice(0, 60)); return original.call(this, state, ...rest); };
  }
  const go = history.go;
  history.go = function (n) { add("go " + n); return go.call(this, n); };
})();`;

// What a journey does with the page: open, look, tap, type, and keep a
// screenshot of each step.
function phonePage(t, tab, { name, origin }) {
  let shots = 0;
  // Each tap: what was meant, where, what the page had there just before
  // the finger came down, and the viewport then (for a tap that landed
  // elsewhere).
  const tapped = [];
  const label = `${process.platform}-${name}`.replace(/[^a-z0-9-]+/gi, "-").replace(/-+/g, "-").slice(0, 80);
  const shot = async (step) => {
    try {
      const { data } = await tab.send("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync(reports, { recursive: true });
      const file = path.join(reports, `${label}-${String(++shots).padStart(2, "0")}-${step.replace(/[^a-z0-9-]+/gi, "-").slice(0, 40)}.png`);
      fs.writeFileSync(file, Buffer.from(data, "base64"));
      return file;
    } catch {
      return null;
    }
  };
  const text = () => tab.evaluate("document.body?.innerText || ''");
  // Shared by text/DOM waits and screenshot-colour waits. Persist the same
  // bounded evidence before either kind of assertion can be buffered.
  const recordFailure = async (description, file, extra = {}) => {
    const observed = await tab.evaluate(`(() => {
      let trace = []; try { trace = JSON.parse(sessionStorage.getItem("journey.trace") || "[]"); } catch {}
      const input = document.querySelector("input.pair-code");
      const button = input?.closest("form")?.querySelector("button");
      const viewport = visualViewport;
      return { trace, state: { connectVisible: !!document.querySelector(".connect-flow, .welcome, input.pair-code"),
        pairingLength: input?.value?.length ?? null, pairingValid: input?.validity?.valid ?? null,
        submitDisabled: button?.disabled ?? null,
        activeTag: document.activeElement?.tagName?.slice(0, 48) || null,
        viewport: viewport ? [viewport.offsetLeft, viewport.offsetTop, viewport.scale, viewport.width, viewport.height] : null } };
    })()`).catch(() => ({ trace: [], state: null }));
    const did = Array.isArray(observed?.trace) ? observed.trace : [];
    const bounded = (value, max) => typeof value === "string" ? value.slice(0, max) : null;
    const numbers = (values, max) => Array.isArray(values) ? values.slice(0, max).map((value) => Number.isFinite(value) ? value : null) : null;
    const request = value => ({
      at: value.at, method: bounded(value.method, 16), path: bounded(value.path, 240),
      status: value.status, failed: bounded(value.failed, 64), cancelled: !!value.cancelled,
      blockedReason: bounded(value.blockedReason, 64),
    });
    let nativeCalls = [];
    try { const values = page.nativeCalls?.(); if (Array.isArray(values)) nativeCalls = values.slice(0, 32).map(safeNativeCall).filter(Boolean); } catch {}
    // API paths/statuses and input length only: no bodies, headers, field
    // values, URL queries, raw native/browser errors, or arbitrary extras.
    try {
      fs.mkdirSync(reports, { recursive: true });
      fs.writeFileSync(file ? file.replace(/\.png$/, ".json") : path.join(reports, `${label}-failed-step.json`), JSON.stringify({
        step: bounded(description, 160), state: observed?.state ?? null,
        requests: (page.requests?.() || []).slice(-15).map(request),
        // Retained separately: later successful health polls cannot evict
        // the HTTP failure that caused an earlier Apps or icon lookup error.
        failedRequests: (page.failedRequests?.() || []).slice(-20).map(request),
        gestures: did.filter((entry) => typeof entry === "string" && /^\d+ (click|pointerdown|pointerup|touchstart|touchend) /.test(entry)).slice(-30).map((entry) => entry.slice(0, 256)),
        taps: tapped.slice(-6).map((tap) => ({
          meant: bounded(tap.meant, 160), x: tap.x, y: tap.y,
          hit: bounded(tap.hit, 40), viewport: numbers(tap.viewport, 8), observationFailed: !!tap.error,
        })),
        nativeCalls, ...safeFailureExtra(extra),
      }, null, 2) + "\n");
    } catch { /* Preserve the original assertion if evidence cannot be written. */ }
    return did;
  };
  // Until the page shows `what` (a pattern in its text, or a page function
  // that returns something); then that. Otherwise the step failed: what the
  // page showed and said, and its screenshot.
  const see = async (what, description = String(what), ms = 20000, why = async () => "") => {
    const check =
      what instanceof RegExp
        ? `(() => { const m = (document.body?.innerText || '').match(${what}); return m && m[0]; })()`
        : typeof what === "function"
          ? `(() => { const v = (${what})(); return v instanceof Node ? true : v; })()`
          : what?.js
            ? what.js
            : `(() => (document.body?.innerText || '').includes(${JSON.stringify(what)}) && ${JSON.stringify(what)})()`;
    const end = Date.now() + ms;
    let last;
    for (;;) {
      try {
        const value = await tab.evaluate(check);
        if (value) return value;
      } catch (error) {
        last = error;
      }
      if (Date.now() > end) {
        const file = await shot(`failed-${description}`);
        const shown = await text().catch(() => "");
        const found = await why().catch(() => "");
        const requests = (page.requests?.() || []).slice(-15).map((r) => `${r.method} ${r.path} ${r.status ?? "…"}`);
        const did = await recordFailure(description, file);
        assert.fail(
          `The phone never showed ${description}${last ? ` (${last.message})` : ""}.${found ? `\nLooked at: ${found}` : ""}\nIt shows: ${shown.slice(-2500)}\nIt said: ${JSON.stringify(tab.problems.slice(-12))}\nIt asked: ${JSON.stringify(requests)}\nIt did: ${JSON.stringify(did)}\nTapped: ${JSON.stringify(tapped.slice(-6))}\nScreenshot: ${file}`,
        );
      }
      await sleep(100);
    }
  };
  // The element a person would tap for `target`: a button, link, tab or row
  // whose words (or label) match; a CSS selector; or { selector, text }, the
  // selector's elements whose words match the text (a string inside them,
  // or a pattern).
  const pattern = (value) => (value instanceof RegExp ? value : JSON.stringify(value));
  const find = (target) => `(() => {
    const target = ${target?.selector ? `{ selector: ${JSON.stringify(target.selector)}, text: ${pattern(target.text)} }` : pattern(target)};
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.pointerEvents !== "none"; };
    const words = (el) => [el.innerText, el.getAttribute("aria-label"), el.getAttribute("title")].filter(Boolean).map((s) => s.replace(/\\s+/g, " ").trim());
    const fits = (el) => words(el).some((w) => (target instanceof RegExp ? target.test(w) : w === target));
    let candidates;
    if (target?.selector)
      candidates = [...document.querySelectorAll(target.selector)].filter((el) =>
        words(el).some((w) => (target.text instanceof RegExp ? target.text.test(w) : w.includes(target.text))),
      );
    else if (typeof target === "string" && /^[.#\\[]|^[a-z]+[.#\\[]/.test(target)) candidates = [...document.querySelectorAll(target)];
    else {
      const clickable = [...document.querySelectorAll("button, a, [role=button], [role=tab], [role=link], [role=menuitem], [role=option], [role=switch], summary, label, input[type=checkbox], [onclick], li")];
      candidates = clickable.filter(fits);
      // The innermost one that fits: a row's own button, not the row.
      candidates = candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other)));
    }
    const el = candidates.find((el) => visible(el) && !el.disabled && el.getAttribute("aria-disabled") !== "true");
    // Why not, for the step's failure.
    window.__journeyFind = candidates.slice(0, 5).map((el) => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      return { tag: el.tagName, words: words(el)[0]?.slice(0, 60), size: [Math.round(r.width), Math.round(r.height)], visibility: s.visibility, pointer: s.pointerEvents, disabled: !!el.disabled };
    });
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    const x = r.x + r.width / 2, y = r.y + r.height / 2;
    // Being mounted and styled visible does not mean a finger can reach it.
    // Wait within this tap's existing budget; never send a tap to an overlay
    // or replay an action after it disappears.
    const hit = document.elementFromPoint(x, y);
    if (!hit || !el.contains(hit)) return null;
    return { x, y };
  })()`;
  const touch = async (x, y) => {
    await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  // Touch and hold, for `ms`.
  const hold = async (x, y, ms = 800) => {
    await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await sleep(ms);
    await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const tap = async (target, description = target?.selector ? `${target.selector} (${target.text})` : String(target), ms = 20000) => {
    const at = await see({ js: find(target) }, `${description} to tap`, ms, () => tab.evaluate("JSON.stringify(window.__journeyFind || [])"));
    const there = await tab.evaluate(`(() => {
      const el = document.elementFromPoint(${at.x}, ${at.y});
      const b = el && (el.closest("button, a, [role=button], [role=tab], li") || el);
      const v = visualViewport;
      return { hit: b ? (b.getAttribute("aria-label") || b.innerText || b.tagName).replace(/\\s+/g, " ").trim().slice(0, 40) : null,
        viewport: [Math.round(v.offsetLeft), Math.round(v.offsetTop), v.scale, Math.round(scrollX), Math.round(scrollY), document.documentElement.scrollWidth, document.documentElement.clientWidth] };
    })()`).catch((error) => ({ error: error.message }));
    tapped.push({ meant: description, x: Math.round(at.x), y: Math.round(at.y), ...there });
    await touch(at.x, at.y);
    await sleep(150);
    return at;
  };
  const page = {
    tab,
    origin,
    dialogs: [],
    text,
    see,
    shot,
    recordFailure,
    tap,
    touch,
    hold,
    // The colour the phone shows at a point of the page, as a person sees
    // it (its screen, not what a page script can read back).
    pixel: async (x, y) => {
      const { data } = await tab.send("Page.captureScreenshot", { format: "png", clip: { x: x - 1, y: y - 1, width: 3, height: 3, scale: 1 } });
      return middleOfPng(Buffer.from(data, "base64"));
    },
    evaluate: (expression) => tab.evaluate(expression),
    // Whether the page shows `what` now, without waiting.
    shows: async (what) =>
      what instanceof RegExp ? what.test(await text()) : (await text()).includes(what),
    open: (route) => tab.navigate(origin + route),
    // Typing as the phone's keyboard does: into whatever has the focus, at
    // a person's pace (the page sees it before the next key).
    type: async (value) => {
      await tab.send("Input.insertText", { text: value });
      await sleep(250);
    },
    key: async (key) => {
      const keys = {
        Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
        Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
        Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
      };
      const k = keys[key];
      await tab.send("Input.dispatchKeyEvent", { type: "keyDown", ...k });
      await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...k, text: undefined });
    },
    // The first time on a phone: a short scene (src/MascotIntro.tsx),
    // skipped as a person would, or let end; then it's gone.
    skipIntro: async () => {
      const skip = await tab.evaluate(find(".intro-skip-button"));
      if (skip) await touch(skip.x, skip.y);
      await see(() => !document.querySelector(".mascot-intro"), "the first-time scene ended", 30000);
    },
    // A field, tapped then typed into: its value as the keyboard leaves it.
    fill: async (selector, value) => {
      await tap(selector);
      await tab.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.focus(); el.select?.(); })()`);
      await tab.send("Input.insertText", { text: value });
    },
  };
  return page;
}
