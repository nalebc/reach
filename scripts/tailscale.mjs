import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
// The Mac App Store and standalone apps carry the CLI inside the app without
// putting `tailscale` on PATH.
const macApps = (env) => ["/Applications/Tailscale.app", path.posix.join(env.HOME || os.homedir(), "Applications/Tailscale.app")];
const appCli = (app) => path.posix.join(app, "Contents/MacOS/Tailscale");
export const findMacTailscaleApp = ({ env = process.env, exists = fs.existsSync } = {}) =>
  macApps(env).find(app => exists(app) || exists(appCli(app)));
// Windows installs it in Program Files. The installer adds it to PATH, but a
// Reach already running (waiting for the install) keeps its old PATH.
export const windowsTailscaleDir = (env = process.env) =>
  path.win32.join(env.ProgramFiles || "C:\\Program Files", "Tailscale");
export function findTailscaleCli({
  env = process.env,
  platform = process.platform,
  exists = fs.existsSync,
} = {}) {
  if (env.REACH_TAILSCALE) return env.REACH_TAILSCALE;
  // On a Mac with the Tailscale app, its own command line is the one that
  // matches the running daemon; a Homebrew copy on the PATH often doesn't,
  // and long-lived sessions through a mismatched client drop.
  if (platform === "darwin") {
    const app = macApps(env).map(appCli).find(exists);
    if (app) return app;
    // A Terminal opened before Homebrew was installed keeps its old PATH.
    // Honor a CLI already on PATH, then check both Homebrew prefixes.
    const candidates = [
      ...(env.PATH || "").split(":").filter(dir => path.posix.isAbsolute(dir)).map(dir => path.posix.join(dir, "tailscale")),
      "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale",
    ];
    const found = candidates.find(exists);
    if (found) return found;
  }
  if (platform === "win32") {
    const exe = path.win32.join(windowsTailscaleDir(env), "tailscale.exe");
    if (exists(exe)) return exe;
  }
  return "tailscale";
}
// Setup can install, move or replace the app while Reach waits.
export const tailscaleCli = () => findTailscaleCli();
// The command line's own version ("" when it doesn't answer).
export const tailscaleCliVersion = () =>
  exec(tailscaleCli(), ["version"], { timeout: 5000, maxBuffer: 65536, windowsHide: true }).then(({ stdout }) => stdout.split("\n")[0].trim()).catch(() => "");
// The command line's version and the daemon's: when they differ, say so once.
export async function tailscaleVersions() {
  const [client, status] = await Promise.all([
    tailscaleCliVersion(),
    tailscaleJson(["status", "--json"]).catch(() => null),
  ]);
  const daemon = typeof status?.Version === "string" ? status.Version.split("-")[0] : "";
  return { client, daemon, mismatch: !!client && !!daemon && client !== daemon };
}
// What Windows' keyed route depends on (configure.mjs keyedSupportProblem):
// the daemon's status and the command line's version.
export async function readKeyedState({ redact } = {}) {
  const [status, cliVersion] = await Promise.all([
    tailscaleJson(["status", "--json"], { redact }),
    tailscaleCliVersion(),
  ]);
  return { status, cliVersion };
}
// `redact`: Windows' keyed mode takes its route's key out of what Tailscale
// said before anything is cut (server/tailscale-auth.mjs keyRedactor). Every
// other caller gets Tailscale's words as they were.
export async function tailscaleJson(args, { redact = (text) => text } = {}) {
  try {
    const { stdout } = await exec(tailscaleCli(), args, {
      timeout: 5000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return JSON.parse(stdout);
  } catch (error) {
    // A missing program is not a program that didn't answer.
    if (error?.code === "ENOENT")
      throw Error(
        "Tailscale is unavailable. Install and sign in to Tailscale on this computer and your phone, then rerun Reach.",
      );
    const why = redact(String(error?.killed || error?.signal ? "it took too long" : error?.stderr || error?.message || ""))
      .trim()
      .split("\n")[0]
      .slice(0, 160);
    throw Error(`Tailscale didn't answer${why ? `: ${why}` : ""}. Check that it is running and signed in, then rerun Reach.`);
  }
}
export function serveConfigs(config) {
  return [
    config,
    ...Object.values(config?.Foreground || {}).flatMap(serveConfigs),
  ];
}
// Windows' keyed route (docs/parity/D-public-door.md §4.6): does anything in
// Tailscale's serve config, other than Reach's own `ownTarget`, lead to
// Reach's loopback port? A TCP forward or a proxy to that port is a path from
// Tailscale's own process with no key: Reach then closes its route until it's
// gone. Whatever the host is called (127.1, LOCALHOST, [::1], the PC's name):
// only the port counts. A target whose port can't be read counts too.
// `ownTarget` "": every route to the port counts (Reach stopping).
const targetPort = (value) => {
  if (typeof value !== "string" || !value) return NaN;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `tcp://${value}`);
    if (url.port) return Number(url.port);
    return { "http:": 80, "https:": 443, "https+insecure:": 443 }[url.protocol] ?? NaN;
  } catch {
    return NaN;
  }
};
export function foreignIngressRoute(config, port, ownTarget = "") {
  const entries = serveConfigs(config).flatMap((entry) => [entry, ...Object.values(entry?.Services || {})]);
  for (const entry of entries) {
    for (const tcp of Object.values(entry?.TCP || {})) {
      if (typeof tcp?.TCPForward !== "string" || !tcp.TCPForward) continue;
      const forwarded = tcp.TCPForward.slice(tcp.TCPForward.lastIndexOf(":") + 1);
      if (!/^\d{1,5}$/.test(forwarded) || Number(forwarded) === port) return true;
    }
    for (const web of Object.values(entry?.Web || {}))
      for (const handler of Object.values(web?.Handlers || {})) {
        const proxy = handler?.Proxy;
        if (typeof proxy !== "string" || !proxy || proxy.startsWith("unix:")) continue;
        if (ownTarget && proxy === ownTarget) continue;
        const to = targetPort(proxy);
        if (!Number.isInteger(to) || to === port) return true;
      }
  }
  return false;
}
export function assertPrivatePort(config, port) {
  for (const item of serveConfigs(config)) {
    if (
      Object.entries(item.AllowFunnel || {}).some(
        ([host, enabled]) => enabled && host.endsWith(`:${port}`),
      )
    )
      throw Error(
        `Tailscale Funnel is enabled on port ${port}. Reach requires a private Serve port. Turn Funnel off on this port: tailscale funnel --https=${port} off, then run Reach again.`,
      );
  }
}
// What a route on the port leads to, when it's an earlier Reach's own:
// its private socket (server/tailscale-auth.mjs serveSocketPath).
const REACH_SOCKET = /^unix:.*\/(?:r|reach-\d+)-[0-9a-f]{6,12}\/s$/;
export function assertUnusedPort(config, port) {
  assertPrivatePort(config, port);
  const taken = serveConfigs(config).filter(
    (item) =>
      item.TCP?.[port] ||
      Object.keys(item.Web || {}).some((host) => host.endsWith(`:${port}`)),
  );
  if (!taken.length) return;
  const proxies = taken.flatMap((item) =>
    Object.entries(item.Web || {})
      .filter(([host]) => host.endsWith(`:${port}`))
      .flatMap(([, web]) => Object.values(web?.Handlers || {}).map((h) => h?.Proxy || "")),
  );
  // An earlier Reach's route (another folder, or before its .reach was
  // deleted): Reach doesn't remove what it didn't record as its own, so the
  // fix is one command, for you to run.
  if (proxies.length && proxies.every((p) => REACH_SOCKET.test(p)))
    throw Error(
      `Tailscale port ${port} still has the route of an earlier Reach (another folder, or set up before). If that Reach is gone, remove the route with: tailscale serve --https=${port} off\nThen run Reach again. Or choose another port with --https-port.`,
    );
  throw Error(
    `Tailscale port ${port} is already in use (see: tailscale serve status). Choose another with --https-port; Reach will not replace an existing service.`,
  );
}
export function ownsServeRoute(config, origin, target) {
  const u = new URL(origin);
  const port = Number(u.port || 443);
  assertPrivatePort(config, port);
  return serveConfigs(config).some(
    (item) =>
      item.TCP?.[port]?.HTTPS === true &&
      (item.Web?.[`${u.hostname}:${port}`] || item.Web?.[u.host])?.Handlers?.[
        "/"
      ]?.Proxy === target,
  );
}
// Prefer the saved port, then find a private port without changing any
// existing service. Funnel flags count even when no listener is listed.
export function selectPrivatePort(config, preferred, acceptExisting) {
  const used = new Set(), publicPorts = new Set();
  for (const item of serveConfigs(config)) {
    for (const [port, listener] of Object.entries(item?.TCP || {}))
      if (listener) used.add(Number(port));
    for (const host of Object.keys(item?.Web || {}))
      used.add(Number(host.slice(host.lastIndexOf(":") + 1)));
    for (const [host, enabled] of Object.entries(item?.AllowFunnel || {}))
      if (enabled) publicPorts.add(Number(host.slice(host.lastIndexOf(":") + 1)));
  }
  const available = (port) => !publicPorts.has(port) && (!used.has(port) || acceptExisting?.(port));
  for (const port of [preferred, 9443, 8443])
    if (Number.isInteger(port) && port >= 1 && port <= 65535 && available(port)) return port;
  for (const [start, end] of [[8444, 65535], [1024, 8442]])
    for (let port = start; port <= end; port++)
      if (available(port)) return port;
  throw Error("Tailscale has no free private HTTPS port for Reach. Free a port in Tailscale, then run Reach again.");
}
export async function prepareTailscale(port = 8443, acceptExisting, { json = tailscaleJson, print = console.log } = {}) {
  const status = await json(["status", "--json"]);
  if (status.BackendState !== "Running")
    throw Error(
      "Open Tailscale and sign in on this computer, then rerun Reach.",
    );
  const hostname = status.Self?.DNSName?.replace(/\.$/, "");
  if (!hostname || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+\.ts\.net$/i.test(hostname))
    throw Error(
      "Tailscale did not provide a valid device hostname. Enable MagicDNS and HTTPS in Tailscale.",
    );
  const originAt = (chosen) => `https://${hostname}${chosen === 443 ? "" : ":" + chosen}`;
  const config = await json(["serve", "status", "--json"]);
  const chosen = selectPrivatePort(config, port, (candidate) => acceptExisting?.(config, originAt(candidate)));
  if (chosen !== port)
    print(`Reach: port ${port} is unavailable; using port ${chosen} automatically.`);
  return originAt(chosen);
}
export async function checkUnused(port) {
  assertUnusedPort(await tailscaleJson(["serve", "status", "--json"]), port);
}
