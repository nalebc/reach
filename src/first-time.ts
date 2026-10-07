import { useCallback, useState } from "react";

// Hints shown once: remembered on this phone. Where storage is blocked
// (private browsing), once per visit.
const shown = new Set<string>();
const key = (name: string) => `reach.hint.${name}`;
function seen(name: string) {
  try {
    return localStorage.getItem(key(name)) === "seen";
  } catch {
    return shown.has(name);
  }
}

export function useFirstTime(name: string): [boolean, () => void] {
  const [open, setOpen] = useState(() => !seen(name));
  const done = useCallback(() => {
    try {
      localStorage.setItem(key(name), "seen");
    } catch {
      shown.add(name);
    }
    setOpen(false);
  }, [name]);
  return [open, done];
}
