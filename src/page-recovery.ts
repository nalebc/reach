// A restored document can keep its scripts and an empty React container.
// A body element count calls that healthy, even though there is no page.
export function pageHasContent(doc: Document) {
  const roots = [doc.getElementById("root"), doc.getElementById("start")]
    .filter((root): root is HTMLElement => !!root);
  const content = (root: Element) => !!root.textContent?.trim() ||
    !!root.querySelector("canvas,video,img,svg,input,button,[role=status],[role=alert]");
  return roots.length ? roots.some(content) :
    !!doc.body && [...doc.body.children].some(child =>
      !child.hasAttribute("data-reach-page-recovery") &&
      !["SCRIPT", "STYLE", "LINK"].includes(child.tagName) && content(child));
}

export function reconnectUrl(href: string, now = Date.now()) {
  const url = new URL(href);
  url.searchParams.set("reach-reconnect", String(now));
  return url.href;
}

async function documentAnswers(href: string, signal: AbortSignal) {
  const response = await fetch(reconnectUrl(href), {
    cache: "no-store", credentials: "same-origin", signal,
  });
  if (!response.ok || response.headers.get("X-Reach-Cached-Shell")) return false;
  const html = await response.text();
  return pageHasContent(new DOMParser().parseFromString(html, "text/html"));
}

// Recovery only reads the document and reopens its current address. It never
// retries an API action, changes a saved approval, or replaces a working page.
export function watchPageRecovery({
  doc = document,
  win = window,
  answers = documentAnswers,
  reopen = (_href: string) => win.location.reload(),
  every = (check: () => void) => setInterval(check, 2000),
  clear = (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
} = {}) {
  let missing = false, stopped = false, opening = false;
  let pending: AbortController | undefined;
  let cover: HTMLElement | undefined;
  const uncover = () => { cover?.remove(); cover = undefined; };
  const check = () => {
    if (stopped || opening) return;
    if (doc.hidden) {
      missing = false;
      pending?.abort();
      return;
    }
    if (pageHasContent(doc)) {
      missing = false;
      pending?.abort();
      uncover();
      return;
    }
    // An ordinary React commit or startup transition may briefly be empty.
    if (!missing) { missing = true; return; }
    if (pending) return;
    if (!cover) {
      cover = doc.createElement("section");
      cover.setAttribute("data-reach-page-recovery", "");
      cover.setAttribute("role", "status");
      cover.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:grid;align-content:center;gap:16px;padding:32px;box-sizing:border-box;background:#111816;color:#edf2ee;font:16px/1.5 system-ui,sans-serif";
      const words = doc.createElement("p");
      words.textContent = "Reconnecting to Reach…";
      const link = doc.createElement("a");
      link.textContent = "Reload Reach";
      link.href = reconnectUrl(win.location.href);
      link.style.color = "inherit";
      cover.append(words, link);
      doc.body.append(cover);
    }
    const controller = new AbortController();
    pending = controller;
    const timer = setTimeout(() => controller.abort(), 6000);
    void answers(win.location.href, controller.signal).catch(() => false).then(ready => {
      if (!ready || stopped || controller.signal.aborted || doc.hidden || pageHasContent(doc)) return;
      opening = true;
      reopen(win.location.href);
    }).finally(() => {
      clearTimeout(timer);
      if (pending === controller) pending = undefined;
    });
  };
  const timer = every(check);
  for (const event of ["pageshow", "focus", "online"]) win.addEventListener(event, check);
  doc.addEventListener("visibilitychange", check);
  check();
  return () => {
    stopped = true;
    pending?.abort();
    clear(timer);
    uncover();
    for (const event of ["pageshow", "focus", "online"]) win.removeEventListener(event, check);
    doc.removeEventListener("visibilitychange", check);
  };
}

let watching = false;
export function keepPageRecovery() {
  if (watching) return;
  watching = true;
  watchPageRecovery();
}
