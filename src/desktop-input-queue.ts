export type DesktopAction = { type: string; [key: string]: unknown };
export type TextTarget = {
  editable: boolean;
  focus?: string;
  secure?: boolean;
  // The keyboard opened during the tap; no input may leave until focus is confirmed.
  pending?: boolean;
  // Reset phone-only draft context after a remote caret/selection change.
  editRevision?: number;
  // The typing session, kept while its field is confirmed again (after a
  // reconnect, Tab or Esc): its keyboard stays open meanwhile.
  session?: string;
  // Confirming the same field again on a new connection: its point.
  rejoin?: { x: number; y: number } | true;
};
export type InputResult = {
  ok?: boolean;
  // The computer turned down this one action (control goes on).
  error?: string;
  text?: string;
  skipped?: boolean;
  target?: TextTarget;
  point?: { x: number; y: number };
  clickState?: number;
  retargeted?: boolean;
};
type InputReconnectError = Error & { inputReconnect: true; notSent?: true };
// A local connection lifetime marker, never copied from a host's refusal.
// Only notSent actions may be retained for a later explicit user decision.
export function inputEnded(reconnecting = false, notSent = false, message = "Desktop control ended.") {
  return Object.assign(Error(message), {
    ...(reconnecting ? { inputReconnect: true as const } : {}),
    ...(notSent ? { notSent: true as const } : {}),
  });
}
export function isInputReconnect(error: unknown): error is InputReconnectError {
  return !!error && typeof error === "object" && (error as InputReconnectError).inputReconnect === true;
}
type Pending = {
  action: DesktopAction;
  resolve: (r: InputResult) => void;
  reject: (e: Error) => void;
  at: number;
  sent: number;
};
// Pointer moves and scrolls: the newest one stands for those before it.
const isMotion = (action: DesktopAction) => action.type === "move" || action.type === "scroll";
const graphemes = (text: string) =>
  Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
const bytes = (text: string) => new TextEncoder().encode(text).length;
// Typing that hasn't left yet goes as one edit with the next: a burst of
// letters can't fill the queue, and the computer types exactly the same.
// An edit deletes its count of characters before the caret, then types.
export function mergeTyping(a: DesktopAction, b: DesktopAction): DesktopAction | null {
  if (a.focus !== b.focus) return null;
  if (a.type === "text" && b.type === "text") {
    const text = String(a.text) + String(b.text);
    return bytes(text) <= 4000 ? { ...b, text } : null;
  }
  if (a.type !== "type-edit" || b.type !== "type-edit") return null;
  const typed = graphemes(String(a.text)), removed = Number(b.delete);
  const merged = removed <= typed.length
    ? { delete: Number(a.delete), text: typed.slice(0, typed.length - removed).join("") + String(b.text) }
    : { delete: Number(a.delete) + removed - typed.length, text: String(b.text) };
  return merged.delete <= 256 && bytes(merged.text) <= 4000 ? { ...b, ...merged } : null;
}
// A small ordered window hides network RTT; the host still dispatches serially.
export class DesktopInputQueue {
  private pending = new Map<number, Pending>();
  private queued: Pending[] = [];
  private sequence = 0;
  private lastMotion = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private reconnecting = false;
  constructor(
    private transmit: (id: number, action: DesktopAction) => void,
    private fail: (message: string) => void,
    private window = 8,
    private now = () => performance.now(),
  ) {}
  get idle() {
    return !this.pending.size && !this.queued.length;
  }
  enqueue(action: DesktopAction): Promise<InputResult> {
    return new Promise((resolve, reject) => {
      if (this.stopped) return reject(inputEnded(this.reconnecting, true));
      // A touch stopping a fling discards unsent scrolling even on a slow
      // link. Keep clicks, keys and pointer releases in their original order.
      if (action.type === "scroll" && action.phase === "cancelled" && action.dx === 0 && action.dy === 0)
        for (let i = this.queued.length - 1; i >= 0; i--)
          if (this.queued[i].action.type === "scroll") {
            this.queued[i].resolve({ ok: true, skipped: true });
            this.queued.splice(i, 1);
          }
      // A move or scroll merges into the last one of its kind still waiting,
      // past other moves and scrolls (never past a click or key): moves and
      // scrolls arriving in turns can't pile up on a slow link.
      if (isMotion(action))
        for (let i = this.queued.length - 1; i >= 0 && isMotion(this.queued[i].action); i--) {
          const previous = this.queued[i];
          if (previous.action.type !== action.type) continue;
          if (action.type === "scroll")
            action = {
              ...action,
              dx: Math.max(-120, Math.min(120, Number(previous.action.dx) + Number(action.dx))),
              dy: Math.max(-120, Math.min(120, Number(previous.action.dy) + Number(action.dy))),
            };
          previous.resolve({ ok: true, skipped: true });
          this.queued[i] = { action, resolve, reject, at: this.now(), sent: 0 };
          this.flush();
          return;
        }
      const last = this.queued.at(-1);
      const merged = last && mergeTyping(last.action, action);
      if (last && merged) {
        const { resolve: first, reject: firstFailed } = last;
        last.action = merged;
        last.resolve = (result) => {
          first(result);
          resolve(result);
        };
        last.reject = (error) => {
          firstFailed(error);
          reject(error);
        };
        this.flush();
        return;
      }
      if (this.queued.length >= 32) {
        reject(inputEnded(true, true, "Too many pending actions."));
        this.fail("Desktop input queue filled. Reconnect.");
        return;
      }
      this.queued.push({ action, resolve, reject, at: this.now(), sent: 0 });
      this.flush();
    });
  }
  private flush() {
    while (
      !this.stopped &&
      this.pending.size < this.window &&
      this.queued.length
    ) {
      const item = this.queued[0],
        motion = ["move", "scroll"].includes(item.action.type);
      const wait = 16 - (this.now() - this.lastMotion);
      if (motion && wait > 0) {
        if (!this.timer)
          this.timer = setTimeout(() => {
            this.timer = undefined;
            this.flush();
          }, wait);
        return;
      }
      if (this.now() - item.at > 1000) {
        // A move or scroll that waited too long is let go (the next one
        // stands for it); a click or key never goes late: control ends.
        if (motion) {
          this.queued.shift();
          item.resolve({ ok: true, skipped: true });
          continue;
        }
        this.fail("Connection is too slow for safe control. Reconnect.");
        return;
      }
      this.queued.shift();
      if (motion) this.lastMotion = this.now();
      item.sent = this.now();
      const id = ++this.sequence;
      this.pending.set(id, item);
      try {
        this.transmit(id, item.action);
      } catch {
        this.close(true);
        this.fail(
          "Desktop input disconnected. No pending actions were replayed.",
        );
        return;
      }
    }
  }
  acknowledge(id: number, result: InputResult) {
    const item = this.pending.get(id);
    if (!item) throw Error("Invalid input acknowledgment.");
    this.pending.delete(id);
    // Turned down: that action fails; control and the queue go on.
    if (result?.ok === false && typeof result.error === "string") item.reject(Error(result.error));
    else item.resolve(result);
    this.flush();
    return this.now() - item.sent;
  }
  // Longer than the computer may hold input while it confirms this phone
  // again (server/identity-hold.mjs, 5 s): a hold isn't a dead link.
  checkTimeout() {
    if ([...this.pending.values()].some((p) => this.now() - p.sent > 6000))
      this.fail("Desktop input timed out.");
  }
  close(reconnecting = false, message = "Desktop control ended.") {
    this.stopped = true;
    this.reconnecting ||= reconnecting;
    clearTimeout(this.timer);
    const error = inputEnded(this.reconnecting, false, message);
    for (const item of this.pending.values()) item.reject(error);
    // Never transmitted: the Mac can't have done these, so a tap among them
    // may go again once control is back (src/DesktopSurface.tsx, within 1 s).
    for (const item of this.queued)
      item.reject(inputEnded(this.reconnecting, true, message));
    this.pending.clear();
    this.queued = [];
  }
}
