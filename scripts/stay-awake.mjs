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
  platform = process.platform,
  readPower = async () =>
    (await exec("/usr/bin/pmset", ["-g", "batt"], { timeout: 3000 })).stdout,
  acquire = () =>
    spawn("/usr/bin/caffeinate", assertionArgs(), { stdio: "ignore" }),
  report = console.log,
  changed = () => {},
  interval = setInterval,
  cancel = clearInterval,
  // Windows: its helper (built on first use) and how it starts.
  helper,
  start,
} = {}) {
  if (platform === "win32") return keepAwakeWindows({ mode, helper, start, report, changed });
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

// Windows: one helper (scripts/native/stay-awake.cs) holds the PC awake for
// as long as it runs, checking the power source itself in "ac" mode, and
// says what it holds each time that changes. It lets go when Reach ends (its
// input closes), as caffeinate -w does on a Mac. The same three modes, the
// same status and the same retries; a helper this PC can't build is tried
// again ten minutes later (a compiler turned on meanwhile is picked up).
export function keepAwakeWindows({
  mode = "always",
  helper = async () => {
    throw Error("No stay-awake helper.");
  },
  start = (file, args) => spawn(file, args, { stdio: ["pipe", "pipe", "ignore"], windowsHide: true }),
  report = console.log,
  changed = () => {},
  retryMs = 5000,
  buildRetryMs = 10 * 60 * 1000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (!["off", "ac", "always"].includes(mode))
    throw Error("Invalid stay-awake mode.");
  let child,
    stopped = false,
    active = false,
    error = "",
    timer;
  const status = () => ({
    mode,
    active: !!child && active,
    pid: child && active ? child.pid : null,
    error,
  });
  let lastStatus = "";
  const notify = () => {
    const value = status(),
      serialized = JSON.stringify(value);
    if (serialized === lastStatus) return;
    lastStatus = serialized;
    try {
      changed(value);
    } catch {
      report("Reach: could not save sleep-prevention status. Power assertions remain unchanged.");
    }
  };
  const later = (ms) => {
    clearTimer(timer);
    timer = setTimer(() => void check(), ms);
    timer?.unref?.();
  };
  const check = async () => {
    if (stopped || mode === "off" || child) return;
    let file;
    try {
      file = await helper();
    } catch {
      if (stopped) return;
      error = "Could not enable sleep prevention. Reach will retry in 10 minutes.";
      report(`Reach: ${error}`);
      notify();
      return later(buildRetryMs);
    }
    if (stopped) return;
    let current;
    try {
      current = start(file, [mode]);
    } catch {
      error = "Could not enable sleep prevention. Reach will retry within 5 seconds.";
      report(`Reach: ${error}`);
      notify();
      return later(retryMs);
    }
    child = current;
    active = false;
    error = "";
    let buffer = "";
    current.stdout?.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let said = null;
        try {
          said = JSON.parse(line);
        } catch {}
        if (child !== current || typeof said?.active !== "boolean") continue;
        active = said.active;
        notify();
      }
      // A line that never ends isn't one.
      if (buffer.length > 4096) buffer = "";
    });
    current.stdin?.on("error", () => {});
    const failed = () => {
      if (stopped || child !== current) return;
      child = undefined;
      active = false;
      error = "Sleep prevention stopped. Reach will retry within 5 seconds.";
      report(`Reach: ${error}`);
      notify();
      later(retryMs);
    };
    current.once("error", failed);
    current.once("exit", failed);
    notify();
  };
  void check();
  return {
    check,
    status,
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimer(timer);
      const current = child;
      child = undefined;
      active = false;
      // Its input closes and it lets go; ended too, whatever it's doing.
      try {
        current?.stdin?.end();
      } catch {}
      current?.kill();
      notify();
    },
  };
}
