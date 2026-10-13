import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { findChrome, launchChrome, openTab, testCertificate } from "./helpers/headless-chrome.mjs";

// Face ID in Settings, end to end, in a real browser: headless Chrome with a
// platform passkey (a WebAuthn virtual authenticator: internal, resident
// keys, user verification, backup eligible and backed up, as iCloud Keychain
// and Google Password Manager passkeys are), on this computer's own Tailscale
// name and port, against a real Reach behind a stand-in for Tailscale Serve
// (identity headers on its private socket).
//
// The page is Settings' own Face ID components (src/FaceIdSettings.tsx,
// src/AgentFaceId.tsx), built from source, not the whole app: the whole app's
// Home would reach for this computer itself (its screen, Terminal tabs,
// agents), which a test must not touch.
//
// A person takes a moment at the Face ID sheet; a virtual authenticator
// answers in milliseconds. The stand-in holds the answer's POST for 1.5 s, so
// whatever the page does meanwhile reaches the computer first, as on a phone
// (Oct 13: every add from the owner's iPhone was refused because the page
// asked for a new challenge while Face ID was still up).
const HOST = "mac-a.t.ts.net";
const owner = { userId: "42", login: "me@example.test" };
const PHONE = "100.64.0.10",
  NEW_BROWSER = "100.64.0.11";
const NODES = {
  [PHONE]: { id: "nPhone", name: "iphone" },
  [NEW_BROWSER]: { id: "nNewBrowser", name: "iphone-chrome" },
};
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const repo = fileURLToPath(new URL("..", import.meta.url));
const chrome = findChrome();
const openssl = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;
const skip =
  process.platform === "win32"
    ? "Reach's private Tailscale socket is POSIX-only"
    : !chrome
      ? "no Chrome or Chromium on this computer (set REACH_TEST_CHROME to one)"
      : !openssl
        ? "no openssl for the test certificate"
        : false;

// Settings' Face ID components, built as the app builds them. ?agents shows
// Settings → Agents' switch instead.
async function buildPage(dir) {
  const src = path.join(dir, "src");
  fs.mkdirSync(src);
  const abs = (p) => JSON.stringify(path.join(repo, p).split(path.sep).join("/"));
  fs.writeFileSync(
    path.join(src, "entry.js"),
    `import React from ${abs("node_modules/react/index.js")};
import { createRoot } from ${abs("node_modules/react-dom/client.js")};
import { FaceIdSettings } from ${abs("src/FaceIdSettings.tsx")};
import AgentFaceIdSetting from ${abs("src/AgentFaceId.tsx")};
import { signWithFaceId } from ${abs("src/passkeys.ts")};
window.__signWithFaceId = signWithFaceId;
const peer = JSON.parse(localStorage.getItem("e2e.peer") || "null");
const page = location.search === "?agents" ? AgentFaceIdSetting : FaceIdSettings;
if (peer) createRoot(document.getElementById("root")).render(React.createElement(page, { peer }));
`,
  );
  const out = path.join(dir, "page");
  const { build } = await import("vite");
  await build({
    configFile: false,
    root: src,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    build: {
      outDir: out,
      emptyOutDir: true,
      minify: false,
      target: "chrome100",
      lib: { entry: path.join(src, "entry.js"), formats: ["es"], fileName: () => "entry.js", cssFileName: "entry" },
    },
  });
  const css = fs.readdirSync(out).filter((f) => f.endsWith(".css"));
  fs.writeFileSync(
    path.join(out, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${css.map((f) => `<link rel="stylesheet" href="${f}">`).join("")}</head><body><div id="root"></div><script type="module" src="entry.js"></script></body></html>`,
  );
  return out;
}

// Tailscale Serve, as far as Reach sees it: TLS on the computer's name, then
// each request on Reach's private socket with the source device's address
// and its user's login. `from.ip`: which device is asking now. `/__e2e/` is
// the test page. The Face ID answers are held (a person at the sheet).
async function tailscaleServe({ tls, socket, page, hold = 1500 }) {
  const from = { ip: PHONE };
  const seen = []; // "POST /api/…", in the order they reached Reach
  const sent = (req) => {
    if (req.url.startsWith("/api/")) seen.push(`${req.method} ${req.url}`);
  };
  const headers = (req) => ({
    ...req.headers,
    "x-forwarded-for": from.ip,
    "tailscale-user-login": owner.login,
    "tailscale-user-name": "Me",
  });
  const held = (req) =>
    req.method === "POST" && ["/api/auth/passkeys", "/api/settings"].includes(req.url);
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    if (req.url.startsWith("/__e2e/")) {
      const file = path.join(page, path.basename(new URL(req.url, "https://x").pathname) || "index.html");
      if (!fs.existsSync(file)) return res.writeHead(404).end();
      res.setHeader(
        "Content-Type",
        /\.m?js$/.test(file) ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html",
      );
      return res.end(fs.readFileSync(file));
    }
    const forward = () => {
      sent(req);
      const out = http.request(
        { socketPath: socket, path: req.url, method: req.method, headers: headers(req) },
        (answer) => {
          res.writeHead(answer.statusCode, answer.headers);
          answer.pipe(res);
        },
      );
      out.on("error", () => res.destroy());
      req.pipe(out);
    };
    if (held(req)) setTimeout(forward, hold);
    else forward();
  });
  server.on("upgrade", (req, client, head) => {
    const upstream = net.connect(socket, () => {
      const lines = Object.entries(headers(req)).map(([k, v]) => `${k}: ${v}`);
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, from, seen, port: server.address().port };
}

test(
  "Settings → Face ID in a real browser: added, signs a new browser in, and Settings → Agents' switch goes on and off with it",
  { skip, timeout: 120000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-faceid-e2e-"));
    const socketDir = fs.mkdtempSync("/tmp/reach-fe-");
    const socket = path.join(socketDir, "s");
    // Undone last first: Chrome before the servers it keeps connections to.
    const undo = [];
    t.after(async () => {
      for (const step of undo.reverse()) await step().catch(() => {});
    });
    undo.push(async () => {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(socketDir, { recursive: true, force: true });
    });
    const tls = await testCertificate(dir, HOST);
    const page = await buildPage(dir);
    const serve = await tailscaleServe({ tls, socket, page });
    undo.push(() => {
      serve.server.closeAllConnections();
      return new Promise((resolve) => serve.server.close(resolve));
    });
    const origin = `https://${HOST}:${serve.port}`;
    const dataDir = path.join(dir, "private");
    const shared = path.join(dir, "shared");
    fs.mkdirSync(shared);
    const logged = [];
    const log = console.log;
    console.log = (...args) => {
      logged.push(args.join(" "));
      log(...args);
    };
    undo.push(async () => {
      console.log = log;
    });
    const reach = await createReach({
      roots: [shared],
      dataDir,
      port: 0,
      publicOrigin: origin,
      // The port-less address, as ./reach starts it (scripts/launch.mjs).
      allowedOrigins: [`https://${HOST}`],
      tailscaleOwner: owner,
      screen: false,
      agentDesktop: null,
      tailscaleIdentity: {
        lookup: async (ip) => {
          const n = NODES[ip];
          return (
            n && {
              Node: { StableID: n.id, User: 42, Name: `${n.name}.t.ts.net.`, KeyExpiry: "0001-01-01T00:00:00Z" },
              UserProfile: { ID: 42, LoginName: owner.login },
            }
          );
        },
      },
      tailscaleStatus: async () => ({ Self: { TailscaleIPs: ["100.64.0.5"] }, Peer: {} }),
    });
    await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
    await reach.listenPrivate(socket);
    undo.push(async () => {
      reach.server.closeAllConnections?.();
      await reach.close();
    });
    const phone = reach.auth.issue("iPhone", ALL_SCOPES, "device", {
      tailscale: { userId: "42", nodeId: "nPhone" },
      nodeName: "iphone",
    });
    const saved = () => JSON.parse(fs.readFileSync(path.join(dataDir, "passkeys.json"), "utf8")).credentials;

    const browser = await launchChrome(t, {
      hosts: [HOST],
      spki: tls.spki,
    });
    undo.push(() => browser.close());
    const tab = await openTab(browser);
    // An iPhone with Face ID (its screen, its Safari), and its passkeys.
    await tab.send("Emulation.setUserAgentOverride", { userAgent: IPHONE_UA, platform: "iPhone" });
    await tab.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    });
    await tab.send("WebAuthn.enable", { enableUI: false });
    await tab.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
        defaultBackupEligibility: true,
        defaultBackupState: true,
      },
    });
    const text = () => tab.evaluate("document.body.innerText");
    const waitFor = async (what, check, ms = 15000) => {
      const until = Date.now() + ms;
      let last;
      while (Date.now() < until) {
        last = await tab.evaluate(check);
        if (last) return last;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error(
        `${what} didn't happen. The page says: ${JSON.stringify(await text())}; its errors: ${JSON.stringify(tab.problems)}`,
      );
    };
    // The same, for something on this side (what Reach was asked).
    const until = async (what, check, ms = 15000) => {
      const deadline = Date.now() + ms;
      while (!check()) {
        if (Date.now() > deadline)
          throw Error(`${what} didn't happen. Reach got: ${serve.seen.join(", ")}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const find = (label) =>
      `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute("aria-label") === ${JSON.stringify(label)})`;
    // A finger's tap, at the button: a real user gesture.
    const tap = async (label) => {
      const at = await tab.evaluate(
        `(() => { const b = ${find(label)}; if (!b) return null; b.scrollIntoView({ block: "center" }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
      );
      assert.ok(at, `no "${label}" button. The page says: ${JSON.stringify(await text())}`);
      for (const type of ["mousePressed", "mouseReleased"])
        await tab.send("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
    };
    const open = async (query = "") => {
      await tab.navigate(`${origin}/__e2e/index.html${query}`);
    };
    await open();
    await tab.evaluate(
      `localStorage.setItem("e2e.peer", ${JSON.stringify(JSON.stringify({ id: "mac-a", name: "Mac A", url: origin, token: phone.token, platform: "darwin" }))})`,
    );

    // Settings → Face ID: add this phone's.
    await open();
    await waitFor("the add button", `!!${find("Use Face ID")}`);
    // What it's for, said on the page in this phone's words.
    assert.match(
      await text(),
      /A new browser of yours \(another browser on this iPhone, or a new one with your passkeys\) signs in with Face ID instead of a code at your Mac\. Agents & people can require it to approve agents\./,
    );
    // Its challenge comes before the tap (Safari shows Face ID from a tap only).
    const challenges = () => serve.seen.filter((r) => r === "POST /api/auth/passkeys/options").length;
    await until("the challenge", () => challenges() === 1);
    await tap("Use Face ID");
    await waitFor(
      "the add finishing",
      `/Added\\. |can't|isn't|didn't|refused|Try again|cancelled|attempt|expired/i.test(document.body.innerText)`,
    );
    assert.equal(
      saved().length,
      1,
      `nothing saved. The page says: ${JSON.stringify(await text())}; Reach got, in order: ${serve.seen.join(", ")}`,
    );
    // While Face ID was up, nothing asked for another challenge: it would
    // have replaced the one the answer was made for.
    const added = serve.seen.indexOf("POST /api/auth/passkeys");
    assert.deepEqual(
      serve.seen.slice(0, added).filter((r) => r === "POST /api/auth/passkeys/options"),
      ["POST /api/auth/passkeys/options"],
      serve.seen.join(", "),
    );
    const [key] = saved();
    assert.equal(key.backupEligible, true, "a synced passkey: backup eligible");
    assert.equal(key.alg, -7);
    assert.deepEqual(key.transports, ["internal"]);
    // On: its row, checked, added today; and the line says what changed.
    await waitFor("its row", `/iPhone\\s*Added today/.test(document.body.innerText)`);
    assert.equal(await tab.evaluate(`!!document.querySelector(".faceid-on")`), true, "the green check");
    assert.match(await text(), /Added\. New browsers of yours can sign in with Face ID now\./);
    assert.ok(logged.includes("Reach: Face ID added (iPhone)."), logged.join("\n"));
    assert.ok(!logged.some((l) => /Face ID not added/.test(l)), logged.join("\n"));
    // Again from the same phone: its passkey is already there, and it says so.
    await waitFor("the next challenge", `!!${find("Add Face ID on this iPhone")}`);
    await until("the next challenge, once the answer was in", () => challenges() === 2);
    await tap("Add Face ID on this iPhone");
    await waitFor("its answer", `/already added/.test(document.body.innerText)`);
    assert.match(await text(), /This iPhone's Face ID is already added\./);
    assert.equal(saved().length, 1);

    // What it's for: a new browser of yours (another browser on this phone,
    // a new phone with your synced passkeys) signs in with it instead of a
    // code typed at the computer.
    serve.from.ip = NEW_BROWSER;
    const signIn = await tab.evaluate(`(async () => {
      const call = (route, body) => fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
      const asked = await call("/api/auth/requests", { name: "Chrome on iPhone" });
      const options = await call("/api/auth/requests/" + asked.json.id + "/passkey/options", { secret: asked.json.secret });
      const credential = await window.__signWithFaceId(options.json);
      const used = await call("/api/auth/requests/" + asked.json.id + "/passkey", { secret: asked.json.secret, credential });
      const polled = await call("/api/auth/requests/" + asked.json.id, { secret: asked.json.secret });
      return { offered: asked.json.passkey, used: used.status, error: used.json.error || "", status: polled.json.status, token: !!polled.json.token };
    })()`);
    serve.from.ip = PHONE;
    assert.deepEqual(signIn, { offered: true, used: 200, error: "", status: "approved", token: true });

    // Settings → Agents: the switch, on with a tap, off with Face ID.
    const agents = (on) => `(() => { const s = document.querySelector('[role="switch"]'); return !!s && s.getAttribute("aria-checked") === "${on}"; })()`;
    await open("?agents");
    await waitFor("the switch", agents(false));
    const switchName = await tab.evaluate(`document.querySelector('[role="switch"]').getAttribute("aria-label")`);
    assert.equal(switchName, "Face ID confirms approvals");
    await tap(switchName);
    await waitFor("on", agents(true));
    // Its Face ID challenge comes before the tap.
    const asked = () => serve.seen.filter((r) => r === "POST /api/settings/passkey/options").length;
    await until("the switch's challenge", () => asked() === 1);
    await tap(switchName);
    await waitFor("off with Face ID", `${agents(false)} || !!document.querySelector(".gs-foot")`);
    assert.equal(
      await tab.evaluate(agents(false)),
      true,
      `still on. The page says: ${JSON.stringify(await text())}; Reach got: ${serve.seen.slice(-6).join(", ")}`,
    );
    assert.equal(asked(), 1, "no new challenge while Face ID was up");
  },
);
