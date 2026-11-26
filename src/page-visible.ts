import { useEffect, useState } from "react";

// Standalone Home Screen web views on iOS/Android often omit visibilitychange
// when returning from the app switcher, Control Center or lock screen, firing
// pageshow/focus or simply resuming timers after a suspension gap instead.
export function onAppResume(listener: (suspended: boolean) => void): () => void {
  if (typeof window === "undefined" || typeof document === "undefined")
    return () => {};
  let hiddenAt = document.hidden ? Date.now() : undefined;
  let lastTick = Date.now();
  let lastWakeAt = 0;
  let lastWakeSuspended = false;

  const markHidden = () => {
    hiddenAt ??= Date.now();
  };

  const wake = (forceSuspended = false) => {
    if (document.hidden) {
      markHidden();
      return;
    }
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    const suspended =
      forceSuspended ||
      (hiddenAt !== undefined && now - hiddenAt >= 3000) ||
      gap >= 8000;
    hiddenAt = undefined;
    if (now - lastWakeAt < 250 && (!suspended || lastWakeSuspended)) return;
    lastWakeAt = now;
    lastWakeSuspended = suspended;
    listener(suspended);
  };

  const onVisibility = () => {
    if (document.hidden) markHidden();
    else wake();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    wake(event.persisted);
  };
  const onFocus = () => wake();
  const onResume = () => wake(true);

  const liveness = window.setInterval(() => {
    const now = Date.now();
    const gap = now - lastTick;
    lastTick = now;
    if (document.hidden) {
      markHidden();
      return;
    }
    if (gap >= 8000 || hiddenAt !== undefined) {
      if (gap >= 8000) hiddenAt ??= now - gap;
      wake(gap >= 8000);
    }
  }, 2000);

  document.addEventListener("visibilitychange", onVisibility);
  document.addEventListener("freeze", markHidden);
  document.addEventListener("resume", onResume);
  window.addEventListener("pagehide", markHidden);
  window.addEventListener("pageshow", onPageShow);
  window.addEventListener("focus", onFocus);

  return () => {
    window.clearInterval(liveness);
    document.removeEventListener("visibilitychange", onVisibility);
    document.removeEventListener("freeze", markHidden);
    document.removeEventListener("resume", onResume);
    window.removeEventListener("pagehide", markHidden);
    window.removeEventListener("pageshow", onPageShow);
    window.removeEventListener("focus", onFocus);
  };
}

// Whether this page is on screen. Polls stop while it's in the background
// (another tab, the phone locked) and look again the moment it's back.
export function usePageVisible() {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || !document.hidden,
  );
  useEffect(() => {
    const update = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("pageshow", update);
    window.addEventListener("focus", update);
    document.addEventListener("resume", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("pageshow", update);
      window.removeEventListener("focus", update);
      document.removeEventListener("resume", update);
    };
  }, []);
  return visible;
}
