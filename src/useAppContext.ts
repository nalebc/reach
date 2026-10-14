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
  const unsupported = useRef(false);
  const generation = useRef(0);
  const enabled = useRef(active);
  enabled.current = active;
  const sendRef = useRef(send);
  sendRef.current = send;
  const refresh = useCallback(async () => {
    if (!enabled.current || unsupported.current || document.hidden) return;
    const mine = generation.current;
    try {
      const result = (await sendRef.current({
        type: "context",
        ...(stamp.current ? { since: stamp.current } : {}),
      })) as unknown as ContextResult;
      if (mine !== generation.current || !enabled.current) return;
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
    } catch (error) {
      if (mine !== generation.current || !enabled.current) return;
      // Only an explicit unsupported action identifies an older host. Native
      // refusals and connection errors can recover on the next ordinary poll.
      unsupported.current =
        /^Unsupported (desktop action|input(?: type)?)\.?$/i.test(
          (error as Error)?.message || "",
        );
      stamp.current = undefined;
      setApp(null);
      setItems([]);
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    generation.current++;
    unsupported.current = false;
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [active, refresh]);
  return { app: active ? app : null, items, refresh };
}
