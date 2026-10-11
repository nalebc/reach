import { useEffect, useState } from "react";

// Reach on the phone's Home Screen: what this phone is, whether this page is
// already the Home Screen app, and the browser's own install prompt (Chrome,
// Edge and Samsung Internet on Android). That prompt is offered only once, at
// page load, so this module loads at start-up (boot.ts, and start.ts, where a
// phone without the Tailscale app loads the app much later) to keep it for
// the tap. iPhone has no such prompt: Share → Add to Home Screen.

export const isIos = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export const isAndroid = () => /Android/.test(navigator.userAgent);
// A phone or tablet: where a Home Screen icon is how apps are opened.
export const isPhone = () => isIos() || isAndroid();
export const standalone = () =>
  (typeof matchMedia === "function" &&
    matchMedia("(display-mode: standalone)").matches) ||
  (navigator as { standalone?: boolean }).standalone === true;

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};
let installPrompt: InstallPrompt | null = null;
let installed = false;
const changed = () => window.dispatchEvent(new Event("reach-install-changed"));
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e as InstallPrompt;
    changed();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    installed = true;
    changed();
  });
}
// Added from this page just now (the browser said so).
export const justInstalled = () => installed;

// The browser's install prompt, when it offered one: a function to show it.
export function useInstallPrompt() {
  const [ready, setReady] = useState(() => !!installPrompt);
  useEffect(() => {
    const update = () => setReady(!!installPrompt);
    window.addEventListener("reach-install-changed", update);
    return () => window.removeEventListener("reach-install-changed", update);
  }, []);
  const install = async () => {
    const prompt = installPrompt;
    if (!prompt) return null;
    installPrompt = null;
    await prompt.prompt();
    const choice = await prompt.userChoice.catch(() => null);
    changed();
    return choice?.outcome ?? null;
  };
  return ready ? install : null;
}
