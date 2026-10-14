import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import assert from "node:assert/strict";
import { firstInstall, setupMenu } from "./first-install.mjs";
import { HOST } from "./fake-tailscale.mjs";
import { findChrome, launchChrome, openTab, testCertificate } from "./headless-chrome.mjs";
import { computerWord } from "../../server/computer-word.mjs";

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
const chrome = findChrome();
export const skip = !chrome
  ? "no Chrome or Chromium on this computer (set REACH_TEST_CHROME to one)"
  : !["darwin", "win32"].includes(process.platform)
    ? "the journeys run on a Mac or a Windows PC"
    : false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      const upstream = to.socketPath ? net.connect(to.socketPath) : net.connect(to.port, to.host);
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
    socket.on("error", () => {});
    const [host, port] = req.url.split(":");
    if (host !== HOST || !/^\d+$/.test(port || "")) return socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) socket.unshift(head);
    server(Number(port)).emit("connection", socket);
  });
  return {
    proxy,
    close: async () => {
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
  await new Promise((resolve) => serve.proxy.listen(0, "127.0.0.1", resolve));
  const browser = await launchChrome(t, {
    spki: tls.spki,
    args: [`--proxy-server=http://127.0.0.1:${serve.proxy.address().port}`, "--lang=en-US"],
  });
  // Chrome before the servers it holds connections to.
  t.after(async () => {
    await browser.close();
    await serve.close();
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
  const page = phonePage(t, tab, { name, origin: computer.origin });
  await page.open("/");
  await signIn(page, computer);
  return page;
}

async function signIn(page, computer) {
  if (computer.approval) {
    // The page asks by itself, then shows the code to type into Reach.
    const code = await page.see(() => document.querySelector(".approval-code")?.textContent?.trim(), "the code to type on the computer", 60000);
    assert.match(code, /^[a-f0-9]{8}$/);
    computer.reach.answer(code);
  } else {
    await page.see(/Pairing code/, "the pairing code form", 60000);
    await page.fill("input.pair-code", computer.pairing);
    await page.tap("Connect computer");
  }
  await page.see(() => !document.querySelector(".connect-flow, .welcome, input.pair-code"), "signed in, past the connect page", 60000);
}

// What a journey does with the page: open, look, tap, type, and keep a
// screenshot of each step.
function phonePage(t, tab, { name, origin }) {
  let shots = 0;
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
  // Until the page shows `what` (a pattern in its text, or a page function
  // that returns something); then that. Otherwise the step failed: what the
  // page showed and said, and its screenshot.
  const see = async (what, description = String(what), ms = 20000, why = async () => "") => {
    const check =
      what instanceof RegExp
        ? `(() => { const m = (document.body?.innerText || '').match(${what}); return m && m[0]; })()`
        : typeof what === "function"
          ? `(${what})()`
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
        assert.fail(
          `The phone never showed ${description}${last ? ` (${last.message})` : ""}.${found ? `\nLooked at: ${found}` : ""}\nIt shows: ${shown.slice(-2500)}\nIt said: ${JSON.stringify(tab.problems.slice(-12))}\nScreenshot: ${file}`,
        );
      }
      await sleep(100);
    }
  };
  // The element a person would tap for `target`: a button, link, tab or row
  // whose words (or label) match, or a CSS selector.
  const find = (target) => `(() => {
    const target = ${target instanceof RegExp ? target : JSON.stringify(target)};
    const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.pointerEvents !== "none"; };
    const words = (el) => [el.innerText, el.getAttribute("aria-label"), el.getAttribute("title")].filter(Boolean).map((s) => s.replace(/\\s+/g, " ").trim());
    const fits = (el) => words(el).some((w) => (target instanceof RegExp ? target.test(w) : w === target));
    let candidates;
    if (typeof target === "string" && /^[.#\\[]|^[a-z]+[.#\\[]/.test(target)) candidates = [...document.querySelectorAll(target)];
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
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`;
  const touch = async (x, y) => {
    await tab.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await tab.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const tap = async (target, description = String(target), ms = 20000) => {
    const at = await see({ js: find(target) }, `${description} to tap`, ms, () => tab.evaluate("JSON.stringify(window.__journeyFind || [])"));
    await touch(at.x, at.y);
    await sleep(150);
    return at;
  };
  const page = {
    tab,
    origin,
    text,
    see,
    shot,
    tap,
    touch,
    evaluate: (expression) => tab.evaluate(expression),
    // Whether the page shows `what` now, without waiting.
    shows: async (what) =>
      what instanceof RegExp ? what.test(await text()) : (await text()).includes(what),
    open: (route) => tab.navigate(origin + route),
    // Typing as the phone's keyboard does: into whatever has the focus.
    type: (value) => tab.send("Input.insertText", { text: value }),
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
