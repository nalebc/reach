// Kept before an embedded node replaces the page's fetch/WebSocket. Both
// private recovery and the signed browser-agent gateway must probe the OS
// connection, independently of the embedded node's connectivity.
let native: { fetch: typeof fetch; Socket: typeof WebSocket } | null = null;
export const nativeBrowser = () => (native ||= {
  fetch: window.fetch.bind(window),
  Socket: window.WebSocket,
});
export const nativeBrowserFetch: typeof fetch = (input, init) => nativeBrowser().fetch(input, init);
