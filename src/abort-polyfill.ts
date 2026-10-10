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
    for (const signal of signals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        break;
      }
      signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
  };
export {};
