// This small entry loads independently of React and the connection client.
// A failed workspace dependency must not also disable the way to reload it.
import { keepPageRecovery, reconnectUrl } from "./page-recovery";

for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-reach-reload]"))
  link.href = reconnectUrl(location.href);
// The async production script may start before the body is parsed. Capture
// clicks too, preserving the current view even on a stalled startup page.
document.addEventListener("click", event => {
  const link = event.target instanceof Element
    ? event.target.closest<HTMLAnchorElement>("a[data-reach-reload]") : null;
  if (link) link.href = reconnectUrl(location.href);
}, { capture: true });
keepPageRecovery();
