import { createElement } from "react";
import { computer } from "./computer.mjs";

// Stands in for src/DesktopSurface.tsx and keeps the props it was given in
// computer.surface, so a test can act as the surface does (a tap's probe,
// its click, the Mac's answer after it).
export default function DesktopSurface(props) {
  computer.surface = props;
  return createElement("div", { className: "fake-desktop" });
}
