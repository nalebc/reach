import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

export function privateFile(file) {
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536)
      throw Error("Secret must be a regular file smaller than 64 KiB.");
    if (
      process.platform !== "win32" &&
      (stat.mode & 0o077 || stat.uid !== process.getuid())
    )
      throw Error(
        "Secret files must belong to the current user and have permissions 0600 or 0400.",
      );
    return fs.readFileSync(fd, "utf8").trim();
  } finally {
    fs.closeSync(fd);
  }
}
export function reachOrigin(value, allowLocal = false) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/")
    throw Error("Use a Reach origin without a path, query, or credentials.");
  const local =
    allowLocal &&
    u.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(u.hostname);
  if (
    !local &&
    !(
      u.protocol === "https:" &&
      /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(u.hostname)
    )
  )
    throw Error(
      "Use the private HTTPS .ts.net link shown by Reach. Local testing requires --allow-local.",
    );
  return u;
}
export class TunnelAgent extends https.Agent {
  constructor(proxy) {
    super({ keepAlive: false });
    this.proxy = new URL(proxy);
    if (
      this.proxy.protocol !== "http:" ||
      !["127.0.0.1", "localhost"].includes(this.proxy.hostname) ||
      this.proxy.username ||
      this.proxy.password ||
      this.proxy.pathname !== "/" ||
      this.proxy.search ||
      this.proxy.hash
    )
      throw Error("REACH_PROXY must be a loopback HTTP proxy.");
  }
  createConnection(options, callback) {
    const req = http.request(this.proxy, {
      method: "CONNECT",
      path: `${options.host}:${options.port}`,
      headers: { Host: `${options.host}:${options.port}` },
    });
    let finished = false;
    const done = (error, socket) => {
      if (!finished) {
        finished = true;
        callback(error, socket);
      }
    };
    req.setTimeout(15000, () =>
      req.destroy(Error("Tailscale proxy timed out.")),
    );
    req.on("error", (e) => done(e));
    req.on("connect", (response, socket, head) => {
      if (response.statusCode !== 200 || head.length) {
        socket.destroy();
        done(Error("Tailscale proxy rejected the connection."));
        return;
      }
      const secure = tls.connect({
        socket,
        servername: options.host,
        rejectUnauthorized: true,
      });
      secure.setTimeout(15000, () =>
        secure.destroy(Error("TLS handshake timed out.")),
      );
      secure.once("secureConnect", () => {
        secure.setTimeout(0);
        done(null, secure);
      });
      secure.on("error", (e) => done(e));
    });
    req.end();
  }
}
export function createAgentClient(
  credential,
  { allowLocal = false, proxy = process.env.REACH_PROXY } = {},
) {
  const origin = reachOrigin(credential.url, allowLocal);
  if (
    typeof credential.token !== "string" ||
    !/^[A-Za-z0-9_-]{20,256}$/.test(credential.token)
  )
    throw Error("Invalid Reach credential.");
  if (credential.expiresAt && Date.now() >= credential.expiresAt)
    throw Error("Reach credential expired. Ask the Mac owner for a new grant.");
  if (proxy && origin.protocol !== "https:")
    throw Error("Proxy connections require HTTPS.");
  const agent = proxy ? new TunnelAgent(proxy) : undefined;
  return (route, method = "GET", body, contentType = "application/json") =>
    new Promise((resolve, reject) => {
      if (!route.startsWith("/api/") || route.startsWith("//")) {
        reject(Error("Invalid API route."));
        return;
      }
      const data =
        body === undefined
          ? undefined
          : Buffer.isBuffer(body)
            ? body
            : JSON.stringify(body);
      const req = (origin.protocol === "https:" ? https : http).request(
        new URL(route, origin),
        {
          agent,
          method,
          rejectUnauthorized: true,
          headers: {
            Authorization: `Bearer ${credential.token}`,
            "Content-Type": contentType,
            ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
          },
        },
        (res) => {
          const chunks = [];
          // Only the named browser screen route may return a binary image.
          const screenImage = (route === "/api/browser/screen" || /^\/api\/browser\/apps\/screen\?target=[A-Za-z0-9_-]{1,128}$/.test(route)) && method === "GET" && body === undefined && res.statusCode >= 200 && res.statusCode < 300;
          const responseLimit = (screenImage ? 8 : 2) * 1024 * 1024;
          let size = 0;
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > responseLimit)
              res.destroy(Error(`Reach response exceeds ${screenImage ? 8 : 2} MiB.`));
            else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            if (res.statusCode >= 300 && res.statusCode < 400) {
              reject(Error("Reach redirects are refused."));
              return;
            }
            try {
              if (screenImage) {
                const mimeType = String(res.headers["content-type"] || "").split(";")[0].trim();
                if (!["image/jpeg", "image/png"].includes(mimeType)) throw Error("Reach returned an unsupported screen image.");
                resolve({ image: Buffer.concat(chunks).toString("base64"), mimeType });
                return;
              }
              const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              if (res.statusCode < 200 || res.statusCode >= 300)
                throw Error(
                  result.error || `Reach returned HTTP ${res.statusCode}.`,
                );
              resolve(result);
            } catch (e) {
              reject(e);
            }
          });
        },
      );
      const deadline = setTimeout(
        () =>
          req.destroy(
            Error(
              "Reach request timed out. Mutating operations are not retried.",
            ),
          ),
        35000,
      );
      req.on("close", () => clearTimeout(deadline));
      req.on("error", reject);
      req.end(data);
    });
}
