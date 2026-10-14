import { tailscaleJson } from "./tailscale.mjs";
import { exactForegroundFunnel, funnelRoute } from "./public-link.mjs";
import { CONFLICT } from "./ephemeral-funnel.mjs";
import { ForegroundServe } from "./foreground-serve.mjs";

const AUTH_URL = /https:\/\/(?:login|console)\.tailscale\.com\/[^\s"']+/;

// Windows' public route with browser sign-in
// (docs/parity/D-public-door.md §4.9): what EphemeralFunnel is on a Mac, held
// the way Windows holds its private route. A background Funnel route would
// outlive a crash with the route's key in Tailscale's state, so it's a
// foreground `tailscale funnel` session, Reach's own child, gone with Reach:
// no --bg, no janitor, no record file. Reach itself refuses the internet
// unless an invitation or agent session is live (server/index.mjs).
//
// Funnel not yet allowed for this computer: Tailscale says so with the page
// that allows it, then either ends (shown, tried again later) or waits until
// it's allowed (kept, never killed or started again meanwhile).
export class ForegroundFunnel {
  constructor({
    origin,
    target,
    window,
    redact = (text) => text,
    inspect = () => tailscaleJson(["serve", "status", "--json"], { redact }),
    spawnServe,
    report = () => {},
    log = null,
    // Called with true when the public route comes up and false when it goes.
    changed = () => {},
    lock = null,
    now = Date.now,
    every = setInterval,
    clearEvery = clearInterval,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ensureMs = 15000,
    inspectMs = 10000,
    waitMs = 20000,
    pollMs = 250,
    awaitPollMs = 2000,
  }) {
    Object.assign(this, { origin, target, window, redact, inspect, report, log, changed, now, every, clearEvery, delay, ensureMs, inspectMs });
    this.isLive = false;
    this.stopped = false;
    this.started = false;
    this.lastError = "";
    this.enableUrl = "";
    this.announced = new Set();
    this.nextStart = 0;
    this.attempt = 0;
    this.inspected = 0;
    this.holder = new ForegroundServe({
      file: "",
      origin,
      target,
      args: ["funnel", "--https=443", target],
      exact: exactForegroundFunnel,
      free: (config) => {
        if (funnelRoute(config, origin, target) !== "free") throw Error(CONFLICT);
      },
      inspect,
      ...(spawnServe && { spawnServe }),
      redact,
      lock,
      awaitEnable: true,
      awaiting: (url) => {
        this.enableUrl = url;
        this.warn(`Allow Tailscale Funnel for this computer: ${url}`);
        this.onAwaiting?.();
      },
      output: (text) => log?.write(text),
      exited: () => {
        this.live = false;
      },
      waitMs,
      pollMs,
      awaitPollMs,
    });
  }
  get live() {
    return this.isLive;
  }
  set live(value) {
    if (value === this.isLive) return;
    this.isLive = value;
    try {
      this.changed(value);
    } catch (error) {
      this.warn(error.message);
    }
  }
  activeWindow() {
    const value = this.window();
    return value?.open === true && Number.isFinite(value.until) && value.until > this.now() ? value : null;
  }
  // Each thing said once; a page to visit, once, however it's worded.
  warn(message) {
    const said = this.redact(message);
    const url = said.match(AUTH_URL)?.[0];
    if (said !== this.lastError && !(url && this.announced.has(url))) this.report(said);
    if (url) this.announced.add(url);
    this.lastError = said;
  }
  async start() {
    if (this.started || this.stopped) return this.live;
    this.started = true;
    this.monitor = this.every(() => {
      void this.sync().catch((error) => this.warn(error.message));
    }, 1000);
    this.monitor?.unref?.();
    return this.sync();
  }
  sync() {
    if (this.syncing) return this.syncing;
    this.syncing = this.synchronize().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }
  async synchronize() {
    if (this.stopped || !this.started) return false;
    const holder = this.holder;
    // Waiting for Funnel to be allowed, or on its way up: left alone.
    if (holder.awaitingEnable || holder.starting) return false;
    if (holder.alive) {
      if (this.live && this.now() - this.inspected < this.inspectMs) return true;
      let config;
      try {
        config = await this.inspect();
        this.inspected = this.now();
      } catch (error) {
        this.warn(error.message);
        return this.live;
      }
      if (this.stopped) return false;
      if (holder.owns(config)) return this.up();
      // Something else on 443 beside it: not ours to use.
      this.live = false;
      this.warn(CONFLICT);
      return false;
    }
    this.live = false;
    if (this.now() < this.nextStart) return false;
    this.nextStart = this.now() + Math.min(60000, 1500 * 2 ** Math.min(this.attempt++, 6));
    const awaiting = new Promise((resolve) => {
      this.onAwaiting = () => resolve("awaiting");
    });
    const attempt = holder.start().then(
      (up) => (up ? "up" : "stopped"),
      (error) => {
        this.warn(error.message);
        return "failed";
      },
    );
    const result = await Promise.race([attempt, awaiting]);
    this.onAwaiting = null;
    // Allowed later: the session comes up by itself (the next sync sees it).
    if (result === "up" && !this.stopped) {
      this.inspected = this.now();
      return this.up();
    }
    return false;
  }
  up() {
    if (!this.live) this.report("Public link on: the internet gets nothing until an invitation or agent session is live.");
    this.live = true;
    this.lastError = "";
    this.enableUrl = "";
    this.attempt = 0;
    return true;
  }
  async ensure() {
    if (this.stopped) throw Error("Agent sharing has stopped.");
    if (!this.started) await this.start();
    const deadline = this.now() + this.ensureMs;
    while (!this.stopped && this.now() < deadline) {
      if (!this.activeWindow()) throw Error("This agent invitation or session has ended.");
      if (await this.sync()) return true;
      if (this.lastError === CONFLICT) throw Error(CONFLICT);
      if (this.enableUrl) throw Error(`Tailscale Funnel isn't allowed for this computer yet: ${this.enableUrl}`);
      await this.delay(250);
    }
    throw Error(this.lastError || "The temporary Tailscale connection could not start. Try creating a new agent invitation.");
  }
  async stop() {
    this.stopped = true;
    this.clearEvery(this.monitor);
    await this.holder.stop();
    this.live = false;
  }
}
