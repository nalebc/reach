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
export const browserNodeIdentityCurrent = () => false;
export const browserApprovalIdentity = () => null;
export async function browserPeerEligible(peer) {
  return !!localStorage.getItem("reach.tailnet:_current-profile") &&
    localStorage.getItem("reach.browser.identity-lineage") === null && peer.browserIdentity === undefined;
}
export const savedBrowserProfile = () => localStorage.getItem("reach.tailnet:_current-profile") || "";
export function setupBrowserNode() { throw Error("This recovery fixture does not authorize browser setup."); }
export function observeBrowserNode() { throw Error("This recovery fixture does not authorize browser setup."); }
