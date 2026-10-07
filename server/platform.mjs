import fs from "node:fs/promises";
import { buildNative } from "./native-build.mjs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fail } from "./core.mjs";
import { tailscaleCli } from "../scripts/tailscale.mjs";
export const exec = promisify(execFile);
const options = {
  timeout: 12000,
  maxBuffer: 4 * 1024 * 1024,
  windowsHide: true,
};
let appCache = [],
  appCacheAt = 0,
  appScan;
export async function apps() {
  if (appCacheAt && Date.now() - appCacheAt < 30000) return appCache;
  if (!appScan)
    appScan = scanApps()
      .then((result) => {
        appCacheAt = Date.now();
        return result;
      })
      .finally(() => {
        appScan = null;
      });
  return appScan;
}
async function scanApps() {
  if (process.platform === "darwin") {
    const directories = [
      "/Applications",
      "/System/Applications",
      "/System/Applications/Utilities",
      path.join(os.homedir(), "Applications"),
    ];
    const found = [];
    for (const dir of directories) {
      try {
        for (const name of await fs.readdir(dir))
          if (name.endsWith(".app"))
            found.push({ id: path.join(dir, name), name: name.slice(0, -4) });
      } catch {}
    }
    appCache = found.sort((a, b) => a.name.localeCompare(b.name));
  } else if (process.platform === "win32") {
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress",
      ],
      options,
    );
    const data = JSON.parse(stdout || "[]");
    appCache = (Array.isArray(data) ? data : [data]).map((a) => ({
      id: a.AppID,
      name: a.Name,
    }));
  } else {
    appCache = [];
  }
  return appCache;
}
export async function launchApp(appId) {
  if (!appCache.length) await apps();
  const app = appCache.find((a) => a.id === appId);
  if (!app)
    throw fail(404, "Choose an application from this computer’s app list.");
  if (process.platform === "darwin")
    await exec("/usr/bin/open", ["-a", app.id], options);
  else if (process.platform === "win32")
    await exec("explorer.exe", [`shell:AppsFolder\\${app.id}`], options);
  else throw fail(501, "App launching is supported on Mac and Windows.");
  return { name: app.name };
}
export async function tailscaleInfo() {
  try {
    const { stdout } = await exec(
      // The app's own command line, the one matching its daemon.
      tailscaleCli(),
      ["status", "--json"],
      { ...options, timeout: 3000 },
    );
    const t = JSON.parse(stdout);
    return {
      connected: t.BackendState === "Running",
      hostname: t.Self?.DNSName?.replace(/\.$/, ""),
      ips: t.TailscaleIPs || [],
      peers: Object.values(t.Peer || {}).map((p) => ({
        name: p.HostName,
        hostname: p.DNSName?.replace(/\.$/, ""),
        os: p.OS,
        online: !!p.Online,
      })),
    };
  } catch {
    return { connected: false, peers: [] };
  }
}
export async function screenCapture(config) {
  if (!config.screen)
    throw fail(403, "Screen access is off. Turn it on in Reach on your phone.");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "reach-screen-"));
  const file = path.join(temp, "screen.jpg");
  try {
    if (process.platform === "darwin")
      await exec(
        "/usr/sbin/screencapture",
        ["-x", "-m", "-t", "jpg", file],
        options,
      );
    else if (process.platform === "win32") {
      const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g=[System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save($env:REACH_CAPTURE,[System.Drawing.Imaging.ImageFormat]::Jpeg); $g.Dispose(); $i.Dispose()`;
      await exec("powershell.exe", ["-NoProfile", "-Command", script], {
        ...options,
        env: { ...process.env, REACH_CAPTURE: file },
      });
    } else throw fail(501, "Screen access is supported on Mac and Windows.");
    return await fs.readFile(file);
  } catch (error) {
    if (error.status) throw error;
    throw fail(
      403,
      process.platform === "darwin"
        ? "On your Mac, open System Settings → Privacy & Security → Screen & System Audio Recording (Screen Recording on older macOS). Allow the app running Reach, such as Terminal, then quit and reopen that app and restart Reach."
        : "Windows could not capture the desktop. Keep the computer signed in and unlocked, and run Reach in your desktop session.",
    );
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export async function screenInput(config, payload, authorize = () => {}) {
  if (!config.screen)
    throw fail(403, "Screen access is off. Turn it on in Reach on your phone.");
  if (
    !payload ||
    typeof payload !== "object" ||
    !["click", "scroll", "text", "key"].includes(payload.type)
  )
    throw fail(400, "Unsupported input type.");
  if (
    payload.type === "click" &&
    (!Number.isFinite(payload.x) ||
      !Number.isFinite(payload.y) ||
      payload.x < 0 ||
      payload.x > 1 ||
      payload.y < 0 ||
      payload.y > 1)
  )
    throw fail(400, "Click coordinates must be between 0 and 1.");
  if (
    payload.type === "click" &&
    ((payload.button !== undefined &&
      !["left", "right"].includes(payload.button)) ||
      (payload.count !== undefined && ![1, 2].includes(payload.count)))
  )
    throw fail(400, "Choose a single or double left click, or a right click.");
  if (
    payload.type === "scroll" &&
    (!Number.isInteger(payload.delta) ||
      payload.delta === 0 ||
      Math.abs(payload.delta) > 10)
  )
    throw fail(400, "Scroll must be between -10 and 10 steps, excluding zero.");
  if (
    payload.type === "text" &&
    (typeof payload.text !== "string" || payload.text.length > 2000)
  )
    throw fail(400, "Text can be up to 2,000 characters.");
  if (
    payload.type === "key" &&
    ![
      "enter",
      "backspace",
      "tab",
      "escape",
      "left",
      "right",
      "up",
      "down",
    ].includes(payload.key)
  )
    throw fail(400, "Unsupported key.");
  const { fileURLToPath } = await import("node:url");
  const { spawn } = await import("node:child_process");
  const native = fileURLToPath(new URL("../scripts/native/", import.meta.url));
  let executable, args;
  if (process.platform === "darwin" && process.env.REACH_INPUT_HELPER) {
    executable = process.env.REACH_INPUT_HELPER;
    args = [];
  } else if (process.platform === "darwin") {
    executable = path.join(config.dataDir, "reach-input-v2");
    args = [];
    try {
      await fs.access(executable);
    } catch {
      try {
        // Built whole or not at all (a build stopped halfway was reused forever).
        await buildNative(executable, ["swiftc", path.join(native, "input.swift")], { timeout: 90000, prune: false });
      } catch {
        throw fail(
          503,
          "The screen input helper needs Apple Command Line Tools. Run xcode-select --install on your Mac.",
        );
      }
    }
  } else if (process.platform === "win32") {
    executable = "powershell.exe";
    args = ["-NoProfile", "-File", path.join(native, "input.ps1")];
  } else throw fail(501, "Screen input is supported on Mac and Windows.");
  authorize();
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let error = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(fail(504, "Screen input timed out."));
    }, 10000);
    child.stderr.on("data", (b) => (error += b.toString()));
    child.on("error", () => {
      clearTimeout(timer);
      reject(fail(503, "Could not start the screen input helper."));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(
            fail(
              403,
              error ||
                "Allow the Reach input helper or the app running Reach in System Settings → Privacy & Security → Accessibility, then try again.",
            ),
          );
    });
    child.stdin.end(JSON.stringify(payload));
  });
  return { ok: true };
}

// os.freemem() on macOS excludes reclaimable cache, so the Mac looks almost full.
export async function availableMemory() {
  if (process.platform !== "darwin") return os.freemem();
  try {
    const { stdout } = await exec("/usr/bin/vm_stat", [], options);
    const pageSize = Number(/page size of (\d+)/.exec(stdout)?.[1] || 16384);
    const pages = (label) =>
      Number(new RegExp(`${label}:\\s+(\\d+)`).exec(stdout)?.[1] || 0);
    return (
      (pages("Pages free") +
        pages("Pages inactive") +
        pages("Pages speculative") +
        pages("Pages purgeable")) *
      pageSize
    );
  } catch {
    return os.freemem();
  }
}
