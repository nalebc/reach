import { post, request, type Peer } from "./api";

// Notifications on this phone when something needs you and Reach isn't open
// (public/sw.js shows them; server/push.mjs sends them). One browser gets
// them from the computer that serves its page.

export type PushSupport = "ready" | "home-screen" | "unsupported" | "denied";

const isIos = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () =>
  matchMedia?.("(display-mode: standalone)").matches ||
  (navigator as { standalone?: boolean }).standalone === true;

// Whether this browser can get notifications, or what it needs first.
export function pushSupport(): PushSupport {
  const capable =
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window;
  // iPhone: only Reach added to the Home Screen gets notifications.
  if (!capable) return isIos() && !standalone() ? "home-screen" : "unsupported";
  if (Notification.permission === "denied") return "denied";
  return "ready";
}

const keyBytes = (key: string) => {
  const text = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
};

const sameBytes = (a: ArrayBuffer, b: Uint8Array) => {
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
};

async function registration() {
  await navigator.serviceWorker.register("/sw.js");
  return navigator.serviceWorker.ready;
}

// Whether this browser gets notifications from this computer now.
export async function pushEnabled(peer: Peer) {
  const existing = await navigator.serviceWorker
    .getRegistration("/")
    .then((r) => r?.pushManager.getSubscription());
  if (!existing || Notification.permission !== "granted") return false;
  const { subscribed } = await request<{ subscribed: boolean }>(
    peer,
    `/api/push?endpoint=${encodeURIComponent(existing.endpoint)}`,
  );
  return subscribed;
}

// From a tap: the browser asks first.
export async function enablePush(peer: Peer) {
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw Error("Notifications are off for Reach in this phone's settings.");
  const [{ key }, reg] = await Promise.all([
    request<{ key: string }>(peer, "/api/push"),
    registration(),
  ]);
  const wanted = keyBytes(key);
  let subscription = await reg.pushManager.getSubscription();
  const current = subscription?.options.applicationServerKey;
  // Made for another computer's key: start over with this one's.
  if (subscription && current && !sameBytes(current, wanted)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: wanted,
  });
  await post(peer, "/api/push", { subscription: subscription.toJSON() });
}

export async function disablePush(peer: Peer) {
  const reg = await navigator.serviceWorker.getRegistration("/");
  const subscription = await reg?.pushManager.getSubscription();
  if (!subscription) return;
  await request(peer, "/api/push", {
    method: "DELETE",
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
}
