import { fail } from "./core.mjs";

const MAX_FRAME = 8 * 1024 * 1024;

// Browser agents use signed HTTP snapshots, not the private screen WebSocket.
// Keep the native JPEG helper warm only between recent snapshot requests. No
// JPEG is cached: each request asks the helper for its current frame.
export class BrowserScreenSnapshots {
  constructor(
    prepare,
    {
      fallback,
      idleMs = 5000,
      timeoutMs = 8000,
      retryMs = 30000,
      now = Date.now,
    } = {},
  ) {
    Object.assign(this, { prepare, fallback, idleMs, timeoutMs, retryMs, now });
  }
  source = null;
  flight = null;
  idle = null;
  generation = 0;
  retryAt = 0;

  stop(message = "Screen capture stopped.") {
    this.generation++;
    clearTimeout(this.idle);
    this.idle = null;
    this.source?.stop();
    this.source = null;
    this.flight?.cancel(fail(409, message));
    this.flight = null;
  }

  async capture(authorize) {
    authorize();
    const generation = this.generation;
    clearTimeout(this.idle);
    this.idle = null;
    if (!this.flight) this.flight = this.start(authorize, generation);
    try {
      const frame = await this.flight.promise;
      if (generation !== this.generation)
        throw fail(409, "Screen capture stopped.");
      // Each HTTP reader checks its own permission, even when concurrent
      // requests share the same native frame operation.
      authorize();
      return frame;
    } finally {
      if (generation === this.generation && !this.flight && this.source) {
        clearTimeout(this.idle);
        this.idle = setTimeout(() => this.stop(), this.idleMs);
        this.idle.unref?.();
      }
    }
  }

  start(authorize, generation) {
    let cancelled = false;
    let timeout;
    let cancel;
    const abort = new Promise((_, reject) => {
      cancel = (error) => {
        cancelled = true;
        clearTimeout(timeout);
        reject(error);
      };
    });
    const check = () => {
      if (cancelled || generation !== this.generation)
        throw fail(409, "Screen capture stopped.");
      authorize();
    };
    const validate = (frame) => {
      if (
        !Buffer.isBuffer(frame) ||
        frame.length < 2 ||
        frame.length > MAX_FRAME
      )
        throw fail(413, "This screen snapshot is too large or unavailable.");
      return frame;
    };
    const native = async () => {
      if (!this.source) {
        const factory = await this.prepare();
        check();
        this.source = factory();
      }
      check();
      // "key" forces a JPEG even if the desktop has not changed; the native
      // helper's one-byte unchanged marker is not an image response.
      const frame = await this.source.next("key");
      check();
      return validate(frame);
    };
    const fallback = async () => {
      check();
      if (!this.fallback)
        throw fail(503, "Screen capture is unavailable. Try again shortly.");
      const frame = await this.fallback();
      check();
      return validate(frame);
    };
    const operation = {};
    operation.cancel = cancel;
    const work = (async () => {
      if (this.now() < this.retryAt) return fallback();
      try {
        const expired = new Promise((_, reject) => {
          timeout = setTimeout(() => {
            if (cancelled || generation !== this.generation) return;
            cancelled = true;
            this.source?.stop();
            this.source = null;
            reject(fail(503, "Screen capture timed out."));
          }, this.timeoutMs);
          timeout.unref?.();
        });
        return await Promise.race([native(), expired]);
      } catch (error) {
        clearTimeout(timeout);
        if (generation !== this.generation) throw error;
        // A preparation that completes after timeout must not start a helper.
        // The fallback is a separate operation, permitted only after checking
        // that the HTTP viewer still has access.
        authorize();
        this.source?.stop();
        this.source = null;
        this.retryAt = this.now() + this.retryMs;
        if (!this.fallback) throw error;
        const frame = await this.fallback();
        if (generation !== this.generation)
          throw fail(409, "Screen capture stopped.");
        authorize();
        return validate(frame);
      } finally {
        clearTimeout(timeout);
      }
    })();
    operation.promise = Promise.race([work, abort]).finally(() => {
      if (this.flight === operation) this.flight = null;
    });
    return operation;
  }
}
