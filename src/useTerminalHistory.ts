import { useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";

export function useTerminalHistory() {
  const terminal = useRef<Terminal | null>(null);
  const [reading, setReading] = useState(false);
  const observe = (term: Terminal) => {
    terminal.current = term;
    setReading(false);
    const update = () => {
      const buffer = term.buffer.active;
      setReading(buffer.viewportY < buffer.baseY);
    };
    const listener = term.onScroll?.(update);
    const parsed = term.onWriteParsed?.(update);
    // Track both xterm v5 (.xterm-viewport) and xterm v6 (.xterm-scrollable-element).
    const viewport = term.element?.querySelector(".xterm-viewport");
    const scrollable = term.element?.querySelector(".xterm-scrollable-element");
    let frame = 0;
    const scroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    viewport?.addEventListener("scroll", scroll, { passive: true });
    scrollable?.addEventListener("scroll", scroll, { passive: true });
    scrollable?.addEventListener("wheel", scroll, { passive: true });
    return () => {
      listener?.dispose();
      parsed?.dispose();
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("scroll", scroll);
      scrollable?.removeEventListener("scroll", scroll);
      scrollable?.removeEventListener("wheel", scroll);
      terminal.current = null;
    };
  };
  const latest = () => {
    terminal.current?.scrollToBottom();
    setReading(false);
  };
  return { reading, observe, latest };
}
