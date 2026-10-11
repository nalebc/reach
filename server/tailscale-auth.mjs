import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import { tailscaleJson } from "../scripts/tailscale.mjs";
import { fail, hash } from "./core.mjs";

// Never exported as an HTTP header. Only the filesystem-protected listener can
// set this marker. The host OS user/root is trusted, just like clients.json.
const trusted = new WeakSet();
const ingress = new WeakSet();
// Tailscale's Unix-socket proxy rewrites Host to localhost and overwrites
// X-Forwarded-Host with the original authority. Trust that value only on the
// protected listener, including Funnel requests, without granting identity.
export const serveRequestHost = (req) =>
  ingress.has(req)
    ? req.headers["x-forwarded-host"] || req.headers.host
    : req.headers.host;
export const identityBinding = (identity) => ({
  userId: identity.userId,
  nodeId: identity.nodeId,
});
export const sameIdentity = (a, b) =>
  !!a && !!b && a.userId === b.userId && a.nodeId === b.nodeId;
export const ownerIdentity = (identity, owner) =>
  !!identity &&
  !identity.tagged &&
  identity.userId === owner?.userId &&
  identity.validUntil > Date.now();
export function serveSocketPath(
  root,
  {
    platform = process.platform,
    home = os.homedir(),
    uid = process.getuid?.(),
    exists = fs.existsSync,
  } = {},
) {
  const paths = platform === "darwin" ? path.posix : path;
  const suffix = hash(paths.resolve(root)).slice(0, 12);
  let base = platform === "darwin" ? "/tmp" : os.tmpdir();
  if (platform === "darwin") {
    // Sandboxed Tailscale variants may only dial Unix sockets in their app group.
    // Match the CLI's macOS-before-macsys discovery order. No Tailscale files are
    // read or changed: Reach owns only its r-<checkout hash> directory.
    for (const group of [
      "W5364U7YZB.group.io.tailscale.ipn.macos",
      "W5364U7YZB.io.tailscale.ipn.macsys",
    ]) {
      const candidate = paths.join(home, "Library/Group Containers", group);
      if (exists(candidate)) {
        base = candidate;
        break;
      }
    }
  }
  const at = (n) =>
    paths.join(
      base,
      base === "/tmp" || platform !== "darwin"
        ? `reach-${uid}-${suffix.slice(0, n)}`
        : `r-${suffix.slice(0, n)}`,
      "s",
    );
  // A long account name puts Tailscale's app folder deep; Reach's own folder
  // in it takes a shorter name then (a computer set up before keeps its own).
  const limit = platform === "darwin" ? 104 : 108;
  const socket = [at(12), at(6)].find((p) => Buffer.byteLength(p) < limit);
  if (!socket)
    throw Error(
      base.includes("ipn.macos")
        ? `Your Mac account's folder (${home}) is too long for the App Store version of Tailscale, which can only reach Reach through a short path. Install Tailscale's standalone app from https://tailscale.com/download/mac instead, or use a Mac account with a shorter name.`
        : `Your home folder (${home}) is too long for Tailscale's private socket. Use an account with a shorter name; device approval can't start safely otherwise.`,
    );
  return socket;
}
export function whoisIdentity(value) {
  const node = value?.Node,
    user = value?.UserProfile;
  if (
    !node?.StableID ||
    node.Expired ||
    (node.KeyExpiry &&
      Date.parse(node.KeyExpiry) > 0 &&
      Date.parse(node.KeyExpiry) <= Date.now())
  )
    throw fail(403, "This Tailscale device is no longer authorized.");
  const tagged = Array.isArray(node.Tags) && node.Tags.length > 0;
  if (!tagged && (!user?.ID || String(node.User) !== String(user.ID)))
    throw fail(403, "Tailscale could not verify this account.");
  return {
    nodeId: String(node.StableID),
    userId: tagged ? "" : String(user.ID),
    login: tagged ? "" : user.LoginName,
    nodeName: String(node.ComputedName || node.Name || "Device")
      .replace(/\.$/, "")
      .slice(0, 160),
    tagged,
  };
}
export function createIdentityResolver({
  lookup = (ip) => tailscaleJson(["whois", "--json", ip]),
  now = Date.now,
  // A device's identity is asked of Tailscale again after this long. Each ask
  // starts the Tailscale CLI (~0.1 s), but an address that now belongs to
  // another device must lose its open connections within seconds
  // (tailscale-auth.test.mjs), so it stays short.
  ttlMs = 2000,
} = {}) {
  const cache = new Map();
  return async (req) => {
    if (!trusted.has(req) || fromInternet(req)) return null;
    const ip = req.headers["x-forwarded-for"];
    // Serve overwrites X-Forwarded-For with the actual source; never accept a
    // client supplied chain, host name, port or arbitrary CLI argument.
    if (typeof ip !== "string" || !net.isIP(ip)) return null;
    let entry = cache.get(ip);
    if (!entry || entry.until <= now()) {
      if (cache.size >= 256) cache.clear();
      entry = {
        until: now() + ttlMs,
        value: Promise.resolve()
          .then(() => lookup(ip))
          .then(whoisIdentity)
          .catch(() => null),
      };
      cache.set(ip, entry);
    }
    const value = await entry.value;
    if (!value || (!value.tagged && !req.headers["tailscale-user-login"]))
      return null;
    return { ...value, validUntil: entry.until + 5000 };
  };
}
// Tailscale marks each request that came from the internet (Funnel) and strips
// the mark from everything else, including a copy sent by the client.
export const fromInternet = (req) =>
  req.headers["tailscale-funnel-request"] !== undefined;
// One address for everything: Tailscale may send the internet's requests here
// too (Funnel) and on the same connection as your devices'. Each request is
// sorted on its own: the internet only ever gets `publicApp` (the start page),
// never Reach; WebSockets from the internet are refused.
export async function listenPrivateIngress({
  socketPath,
  app,
  upgrade,
  resolveIdentity,
  publicApp,
}) {
  if (process.platform === "win32")
    throw Error("Private Tailscale ingress requires POSIX socket ownership and permissions.");
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid())
    throw Error("Unsafe Reach socket directory.");
  fs.chmodSync(dir, 0o700);
  if (fs.existsSync(socketPath)) {
    const old = fs.lstatSync(socketPath);
    if (!old.isSocket() || old.uid !== process.getuid())
      throw Error("Unsafe Reach socket path.");
    const alive = await new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", (e) =>
        ["ECONNREFUSED", "ENOENT"].includes(e.code)
          ? resolve(false)
          : reject(e),
      );
    });
    if (alive) throw Error("Reach's private listener is already running.");
    fs.unlinkSync(socketPath);
  }
  const prepare = async (req) => {
    trusted.add(req);
    req.reachIdentity = await resolveIdentity(req);
  };
  const server = http.createServer((req, res) => {
    ingress.add(req);
    if (fromInternet(req)) {
      if (publicApp) return publicApp(req, res);
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not found.");
    }
    prepare(req)
      .then(() => app(req, res))
      .catch(() => {
        res.writeHead(503);
        res.end();
      });
  });
  server.on("upgrade", (req, socket, head) => {
    if (fromInternet(req)) return socket.destroy();
    prepare(req)
      .then(() => upgrade(req, socket, head))
      .catch(() => socket.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  fs.chmodSync(socketPath, 0o600);
  return server;
}
export function trustedRequest(req) {
  return trusted.has(req);
}
