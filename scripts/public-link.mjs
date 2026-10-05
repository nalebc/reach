import fs from "node:fs";
import { spawn } from "node:child_process";
import { atomicJson, loadJson } from "../server/core.mjs";
import { serveConfigs, tailscaleCli, tailscaleJson } from "./tailscale.mjs";
import { runTailscale } from "./persistent-serve.mjs";

// The one address: https://<computer>.<tailnet>.ts.net (port 443) via
// Tailscale Funnel, pointing at Reach's own private listener. That listener
// gives the internet only the start page (server/public-start.mjs) and your
// devices Reach, request by request, by Tailscale's Funnel mark
// (server/tailscale-auth.mjs). Reach's own port (8443) stays private Serve.
export const PUBLIC_PORT = 443;
export const startOrigin = (privateOrigin) =>
  `https://${new URL(privateOrigin).hostname}`;
const AUTH_URL = /https:\/\/(?:login|console)\.tailscale\.com\/[^\s"']+/;

// "ours": exactly our Funnel route. "free": nothing on 443. "taken": anything
// else on 443, which is never replaced.
export function funnelRoute(config, origin, target) {
  const host = `${new URL(origin).hostname}:${PUBLIC_PORT}`;
  let ours = false,
    taken = false;
  for (const c of serveConfigs(config)) {
    const hosts = Object.keys(c?.Web || {}).filter((h) =>
      h.endsWith(`:${PUBLIC_PORT}`),
    );
    if (!c?.TCP?.[PUBLIC_PORT] && !hosts.length) continue;
    const handlers = c.Web?.[host]?.Handlers || {};
    if (
      c.TCP?.[PUBLIC_PORT]?.HTTPS === true &&
      hosts.length === 1 &&
      hosts[0] === host &&
      Object.keys(handlers).length === 1 &&
      handlers["/"]?.Proxy === target &&
      c.AllowFunnel?.[host] === true
    )
      ours = true;
    else taken = true;
  }
  return taken ? "taken" : ours ? "ours" : "free";
}

export const PORT_TAKEN =
  "Port 443 on this computer's Tailscale address is used by another service, so phones without the Tailscale app can't sign in from the browser. Phones with the app still connect.";

// Reach's own route from before one address (to a separate start-page
// listener), as recorded when Reach added it: turned off so the one address
// can take its place. Never a route Reach didn't record as its own.
async function clearOwnOldRoute({ file, origin, target, inspect, run }) {
  const record = file ? loadJson(file, null) : null;
  if (
    !record ||
    record.origin !== origin ||
    typeof record.target !== "string" ||
    record.target === target ||
    funnelRoute(await inspect(), origin, record.target) !== "ours"
  )
    return false;
  await run(["funnel", `--https=${PUBLIC_PORT}`, "off"]);
  return true;
}

// Foreground: a `tailscale funnel` process that lives as long as Reach does;
// Tailscale removes its route when it exits.
export class PublicLink {
  constructor({
    origin,
    target,
    inspect = () => tailscaleJson(["serve", "status", "--json"]),
    spawnFunnel = (args) =>
      spawn(tailscaleCli(), args, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }),
    report = () => {},
    setupUrl = () => {},
    log = null,
    now = Date.now,
    // Where a background service records its route (to replace an old one).
    file = "",
    run = runTailscale,
  }) {
    Object.assign(this, {
      origin,
      target,
      inspect,
      spawnFunnel,
      report,
      setupUrl,
      log,
      now,
      file,
      run,
    });
    this.child = null;
    this.stopped = false;
    this.nextStart = 0;
    this.attempt = 0;
    this.live = false;
    this.warned = "";
  }
  warn(message) {
    if (message !== this.warned) this.report(message);
    this.warned = message;
  }
  running() {
    return (
      !!this.child &&
      this.child.exitCode === null &&
      this.child.signalCode == null
    );
  }
  async check() {
    if (this.stopped) return this.live;
    let state;
    try {
      state = funnelRoute(await this.inspect(), this.origin, this.target);
      // A background service's route from an older Reach: this run is Reach
      // now, at the one address; the service records its own when it starts.
      if (state === "taken" && (await clearOwnOldRoute(this))) {
        fs.rmSync(this.file, { force: true });
        state = funnelRoute(await this.inspect(), this.origin, this.target);
      }
    } catch (error) {
      this.live = false;
      this.warn(error.message);
      return false;
    }
    if (state === "ours") {
      if (!this.live && this.warned) this.report("Public start link restored.");
      this.live = true;
      this.warned = "";
      this.attempt = 0;
      return true;
    }
    this.live = false;
    if (state === "taken") {
      this.warn(PORT_TAKEN);
      return false;
    }
    // Free: (re)start our Funnel, with backoff if it keeps failing.
    if (this.running() || this.now() < this.nextStart) return false;
    this.nextStart =
      this.now() + Math.min(60000, 5000 * 2 ** Math.min(this.attempt++, 4));
    const child = this.spawnFunnel([
      "funnel",
      `--https=${PUBLIC_PORT}`,
      this.target,
    ]);
    this.child = child;
    const consume = (chunk) => {
      this.log?.write(chunk);
      const url = String(chunk).match(AUTH_URL)?.[0];
      if (url) this.setupUrl(url);
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.on?.("error", () => {});
    return false;
  }
  async stop() {
    this.stopped = true;
    const child = this.child;
    if (!child || !this.running()) return;
    const closed = new Promise((resolve) => child.once("close", resolve));
    child.kill();
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    timer.unref?.();
    await closed;
    clearTimeout(timer);
  }
}

// Background service: a lasting `funnel --bg` route, recorded so uninstall
// removes exactly what Reach added.
export async function ensurePersistentFunnel({
  file,
  origin,
  target,
  inspect = () => tailscaleJson(["serve", "status", "--json"]),
  run = runTailscale,
}) {
  let state = funnelRoute(await inspect(), origin, target);
  const record = loadJson(file, null);
  if (
    state === "ours" &&
    record?.origin === origin &&
    record?.target === target
  )
    return true;
  if (
    state === "taken" &&
    (await clearOwnOldRoute({ file, origin, target, inspect, run }))
  )
    state = funnelRoute(await inspect(), origin, target);
  if (state === "taken") throw Error(PORT_TAKEN);
  atomicJson(file, { version: 1, origin, target });
  if (state === "free")
    await run(["funnel", "--bg", `--https=${PUBLIC_PORT}`, target]);
  if (funnelRoute(await inspect(), origin, target) !== "ours")
    throw Error("The public start link could not be verified.");
  return true;
}

export async function removePersistentFunnel({
  file,
  inspect = () => tailscaleJson(["serve", "status", "--json"]),
  run = runTailscale,
}) {
  const record = loadJson(file, null);
  if (!record) return "";
  if (funnelRoute(await inspect(), record.origin, record.target) === "ours")
    await run(["funnel", `--https=${PUBLIC_PORT}`, "off"]);
  fs.rmSync(file, { force: true });
  return "Public start link removed.";
}
