import { createElement } from "react";

// Stands in for src/DesktopSurface.tsx, which draws video on a canvas.
// Without video it shows what the real one does then (`idle`).
// It also says which area it was told to open on (focusRect), as JSON.
export default function DesktopSurface({ ready, idle, focusRect }) {
  return createElement(
    "div",
    { className: "fake-desktop", "data-ready": String(ready), ...(focusRect ? { "data-focus": JSON.stringify(focusRect) } : {}) },
    ready ? null : (idle ?? null),
  );
}
