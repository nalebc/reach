// Fixed recovery recipes for an update that already reported its blocker.
// A recipe is displayed for approval; error output is never executed as a command.
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const BREW = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"];
const fail = (status, message) => Object.assign(new Error(message), { status });
export async function updateRecovery(
  details,
  { platform = process.platform, access = fs.access } = {},
) {
  details = details.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  const required = details
    .match(/requires Node ([^\n"\\]+)/i)?.[1]
    ?.trim()
    .replace(/\.$/, "");
  if (required) {
    // Automate only the known LTS range. A different requirement must not
    // silently install a runtime that still cannot run the requested release.
    const minimum = required.match(/^>=24\.(\d+)\.(\d+)\s+<25(?:\s*\|\|.*)?$/);
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
  const { brew, minimum, ...publicFields } = recovery;
  return publicFields;
}

export async function installUpdateRuntime(
  recovery,
  { run = promisify(execFile), env = process.env, authorize = () => {} } = {},
) {
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
  const runtime = path.join(
    path.dirname(path.dirname(recovery.brew)),
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

export async function availableUpdateRuntime({
  platform = process.platform,
  access = fs.access,
} = {}) {
  if (platform !== "darwin") return null;
  for (const brew of BREW) {
    const runtime = path.join(
      path.dirname(path.dirname(brew)),
      "opt/node@24/bin/node",
    );
    try {
      await access(runtime);
      return runtime;
    } catch {}
  }
  return null;
}
