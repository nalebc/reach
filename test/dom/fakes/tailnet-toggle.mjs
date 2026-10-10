// Whether the page's own tailnet node carries requests (a phone without the
// Tailscale app), switched by the test instead of a running node.
export const tailnetBrowser = () => globalThis.__reachTailnetBrowser === true;
