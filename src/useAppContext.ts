import { useCallback, useEffect, useRef, useState } from "react";
import type { DesktopAction, InputResult } from "./desktop-input-queue";
import type { HostApp, MenuItem } from "./app-context";

type ContextResult = {
  app?: HostApp | null;
  stamp?: string;
  unchanged?: boolean;
  items?: MenuItem[];
};

// Which app is in front on the computer, refreshed while controlling. The host
// re-sends the menu only when it changed (stamp), so polling stays small.
export function useAppContext(
  send: (action: DesktopAction) => Promise<InputResult>,
  active: boolean,
) {
  const [app, setApp] = useState<HostApp | null>(null);
  const [items, setItems] = useState<MenuItem[]>([]);
  const stamp = useRef<string | undefined>(undefined);
  const failures = useRef(0);
  const sendRef = useRef(send);
  sendRef.current = send;
  const refresh = useCallback(async () => {
    if (failures.current >= 3 || document.hidden) return;
    try {
      const result = (await sendRef.current({
        type: "context",
        ...(stamp.current ? { since: stamp.current } : {}),
      })) as unknown as ContextResult;
      failures.current = 0;
      if (!result.app) {
        setApp(null);
        return;
      }
      const next = result.app;
      setApp((current) =>
        current?.bundle === next.bundle && current.name === next.name
          ? current
          : next,
      );
      if (!result.unchanged) {
        stamp.current = result.stamp;
        setItems(result.items ?? []);
      }
    } catch {
      // Older hosts reject the action; stop asking after a few failures.
      failures.current++;
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    failures.current = 0;
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, [active, refresh]);
  return { app: active ? app : null, items, refresh };
}
