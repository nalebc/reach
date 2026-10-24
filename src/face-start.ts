// Face ID sign-in, the browser's side (server/face-join.mjs): the start page
// passes Face ID, joins your tailnet with the computer's one-time key, and
// leaves the one-time ticket here for Connect to use once.

// This browser's Tailscale device joined with Face ID: a limited one, which
// reaches Reach at the computer's private address (its port is the one the
// device may use).
export const FACE_DEVICE = "reach.tailnet.face";
const TICKET = "reach.face.ticket";
const FRESH = "reach.face.fresh";

type Ticket = { ticket: string; origin: string; at: number };
export function saveTicket(ticket: string, origin: string) {
  try {
    sessionStorage.setItem(
      TICKET,
      JSON.stringify({ ticket, origin, at: Date.now() }),
    );
  } catch {}
}
// A ticket works once, and only for ten minutes.
function readTicket(): Ticket | null {
  try {
    const t = JSON.parse(sessionStorage.getItem(TICKET) || "null");
    return typeof t?.ticket === "string" &&
      typeof t.origin === "string" &&
      Date.now() - t.at < 600000
      ? t
      : null;
  } catch {
    return null;
  }
}
export const hasTicket = () => !!readTicket();
export function takeTicket() {
  const t = readTicket();
  try {
    sessionStorage.removeItem(TICKET);
  } catch {}
  return t;
}

// The computers this browser saved while signed in from the browser: each
// credential is bound to this browser's Tailscale device, so a new device
// (signing in again, any way) starts without them (src/api.ts, peersKey).
export function forgetSaved() {
  try {
    localStorage.removeItem("reach.browser.devices");
    localStorage.removeItem("reach.browser.active");
    localStorage.removeItem("reach.browser.identity-lineage");
    // Saved before the two ways were kept apart (src/api.ts, separateWays):
    // at this address, that was only ever the browser way's.
    if (!location.port && location.hostname.endsWith(".ts.net") && !localStorage.getItem("reach.ways")) {
      localStorage.removeItem("reach.devices");
      localStorage.removeItem("reach.active");
      localStorage.setItem("reach.ways", "1");
    }
  } catch {}
}
// Sign in with Face ID again: this browser's old device (its access here
// ended, or it was removed) is forgotten when the start page loads.
export function startFresh() {
  try {
    sessionStorage.setItem(FRESH, "1");
  } catch {}
  location.replace("/");
}
export function forgetIfFresh() {
  try {
    if (!sessionStorage.getItem(FRESH)) return false;
    sessionStorage.removeItem(FRESH);
    for (const k of Object.keys(localStorage))
      if (k.startsWith("reach.tailnet:")) localStorage.removeItem(k);
    localStorage.removeItem(FACE_DEVICE);
    forgetSaved();
    return true;
  } catch {
    return false;
  }
}
export const faceDevice = () => {
  try {
    return localStorage.getItem(FACE_DEVICE) === "1";
  } catch {
    return false;
  }
};
