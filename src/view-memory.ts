import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { Peer } from "./api";

// View preferences only, for this open tab. Never store requests, results or
// credentials on disk. A new grant gets its own views; a verified transport
// handoff keeps the workspace identity already assigned by app-watch.
const documents = new WeakMap<Document, Map<string, unknown>>();
function memory() {
  let values = documents.get(document);
  if (!values) documents.set(document, values = new Map());
  return values;
}
function remember(key: string, value: unknown) {
  const values = memory();
  values.delete(key);
  values.set(key, value);
  if (values.size > 600) values.delete(values.keys().next().value!);
}
export function viewScope(peer: Peer | null | undefined, view: string) {
  return JSON.stringify([
    peer?.workspaceKey || (peer ? JSON.stringify([peer.id, peer.url, peer.token, peer.transport, peer.sessionId]) : ""),
    view,
  ]);
}

export function useViewState<T>(scope: string, name: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const key = JSON.stringify([scope, name]);
  const read = () => memory().has(key) ? memory().get(key) as T : initial;
  const [held, setHeld] = useState(() => ({ key, value: read() }));
  const value = held.key === key ? held.value : read();
  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setHeld((old) => {
      const previous = old.key === key ? old.value : read();
      const value = typeof next === "function" ? (next as (old: T) => T)(previous) : next;
      remember(key, value);
      return { key, value };
    });
  }, [key]);
  return [value, set];
}

// Opening Search may focus it; restoring an already-open Search must not
// summon the phone keyboard or let a swipe's preview steal focus.
export function useSearchFocus<T extends HTMLElement>(open: boolean) {
  const field = useRef<T>(null);
  const requested = useRef(false);
  useLayoutEffect(() => {
    if (open && requested.current) field.current?.focus({ preventScroll: true });
    requested.current = false;
  }, [open]);
  return { field, requestFocus: () => { requested.current = true; } };
}

function scrollParent(element: HTMLElement): HTMLElement {
  for (let at = element.parentElement; at; at = at.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(at).overflowY)) return at;
  }
  return (document.scrollingElement || document.documentElement) as HTMLElement;
}

// Wait for a returning list to fill before restoring its position. Stop on
// user input, so delayed data can never drag someone away from new work.
// Inactive swipe previews must neither restore nor record the shared viewport.
export function useViewScroll<T extends HTMLElement>(scope: string, enabled = true, ready = true) {
  const [element, bind] = useState<T | null>(null);
  const status = useRef(ready);
  status.current = ready;
  const control = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (!element || !enabled) return;
    const key = JSON.stringify([scope, "scroll"]);
    const scroller = scrollParent(element);
    const target = memory().get(key);
    const top = typeof target === "number" ? target : 0;
    let pending = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => remember(key, scroller.scrollTop);
    const finish = () => {
      pending = false;
      clearTimeout(timer);
      save();
    };
    const restore = () => {
      if (!pending || (!status.current && top > 0)) return;
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      scroller.scrollTop = Math.min(top, max);
      if (max >= top) finish();
      // A shorter list (deleted/filtered items) settles at its new end.
      else timer ??= setTimeout(finish, 1500);
    };
    control.current = restore;
    const scroll = (event: Event) => {
      if (!pending && (event.target === scroller || event.target === document)) save();
    };
    const input = (event: Event) => {
      if (event.type === "keydown" && !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes((event as KeyboardEvent).key)) return;
      if (pending) finish();
    };
    const observer = new ResizeObserver(restore);
    observer.observe(element);
    observer.observe(scroller);
    document.addEventListener("scroll", scroll, true);
    for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) document.addEventListener(name, input, { passive: true });
    restore();
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      control.current = null;
      document.removeEventListener("scroll", scroll, true);
      for (const name of ["wheel", "touchstart", "pointerdown", "keydown"]) document.removeEventListener(name, input);
    };
  }, [element, scope, enabled]);
  useLayoutEffect(() => { control.current?.(); });
  return bind;
}
