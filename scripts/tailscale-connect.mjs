import fs from "node:fs";
import { execFile, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { tailscaleCli } from "./tailscale.mjs";

// Gets this computer onto Tailscale before Reach needs it: install, open,
// sign in, switch on. Every step is something the owner does in Tailscale's
// own app or web page; Reach only opens the right place and waits.
export const MAC_APP = "/Applications/Tailscale.app";
const DOWNLOAD = {
  darwin: "https://tailscale.com/download/mac",
  linux: "https://tailscale.com/download/linux",
};
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

const MESSAGES = {
  missing:
    "Tailscale isn't on this computer yet. Reach uses it (free) to keep the link to your phone private.",
  closed: "Tailscale is installed but not running.",
  "signed-out": "Tailscale needs you to sign in on this computer.",
  "needs-approval":
    "Your tailnet admin has to approve this computer before it can connect.",
  off: "Tailscale is switched off on this computer.",
  starting: "Tailscale is starting…",
};
export const tailscaleProblem = (state) =>
  `${MESSAGES[state] || "Tailscale is unavailable."} Run Reach in a terminal to set it up.`;

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
    appInstalled: () => platform === "darwin" && fs.existsSync(MAC_APP),
    status: async () =>
      JSON.parse((await run(tailscaleCli(), ["status", "--json"])).stdout),
    open: (target) =>
      run(platform === "darwin" ? "open" : "xdg-open", [target]).catch(
        () => {},
      ),
    openApp: () => run("open", ["-a", MAC_APP]).catch(() => {}),
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
      return { status, state: tailscaleState({ status }) };
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
  let announced, stopLogin, triedApp, triedOn;
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
          openOnce(DOWNLOAD[d.platform] || "https://tailscale.com/download");
          d.print(
            "Reach: waiting for Tailscale to be installed… (Ctrl+C to stop)",
          );
        } else if (state === "closed") {
          if (d.platform === "darwin" && d.appInstalled() && !triedApp) {
            triedApp = true;
            d.print("Reach: opening Tailscale…");
            await d.openApp();
          } else
            d.print(
              d.platform === "linux"
                ? "Start it with: sudo systemctl enable --now tailscaled"
                : "Open Tailscale on this computer. Reach continues as soon as it runs.",
            );
        } else if (state === "signed-out") {
          d.print("Reach: opening the Tailscale sign-in page in your browser…");
          stopLogin ||= d.login((url) => {
            if (opened.has(url)) return;
            d.print(`If it doesn't open, visit: ${url}`);
            openOnce(url);
          });
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
          try {
            await d.turnOn();
          } catch {
            d.print(
              "Switch Tailscale on from its menu bar icon. Reach continues once it's on.",
            );
            if (d.platform === "darwin" && d.appInstalled()) await d.openApp();
          }
        }
      }
      await d.sleep(1500);
      ({ status, state } = await read());
    }
  } finally {
    stopLogin?.();
  }
  d.print("Reach: Tailscale is connected.");
  return status;
}
