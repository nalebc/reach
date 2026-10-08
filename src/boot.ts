import { openReach } from "./app-boot";

// Keep a visible startup state even when a cached or unavailable chunk cannot
// load. React's boundary takes over after the application starts rendering.
void openReach(() => import("./main"));
