import type { ITerminalOptions, Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";

// The terminal fitted to its box, the newest line still in sight when the
// reader was at it: a box that shrinks (the keyboard closing, a bar
// growing) must never leave the prompt under the keys.
export function fitKeepingLatest(fit: FitAddon, term: Terminal) {
  const buffer = term.buffer.active;
  const latest = buffer.viewportY >= buffer.baseY;
  fit.fit();
  if (latest) term.scrollToBottom();
}

// One look for every terminal view.
export function terminalOptions(): ITerminalOptions {
  return {
    cursorBlink: true,
    // Phones fit more columns at 12px; full-screen programs need the width.
    fontSize: matchMedia("(max-width: 600px)").matches ? 12 : 14,
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
    theme: {
      background: "#0c110f",
      foreground: "#dce5dd",
      cursor: "#b9efd4",
      selectionBackground: "#354831",
      black: "#182019",
      red: "#f18d8d",
      green: "#b9f568",
      yellow: "#e3c67a",
      blue: "#8fb9f4",
      magenta: "#c7a8e9",
      cyan: "#86d0bd",
      white: "#e5ece6",
      // xterm draws its own scrollbar; its width is in styles.css.
      scrollbarSliderBackground: "#354635",
      scrollbarSliderHoverBackground: "#354635",
      scrollbarSliderActiveBackground: "#354635",
    },
    scrollback: 5000,
    convertEol: false,
  };
}

// Option (Alt) + ← / → jump a word, as they did before xterm 6, which now
// sends them as bare modified arrows (ESC [1;3D) that shells don't bind.
// Same bytes xterm 5 sent: the Mac's ESC b / ESC f, elsewhere Ctrl + arrow.
export function altArrowWords(term: Terminal) {
  const mac = ["Macintosh", "MacIntel", "MacPPC", "Mac68K"].includes(
    navigator.platform,
  );
  const words: Record<string, string> = mac
    ? { ArrowLeft: "\x1bb", ArrowRight: "\x1bf" }
    : { ArrowLeft: "\x1b[1;5D", ArrowRight: "\x1b[1;5C" };
  term.attachCustomKeyEventHandler((event) => {
    const word = words[event.key];
    if (!word || event.type !== "keydown" || !event.altKey) return true;
    if (event.ctrlKey || event.metaKey || event.shiftKey) return true;
    event.preventDefault();
    term.input(word);
    return false;
  });
}

// Keystrokes go straight to the computer; the phone must not rewrite them.
export function plainKeyboard(term: Terminal) {
  const helper = term.textarea;
  // xterm positions a tiny textarea over the cursor. Safari zooms the whole
  // page when that field inherits the terminal's 12px font.
  if (helper) helper.style.fontSize = "16px";
  for (const [name, value] of [
    ["autocorrect", "off"],
    ["autocapitalize", "off"],
    ["autocomplete", "off"],
    ["spellcheck", "false"],
    ["writingsuggestions", "false"],
  ])
    helper?.setAttribute(name, value);
}

// Mac tabs send snapshots, not a PTY stream. Keep the reader's place when
// those snapshots change; a reset must not turn every refresh into "Latest".
export function writeSnapshot(term: Terminal, text: string) {
  const buffer = term.buffer?.active;
  const top = buffer?.viewportY ?? 0;
  const following = !buffer || top >= buffer.baseY;
  term.reset();
  term.write(text, () => {
    if (following) term.scrollToBottom();
    else term.scrollToLine(top);
  });
}

// xterm ignores touch scrolling when a program enables mouse reporting.
// Translate deliberate vertical drags into the same wheel path used by a
// trackpad (including alternate-screen programs). Never focus after a drag.
export function terminalTouch(element: HTMLElement, term: Terminal) {
  let start: { x: number; y: number; lastY: number; moved: boolean } | null = null;
  let suppressClickUntil = 0;
  let remainder = 0;
  const down = (event: TouchEvent) => {
    if (event.touches.length !== 1) { start = null; return; }
    const t = event.touches[0];
    start = { x: t.clientX, y: t.clientY, lastY: t.clientY, moved: false };
    remainder = 0;
  };
  const move = (event: TouchEvent) => {
    if (!start || event.touches.length !== 1) return;
    const t = event.touches[0];
    if (!start.moved) {
      const dx = Math.abs(t.clientX - start.x), dy = Math.abs(t.clientY - start.y);
      if (dy < 8 || dy < dx) return;
      start.moved = true;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    const delta = start.lastY - t.clientY;
    start.lastY = t.clientY;
    suppressClickUntil = Date.now() + 500;
    if (term.buffer?.active.type === "alternate") {
      element.querySelector(".xterm")?.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, deltaY: delta,
        clientX: t.clientX, clientY: t.clientY,
      }));
    } else {
      const row = (element.querySelector(".xterm-screen")?.getBoundingClientRect().height || element.clientHeight) / (term.rows || 24) || 18;
      remainder += delta;
      const lines = Math.trunc(remainder / row);
      if (lines) { term.scrollLines(lines); remainder -= lines * row; }
    }
  };
  const up = () => { start = null; };
  const click = (event: MouseEvent) => {
    if (Date.now() < suppressClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  element.addEventListener("touchstart", down, { passive: true, capture: true });
  element.addEventListener("touchmove", move, { passive: false, capture: true });
  element.addEventListener("touchend", up, true);
  element.addEventListener("touchcancel", up, true);
  element.addEventListener("click", click, true);
  return () => {
    element.removeEventListener("touchstart", down, true);
    element.removeEventListener("touchmove", move, true);
    element.removeEventListener("touchend", up, true);
    element.removeEventListener("touchcancel", up, true);
    element.removeEventListener("click", click, true);
  };
}

// xterm queues layout work for the next animation frames (open, reset);
// disposing before it runs throws "reading 'dimensions'". Callbacks run in
// order, so two frames later the queued work has finished.
export function disposeLater(term: Terminal) {
  requestAnimationFrame(() => requestAnimationFrame(() => term.dispose()));
}
