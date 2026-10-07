// One bounded retry timer per connection. Never retries an operation payload.
export class ReconnectTimer {
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: (() => void) | undefined;
  constructor(private random = Math.random) {}
  schedule(run: () => void) {
    this.cancel();
    this.pending = run;
    const delay =
      Math.min(30000, 1000 * 2 ** Math.min(this.attempt++, 5)) *
      (0.8 + this.random() * 0.2);
    this.timer = setTimeout(() => this.wake(), delay);
    return delay;
  }
  wake() {
    const run = this.pending;
    this.cancel();
    run?.();
  }
  cancel() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
  }
  reset() {
    this.cancel();
    this.attempt = 0;
  }
}

export function screenCanRetry(message: {
  retryable?: boolean;
  status?: number;
  error?: string;
}) {
  if (typeof message.retryable === "boolean") return message.retryable;
  if ([400, 401, 403, 404].includes(message.status || 0)) return false;
  // Older companions do not send structured failure details.
  return !/revoked|expired|pair this device|not granted|turned off|viewing is off|turn on screen|authenticate first/i.test(
    message.error || "",
  );
}
