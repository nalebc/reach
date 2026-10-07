import { useCallback, useEffect, useState } from "react";
import { post, request, type Peer } from "./api";

// Apps on your phone (server/app-threads.mjs): an app runs on the Mac on its
// own hidden display, in a window shaped like this phone.
export type Region = { x: number; y: number; w: number; h: number };
export type AppThread = {
  id: string;
  appId: string;
  name: string;
  state: "starting" | "running" | "paused" | "closed";
  // Held by a pause on the Mac: comes back to the phone on Resume.
  held?: boolean;
  createdAt: string;
  display?: string;
  region?: Region;
  size?: { w: number; h: number };
  scale?: number;
};

// The area an app gets on this phone, in CSS pixels (Mac points at 1:1): the
// whole visible screen, below the status bar when Reach runs full screen
// from the Home Screen.
const insetTop = (view: Window) => {
  try {
    const probe = view.document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;height:0;visibility:hidden;padding-top:env(safe-area-inset-top)";
    view.document.body.append(probe);
    const inset = parseFloat(view.getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
    return inset;
  } catch {
    return 0;
  }
};
export function phoneViewport(view: Window = window) {
  const width = Math.round(view.visualViewport?.width || view.innerWidth);
  const height = Math.round(
    (view.visualViewport?.height || view.innerHeight) - insetTop(view),
  );
  const clamp = (n: number) => Math.min(1000, Math.max(200, n));
  // Pixels per point: the stream needn't be sharper than the screen.
  const scale = Math.min(
    4,
    Math.max(1, Math.round((view.devicePixelRatio || 1) * 2) / 2),
  );
  return { width: clamp(width), height: clamp(height), scale };
}
export const portrait = (size: {
  width: number;
  height: number;
  scale?: number;
}) => size.height >= size.width;

// Touch point (0..1 across the shown window) → 0..1 across the hidden display,
// which is what the Mac's input helper expects.
export function toDisplay(
  thread: Pick<AppThread, "region" | "size">,
  u: number,
  v: number,
) {
  const { region, size } = thread;
  if (!region || !size) return null;
  return {
    x: Math.min(1, Math.max(0, (region.x + u * region.w) / size.w)),
    y: Math.min(1, Math.max(0, (region.y + v * region.h) / size.h)),
  };
}

export const openThread = (peer: Peer, appId: string, size = phoneViewport()) =>
  post<AppThread>(peer, "/api/screen/apps", { appId, ...size });
export const rotateThread = (peer: Peer, id: string, size = phoneViewport()) =>
  request<AppThread>(peer, `/api/screen/apps/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(size),
  });
// Quit the app on the Mac, as ⌘Q does. `confirm` when it also has windows
// on the Mac's own screens; `waiting` while it asks something (unsaved work).
export type QuitResult =
  | { confirm: true; others: number }
  | { quit: boolean; waiting?: boolean; removed?: boolean };
export const quitThread = (peer: Peer, id: string, confirm = false) =>
  post<QuitResult>(peer, `/api/screen/apps/${encodeURIComponent(id)}/quit`, {
    confirm,
  });
// Text fields in the window, in points from its top-left.
export type Field = {
  x: number;
  y: number;
  w: number;
  h: number;
  secure: boolean;
};
export const threadFields = (peer: Peer, id: string) =>
  request<{ fields: Field[]; complete: boolean }>(
    peer,
    `/api/screen/apps/${encodeURIComponent(id)}/fields`,
  );
export const returnThread = (peer: Peer, id: string) =>
  request<{ closed: boolean; returned: boolean }>(
    peer,
    `/api/screen/apps/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );

const isThread = (t: unknown): t is AppThread =>
  !!t &&
  typeof (t as AppThread).id === "string" &&
  typeof (t as AppThread).appId === "string" &&
  typeof (t as AppThread).name === "string";

// The computer's app threads, refreshed when its presence fingerprint for
// them changes (no polling). `changes` is the fleet connection's string.
export function useAppThreads(peer: Peer, enabled: boolean, changes?: string) {
  const [threads, setThreads] = useState<AppThread[]>([]);
  let fingerprint: string | undefined;
  try {
    fingerprint = changes ? JSON.parse(changes).apps : undefined;
  } catch {}
  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const list = await request<unknown>(peer, "/api/screen/apps");
      if (Array.isArray(list)) setThreads(list.filter(isThread));
    } catch {
      /* Older computers have no app threads. */
    }
  }, [peer.url, peer.token, enabled]);
  useEffect(() => {
    void refresh();
  }, [refresh, fingerprint]);
  const upsert = useCallback((thread: AppThread) => {
    setThreads((list) => [thread, ...list.filter((t) => t.id !== thread.id)]);
  }, []);
  const remove = useCallback((id: string) => {
    setThreads((list) => list.filter((t) => t.id !== id));
  }, []);
  return { threads, refresh, upsert, remove };
}

// The last frame seen of each thread, for the switcher: like the iPhone's app
// switcher, a snapshot from when you left, at no cost to the computer.
const snapshots = new Map<string, string>();
export const snapshotOf = (id: string) => snapshots.get(id);
export function keepSnapshot(id: string, canvas: HTMLCanvasElement | null) {
  if (!canvas?.width || !canvas.height) return;
  try {
    const scale = Math.min(1, 240 / canvas.width);
    const small = document.createElement("canvas");
    small.width = Math.round(canvas.width * scale);
    small.height = Math.round(canvas.height * scale);
    small.getContext("2d")?.drawImage(canvas, 0, 0, small.width, small.height);
    snapshots.set(id, small.toDataURL("image/jpeg", 0.7));
  } catch {
    /* A tainted or lost canvas leaves the app's logo in place. */
  }
}
export const forgetSnapshot = (id: string) => snapshots.delete(id);
