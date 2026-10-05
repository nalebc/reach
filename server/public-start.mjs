import fs from "node:fs";
import path from "node:path";
import http from "node:http";

// The one public part of Reach: the start page a phone opens before it is on
// the tailnet, through Tailscale Funnel. It serves only fixed files that hold
// no data: the start page, the app's built code and the browser tailnet
// client. No API, no WebSockets, no proxying; Reach itself stays private.
// With the Tailscale app on, the start page sends the phone straight to the
// private address; without it, the phone signs in to Tailscale in the browser.

const accepts = (req, encoding) =>
  new RegExp(`(?:^|[\\s,])${encoding}(?:[\\s,;]|$)`).test(
    String(req.headers["accept-encoding"] || ""),
  );
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".png": "image/png",
};
export const PUBLIC_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' https: wss:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
const NAME = /^\/[\w.-]+$/;

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

// Listen next to Reach's private socket (same owner-only directory). A stale
// socket from a previous run is replaced; a live one means Reach already runs.
export async function listenPublicSocket(server, socketPath) {
  const dir = path.dirname(socketPath);
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid())
    throw Error("Unsafe Reach socket directory.");
  if (fs.existsSync(socketPath)) {
    const old = fs.lstatSync(socketPath);
    if (!old.isSocket() || old.uid !== process.getuid())
      throw Error("Unsafe Reach socket path.");
    fs.unlinkSync(socketPath);
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o600);
}

export function createPublicStart({
  dist,
  tailnetDir,
  privateOrigin,
  name,
  instance,
  // When Reach was set up on this computer: the oldest one's link is your
  // tailnet's one link.
  since = 0,
}) {
  const publicHost = new URL(privateOrigin).hostname;
  const config = () =>
    JSON.stringify({
      product: "Reach",
      origin: privateOrigin,
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
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Security-Policy", PUBLIC_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
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
    if (["/favicon.svg", "/fonts.css", "/manifest.webmanifest"].includes(url))
      return send(req, res, path.join(dist, url.slice(1)), "no-cache");
    notFound(res);
  });
  // No WebSockets here, ever.
  server.on("upgrade", (req, socket) => socket.destroy());
  server.requestTimeout = 60000;
  server.headersTimeout = 15000;
  return server;
}
