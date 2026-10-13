// Bound one refresh while retaining the view's cancellation signal. Each
// refresh gets its own deadline, so a timeout cannot disable later retries.
export function requestDeadline(parent: AbortSignal, ms = 35000) {
  const controller = new AbortController();
  const cancel = () => controller.abort(parent.reason);
  if (parent.aborted) cancel();
  else parent.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("The request timed out.", "TimeoutError")), ms);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", cancel);
    },
  };
}
