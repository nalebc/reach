// Connector logos stay local to Reach. Only public HTTPS destinations are
// contacted, and the address checked by DNS policy is the address connected.
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";

const TYPES = {
  "image/png": "png", "image/jpeg": "jpeg", "image/gif": "gif",
  "image/webp": "webp", "image/svg+xml": "svg+xml", "image/x-icon": "x-icon",
  "image/vnd.microsoft.icon": "x-icon",
};
const MAX_BYTES = 256 * 1024;
const MAX_DATA_URL_BYTES = Math.ceil(MAX_BYTES / 3) * 4 + 128;
const MAX_ACTIVE = 4;
const MAX_CACHE = 256;
const MISS_MS = 24 * 60 * 60 * 1000;

// Logo lookup does not need local, transitional, reserved or multicast IPs.
// In particular, rejecting non-global IPv6 also covers every spelling of
// IPv4-mapped/compatible addresses, including ::ffff:7f00:1.
export function privateAddress(address) {
  if (typeof address !== "string") return true;
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (!net.isIPv6(address) || address.includes("%")) return true;
  // URL's IPv6 serialization normalizes leading zeros and compression.
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const first = parseInt(normalized.split(":")[0], 16);
  if (!(first >= 0x2000 && first <= 0x3fff)) return true;
  // Teredo, 6to4 and documentation addresses are not direct public services.
  return /^2001:(?:0:|:|db8:)/.test(normalized) || normalized.startsWith("2002:");
}

export function iconAddresses(url) {
  let host;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password) return [];
    host = u.hostname;
  } catch { return []; }
  const site = host.replace(/^(mcp|api|app|www|server|gateway)\./, "");
  return [...new Set([`https://${site}/favicon.ico`, `https://${host}/favicon.ico`])];
}

export function createConnectorLogos({
  dir,
  request = https.request,
  lookup = (host) => dns.lookup(host, { all: true }),
  now = Date.now,
  timeoutMs = 5000,
}) {
  const memory = new Map(), misses = new Map(), inflight = new Map();
  const keep = (map, key, value) => {
    map.delete(key); map.set(key, value);
    if (map.size > MAX_CACHE) map.delete(map.keys().next().value);
  };
  const keyOf = (value) => crypto.createHash("sha256").update(value).digest("hex").slice(0, 32);
  const fileOf = (key) => path.join(dir, `${key}.txt`);
  const known = (key) => {
    if (memory.has(key)) return memory.get(key);
    try {
      const file = fileOf(key), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_DATA_URL_BYTES) return undefined;
      const value = fs.readFileSync(file, "utf8");
      if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml|x-icon);base64,[A-Za-z0-9+/]+=*$/.test(value)) {
        keep(memory, key, value); return value;
      }
    } catch {}
    return undefined;
  };

  // A separate, non-pooled connection for each hop. The lookup callback is
  // the socket's lookup: no second resolver may substitute a private IP.
  // HTTPS still verifies the certificate against the original URL hostname.
  function readHop(url, remaining) {
    return new Promise((resolve) => {
      let req, response, done = false;
      const finish = (value = null) => {
        if (done) return;
        done = true; clearTimeout(timer);
        response?.destroy(); req?.destroy();
        resolve(value);
      };
      const timer = setTimeout(finish, remaining);
      const pinnedLookup = (hostname, options, callback) => {
        Promise.resolve().then(() => lookup(hostname)).then((addresses) => {
          if (done) return;
          if (!Array.isArray(addresses) || !addresses.length || addresses.some((a) => privateAddress(a?.address)))
            return callback(new Error("Logo address refused."));
          const address = addresses[0].address, family = net.isIP(address);
          if (options?.all) callback(null, [{ address, family }]);
          else callback(null, address, family);
        }, () => { if (!done) callback(new Error("Logo lookup failed.")); });
      };
      try {
        req = request(url, {
          method: "GET", agent: false, lookup: pinnedLookup, autoSelectFamily: false,
          headers: { Accept: "image/*", "Accept-Encoding": "identity" },
        }, (res) => {
          response = res;
          if (done) { res.destroy(); return; }
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400 && typeof res.headers.location === "string")
            return finish({ redirect: res.headers.location });
          const type = String(res.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
          if (status < 200 || status >= 300 || !Object.hasOwn(TYPES, type) ||
              (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") ||
              Number(res.headers["content-length"]) > MAX_BYTES) return finish();
          let size = 0;
          const chunks = [];
          res.on("data", (chunk) => {
            if (done) return;
            size += chunk.length;
            if (size > MAX_BYTES) return finish();
            chunks.push(chunk);
          });
          res.once("error", () => finish());
          res.once("aborted", () => finish());
          res.once("end", () => finish(size ? { image: `data:image/${TYPES[type]};base64,${Buffer.concat(chunks, size).toString("base64")}` } : null));
          res.once("close", () => { if (!res.complete) finish(); });
        });
        req.once("error", () => finish());
        req.end();
      } catch { finish(); }
    });
  }
  async function image(url, deadline) {
    let target = url;
    for (let hop = 0; hop < 4; hop++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || target.length > 2048) return null;
      const u = new URL(target), hostname = u.hostname.replace(/^\[|\]$/g, "");
      if (u.protocol !== "https:" || u.username || u.password || !hostname ||
          (net.isIP(hostname) && privateAddress(hostname))) return null;
      const result = await readHop(u, remaining);
      if (result?.redirect) { target = new URL(result.redirect, u).href; continue; }
      return result?.image || null;
    }
    return null;
  }
  function logo(addresses) {
    const list = (Array.isArray(addresses) ? addresses : [addresses]).filter((a) => typeof a === "string" && a.startsWith("https://") && a.length <= 2048).slice(0, 4);
    if (!list.length) return Promise.resolve(null);
    const key = keyOf(list.join("|")), have = known(key);
    if (have !== undefined) return Promise.resolve(have);
    if (now() - (misses.get(key) ?? -Infinity) < MISS_MS) return Promise.resolve(null);
    if (inflight.has(key)) return inflight.get(key);
    // Excess work can be tried on a later listing; it is not a cached miss.
    if (inflight.size >= MAX_ACTIVE) return Promise.resolve(null);
    const deadline = Date.now() + timeoutMs;
    const work = (async () => {
      for (const address of list) {
        const found = await image(address, deadline).catch(() => null);
        if (found) {
          keep(memory, key, found);
          try {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            const count = fs.readdirSync(dir).filter((name) => /^[a-f0-9]{20,32}\.txt$/.test(name)).length;
            if (count < MAX_CACHE) fs.writeFileSync(fileOf(key), found, { mode: 0o600, flag: "wx" });
          } catch {}
          return found;
        }
      }
      keep(misses, key, now());
      return null;
    })().finally(() => inflight.delete(key));
    inflight.set(key, work);
    return work;
  }
  return {
    async many(requests, ms = 1500) {
      const out = new Map();
      let timer;
      try {
        await Promise.race([
          Promise.all(requests.slice(0, MAX_CACHE).map(async ([id, addresses]) => out.set(id, await logo(addresses)))),
          new Promise((resolve) => { timer = setTimeout(resolve, Math.max(0, Math.min(ms, timeoutMs))); }),
        ]);
      } finally { clearTimeout(timer); }
      return out;
    },
    logo,
  };
}
