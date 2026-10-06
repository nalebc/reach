export type GuestNetworkStep =
  | "https-connecting"
  | "https-ready"
  | "https-failed"
  | "socket-connecting"
  | "socket-ready"
  | "socket-failed";

// Observe only the public Tailscale handshake during guest startup. Never
// capture URLs, headers, bodies, keys, or traffic to the owner's computer.
export function observeGuestNetwork(
  scope: Pick<typeof globalThis, "fetch" | "WebSocket">,
  report: (step: GuestNetworkStep) => void,
) {
  const originalFetch = scope.fetch;
  const OriginalSocket = scope.WebSocket;
  let active = true;
  const emit = (step: GuestNetworkStep) => {
    if (active) {
      try {
        report(step);
      } catch {
        // Reporting must not affect the actual network request.
      }
    }
  };
  const matches = (input: string | URL | Request, route: string) => {
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return (
        url.hostname === "controlplane.tailscale.com" && url.pathname === route
      );
    } catch {
      return false;
    }
  };
  const observedFetch: typeof fetch = async (input, init) => {
    const tracked = matches(input, "/key");
    if (tracked) emit("https-connecting");
    try {
      const response = await originalFetch.call(scope, input, init);
      if (tracked) emit(response.ok ? "https-ready" : "https-failed");
      return response;
    } catch (error) {
      if (tracked) emit("https-failed");
      throw error;
    }
  };
  class ObservedSocket extends OriginalSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const tracked = matches(url, "/ts2021");
      if (tracked) emit("socket-connecting");
      try {
        super(url, protocols);
      } catch (error) {
        if (tracked) emit("socket-failed");
        throw error;
      }
      if (tracked) {
        this.addEventListener("open", () => emit("socket-ready"));
        this.addEventListener("error", () => emit("socket-failed"));
      }
    }
  }
  scope.fetch = observedFetch;
  scope.WebSocket = ObservedSocket;
  return () => {
    active = false;
    // Leave later transport replacements alone.
    if (scope.fetch === observedFetch) scope.fetch = originalFetch;
    if (scope.WebSocket === ObservedSocket) scope.WebSocket = OriginalSocket;
  };
}
