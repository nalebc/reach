// The pretend computer behind the fake stream and input socket. It records
// every action the phone sends, and `frame()` delivers a new video frame,
// which re-renders the screen the way live video does.
export const computer = {
  actions: [],
  frames: new Set(),
  // What the phone asked to stream and control: { display, thread }.
  stream: null,
  input: null,
  // Video size in pixels, and an answer per action type (e.g. focus).
  size: { width: 1470, height: 956 },
  replies: {},
  // Optional model of the server's control grant (see desktop-input.mjs).
  lease: undefined,
  connected: null,
  refused: 0,
  frame() {
    for (const deliver of this.frames) deliver();
  },
  reset() {
    this.actions.length = 0;
    this.stream = null;
    this.input = null;
    this.size = { width: 1470, height: 956 };
    this.replies = {};
    this.lease = undefined;
    this.connected = null;
    this.refused = 0;
  },
};
