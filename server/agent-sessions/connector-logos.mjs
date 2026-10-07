// Logos for connectors Reach doesn't ship a mark for (src/brand-marks.ts):
// a ChatGPT app's own logo (Codex's app list names it) or a server's site
// icon. Fetched once by the computer, never by the phone (its pages show
// only images of their own, data: ones included), and kept in Reach's data
// folder. Only https, only public addresses (never this computer, the
// tailnet or a home network: a connector's address is the person's to type,
// and Reach mustn't become a way to look inside a network), only small
// images. Anything else: no logo, and the phone shows the name's letter.
import crypto from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const TYPES = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg+xml",
  "image/x-icon": "x-icon",
  "image/vnd.microsoft.icon": "x-icon",
};
const MAX_BYTES = 256 * 1024;
const MISS_MS = 24 * 60 * 60 * 1000;

// Addresses that aren't the public internet.
export function privateAddress(address) {
  const v4 = net.isIPv4(address) ? address : address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  if (v4) {
    const [a, b] = v4.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || // CGNAT, Tailscale
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  const v6 = address.toLowerCase();
  return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith("fd7a:115c:a1e0");
}

// Where a server's site keeps its icon: the host, and the site under an
// mcp./api. host (mcp.linear.app → linear.app).
export function iconAddresses(url) {
  let host;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return [];
    host = u.hostname;
  } catch {
    return [];
  }
  const site = host.replace(/^(mcp|api|app|www|server|gateway)\./, "");
  return [...new Set([`https://${site}/favicon.ico`, `https://${host}/favicon.ico`])];
}

export function createConnectorLogos({
  dir,
  fetch: get = globalThis.fetch,
  lookup = (host) => dns.lookup(host, { all: true }),
  now = Date.now,
  timeoutMs = 5000,
}) {
  const memory = new Map(); // key -> data URL or null
  const misses = new Map(); // key -> when it failed
  const inflight = new Map();
  const keyOf = (value) => crypto.createHash("sha1").update(value).digest("hex").slice(0, 20);
  const fileOf = (key) => path.join(dir, `${key}.txt`);
  const known = (key) => {
    if (memory.has(key)) return memory.get(key);
    try {
      const value = fs.readFileSync(fileOf(key), "utf8");
      if (value.startsWith("data:image/")) {
        memory.set(key, value);
        return value;
      }
    } catch {}
    return undefined;
  };
  // One image, from public https addresses only (each redirect checked).
  async function image(url) {
    let target = url;
    for (let hop = 0; hop < 4; hop++) {
      const u = new URL(target);
      if (u.protocol !== "https:" || u.username || u.password) return null;
      const addresses = await lookup(u.hostname).catch(() => []);
      if (!addresses.length || addresses.some((a) => privateAddress(a.address))) return null;
      const res = await get(target, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        target = new URL(res.headers.get("location"), target).href;
        continue;
      }
      if (!res.ok) return null;
      const type = String(res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!TYPES[type]) return null;
      if (Number(res.headers.get("content-length")) > MAX_BYTES) return null;
      const body = Buffer.from(await res.arrayBuffer());
      if (!body.length || body.length > MAX_BYTES) return null;
      return `data:image/${TYPES[type]};base64,${body.toString("base64")}`;
    }
    return null;
  }
  // A logo from the first of these addresses that gives one; cached either way.
  function logo(addresses) {
    const list = (Array.isArray(addresses) ? addresses : [addresses]).filter((a) => typeof a === "string" && a.startsWith("https://"));
    if (!list.length) return Promise.resolve(null);
    const key = keyOf(list.join("|"));
    const have = known(key);
    if (have !== undefined) return Promise.resolve(have);
    if (now() - (misses.get(key) || -Infinity) < MISS_MS) return Promise.resolve(null);
    if (inflight.has(key)) return inflight.get(key);
    const work = (async () => {
      for (const address of list) {
        const found = await image(address).catch(() => null);
        if (found) {
          memory.set(key, found);
          try {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
            fs.writeFileSync(fileOf(key), found, { mode: 0o600 });
          } catch {}
          return found;
        }
      }
      misses.set(key, now());
      return null;
    })().finally(() => inflight.delete(key));
    inflight.set(key, work);
    return work;
  }
  return {
    // Logos for many at once, given at most `ms`; slower ones come next time.
    async many(requests, ms = 1500) {
      const out = new Map();
      await Promise.race([
        Promise.all(requests.map(async ([id, addresses]) => out.set(id, await logo(addresses)))),
        new Promise((r) => setTimeout(r, ms).unref?.()),
      ]);
      return out;
    },
    logo,
  };
}
