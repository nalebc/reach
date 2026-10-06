import { useEffect, useState } from "react";

// Where a notification takes you, in one tap: a chat, an app handed to you,
// or the request itself opened for review (not the list it's in). Read from
// the address Reach opens with (?page=…&agent=…&id=… / &needs=…), or passed
// by the service worker when Reach is already open (public/sw.js).
export type OpenTarget = { page: string; agent?: string; id?: string; threadId?: string; needs?: string };

const PAGE = /^[a-z][\w-]{0,30}$/;
const VALUE = /^[\w:.@-]{1,200}$/;
export function openTarget(href: string): OpenTarget | null {
  let url: URL;
  try {
    url = new URL(href, location.origin);
  } catch {
    return null;
  }
  const page = url.searchParams.get("page") || "";
  if (!PAGE.test(page)) return null;
  const target: OpenTarget = { page };
  for (const key of ["agent", "id", "threadId", "needs"] as const) {
    const value = url.searchParams.get(key);
    if (value && VALUE.test(value)) target[key] = value;
  }
  return target;
}

// The address without the link's own bits, so a reload doesn't open it again.
export function withoutTarget(href: string) {
  const url = new URL(href, location.origin);
  for (const key of ["page", "agent", "id", "threadId", "needs"]) url.searchParams.delete(key);
  return url.pathname + (url.search === "?" ? "" : url.search) + url.hash;
}

// A request to open for review on Home (needs=…), until Home has it.
let wanted: string | null = null;
const listeners = new Set<() => void>();
export function wantNeed(key: string | null) {
  wanted = key;
  for (const listener of listeners) listener();
}
export function wantedNeed() {
  return wanted;
}
export function onWantedNeed(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// On Home: the wanted request opened for review the moment it's listed, with
// its "opens" action (Review, Open), never a decision like Allow. Forgotten
// if it never shows up (already answered elsewhere).
export function useOpenWantedNeed(items: { key: string; actions?: { opens?: boolean; run: () => unknown }[] }[]) {
  const [wanted, setWanted] = useState(wantedNeed);
  useEffect(() => {
    const stop = onWantedNeed(() => setWanted(wantedNeed()));
    return () => void stop();
  }, []);
  useEffect(() => {
    if (!wanted) return;
    const item = items.find((i) => i.key === wanted);
    if (item) {
      wantNeed(null);
      item.actions?.find((a) => a.opens)?.run();
      return;
    }
    const giveUp = setTimeout(() => wantNeed(null), 20000);
    return () => clearTimeout(giveUp);
  });
}
