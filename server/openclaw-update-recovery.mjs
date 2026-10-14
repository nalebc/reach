// Fixed recovery recipes for an update that already reported its blocker.
// A recipe is displayed for approval; error output is never executed as a command.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findOpenClaw } from "./openclaw-windows.mjs";
import { nodeRange, nodeVersion, privateNode, privateNodeDir, privateNodePrefix, supportedNode } from "./openclaw-node.mjs";
import { powershellFile } from "./powershell.mjs";
import { loginShell } from "./openclaw-run.mjs";

const BREW = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
const fail = (status, message) => Object.assign(new Error(message), { status });
const exec = promisify(execFile);
// OpenClaw's own Node, on a Mac and a Windows PC alike: installed for
// OpenClaw only by the installer in OpenClaw's own package, in its Node-only
// mode (scripts/install-cli.sh --node-only, scripts/install.ps1 -NodeOnly:
// Node from nodejs.org, its SHA-256 checked), where OpenClaw's launcher
// looks first (node-runtime-update.mjs). The computer's own Node is kept.
// Only for a range Reach can read (openclaw-node.mjs) that the Node it
// brings is in: install-cli.sh's pinned Node, install.ps1's newest 26.
export async function bundledInstaller({ find = findOpenClaw, isFile = fileAt } = {}) {
  const script = await find().catch(() => null);
  if (!script || !/[\\/]openclaw\.mjs$/i.test(script)) return null;
  const installer = path.join(path.dirname(script), "scripts", "install.ps1");
  return (await isFile(installer)) ? installer : null;
}
// On a Mac, OpenClaw as the login shell finds it (npm's bin is a link to
// <package>/openclaw.mjs), and the Node its install-cli.sh pins.
export async function posixInstaller({ env = process.env, platform = process.platform, run = exec, realpath = fs.realpath, readFile = fs.readFile } = {}) {
  try {
    const { stdout } = await run(loginShell(env, platform), ["-lc", "command -v openclaw"], { timeout: 15000 });
    const found = String(stdout).trim().split(/\r?\n/).pop();
    if (!path.posix.isAbsolute(found || "")) return null;
    const script = await realpath(found);
    if (!/\/openclaw\.mjs$/.test(script)) return null;
    const file = path.join(path.dirname(script), "scripts", "install-cli.sh");
    const pinned = /^DEFAULT_NODE_VERSION="(\d+\.\d+\.\d+)"$/m.exec(String(await readFile(file, "utf8")))?.[1];
    return pinned ? { file, pinned } : null;
  } catch {
    return null;
  }
}
const fileAt = async (file) => {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
};
const OWN_NODE = {
  title: "Upgrade Node to continue",
  description: "OpenClaw needs a newer Node runtime. Reach can install one for OpenClaw only, with OpenClaw's own installer. Your current Node installation is kept.",
  steps: [
    "Install Node for OpenClaw only",
    "Retry the OpenClaw update",
    "Migrate existing settings, credentials and plugins if required",
    "Repair the Gateway service and verify its connection",
  ],
};
export async function updateRecovery(
  details,
  { platform = process.platform, access = fs.access, installer = bundledInstaller, macInstaller = posixInstaller } = {},
) {
  details = details.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const required = details
    .match(/requires Node ([^\n"\\]+)/i)?.[1]
    ?.trim()
    .replace(/\.$/, "");
  const accepts = required ? nodeRange(required) : null;
  // A Mac's OpenClaw brings install-cli.sh: its pinned Node, when the range
  // takes it. Without it, Homebrew's node@24, as before.
  if (required && platform !== "win32") {
    const own = accepts ? await macInstaller({ platform }) : null;
    if (own && accepts(own.pinned))
      return { kind: "node", required, detected: details.match(/detected Node ([\d.]+)/i)?.[1], available: true, installer: own.file, ...OWN_NODE };
  }
  if (required && platform === "win32") {
    // install.ps1 brings the newest 26: only a range with a 26 in it.
    const file = accepts?.("26.999.0") ? await installer() : null;
    return {
      kind: "node",
      title: "Upgrade Node to continue",
      required,
      detected: details.match(/detected Node ([\d.]+)/i)?.[1],
      available: !!file,
      ...(file ? { installer: file } : {}),
      steps: OWN_NODE.steps,
      description: file
        ? OWN_NODE.description
        : `OpenClaw requires Node ${required}. Automatic installation is not available on this computer. Install a compatible Node runtime, then retry here.`,
    };
  }
  if (required) {
    // Automate only the known LTS range. A different requirement must not
    // silently install a runtime that still cannot run the requested release.
    // Its engines say "<25 || >=26.1.0"; its launcher (2026.10.3) says
    // "<25, or >=26.1.0": either (nodeRange, openclaw-node.mjs).
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
  { run = promisify(execFile), env = process.env, authorize = () => {}, platform = process.platform, installer = bundledInstaller, macInstaller = posixInstaller } = {},
) {
  if (platform === "win32") return installWindowsRuntime(recovery, { run, env, authorize, installer });
  if (recovery?.installer) return installPosixRuntime(recovery, { run, env, authorize, platform, macInstaller });
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
// in OpenClaw's package; then that Node must be in the range it named.
const ACCEPTED = "OpenClaw's installer did not provide a Node version OpenClaw accepts. Retry in Reach.";
async function installPosixRuntime(recovery, { run, env, authorize, platform, macInstaller }) {
  const own = recovery.available && recovery.kind === "node" ? await macInstaller({ env, platform }) : null;
  const accepts = nodeRange(recovery.required);
  if (!own || own.file !== recovery.installer || !accepts?.(own.pinned))
    throw fail(409, "This dependency upgrade is not available. Check the update details.");
  authorize();
  // Its own pin, never one from this computer's environment.
  const { OPENCLAW_NODE_VERSION: _pin, ...clean } = env;
  await run("/bin/bash", [own.file, "--node-only", "--prefix", privateNodePrefix({ env })], {
    env: clean,
    timeout: 20 * 60 * 1000,
    maxBuffer: 2 * 1024 * 1024,
  });
  authorize();
  const runtime = privateNode({ platform, env });
  const { stdout } = await run(runtime, ["-p", "process.versions.node"], { env, timeout: 10000 });
  authorize();
  if (!accepts(String(stdout).trim())) throw fail(409, ACCEPTED);
  return runtime;
}
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
  if (!nodeRange(recovery.required)?.(String(stdout).trim())) throw fail(409, ACCEPTED);
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
