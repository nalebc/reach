import http from "node:http";
import crypto from "node:crypto";
import { Readable } from "node:stream";

// Tools for proving a file crosses between phone and computer byte for byte:
// an XMLHttpRequest over Node's own HTTP (jsdom's would garble a Node Blob,
// so a mismatch could never be told apart from Reach's), and a proxy that
// cuts, half-opens or drops a chosen request the way a phone's network does.

export const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");

// Deterministic bytes at any offset (AES-CTR keystream), so a file of any
// size can be sent and checked without ever existing whole on disk.
export function seeded(seed, size) {
  const key = crypto.createHash("sha256").update(String(seed)).digest();
  const at = (offset, length) => {
    const block = Math.floor(offset / 16);
    const iv = Buffer.alloc(16);
    iv.writeBigUInt64BE(BigInt(block), 8);
    const cipher = crypto.createCipheriv("aes-256-ctr", key, iv);
    const skip = offset - block * 16;
    return cipher.update(Buffer.alloc(skip + length)).subarray(skip);
  };
  return {
    size,
    at,
    // A File-shaped source for uploadFiles: only the slice being sent is in memory.
    file(name) {
      return {
        name,
        size,
        slice: (start = 0, end = size) =>
          new Blob([at(start, Math.max(0, Math.min(end, size) - start))]),
      };
    },
    async hash(step = 64 * 1024 * 1024) {
      const h = crypto.createHash("sha256");
      for (let o = 0; o < size; o += step) h.update(at(o, Math.min(step, size - o)));
      return h.digest("hex");
    },
  };
}

// What the browser gives transfers.ts, over a fresh connection each time.
export class NodeXHR {
  upload = {};
  status = 0;
  responseText = "";
  onload = null;
  onerror = null;
  onabort = null;
  #method = "GET";
  #url = "";
  #headers = {};
  #request = null;
  #settled = false;
  open(method, url) {
    this.#method = method;
    this.#url = url;
  }
  setRequestHeader(name, value) {
    this.#headers[name] = value;
  }
  #end(handler) {
    if (this.#settled) return;
    this.#settled = true;
    handler?.call(this);
  }
  async send(body) {
    const headers = { ...this.#headers };
    let source;
    let length = 0;
    if (body instanceof FormData) {
      const encoded = new Request("http://form.invalid/", { method: "POST", body });
      headers["Content-Type"] = encoded.headers.get("content-type");
      const bytes = Buffer.from(await encoded.arrayBuffer());
      source = Readable.from([bytes]);
      length = bytes.length;
    } else {
      length = body?.size ?? 0;
      source = body ? Readable.fromWeb(body.stream()) : Readable.from([]);
    }
    if (this.#settled) return;
    headers["Content-Length"] = String(length);
    const request = http.request(this.#url, {
      method: this.#method,
      headers,
      agent: false,
    });
    this.#request = request;
    let loaded = 0;
    source.on("data", (chunk) => {
      loaded += chunk.length;
      this.upload.onprogress?.({ loaded, total: length, lengthComputable: true });
    });
    source.on("error", () => request.destroy());
    source.pipe(request);
    request.on("response", (response) => {
      const parts = [];
      response.on("data", (chunk) => parts.push(chunk));
      response.on("end", () => {
        this.status = response.statusCode;
        this.responseText = Buffer.concat(parts).toString("utf8");
        this.#end(this.onload);
      });
      response.on("error", () => this.#end(this.onerror));
      response.on("aborted", () => this.#end(this.onerror));
    });
    request.on("error", () => this.#end(this.onerror));
    request.on("close", () => {
      if (!request.res) this.#end(this.onerror);
    });
  }
  abort() {
    if (this.#settled) return;
    this.#request?.destroy();
    this.#end(this.onabort);
  }
}

// The page's own tailnet node (tailnet/main.go) as src/tailnet-transport.ts
// drives it: bodies cross as one Uint8Array, answers come back 256 KiB per
// read. Like Go's net/http, a body cut short by a closed connection reads as
// a clean end (io.ErrUnexpectedEOF is treated as EOF there).
export function goTailnetNode() {
  return {
    fetch({ url, method, headers, body }) {
      const controller = new AbortController();
      const response = new Promise((resolve, reject) => {
        const head = {};
        for (let i = 0; i + 1 < headers.length; i += 2) head[headers[i]] = headers[i + 1];
        const request = http.request(url, {
          method,
          headers: { ...head, "content-length": String(body?.byteLength ?? 0) },
          agent: false,
          signal: controller.signal,
        });
        request.on("error", reject);
        request.on("response", (res) => {
          const pairs = [];
          for (const [k, v] of Object.entries(res.headers))
            for (const value of [].concat(v)) pairs.push(k, value);
          const chunks = res[Symbol.asyncIterator]();
          let pending = Buffer.alloc(0);
          const read = async () => {
            if (pending.length) {
              const out = pending.subarray(0, 256 * 1024);
              pending = pending.subarray(out.length);
              return new Uint8Array(out);
            }
            try {
              const { value, done } = await chunks.next();
              if (done) return null;
              pending = value;
              return read();
            } catch {
              return null;
            }
          };
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: pairs,
            read,
            cancel: () => res.destroy(),
          });
        });
        request.end(body ? Buffer.from(body) : undefined);
      });
      response.catch(() => {});
      return { response, abort: () => controller.abort() };
    },
  };
}

// An HTTP proxy in front of a Reach server. `next(match, fault)` arms one
// fault for the next matching request it can act on (one too short to cut
// passes untouched and leaves it armed); `pending()` counts those not yet done:
//   { cutRequestAfter: n, then }      n body bytes go up, then both sides drop
//   { cutRequestAfter: n, half: true } the phone's side drops, the computer's
//                                     stays open and silent (Wi-Fi to cellular)
//   { dropResponse: true }            the computer answers, the phone never hears
//   { cutResponseAfter: n, then }     n response bytes arrive, then the line drops
//   { answer: [status, body] }        answered here, never reaching the computer
//   { drop: true }                    the line drops before the computer hears it
export async function faultProxy(upstream) {
  const target = { port: upstream };
  const armed = [];
  const claimed = new Set();
  const held = new Set();
  const seen = [];
  const server = http.createServer((req, res) => {
    const index = armed.findIndex((rule) => rule.match(req));
    let rule = index >= 0 ? armed.splice(index, 1)[0] : null;
    const fault = rule?.fault || {};
    const fired = () => {
      if (rule) rule.fired = true;
    };
    const settle = () => {
      if (!rule) return;
      claimed.delete(rule);
      if (!rule.fired) armed.splice(Math.min(index, armed.length), 0, rule);
      rule = null;
    };
    if (rule) claimed.add(rule);
    res.on("finish", settle);
    res.on("close", settle);
    seen.push({
      route: `${req.method} ${req.url.split("?")[0]}`,
      url: req.url,
      range: req.headers.range,
      faulted: index >= 0,
    });
    if (fault.drop) {
      fired();
      req.socket.destroy();
      return;
    }
    if (fault.answer) {
      fired();
      req.resume();
      const [status, body] = fault.answer;
      res.writeHead(status, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(body));
    }
    const up = http.request({
      host: "127.0.0.1",
      port: target.port,
      method: req.method,
      path: req.url,
      headers: req.headers,
      agent: false,
    });
    const dropPhone = () => {
      req.socket.destroy();
      res.socket?.destroy();
    };
    up.on("error", () => dropPhone());
    let sent = 0;
    let cut = false;
    req.on("data", (chunk) => {
      if (cut) return;
      if (fault.cutRequestAfter === undefined) return void up.write(chunk);
      const room = fault.cutRequestAfter - sent;
      sent += chunk.length;
      if (room > 0) up.write(chunk.subarray(0, room));
      if (sent < fault.cutRequestAfter) return;
      cut = true;
      fired();
      // Let what went up reach the computer before the line drops.
      setTimeout(async () => {
        dropPhone();
        if (fault.half) held.add(up);
        else up.destroy();
        await fault.then?.();
      }, 50);
    });
    req.on("end", () => {
      if (!cut) up.end();
    });
    req.on("error", () => {});
    up.on("response", (response) => {
      if (fault.dropResponse) {
        fired();
        response.resume();
        response.on("end", () => dropPhone());
        return;
      }
      res.writeHead(response.statusCode, response.headers);
      if (fault.cutResponseAfter === undefined) return void response.pipe(res);
      let delivered = 0;
      let stopped = false;
      response.on("data", (chunk) => {
        if (stopped) return;
        const room = fault.cutResponseAfter - delivered;
        delivered += chunk.length;
        if (room > 0) res.write(chunk.subarray(0, room));
        if (delivered < fault.cutResponseAfter) return;
        stopped = true;
        fired();
        response.destroy();
        up.destroy();
        setTimeout(async () => {
          dropPhone();
          await fault.then?.();
        }, 20);
      });
      response.on("end", () => {
        if (!stopped) res.end();
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    retarget(port) {
      target.port = port;
    },
    next(match, fault) {
      const test =
        typeof match === "function"
          ? match
          : (req) => `${req.method} ${req.url.split("?")[0]}`.match(match);
      armed.push({ match: test, fault });
    },
    pending: () => armed.length + claimed.size,
    // The silent connections a half-open drop left behind.
    held: () => held,
    async close() {
      for (const up of held) up.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
