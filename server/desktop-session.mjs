import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import { desktopBinary } from "./desktop-native.mjs";
import { fail } from "./core.mjs";
import { tailscaleJson } from "../scripts/tailscale.mjs";
const exec = promisify(execFile);
export function desktopSettings(value = {}) {
  const { mode = "match", width, height, clipboard = false } = value;
  if (
    !["match", "mirror"].includes(mode) ||
    typeof clipboard !== "boolean" ||
    ![width, height].every(
      (n) => Number.isInteger(n) && n >= 640 && n <= 3840,
    ) ||
    width * height > 9000000
  )
    throw fail(400, "Invalid iPad display settings.");
  return {
    mode,
    width: width - (width % 2),
    height: height - (height % 2),
    clipboard,
  };
}
export async function nativeDesktopSession(config, options, ended) {
  if (process.platform !== "darwin")
    throw fail(501, "iPad Desktop mode requires a Mac host.");
  const child = spawn(
    await desktopBinary(config, "desktop-session"),
    [options.mode, String(options.width), String(options.height)],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  return await new Promise((resolve, reject) => {
    let settled = false,
      buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(fail(503, "The Mac desktop did not become ready."));
    }, 10000);
    const stopped = () => {
      clearTimeout(timer);
      if (!settled)
        reject(
          fail(503, "Desktop indicator or virtual display could not start."),
        );
      ended();
    };
    child.once("exit", stopped);
    child.once("error", stopped);
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.stdout.on("data", (data) => {
      buffer += data.toString();
      if (buffer.length > 8192) return child.kill();
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const value = JSON.parse(line);
          if (value.error) {
            reject(fail(503, value.error));
            child.kill();
          } else if (value.type === "disconnect") ended();
          else if (
            !settled &&
            value.type === "ready" &&
            /^\d+$/.test(value.display)
          ) {
            settled = true;
            clearTimeout(timer);
            resolve({
              ...value,
              update: (label) =>
                child.stdin.write(JSON.stringify({ label }) + "\n"),
              stop: () => {
                child.stdin.end();
                child.kill();
                const force = setTimeout(() => child.kill("SIGKILL"), 3000);
                force.unref();
                child.once("exit", () => clearTimeout(force));
              },
            });
          }
        } catch {
          child.kill();
        }
      }
    });
  });
}
// Session IDs are not credentials. Every attach/operation rechecks the owning credential
// and the separate ScreenControl lease. A local disconnect invalidates the ID permanently.
export class DesktopSessions {
  constructor(
    config,
    {
      create = nativeDesktopSession,
      grace = 3500,
      onEnd = () => {},
      controls = () => false,
    } = {},
  ) {
    Object.assign(this, { config, create, grace, onEnd, controls });
    this.sessions = new Map();
    this.timer = setInterval(() => this.tick(), 1000);
    this.timer.unref();
  }
  async open(client, value, authorize) {
    if (!client.scopes.includes("admin"))
      throw fail(403, "Only paired owners can prepare a desktop session.");
    if (this.sessions.size)
      throw fail(
        409,
        "A desktop session is already connected. Disconnect it first.",
      );
    const options = desktopSettings(value),
      id = crypto.randomUUID();
    const session = {
      id,
      clientId: client.id,
      name: client.name || "A device",
      options,
      authorize,
      sockets: new Set(),
      deadline: Date.now() + 15000,
    };
    this.sessions.set(id, session);
    try {
      const helper = await this.create(this.config, options, () =>
        this.end(id),
      );
      if (!this.sessions.has(id)) {
        helper.stop();
        throw fail(403, "Desktop session ended.");
      }
      session.helper = helper;
      authorize();
      session.display = helper.display;
      helper.update(`${session.name} is viewing this Mac`);
      return {
        id,
        display: session.display,
        virtual: helper.virtual,
        ...options,
      };
    } catch (e) {
      this.end(id);
      throw e;
    }
  }
  get(id, client) {
    const s = this.sessions.get(id);
    if (!s || s.clientId !== client.id || !s.helper)
      throw fail(403, "Desktop session ended. Open Desktop mode again.");
    s.authorize();
    return s;
  }
  attach(id, client, ws) {
    const s = this.get(id, client);
    s.sockets.add(ws);
    s.deadline = Infinity;
    ws.once("close", () => {
      s.sockets.delete(ws);
      if (!s.sockets.size) s.deadline = Date.now() + this.grace;
    });
    return s;
  }
  tick() {
    for (const s of this.sessions.values()) {
      try {
        s.authorize();
        if (Date.now() > s.deadline) {
          this.end(s.id);
          continue;
        }
        s.helper?.update(
          `${s.name} is ${this.controls(s.clientId) ? "controlling" : "viewing"} this Mac`,
        );
      } catch {
        this.end(s.id);
      }
    }
  }
  end(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this.onEnd(s.clientId);
    for (const ws of s.sockets) {
      ws.endControl?.();
      ws.close(4003, "Desktop session ended");
    }
    s.helper?.stop();
  }
  revoke(clientId) {
    for (const s of this.sessions.values())
      if (!clientId || s.clientId === clientId) this.end(s.id);
  }
  close() {
    clearInterval(this.timer);
    this.revoke();
  }
}
export function peerRoute(status, ip) {
  const peer = Object.values(status.Peer || {}).find((p) =>
    p.TailscaleIPs?.includes(ip),
  );
  if (!peer || !peer.Online) return "Unknown";
  // Relay contains the home DERP even when direct: CurrAddr takes precedence.
  return peer.CurAddr ? "Direct" : peer.Relay ? "Relayed" : "Unknown";
}
let cached,
  cachedAt = 0;
export async function connectionRoute(req) {
  // Serve replaces X-Forwarded-For with the tailnet source IP. Used for diagnostics
  // only, never as authorization. Unknown is preferable to guessing the client's peer.
  const ip = String(req.headers["x-forwarded-for"] || "")
    .split(",")
    .at(-1)
    .trim();
  if (!ip) return "Unknown";
  try {
    if (Date.now() - cachedAt > 2000) {
      cached = await tailscaleJson(["status", "--json"]);
      cachedAt = Date.now();
    }
    return peerRoute(cached, ip);
  } catch {
    return "Unknown";
  }
}
export async function desktopPreparation(config) {
  if (process.platform !== "darwin")
    throw fail(501, "Desktop preparation requires macOS.");
  const read = async (command, args) => {
    try {
      return (await exec(command, args, { timeout: 5000, maxBuffer: 65536 }))
        .stdout;
    } catch {
      return "";
    }
  };
  const [power, filevault, probe, assertions] = await Promise.all([
    read("/usr/bin/pmset", ["-g", "custom"]),
    read("/usr/bin/fdesetup", ["status"]),
    read(await desktopBinary(config, "desktop-session"), ["--probe"]),
    read("/usr/bin/pmset", ["-g", "assertions"]),
  ]);
  const ac = power.split("AC Power:")[1] || power;
  const display = JSON.parse(probe || "{}");
  return {
    virtualDisplay: display,
    checks: [
      {
        id: "display",
        ready: display.headless === false,
        title: "Display",
        instruction: display.headless
          ? "No physical display detected. Desktop mode automatically creates a virtual display. If macOS refuses it, use an HDMI dummy plug."
          : "A display is connected. Match iPad creates a temporary display; Mirror shares your existing screen.",
      },
      {
        id: "sleep",
        ready:
          /PreventUserIdleDisplaySleep\s+1\b/.test(assertions) &&
          /PreventUserIdleSystemSleep\s+1\b/.test(assertions),
        title: "System and display sleep prevention",
        instruction:
          "Reach keeps the system and display awake by default while running. Explicit --stay-awake restricts prevention to AC power; --no-stay-awake allows idle sleep. This does not unlock a locked Mac.",
      },
      {
        id: "power",
        ready: /autorestart\s+1\b/.test(ac),
        title: "Start after power failure",
        instruction:
          "On Mac mini, enable Start up automatically after a power failure in System Settings → Energy. This may require an administrator.",
      },
      {
        id: "lock",
        ready: null,
        title: "Screen lock",
        instruction:
          "macOS may pause capture when locked. Keep the signed-in desktop available if appropriate for your environment. Reach never bypasses the lock screen or changes lock settings.",
      },
      {
        id: "filevault",
        ready: /FileVault is Off/.test(filevault) ? true : null,
        title: "After a restart",
        instruction: /FileVault is On/.test(filevault)
          ? "FileVault is on. Someone must enter the disk password locally after a reboot before Reach and Tailscale can start."
          : "Confirm login and background startup before leaving. Reach cannot unlock FileVault or sign in after reboot.",
      },
    ],
  };
}
