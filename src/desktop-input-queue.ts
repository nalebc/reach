export type DesktopAction = { type: string; [key: string]: unknown };
export type TextTarget = {
  editable: boolean;
  focus?: string;
  secure?: boolean;
  // The keyboard opened during the tap; no input may leave until focus is confirmed.
  pending?: boolean;
};
export type InputResult = {
  ok?: boolean;
  // The computer turned down this one action (control goes on).
  error?: string;
  text?: string;
  skipped?: boolean;
  target?: TextTarget;
};
type Pending = {
  action: DesktopAction;
  resolve: (r: InputResult) => void;
  reject: (e: Error) => void;
  at: number;
  sent: number;
};
// Pointer moves and scrolls: the newest one stands for those before it.
const isMotion = (action: DesktopAction) => action.type === "move" || action.type === "scroll";
// A small ordered window hides network RTT; the host still dispatches serially.
export class DesktopInputQueue {
  private pending = new Map<number, Pending>();
  private queued: Pending[] = [];
  private sequence = 0;
  private lastMotion = -Infinity;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
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
      if (this.stopped) return reject(Object.assign(Error("Desktop control ended."), { notSent: true }));
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
      if (this.queued.length >= 32) {
        reject(Error("Too many pending actions."));
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
        this.close();
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
  checkTimeout() {
    if ([...this.pending.values()].some((p) => this.now() - p.sent > 3000))
      this.fail("Desktop input timed out.");
  }
  close() {
    this.stopped = true;
    clearTimeout(this.timer);
    const error = Error("Desktop control ended.");
    for (const item of this.pending.values()) item.reject(error);
    // Never transmitted: the Mac can't have done these, so a tap among them
    // may go again once control is back (src/DesktopSurface.tsx, within 1 s).
    for (const item of this.queued)
      item.reject(Object.assign(Error("Desktop control ended."), { notSent: true }));
    this.pending.clear();
    this.queued = [];
  }
}
