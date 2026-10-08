import { fail } from "./core.mjs";

const busy = () => Object.assign(fail(409,
  "Desktop automation is waiting while the screen is in use. Try again after control is released."),
{ kind: "busy", waiting: true });

// One complete switch/native-operation/restore transaction at a time. Native
// work must be awaited through actual completion; this coordinator never retries
// or cancels a dispatched OS action. Its guard prevents subsequent stale steps.
export function createDesktopAutomation({ blocked = () => false } = {}) {
  let current = null, foreground = null, generation = 0, closed = false;
  const unavailable = () => {
    try { return blocked() !== false; } catch { return true; }
  };
  return {
    noteForeground(bundle) {
      const next = typeof bundle === "string" && bundle.length > 0 && bundle.length <= 300 ? bundle : null;
      if (next !== foreground) { foreground = next; generation++; }
      // Unknown remains unusable even when repeated unknown reports arrive.
    },
    active: () => current !== null,
    // Owner control takes priority, but its native input must wait for this
    // returned barrier. Returning to the prior foreground never un-cancels it.
    interrupt() {
      if (!current) return null;
      current.interrupted = true;
      return current.done;
    },
    async run(work) {
      if (closed || current || foreground === null || unavailable()) throw busy();
      let release;
      const entry = { interrupted: false, generation, done: new Promise(resolve => { release = resolve; }) };
      current = entry;
      const guard = () => {
        if (closed || current !== entry || entry.interrupted || foreground === null || generation !== entry.generation || unavailable()) throw busy();
      };
      try {
        guard();
        // Once a caller dispatched and confirmed a mutation, later focus or
        // owner changes must not turn its receipt into a retryable refusal.
        return await work(guard);
      } finally {
        if (current === entry) current = null;
        release();
      }
    },
    close() {
      closed = true;
      if (current) current.interrupted = true;
    },
  };
}
