// The real recovery controller and HTTP/WebSocket router use this fake node.
// No Go runtime, Tailscale device registration or OS networking is performed.
export async function existingBrowserNode(_config, { wake = false } = {}) {
  if (!localStorage.getItem("reach.tailnet:_current-profile")) return null;
  const node = globalThis.__reachPrivateRecoveryNode || null;
  if (wake) node?.wake();
  return node;
}
export const browserRecoveryStatus = () => ({
  phase: "idle", retained: !!globalThis.__reachPrivateRecoveryNode,
  nodeState: globalThis.__reachPrivateRecoveryNode ? "Running" : "none",
});
