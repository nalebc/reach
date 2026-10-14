// Fixed recovery recipes for an update that already reported its blocker.
// A recipe is displayed for approval; error output is never executed as a command.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findOpenClaw, nodeVersion, privateNodeDir, supportedNode } from "./openclaw-windows.mjs";
import { powershellFile } from "./powershell.mjs";

const BREW = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
const fail = (status, message) => Object.assign(new Error(message), { status });
// On Windows the Mac's Homebrew node@24 is OpenClaw's own Node: installed
// for OpenClaw only by the installer in its own package (scripts/install.ps1
// -NodeOnly, which fetches Node from nodejs.org and checks its SHA-256),
// where OpenClaw's launcher looks first. The PC's Node is kept. Its range
// reads "<25 || >=26.1.0" in OpenClaw's engines and "<25, or >=26.1.0" in
// its launcher's refusal: either is the known range, and the Node its
// installer brings (the newest 26) must be in it.
const WINDOWS_RANGE = /^>=24\.\d+\.\d+\s+<25(?:\s*\|\||,\s*or)\s*>=26\.(\d+)\.(\d+)$/;
export async function bundledInstaller({ find = findOpenClaw, isFile = fileAt } = {}) {
  const script = await find().catch(() => null);
  if (!script || !/[\\/]openclaw\.mjs$/i.test(script)) return null;
  const installer = path.join(path.dirname(script), "scripts", "install.ps1");
  return (await isFile(installer)) ? installer : null;
}
const fileAt = async (file) => {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
};
export async function updateRecovery(
  details,
  { platform = process.platform, access = fs.access, installer = bundledInstaller } = {},
) {
  details = details.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const required = details
    .match(/requires Node ([^\n"\\]+)/i)?.[1]
    ?.trim()
    .replace(/\.$/, "");
  if (required && platform === "win32") {
    const file = WINDOWS_RANGE.test(required) ? await installer() : null;
    return {
      kind: "node",
      title: "Upgrade Node to continue",
      required,
      detected: details.match(/detected Node ([\d.]+)/i)?.[1],
      available: !!file,
      ...(file ? { installer: file } : {}),
      description: file
        ? "OpenClaw needs a newer Node runtime. Reach can install one for OpenClaw only, with OpenClaw's own installer. Your current Node installation is kept."
        : `OpenClaw requires Node ${required}. Automatic installation is not available on this computer. Install a compatible Node runtime, then retry here.`,
      steps: [
        "Install Node for OpenClaw only",
        "Retry the OpenClaw update",
        "Migrate existing settings, credentials and plugins if required",
        "Repair the Gateway service and verify its connection",
      ],
    };
  }
  if (required) {
    // Automate only the known LTS range. A different requirement must not
    // silently install a runtime that still cannot run the requested release.
    // Its engines say "<25 || >=26.1.0"; its launcher (2026.10.3) says
    // "<25, or >=26.1.0": either, as on Windows (WINDOWS_RANGE).
    const minimum = required.match(/^>=24\.(\d+)\.(\d+)\s+<25(?:(?:\s*\|\||,\s*or).*)?$/);
    let brew;
    if (platform === "darwin" && minimum)
      for (const candidate of BREW) {
        try {
          await access(candidate);
          brew = candidate;
          break;
        } catch {}
      }
    return {
      kind: "node",
      title: "Upgrade Node to continue",
      required,
      detected: details.match(/detected Node ([\d.]+)/i)?.[1],
      available: !!brew,
      ...(brew
        ? { brew, minimum: [24, Number(minimum[1]), Number(minimum[2])] }
        : {}),
      description: brew
        ? "OpenClaw needs a newer Node runtime. Reach can install Node 24 with Homebrew and use it for OpenClaw. Your current Node installation is kept."
        : `OpenClaw requires Node ${required}. Automatic installation is not available on this computer. Install a compatible Node runtime, then retry here.`,
      steps: [
        "Install Node 24 and its Homebrew dependencies",
        "Retry the OpenClaw update",
        "Migrate existing settings, credentials and plugins if required",
        "Repair the Gateway service and verify its connection",
      ],
    };
  }
  if (
    /openclaw (?:update repair|doctor --fix)|AUTH_PROFILE_MIGRATION_REQUIRED|reason["':\s]+openclaw doctor/i.test(
      details,
    )
  )
    return {
      kind: "repair",
      title: "Finish the OpenClaw upgrade",
      available: true,
      description:
        "The package was installed, but OpenClaw still needs to migrate its existing data and repair its service. Conversations may be interrupted while the Gateway restarts.",
      steps: [
        "Migrate existing settings, credentials and plugins",
        "Repair the Gateway service",
        "Restart and verify the Gateway connection",
      ],
    };
  return null;
}

export function publicRecovery(recovery) {
  if (!recovery) return undefined;
  const { brew, minimum, installer, ...publicFields } = recovery;
  return publicFields;
}

export async function installUpdateRuntime(
  recovery,
  { run = promisify(execFile), env = process.env, authorize = () => {}, platform = process.platform, installer = bundledInstaller } = {},
) {
  if (platform === "win32") return installWindowsRuntime(recovery, { run, env, authorize, installer });
  if (
    !recovery?.available ||
    recovery.kind !== "node" ||
    !BREW.includes(recovery.brew)
  )
    throw fail(
      409,
      "This dependency upgrade is not available. Check the update details.",
    );
  authorize();
  // Keep existing runtimes for live processes. Never use sudo or accept new
  // plugin capabilities as part of a dependency upgrade.
  await run(recovery.brew, ["install", "node@24"], {
    env: {
      ...env,
      HOMEBREW_NO_INSTALL_CLEANUP: "1",
      HOMEBREW_NO_AUTO_UPDATE: "1",
      NONINTERACTIVE: "1",
    },
    timeout: 20 * 60 * 1000,
    maxBuffer: 2 * 1024 * 1024,
  });
  authorize();
  // Homebrew's paths are a Mac's, whatever computer reads this.
  const runtime = path.posix.join(
    path.posix.dirname(path.posix.dirname(recovery.brew)),
    "opt/node@24/bin/node",
  );
  const { stdout } = await run(runtime, ["-p", "process.versions.node"], {
    env,
    timeout: 10000,
  });
  authorize();
  const version = String(stdout).trim().split(".").map(Number);
  const minimum = recovery.minimum;
  if (
    version.length !== 3 ||
    version.some((n) => !Number.isInteger(n)) ||
    version[0] !== 24 ||
    !minimum ||
    version[1] < minimum[1] ||
    (version[1] === minimum[1] && version[2] < minimum[2])
  )
    throw fail(
      409,
      "Homebrew did not provide the required Node version. Update Homebrew’s formulae, then retry in Reach.",
    );
  return runtime;
}

// OpenClaw's installer with its own fixed arguments, as OpenClaw's
// "Update NodeJS" runs it, only when the recipe's installer is still the one
// in OpenClaw's package; then that Node must be one OpenClaw accepts.
async function installWindowsRuntime(recovery, { run, env, authorize, installer }) {
  const file = recovery?.available && recovery.kind === "node" ? await installer() : null;
  if (!file || file !== recovery.installer)
    throw fail(409, "This dependency upgrade is not available. Check the update details.");
  authorize();
  const prefix = privateNodeDir({ env });
  // With the bypass every Reach script gets (powershell.mjs): Windows'
  // default policy refuses a bare -File.
  await run("powershell.exe", ["-NonInteractive", ...powershellFile(file, ["-NodeOnly", "-NodePrefix", prefix])], {
    env,
    timeout: 20 * 60 * 1000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  authorize();
  const runtime = path.join(prefix, "node.exe");
  const { stdout } = await run(runtime, ["-p", "process.versions.node"], { env, timeout: 10000, windowsHide: true });
  authorize();
  const [, minor, patch] = String(recovery.required).match(WINDOWS_RANGE) || [];
  const version = String(stdout).trim().split(".").map(Number);
  if (!supportedNode(String(stdout).trim()) || minor === undefined || version[0] !== 26 ||
    version[1] < Number(minor) || (version[1] === Number(minor) && version[2] < Number(patch)))
    throw fail(409, "OpenClaw's installer did not provide a Node version OpenClaw accepts. Retry in Reach.");
  return runtime;
}

export async function availableUpdateRuntime({
  platform = process.platform,
  access = fs.access,
  env = process.env,
  version = nodeVersion,
} = {}) {
  // OpenClaw's own Node, while it's one OpenClaw accepts.
  if (platform === "win32") {
    const runtime = path.join(privateNodeDir({ env }), "node.exe");
    return supportedNode(await version(runtime)) ? runtime : null;
  }
  if (platform !== "darwin") return null;
  for (const brew of BREW) {
    const runtime = path.posix.join(
      path.posix.dirname(path.posix.dirname(brew)),
      "opt/node@24/bin/node",
    );
    try {
      await access(runtime);
      return runtime;
    } catch {}
  }
  return null;
}
