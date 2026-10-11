import { post, request, type Peer } from "./api";
import { isIos, standalone } from "./home-screen";

// Notifications on this phone when something needs you and Reach isn't open
// (public/sw.js shows them; server/push.mjs sends them). One browser gets
// them from the computer that serves its page.

export type PushSupport = "ready" | "home-screen" | "unsupported" | "denied";


// Whether this browser can get notifications, or what it needs first.
export function pushSupport(): PushSupport {
  if (isIos() && !standalone()) return "home-screen";
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
  const reg = await navigator.serviceWorker.getRegistration("/");
  const existing = await reg?.pushManager.getSubscription();
  // Keep the worker current for phones that enabled push before this build.
  if (existing) void reg?.update?.().catch(() => {});
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
    throw Error(
      permission === "denied"
        ? "Notifications are off for Reach in this device's settings."
        : "Notifications weren't enabled. Tap Enable notifications when you're ready.",
    );
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

export async function testPush(peer: Peer) {
  const reg = await navigator.serviceWorker.getRegistration("/");
  const subscription = await reg?.pushManager.getSubscription();
  if (!subscription) throw Error("Enable notifications on this device first.");
  return post(peer, "/api/push/test", { endpoint: subscription.endpoint });
}

export type NotificationPreferences = {
  chat: boolean;
  // A chat finished its work.
  done: boolean;
  // OpenClaw's background work ended.
  openclaw: boolean;
  computer: boolean;
  handoffs: boolean;
  access: boolean;
  pausedUntil: number;
};

export async function notificationPreferences(
  peer: Peer,
  change?: {
    preferences?: Partial<Omit<NotificationPreferences, "pausedUntil">>;
    pauseMinutes?: number;
  },
) {
  const reg = await navigator.serviceWorker.getRegistration("/");
  const subscription = await reg?.pushManager.getSubscription();
  if (!subscription) throw Error("Enable notifications on this device first.");
  const result = await request<{ preferences: NotificationPreferences }>(
    peer,
    change
      ? "/api/push"
      : `/api/push?endpoint=${encodeURIComponent(subscription.endpoint)}`,
    change
      ? {
          method: "PATCH",
          body: JSON.stringify({
            endpoint: subscription.endpoint,
            preferences: {},
            ...change,
          }),
        }
      : undefined,
  );
  if (!result.preferences)
    throw Error("Couldn't load notification controls. Try again.");
  return result.preferences;
}
