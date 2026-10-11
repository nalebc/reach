// Storage refused (Safari blocking all cookies): kept in memory instead.
import "./storage-fallback";
import { openReach } from "./app-boot";
// Keeps the browser's install prompt from page load (Add to Home Screen).
import "./home-screen";

// Keep a visible startup state even when a cached or unavailable chunk cannot
// load. React's boundary takes over after the application starts rendering.
void openReach(() => import("./main"));
