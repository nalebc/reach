// When the phone's page stops answering, and what it was doing then, for the
// computer to keep (Oct 27: "the app sometimes freezes: I can scroll but
// taps and typing do nothing"). On an iPhone scrolling goes on without the
// page's own code; taps and typing wait for it, or land on something lying
// over the page. Each report says which:
// - stall: the page's code didn't run for a second or more while in front;
// - slow-input: a touch reached the page's code late;
// - no-click: a tap that never became a click;
// - repeat-taps: three taps within a few seconds, the last one's target;
// - unclean-end: the page ended while in front without going away first
//   (closed while frozen, or its process ended).
// Never what's on the page: no text, no labels (a label can be a file's or
// a chat's name), no addresses. An element is its tag, its role and up to
// three of Reach's own class names.
export type StallKind = "stall" | "slow-input" | "no-click" | "repeat-taps" | "unclean-end";
export type StallReport = {
  kind: StallKind;
  ms: number;
  at: number;
  page: string;
  route: string;
  visible: boolean;
  dialogs: number;
  inert: number;
  pinned: boolean;
  focused: string;
  target?: string;
  under?: string;
  interactive?: boolean;
  build: string;
};
type Context = { page: () => string; route: () => string };

const STALL_MS = 1000;
const SLOW_INPUT_MS = 500;
const NO_CLICK_MS = 700;
const REPEAT_TAPS = 3, REPEAT_WINDOW_MS = 4000;
const TICK_MS = 200;
const BEAT_KEY = "reach.stall.beat";
const QUEUE_KEY = "reach.stall.queue";
const QUEUE_MAX = 20;

// An element as Reach's own code names it: tag, role, up to three classes.
export function describe(element: Element | null): string {
  if (!element) return "";
  const classes = [...element.classList].filter((name) => /^[a-z][a-z0-9_-]{0,40}$/i.test(name)).slice(0, 3);
  const role = element.getAttribute("role");
  return [element.tagName.toLowerCase(), role && /^[a-z]{1,20}$/.test(role) ? `[${role}]` : "", ...classes.map((name) => "." + name)].join("").slice(0, 120);
}
const INTERACTIVE = "button, a[href], input, textarea, select, summary, label, [role=button], [role=tab], [role=link], [role=menuitem], [role=option], [role=switch], [contenteditable=true]";
const build = () => {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  return (script?.getAttribute("src") || "").replace(/^.*\/assets\//, "").slice(0, 64);
};

function snapshot(kind: StallKind, ms: number, context: Context, extra: Partial<StallReport> = {}): StallReport {
  const focused = document.activeElement && document.activeElement !== document.body ? describe(document.activeElement) : "";
  return {
    kind, ms: Math.round(ms), at: Date.now(),
    page: context.page().slice(0, 40), route: context.route().slice(0, 20),
    visible: document.visibilityState === "visible",
    dialogs: document.querySelectorAll("dialog[open]").length,
    inert: document.querySelectorAll("[inert]").length,
    pinned: document.body?.style.position === "fixed",
    focused, build: build(), ...extra,
  };
}

const readQueue = (): StallReport[] => {
  try { const value = JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); return Array.isArray(value) ? value.slice(-QUEUE_MAX) : []; } catch { return []; }
};
const writeQueue = (queue: StallReport[]) => {
  try { queue.length ? localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-QUEUE_MAX))) : localStorage.removeItem(QUEUE_KEY); } catch { /* Storage refused: they stay in memory. */ }
};

// What sending did: taken, refused for good (not the owner's device: the
// reports are dropped), or not now (offline, the computer away: kept).
export type Sent = "taken" | "refused" | "later";
export function watchStalls(send: (reports: StallReport[]) => Promise<Sent>, context: Context, now = () => performance.now()) {
  let queue = readQueue();
  let sending = false, stopped = false, failures = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const flush = async () => {
    if (sending || stopped || !queue.length) return;
    sending = true;
    const batch = queue.slice(0, 10);
    let sent: Sent = "later";
    try { sent = await send(batch); } catch { /* Kept for the next try. */ }
    finally { sending = false; }
    if (sent !== "later") {
      queue = sent === "refused" ? [] : queue.slice(batch.length);
      writeQueue(queue);
      failures = 0;
    } else failures++;
    // Not now: again later, less often each time, never a loop.
    if (queue.length && !stopped && !retry) {
      retry = setTimeout(() => { retry = null; void flush(); }, sent === "later" ? Math.min(300_000, 5000 * 2 ** Math.min(failures, 6)) : 500);
    }
  };
  const report = (value: StallReport) => {
    queue.push(value);
    if (queue.length > QUEUE_MAX) queue = queue.slice(-QUEUE_MAX);
    writeQueue(queue);
    // After the page answers again: not on a page still catching up.
    setTimeout(() => void flush(), 500);
  };

  // The page last seen in front, every second, kept where a later start finds
  // it: in front without ever going away means it ended frozen (or crashed).
  const beat = (state: "visible" | "hidden" | "left") => {
    try { localStorage.setItem(BEAT_KEY, JSON.stringify({ state, at: Date.now(), page: context.page().slice(0, 40), route: context.route().slice(0, 20), build: build() })); } catch { /* Storage refused. */ }
  };
  try {
    const last = JSON.parse(localStorage.getItem(BEAT_KEY) || "null");
    if (last && last.state === "visible" && Number.isFinite(last.at) && Date.now() - last.at < 24 * 3600_000) {
      report({ ...snapshot("unclean-end", Date.now() - last.at, context), at: last.at, page: String(last.page || "").slice(0, 40),
        route: String(last.route || "").slice(0, 20), build: String(last.build || "").slice(0, 64), dialogs: 0, inert: 0, pinned: false, focused: "" });
    }
  } catch { /* Nothing saved. */ }

  // The page's own code not running while in front. A page put away (or
  // just back) has timers held by the browser: not a stall.
  let last = now(), shownEpoch = 0, seenEpoch = 0;
  const shown = () => { shownEpoch++; beat(document.visibilityState === "visible" ? "visible" : "hidden"); };
  const left = () => { shownEpoch++; beat("left"); };
  document.addEventListener("visibilitychange", shown);
  window.addEventListener("pageshow", shown);
  window.addEventListener("pagehide", left);
  document.addEventListener("freeze", left);
  document.addEventListener("resume", shown);
  let beats = 0;
  const tick = () => {
    const at = now(), gap = at - last - TICK_MS;
    last = at;
    const steady = seenEpoch === shownEpoch;
    seenEpoch = shownEpoch;
    if (!steady || document.visibilityState !== "visible") return;
    if (gap >= STALL_MS) report(snapshot("stall", gap, context));
    if (++beats % 5 === 0) beat("visible");
  };
  const timer = setInterval(tick, TICK_MS);
  beat(document.visibilityState === "visible" ? "visible" : "hidden");

  // Taps.
  let down: { x: number; y: number; at: number; target: Element | null } | null = null;
  let waiting: ReturnType<typeof setTimeout> | null = null;
  let taps: number[] = [];
  const onDown = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    const delay = now() - event.timeStamp;
    if (event.timeStamp > 0 && delay >= SLOW_INPUT_MS && delay < 600_000)
      report(snapshot("slow-input", delay, context, { target: describe(event.target as Element) }));
    down = { x: event.clientX, y: event.clientY, at: event.timeStamp, target: event.target as Element };
  };
  const onUp = (event: PointerEvent) => {
    if (!event.isPrimary || event.pointerType !== "touch" || !down) return;
    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y) > 10;
    const long = event.timeStamp - down.at > 500;
    const start = down;
    down = null;
    if (moved || long) return;
    const at = start.at;
    taps = [...taps.filter((time) => at - time < REPEAT_WINDOW_MS), at];
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const facts = () => ({ target: describe(start.target), under: describe(under), interactive: !!under?.closest(INTERACTIVE) });
    if (taps.length >= REPEAT_TAPS) {
      taps = [];
      report(snapshot("repeat-taps", REPEAT_WINDOW_MS, context, facts()));
    }
    if (waiting) clearTimeout(waiting);
    waiting = setTimeout(() => {
      waiting = null;
      report(snapshot("no-click", NO_CLICK_MS, context, facts()));
    }, NO_CLICK_MS);
  };
  const online = () => void flush();
  window.addEventListener("online", online);
  const onClick = () => {
    if (waiting) { clearTimeout(waiting); waiting = null; }
  };
  window.addEventListener("pointerdown", onDown, { capture: true, passive: true });
  window.addEventListener("pointerup", onUp, { capture: true, passive: true });
  window.addEventListener("click", onClick, { capture: true, passive: true });
  // A text field takes a tap without a click on some keyboards' first tap.
  window.addEventListener("focusin", onClick, { capture: true, passive: true });
  void flush();
  return () => {
    stopped = true;
    clearInterval(timer);
    if (retry) clearTimeout(retry);
    window.removeEventListener("online", online);
    if (waiting) clearTimeout(waiting);
    left();
    document.removeEventListener("visibilitychange", shown);
    window.removeEventListener("pageshow", shown);
    window.removeEventListener("pagehide", left);
    document.removeEventListener("freeze", left);
    document.removeEventListener("resume", shown);
    window.removeEventListener("pointerdown", onDown, { capture: true });
    window.removeEventListener("pointerup", onUp, { capture: true });
    window.removeEventListener("click", onClick, { capture: true });
    window.removeEventListener("focusin", onClick, { capture: true });
  };
}
