// Whether the page's own tailnet node carries requests (a phone without the
// Tailscale app), switched by the test instead of a running node.
export const tailnetBrowser = () => globalThis.__reachTailnetBrowser === true;

// Tests can retain the original route of a peer held across a handoff.
export const peerUsesBrowserTailnet = (peer) =>
  globalThis.__reachPeerUsesBrowserTailnet?.(peer) ?? tailnetBrowser();
