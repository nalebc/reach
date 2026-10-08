// What every agent did while you were away (docs/ACROSS_AGENTS.md): each
// turn that ended (with a reply, an error, a used-up limit, or stopped), with
// how many files it changed, and each relay step. Kept a week in Reach's data
// folder; the phone asks for what came since it last looked.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { changedFiles, usageLimited } from "./turn-watch.mjs";

export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const MAX = 500;

// A turn's end as one line of the journal.
export function turnEvent({ session: s, outcome }, at = Date.now()) {
  const kind =
    outcome.kind === "reply"
      ? "finished"
      : outcome.kind === "stopped"
        ? "stopped"
        : outcome.kind === "error"
          ? usageLimited(s.agent, outcome.item)
            ? "usage"
            : "failed"
          : null;
  if (!kind) return null;
  return {
    kind,
    agent: s.agent,
    chat: s.id,
    title: String(s.title || "").slice(0, 200),
    cwd: String(s.cwd || ""),
    files: changedFiles(outcome.turn).length,
    ...(kind === "failed" || kind === "usage" ? { text: String(outcome.item?.text || "").slice(0, 300) } : {}),
    at,
  };
}

export function createJournal({ file = null, now = Date.now } = {}) {
  let events = [];
  if (file)
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(saved)) events = saved.filter((e) => e && typeof e.kind === "string" && Number.isFinite(e.at));
    } catch {
      /* none yet */
    }
  let timer = null;
  const save = () => {
    if (!file || timer) return;
    // Several turns end together (a burst): written once.
    timer = setTimeout(() => {
      timer = null;
      const tmp = `${file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(events), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch {
        /* kept in memory until the next one */
      }
    }, 500);
    timer.unref?.();
  };
  return {
    add(event) {
      if (!event) return null;
      const kept = { id: randomUUID(), ...event, at: event.at ?? now() };
      const old = now() - KEEP_MS;
      events = [...events.filter((e) => e.at > old), kept].slice(-MAX);
      save();
      return kept;
    },
    // Newest first, after `since` (ms).
    since: (since = 0) => events.filter((e) => e.at > since).reverse(),
    flush() {
      if (!timer) return;
      clearTimeout(timer);
      timer = null;
      if (file) fs.writeFileSync(file, JSON.stringify(events), { mode: 0o600 });
    },
  };
}
