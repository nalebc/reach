import fs from "node:fs";
import path from "node:path";

// The background service is restarted by macOS whenever it exits (KeepAlive).
// A start that can't succeed (Tailscale signed out, the folder moved, a build
// that fails) would then run again every 5 s, forever, keeping the CPU busy.
// Each start is counted here; after `quick` failed starts in a row the next
// waits first (5 s, doubling, at most 5 minutes). Up and well for `healthyMs`
// counts as a success and clears the count.
export async function serviceBackoff(
  state,
  {
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = (line) => console.log(line),
    quick = 3,
    firstMs = 5000,
    maxMs = 5 * 60 * 1000,
    healthyMs = 60 * 1000,
    setTimer = setTimeout,
  } = {},
) {
  const file = path.join(state, "service-starts.json");
  let failures = 0;
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Number.isInteger(saved.failures) && saved.failures >= 0) failures = saved.failures;
  } catch {
    /* first start, or unreadable: nothing counted */
  }
  const save = (count) => {
    try {
      fs.mkdirSync(state, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ failures: count, at: now() }));
    } catch {
      /* counting is a courtesy; never block a start on it */
    }
  };
  // Counted as failed until it proves otherwise.
  save(failures + 1);
  let waited = 0;
  if (failures >= quick) {
    waited = Math.min(maxMs, firstMs * 2 ** (failures - quick));
    log(`Reach: the last ${failures} starts failed. Waiting ${Math.round(waited / 1000)} s before trying again.`);
    await sleep(waited);
  }
  const timer = setTimer(() => save(0), healthyMs);
  timer?.unref?.();
  return { failures, waited };
}
