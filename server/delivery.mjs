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
  app.get("/agent-browser", (req, res) =>
    res.sendFile(path.join(dist, "agent.html"), { headers: { "Cache-Control": "no-store" } }),
  );
  const exists = new Map();
  const has = (file) => {
    if (!exists.has(file)) exists.set(file, fs.existsSync(file));
    return exists.get(file);
  };
  app.use("/assets", (req, res, next) => {
    if (!["GET", "HEAD"].includes(req.method) || !/^\/[\w.-]+$/.test(req.path))
      return next();
    const file = path.join(dist, "assets", req.path.slice(1));
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
        return res.sendFile(file + ext, { cacheControl: false });
      }
    res.sendFile(file, { cacheControl: false });
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
  app.use((req, res) =>
    res.sendFile(page, { headers: { "Cache-Control": "no-cache" } }),
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
