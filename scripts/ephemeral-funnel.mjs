import fs from "node:fs";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atomicJson, loadJson } from "../server/core.mjs";
import { exactBackgroundFunnel, funnelRoute } from "./public-link.mjs";
import { runTailscale } from "./persistent-serve.mjs";
import { tailscaleJson } from "./tailscale.mjs";
import { MAX_FUNNEL_LEASE_MS } from "./funnel-lease-worker.mjs";

export { exactBackgroundFunnel };
export const CONFLICT = "Tailscale port 443 is used by another service. Reach cannot open this agent invitation without replacing that service.";
const workerFile = fileURLToPath(new URL("./funnel-lease-worker.mjs", import.meta.url));
const HELD = { until: Number.MAX_SAFE_INTEGER };

// The public route is Tailscale daemon state: a background Funnel on port 443,
// held on for as long as Reach runs. Tailscale withdraws the public name after
// Funnel has been off for a while and can take many minutes to publish it
// again, so a route switched on per invitation handed agents a link the
// internet could not find. Reach itself refuses every internet request unless
// an invitation or agent session is live (listenPrivate in server/index.mjs).
// A separate janitor (funnel-lease-worker.mjs) holds a five-second lease and
// switches the route off if Reach itself dies; stopping Reach switches it off.
export class EphemeralFunnel {
  constructor({
    origin, target, file = "", window,
    inspect = () => tailscaleJson(["serve", "status", "--json"]),
    run = runTailscale,
    spawnWorker = () => fork(workerFile, [], { stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true }),
    report = () => {}, log = null,
    // Called with true when the public route comes up and false when it goes.
    changed = () => {},
    now = Date.now,
    every = setInterval, clearEvery = clearInterval,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ensureMs = 15000,
    inspectMs = 10000,
  }) {
    Object.assign(this, { origin, target, file, window, inspect, run, spawnWorker, report, log, changed, now, every, clearEvery, delay, ensureMs, inspectMs });
    this.worker = null;
    this.isLive = false;
    this.stopped = false;
    this.started = false;
    this.lastError = "";
    this.nextStart = 0;
    this.config = null;
    this.inspected = 0;
  }
  get live() { return this.isLive; }
  set live(value) {
    if (value === this.isLive) return;
    this.isLive = value;
    try { this.changed(value); } catch (error) { this.warn(error.message); }
  }
  activeWindow() {
    const value = this.window();
    return value?.open === true && Number.isFinite(value.until) && value.until > this.now() ? value : null;
  }
  warn(message) {
    if (message !== this.lastError) this.report(message);
    this.lastError = message;
  }
  // The daemon's serve configuration, read at most every inspectMs unless
  // forced. A failed read is reported, never acted on: the route stays as it is.
  async readConfig(force = false) {
    if (!force && this.config && this.now() - this.inspected < this.inspectMs) return this.config;
    const config = await this.inspect();
    this.config = config;
    this.inspected = this.now();
    return config;
  }
  async start() {
    if (this.starting) return this.starting;
    if (this.started || this.stopped) return this.live;
    this.starting = (async () => {
      // A route left by an earlier Reach: kept when it is exactly ours with
      // this target, switched off otherwise. Anything else on the port
      // is somebody else's and is never touched.
      const record = this.file ? loadJson(this.file, null) : null;
      if (record?.version === 1 && record.origin === this.origin && typeof record.target === "string") {
        const config = await this.readConfig(true);
        if (exactBackgroundFunnel(config, record.origin, record.target)) {
          if (record.target === this.target) this.live = true;
          else {
            await this.run(["funnel", "--https=443", "off"]);
            if (funnelRoute(await this.readConfig(true), record.origin, record.target) !== "free")
              throw Error("The previous public Funnel could not be closed. Agent access remains unavailable.");
            fs.rmSync(this.file, { force: true });
          }
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
      child.send(message, (error) => { if (error) this.warn(error.message); });
      return true;
    } catch (error) {
      this.warn(error.message);
      return false;
    }
  }
  // Reach being alive is the whole window: the lease is renewed every tick.
  lease(active = HELD, type = "lease") {
    return { type, leaseUntil: Math.min(this.now() + MAX_FUNNEL_LEASE_MS, active.until), windowUntil: active.until };
  }
  // The janitor exits quietly when Reach asks; losing Reach makes it act.
  async closeWorker() {
    const child = this.worker;
    this.worker = null;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode != null) return;
    const closed = new Promise((resolve) => { child.once("exit", resolve); child.once("close", resolve); });
    if (child.connected) {
      try { child.send({ type: "stop" }, () => {}); } catch {}
      try { child.disconnect(); } catch {}
    } else child.kill("SIGTERM");
    await closed;
  }
  startWorker(active) {
    const child = this.spawnWorker();
    this.worker = child;
    child.once("error", (error) => this.warn(error.message));
    const ended = () => { if (this.worker === child) this.worker = null; };
    child.once("exit", ended);
    child.once("close", ended);
    child.on("message", (message) => {
      if (message?.type === "error") this.warn(message.message);
      if (message?.type === "output") this.log?.write(message.text);
      if (message?.type === "off" && message.changed) { this.live = false; this.report("Public link switched off by the watchdog."); }
    });
    child.stdout?.on("data", (chunk) => this.log?.write(chunk));
    child.stderr?.on("data", (chunk) => this.log?.write(chunk));
    if (!this.send({ ...this.lease(active, "init"), target: this.target, origin: this.origin })) this.worker = null;
  }
  // Switch Reach's own route off (the window closed, or Reach is stopping).
  // Only an exact route of Reach's own is touched, judged from a fresh read
  // of the daemon unless the caller has one in hand.
  async release(config = null) {
    // Never live and no record of a route created: nothing of Reach's can be
    // on the port, so the daemon is not even asked.
    if (!config && !this.live && this.file && !fs.existsSync(this.file)) return;
    try {
      config ??= await this.readConfig(true);
      if (exactBackgroundFunnel(config, this.origin, this.target)) {
        await this.run(["funnel", "--https=443", "off"]);
        this.config = null;
        if (this.file) fs.rmSync(this.file, { force: true });
        this.report("Public link off: Reach stopped.");
      } else if (this.file && funnelRoute(config, this.origin, this.target) === "free") {
        // A record with no route behind it (switching on failed): dropped.
        fs.rmSync(this.file, { force: true });
      }
    } catch (error) { this.warn(error.message); }
    this.live = false;
  }
  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.synchronize().finally(() => { this.syncing = null; });
    return this.syncing;
  }
  async synchronize() {
    if (this.stopped || !this.started) return false;
    // Keep the janitor leased; a janitor that went away is started again.
    if (this.worker && !this.send(this.lease())) await this.closeWorker();
    if (!this.worker) this.startWorker(HELD);
    // The route itself is checked every inspectMs while live, and now if not.
    if (this.live && this.now() - this.inspected < this.inspectMs) return true;
    let config;
    try { config = await this.readConfig(true); }
    catch (error) { this.warn(error.message); return this.live; }
    if (this.stopped) return false;
    // Exactly our own background route is used as is (a restart never blinks);
    // a free port gets one; anything else on the port is somebody else's.
    if (exactBackgroundFunnel(config, this.origin, this.target)) { this.live = true; this.lastError = ""; return true; }
    if (funnelRoute(config, this.origin, this.target) !== "free") { this.live = false; this.warn(CONFLICT); return false; }
    if (this.now() < this.nextStart) return false;
    this.nextStart = this.now() + 1500;
    try {
      if (this.file) atomicJson(this.file, { version: 1, origin: this.origin, target: this.target });
      await this.run(["funnel", "--bg", "--https=443", this.target]);
      if (!exactBackgroundFunnel(await this.readConfig(true), this.origin, this.target))
        throw Error("The public Funnel route could not be verified. Agent access stays closed.");
      this.live = true;
      this.lastError = "";
      this.report("Public link on: the internet gets nothing until an invitation or agent session is live.");
    } catch (error) {
      this.live = false;
      this.warn(error.message);
    }
    return this.live;
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
    await this.release();
  }
}
