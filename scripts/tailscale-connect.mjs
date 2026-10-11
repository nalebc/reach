import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { tailscaleCli, windowsTailscaleDir } from "./tailscale.mjs";

// Gets this computer onto Tailscale before Reach needs it: install, open,
// sign in, switch on. Every step is something the owner does in Tailscale's
// own app or web page; Reach only opens the right place and waits.
export const MAC_APP = "/Applications/Tailscale.app";
// Windows: the app with the taskbar icon, next to its command line.
export const windowsApp = (env = process.env) =>
  path.win32.join(windowsTailscaleDir(env), "tailscale-ipn.exe");
const DOWNLOAD = {
  darwin: "https://tailscale.com/download/mac",
  linux: "https://tailscale.com/download/linux",
  win32: "https://tailscale.com/download/windows",
};
// What opens a page in the default browser. Windows: explorer.exe, as
// `start` is a cmd.exe built-in (and cmd would split a link at its "&").
// explorer.exe exits 1 even when the page opened.
export const pageOpener = (platform, url) =>
  platform === "darwin"
    ? ["open", [url]]
    : platform === "win32"
      ? ["explorer.exe", [url]]
      : ["xdg-open", [url]];
const MACHINES = "https://login.tailscale.com/admin/machines";
const AUTH_URL = /https:\/\/(?:login|console)\.tailscale\.com\/[^\s"']+/;

export function tailscaleState({ status, error, appInstalled }) {
  if (error)
    return error.code === "ENOENT" && !appInstalled ? "missing" : "closed";
  switch (status?.BackendState) {
    case "Running":
      return "running";
    case "NeedsLogin":
      return "signed-out";
    case "NeedsMachineAuth":
      return "needs-approval";
    case "Stopped":
      return "off";
    case "Starting":
    case "NoState":
      return status?.AuthURL ? "signed-out" : "starting";
    default:
      return "closed";
  }
}

// Linux: Tailscale answers only root and its "operator" until told
// otherwise ("Access denied: checkprefs access denied", "use sudo").
const DENIED = /access denied|use 'sudo tailscale|must be root|operator/i;
const OPERATOR = "On Linux, let your user manage Tailscale once: sudo tailscale set --operator=$USER\nReach continues as soon as that's done.";
const WINDOWS_SERVICE =
  "If it still isn't running, start its service from a terminal opened as administrator: net start Tailscale\nReach continues as soon as it runs.";
// Signed out, even the operator is refused, and the operator setting isn't
// kept (Ubuntu 24.04, Tailscale 1.104): the first sign-in is root's, and the
// same command keeps your user as its operator from then on.
const SIGN_IN_AS_ROOT = "On Linux, Tailscale's first sign-in is root's. Sign in once, keeping your user as its manager:\n  sudo tailscale up --operator=$USER\nIt prints the sign-in link. Reach continues as soon as you've signed in.";
// Switching it on where its own button is.
const SWITCH_ON = {
  darwin: "Switch Tailscale on from its menu bar icon. Reach continues once it's on.",
  win32: "Switch Tailscale on from its icon in the taskbar's notification area. Reach continues once it's on.",
  linux: "Switch it on with: sudo tailscale up\nReach continues once it's on.",
};
const MESSAGES = {
  missing:
    "Tailscale isn't on this computer yet. Reach uses it (free) to keep the link to your phone private.",
  closed: "Tailscale is installed but not running.",
  "signed-out": "Tailscale needs you to sign in on this computer.",
  "needs-approval":
    "Your tailnet admin has to approve this computer before it can connect.",
  off: "Tailscale is switched off on this computer.",
  starting: "Tailscale is starting…",
  operator:
    "Tailscale is on, but it takes changes only from root, and Reach adds your phone's link to it.",
};
// Linux: whether Tailscale takes changes (Reach's Serve route) from this
// user, read from `tailscale debug prefs` without changing anything: the
// operator only (root never asks). OperatorUser is left out while unset;
// WantRunning is always there. Prefs it can't read: Tailscale's own refusal
// says it later.
export function managesTailscale(prefs, user) {
  if (!prefs || typeof prefs !== "object" || !("WantRunning" in prefs)) return true;
  return prefs.OperatorUser === user;
}
export const tailscaleProblem = (state) =>
  state === "operator"
    ? `${MESSAGES.operator} Let your user manage it once: sudo tailscale set --operator=$USER, then start Reach again.`
    : `${MESSAGES[state] || "Tailscale is unavailable."} Run Reach in a terminal to set it up.`;

function defaults() {
  const run = (file, args, timeout = 5000) =>
    new Promise((resolve, reject) =>
      execFile(
        file,
        args,
        { timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) =>
          error
            ? reject(Object.assign(error, { stdout, stderr }))
            : resolve({ stdout, stderr }),
      ),
    );
  const platform = process.platform;
  return {
    platform,
    appInstalled: () =>
      platform === "darwin"
        ? fs.existsSync(MAC_APP)
        : platform === "win32" && fs.existsSync(windowsApp()),
    status: async () =>
      JSON.parse((await run(tailscaleCli(), ["status", "--json"])).stdout),
    canManage: async () => {
      if (platform !== "linux" || process.getuid?.() === 0) return true;
      try {
        const prefs = JSON.parse((await run(tailscaleCli(), ["debug", "prefs"])).stdout);
        return managesTailscale(prefs, os.userInfo().username);
      } catch {
        return true;
      }
    },
    open: (target) => run(...pageOpener(platform, target)).catch(() => {}),
    // The Windows app keeps running after it opens: started on its own.
    openApp: async () => {
      if (platform !== "win32")
        return run("open", ["-a", MAC_APP]).catch(() => {});
      const child = spawn(windowsApp(), [], { detached: true, stdio: "ignore" });
      child.on("error", () => {});
      child.unref();
    },
    turnOn: () => run(tailscaleCli(), ["up"], 30000),
    // `tailscale login` prints its sign-in link, then waits for it to be used.
    login: (onUrl) => {
      const child = spawn(tailscaleCli(), ["login"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const scan = (chunk) => {
        const url = String(chunk).match(AUTH_URL)?.[0];
        if (url) onUrl(url);
        else if (DENIED.test(String(chunk))) onUrl(null, "denied");
      };
      child.stdout.on("data", scan);
      child.stderr.on("data", scan);
      child.on("error", () => {});
      return () => child.exitCode === null && child.kill();
    },
    sleep: (ms) => delay(ms),
    print: console.log,
  };
}

// Resolves with Tailscale's status once this computer is signed in and
// running. Without a terminal to ask in, it explains what's missing instead.
export async function ensureTailscale(deps = {}) {
  const d = { ...defaults(), ...deps };
  const interactive = d.interactive ?? !!process.stdin.isTTY;
  const read = async () => {
    try {
      const status = await d.status();
      const state = tailscaleState({ status });
      // Signed in with sudo (Tailscale's own Linux steps), not as this user.
      if (state === "running" && !(await d.canManage()))
        return { status, state: "operator" };
      return { status, state };
    } catch (error) {
      return {
        state: tailscaleState({ error, appInstalled: d.appInstalled() }),
      };
    }
  };
  let { status, state } = await read();
  if (state === "running") return status;
  if (!interactive) throw Error(tailscaleProblem(state));
  const select =
    d.select || (await import("./prompts.mjs")).terminalPrompts().select;
  const deadline = Date.now() + (d.waitMs ?? 15 * 60_000);
  const opened = new Set();
  const openOnce = (target) => {
    if (opened.has(target)) return;
    opened.add(target);
    void d.open(target);
  };
  let announced, stopLogin, triedApp, triedOn, upRefused;
  const sayOnce = (text) => {
    if (!opened.has(text)) d.print(text);
    opened.add(text);
  };
  const operator = () => sayOnce(OPERATOR);
  const onLogin = (url, problem) => {
    if (problem === "denied") return sayOnce(SIGN_IN_AS_ROOT);
    if (opened.has(url)) return;
    d.print(`If it doesn't open, visit: ${url}`);
    openOnce(url);
  };
  const turnOn = async () => {
    try {
      await d.turnOn();
      upRefused = false;
    } catch (error) {
      const refused = d.platform === "linux" && DENIED.test(`${error?.stderr || ""} ${error?.message || ""}`);
      // Refused until the operator command runs: tried again on the next look,
      // said once.
      if (refused && upRefused) return;
      upRefused = refused;
      if (refused) return operator();
      d.print(SWITCH_ON[d.platform] || SWITCH_ON.darwin);
      // Its switch is in its app: open it (Windows shows no icon until then).
      if ((d.platform === "darwin" || d.platform === "win32") && d.appInstalled())
        await d.openApp();
    }
  };
  try {
    while (state !== "running") {
      if (Date.now() > deadline)
        throw Error(
          `${MESSAGES[state] || "Tailscale is unavailable."} Rerun Reach once it's ready.`,
        );
      if (announced !== state) {
        announced = state;
        d.print(`\nReach: ${MESSAGES[state] || "Waiting for Tailscale…"}`);
        if (state === "missing") {
          const choice = await select({
            message: "Install Tailscale to continue",
            choices: [
              {
                value: "open",
                label: "Open the Tailscale download page",
                description: "Install it, sign in, then come back here.",
                recommended: true,
              },
              { value: "cancel", label: "Not now", description: "Exit Reach." },
            ],
          });
          if (choice !== "open")
            throw Error(
              "Reach needs Tailscale. Rerun Reach once it's installed.",
            );
          const page = DOWNLOAD[d.platform] || "https://tailscale.com/download";
          openOnce(page);
          // Said too: a computer without a desktop (a server) opens nothing.
          d.print(`Reach: get it at ${page}`);
          d.print(
            "Reach: waiting for Tailscale to be installed… (Ctrl+C to stop)",
          );
        } else if (state === "closed") {
          const app =
            (d.platform === "darwin" || d.platform === "win32") &&
            d.appInstalled();
          if (app && !triedApp) {
            triedApp = true;
            d.print("Reach: opening Tailscale…");
            await d.openApp();
            // Windows: the app doesn't start a stopped Tailscale service.
            if (d.platform === "win32") d.print(WINDOWS_SERVICE);
          } else
            d.print(
              d.platform === "linux"
                ? "Start it with: sudo systemctl enable --now tailscaled"
                : d.platform === "win32"
                  ? `Open Tailscale from the Start menu. ${WINDOWS_SERVICE}`
                  : d.platform === "darwin" && !d.appInstalled()
                    ? "Start it with: sudo brew services start tailscale (Homebrew), or open the Tailscale app. Reach continues as soon as it runs."
                    : "Open Tailscale on this computer. Reach continues as soon as it runs.",
            );
        } else if (state === "signed-out") {
          d.print("Reach: opening the Tailscale sign-in page in your browser…");
          stopLogin ||= d.login(onLogin);
        } else if (state === "operator") {
          operator();
        } else if (state === "needs-approval") {
          openOnce(MACHINES);
          d.print(
            `Approve it at ${MACHINES}. Reach continues once it's approved.`,
          );
        } else if (state === "off" && !triedOn) {
          triedOn = true;
          const choice = await select({
            message: "Turn Tailscale on?",
            choices: [
              { value: "on", label: "Turn it on", recommended: true },
              { value: "cancel", label: "Not now", description: "Exit Reach." },
            ],
          });
          if (choice !== "on")
            throw Error(
              "Reach needs Tailscale switched on. Rerun Reach when it is.",
            );
          await turnOn();
        }
      } else if (state === "off" && upRefused) await turnOn();
      await d.sleep(1500);
      ({ status, state } = await read());
    }
  } finally {
    stopLogin?.();
  }
  d.print("Reach: Tailscale is connected.");
  return status;
}
