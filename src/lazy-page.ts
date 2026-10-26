import { createElement, lazy, type ComponentProps, type ComponentType } from "react";

// Pages whose code loads when first opened (Screen, Terminals). Their files
// are fixed, hashed GETs, safe to ask for again: a connection that drops for
// a moment (a phone between networks, a handoff between Reach's routes) costs
// a retry, never a page that stays on "This screen couldn't open".
//
// Vite's preload counts a stylesheet that failed as loaded and leaves its
// dead <link> in place, so a page imported again would open without its
// styles. Each load first puts a fresh copy in place of every stylesheet the
// document saw fail.
const failedSheets = new Set<HTMLLinkElement>();
if (typeof document !== "undefined")
  document.addEventListener(
    "error",
    (event) => {
      const link = event.target;
      if (link instanceof HTMLLinkElement && link.rel === "stylesheet")
        failedSheets.add(link);
    },
    true,
  );
function restoreSheets() {
  for (const dead of [...failedSheets]) {
    failedSheets.delete(dead);
    if (dead.isConnected) dead.replaceWith(dead.cloneNode());
  }
}

// After a failed load, wait this long (ms) before each new attempt.
export const PAGE_RETRY_MS: readonly number[] = [300, 1500];

export async function loadAgain<T>(
  load: () => Promise<T>,
  waits: readonly number[] = PAGE_RETRY_MS,
): Promise<T> {
  for (let tries = 0; ; tries++) {
    restoreSheets();
    try {
      return await load();
    } catch (error) {
      if (tries >= waits.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, waits[tries]));
    }
  }
}

// React.lazy keeps a failed load for good. The page says so (ScreenBoundary);
// Try again, or opening the page again, then starts a new load: never
// before, so a page that can't load isn't asked for in a loop.
const failedPages = new Set<() => void>();
export function retryFailedPages() {
  for (const retry of [...failedPages]) retry();
  failedPages.clear();
}
export function lazyPage<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
  waits: readonly number[] = PAGE_RETRY_MS,
) {
  const attempt = () =>
    loadAgain(load, waits).catch((error) => {
      failedPages.add(() => (Page = lazy(attempt)));
      throw error;
    });
  let Page = lazy(attempt);
  return function LazyPage(props: ComponentProps<T>) {
    return createElement(Page as ComponentType<ComponentProps<T>>, props);
  };
}
