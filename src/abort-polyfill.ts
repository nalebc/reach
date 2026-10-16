// AbortSignal.timeout (Safari 16) and AbortSignal.any (Safari 17.4) on the
// older iPhones the app still supports (iOS 15): without them every request
// throws before it starts and Reach looks disconnected.
const S = AbortSignal as unknown as {
  timeout?: (ms: number) => AbortSignal;
  any?: (signals: AbortSignal[]) => AbortSignal;
};
if (typeof S.timeout !== "function")
  S.timeout = (ms: number) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
      ms,
    );
    return controller.signal;
  };
if (typeof S.any !== "function")
  S.any = (signals: AbortSignal[]) => {
    const controller = new AbortController();
    const listeners = new Map<AbortSignal, () => void>();
    const abort = (signal: AbortSignal) => {
      for (const [source, listener] of listeners)
        source.removeEventListener("abort", listener);
      listeners.clear();
      controller.abort(signal.reason);
    };
    for (const signal of signals) {
      if (signal.aborted) {
        abort(signal);
        break;
      }
      if (listeners.has(signal)) continue;
      const listener = () => abort(signal);
      listeners.set(signal, listener);
      signal.addEventListener("abort", listener, { once: true });
    }
    return controller.signal;
  };
export {};
