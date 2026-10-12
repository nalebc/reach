// No workspace or API caching. Only agent icons and short-lived, one-use
// notification-button intents are stored by this worker.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
const ICONS = ["codex", "claude", "gemini", "openclaw", "agent", "mac"];
const iconCache = "reach-notification-icons-v1";
const intentCache = "reach-notification-intents-v1";
const ownPage = (value) => {
  try {
    if (
      typeof value !== "string" ||
      !/^\/(?!\/)/.test(value) ||
      /[\\\u0000-\u0020]/.test(value)
    )
      return "/";
    const url = new URL(value, self.location.origin);
    return url.origin === self.location.origin
      ? url.pathname + url.search + url.hash
      : "/";
  } catch {
    return "/";
  }
};
const intentKey = (id) =>
  new URL(`/__reach-notification-intent/${id}`, self.location.origin).href;
const validSource = (source) => {
  try {
    return new URL(source?.url).origin === self.location.origin;
  } catch {
    return false;
  }
};
self.addEventListener("message", (event) => {
  // The sender's origin (browsers name it) and its page's own address.
  if (event.origin && event.origin !== self.location.origin) return;
  if (!validSource(event.source)) return;
  if (event.data?.type === "reach-notification-icons")
    event.waitUntil(
      (async () => {
        const cache = await caches.open(iconCache);
        for (const name of ICONS) {
          const data = event.data.logos?.[name === "mac" ? "macos" : name];
          if (
            typeof data !== "string" ||
            data.length > 250000 ||
            !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(data)
          )
            continue;
          const bytes = Uint8Array.from(atob(data.split(",")[1]), (char) =>
            char.charCodeAt(0),
          );
          await cache.put(
            new URL(`/notification-icons/${name}.png`, self.location.origin),
            new Response(bytes, { headers: { "Content-Type": "image/png" } }),
          );
        }
      })(),
    );
  if (
    event.data?.type === "take-notification-intent" &&
    /^[a-f0-9-]{36}$/.test(event.data.id)
  )
    event.waitUntil(
      (async () => {
        const cache = await caches.open(intentCache);
        const key = intentKey(event.data.id);
        const saved = await cache.match(key);
        await cache.delete(key); // consume before replying, including on another tab
        const value = saved ? await saved.json() : null;
        event.ports?.[0]?.postMessage(value?.until > Date.now() ? value : null);
      })(),
    );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const match =
    /^\/notification-icons\/(codex|claude|gemini|openclaw|agent|mac)\.png$/.exec(
      url.pathname,
    );
  if (
    url.origin !== self.location.origin ||
    !match ||
    event.request.method !== "GET"
  )
    return;
  event.respondWith(
    (async () =>
      (await (await caches.open(iconCache)).match(event.request)) ||
      fetch(event.request).catch(() =>
        fetch("/notification-icons/agent.svg"),
      ))(),
  );
});
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {}
  const actionLimit =
    typeof self.Notification?.maxActions === "number"
      ? Math.max(0, Math.min(2, self.Notification.maxActions))
      : 0;
  const actions = Array.isArray(data.actions)
    ? data.actions
        .filter(
          (item) =>
            ["open", "deny"].includes(item?.action) &&
            typeof item.title === "string",
        )
        .slice(0, actionLimit)
        .map((item) => ({
          action: item.action,
          title: item.title.slice(0, 40),
        }))
    : [];
  event.waitUntil(
    self.registration.showNotification(
      typeof data.title === "string" && data.title
        ? data.title.slice(0, 120)
        : "New activity",
      {
        body: typeof data.body === "string" ? data.body.slice(0, 240) : "",
        tag: typeof data.tag === "string" ? data.tag : "reach",
        renotify: true,
        icon: ICONS.includes(data.icon)
          ? `/notification-icons/${data.icon}.png`
          : "/assets/reach-mascot-9274aea5a9-192.png",
        badge: "/notification-icons/agent.svg",
        actions,
        data: {
          url: ownPage(data.url),
          notification: data.notification,
          actions: actions.map((item) => item.action),
        },
      },
    ),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const data = event.notification.data || {};
      const url = new URL(ownPage(data.url), self.location.origin);
      let intent;
      if (
        event.action === "deny" &&
        data.actions?.includes("deny") &&
        typeof data.notification?.id === "string" &&
        data.notification.id.length <= 1500 &&
        /^[a-f0-9]{64}$/.test(data.notification.revision)
      ) {
        intent = crypto.randomUUID();
        const cache = await caches.open(intentCache);
        const existing = await cache.keys();
        for (const key of existing) {
          const entry = await cache.match(key);
          const value = entry ? await entry.json() : null;
          if (!value || value.until <= Date.now() || existing.length >= 50)
            await cache.delete(key);
        }
        await cache.put(
          intentKey(intent),
          new Response(
            JSON.stringify({
              ...data.notification,
              action: "deny",
              url: url.href,
              until: Date.now() + 300000,
            }),
            { headers: { "Content-Type": "application/json" } },
          ),
        );
        url.searchParams.set("notificationIntent", intent);
      }
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if (validSource(client) && "focus" in client) {
          const focused = await client.focus();
          if (intent) return focused.navigate(url.href);
          else
            focused.postMessage(
              url.searchParams.has("page")
                ? { type: "reach-open", url: url.href }
                : { type: "reach-notifications" },
            );
          return focused;
        }
      }
      return self.clients.openWindow(url.href);
    })(),
  );
});
