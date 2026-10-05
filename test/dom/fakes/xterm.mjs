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
  onData() {
    return { dispose() {} };
  }
  attachCustomKeyEventHandler() {}
  dispose() {}
}
export class FitAddon {
  fit() {}
}
