import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const accepts = (req, encoding) =>
  new RegExp(`(?:^|[\\s,])${encoding}(?:[\\s,;]|$)`).test(
    String(req.headers["accept-encoding"] || ""),
  );

// The built interface. Files under /assets carry a content hash in their name,
// so they never change: cache them for a year and serve the copy precompressed
// at build time. The page itself is revalidated on every open.
export function serveBuild(app, express, dist) {
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
  const exists = new Map();
  const has = (file) => {
    if (!exists.has(file)) exists.set(file, fs.existsSync(file));
    return exists.get(file);
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
