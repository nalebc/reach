// Reach's side of its browser extension (docs/parity/G-browser-tools.md): on
// Windows, agents' saved tools reach Chrome and Edge through Reach's
// extension, as they reach Chrome and Safari through Apple Events on a Mac.
//
// The extension's native host (scripts/native/browser-host.cs) connects to
// this pipe and relays native messaging frames (4-byte little-endian length,
// UTF-8 JSON) both ways. Nothing is run before both sides prove the secret
// the owner approved for that browser (HMAC-SHA256 over both nonces). A
// browser without one asks to connect; the owner's tap in Reach pairs it.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { atomicJson } from "./core.mjs";
import { extensionIds, extensionOrigin } from "./browser-extension-ids.mjs";

export const EXTENSION_BROWSERS = ["Chrome", "Edge"];
const LABEL = "reach.browser.v1";
const MAX_FRAME = 32 * 1024 * 1024;
// Toward the browser a native message is at most 1 MB: bigger ones (an 8 MB
// attachment) go in base64 pieces the extension puts back together.
const CHUNK = 512 * 1024;
const PENDING_PAIRINGS = 4;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The pipe Reach serves for this data folder (one Reach per PC, tests apart). */
export function extensionPipe(dataDir, platform = process.platform) {
  const hash = crypto.createHash("sha256").update(path.resolve(dataDir)).digest("hex").slice(0, 16);
  return platform === "win32" ? `\\\\.\\pipe\\reach-browser-tools-${hash}` : path.join(dataDir, `browser-tools-${hash}.sock`);
}
export const pipeShortName = (pipe) => pipe.replace(/^\\\\[.?]\\pipe\\/i, "");

export function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}
/** Splits a byte stream into native messaging frames; null on a malformed one. */
export function frameReader(onMessage, { max = MAX_FRAME } = {}) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    for (;;) {
      if (pending.length < 4) return true;
      const size = pending.readUInt32LE(0);
      if (size > max) return false;
      if (pending.length < 4 + size) return true;
      const body = pending.subarray(4, 4 + size);
      pending = pending.subarray(4 + size);
      let message;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        return false;
      }
      onMessage(message);
    }
  };
}
// The messages toward the extension, each under the browser's limit.
export function outgoing(message, { id = crypto.randomUUID(), chunk = CHUNK } = {}) {
  const text = JSON.stringify(message);
  if (Buffer.byteLength(text, "utf8") <= chunk) return [message];
  const data = Buffer.from(text, "utf8").toString("base64");
  const count = Math.ceil(data.length / chunk);
  return Array.from({ length: count }, (_, index) => ({ type: "chunk", id, index, count, data: data.slice(index * chunk, (index + 1) * chunk) }));
}
const proof = (secret, ...parts) => crypto.createHmac("sha256", Buffer.from(secret, "hex")).update([LABEL, ...parts].join("|")).digest("hex");
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
// Reach's own fixed answers, in the shape the extension and JXA use.
const raw = (error, code, uncertain = false) => JSON.stringify({ error, code, uncertain });
const problem = (code, uncertain = false) => Object.assign(Error(code), { code, uncertain });

export function createBrowserExtensionBridge({
  dataDir,
  pipe = extensionPipe(dataDir),
  ids = extensionIds(),
  onPairingRequest = () => {},
  now = Date.now,
  randomBytes = crypto.randomBytes,
  // How long a run waits for a browser Reach just found closed to come back
  // (the agent's tool starts it), and for a request's answer.
  reconnectMs = 15000,
  closedWaitMs = 1500,
} = {}) {
  const origins = new Set(ids.map(extensionOrigin));
  const storeFile = path.join(dataDir, "browser-extension.json");
  let pairings = [];
  try {
    const data = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    if (Array.isArray(data))
      pairings = data.filter((entry) => entry && UUID.test(entry.installId) && EXTENSION_BROWSERS.includes(entry.browser) && HEX64.test(entry.secret));
  } catch {
    /* none yet, or unreadable: every browser asks again */
  }
  const save = () => atomicJson(storeFile, pairings);
  const connections = new Set();
  // Browsers asking to connect, by install: shown to the owner, never trusted.
  const asking = new Map();
  const windows = new Map();
  const closedAt = new Map();
  const waiters = new Set();
  let server = null, closed = false, sequence = 0;

  const nonce = () => randomBytes(32).toString("hex");
  const trusted = (browser) => [...connections].filter((c) => c.trusted && c.browser === browser);
  const wake = () => {
    for (const waiter of waiters) waiter();
  };

  function accept(socket) {
    if (closed || connections.size >= 32) return socket.destroy();
    const conn = { socket, origin: null, installId: null, browser: null, trusted: false, reachNonce: null, pending: new Map(), focusAt: 0, at: now() };
    connections.add(conn);
    const send = (message) => {
      if (socket.destroyed) return;
      for (const part of outgoing(message)) socket.write(frame(part));
    };
    conn.send = send;
    const drop = () => {
      if (!connections.delete(conn)) return;
      for (const [id, entry] of asking) if (entry.conn === conn) asking.delete(id);
      for (const [window, owner] of windows) if (owner === conn) windows.delete(window);
      for (const request of conn.pending.values()) request.reject(problem("uncertain", true));
      conn.pending.clear();
      socket.destroy();
      wake();
    };
    conn.drop = drop;
    const challenge = () => {
      conn.reachNonce = nonce();
      send({ type: "challenge", nonce: conn.reachNonce });
    };
    const read = frameReader((message) => {
      if (!message || typeof message !== "object" || Array.isArray(message)) return drop();
      if (!conn.origin) {
        // The host's own first frame: which extension Chrome or Edge started it for.
        if (message.type !== "host" || !origins.has(message.origin)) return drop();
        conn.origin = message.origin;
        return challenge();
      }
      if (message.type === "hello") {
        if (!UUID.test(message.installId || "") || !EXTENSION_BROWSERS.includes(message.browser) || !HEX64.test(message.nonce || "") || !conn.reachNonce) return drop();
        if (conn.installId && conn.installId !== message.installId) return drop();
        conn.installId = message.installId;
        conn.browser = message.browser;
        conn.trusted = false;
        const pairing = pairings.find((entry) => entry.installId === message.installId);
        if (message.proof !== undefined) {
          if (!pairing || pairing.browser !== message.browser) {
            // A secret Reach doesn't know (or for another browser): the
            // extension forgets it and asks the owner again, on a new nonce.
            conn.reachNonce = nonce();
            return send({ type: "unknown", nonce: conn.reachNonce });
          }
          const expected = proof(pairing.secret, "extension", conn.reachNonce, message.nonce, message.installId);
          if (!same(expected, message.proof)) return drop();
          const reachNonce = conn.reachNonce;
          // Each challenge answers once.
          conn.reachNonce = null;
          conn.trusted = true;
          asking.delete(message.installId);
          closedAt.delete(conn.browser);
          send({ type: "ready", proof: proof(pairing.secret, "reach", message.nonce, reachNonce, message.installId) });
          wake();
          return;
        }
        if (message.pair !== true) return drop();
        if (pairing) {
          // It lost its secret: pairing again needs the owner again.
          pairings = pairings.filter((entry) => entry !== pairing);
          save();
        }
        if (!asking.has(message.installId) && asking.size >= PENDING_PAIRINGS) return drop();
        asking.set(message.installId, { browser: message.browser, conn, at: now() });
        try {
          onPairingRequest(message.browser);
        } catch {
          /* the setup row shows it anyway */
        }
        return;
      }
      if (!conn.trusted) return drop();
      if (message.type === "focus") {
        conn.focusAt = now();
        return;
      }
      if (message.type === "response" && typeof message.id === "string" && typeof message.raw === "string") {
        const request = conn.pending.get(message.id);
        if (!request) return;
        conn.pending.delete(message.id);
        request.resolve(message.raw);
        return;
      }
      drop();
    });
    socket.on("data", (chunk) => {
      if (!read(chunk)) drop();
    });
    socket.on("error", drop);
    socket.on("close", drop);
  }

  function send(conn, request, { timeoutMs = 12000, signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(problem("cancelled", true));
      const id = `${++sequence}-${crypto.randomUUID()}`;
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        conn.pending.delete(id);
      };
      const abort = () => {
        finish();
        conn.send({ type: "cancel", id });
        reject(problem("cancelled", true));
      };
      const timer = setTimeout(() => {
        finish();
        conn.send({ type: "cancel", id });
        reject(problem("uncertain", true));
      }, Math.max(1, timeoutMs));
      signal?.addEventListener("abort", abort, { once: true });
      conn.pending.set(id, {
        resolve: (value) => { finish(); resolve(value); },
        reject: (error) => { finish(); reject(error); },
      });
      conn.send({ type: "request", id, request });
    });
  }
  const waitFor = (browser, ms, signal) => new Promise((resolve) => {
    if (trusted(browser).length || ms <= 0) return resolve(trusted(browser));
    const done = () => {
      clearTimeout(timer);
      waiters.delete(check);
      signal?.removeEventListener("abort", done);
      resolve(trusted(browser));
    };
    const check = () => {
      if (trusted(browser).length) done();
    };
    const timer = setTimeout(done, ms);
    waiters.add(check);
    signal?.addEventListener("abort", done, { once: true });
  });
  async function live(browser, signal) {
    let list = trusted(browser);
    if (list.length) return list;
    // Allowed before but not connected now: the browser is closed, or just
    // opened and its extension still connecting.
    if (pairings.some((entry) => entry.browser === browser)) {
      const recent = closedAt.has(browser) && now() - closedAt.get(browser) < 60000;
      list = await waitFor(browser, recent ? reconnectMs : closedWaitMs, signal);
      if (list.length) return list;
      closedAt.set(browser, now());
      throw problem("browser_closed");
    }
    throw problem("setup_required");
  }
  const front = (list) => list.reduce((best, conn) => (conn.focusAt > best.focusAt || (conn.focusAt === best.focusAt && conn.at < best.at) ? conn : best));
  async function owner(browser, window, options) {
    const list = await live(browser, options.signal);
    const known = windows.get(window);
    if (known && list.includes(known)) return known;
    await tabs(browser, list, options);
    return windows.get(window) || null;
  }
  async function tabs(browser, list, options) {
    const all = [];
    for (const conn of list) {
      const answer = JSON.parse(await send(conn, { op: "tabs" }, options));
      if (!Array.isArray(answer)) return answer;
      for (const tab of answer) {
        windows.set(tab.window, conn);
        all.push(tab);
      }
    }
    return all;
  }
  return {
    pipe,
    async start({ listen = (handler) => net.createServer(handler) } = {}) {
      if (server) return server;
      if (process.platform !== "win32") fs.rmSync(pipe, { force: true });
      server = listen(accept);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(pipe, () => {
          server.off("error", reject);
          resolve();
        });
      });
      server.on("error", () => {});
      return server;
    },
    close() {
      closed = true;
      for (const conn of [...connections]) conn.drop();
      server?.close();
      server = null;
    },
    /** Raw JSON answer (as JXA prints it) from the browser's extension; throws {code, uncertain}. */
    async request(browser, request, options = {}) {
      if (closed) throw problem("cancelled");
      if (!EXTENSION_BROWSERS.includes(browser)) return raw("Choose Chrome or Edge.", "invalid");
      const { op } = request;
      if (op === "tabs") return JSON.stringify(await tabs(browser, await live(browser, options.signal), options));
      if (op === "create" || (op === "preflight" && request.window === undefined))
        return send(front(await live(browser, options.signal)), request, options);
      const window = op === "preflight" ? request.window : request.target?.window;
      if (!Number.isInteger(window)) return raw("The target browser window is gone.", "browser_changed");
      const conn = await owner(browser, window, options);
      if (!conn) return raw("The target browser window is gone.", "browser_changed");
      return send(conn, request, options);
    },
    /** Each browser: connected (proven), asking (waits for the owner), allowed before. */
    status() {
      return Object.fromEntries(EXTENSION_BROWSERS.map((browser) => [browser, {
        connected: trusted(browser).length > 0,
        asking: [...asking.values()].some((entry) => entry.browser === browser),
        paired: pairings.some((entry) => entry.browser === browser),
      }]));
    },
    /** The owner's tap: every browser of this kind asking now is allowed. */
    approve(browser) {
      const waiting = [...asking].filter(([, entry]) => entry.browser === browser);
      for (const [installId, entry] of waiting) {
        asking.delete(installId);
        if (!connections.has(entry.conn)) continue;
        const secret = randomBytes(32).toString("hex");
        pairings = [...pairings.filter((item) => item.installId !== installId), { installId, browser, secret, pairedAt: now() }];
        save();
        entry.conn.reachNonce = nonce();
        entry.conn.send({ type: "paired", secret, nonce: entry.conn.reachNonce });
      }
      return waiting.length;
    },
    /** Forget a browser: its secrets go, and it asks the owner again. */
    forget(browser) {
      pairings = pairings.filter((entry) => entry.browser !== browser);
      save();
      for (const conn of [...connections]) if (conn.browser === browser) conn.drop();
    },
    // For tests: the connection count.
    connections: () => connections.size,
  };
}
