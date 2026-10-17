// The real recovery controller and HTTP/WebSocket router use this fake node.
// No Go runtime, Tailscale device registration or OS networking is performed.
export const existingBrowserNode = async () => localStorage.getItem("reach.tailnet:_current-profile")
  ? globalThis.__reachPrivateRecoveryNode || null : null;
