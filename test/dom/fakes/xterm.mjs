// Stand-in for xterm.js, which can't draw in jsdom: records what's written.
export class Terminal {
  static instances = [];
  constructor() {
    Terminal.instances.push(this);
    this.written = [];
    this.modes = { applicationCursorKeysMode: false };
    this.cols = 80;
    this.rows = 24;
  }
  loadAddon() {}
  open() {}
  write(data) {
    this.written.push(data);
  }
  reset() {
    this.written = [];
  }
  focus() {}
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
  attachCustomKeyEventHandler() {}
  dispose() {}
}
export class FitAddon {
  fit() {}
}
