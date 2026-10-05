import { useEffect, useState } from "react";
import { request, type Peer } from "./api";
export type Shortcut = {
  id: string;
  name: string;
  detail: string;
  kind: string;
  suggested?: boolean;
  custom?: boolean;
  appId?: string;
};
export type CustomShortcut = {
  id: string;
  name: string;
  type: "app" | "website" | "terminal";
  actionId?: string;
  url?: string;
  // Terminal shortcuts: run `command` in a new terminal, in a shared folder.
  root?: number;
  path?: string;
  command?: string;
  available?: boolean;
};
export const shortcutScore = (a: Shortcut) =>
  a.custom
    ? -1
    : a.id === "codex-new"
      ? 0
      : a.kind === "codex"
        ? 1
        : /chrome/i.test(a.name)
          ? 2
          : a.kind === "browser"
            ? 3
            : a.kind === "terminal"
              ? 4
              : 5;
// Home shows shortcuts in more than one place: one request serves them all.
const recent = new Map<string, { at: number; list: Promise<Shortcut[]> }>();
function fetchShortcuts(peer: Peer) {
  const key = JSON.stringify([peer.url, peer.token]);
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < 3000) return hit.list;
  const list = request<Shortcut[]>(peer, "/api/apps/shortcuts");
  recent.set(key, { at: Date.now(), list });
  list.catch(() => recent.delete(key));
  return list;
}
export function shortcutsChanged(peer: Peer) {
  for (const key of recent.keys())
    if (JSON.parse(key)[0] === peer.url) recent.delete(key);
  window.dispatchEvent(
    new CustomEvent("reach-shortcuts-changed", { detail: peer.url }),
  );
}
export function useShortcuts(peer: Peer) {
  const [items, setItems] = useState<Shortcut[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    setItems([]);
    setLoading(true);
    setError("");
    let active = true;
    let sequence = 0;
    const load = async () => {
      const current = ++sequence;
      try {
        const result = [...(await fetchShortcuts(peer))];
        if (active && current === sequence) {
          setItems(
            result.sort(
              (a, b) =>
                shortcutScore(a) - shortcutScore(b) ||
                a.name.localeCompare(b.name),
            ),
          );
          setError("");
        }
      } catch (e) {
        if (active && current === sequence) setError((e as Error).message);
      } finally {
        if (active && current === sequence) setLoading(false);
      }
    };
    const changed = (e: Event) => {
      if ((e as CustomEvent).detail === peer.url) void load();
    };
    void load();
    window.addEventListener("reach-shortcuts-changed", changed);
    return () => {
      active = false;
      window.removeEventListener("reach-shortcuts-changed", changed);
    };
  }, [peer.url, peer.token]);
  return { items, loading, error };
}
