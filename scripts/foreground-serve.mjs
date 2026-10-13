import fs from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { tailscaleCli, tailscaleJson, assertUnusedPort } from "./tailscale.mjs";
import {
  exactForegroundRoute,
  recordedRouteOwned,
  runTailscale,
  tailscaleSaid,
} from "./persistent-serve.mjs";

// A page Tailscale asks you to visit (turn Funnel on for this computer).
const AUTH_URL = /https:\/\/(?:login|console)\.tailscale\.com\/[^\s"']+/;
// Two `tailscale serve` changing the serve config at once: one is told to
// try again (each reads it, then writes it only if nobody else did).
const ETAG = /Another client is changing the serve config/;

// One change of Tailscale's serve config at a time across Reach's sessions
// (Windows' private route and its Funnel). `fn(release)` may let the next one
// go before it finishes (a session waiting for Funnel to be allowed).
export function createLock() {
  let tail = Promise.resolve();
  return (fn) => {
    let release;
    const released = new Promise((resolve) => (release = resolve));
    const before = tail;
    tail = before.then(() => released);
    return before.then(() => fn(release)).finally(release);
  };
}

// Windows has no Unix socket: Reach's private route leads to its local
// address (http://127.0.0.1:<port>), where any user of this PC can listen
// once Reach is gone. A background Serve route outlives Reach (a stop, a
// crash, a reboot) and would hand the real *.ts.net address, with the
// owner's saved Reach sign-in on it, to whatever answers there next. So on
// Windows the route is a foreground Serve session: `tailscale serve` without
// --bg, run as Reach's own (non-detached) child. tailscaled drops the session
// when that process ends, and Windows ends it with Reach (Node keeps its
// children in a kill-on-close job object), crash and reboot included.
//
// With browser sign-in (REACH_WINDOWS_ACCOUNT=1) the route's target carries
// its key: everything Tailscale says is redacted line by line before it's
// shown or kept, and the public route (scripts/foreground-funnel.mjs) is held
// the same way, its command and checks passed in.
export class ForegroundServe {
  constructor({
    file,
    origin,
    target,
    inspect = () => tailscaleJson(["serve", "status", "--json"]),
    run = runTailscale,
    spawnServe = (args) =>
      spawn(tailscaleCli(), args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }),
    // Its words as they come (a setup page to open, its log).
    output = () => {},
    // It ended by itself after the route was up.
    exited = () => {},
    waitMs = 20000,
    pollMs = 250,
    // While it waits for Funnel to be allowed: the config is read less often.
    awaitPollMs = 2000,
    // The command, the exact session it makes, and what must be free first.
    args,
    exact = exactForegroundRoute,
    free,
    // Takes the route's key out of Tailscale's words (keyed mode only).
    redact,
    // Shared with the other session: one config change at a time.
    lock = null,
    // Funnel: a session that prints the page allowing Funnel and waits is
    // kept, past waitMs, until it's allowed (awaiting(url), once).
    awaitEnable = false,
    awaiting = () => {},
  }) {
    Object.assign(this, { file, origin, target, inspect, run, spawnServe, output, exited, waitMs, pollMs, awaitPollMs, exact, lock, awaitEnable, awaiting });
    this.port = Number(new URL(origin).port || 443);
    this.args = args || ["serve", `--https=${this.port}`, target];
    this.free = free || ((config) => assertUnusedPort(config, this.port));
    this.redacting = typeof redact === "function";
    this.redact = redact || ((text) => text);
    this.held = null;
    this.stopped = false;
    this.starting = null;
  }
  get alive() {
    return !!this.held && !this.held.done;
  }
  // Alive, and waiting for Funnel to be allowed for this computer.
  get awaitingEnable() {
    return this.alive && !!this.held.awaiting;
  }
  // Ours: the exact route, in a session while our child still holds it.
  owns(config, origin = this.origin, target = this.target) {
    return this.alive && this.exact(config, origin, target);
  }
  start() {
    this.starting ??= this.open().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }
  // Resolves true once the route is up, false if Reach stopped meanwhile.
  async open() {
    await this.end();
    if (this.stopped) return false;
    return this.lock ? this.lock((release) => this.hold(release)) : this.hold(() => {});
  }
  async hold(release) {
    let config = await this.inspect();
    // The session of the child just ended goes with it, in a moment.
    for (let until = Date.now() + 2000; this.exact(config, this.origin, this.target) && Date.now() < until; ) {
      await delay(this.pollMs);
      config = await this.inspect();
    }
    if (this.file && recordedRouteOwned(this.file, config, this.origin)) {
      // An older Reach's background route, recorded as its own: switched off
      // once, whatever its target. Nobody else's route on the port ever is.
      await this.run(["serve", `--https=${this.port}`, "off"]);
      config = await this.inspect();
    }
    this.free(config);
    // Nothing left to record: this route ends with Reach.
    if (this.file) fs.rmSync(this.file, { force: true });
    // Told to try again (another session changed the config at that moment):
    // tried again at once, a few times, still holding the lock.
    for (let attempt = 1; ; attempt++) {
      if (this.stopped) return false;
      const result = await this.watch(release, attempt >= 3);
      if (result !== "again") return result;
      await delay(250);
    }
  }
  async watch(release, last) {
    const held = { child: this.spawnServe(this.args), done: false, up: false, ending: false, said: "", error: null, awaiting: false };
    this.held = held;
    let pending = "";
    const hear = (chunk) => {
      const text = String(chunk);
      held.said += text;
      if (!this.redacting) this.output(text);
      // Line by line: a key can be cut between two chunks, never in a line.
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (this.redacting) this.output(this.redact(line) + "\n");
        this.noticeEnable(held, line);
      }
      if (pending.length > 8192) pending = ""; // dropped, never shown in part
    };
    held.child.stdout?.on("data", hear);
    held.child.stderr?.on("data", hear);
    held.ended = new Promise((resolve) => {
      const end = (code, signal) => {
        if (held.done) return;
        held.done = true;
        if (code instanceof Error) held.error = code;
        if (pending && this.redacting) this.output(this.redact(pending));
        pending = "";
        resolve();
        if (held.up && !held.ending && !this.stopped)
          this.exited(this.redact(held.error ? held.error.message : String(signal || code)));
      };
      held.child.once("error", end);
      held.child.once("exit", end);
    });
    for (let deadline = Date.now() + this.waitMs; ; ) {
      if (this.stopped) return false;
      if (held.done) {
        if (!held.up && !last && ETAG.test(held.said)) return "again";
        if (held.error?.code === "ENOENT")
          throw Error("Tailscale is unavailable. Install and sign in to Tailscale on this computer, then rerun Reach.");
        // A spawn error's own fields carry the command line, key included:
        // only its message, redacted, is ever said.
        throw Error(tailscaleSaid(held.said, this.redact) || this.redact(held.error?.message || "") || "Tailscale refused the change.");
      }
      try {
        if (this.exact(await this.inspect(), this.origin, this.target)) {
          held.up = true;
          held.awaiting = false;
          return true;
        }
      } catch {}
      // Waiting for Funnel to be allowed: the other session may go meanwhile,
      // and no deadline ends this one.
      if (held.awaiting) release();
      else if (Date.now() >= deadline) {
        await this.end();
        throw Error(tailscaleSaid(held.said, this.redact) || "Tailscale took too long to answer.");
      }
      await Promise.race([delay(held.awaiting ? this.awaitPollMs : this.pollMs), held.ended]);
    }
  }
  noticeEnable(held, line) {
    if (!this.awaitEnable || held.done || held.awaiting) return;
    const url = line.match(AUTH_URL)?.[0];
    if (!url) return;
    held.awaiting = true;
    this.awaiting(url);
  }
  // Ends the session: its process goes, and Tailscale drops the route.
  async end() {
    const held = this.held;
    this.held = null;
    if (!held || held.done) return;
    held.ending = true;
    held.child.kill();
    await Promise.race([held.ended, delay(2000)]);
    if (!held.done) {
      held.child.kill("SIGKILL");
      await Promise.race([held.ended, delay(1000)]);
    }
  }
  async stop() {
    this.stopped = true;
    await this.end();
  }
}
