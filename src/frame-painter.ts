// Shows decoded video frames without falling behind: at most one draw per
// screen refresh, always the newest frame. Frames that arrive before the next
// refresh replace the waiting one (which is closed, freeing the decoder's
// buffer), so a phone that can't draw every frame skips frames instead of
// building up delay.
type Frame = { close(): void };
export function latestFramePainter<F extends Frame>(
  draw: (frame: F) => void,
  schedule: (callback: () => void) => number = (callback) =>
    requestAnimationFrame(callback),
  cancel: (handle: number) => void = (handle) => cancelAnimationFrame(handle),
) {
  let waiting: F | undefined,
    handle = 0;
  const paint = () => {
    handle = 0;
    const frame = waiting;
    waiting = undefined;
    if (!frame) return;
    try {
      draw(frame);
    } finally {
      frame.close();
    }
  };
  return {
    push(frame: F) {
      waiting?.close();
      waiting = frame;
      if (!handle) handle = schedule(paint);
    },
    stop() {
      if (handle) cancel(handle);
      handle = 0;
      waiting?.close();
      waiting = undefined;
    },
  };
}
