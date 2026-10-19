// Stand-in for xterm.js, which can't draw in jsdom: records what's written.
export class Terminal {
  static instances = [];
  constructor() {
    Terminal.instances.push(this);
    this.written = [];
    this.modes = { applicationCursorKeysMode: false, bracketedPasteMode: false };
    this.cols = 80;
    this.rows = 24;
    this.buffer = { active: { baseY: 0, viewportY: 0, type: "normal" } };
  }
  loadAddon() {}
  open() {}
  write(data, done) {
    this.written.push(data);
    done?.();
  }
  reset() {
    this.written = [];
  }
  focus() {}
  scrollToBottom() { this.scrollToLine(this.buffer.active.baseY); }
  scrollToLine(line) { this.buffer.active.viewportY = line; this.scrolled?.(); }
  scrollLines(lines) { this.scrollToLine(this.buffer.active.viewportY + lines); }
  onScroll(listener) { this.scrolled = listener; return { dispose: () => { this.scrolled = null; } }; }
  onData(listener) {
    (this.listeners ??= []).push(listener);
    return {
      dispose: () => this.listeners.splice(this.listeners.indexOf(listener), 1),
    };
  }
  // What typing on the phone keyboard does: the terminal hears it.
  type(data) {
    for (const listener of this.listeners ?? []) listener(data);
  }
  // xterm 6's paste (browser/Clipboard.ts): line breaks become Return, and
  // the text is bracketed when the program asked (ESC [?2004h).
  paste(text) {
    const data = text.replace(/\r?\n/g, "\r");
    this.type(this.modes.bracketedPasteMode ? `\x1b[200~${data}\x1b[201~` : data);
  }
  attachCustomKeyEventHandler() {}
  dispose() {}
}
export class FitAddon {
  fit() {}
}
