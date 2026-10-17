import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { agentSteps, agentStepsPage, wantsPage } from "./agent-steps.mjs";

// The one public part of Reach: the start page a phone opens before it is on
// the tailnet, through Tailscale Funnel. It serves only fixed files that hold
// no data: the start page, the app's built code and the browser tailnet
// client, and the agent runtime. No API, no WebSockets, no proxying; Reach
// itself stays private.
// With the Tailscale app on, the start page sends the phone straight to the
// private address; without it, the phone signs in to Tailscale in the browser.

const accepts = (req, encoding) =>
  new RegExp(`(?:^|[\\s,])${encoding}(?:[\\s,;]|$)`).test(
    String(req.headers["accept-encoding"] || ""),
  );
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".png": "image/png",
};
// https://*.ts.net:8443: the start page asks the Mac's private address (port
// 8443) whether this phone is on the tailnet (probeDirect); without it a phone
// with the Tailscale app is sent down the in-browser path (Oct 10).
export const PUBLIC_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' https://*.ts.net https://*.ts.net:8443 wss://*.ts.net https://*.tailscale.com wss://*.tailscale.com; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
// One file name: no "." or ".." (they name folders).
const NAME = /^\/(?!\.{1,2}$)[\w.-]+$/;

// Where the browser client was built, if it was: { wasm, exec } file names.
export function readTailnetManifest(dir) {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(dir, "tailnet.json"), "utf8"),
    );
    return ["wasm", "exec"].every(
      (k) => typeof value[k] === "string" && NAME.test(`/${value[k]}`),
    ) && ["wasm", "exec"].every((k) => fs.existsSync(path.join(dir, value[k])))
      ? { wasm: value.wasm, exec: value.exec }
      : null;
  } catch {
    return null;
  }
}

// What the internet gets at this computer's address. Reach's own listener
// hands it only requests Tailscale marked as coming through Funnel
// (server/tailscale-auth.mjs); your devices get Reach itself there.
export function publicStartHandler({
  dist,
  tailnetDir,
  privateOrigin,
  // The one address, https://<computer>.<tailnet>.ts.net: Reach for your
  // devices, this page for the internet. The browser path signs in, then uses
  // Reach there too, so both ways in keep the same saved computer.
  home = "",
  name,
  instance,
  // When Reach was set up on this computer: the oldest one's link is your
  // tailnet's one link.
  since = 0,
  // Whether a new browser can sign in with Face ID alone right now
  // (server/face-join.mjs).
  faceId = () => false,
  // What the steps at /agent call this computer (computer-word.mjs).
  platform = process.platform,
}) {
  const publicHost = new URL(privateOrigin).hostname;
  // Automatic port recovery must also permit the direct-connection probe
  // to this computer's selected port, including its WebSocket connection.
  const direct = new URL(privateOrigin);
  const csp = !direct.port || direct.port === "8443" ? PUBLIC_CSP
    : PUBLIC_CSP.replace("connect-src 'self'", `connect-src 'self' ${direct.origin} ${direct.origin.replace(/^https:/, "wss:")}`);
  // Where an agent's link points, and its runtime comes from.
  const agentStart = home || `https://${publicHost}`;
  const config = () =>
    JSON.stringify({
      product: "Reach",
      origin: privateOrigin,
      ...(home ? { home } : {}),
      ...(faceId() ? { faceId: true } : {}),
      name,
      instance,
      since,
      tailnet: tailnetDir ? readTailnetManifest(tailnetDir) : null,
    });
  // Remember only files that exist: names requested from the internet are
  // arbitrary, so misses must not grow memory.
  const found = new Set();
  const has = (file) => {
    if (found.has(file)) return true;
    const ok = fs.existsSync(file);
    if (ok) found.add(file);
    return ok;
  };
  const send = (req, res, file, cache) => {
    const headers = {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": cache,
    };
    let body = file;
    if (cache.includes("immutable")) {
      headers.Vary = "Accept-Encoding";
      for (const [encoding, ext] of [
        ["br", ".br"],
        ["gzip", ".gz"],
      ])
        if (accepts(req, encoding) && has(file + ext)) {
          headers["Content-Encoding"] = encoding;
          body = file + ext;
          break;
        }
    }
    let size;
    try {
      size = fs.statSync(body).size;
    } catch {
      return notFound(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(body)
      .on("error", () => res.destroy())
      .pipe(res);
  };
  const notFound = (res) => {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found.");
  };
  // An agent's link explains itself: its steps as text to a program (curl,
  // a fetch tool), the start page with them in it to a browser. Nothing
  // from the request goes in (its fragment never arrives anyway).
  const agentPage = (req, res) => {
    const text = agentSteps(agentStart, { platform });
    let body = text, type = "text/plain; charset=utf-8";
    if (wantsPage(req.headers.accept)) {
      try {
        body = agentStepsPage(fs.readFileSync(path.join(dist, "start.html"), "utf8"), text);
        type = "text/html; charset=utf-8";
      } catch {
        return notFound(res);
      }
    }
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache", Vary: "Accept", "Content-Length": Buffer.byteLength(body) });
    res.end(req.method === "HEAD" ? undefined : body);
  };
  return (req, res) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    // Funnel serves this only over HTTPS: browsers keep it so.
    res.setHeader("Strict-Transport-Security", "max-age=31536000");
    let host = "";
    try {
      host = new URL(`http://${req.headers.host || ""}`).hostname;
    } catch {}
    if (![publicHost, "localhost", "127.0.0.1"].includes(host)) {
      res.writeHead(421, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Unrecognized host.");
    }
    if (!["GET", "HEAD"].includes(req.method)) {
      res.writeHead(405, { Allow: "GET, HEAD" });
      return res.end();
    }
    const url = (req.url || "/").split("?")[0];
    if (url === "/agent-browser")
      return send(req, res, path.join(dist, "agent.html"), "no-store");
    if (url === "/agent") return agentPage(req, res);
    if (url === "/" || url === "/guest")
      return send(req, res, path.join(dist, "start.html"), "no-cache");
    if (url === "/reach-start.json") {
      const body = config();
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(body),
      });
      return res.end(req.method === "HEAD" ? undefined : body);
    }
    if (url.startsWith("/assets/") && NAME.test(url.slice(7)))
      return send(
        req,
        res,
        path.join(dist, "assets", url.slice(8)),
        "public, max-age=31536000, immutable",
      );
    if (tailnetDir && url.startsWith("/tailnet/") && NAME.test(url.slice(8)))
      return send(
        req,
        res,
        path.join(tailnetDir, url.slice(9)),
        "public, max-age=31536000, immutable",
      );
    // A runtime this computer served, by its SHA-256: a line from `agent.mjs
    // keep` restores with exactly the one it was kept with.
    if (/^\/agent-runtimes\/[0-9a-f]{64}\.mjs$/.test(url))
      return send(req, res, path.join(dist, url.slice(1)), "public, max-age=31536000, immutable");
    // Reach for agents: an invited agent downloads it to join (no secrets).
    if (
      [
        "/favicon.svg",
        "/fonts.css",
        "/manifest.webmanifest",
        "/sw.js",
        "/agent.mjs",
      ].includes(url)
    )
      return send(req, res, path.join(dist, url.slice(1)), "no-cache");
    notFound(res);
  };
}

export function createPublicStart(options) {
  const server = http.createServer(publicStartHandler(options));
  // No WebSockets here, ever.
  server.on("upgrade", (req, socket) => socket.destroy());
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  return server;
}
