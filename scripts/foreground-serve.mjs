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

// Windows has no Unix socket: Reach's private route leads to its local
// address (http://127.0.0.1:<port>), where any user of this PC can listen
// once Reach is gone. A background Serve route outlives Reach (a stop, a
// crash, a reboot) and would hand the real *.ts.net address, with the
// owner's saved Reach sign-in on it, to whatever answers there next. So on
// Windows the route is a foreground Serve session: `tailscale serve` without
// --bg, run as Reach's own (non-detached) child. tailscaled drops the session
// when that process ends, and Windows ends it with Reach (Node keeps its
// children in a kill-on-close job object), crash and reboot included.
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
  }) {
    Object.assign(this, { file, origin, target, inspect, run, spawnServe, output, exited, waitMs, pollMs });
    this.port = Number(new URL(origin).port || 443);
    this.held = null;
    this.stopped = false;
    this.starting = null;
  }
  get alive() {
    return !!this.held && !this.held.done;
  }
  // Ours: the exact route, in a session while our child still holds it.
  owns(config, origin = this.origin, target = this.target) {
    return this.alive && exactForegroundRoute(config, origin, target);
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
    let config = await this.inspect();
    // The session of the child just ended goes with it, in a moment.
    for (let until = Date.now() + 2000; exactForegroundRoute(config, this.origin, this.target) && Date.now() < until; ) {
      await delay(this.pollMs);
      config = await this.inspect();
    }
    if (recordedRouteOwned(this.file, config, this.origin)) {
      // An older Reach's background route, recorded as its own: switched off
      // once, whatever its target. Nobody else's route on the port ever is.
      await this.run(["serve", `--https=${this.port}`, "off"]);
      config = await this.inspect();
    }
    assertUnusedPort(config, this.port);
    // Nothing left to record: this route ends with Reach.
    fs.rmSync(this.file, { force: true });
    if (this.stopped) return false;
    const held = { child: this.spawnServe(["serve", `--https=${this.port}`, this.target]), done: false, up: false, ending: false, said: "", error: null };
    this.held = held;
    const hear = (chunk) => {
      held.said += chunk;
      this.output(String(chunk));
    };
    held.child.stdout?.on("data", hear);
    held.child.stderr?.on("data", hear);
    held.ended = new Promise((resolve) => {
      const end = (code, signal) => {
        if (held.done) return;
        held.done = true;
        if (code instanceof Error) held.error = code;
        resolve();
        if (held.up && !held.ending && !this.stopped) this.exited(held.error ? held.error.message : signal || code);
      };
      held.child.once("error", end);
      held.child.once("exit", end);
    });
    for (const deadline = Date.now() + this.waitMs; ; ) {
      if (this.stopped) return false;
      if (held.done) {
        if (held.error?.code === "ENOENT")
          throw Error("Tailscale is unavailable. Install and sign in to Tailscale on this computer, then rerun Reach.");
        throw Error(tailscaleSaid(held.said) || held.error?.message || "Tailscale refused the change.");
      }
      try {
        if (exactForegroundRoute(await this.inspect(), this.origin, this.target)) {
          held.up = true;
          return true;
        }
      } catch {}
      if (Date.now() >= deadline) {
        await this.end();
        throw Error(tailscaleSaid(held.said) || "Tailscale took too long to answer.");
      }
      await Promise.race([delay(this.pollMs), held.ended]);
    }
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
