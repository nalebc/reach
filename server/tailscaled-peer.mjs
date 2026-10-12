import { spawnVerified } from "./desktop-native.mjs";

// Is a connection to Reach's keyed route from Tailscale's own process?
// Windows only (docs/parity/D-public-door.md §4.3 and §6): asked of a small
// helper (scripts/native/tailscaled-peer.cs), started once and kept, one line
// per batch of connections. A connection counts only when the helper says
// Tailscale's service (or its daemon child) owns it AND made it no later than
// Reach accepted it: a client that reset its connection can't lend its
// address pair to the next one Tailscale opens. Anything else, a helper that
// won't start, answers late, garbles or stops, is a no.
const ANSWER = /^a (\d{1,9})((?: \d{1,5}:(?:t:\d{1,15}|[ogne]))+)$/;
const SET_UP = (code) => `Tailscale's Windows service isn't set up the usual way (${code}).`;
const REASONS = {
  "no-service": "Tailscale isn't installed as a Windows service here.",
  "not-running": "Tailscale's Windows service isn't running.",
  "not-own-process": SET_UP("not-own-process"),
  "not-localsystem": SET_UP("not-localsystem"),
  "not-tailscaled": SET_UP("not-tailscaled"),
  access:
    "Windows didn't let Reach read Tailscale's service settings. This happens when Reach runs outside a signed-in Windows session (over SSH, or as a scheduled task); start it from a Terminal window on the PC.",
  arch: "This Windows isn't 64-bit.",
  arch32: "Reach's Tailscale check was built as 32-bit (arch32).",
};
// Smart App Control or App Control blocking it, a file changed on disk, …
const couldntStart = (why) => `Reach's Tailscale check couldn't start (${why}).`;
const startError = (error) =>
  couldntStart(error?.code === "ECHANGED" ? "it changed on disk" : error?.code || error?.message || "unknown");
export const peerCheckReason = (code) => REASONS[code] || couldntStart(code);
const loopback = (address) => address === "127.0.0.1";
const validPort = (port) => Number.isInteger(port) && port > 0 && port <= 65535;

export function createTailscaledPeerCheck({
  platform = process.platform,
  // () => Promise<{ file, sha256 }>: built in Reach's private folder
  // (server/windows-private-folder.mjs).
  helper,
  // Hashed again right before every start, restarts included.
  spawnHelper = ({ file, sha256 }) =>
    spawnVerified(file, sha256, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true }),
  readyMs = 30000,
  answerMs = 3000,
  restartMs = 5000,
  // The kernel stamps connections with the coarse system clock (~15.6 ms).
  slackMs = 20,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  // Once per distinct reason: the helper stopped, or didn't answer in time.
  onProblem = () => {},
  // Each answer as the helper gave it (Windows CI records them).
  onAnswer = () => {},
} = {}) {
  let child = null;
  let live = false;
  let closed = false;
  let starting = null;
  let first = null;
  let restartTimer = null;
  let nextId = 0;
  let queue = [];
  let flushing = false;
  const inflight = new Map(); // id -> { waiters: Map<port, [{ acceptedAt, resolve }]>, timer }
  const said = new Set();
  const problem = (reason) => {
    if (said.has(reason)) return;
    said.add(reason);
    try {
      onProblem(reason);
    } catch {}
  };
  const failAll = () => {
    for (const entry of inflight.values()) {
      clearTimer(entry.timer);
      for (const list of entry.waiters.values()) for (const waiter of list) waiter.resolve(false);
    }
    inflight.clear();
    for (const waiter of queue) waiter.resolve(false);
    queue = [];
  };
  const scheduleRestart = () => {
    if (closed || restartTimer) return;
    restartTimer = setTimer(() => {
      restartTimer = null;
      void start().then((result) => {
        if (!result.ok) {
          problem(result.reason);
          scheduleRestart();
        }
      });
    }, restartMs);
    restartTimer?.unref?.();
  };
  // This helper is done: whatever it was asked is a no, and a new one starts
  // after restartMs (unless Reach is stopping).
  const drop = (c, why) => {
    try {
      c.kill();
    } catch {}
    if (child !== c) return;
    child = null;
    live = false;
    failAll();
    if (closed) return;
    problem(why);
    scheduleRestart();
  };
  const answered = (c, line) => {
    const match = ANSWER.exec(line);
    if (!match) return drop(c, "garbled");
    const id = Number(match[1]);
    const entry = inflight.get(id);
    if (!entry) return; // not asked (or already given up on): ignored
    inflight.delete(id);
    clearTimer(entry.timer);
    for (const part of match[2].trim().split(" ")) {
      const [port, value, ms] = part.split(":");
      const list = entry.waiters.get(Number(port));
      if (!list) continue;
      entry.waiters.delete(Number(port));
      for (const waiter of list) {
        const ok = value === "t" && Number(ms) > 0 && Number(ms) <= waiter.acceptedAt + slackMs;
        try {
          onAnswer({ port: waiter.port, ingress: waiter.ingress, value, createdMs: value === "t" ? Number(ms) : 0, acceptedAt: waiter.acceptedAt, ok });
        } catch {}
        waiter.resolve(ok);
      }
    }
    // Asked but not answered: no.
    for (const list of entry.waiters.values()) for (const waiter of list) waiter.resolve(false);
  };
  async function launch() {
    let built;
    try {
      built = await helper();
    } catch (error) {
      return { ok: false, reason: startError(error) };
    }
    if (closed) return { ok: false, reason: "Reach is stopping." };
    let c;
    try {
      c = spawnHelper(built);
    } catch (error) {
      return { ok: false, reason: startError(error) };
    }
    child = c;
    return new Promise((resolve) => {
      let ready = false;
      let settled = false;
      const timer = setTimer(() => finish({ ok: false, reason: "Reach's Tailscale check didn't answer." }), readyMs);
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        if (result.ok && child === c) {
          ready = live = true;
        } else if (child === c) {
          child = null;
          try {
            c.kill();
          } catch {}
        }
        resolve(child === c ? result : result.ok ? { ok: false, reason: "Reach's Tailscale check stopped." } : result);
      };
      let buffer = "";
      c.stdout?.setEncoding?.("latin1");
      c.stdout?.on("data", (chunk) => {
        buffer += chunk;
        // An answer is a few hundred bytes: anything this long is not one.
        if (buffer.length > 65536) return ready ? drop(c, "garbled") : finish({ ok: false, reason: couldntStart("unexpected answer") });
        let at;
        while ((at = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, at).replace(/\r$/, "");
          buffer = buffer.slice(at + 1);
          if (line.length > 4096) return ready ? drop(c, "garbled") : finish({ ok: false, reason: couldntStart("unexpected answer") });
          if (ready) {
            answered(c, line);
            if (child !== c) return;
            continue;
          }
          if (line === "ready 1") finish({ ok: true });
          else {
            const error = /^error ([a-z0-9-]{1,40})$/.exec(line);
            return finish({ ok: false, reason: error ? peerCheckReason(error[1]) : couldntStart("unexpected answer") });
          }
        }
        if (buffer.length > 4096) return ready ? drop(c, "garbled") : finish({ ok: false, reason: couldntStart("unexpected answer") });
      });
      c.stdin?.on?.("error", () => {});
      c.once("error", (error) => {
        finish({ ok: false, reason: startError(error) });
        drop(c, "stopped");
      });
      c.once("exit", () => {
        finish({ ok: false, reason: "Reach's Tailscale check stopped." });
        drop(c, "stopped");
      });
    });
  }
  const start = () => {
    starting ??= launch().finally(() => {
      starting = null;
    });
    return starting;
  };
  const flush = () => {
    flushing = false;
    const batch = queue;
    queue = [];
    const c = child;
    if (!live || !c) {
      for (const waiter of batch) waiter.resolve(false);
      return;
    }
    // One line per Reach port, at most 64 connections each.
    const byIngress = new Map();
    for (const waiter of batch) {
      if (!byIngress.has(waiter.ingress)) byIngress.set(waiter.ingress, new Map());
      const ports = byIngress.get(waiter.ingress);
      if (!ports.has(waiter.port)) ports.set(waiter.port, []);
      ports.get(waiter.port).push(waiter);
    }
    for (const [ingress, ports] of byIngress) {
      const listed = [...ports.keys()];
      for (let i = 0; i < listed.length; i += 64) {
        const slice = listed.slice(i, i + 64);
        nextId = nextId >= 999999999 ? 1 : nextId + 1;
        const id = nextId;
        const entry = { waiters: new Map(slice.map((port) => [port, ports.get(port)])), timer: null };
        entry.timer = setTimer(() => {
          if (!inflight.has(id)) return;
          // Late: this batch is a no, and the helper is replaced.
          drop(c, "timeout");
        }, answerMs);
        entry.timer?.unref?.();
        inflight.set(id, entry);
        try {
          c.stdin.write(`q ${id} ${ingress} ${slice.join(",")}\n`);
        } catch {
          return drop(c, "stopped");
        }
      }
    }
  };
  return {
    ready() {
      if (platform !== "win32") return Promise.resolve({ ok: false, reason: "Windows only." });
      first ??= start();
      return first;
    },
    // true only for a live connection between two loopback addresses that
    // Tailscale's own process made no later than Reach accepted it.
    check(socket, acceptedAt) {
      if (platform !== "win32" || closed || !live || !child) return Promise.resolve(false);
      if (!loopback(socket?.remoteAddress) || !loopback(socket?.localAddress)) return Promise.resolve(false);
      const port = socket.remotePort;
      const ingress = socket.localPort;
      if (!validPort(port) || !validPort(ingress) || !Number.isFinite(acceptedAt) || acceptedAt <= 0)
        return Promise.resolve(false);
      return new Promise((resolve) => {
        queue.push({ port, ingress, acceptedAt, resolve });
        if (!flushing) {
          flushing = true;
          setImmediate(flush);
        }
      });
    },
    async close() {
      closed = true;
      clearTimer(restartTimer);
      restartTimer = null;
      const c = child;
      child = null;
      live = false;
      failAll();
      if (!c) return;
      const exited = new Promise((resolve) => {
        if (c.exitCode != null || c.signalCode != null) return resolve();
        c.once("exit", resolve);
        setTimeout(resolve, 1000).unref?.();
      });
      try {
        c.stdin?.end();
      } catch {}
      try {
        c.kill();
      } catch {}
      await exited;
    },
  };
}
