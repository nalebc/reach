// A restored document can keep its scripts and an empty React container.
// A body element count calls that healthy, even though there is no page.
export function pageHasContent(doc: Document) {
  const visible = (element: Element) => {
    const win = doc.defaultView;
    for (let parent: Element | null = element; parent; parent = parent.parentElement) {
      if (parent.hasAttribute("hidden")) return false;
      const style = win?.getComputedStyle(parent);
      if (style?.display === "none" || style?.opacity === "0" ||
        style?.getPropertyValue("content-visibility") === "hidden") return false;
    }
    const style = win?.getComputedStyle(element);
    if (style?.visibility === "hidden" || style?.visibility === "collapse") return false;
    // Parsed HTML and DOM-only tests have no viewport. A rendered page must
    // actually put its content on screen, rather than retain offscreen nodes.
    const width = doc.documentElement.clientWidth, height = doc.documentElement.clientHeight;
    if (!win || !width || !height) return true;
    return [...element.getClientRects()].some(rect => rect.width > 0 && rect.height > 0 &&
      rect.right > 0 && rect.bottom > 0 && rect.left < width && rect.top < height);
  };
  const roots = [doc.getElementById("root"), doc.getElementById("start")]
    .filter((root): root is HTMLElement => !!root);
  const content = (root: Element) => {
    for (const element of [root, ...root.querySelectorAll("canvas,video,img,svg,input,button,[role=status],[role=alert]")])
      if (element.matches("canvas,video,img,svg,input,button,[role=status],[role=alert]") && visible(element)) return true;
    const text = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
    while (text.nextNode())
      if (text.currentNode.textContent?.trim() && text.currentNode.parentElement && visible(text.currentNode.parentElement)) return true;
    return false;
  };
  return roots.some(content) ||
    !!doc.body && [...doc.body.children].some(child =>
      !roots.includes(child as HTMLElement) &&
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
export function watchPageRecovery(options: Partial<{
  doc: Document;
  win: Window;
  answers: typeof documentAnswers;
  reopen: (href: string) => void;
  every: (check: () => void) => number;
  clear: (timer: number) => void;
}> = {}) {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const answers = options.answers ?? documentAnswers;
  const reopen = options.reopen ?? ((href: string) => win.location.replace(reconnectUrl(href)));
  const every = options.every ?? ((check: () => void) => win.setInterval(check, 2000));
  const clear = options.clear ?? ((timer: number) => win.clearInterval(timer));
  let missing = false, stopped = false, opening = false;
  let pending: AbortController | undefined;
  let cover: HTMLElement | undefined;
  const uncover = () => { cover?.remove(); cover = undefined; };
  const check = () => {
    if (stopped || opening || !doc.body) return;
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
    const timer = win.setTimeout(() => controller.abort(), 6000);
    // A suspended browser transport may never settle its promise, including
    // after abort. Release this attempt on our own deadline so a late result
    // cannot hold every later foreground recovery hostage.
    const finish = () => {
      win.clearTimeout(timer);
      if (pending === controller) pending = undefined;
    };
    controller.signal.addEventListener("abort", finish, { once: true });
    void answers(win.location.href, controller.signal).catch(() => false).then(ready => {
      if (!ready || stopped || controller.signal.aborted || doc.hidden || pageHasContent(doc)) return;
      opening = true;
      reopen(win.location.href);
    }).finally(() => {
      controller.signal.removeEventListener("abort", finish);
      finish();
    });
  };
  const timer = every(check);
  for (const event of ["pageshow", "focus", "online"]) win.addEventListener(event, check);
  doc.addEventListener("visibilitychange", check);
  doc.addEventListener("resume", check);
  check();
  return () => {
    stopped = true;
    pending?.abort();
    clear(timer);
    uncover();
    for (const event of ["pageshow", "focus", "online"]) win.removeEventListener(event, check);
    doc.removeEventListener("visibilitychange", check);
    doc.removeEventListener("resume", check);
  };
}

let watching = false;
export function keepPageRecovery() {
  if (watching) return;
  watching = true;
  watchPageRecovery();
}
