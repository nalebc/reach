import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

// A source checkout only: edits to the phone interface (src/, public/,
// index.html) reach open phones without restarting Reach. Agents used to
// restart Reach for every interface change, ending its terminals and live
// streams each time (Oct 6). Reach rebuilds the interface in place, keeping
// the old files so a page still loading finds them, and the new build's
// fingerprint makes idle pages reload (src/build-reload.ts). Server changes
// still need ./reach restart. An installed Reach has no source to watch.
const WATCHED = ["src", "public", "index.html"];

export function watchInterface({
  root,
  onBuilt,
  log = console,
  watch = fs.watch,
  build = buildInterface,
  delay = 1500,
}) {
  let timer,
    running = false,
    again = false,
    stopped = false;
  const run = async () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await build(root);
      if (!stopped) onBuilt();
    } catch (error) {
      // Half-saved edits fail too; the next save tries again.
      log.warn(
        `Reach: the phone interface didn't rebuild (${String(error?.message || error).split("\n")[0]}). Phones keep the last one that built.`,
      );
    } finally {
      running = false;
      if (again && !stopped) {
        again = false;
        schedule();
      }
    }
  };
  // Many saves in a row (an agent editing several files) build once.
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  };
  const watchers = [];
  for (const target of WATCHED)
    try {
      watchers.push(watch(path.join(root, target), { recursive: true }, schedule));
      watchers.at(-1).unref?.();
    } catch {
      /* not in this checkout */
    }
  return () => {
    stopped = true;
    clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}

// Vite alone (no typecheck, no compression): a few seconds. The full build
// still runs when ./reach starts.
export function buildInterface(root) {
  return new Promise((resolve, reject) =>
    execFile(
      process.execPath,
      [
        path.join(root, "node_modules/vite/bin/vite.js"),
        "build",
        "--emptyOutDir",
        "false",
        "--logLevel",
        "error",
      ],
      { cwd: root, timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) =>
        error ? reject(Error(stderr.trim() || error.message)) : resolve(),
    ),
  );
}
