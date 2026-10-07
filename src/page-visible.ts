import { useEffect, useState } from "react";

// Whether this page is on screen. Polls stop while it's in the background
// (another tab, the phone locked) and look again the moment it's back.
export function usePageVisible() {
  const [visible, setVisible] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  return visible;
}
