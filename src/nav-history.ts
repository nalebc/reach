// Reach's back stack, kept on the browser's own history so the on-screen back
// chevron, the iPhone's edge swipe, Android's back and the browser's Back are
// one path. Each entry Reach makes carries `reach: { page, i }`: the page it
// belongs to and how far it sits above this document's first entry (i: 0,
// Home). A page opened from Tools, Settings or a card pushes one. A chat
// opened from its list pushes another; one opened directly owns its page's
// entry. Nested views retain their page's depth and the detail to restore.
// Going back pops one and the view under it comes back
// through popstate, in the same document: never a reload.
//
// Why: an entry left by an earlier document (before an interface rebuild
// reload, or a reload by the phone) is a different page to the browser.
// Landing on it loads Reach again: the owner's back swipe in a chat showed a
// blank page and reloaded instead of going back to the list (Oct 13).
export type View = { page: string; i: number };
type Entry = Record<string, unknown> & { reach?: View };

export const currentEntry = (): Entry => {
  const state = typeof window === "undefined" ? null : window.history.state;
  return state && typeof state === "object" ? state : {};
};

export function currentView(): View | null {
  const view = currentEntry().reach;
  return view && typeof view.page === "string" && Number.isInteger(view.i) && view.i >= 0 ? view : null;
}

/** How many of this document's entries sit above its first one. */
export const stackDepth = () => currentView()?.i ?? 0;

/** The workspace page under any chat or sub-page in the current entry. */
export function pageDepth() {
  const at = currentEntry().reachPageAt;
  return typeof at === "number" && Number.isInteger(at) && at >= 0 && at <= stackDepth()
    ? at : stackDepth();
}

/** Remember the current detail so returning from another page restores it. */
export function updateEntry(marks: Record<string, unknown>) {
  window.history.replaceState({ ...currentEntry(), ...marks }, "");
}

let steppingBack = false;
/** One Back action, shared by buttons and nested views. Ignore double taps. */
export function backOne() {
  if (steppingBack) return true;
  if (!stackDepth()) return false;
  steppingBack = true;
  const done = () => {
    steppingBack = false;
    window.removeEventListener("popstate", done);
    clearTimeout(timer);
  };
  const timer = setTimeout(done, 800);
  window.addEventListener("popstate", done);
  window.history.back();
  return true;
}

/**
 * A fresh document (a cold start, a notification, a reload): its first entry
 * becomes Home, with nothing else marked on it, so whatever Reach opens next
 * has a parent in this document. `url` also cleans the address.
 */
export function seedBase(url?: string) {
  window.history.replaceState({ reach: { page: "overview", i: 0 } }, "", url);
}

/** A page of the workspace, pushed one above `under` (its own entry). */
export function pushPage(page: string, under: number, marks: Record<string, unknown> = {}) {
  window.history.pushState({ ...marks, reach: { page, i: under + 1 }, reachPageAt: under + 1 }, "");
}

/** The entry under the page, now this page's (a tab switch adds nothing). */
export function replacePage(page: string, i: number) {
  window.history.replaceState({ reach: { page, i }, reachPageAt: i }, "");
}

/** A view inside the page (an open chat, a sub-page): one entry above. */
export function pushInPage(marks: Record<string, unknown>) {
  const view = currentView();
  window.history.pushState(
    { ...currentEntry(), reachPageAt: pageDepth(), ...marks, reach: { page: view?.page ?? "", i: (view?.i ?? 0) + 1 } },
    "",
  );
}

// An interface rebuild reload first steps back to this document's first
// entry, so the new document replaces it and no entry of the old one is left
// to land on. Views ignore those steps: the chat stays remembered and opens
// again after the reload.
let reloading = false;
export const leavingForReload = () => reloading;
export function reloadFromBase(reload: () => void, { wait = 800 } = {}) {
  const n = stackDepth();
  if (reloading) return;
  if (n <= 0 || typeof window === "undefined") return reload();
  reloading = true;
  let done = false;
  const go = () => {
    if (done) return;
    done = true;
    window.removeEventListener("popstate", go);
    reload();
  };
  window.addEventListener("popstate", go);
  // A browser that never says it got there still reloads.
  setTimeout(go, wait);
  window.history.go(-n);
}
// Tests start each case afresh.
export function forgetReload() {
  reloading = false;
}
