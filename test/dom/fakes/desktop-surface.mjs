import { createElement } from "react";

// Stands in for src/DesktopSurface.tsx, which draws video on a canvas.
// Without video it shows what the real one does then (`idle`).
export default function DesktopSurface({ ready, idle }) {
  return createElement(
    "div",
    { className: "fake-desktop", "data-ready": String(ready) },
    ready ? null : (idle ?? null),
  );
}
