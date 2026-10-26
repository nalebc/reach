// No workspace or API caching. Explicit fallback setup may also save a
// complete public interface; notification intents remain short-lived/one-use.
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

// Public code only. Content-addressed bodies are shared between complete
// interface generations, including the large Go client. Nothing here stores
// an approval, identity key, API answer, request body or workspace content.
const shellBodies = "reach-static-bytes-v1", shellRecords = "reach-static-cohorts-v1";
const shellPrefix = "/__reach-static-v1/", shellJobs = new Map(), shellPins = new Map();
const shellHash = /^[a-f0-9]{64}$/, shellFileLimit = 64 * 1024 * 1024;
const shellTotalLimit = 96 * 1024 * 1024, shellStoreLimit = 144 * 1024 * 1024;
// Exactly the existing private *.ts.net owner policy (PUBLIC_CSP). The model
// checks parity; arbitrary server/worker message headers never enter a cache.
const shellCsp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' https://*.ts.net:* wss://*.ts.net:* https://*.tailscale.com wss://*.tailscale.com; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";
function shellHeaders(type, bytes) {
  const headers = new Headers({ "Content-Type": type, "Content-Security-Policy": shellCsp, "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Strict-Transport-Security": "max-age=31536000" });
  if (bytes !== undefined) headers.set("Content-Length", String(bytes));
  return headers;
}
let shellMutations = Promise.resolve();
const shellKey = value => new URL(shellPrefix + value, self.location.origin).href;
const shellSha = async body => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), byte => byte.toString(16).padStart(2, "0")).join("");
const shellPath = path => typeof path === "string" && (/^\/assets\/[\w.-]+$/.test(path) ||
  /^\/pdfjs\/(?:jbig2_nowasm_fallback|openjpeg_nowasm_fallback)\.js$/.test(path) ||
  ["/index.html", "/start.html", "/manifest.webmanifest", "/favicon.svg"].includes(path));
const shellRuntime = path => /^\/tailnet\/(?:reach-tailnet\.[a-f0-9]{12,64}\.wasm|wasm_exec\.[a-f0-9]{12,64}\.js)$/.test(path);
const shellNavigation = url => url.origin === self.location.origin && (url.pathname === "/" || /^\/(?:files|chats|screen|terminals|settings|tools)(?:\/[\w.-]*)*$/.test(url.pathname));
const shellSource = source => {
  try { const url = new URL(source?.url); return url.protocol === "https:" && url.hostname.endsWith(".ts.net") && shellNavigation(url); }
  catch { return false; }
};
function shellEntry(value, runtime = false) {
  if (!value || !(runtime ? shellRuntime(value.path) : shellPath(value.path)) || !shellHash.test(value.sha256) ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > (runtime ? shellFileLimit : 8 * 1024 * 1024) ||
      typeof value.type !== "string" || value.type.length > 80 || !/^(?:text\/(?:javascript|css|html)|image\/(?:png|svg\+xml)|font\/(?:woff2?|ttf)|application\/(?:wasm|octet-stream|manifest\+json))$/.test(value.type)) throw Error("invalid");
  if (runtime) {
    const match = /\.([a-f0-9]{12,64})\.(wasm|js)$/.exec(value.path);
    if (!value.sha256.startsWith(match[1]) || value.type !== (match[2] === "wasm" ? "application/wasm" : "text/javascript")) throw Error("invalid");
  } else {
    const extension = value.path.split(".").slice(-1)[0];
    const expected = { js: "text/javascript", mjs: "text/javascript", css: "text/css", html: "text/html", png: "image/png", svg: "image/svg+xml",
      woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", wasm: "application/wasm", webmanifest: "application/manifest+json", bcmap: "application/octet-stream", pfb: "application/octet-stream" }[extension];
    if (value.type !== expected) throw Error("invalid");
  }
  return { path: value.path, bytes: value.bytes, sha256: value.sha256, type: value.type };
}
function shellConfig(value) {
  if (value?.product !== "Reach" || typeof value.instance !== "string" || value.instance.length > 256) throw Error("invalid");
  const origin = new URL(value.origin), own = new URL(self.location.origin);
  if (origin.protocol !== "https:" || origin.origin !== value.origin || origin.hostname !== own.hostname ||
      !origin.hostname.endsWith(".ts.net")) throw Error("invalid");
  const client = value.tailnet;
  if (!client || !shellRuntime("/tailnet/" + client.wasm) || !client.wasm.endsWith(".wasm") ||
      !shellRuntime("/tailnet/" + client.exec) || !client.exec.endsWith(".js")) throw Error("invalid");
  // Unknown fields (including Face ID/enrollment hints) are intentionally lost.
  return { product: "Reach", origin: origin.origin,
    ...(value.home === "https://" + own.hostname ? { home: value.home } : {}),
    name: "Reach", instance: value.instance, tailnet: { wasm: client.wasm, exec: client.exec } };
}
async function shellJson(cache, key) {
  const response = await cache.match(shellKey(key));
  if (!response) return null;
  const reader = response.body.getReader(), parts = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break;
    if ((size += value.byteLength) > 512 * 1024) throw Error("invalid"); parts.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  const body = new Uint8Array(size); let offset = 0;
  for (const value of parts) { body.set(value, offset); offset += value.length; }
  return JSON.parse(new TextDecoder().decode(body));
}
const shellWrite = (cache, key, value) => cache.put(shellKey(key), new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }));
async function shellCohorts(cache) {
  const records = [];
  for (const key of await cache.keys()) {
    const path = new URL(key.url || key).pathname;
    if (!new RegExp("^" + shellPrefix + "cohort/[a-f0-9]{64}$").test(path)) continue;
    if (records.length >= 2) throw Error("invalid");
    const record = await shellJson(cache, path.slice(shellPrefix.length));
    if (!record || record.version !== 1 || !shellHash.test(record.id) || !shellHash.test(record.build) || !Array.isArray(record.entries) || record.entries.length > 514) throw Error("invalid");
    record.config = shellConfig(record.config);
    record.entries = record.entries.map(value => shellEntry(value, shellRuntime(value.path)));
    if (!record.entries.some(entry => entry.path === "/index.html") ||
        record.entries.reduce((n, entry) => n + entry.bytes, 0) > shellTotalLimit) throw Error("invalid");
    records.push(record);
  }
  return records;
}
async function shellSpace(records, cohorts, active, id) {
  if (cohorts.some(record => record.id === id) || cohorts.length < 2) return;
  const clients = (await self.clients.matchAll({ type: "window", includeUncontrolled: true })).filter(shellSource);
  const unknown = clients.some(client => !shellPins.has(client.id));
  const pinned = new Set(clients.map(client => shellPins.get(client.id)?.id).filter(Boolean));
  const remove = cohorts.find(record => record.id !== active?.id && !pinned.has(record.id));
  if (!remove || unknown) throw Error("busy");
  await records.delete(shellKey("cohort/" + remove.id)); cohorts.splice(cohorts.indexOf(remove), 1);
}
async function shellCommand(event) {
  const command = event.data, records = await caches.open(shellRecords), bodies = await caches.open(shellBodies);
  const cohorts = await shellCohorts(records), active = await shellJson(records, "active");
  if (command.action === "pin" || command.action === "bootstrap") {
    if (!shellHash.test(command.build)) return { ok: false };
    const pinned = shellPins.get(event.source.id);
    const cohort = cohorts.find(record => record.id === pinned?.id && record.build === command.build) ||
      cohorts.find(record => record.id === active?.id && record.build === command.build) || cohorts.find(record => record.build === command.build);
    shellPins.set(event.source.id, { build: command.build, id: cohort?.id });
    return { ok: true, enabled: !!active, config: command.action === "bootstrap" ? cohort?.config : undefined };
  }
  if (command.action === "runtime") {
    const paths = command.paths;
    if (!Array.isArray(paths) || paths.length !== 2 || !paths.every(shellRuntime)) throw Error("invalid");
    const entries = [];
    for (const path of paths) {
      const found = cohorts.flatMap(record => record.entries).find(entry => entry.path === path);
      if (found && await bodies.match(shellKey("body/" + found.sha256))) entries.push(found);
    }
    return { ok: true, entries };
  }
  if (command.action === "retire") {
    shellJobs.clear(); shellPins.clear();
    // Serialize retirement with commits; a late prepared reply cannot publish
    // behind this new epoch, even after the worker has been stopped/restarted.
    const epoch = (await shellJson(records, "epoch"))?.value || 0;
    await shellWrite(records, "epoch", { value: epoch + 1 });
    for (const key of await records.keys()) if (new URL(key.url || key).pathname !== shellPrefix + "epoch") await records.delete(key);
    for (const key of await bodies.keys()) await bodies.delete(key);
    return { ok: true };
  }
  if (command.action === "begin") {
    const manifest = command.manifest, config = shellConfig(command.config);
    if (manifest?.version !== 1 || !shellHash.test(manifest.build) || !Array.isArray(manifest.entries) ||
        manifest.entries.length > 512 || !Array.isArray(command.runtime) || command.runtime.length !== 2) throw Error("invalid");
    const entries = [...manifest.entries.map(value => shellEntry(value)), ...command.runtime.map(value => shellEntry(value, true))];
    if (new Set(entries.map(entry => entry.path)).size !== entries.length || !entries.some(entry => entry.path === "/index.html") ||
        entries.reduce((n, entry) => n + entry.bytes, 0) > shellTotalLimit ||
        ![config.tailnet.wasm, config.tailnet.exec].every(name => entries.some(entry => entry.path === "/tailnet/" + name))) throw Error("invalid");
    const id = await shellSha(new TextEncoder().encode(JSON.stringify([manifest.build, config, entries])));
    await shellSpace(records, cohorts, active, id);
    // One bounded job per client; another page cannot replace or commit it.
    for (const [key, job] of shellJobs) if (job.until < Date.now() || job.client === event.source.id) shellJobs.delete(key);
    if (shellJobs.size >= 2) throw Error("busy");
    const kept = new Map([...cohorts.flatMap(record => record.entries), ...entries,
      ...[...shellJobs.values()].flatMap(job => job.entries)].map(entry => [entry.sha256, entry.bytes]));
    if ([...kept.values()].reduce((n, bytes) => n + bytes, 0) > shellStoreLimit) throw Error("storage");
    for (const key of await bodies.keys()) if (!kept.has(new URL(key.url || key).pathname.split("/").slice(-1)[0])) await bodies.delete(key);
    const random = new Uint8Array(16); crypto.getRandomValues(random);
    const jobId = Array.from(random, byte => byte.toString(16).padStart(2, "0")).join("");
    const epoch = (await shellJson(records, "epoch"))?.value || 0;
    shellJobs.set(jobId, { id, build: manifest.build, config, entries, client: event.source.id, epoch, until: Date.now() + 120000 });
    const missing = [];
    for (const entry of entries) if (!await bodies.match(shellKey("body/" + entry.sha256))) missing.push(entry);
    return { ok: true, job: jobId, missing };
  }
  const job = shellJobs.get(command.job);
  if (!job || job.client !== event.source.id || job.until < Date.now() || job.epoch !== ((await shellJson(records, "epoch"))?.value || 0)) throw Error("cancelled");
  if (command.action === "cancel") { shellJobs.delete(command.job); return { ok: true }; }
  if (command.action === "put") {
    const entry = job.entries.find(value => value.path === command.path), body = command.body;
    if (!entry || !(body instanceof ArrayBuffer) || body.byteLength !== entry.bytes || body.byteLength > shellFileLimit || await shellSha(body) !== entry.sha256) throw Error("invalid");
    await bodies.put(shellKey("body/" + entry.sha256), new Response(body, { headers: { "Content-Type": entry.type, "Content-Length": String(entry.bytes) } }));
    return { ok: true };
  }
  if (command.action === "commit") {
    const cancelled = () => shellJobs.get(command.job) !== job || job.until < Date.now();
    const current = () => {
      if (cancelled()) throw Error("cancelled");
    };
    const rollback = async () => {
      // CacheStorage writes cannot be aborted. Restore the previous complete
      // pointer before processing any queued preparation or retirement.
      if (active) await shellWrite(records, "active", active);
      else await records.delete(shellKey("active"));
      throw Error("cancelled");
    };
    for (const entry of job.entries) {
      const response = await bodies.match(shellKey("body/" + entry.sha256));
      if (!response || response.headers.get("Content-Length") !== String(entry.bytes)) throw Error("storage");
      const body = await response.arrayBuffer();
      current();
      if (body.byteLength !== entry.bytes || await shellSha(body) !== entry.sha256) {
        await bodies.delete(shellKey("body/" + entry.sha256)); throw Error("storage");
      }
    }
    // Another client's completed preparation may have committed since begin.
    await shellSpace(records, cohorts, active, job.id);
    current();
    const record = { version: 1, id: job.id, build: job.build, config: job.config, entries: job.entries };
    await shellWrite(records, "cohort/" + job.id, record);
    current();
    await shellWrite(records, "active", { id: job.id });
    if (cancelled()) return rollback();
    const readBack = await shellJson(records, "active");
    if (cancelled()) return rollback();
    if (readBack?.id !== job.id) throw Error("storage");
    const pinned = shellPins.get(event.source.id);
    if (pinned?.build === job.build && !pinned.id) shellPins.set(event.source.id, { build: job.build, id: job.id });
    shellJobs.delete(command.job);
    return { ok: true, id: job.id };
  }
  throw Error("invalid");
}
self.addEventListener("message", event => {
  if (event.data?.type !== "reach-static-shell-v1" || (event.origin && event.origin !== self.location.origin) || !shellSource(event.source)) return;
  if (event.data.action === "hello") { event.ports?.[0]?.postMessage({ ok: true, version: 1 }); return; }
  // Invalidate synchronously, including while a prior commit awaits the
  // browser's cache writes. Only this job's owning client can cancel it.
  if (event.data.action === "retire") shellJobs.clear();
  if (event.data.action === "cancel" && shellJobs.get(event.data.job)?.client === event.source.id) shellJobs.delete(event.data.job);
  const run = () => shellCommand(event).then(value => event.ports?.[0]?.postMessage(value), error => {
    event.ports?.[0]?.postMessage({ ok: false, reason: ["busy", "cancelled", "invalid"].includes(error.message) ? error.message : "storage" });
  });
  shellMutations = shellMutations.then(run, run);
  event.waitUntil(shellMutations);
});
self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url);
  const navigation = request.mode === "navigate" && shellNavigation(url);
  if (request.method !== "GET" || url.origin !== self.location.origin || (url.search && !navigation) || request.headers?.has("Authorization")) return;
  if (!navigation && !shellPath(url.pathname) && !shellRuntime(url.pathname)) return;
  // A network transition must never reject a document's respondWith promise.
  // This inert page retries only navigation GETs, never workspace actions.
  const network = () => fetch(request).catch(error => {
    if (!navigation) throw error;
    return new Response('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="5"><title>Reconnecting to Reach</title></head><body style="margin:0;padding:32px;background:#111816;color:#edf2ee;font:18px/1.5 system-ui"><h1>Reconnecting to Reach…</h1><p>Your connection changed. Reach will retry automatically at this same link.</p><p>Keep your computer online with Reach and Tailscale running.</p><a href="" style="color:#b9efd8">Try again now</a></body></html>', { status: 503, headers: shellHeaders("text/html") });
  });
  event.respondWith((async () => {
    try {
      const cache = await caches.open(shellRecords), bodies = await caches.open(shellBodies), cohorts = await shellCohorts(cache);
      const active = await shellJson(cache, "active");
      const selected = cohorts.find(record => record.id === active?.id);
      const cohort = navigation ? selected : cohorts.find(record => record.id === shellPins.get(event.clientId)?.id) || selected;
      // The permanent owner URL boots the connection screen. It can resume
      // saved access or finish first-time browser sign-in without native HTTP.
      // Legacy private-port snapshots keep their existing recovery entry.
      const page = !url.port && cohort?.entries.some(value => value.path === "/start.html") ? "/start.html" : "/index.html";
      const entry = cohort?.entries.find(value => value.path === (navigation ? page : url.pathname)) ||
        (!navigation && cohorts.flatMap(record => record.entries).find(value => value.path === url.pathname));
      const response = entry && await bodies.match(shellKey("body/" + entry.sha256));
      if (response) {
        if (navigation) {
          for (const required of cohort.entries) if (!await bodies.match(shellKey("body/" + required.sha256))) {
            return network();
          }
          if (event.resultingClientId) shellPins.set(event.resultingClientId, { build: cohort.build, id: cohort.id });
          const headers = shellHeaders(entry.type, entry.bytes); headers.set("X-Reach-Cached-Shell", cohort.build);
          return new Response(response.body, { headers });
        }
        return new Response(response.body, { headers: shellHeaders(entry.type, entry.bytes) });
      }
    } catch { /* Incomplete/evicted code never supplies API or workspace data. */ }
    return network();
  })());
});
