import http from "node:http";
import net from "node:net";

const address = value => typeof value === "string" && net.isIP(value) ? value : undefined;
const port = value => Number.isInteger(value) && value > 0 && value <= 65535 ? value : undefined;
const code = value => typeof value === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value) ? value : undefined;
const pathOnly = value => {
  try { return new URL(String(value), "http://isolated.test").pathname.slice(0, 256); }
  catch { return "invalid path"; }
};

// The disposable simulator's loopback proxy only. No retry is made: a
// failed reply to an already delivered write remains an unknown result.
export function createIosProxyForwarder(upstream, { now = Date.now, started = now(), maxErrors = 32 } = {}) {
  const origin = new URL(upstream);
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname))
    throw Error("The iOS smoke proxy requires its isolated loopback companion.");
  const errors = [];
  let droppedErrors = 0;
  return {
    forward(req, res) {
      const headers = { ...req.headers, host: origin.host };
      if (headers.origin) headers.origin = upstream;
      let connection = {};
      // The test proxy adds a hop that real owner/private asset delivery
      // does not have. Avoid global-agent reuse of a socket whose idle close
      // has not reached this process yet; do not retry any request.
      const forwarded = http.request(upstream + req.url, { method: req.method, headers, agent: false }, response => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      forwarded.once("socket", socket => {
        const connected = () => {
          connection = { localAddress: address(socket.localAddress), localPort: port(socket.localPort),
            remoteAddress: address(socket.remoteAddress), remotePort: port(socket.remotePort) };
        };
        if (socket.connecting) socket.once("connect", connected); else connected();
      });
      forwarded.on("error", error => {
        if (errors.length < maxErrors) errors.push({ path: pathOnly(req.url), method: code(req.method),
          seconds: Math.max(0, Math.round((now() - started) / 100) / 10),
          code: code(error.code), syscall: code(error.syscall), reusedSocket: forwarded.reusedSocket,
          address: address(error.address), port: port(error.port), ...connection });
        else droppedErrors++;
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(forwarded);
      return forwarded;
    },
    snapshot() { return structuredClone({ errors, droppedErrors }); },
  };
}
