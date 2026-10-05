import { useEffect, useState } from "react";
import { post, request, type Peer } from "./api";

// App logos and file-type icons are fetched once per computer and kept on this
// device (IndexedDB), so they show instantly afterwards. Icons wanted at the
// same moment are requested together in one call; anything older than a week
// refreshes quietly while still shown.
type Entry = { icon: string | null; at: number };
const STALE = 7 * 24 * 60 * 60 * 1000;
const RETRY = 60 * 1000;
const HOUR = 60 * 60 * 1000;
const BATCH = 48;
const TYPE = "type:";

const memory = new Map<string, Entry>();
const listeners = new Map<string, Set<() => void>>();
const hydrated = new Map<string, Promise<void>>();
const inflight = new Set<string>();
const failed = new Map<string, number>();
const legacy = new Set<string>();
const queued = new Map<string, { peer: Peer; ids: Set<string> }>();
let timer = 0;

// A computer keeps its identity across re-pairing and Tailscale/direct links.
const scope = (peer: Peer) => peer.computerId || peer.id;
const keyOf = (peer: Peer, appId: string) => `${scope(peer)}\n${appId}`;
const valid = (icon: unknown) =>
  typeof icon === "string" &&
  icon.length < 65536 &&
  /^data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(icon)
    ? icon
    : null;

let database: Promise<IDBDatabase | null> | undefined;
function open() {
  return (database ??= new Promise((resolve) => {
    try {
      const opening = indexedDB.open("reach-app-icons", 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore("icons");
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  }));
}
function hydrate(peer: Peer) {
  const computer = scope(peer);
  let ready = hydrated.get(computer);
  if (!ready) {
    ready = open().then(
      (db) =>
        new Promise<void>((resolve) => {
          if (!db) return resolve();
          try {
            const range = IDBKeyRange.bound(`${computer}\n`, `${computer}\n￿`);
            const store = db.transaction("icons").objectStore("icons");
            const keys = store.getAllKeys(range),
              values = store.getAll(range);
            values.onsuccess = () => {
              keys.result.forEach((key, i) => {
                const value = values.result[i];
                if (!memory.has(String(key)) && typeof value?.at === "number")
                  memory.set(String(key), {
                    icon: valid(value.icon),
                    at: value.at,
                  });
              });
              resolve();
            };
            values.onerror = () => resolve();
          } catch {
            resolve();
          }
        }),
    );
    hydrated.set(computer, ready);
  }
  return ready;
}
async function persist(entries: [string, Entry][]) {
  const db = await open();
  try {
    const store = db?.transaction("icons", "readwrite").objectStore("icons");
    for (const [key, entry] of entries) store?.put(entry, key);
  } catch {}
}
function notify(key: string) {
  listeners.get(key)?.forEach((fn) => fn());
}
// File-type icons: { "type:pdf": icon }. An older Reach without them is asked
// again in an hour rather than remembered as having none.
async function fetchTypeIcons(peer: Peer, ids: string[]) {
  try {
    const { icons } = await request<{ icons: Record<string, unknown> }>(
      peer,
      `/api/files/icons?${new URLSearchParams({ types: ids.map((id) => id.slice(TYPE.length)).join(",") })}`,
    );
    return {
      icons: Object.fromEntries(
        Object.entries(icons || {}).map(([type, icon]) => [TYPE + type, icon]),
      ),
      until: 0,
    };
  } catch (e) {
    return (e as { status?: number }).status === 404
      ? { icons: {}, until: Date.now() - STALE + HOUR }
      : { icons: null, until: 0 };
  }
}
async function fetchIcons(peer: Peer, ids: string[]) {
  const computer = scope(peer);
  let icons: Record<string, unknown> | null = null,
    until = 0;
  if (ids[0]?.startsWith(TYPE))
    ({ icons, until } = await fetchTypeIcons(peer, ids));
  else if (!legacy.has(computer))
    try {
      icons = (
        await post<{ icons: Record<string, unknown> }>(
          peer,
          "/api/apps/icons",
          {
            ids,
          },
        )
      ).icons;
    } catch (e) {
      if ((e as { status?: number }).status === 404) legacy.add(computer);
    }
  // Computers running an older Reach only answer one logo at a time.
  if (!icons && legacy.has(computer) && !ids[0]?.startsWith(TYPE)) {
    const found = await Promise.all(
      ids.map((appId) =>
        request<{ icon: unknown }>(
          peer,
          `/api/apps/shortcuts/icon?${new URLSearchParams({ appId })}`,
        ).then(
          ({ icon }) => [appId, icon] as const,
          () => null,
        ),
      ),
    );
    if (found.some(Boolean))
      icons = Object.fromEntries(found.filter((f) => !!f));
  }
  const now = Date.now(),
    saved: [string, Entry][] = [];
  for (const appId of ids) {
    const key = keyOf(peer, appId);
    inflight.delete(key);
    if (!icons) {
      failed.set(key, now);
      continue;
    }
    // An empty answer never replaces a logo this device already has.
    const entry = {
      icon: valid(icons[appId]) || memory.get(key)?.icon || null,
      at: until || now,
    };
    memory.set(key, entry);
    if (!until) saved.push([key, entry]);
    notify(key);
  }
  if (saved.length) void persist(saved);
}
function flush() {
  timer = 0;
  const work = [...queued.values()];
  queued.clear();
  for (const { peer, ids } of work) {
    const list = [...ids];
    for (let i = 0; i < list.length; i += BATCH)
      void fetchIcons(peer, list.slice(i, i + BATCH));
  }
}
function want(peer: Peer, appId: string) {
  const key = keyOf(peer, appId);
  const entry = memory.get(key);
  if (entry && Date.now() - entry.at < STALE) return;
  if (inflight.has(key) || Date.now() - (failed.get(key) || 0) < RETRY) return;
  inflight.add(key);
  // App logos and file-type icons come from different endpoints.
  const group = `${scope(peer)}\n${appId.startsWith(TYPE) ? "types" : "apps"}`;
  const batch = queued.get(group) || { peer, ids: new Set<string>() };
  batch.peer = peer;
  batch.ids.add(appId);
  queued.set(group, batch);
  // Gather every logo that scrolls into view in the same moment.
  if (!timer) timer = window.setTimeout(flush, 30);
}

// The logo for an installed app, or null until one is known. Cached logos show
// immediately; `visible` gates the network so off-screen apps cost nothing.
export const useAppIcon = (
  peer: Peer,
  appId: string | undefined,
  visible: boolean,
) => useIcon(peer, appId, visible);

// Icons for every file type in a folder through one subscription, rather
// than one per row. Returns a lookup by type.
export function useFileTypeIcons(peer: Peer, types: string[]) {
  const signature = [...new Set(types)].sort().join(",");
  const [, rerender] = useState(0);
  useEffect(() => {
    const ids = signature ? signature.split(",").map((t) => TYPE + t) : [];
    const keys = ids.map((id) => keyOf(peer, id));
    let active = true;
    const update = () => active && rerender((n) => n + 1);
    for (const key of keys) {
      const set = listeners.get(key) || new Set();
      listeners.set(key, set);
      set.add(update);
    }
    void hydrate(peer).then(() => {
      if (!active) return;
      update();
      for (const id of ids) want(peer, id);
    });
    return () => {
      active = false;
      for (const key of keys) {
        const set = listeners.get(key);
        set?.delete(update);
        if (set && !set.size) listeners.delete(key);
      }
    };
  }, [signature, peer.url, peer.token]);
  return (type: string) => memory.get(keyOf(peer, TYPE + type))?.icon || null;
}

function useIcon(peer: Peer, appId: string | undefined, visible: boolean) {
  const key = appId ? keyOf(peer, appId) : "";
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!appId) return;
    let active = true;
    const update = () => active && rerender((n) => n + 1);
    const set = listeners.get(key) || new Set();
    listeners.set(key, set);
    set.add(update);
    void hydrate(peer).then(() => {
      if (!active) return;
      update();
      if (visible) want(peer, appId);
    });
    return () => {
      active = false;
      set.delete(update);
      if (!set.size) listeners.delete(key);
    };
  }, [key, visible, peer.url, peer.token]);
  return key ? memory.get(key)?.icon || null : null;
}
