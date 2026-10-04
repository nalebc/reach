import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
export const onACPower = (output) =>
  /Now drawing from ['"]AC Power['"]/.test(output);

// `true` is the explicit plugged-in-only CLI option. Normal launches protect
// the whole Reach session; explicit CLI opt-outs remain respected.
export const stayAwakeMode = (value) =>
  value === false ? "off" : value === true ? "ac" : "always";
export const assertionArgs = (pid = process.pid) => [
  "-d",
  "-i",
  "-s",
  "-w",
  String(pid),
];
export function keepAwake({
  mode = "always",
  readPower = async () =>
    (await exec("/usr/bin/pmset", ["-g", "batt"], { timeout: 3000 })).stdout,
  acquire = () =>
    spawn("/usr/bin/caffeinate", assertionArgs(), { stdio: "ignore" }),
  report = console.log,
  changed = () => {},
  interval = setInterval,
  cancel = clearInterval,
} = {}) {
  if (!["off", "ac", "always"].includes(mode))
    throw Error("Invalid stay-awake mode.");
  let child,
    stopped = false,
    checking = false,
    error = "";
  const status = () => ({
    mode,
    active: !!child,
    pid: child?.pid || null,
    error,
  });
  let lastStatus = "";
  const notify = () => {
    const value = status(),
      serialized = JSON.stringify(value);
    if (serialized !== lastStatus) {
      lastStatus = serialized;
      try {
        changed(value);
      } catch {
        report(
          "Reach: could not save sleep-prevention status. Power assertions remain unchanged.",
        );
      }
    }
  };
  const release = () => {
    const current = child;
    child = undefined;
    current?.kill();
  };
  const check = async () => {
    if (stopped || checking || mode === "off") return;
    checking = true;
    try {
      const needed = mode === "always" || onACPower(await readPower());
      if (stopped) return;
      if (!needed) {
        release();
        error = "";
      } else if (!child) {
        child = acquire();
        error = "";
        const current = child;
        const failed = () => {
          if (stopped || child !== current) return;
          child = undefined;
          error =
            "Sleep prevention stopped. Reach will retry within 5 seconds.";
          report(`Reach: ${error}`);
          notify();
        };
        child.once("error", failed);
        child.once("exit", failed);
      }
    } catch {
      release();
      error =
        "Could not enable sleep prevention. Reach will retry within 5 seconds.";
      report(`Reach: ${error}`);
    } finally {
      checking = false;
      if (!stopped) notify();
    }
  };
  const timer = mode === "off" ? undefined : interval(() => void check(), 5000);
  timer?.unref?.();
  void check();
  return {
    check,
    status,
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== undefined) cancel(timer);
      release();
      notify();
    },
  };
}
export const stayAwakeOnAC = (options = {}) =>
  keepAwake({ ...options, mode: "ac" });
