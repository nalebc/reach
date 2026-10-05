// Reach's notifications (src/push.ts, server/push.mjs). This worker only
// shows what the computer sends and opens Reach when one is tapped. It never
// handles the page's requests, so it can't serve a stale Reach or cache data.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

// Only a page of Reach itself ("//elsewhere" is another site).
const ownPage = (url) =>
  typeof url === "string" && /^\/(?!\/)/.test(url) && !url.includes("\\")
    ? url
    : "/";

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {}
  const title =
    typeof data.title === "string" && data.title
      ? data.title.slice(0, 120)
      : "Reach";
  // Every push shows a notification: iPhone stops delivering to pages that don't.
  event.waitUntil(
    self.registration.showNotification(title, {
      tag: typeof data.tag === "string" ? data.tag : "reach",
      renotify: true,
      icon: "/favicon.svg",
      data: { url: ownPage(data.url) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(
    ownPage(event.notification.data?.url),
    self.location.origin,
  ).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows)
        if (
          new URL(client.url).origin === self.location.origin &&
          "focus" in client
        )
          return client.focus();
      return self.clients.openWindow(url);
    })(),
  );
});
