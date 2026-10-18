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
export function createIosProxyForwarder(upstream, { now = Date.now, started = now(), maxErrors = 32, maxRequests = 128 } = {}) {
  const origin = new URL(upstream);
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname))
    throw Error("The iOS smoke proxy requires its isolated loopback companion.");
  const errors = [], requests = [];
  let droppedErrors = 0, droppedRequests = 0;
  const seconds = () => Math.max(0, Math.round((now() - started) / 100) / 10);
  return {
    forward(req, res) {
      // Observe this synthetic proxy hop only, never headers/body contents. A
      // closed client reply does not say whether its one-use pairing reached
      // the companion. Keep both sides' milestones without replaying it.
      const item = requests.length < maxRequests ? {
        path: pathOnly(req.url), method: code(req.method), seconds: seconds(),
        requestBodyBytes: 0, upstreamResponseBytes: 0,
      } : null;
      if (item) requests.push(item); else droppedRequests++;
      const note = (field, value = seconds()) => { if (item) item[field] = value; };
      const bodyBytes = chunk => { if (item) item.requestBodyBytes += Buffer.byteLength(chunk); };
      req.once("end", () => { note("requestBodyEndSeconds"); note("requestComplete", req.complete); });
      req.once("aborted", () => note("requestAbortedSeconds"));
      req.once("close", () => { note("requestCloseSeconds"); note("requestComplete", req.complete); });
      res.once("finish", () => { note("clientFinishSeconds"); note("clientStatus", res.statusCode); });
      res.once("close", () => { note("clientCloseSeconds"); note("clientWritableFinished", res.writableFinished); });
      const headers = { ...req.headers, host: origin.host };
      if (headers.origin) headers.origin = upstream;
      let connection = {};
      // The test proxy adds a hop that real owner/private asset delivery
      // does not have. Avoid global-agent reuse of a socket whose idle close
      // has not reached this process yet; do not retry any request.
      const forwarded = http.request(upstream + req.url, { method: req.method, headers, agent: false }, response => {
        note("upstreamHeadersSeconds"); note("upstreamStatus", response.statusCode);
        const responseBytes = chunk => { if (item) item.upstreamResponseBytes += Buffer.byteLength(chunk); };
        const observingBody = !!item && !res.destroyed;
        note("upstreamBodyObserved", observingBody);
        if (observingBody) response.on("data", responseBytes);
        // A byte observer must not keep draining after the original pipe's
        // destination closes: preserve its original pause/backpressure.
        res.once("close", () => {
          response.removeListener("data", responseBytes);
          if (observingBody && !response.readableEnded) note("upstreamByteObservationStoppedSeconds");
        });
        response.once("end", () => { note("upstreamResponseEndSeconds"); note("upstreamResponseComplete", response.complete); });
        response.once("aborted", () => note("upstreamResponseAbortedSeconds"));
        response.once("close", () => { note("upstreamResponseCloseSeconds"); note("upstreamResponseComplete", response.complete); });
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      });
      forwarded.once("finish", () => note("upstreamRequestFinishSeconds"));
      forwarded.once("close", () => {
        note("upstreamRequestCloseSeconds");
        req.removeListener("data", bodyBytes);
      });
      forwarded.once("socket", socket => {
        const connected = () => {
          connection = { localAddress: address(socket.localAddress), localPort: port(socket.localPort),
            remoteAddress: address(socket.remoteAddress), remotePort: port(socket.remotePort) };
        };
        if (socket.connecting) socket.once("connect", connected); else connected();
      });
      forwarded.on("error", error => {
        note("upstreamErrorSeconds");
        if (code(error.code)) note("upstreamErrorCode", code(error.code));
        if (errors.length < maxErrors) errors.push({ path: pathOnly(req.url), method: code(req.method),
          seconds: seconds(),
          code: code(error.code), syscall: code(error.syscall), reusedSocket: forwarded.reusedSocket,
          address: address(error.address), port: port(error.port), ...connection });
        else droppedErrors++;
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      if (item) req.on("data", bodyBytes);
      req.pipe(forwarded);
      return forwarded;
    },
    snapshot() { return structuredClone({ errors, droppedErrors, requests, droppedRequests }); },
  };
}
