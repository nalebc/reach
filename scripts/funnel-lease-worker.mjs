import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { tailscaleCli } from "./tailscale.mjs";

export const MAX_FUNNEL_LEASE_MS = 5000;
export const FUNNEL_KILL_GRACE_MS = 1000;

// This watchdog is a separate process: a frozen or crashed Reach cannot keep
// renewing the foreground Funnel. No background route is ever created here.
export class FunnelLeaseWorker {
  constructor({
    target,
    spawnFunnel = (args) => spawn(tailscaleCli(), args, {
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    }),
    send = () => {},
    now = Date.now,
    monotonic = () => performance.now(),
    later = setTimeout,
    cancel = clearTimeout,
  }) {
    Object.assign(this, { target, spawnFunnel, send, now, monotonic, later, cancel });
    this.child = null;
    this.stopped = false;
    this.timer = null;
    this.killTimer = null;
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
  }
  renew({ leaseUntil, windowUntil } = {}) {
    if (this.stopped) return false;
    // A delayed timer must not let a queued IPC renewal revive an already
    // expired lease. Check the existing monotonic and absolute deadlines first.
    if (this.child && (this.monotonic() >= this.deadline || this.now() >= this.windowUntil)) {
      this.stop("lease expired");
      return false;
    }
    const duration = Math.min(MAX_FUNNEL_LEASE_MS, leaseUntil - this.now(), windowUntil - this.now());
    if (!Number.isFinite(leaseUntil) || !Number.isFinite(windowUntil) || !Number.isFinite(duration) || duration <= 0) {
      this.stop("lease expired");
      return false;
    }
    this.deadline = this.monotonic() + duration;
    this.windowUntil = windowUntil;
    this.cancel(this.timer);
    this.timer = this.later(() => this.check(), duration);
    if (!this.child) {
      try {
        const child = this.spawnFunnel(["funnel", "--https=443", this.target]);
        this.child = child;
        child.on("error", (error) => {
          this.send({ type: "error", message: error.message });
          this.stop("Funnel could not start");
        });
        child.once("close", () => {
          this.cancel(this.killTimer);
          this.cancel(this.timer);
          this.stopped = true;
          this.send({ type: "closed" });
          this.resolveClosed();
        });
        const output = (chunk) => this.send({ type: "output", text: String(chunk).slice(0, 8192) });
        child.stdout?.on("data", output);
        child.stderr?.on("data", output);
        this.send({ type: "started" });
      } catch (error) {
        this.send({ type: "error", message: error.message });
        this.stop("Funnel could not start");
      }
    }
    return !this.stopped;
  }
  check() {
    if (this.stopped) return;
    const remaining = Math.min(this.deadline - this.monotonic(), this.windowUntil - this.now());
    if (remaining <= 0) this.stop("lease expired");
    else this.timer = this.later(() => this.check(), remaining);
  }
  stop(reason = "stopped") {
    if (this.stopped) return this.closed;
    this.stopped = true;
    this.cancel(this.timer);
    this.send({ type: "stopping", reason });
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode != null) {
      this.resolveClosed();
      return this.closed;
    }
    child.kill("SIGTERM");
    this.killTimer = this.later(() => {
      if (child.exitCode === null && child.signalCode == null) child.kill("SIGKILL");
    }, FUNNEL_KILL_GRACE_MS);
    return this.closed;
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
  // Awaiting initialization must not itself become a lasting child process.
  const initialTimer = setTimeout(() => { void finish("no initial lease"); }, MAX_FUNNEL_LEASE_MS);
  process.on("message", (message) => {
    if (message?.type === "init" && !worker) {
      clearTimeout(initialTimer);
      if (typeof message.target !== "string" || !message.target || message.target.length > 4096) {
        void finish("invalid target");
        return;
      }
      worker = new FunnelLeaseWorker({ target: message.target, send });
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
