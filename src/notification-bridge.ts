import type { AgentLogos } from "./agent-logos";
export type NotificationIntent = {
  id: string;
  revision: string;
  action: "deny";
  url: string;
};
export function shareNotificationIcons(logos: AgentLogos) {
  if (!navigator.serviceWorker?.getRegistration) return;
  void navigator.serviceWorker
    .getRegistration()
    .then((registration) => {
      registration?.active?.postMessage({
        type: "reach-notification-icons",
        logos,
      });
    })
    .catch(() => {});
}
// A URL alone never authorizes a decision. Only a one-use intent created by
// the service worker after an actual OS notification-button click can do so.
export async function takeNotificationIntent(
  id: string,
): Promise<NotificationIntent | null> {
  if (!/^[a-f0-9-]{36}$/.test(id) || !navigator.serviceWorker) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  const worker = registration?.active;
  if (!worker) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(null);
    }, 5000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      const value = event.data;
      resolve(
        value?.action === "deny" &&
          typeof value.id === "string" &&
          /^[a-f0-9]{64}$/.test(value.revision)
          ? value
          : null,
      );
    };
    worker.postMessage({ type: "take-notification-intent", id }, [
      channel.port2,
    ]);
  });
}
