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
    // Native scrollbar/wheel scrolling suppresses xterm's public onScroll.
    const viewport = term.element?.querySelector(".xterm-viewport");
    let frame = 0;
    const scroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    viewport?.addEventListener("scroll", scroll, { passive: true });
    return () => {
      listener?.dispose();
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("scroll", scroll);
      terminal.current = null;
    };
  };
  const latest = () => {
    terminal.current?.scrollToBottom();
    setReading(false);
  };
  return { reading, observe, latest };
}
