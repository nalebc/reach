import fs from "node:fs";
import path from "node:path";
import { sessionAlive } from "./fake-tailscale.mjs";

// The peer check (server/tailscaled-peer.mjs) for a Reach run against the
// stand-in Tailscale (test/helpers/fake-tailscale.mjs): a connection is
// "Tailscale's own" when one of the stand-in's live sessions opened it (its
// proxy notes each connection's local port and when) no later than Reach
// accepted it, within the real check's 20 ms. `problem`: ready() says no.
// `unrecognised`: ready, but no connection is ever Tailscale's own:
// "other" answers that another program owns it, "late" never answers in
// time. `onAnswer`: launch's hook, told each answer as the real check tells it.
const SESSION = /^fake-tailscale-session-\d+\.json$/;
const opened = (dir, port) => {
  for (const name of fs.readdirSync(dir).filter((f) => SESSION.test(f))) {
    try {
      const session = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      if (!sessionAlive(session)) continue;
      const found = (session.from || []).find((entry) => entry.port === port);
      if (found) return found;
    } catch {}
  }
  return null;
};
export function fakePeerCheck(dir, { problem = "", log = "", unrecognised = "", onAnswer = () => {} } = {}) {
  let closed = false;
  const note = (entry) => {
    if (log) fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
  };
  return {
    ready: async () => (problem ? { ok: false, reason: problem } : { ok: true }),
    async check(socket, acceptedAt) {
      if (unrecognised === "other") onAnswer({ port: socket?.remotePort, value: "o", ok: false });
      if (closed || unrecognised || socket?.remoteAddress !== "127.0.0.1" || !Number.isFinite(acceptedAt)) return false;
      // The proxy notes a connection a moment after it opens: looked for a while.
      for (const until = Date.now() + 500; Date.now() < until; ) {
        const found = opened(dir, socket.remotePort);
        if (found) {
          const ok = found.at <= acceptedAt + 20;
          note({ port: socket.remotePort, acceptedAt, at: found.at, ok });
          onAnswer({ port: socket.remotePort, value: "t", ok });
          return ok;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      note({ port: socket.remotePort, acceptedAt, ok: false });
      return false;
    },
    async close() {
      closed = true;
      note({ closed: Date.now() });
    },
  };
}
