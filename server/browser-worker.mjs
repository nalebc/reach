import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

const failure = (code, uncertain) => Object.assign(Error("The browser worker stopped. Inspect completed effects before retrying."), { code, uncertain });

// One request in flight per process. Cancellation and timeout settle only
// AFTER process exit, so desktop ownership cannot pass to another writer
// while an old Apple Event is still being dispatched. Never replay requests.
export class BrowserWorker {
  constructor(command, args, { spawnProcess = spawn, idleMs = 30000 } = {}) {
    this.child = spawnProcess(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    this.terminated = new Promise(resolve => { this.onExit = resolve; });
    this.queue = []; this.current = null; this.stopped = false; this.idleMs = idleMs;
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    this.child.stderr.on("data", () => {});
    this.child.stdout.on("data", chunk => {
      if (this.stopped) return; // Keep the termination barrier after cancellation.
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > (this.current?.maxBytes ?? 16 * 1024 * 1024)) return this.stop("result_limit");
      const at = buffer.indexOf("\n");
      if (at < 0) return;
      if (!this.current || buffer.slice(at + 1).trim()) return this.stop("uncertain");
      const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
      try { JSON.parse(line); } catch { return this.stop("uncertain"); }
      const item = this.current; this.current = null;
      this.finish(item, null, line); this.next();
    });
    this.child.stdin.on("error", () => this.stop("uncertain"));
    this.child.on("error", () => { this.stop("unavailable"); if (!this.child.pid) this.exited(); });
    this.child.on("close", () => this.exited());
  }
  request(input, { timeoutMs = 12000, maxBytes = 16 * 1024 * 1024, signal, beforeSend } = {}) {
    if (this.stopped) return Promise.reject(failure("unavailable", false));
    if (signal?.aborted) return Promise.reject(failure("cancelled", false));
    if (Buffer.byteLength(input) > 16 * 1024 * 1024 || this.queue.length >= 32) return Promise.reject(failure("limit", false));
    return new Promise((resolve, reject) => {
      const item = { input, timeoutMs, maxBytes, signal, beforeSend, resolve, reject, sent: false };
      item.abort = () => {
        if (this.current === item) this.stop("cancelled");
        else { this.queue = this.queue.filter(entry => entry !== item); this.finish(item, failure("cancelled", false)); }
      };
      signal?.addEventListener("abort", item.abort, { once: true });
      this.queue.push(item); this.next();
    });
  }
  finish(item, error, value) {
    if (item.finished) return;
    item.finished = true; clearTimeout(item.timer); item.signal?.removeEventListener("abort", item.abort);
    error ? item.reject(error) : item.resolve(value);
  }
  next() {
    clearTimeout(this.idle);
    if (this.stopped || this.current) return;
    const item = this.queue.shift();
    if (!item) { this.idle = setTimeout(() => this.stop("unavailable"), this.idleMs); this.idle.unref?.(); return; }
    this.current = item;
    try { item.beforeSend?.(); }
    catch (error) {
      error.uncertain = false;
      this.current = null;
      this.finish(item, error);
      this.next();
      return;
    }
    item.timer = setTimeout(() => this.stop("uncertain"), item.timeoutMs);
    item.sent = true;
    try { this.child.stdin.write(item.input + "\n"); } catch { this.stop("uncertain"); }
  }
  stop(code = "cancelled") {
    if (this.stopped) return;
    this.stopped = true; this.code = code; clearTimeout(this.idle);
    clearTimeout(this.current?.timer);
    try { this.child.kill("SIGTERM"); } catch {}
    this.force = setTimeout(() => { try { this.child.kill("SIGKILL"); } catch {} }, 300);
    this.force.unref?.();
  }
  exited() {
    this.onExit();
    this.stopped = true; clearTimeout(this.force); clearTimeout(this.idle);
    for (const item of [this.current, ...this.queue].filter(Boolean)) this.finish(item, failure(this.code || "unavailable", item.sent));
    this.current = null; this.queue = [];
  }
}
