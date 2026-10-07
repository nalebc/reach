// After Reach restarts with a new phone interface, an open page reloads itself
// so it isn't left on the old one, but only while nothing is being typed,
// answered or signed in, so nothing is lost. The Mac's live connection says
// which interface it serves (presence `changes.build`); the first one seen is
// this page's.
let first: string | null = null;
let waiting = false;
let generation = 0;
let pageChecked = false;
let checkingPage = false;
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
  for (const el of doc.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("textarea, input"))
    if (!["file", "hidden", "checkbox", "radio"].includes(el.type) && el.value.trim()) return true;
  // A sign-in under way, a question half answered, a reset being confirmed.
  return !!doc.querySelector(".sign-in[role=group], .as-prompt .chosen, .as-banner-actions > span");
}

// A restored Home Screen page may first reconnect after the host has already
// changed builds. Its first presence packet is then the NEW build, not proof
// that the page loaded that build. Compare the page's hashed assets as well.
export async function currentPageMatches(
  doc: Document = document,
  load: typeof fetch = fetch,
) {
  const signature = (page: Document) =>
    Array.from(page.querySelectorAll('script[type="module"][src], link[rel="stylesheet"][href]'))
      .map((el) => el.getAttribute("src") || el.getAttribute("href") || "")
      .filter((url) => url.startsWith("/assets/"))
      .sort().join("\n");
  const loaded = signature(doc);
  if (!loaded || !/^https?:$/.test(location.protocol)) return true;
  try {
    const response = await load(location.href, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) return null;
    const fresh = signature(new DOMParser().parseFromString(await response.text(), "text/html"));
    return fresh ? fresh === loaded : null;
  } catch {
    return null; // an offline page keeps working; presence will retry later
  }
}

export function noteBuild(
  build: unknown,
  { reload = () => location.reload(), busy = () => busyHere(), wait = (f: () => void) => setTimeout(f, 5000), currentPage = () => currentPageMatches() } = {},
) {
  if (typeof build !== "string" || !build) return;
  const attempt = () => (busy() ? wait(attempt) : reload());
  if (first === null) {
    first = build;
  }
  if (build !== first && !waiting) {
    waiting = true;
    attempt();
    return;
  }
  if (!pageChecked && !checkingPage && !waiting) {
    checkingPage = true;
    const seen = generation;
    void currentPage().then((matches) => {
      if (seen !== generation) return;
      checkingPage = false;
      if (matches === null) return;
      pageChecked = true;
      if (matches || waiting) return;
      waiting = true;
      attempt();
    }).catch(() => { if (seen === generation) checkingPage = false; });
  }
}

// Tests start each case afresh.
export function forgetBuild() {
  first = null;
  waiting = false;
  generation++;
  pageChecked = false;
  checkingPage = false;
}
