import {
  directUrl,
  ownOrigin,
  probeDirect,
  type StartConfig,
} from "./start-flow";

// The browser's own fetch, kept before the page's node takes over Reach's
// requests (installTailnet in src/tailnet-transport.ts): "is the Tailscale
// app on?" must be answered by the phone's own connection, never by that
// node, which always gets through.
const direct = window.fetch.bind(window);

// While in the browser, keep checking for the app: offer the faster path.
// With one address, that's this same page loaded again.
export function watchForApp(config: StartConfig, every = 15000) {
  const own = { ...config, origin: ownOrigin(config) };
  let shown = false;
  const check = async () => {
    if (shown || document.hidden) return;
    if (!(await probeDirect(own, direct, 1500))) return;
    shown = true;
    const pill = document.createElement("button");
    pill.className = "start-switch";
    pill.textContent = "Tailscale app is on · Switch to the faster connection";
    pill.addEventListener("click", () => {
      const target = directUrl(own, location);
      if (new URL(target).origin === location.origin) location.reload();
      else location.replace(target);
    });
    document.body.append(pill);
  };
  return setInterval(check, every);
}
