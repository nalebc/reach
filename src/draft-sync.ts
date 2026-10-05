// Coalesce keystrokes and allow just one request in flight. Send waits for the
// latest draft so a slow response cannot put old text back after submission.
export function createDraftSync(write: (text: string) => Promise<unknown>, delay = 400) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let next: string | undefined;
  let running: Promise<void> | null = null;
  let closed = false;
  const flush = async (): Promise<void> => {
    clearTimeout(timer);
    if (running) { await running; return flush(); }
    if (closed || next === undefined) return;
    const text = next;
    next = undefined;
    running = write(text).then(() => {}, () => {}).finally(() => { running = null; });
    await running;
    if (next !== undefined) await flush();
  };
  return {
    update(text: string) {
      if (closed) return;
      next = text;
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), delay);
    },
    flush,
    close() { closed = true; next = undefined; clearTimeout(timer); },
  };
}
