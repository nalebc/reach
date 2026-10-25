// Wait for something the code under test does asynchronously, rather than
// sleeping a fixed time and asserting it happened: on a slow CI machine a
// fixed sleep is sometimes too short (Oct 19: a 50 ms settle on Intel macOS
// asserted before Claude Code was resumed). Returns the first truthy value;
// fails with what it waited for if that never comes.
export async function eventually(check, { timeoutMs = 5000, intervalMs = 10, label = "the expected state" } = {}) {
  const end = performance.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    if (performance.now() >= end)
      throw Error(`Never saw ${label} within ${timeoutMs / 1000} s${last instanceof Error ? `: ${last.message}` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
