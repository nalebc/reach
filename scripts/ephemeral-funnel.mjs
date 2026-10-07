import fs from "node:fs";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadJson } from "../server/core.mjs";
import { funnelRoute } from "./public-link.mjs";
import { runTailscale } from "./persistent-serve.mjs";
import { serveConfigs, tailscaleJson } from "./tailscale.mjs";
import { MAX_FUNNEL_LEASE_MS } from "./funnel-lease-worker.mjs";

const CONFLICT = "Tailscale port 443 is used by another service. Reach cannot open this agent invitation without replacing that service.";
const workerFile = fileURLToPath(new URL("./funnel-lease-worker.mjs", import.meta.url));
const portEntries = (config) => serveConfigs(config).filter((entry) =>
  entry.TCP?.[443] || Object.keys(entry.Web || {}).some((host) => host.endsWith(":443")),
);
export function exactBackgroundFunnel(config, origin, target) {
  const entries = portEntries(config);
  if (entries.length !== 1 || entries[0] !== config || funnelRoute(config, origin, target) !== "ours") return false;
  const host = `${new URL(origin).hostname}:443`;
  const tcp = config.TCP[443], web = config.Web[host], handler = web.Handlers["/"];
  return Object.keys(tcp).length === 1 && Object.keys(web).length === 1 && Object.keys(handler).length === 1;
}
const ownedForeground = (config, origin, target) => {
  const entries = portEntries(config);
  return entries.length === 1 && entries[0] !== config && funnelRoute(config, origin, target) === "ours";
};

// A public route exists only while an explicit browser invitation or session
// is live. Its independent watchdog must receive a fresh lease every second.
export class EphemeralFunnel {
  constructor({
    origin, target, file = "", window,
    inspect = () => tailscaleJson(["serve", "status", "--json"]),
    run = runTailscale,
    spawnWorker = () => fork(workerFile, [], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true }),
    report = () => {}, log = null,
    now = Date.now,
    every = setInterval, clearEvery = clearInterval,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ensureMs = 15000,
  }) {
    Object.assign(this, { origin, target, file, window, inspect, run, spawnWorker, report, log, now, every, clearEvery, delay, ensureMs });
    this.worker = null;
    this.live = false;
    this.stopped = false;
    this.started = false;
    this.lastError = "";
    this.nextStart = 0;
  }
  activeWindow() {
    const value = this.window();
    return value?.open === true && Number.isFinite(value.until) && value.until > this.now() ? value : null;
  }
  warn(message) {
    if (message !== this.lastError) this.report(message);
    this.lastError = message;
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.started || this.stopped) return this.live;
    this.starting = (async () => {
      const record = this.file ? loadJson(this.file, null) : null;
      if (record?.version === 1 && record.origin === this.origin && typeof record.target === "string") {
        const config = await this.inspect();
        if (exactBackgroundFunnel(config, record.origin, record.target)) {
          await this.run(["funnel", "--https=443", "off"]);
          if (funnelRoute(await this.inspect(), record.origin, record.target) !== "free")
            throw Error("The previous public Funnel could not be closed. Agent access remains unavailable.");
          fs.rmSync(this.file, { force: true });
        } else if (funnelRoute(config, record.origin, record.target) === "free") {
          fs.rmSync(this.file, { force: true });
        }
      }
      if (this.stopped) return false;
      this.started = true;
      this.monitor = this.every(() => { void this.sync().catch((error) => this.warn(error.message)); }, 1000);
      this.monitor.unref?.();
      return this.sync();
    })();
    try { return await this.starting; }
    finally { this.starting = null; }
  }
  send(message) {
    const child = this.worker;
    if (!child?.connected || child.exitCode !== null || child.signalCode != null) return false;
    try {
      child.send(message, (error) => { if (error) { this.live = false; this.warn(error.message); } });
      return true;
    } catch (error) {
      this.live = false;
      this.warn(error.message);
      return false;
    }
  }
  lease(active, type = "lease") {
    return { type, leaseUntil: Math.min(this.now() + MAX_FUNNEL_LEASE_MS, active.until), windowUntil: active.until };
  }
  async closeWorker() {
    this.live = false;
    const child = this.worker;
    this.worker = null;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode != null) return;
    const closed = new Promise((resolve) => { child.once("exit", resolve); child.once("close", resolve); });
    if (child.connected) {
      try { child.send({ type: "stop" }, () => {}); } catch {}
      // IPC loss independently instructs the watchdog to stop. Do not kill
      // the watchdog before it has reaped its own foreground Funnel process.
      try { child.disconnect(); } catch {}
    } else child.kill("SIGTERM");
    await closed;
  }
  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.synchronize().finally(() => { this.syncing = null; });
    return this.syncing;
  }
  async synchronize() {
    if (this.stopped || !this.started) return false;
    let active;
    try { active = this.activeWindow(); }
    catch (error) { await this.closeWorker(); this.warn(error.message); return false; }
    if (!active) { await this.closeWorker(); this.lastError = ""; return false; }
    if (this.worker && !this.send(this.lease(active))) await this.closeWorker();
    let config;
    try { config = await this.inspect(); }
    catch (error) { await this.closeWorker(); this.warn(error.message); return false; }
    if (this.stopped || !this.activeWindow()) { await this.closeWorker(); return false; }
    if (this.worker) {
      this.live = ownedForeground(config, this.origin, this.target);
      if (funnelRoute(config, this.origin, this.target) === "taken") {
        await this.closeWorker();
        this.warn(CONFLICT);
      }
      return this.live;
    }
    if (funnelRoute(config, this.origin, this.target) !== "free") {
      this.warn(CONFLICT);
      return false;
    }
    if (this.now() < this.nextStart) return false;
    this.nextStart = this.now() + 1500;
    active = this.activeWindow();
    if (!active || this.stopped) return false;
    const child = this.spawnWorker();
    this.worker = child;
    this.lastError = "";
    child.once("error", (error) => { this.live = false; this.warn(error.message); });
    const ended = () => { if (this.worker === child) { this.worker = null; this.live = false; } };
    child.once("exit", ended);
    child.once("close", ended);
    child.on("message", (message) => {
      if (message?.type === "error") this.warn(message.message);
      if (message?.type === "output") this.log?.write(message.text);
      if (["closed", "stopping"].includes(message?.type)) this.live = false;
    });
    child.stdout?.on("data", (chunk) => this.log?.write(chunk));
    child.stderr?.on("data", (chunk) => this.log?.write(chunk));
    if (!this.send({ ...this.lease(active, "init"), target: this.target })) await this.closeWorker();
    return false;
  }
  async ensure() {
    if (this.stopped) throw Error("Agent sharing has stopped.");
    if (!this.started) await this.start();
    const deadline = this.now() + this.ensureMs;
    while (!this.stopped && this.now() < deadline) {
      if (!this.activeWindow()) throw Error("This agent invitation or session has ended.");
      if (await this.sync()) return true;
      if (this.lastError === CONFLICT) throw Error(CONFLICT);
      await this.delay(250);
    }
    throw Error(this.lastError || "The temporary Tailscale connection could not start. Try creating a new agent invitation.");
  }
  async stop() {
    this.stopped = true;
    this.clearEvery(this.monitor);
    await this.closeWorker();
  }
}
