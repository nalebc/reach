import type { ITerminalOptions, Terminal } from "@xterm/xterm";

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
    },
    scrollback: 5000,
    convertEol: false,
  };
}

// Keystrokes go straight to the computer; the phone must not rewrite them.
export function plainKeyboard(term: Terminal) {
  const helper = term.textarea;
  for (const [name, value] of [
    ["autocorrect", "off"],
    ["autocapitalize", "off"],
    ["autocomplete", "off"],
    ["spellcheck", "false"],
    ["writingsuggestions", "false"],
  ])
    helper?.setAttribute(name, value);
}

// xterm queues layout work for the next animation frames (open, reset);
// disposing before it runs throws "reading 'dimensions'". Callbacks run in
// order, so two frames later the queued work has finished.
export function disposeLater(term: Terminal) {
  requestAnimationFrame(() => requestAnimationFrame(() => term.dispose()));
}
