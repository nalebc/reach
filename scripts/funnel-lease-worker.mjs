import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { tailscaleCli } from "./tailscale.mjs";
import { exactBackgroundFunnel } from "./public-link.mjs";

export const MAX_FUNNEL_LEASE_MS = 5000;
const exec = promisify(execFile);

// The public route is Tailscale daemon state (a background Funnel), so it
// survives dropped CLI sessions, sleeps and restarts. This janitor is a
// separate process with one job: if Reach stops renewing its lease, because it
// froze, crashed or was killed, switch that route off. It never creates a
// route, and it only switches off a route that is exactly Reach's own.
export class FunnelLeaseWorker {
  constructor({
    target,
    origin,
    inspect = () => exec(tailscaleCli(), ["serve", "status", "--json"], { timeout: 5000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }).then(({ stdout }) => JSON.parse(stdout)),
    run = (args) => exec(tailscaleCli(), args, { timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true }),
    send = () => {},
    now = Date.now,
    monotonic = () => performance.now(),
    later = setTimeout,
    cancel = clearTimeout,
  }) {
    Object.assign(this, { target, origin, inspect, run, send, now, monotonic, later, cancel });
    this.stopped = false;
    this.leased = false;
    this.timer = null;
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
  }
  renew({ leaseUntil, windowUntil } = {}) {
    if (this.stopped) return false;
    // A delayed timer must not let a queued IPC renewal revive an already
    // expired lease. Check the existing monotonic and absolute deadlines first.
    if (this.leased && (this.monotonic() >= this.deadline || this.now() >= this.windowUntil)) {
      void this.stop("lease expired");
      return false;
    }
    const duration = Math.min(MAX_FUNNEL_LEASE_MS, leaseUntil - this.now(), windowUntil - this.now());
    if (!Number.isFinite(leaseUntil) || !Number.isFinite(windowUntil) || !Number.isFinite(duration) || duration <= 0) {
      void this.stop("lease expired");
      return false;
    }
    this.deadline = this.monotonic() + duration;
    this.windowUntil = windowUntil;
    this.cancel(this.timer);
    this.timer = this.later(() => this.check(), duration);
    if (!this.leased) { this.leased = true; this.send({ type: "started" }); }
    return true;
  }
  check() {
    if (this.stopped) return;
    const remaining = Math.min(this.deadline - this.monotonic(), this.windowUntil - this.now());
    if (remaining <= 0) void this.stop("lease expired");
    else this.timer = this.later(() => this.check(), remaining);
  }
  // Reach asked for a quiet exit (it manages the route itself while alive);
  // every other end means Reach is gone, and the route goes with it.
  async stop(reason = "stopped") {
    if (this.stopped) return this.closed;
    this.stopped = true;
    this.cancel(this.timer);
    this.send({ type: "stopping", reason });
    if (reason !== "parent stopped" && this.leased) await this.off();
    this.send({ type: "closed" });
    this.resolveClosed();
    return this.closed;
  }
  async off() {
    try {
      const config = await this.inspect();
      if (!exactBackgroundFunnel(config, this.origin, this.target)) { this.send({ type: "off", changed: false }); return false; }
      await this.run(["funnel", "--https=443", "off"]);
      this.send({ type: "off", changed: true });
      return true;
    } catch (error) {
      this.send({ type: "error", message: `The public route could not be switched off: ${error.message}` });
      return false;
    }
  }
}

async function main() {
  let worker;
  const send = (value) => {
    if (process.connected) process.send(value, () => {});
  };
  const finish = async (reason) => {
    if (worker) await worker.stop(reason);
    if (process.connected) process.disconnect();
  };
  // Awaiting initialization must not itself become a lasting process.
  const initialTimer = setTimeout(() => { void finish("no initial lease"); }, MAX_FUNNEL_LEASE_MS);
  process.on("message", (message) => {
    if (message?.type === "init" && !worker) {
      clearTimeout(initialTimer);
      const valid = (value) => typeof value === "string" && value && value.length <= 4096;
      if (!valid(message.target) || !valid(message.origin)) { void finish("invalid target"); return; }
      worker = new FunnelLeaseWorker({ target: message.target, origin: message.origin, send });
      worker.closed.then(() => { if (process.connected) process.disconnect(); });
      worker.renew(message);
    } else if (message?.type === "lease" && worker) worker.renew(message);
    else if (message?.type === "stop") { clearTimeout(initialTimer); void finish("parent stopped"); }
  });
  process.once("disconnect", () => { clearTimeout(initialTimer); void finish("parent disconnected"); });
  process.once("SIGTERM", () => { clearTimeout(initialTimer); void finish("watchdog stopped"); });
  process.once("SIGINT", () => { clearTimeout(initialTimer); void finish("watchdog stopped"); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
