import { spawn } from "node:child_process";
import { NativeScreenSource } from "./screen-stream.mjs";
import { assertUnchanged } from "./desktop-native.mjs";
import { nativeRules } from "./agent-guard.mjs";
import { fail } from "./core.mjs";

// A guest's live screen on a Windows PC (parity audit #12). On a Mac the
// guest's own stream leaves password managers, Reach's windows and the rest
// of the protected list out of the picture (scripts/native/screen-stream.swift).
// Windows can't leave a window out of a captured frame, so there the same
// windows are painted black in every frame a guest gets, by Windows' own
// video helper (scripts/native/screen-video.cs --private), which decides them
// with the agent desktop's own code and the rules a View agent gets
// (agent-desktop.cs, built into it). Video and still images alike: a guest
// never gets FFmpeg's video or screen-stream.ps1's pictures, which can't hide
// anything. Whether this PC can make a guest's picture is checked once
// (--probe-private), and until it's known to work guests don't watch or
// control, and are told why: detection, never a setting.

// The Mac helper's words when the filter can't be made, and Windows' too.
export const PRIVATE_VIEW_REFUSED = "Screen capture could not hide private windows.";
export const guestRefusal = (why) =>
  `Only this PC's owner can watch or control its screen right now: ${String(why || PRIVATE_VIEW_REFUSED).replace(/\s+$/, "")}`;
export const GUEST_CHECKING = "Reach is still checking that it can hide private windows from guests on this PC. Try again in a moment.";
const CHECKING = GUEST_CHECKING;
// A failed check is tried again a few minutes later (a desktop that was
// locked, a helper an antivirus held up).
const MISS_MS = 5 * 60 * 1000;

// What a guest's picture leaves out: what a View agent never sees on Windows
// (server/agent-guard.mjs's Windows lists), as privateWindows() is on a Mac.
export const guestRules = ({ hosts = [], titles = [] } = {}) =>
  nativeRules({ preset: "view" }, { hosts, titles, platform: "win32" });

// A helper run once with a line on stdin: its stdout, or an error with its
// stderr, exit code and whether it ran out of time.
function runWithInput(file, args, input, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = "",
      stderr = "",
      killed = false;
    const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
    }, timeout);
    child.stdout.on("data", (b) => (stdout = (stdout + b).slice(-65536)));
    child.stderr.on("data", (b) => (stderr = (stderr + b).slice(-65536)));
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout });
      else reject(Object.assign(Error(`exit ${code}`), { code, stderr, killed }));
    });
    child.stdin.end(input);
  });
}

// Why the check failed, in the helper's own words when it gave them.
function whyOf(error) {
  if (/^spawn/.test(error?.syscall || "") && ["EACCES", "EPERM", "UNKNOWN"].includes(error?.code))
    return "Windows refused to run Reach's screen helper: an application control policy (Smart App Control, App Control for Business or AppLocker) or an antivirus blocks it.";
  if (error?.killed) return "Reach's check that it can hide private windows didn't finish in time.";
  const line = String(error?.stderr || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("note: ") && !/^at \S+\(/.test(l))
    .at(-1);
  return (line || error?.message || PRIVATE_VIEW_REFUSED).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 300);
}

// One per Reach (server/index.mjs). helper: Reach's video helper built in the
// folder Reach made private this start (scripts/launch.mjs), as the agent
// desktop's is, resolving { file, sha256 }; off: why there is none.
export function createWindowsGuestScreen({
  helper = null,
  off = "",
  rules = () => guestRules(),
  verify = assertUnchanged,
  run = runWithInput,
  start = (file, args, input) => new NativeScreenSource(file, args, { input }),
  processId = process.pid,
  now = Date.now,
  log = (line) => console.warn(`Reach: live screen: ${line}`),
} = {}) {
  let state = null; // { ok, why, at }
  let pending = null;
  let said = "";
  const settle = (result) => {
    state = { ...result, at: now() };
    if (!result.ok && result.why !== said) {
      said = result.why;
      log(`guests can't watch this PC: ${result.why}`);
    }
    return state;
  };
  const line = () => `${JSON.stringify(rules())}\n`;
  const resolved = async () => {
    if (!helper) throw Error(off || "Reach couldn't prepare the screen helper that hides private windows on this PC.");
    const { file, sha256 } = await helper();
    return { file, sha256 };
  };
  const probe = () => {
    if (state && (state.ok || now() - state.at < MISS_MS)) return Promise.resolve(state);
    if (pending) return pending;
    pending = (async () => {
      try {
        const { file, sha256 } = await resolved();
        verify(file, sha256);
        const { stdout } = await run(file, ["--probe-private", String(processId)], line(), { timeout: 120000 });
        const found = JSON.parse(String(stdout).trim().split(/\r?\n/).at(-1));
        if (!Number.isInteger(found?.windows)) throw Error("The check gave no answer.");
        return { ok: true, windows: found.windows, ms: Number(found.ms) || 0 };
      } catch (error) {
        return { ok: false, why: whyOf(error) };
      }
    })()
      .then(settle)
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  return {
    probe,
    // "" when guests may watch and control this PC's screen; otherwise why
    // not (and a check starts if none is known).
    refusal() {
      if (state?.ok) return "";
      if (!state || now() - state.at >= MISS_MS) void probe();
      return state ? guestRefusal(state.why) : CHECKING;
    },
    // A guest's stream (options: RemoteScreenHub's, format "h264" or
    // "jpeg"): a factory, as the hub's other sources. The helper is checked
    // unchanged right before it starts.
    async source(options) {
      const { file, sha256 } = await resolved();
      const args = [
        options.display,
        String(Math.min(60, Math.max(1, options.fps))),
        String(Math.min(7680, Math.max(160, options.width))),
        String(Math.min(50000000, Math.max(250000, options.bitrate || 6000000))),
        "--private",
        String(processId),
        ...(options.format === "jpeg" ? ["--stills"] : []),
      ];
      return () => {
        verify(file, sha256);
        const source = start(file, args, line());
        // The helper can no longer hide them: the next guest is refused
        // with why, until the check passes again.
        source.onExit = (code, error) => {
          if (String(error?.message || "").startsWith(PRIVATE_VIEW_REFUSED)) settle({ ok: false, why: error.message });
        };
        return source;
      };
    },
  };
}

// Why a viewer who isn't the owner can't watch or control this computer's
// screen; "" when they can. A Mac always can (its helper leaves the windows
// out, or fails closed); Windows once its check passed.
export function privateViewRefusal(privateView, platform = process.platform, guestScreen = null) {
  if (!privateView || platform !== "win32") return "";
  return guestScreen ? guestScreen.refusal() : guestRefusal("Reach can't hide password managers and its own windows from others on this PC.");
}
// The same, thrown: 403, or 503 (try again) while the check runs.
export const refuseGuest = (privateView, platform, guestScreen) => {
  const why = privateViewRefusal(privateView, platform, guestScreen);
  if (why) throw fail(why === GUEST_CHECKING ? 503 : 403, why);
};
