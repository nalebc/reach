import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { rateLimit } from "express-rate-limit";
import { agentSteps, agentStepsPage, wantsPage } from "./agent-steps.mjs";
import { readTailnetManifest } from "./public-start.mjs";

const accepts = (req, encoding) =>
  new RegExp(`(?:^|[\\s,])${encoding}(?:[\\s,;]|$)`).test(
    String(req.headers["accept-encoding"] || ""),
  );

// Who this Reach is, for its own other computers on the tailnet (fleet.mjs):
// the same answer the public start page gives at /reach-start.json. Set by
// the launcher once its address is known; until then the route passes.
let startInfo = null;
export function setStartInfo(read) {
  startInfo = typeof read === "function" ? read : null;
}

// The built interface. Files under /assets carry a content hash in their name,
// so they never change: cache them for a year and serve the copy precompressed
// at build time. The page itself is revalidated on every open.
// `agentStart`: this computer's public start page, where agent links point
// (none: not on Tailscale, and /agent is the app as before).
export function serveBuild(app, express, dist, {
  agentStart = () => "", platform = process.platform,
  tailnetDir = path.resolve(dist, "..", "tailnet", "dist"),
} = {}) {
  const send = (res, next, file, options = {}) =>
    res.sendFile(file, { root: dist, ...options }, (error) => {
      if (!error) return;
      if (!res.headersSent) {
        // An immutable asset policy must never cache a failed delivery. Error
        // middleware sends its own body, not the selected compressed asset.
        res.setHeader("Cache-Control", "no-store");
        for (const header of ["Content-Encoding", "Content-Type", "Content-Length", "Content-Range", "ETag", "Last-Modified"])
          res.removeHeader(header);
      }
      next(error);
    });
  // A checkout may itself live beneath a hidden directory (such as .codex).
  // Root relative filenames there so sendFile checks only requested path
  // components for dotfiles, while retaining its default traversal protection.
  app.get("/agent-browser", (req, res, next) =>
    send(res, next, "agent.html", { headers: { "Cache-Control": "no-store" } }),
  );
  // An agent's link opened from the tailnet (the same address as the public
  // start page): its steps as text to a program, the start page with them in
  // it to a browser, as public-start.mjs does for the internet.
  // A page anyone on the tailnet can open: it reads start.html each time
  // (the interface rebuilds while Reach runs), so at most 120 a minute.
  const stepsLimit = rateLimit({
    windowMs: 60_000, limit: 120, keyGenerator: () => "agent-steps",
    standardHeaders: "draft-8", legacyHeaders: false, identifier: "agent-steps",
    message: "Too many requests for this page. Try again in a minute.",
  });
  app.get("/agent", stepsLimit, (req, res, next) => {
    const start = agentStart();
    if (!start) return next();
    const text = agentSteps(start, { platform });
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Vary", "Accept");
    if (!wantsPage(req.headers.accept)) return res.type("text/plain; charset=utf-8").send(text);
    fs.readFile(path.join(dist, "start.html"), "utf8", (error, html) => {
      if (error) return next();
      res.type("text/html; charset=utf-8").send(agentStepsPage(html, text));
    });
  });
  const exists = new Map();
  // Only found files are remembered: a miss (any name a client tries) is
  // looked up again, so the map can't grow without bound.
  const has = (file) => {
    if (exists.has(file)) return true;
    const found = fs.existsSync(file);
    if (found) exists.set(file, true);
    return found;
  };
  app.use("/assets", (req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method) || !/^\/[\w.-]+$/.test(req.path))
      return next();
    const name = path.join("assets", req.path.slice(1));
    const file = path.join(dist, name);
    if (!has(file)) return next();
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Vary", "Accept-Encoding");
    for (const [encoding, ext] of [
      ["br", ".br"],
      ["gzip", ".gz"],
    ])
      if (accepts(req, encoding) && has(file + ext)) {
        res.setHeader("Content-Encoding", encoding);
        res.type(path.extname(file));
        return send(res, next, name + ext, { cacheControl: false });
      }
    send(res, next, name, { cacheControl: false });
  });
  const browserClient = () => {
    const manifest = readTailnetManifest(tailnetDir);
    if (!manifest) return null;
    try {
      for (const [kind, extension] of [["wasm", ".wasm"], ["exec", ".js"]]) {
        const name = manifest[kind];
        if (!/^[a-zA-Z0-9][\w.-]*$/.test(name) || !name.endsWith(extension) ||
            !fs.lstatSync(path.join(tailnetDir, name)).isFile()) return null;
      }
      return manifest;
    } catch { return null; }
  };
  const homeFor = (info) => {
    try {
      const origin = new URL(info.origin), candidate = info.home || agentStart();
      const home = new URL(candidate);
      return origin.protocol === "https:" && origin.origin === info.origin &&
        origin.hostname.endsWith(".ts.net") && home.protocol === "https:" &&
        home.origin === candidate && home.hostname === origin.hostname && !home.port
        ? home.origin : "";
    } catch { return ""; }
  };
  app.get("/reach-start.json", (req, res, next) => {
    const info = startInfo?.();
    if (!info) return next();
    const { home: ignoredHome, tailnet: ignoredClient, ...identity } = info;
    const home = homeFor(info);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...identity, ...(home ? { home } : {}), tailnet: browserClient() });
  });
  // Private pages prepare the same fixed client assets as the start page.
  // Never turn this directory into a static file browser or serve SPA HTML
  // when a client asset is absent.
  app.use("/tailnet", (req, res, next) => {
    const manifest = browserClient(), name = req.path.slice(1);
    if (!["GET", "HEAD"].includes(req.method) || !manifest ||
        ![manifest.wasm, manifest.exec].includes(name)) {
      res.setHeader("Cache-Control", "no-store");
      return res.sendStatus(404);
    }
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.type(name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
    send(res, next, name, { root: tailnetDir, cacheControl: false });
  });
  const page = path.join(dist, "index.html");
  app.use(
    express.static(dist, {
      index: "index.html",
      setHeaders: (res, file) => {
        if (file === page) res.setHeader("Cache-Control", "no-cache");
      },
    }),
  );
  app.use((req, res, next) =>
    send(res, next, "index.html", { headers: { "Cache-Control": "no-cache" } }),
  );
}

// API responses over 1 KB (folder listings, app lists) go compressed. Done off
// the main thread; downloads use res.download and are never touched.
export function compressJson(minimum = 1024) {
  return (req, res, next) => {
    const encoding = accepts(req, "br")
      ? "br"
      : accepts(req, "gzip")
        ? "gzip"
        : "";
    if (!encoding) return next();
    const json = res.json.bind(res);
    res.json = (body) => {
      const text = JSON.stringify(body);
      if (text === undefined || text.length < minimum) return json(body);
      const finish = (error, data) => {
        if (res.headersSent) return;
        if (error) return json(body);
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Content-Encoding", encoding);
        res.setHeader("Content-Length", data.length);
        res.setHeader("Vary", "Accept-Encoding");
        res.end(data);
      };
      if (encoding === "br")
        zlib.brotliCompress(
          text,
          {
            params: {
              [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
              [zlib.constants.BROTLI_PARAM_SIZE_HINT]: text.length,
            },
          },
          finish,
        );
      else zlib.gzip(text, { level: 6 }, finish);
      return res;
    };
    next();
  };
}
