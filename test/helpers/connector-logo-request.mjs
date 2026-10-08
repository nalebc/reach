import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import net from "node:net";

// Implements only the HTTPS request contract used by the logo fetcher. It
// opens no sockets: the tested lookup must permit an address before a
// response exists, and destroying a response stops its stream.
export function logoRequests(handler) {
  const calls = [], connected = [], responses = [];
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    calls.push({ url: url.href, options, req });
    req.end = () => queueMicrotask(() => {
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      const ready = (error, address, family) => {
        if (req.destroyed) return;
        if (error) { req.emit("error", error); return; }
        connected.push({ url: url.href, address, family });
        const spec = handler(url, options) || {};
        const res = spec.hold ? new Readable({ read() {} }) : Readable.from(spec.chunks || [Buffer.from("image")]);
        res.statusCode = spec.status || 200;
        res.headers = spec.headers || { "content-type": "image/png" };
        res.complete = false;
        res.once("end", () => { res.complete = true; });
        responses.push(res);
        callback(res);
      };
      if (net.isIP(hostname)) ready(null, hostname, net.isIP(hostname));
      else options.lookup(hostname, { all: false }, ready);
    });
    return req;
  };
  return { request, calls, connected, responses };
}
