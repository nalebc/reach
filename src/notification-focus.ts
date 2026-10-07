import { useEffect, useRef } from "react";
type PromptTarget = { agent: string; session: string; id: string };
let wanted: PromptTarget | null = null;
const listeners = new Set<() => void>();
export function wantPrompt(target: PromptTarget) {
  wanted = target;
  listeners.forEach((listener) => listener());
}
export function useWantedPrompt(
  agent: string,
  session: string,
  open: (id: string) => void,
) {
  const callback = useRef(open);
  callback.current = open;
  useEffect(() => {
    const check = () => {
      if (wanted?.agent === agent && wanted.session === session) {
        const target = wanted;
        wanted = null;
        callback.current(target.id);
      }
    };
    check();
    listeners.add(check);
    return () => {
      listeners.delete(check);
    };
  }, [agent, session]);
}
