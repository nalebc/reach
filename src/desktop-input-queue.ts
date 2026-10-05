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
      if (this.stopped) return reject(Error("Desktop control ended."));
      const previous = this.queued.at(-1);
      if (
        ["move", "scroll"].includes(action.type) &&
        previous?.action.type === action.type
      ) {
        this.queued.pop();
        if (action.type === "scroll")
          action = {
            ...action,
            dx: Math.max(
              -120,
              Math.min(120, Number(previous.action.dx) + Number(action.dx)),
            ),
            dy: Math.max(
              -120,
              Math.min(120, Number(previous.action.dy) + Number(action.dy)),
            ),
          };
        previous.resolve({ ok: true, skipped: true });
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
    item.resolve(result);
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
    for (const item of [...this.pending.values(), ...this.queued])
      item.reject(error);
    this.pending.clear();
    this.queued = [];
  }
}
