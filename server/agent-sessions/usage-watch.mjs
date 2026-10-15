// "Notify me when it's back": an agent out of usage, watched from the Mac
// (phones may all be closed) until its limit resets, then one notification.
// Asked from the phone's out-of-usage line; kept across restarts. Its reset
// time only says when to look: back is the Mac's own fresh reading, and a
// reading that fails is never back.
import fs from "node:fs";
import { agentName } from "../notification-items.mjs";

const MINUTE = 60000;
// A week's limit is the longest; a request older than that has no use.
const KEEP_MS = 8 * 24 * 60 * MINUTE;

export function usageBack(health, { resetsAt = null, now = Date.now() } = {}) {
  // The agent's own word (what the message box goes by), then its meters.
  if (!health?.signedIn || health.usable === false) return false;
  // Meters that couldn't be read leave `usable` unknown, so it says nothing
  // then: only a reset time that has passed does. (Claude's sign-in renews
  // only while Claude Code runs, so its meters stay unread until you open it;
  // the reset time is what lets "back" arrive on time, Oct 14.)
  if (health.usage?.available === false) return !!resetsAt && resetsAt <= now;
  if (health.usable !== true) return false;
  return !(health.usage?.windows || []).some((w) => w.usedPercent >= 100);
}

// When a limit resets, as the Mac reads it: its own word first, else the
// fullest window that is used up.
export const resetOf = (health) =>
  health?.resetsAt ??
  (health?.usage?.windows || []).filter((w) => w.usedPercent >= 100 && w.resetsAt).map((w) => w.resetsAt).sort((a, b) => b - a)[0] ??
  null;

export function createUsageWatch({
  health,
  notify,
  file = null,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let wanted = {}; // agent -> { session, at, resetsAt }
  try {
    if (file) wanted = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {}
  let timer = null, looking = null, closed = false;
  const save = () => {
    if (!file) return;
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(wanted), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch {
      /* A read-only disk must not interrupt agent work. */
    }
  };
  // Shortly after the reset, else every minute; never more than 15 minutes
  // apart, since a reset can come early (a plan change, a reset spent).
  const schedule = () => {
    clearTimer(timer);
    timer = null;
    const entries = Object.values(wanted);
    if (closed || !entries.length) return;
    const t = now();
    const delay = Math.min(...entries.map((w) =>
      w.resetsAt && w.resetsAt > t ? Math.min(w.resetsAt - t + 30000, 15 * MINUTE) : MINUTE));
    timer = setTimer(() => void look(), Math.max(1000, delay));
    timer?.unref?.();
  };
  const look = () => {
    if (looking) return looking;
    looking = (async () => {
      if (closed || !Object.keys(wanted).length) return;
      let list;
      try {
        list = await health();
      } catch {
        return;
      }
      let changed = false;
      for (const [agent, w] of Object.entries(wanted)) {
        if (closed) break;
        if (wanted[agent] !== w) continue;
        if (now() - w.at > KEEP_MS) {
          delete wanted[agent];
          changed = true;
          continue;
        }
        const h = (list || []).find((x) => x.agent === agent);
        if (!usageBack(h, { resetsAt: w.resetsAt, now: now() })) {
          const resetsAt = resetOf(h);
          if (resetsAt && resetsAt !== w.resetsAt && h.usage?.available !== false) (w.resetsAt = resetsAt), (changed = true);
          continue;
        }
        const app = agentName(agent);
        const result = await Promise.resolve()
          .then(() => closed || wanted[agent] !== w ? null : notify({
            // Its own switch-free kind: you asked for this one alert, so
            // turning off "Finished" doesn't silence it (push.mjs).
            category: "usage",
            title: `${app} is back`,
            body: `Your ${app} limit reset. You can send messages again.`,
            icon: agent,
            actions: [{ action: "open", title: w.session ? "Open conversation" : "Open" }],
            tag: `usage-back-${agent}`,
            url: `/?page=sessions&agent=${encodeURIComponent(agent)}${w.session ? `&id=${encodeURIComponent(w.session)}` : ""}`,
          }))
          .catch(() => null);
        // Nothing reached a phone: try again at the next look.
        if (wanted[agent] === w && (result?.sent > 0 || result?.suppressed > 0)) {
          delete wanted[agent];
          changed = true;
        }
      }
      if (changed) save();
    })().finally(() => {
      looking = null;
      schedule();
    });
    return looking;
  };
  return {
    // Whether a notification is asked for this agent.
    has: (agent) => !!wanted[agent],
    add(agent, { session = null, resetsAt = null } = {}) {
      wanted[agent] = {
        session: typeof session === "string" && session ? session.slice(0, 200) : null,
        at: now(),
        resetsAt: Number.isFinite(resetsAt) ? resetsAt : null,
      };
      save();
      schedule();
    },
    remove(agent) {
      if (!wanted[agent]) return;
      delete wanted[agent];
      save();
      schedule();
    },
    look,
    start: schedule,
    stop() {
      closed = true;
      clearTimer(timer);
    },
  };
}
