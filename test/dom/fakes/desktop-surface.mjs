import { createElement } from "react";

// Stands in for src/DesktopSurface.tsx, which draws video on a canvas.
export default function DesktopSurface({ ready }) {
  return createElement("div", {
    className: "fake-desktop",
    "data-ready": String(ready),
  });
}
