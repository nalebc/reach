import { fail } from "./core.mjs";

// `reason` names who holds the Mac ("Spicy Llama is using the Mac"): the
// phone shows it on the waiting message instead of a vague "screen in use".
const busy = (reason) => Object.assign(fail(409, typeof reason === "string" && reason
  ? `Waiting: ${reason}. It goes in by itself after.`
  : "Desktop automation is waiting while the screen is in use. Try again after control is released."),
{ kind: "busy", waiting: true });

// One complete switch/native-operation/restore transaction at a time. Native
// work must be awaited through actual completion; this coordinator never retries
// or cancels a dispatched OS action. Its guard prevents subsequent stale steps.
// `blocked()` answers false when the Mac is free, or why it isn't (a string
// names the cause; anything else refuses without one).
export function createDesktopAutomation({ blocked = () => false, now = Date.now, wantMs = 6000 } = {}) {
  let current = null, foreground = null, generation = 0, closed = false;
  // When work last waited on someone else's use of the Mac. While it waits,
  // agents' next input waits instead (wanted()): an agent clicking every
  // second kept its 2.5 s lease forever, and a message to the Claude app
  // waited for good behind it.
  let wantedAt = -Infinity;
  // When a transaction last drove the Mac (a native step past its first
  // guard): an agent's picture from before then is stale (changedAt()).
  let changedAt = 0;
  const unavailable = () => {
    try { return blocked(); } catch { return true; }
  };
  return {
    noteForeground(bundle) {
      const next = typeof bundle === "string" && bundle.length > 0 && bundle.length <= 300 ? bundle : null;
      if (next !== foreground) { foreground = next; generation++; }
      // Unknown remains unusable even when repeated unknown reports arrive.
    },
    active: () => current !== null,
    wanted: () => current === null && now() - wantedAt < wantMs,
    changedAt: () => changedAt,
    // Owner control takes priority, but its native input must wait for this
    // returned barrier. Returning to the prior foreground never un-cancels it.
    interrupt() {
      if (!current) return null;
      current.interrupted = true;
      return current.done;
    },
    async run(work) {
      if (closed) throw busy("Reach is stopping");
      // Another chat's step on the Mac: this one goes after it. Marked so a
      // waiting message keeps the reason it gave before (a passing turn
      // taken hid why it really waited).
      if (current) throw Object.assign(busy("another chat is updating the Claude app"), { collision: true });
      if (foreground === null) throw busy("Reach doesn't know which app is in front on the Mac yet");
      const reason = unavailable();
      if (reason !== false) {
        wantedAt = now();
        throw busy(reason);
      }
      wantedAt = -Infinity;
      let release, steps = 0;
      const entry = { interrupted: false, generation, done: new Promise(resolve => { release = resolve; }) };
      current = entry;
      const guard = () => {
        if (closed || current !== entry) throw busy("Reach is stopping");
        if (entry.interrupted) throw busy("you took control of the Mac");
        if (foreground === null || generation !== entry.generation) throw busy("the app in front on the Mac changed");
        const why = unavailable();
        if (why !== false) throw busy(why);
        steps++;
      };
      try {
        guard();
        // Once a caller dispatched and confirmed a mutation, later focus or
        // owner changes must not turn its receipt into a retryable refusal.
        return await work(guard);
      } finally {
        if (steps > 1) changedAt = now();
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
