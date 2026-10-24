// After Reach restarts with a new phone interface, an open page reloads itself
// so it isn't left on the old one, but only while nothing is being typed,
// answered or signed in, so nothing is lost, and only while it isn't being
// used: in the background (another app, the phone locked), or left untouched
// for a few minutes. It reloaded mid-read each time an agent saved a file,
// the chat back at its end (Oct 8). The Mac's live connection says
// which interface it serves (presence `changes.build`). Foreground checks also
// cover restored pages and browsers whose connection uses a different port.
import { reloadFromBase } from "./nav-history";
import { offlineShellEnabled, prepareInterfaceReload } from "./offline-shell";
let first: string | null = null;
let waiting = false;
let generation = 0;
let pageChecked = false;
let checkingPage = false;
export type UpdateState =
  "checking" | "current" | "offline" | "waiting" | "reloading";
let updateState: UpdateState = "checking";
const listeners = new Set<() => void>();
export const getUpdateState = () => updateState;
export const subscribeUpdates = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
function setUpdateState(state: UpdateState) {
  if (state === updateState) return;
  updateState = state;
  for (const listener of listeners) listener();
}
export function freshInterfaceUrl(href: string, now = Date.now()) {
  const url = new URL(href);
  url.searchParams.set("reach-update", String(now));
  return url.href;
}
type UpdateOptions = {
  reload?: () => void;
  busy?: () => boolean;
  wait?: (f: () => void) => unknown;
  currentPage?: () => Promise<boolean | null>;
  prepare?: () => Promise<boolean>;
};
// The last touch, key, scroll or wheel on the page (its load counts).
let touched = Date.now();
export const IDLE_MS = 5 * 60 * 1000;
if (typeof window !== "undefined")
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart", "scroll"])
    window.addEventListener(type, () => (touched = Date.now()), { capture: true, passive: true });
// Someone is looking at it and used it lately.
export function inUse(doc: Document = document, now = Date.now()) {
  return !doc.hidden && now - touched < IDLE_MS;
}
function queueUpdate({
  // From this document's first entry (src/nav-history.ts): the new interface
  // replaces it and no entry of the old one is left for Back to reload.
  reload = () => reloadFromBase(() => location.replace(freshInterfaceUrl(location.href))),
  busy = () => busyHere() || inUse(),
  wait = (f) => setTimeout(f, 5000),
  prepare = offlineShellEnabled() ? prepareInterfaceReload : undefined,
}: UpdateOptions) {
  if (waiting) return;
  waiting = true;
  const seen = generation;
  let done = false;
  let preparing = false, prepared = false;
  const attempt = () => {
    if (seen !== generation || done) return;
    if (busy()) {
      setUpdateState("waiting");
      wait(attempt);
    } else {
      if (prepare && !prepared) {
        if (preparing) return;
        preparing = true;
        void prepare().catch(() => false).then(ready => {
          preparing = false;
          if (seen !== generation || done) return;
          prepared = ready;
          if (ready) attempt();
          else { setUpdateState("waiting"); wait(attempt); }
        });
        return;
      }
      done = true;
      setUpdateState("reloading");
      reload();
    }
  };
  // Put away (another app, the screen locked): now, not up to 5 s later,
  // when the page may already be frozen.
  if (typeof document !== "undefined")
    document.addEventListener("visibilitychange", () => document.hidden && attempt());
  attempt();
}
// Live screens and app windows open on this page: a reload mid-stream threw
// the phone back to the loading scene each time an agent edited the interface.
let streams = 0;
export function holdReload() {
  let held = true;
  streams++;
  return () => {
    if (held) streams--;
    held = false;
  };
}

export function busyHere(doc: Document = document) {
  if (streams > 0) return true;
  const active = doc.activeElement as HTMLElement | null;
  if (active && /^(TEXTAREA|INPUT|SELECT)$/.test(active.tagName)) return true;
  for (const el of doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
    "textarea, input",
  ))
    if (
      !["file", "hidden", "checkbox", "radio"].includes(el.type) &&
      el.value.trim()
    )
      return true;
  // A sign-in under way, a question half answered, a reset being confirmed.
  return !!doc.querySelector(
    ".sign-in[role=group], .as-prompt .chosen, .as-banner-actions > span",
  );
}

// A restored Home Screen page may first reconnect after the host has already
// changed builds. Its first presence packet is then the NEW build, not proof
// that the page loaded that build. Compare the page's hashed assets as well.
export async function currentPageMatches(
  doc: Document = document,
  load: typeof fetch = fetch,
  { timeoutMs = 10000 } = {},
) {
  const assets = (page: Document, selector: string) =>
    Array.from(page.querySelectorAll(selector))
      .map((el) => el.getAttribute("src") || el.getAttribute("href") || "")
      .filter((url) => url.startsWith("/assets/"))
      .sort();
  const scripts = 'script[type="module"][src]';
  const styles = 'link[rel="stylesheet"][href]';
  const loaded = assets(doc, scripts);
  if (!loaded.length || !/^https?:$/.test(location.protocol)) return true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await load(location.href, {
      cache: "no-store",
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    if (response.headers.get("X-Reach-Cached-Shell")) return null;
    const page = new DOMParser().parseFromString(
      await response.text(),
      "text/html",
    );
    const fresh = assets(page, scripts);
    if (!fresh.length) return null;
    // Vite adds stylesheets for lazy views after loading. Extra loaded styles
    // are expected, especially when the public start page boots the workspace.
    const loadedStyles = new Set(assets(doc, styles));
    return (
      fresh.join("\n") === loaded.join("\n") &&
      assets(page, styles).every((url) => loadedStyles.has(url))
    );
  } catch {
    return null; // an offline page keeps working; presence will retry later
  } finally {
    clearTimeout(timeout);
  }
}

export function checkForUpdates(options: UpdateOptions = {}, force = true) {
  if (checkingPage || waiting || (!force && pageChecked)) return;
  checkingPage = true;
  setUpdateState("checking");
  const seen = generation;
  void (options.currentPage || (() => currentPageMatches()))()
    .then((matches) => {
      if (seen !== generation) return;
      checkingPage = false;
      if (matches === null) {
        setUpdateState("offline");
        return;
      }
      pageChecked = true;
      if (waiting) return;
      if (matches) setUpdateState("current");
      else queueUpdate(options);
    })
    .catch(() => {
      if (seen !== generation) return;
      checkingPage = false;
      setUpdateState("offline");
    });
}

export function watchInterfaceUpdates({
  doc = document,
  win = window,
  check = () => checkForUpdates(),
  every = (f: () => void) => setInterval(f, 60000),
  clear = (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
} = {}) {
  const wake = () => {
    if (!doc.hidden) check();
  };
  wake();
  win.addEventListener("pageshow", wake);
  win.addEventListener("focus", wake);
  win.addEventListener("online", wake);
  doc.addEventListener("visibilitychange", wake);
  const timer = every(wake);
  return () => {
    clear(timer);
    win.removeEventListener("pageshow", wake);
    win.removeEventListener("focus", wake);
    win.removeEventListener("online", wake);
    doc.removeEventListener("visibilitychange", wake);
  };
}

export function noteBuild(build: unknown, options: UpdateOptions = {}) {
  if (typeof build !== "string" || !build) return;
  if (first === null) {
    first = build;
  }
  if (build !== first && !waiting) {
    queueUpdate(options);
    return;
  }
  checkForUpdates(options, false);
}

// Tests start each case afresh.
export function forgetBuild() {
  first = null;
  waiting = false;
  generation++;
  pageChecked = false;
  checkingPage = false;
  setUpdateState("checking");
}
