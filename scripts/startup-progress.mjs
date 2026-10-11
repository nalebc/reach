import { seconds } from "./first-start.mjs";

// Builds write their detailed output to setup.log. Keep the terminal alive
// even during a quiet typecheck or compression, and always clear the timer.
export async function withStartupProgress(
  work,
  {
    print = console.log,
    log,
    now = Date.now,
    every = setInterval,
    clear = clearInterval,
  } = {},
) {
  let current, timer;
  const finish = (failed = false) => {
    clear(timer);
    if (current)
      print(
        `Reach: ${current.label} — ${failed ? "failed after" : "done in"} ${seconds(now() - current.at)}.`,
      );
    current = null;
  };
  const step = (label) => {
    finish();
    current = { label, at: now() };
    print(`Reach: ${label}…`);
    timer = every(() => {
      print(
        `Reach: still ${label} — ${seconds(now() - current.at)} elapsed.${log ? ` Details: ${log}` : ""}`,
      );
    }, 5000);
    timer.unref?.();
  };
  try {
    const result = await work({ say: print, step });
    finish();
    return result;
  } catch (error) {
    finish(true);
    throw error;
  }
}
