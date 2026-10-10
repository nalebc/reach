import { readPreferences } from "./configure.mjs";
import { serveSocketPath } from "../server/tailscale-auth.mjs";
import fs from "node:fs";
import { stayAwakeMode } from "./stay-awake.mjs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFileSync } from "node:child_process";
import { atomicJson, loadJson } from "../server/core.mjs";
import { prepareTailscale } from "./tailscale.mjs";
import {
  removePersistentRoute,
  recordedRouteMatches,
} from "./persistent-serve.mjs";
import { stateDir } from "./home.mjs";
import { removePersistentFunnel } from "./public-link.mjs";

export const serviceLabel = "com.reach.companion";
const xml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const envKeys = [
  "REACH_HOME",
  "REACH_DATA",
  "REACH_ROOTS",
  "REACH_NAME",
  "REACH_SCREEN",
  "REACH_AGENT_POLICY",
  "REACH_TAILSCALE",
  "REACH_CODEX",
  "REACH_ALLOWED_ORIGINS",
];
export function privateNodePath(root, arch = process.arch) {
  if (!["arm64", "x64"].includes(arch))
    throw Error("Unsupported Mac architecture.");
  // ./reach caches the runtime in <folder>/.reach/runtime whatever REACH_HOME
  // says; the state folder's own copy is used when there is one.
  const candidates = [stateDir(root), path.join(root, ".reach")].map((dir) =>
    path.join(dir, "runtime", `node-v22.23.3-darwin-${arch}`, "bin/node"),
  );
  const expected = candidates.find((c) => fs.existsSync(c)) || candidates[0];
  if (!fs.existsSync(expected) || fs.realpathSync.native(expected) !== expected)
    throw Error(
      "Reach's private Node runtime is missing. Run ./reach install to prepare it; system Node is not used for the service.",
    );
  fs.accessSync(expected, fs.constants.X_OK);
  return expected;
}
export function backgroundPlist(options, root, executable, env, logDir) {
  const args = [
    executable,
    path.join(root, "scripts/bootstrap.mjs"),
    "--service",
  ];
  if (options.local) args.push("--local");
  if (options.port) args.push("--port", String(options.port));
  args.push("--https-port", String(options.httpsPort));
  if (options.stayAwake === true) args.push("--stay-awake");
  else if (options.stayAwake === false) args.push("--no-stay-awake");
  else args.push("--stay-awake-always");
  for (const folder of options.folders) args.push("--folder", folder);
  if (options.agentPolicyFile)
    args.push("--agent-policy", options.agentPolicyFile);
  // Preserve the installing user's PATH exactly; prepend the private runtime
  // only inside the daemon, so child tools also use Reach's Node/npm.
  const savedPath =
    env.REACH_INSTALL_PATH ?? env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin";
  const variables = {
    PATH: savedPath,
    ...Object.fromEntries(
      envKeys
        .filter((key) => env[key] !== undefined)
        .map((key) => [key, env[key]]),
    ),
  };
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${serviceLabel}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>/</string>
<key>EnvironmentVariables</key><dict>${Object.entries(variables)
    .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
    .join("")}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>5</integer>
<key>ExitTimeOut</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(path.join(logDir, "companion.log"))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logDir, "companion-error.log"))}</string>
</dict></plist>`;
}
export const availablePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((e) => (e ? reject(e) : resolve(port)));
    });
  });
export function parseLaunchStatus(output) {
  const state = output.match(/^\s*state = (.+)$/m)?.[1]?.trim() || "stopped";
  const pid = Number(output.match(/^\s*pid = (\d+)$/m)?.[1]) || null;
  return { running: state === "running" && !!pid, pid, state };
}
async function waitForStop(pid) {
  if (!pid) return;
  const deadline = Date.now() + 12000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") return;
      throw e;
    }
    if (Date.now() >= deadline)
      throw Error(
        "Reach is still stopping. Retry ./reach uninstall before removing its Serve route.",
      );
    await new Promise((r) => setTimeout(r, 200));
  }
}
export async function backgroundService(options, root, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== "darwin")
    throw Error("Reach install/uninstall/status currently support macOS.");
  const home = deps.home || os.homedir(),
    uid = deps.uid ?? process.getuid();
  const run =
    deps.run ||
    ((args) =>
      execFileSync("/bin/launchctl", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }));
  const domain = `gui/${uid}`,
    service = `${domain}/${serviceLabel}`;
  const file = path.join(home, "Library/LaunchAgents", `${serviceLabel}.plist`);
  const state = stateDir(root);
  const stateFile = path.join(state, "service.json");
  const routeFile = path.join(state, "serve-owner.json");
  const saved = loadJson(stateFile, null);
  const logDir = path.join(state, "logs");
  const command =
    options.command || (options.stopBackground ? "uninstall" : "install");
  let loaded = false,
    status = { running: false, pid: null, state: "stopped" };
  try {
    status = parseLaunchStatus(run(["print", service]));
    loaded = true;
  } catch {}
  const installedPlist = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8")
    : "";
  const ours =
    (!installedPlist && !loaded) ||
    // This checkout's job: by its program path (older plists also named the
    // folder as the working directory).
    (installedPlist.includes(xml(path.join(root, "scripts/bootstrap.mjs"))) ||
      installedPlist.includes(`<key>WorkingDirectory</key><string>${xml(root)}</string>`));
  if (command === "status") {
    const runtime = loadJson(path.join(state, "host-status.json"), {});
    const result = {
      ...status,
      installed: fs.existsSync(file),
      managedHere: ours,
      // The one address once it's up; the private one until then.
      link: runtime.link || saved?.origin || runtime.origin || "Not configured",
      logs: saved?.logDir || logDir,
      stayAwake:
        (runtime.awake?.mode || stayAwakeMode(saved?.options?.stayAwake)) !==
        "off",
      awake: runtime.awake || {
        mode: stayAwakeMode(saved?.options?.stayAwake),
        active: false,
      },
    };
    (deps.print || console.log)(
      `Reach: ${ours ? (status.running ? "running" : "stopped") : "managed by another checkout"}${status.pid ? ` (PID ${status.pid})` : ""}\nTailscale link: ${result.link}\nLogs: ${result.logs}\nSleep prevention: ${result.awake.mode} · ${result.awake.active ? "active" : "not active"}${result.awake.error ? ` · ${result.awake.error}` : ""}`,
    );
    return result;
  }
  if (!ours)
    throw Error(
      "This LaunchAgent belongs to another checkout or its ownership cannot be verified. Manage it from its original Reach folder.",
    );
  if (command === "uninstall") {
    if (loaded) run(["bootout", service]);
    await (deps.waitForStop || waitForStop)(status.pid);
    fs.rmSync(file, { force: true });
    if (saved) atomicJson(stateFile, { ...saved, installed: false });
    // Do not reset Tailscale or touch other routes. Preserve the ownership file
    // on a failure so uninstall can be retried when Tailscale is available.
    const message = await (deps.removeRoute || removePersistentRoute)({
      file: routeFile,
    });
    const funnelMessage = await (deps.removeFunnel || removePersistentFunnel)({
      file: path.join(state, "funnel-owner.json"),
    });
    (deps.print || console.log)(
      `Reach stopped and uninstalled. ${message}${funnelMessage ? ` ${funnelMessage}` : ""}\nSaved pairings and logs remain in .reach. Running Reach terminals/jobs have ended.`,
    );
    return;
  }
  if (loaded || installedPlist)
    throw Error(
      "Reach already has a LaunchAgent. Run ./reach uninstall before changing its setup (ends its running work).",
    );
  const node = (deps.privateNode || privateNodePath)(root);
  const env = deps.env || process.env;
  const resolved = {
    ...options,
    port: options.port || (await (deps.allocatePort || availablePort)()),
    stayAwake: options.stayAwake ?? "always",
  };
  const preferences = !resolved.local ? readPreferences(root) : null;
  const localTarget = `http://127.0.0.1:${resolved.port}`;
  const target = preferences ? `unix:${serveSocketPath(root)}` : localTarget;
  const origin = resolved.local
    ? localTarget
    : await (deps.prepareOrigin || prepareTailscale)(
        resolved.httpsPort,
        (config, address) =>
          recordedRouteMatches(routeFile, config, address, target),
      );
  const dataDir = path.resolve(env.REACH_DATA || path.join(state, "quick"));
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(logDir, 0o700);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const name of ["companion.log", "companion-error.log"]) {
    const fd = fs.openSync(path.join(logDir, name), "a", 0o600);
    fs.closeSync(fd);
    fs.chmodSync(path.join(logDir, name), 0o600);
  }
  const previous = fs.existsSync(stateFile) ? fs.readFileSync(stateFile) : null;
  atomicJson(stateFile, {
    version: 1,
    root,
    node,
    dataDir,
    origin,
    logDir,
    options: resolved,
    installed: true,
  });
  try {
    fs.writeFileSync(
      file,
      backgroundPlist(
        resolved,
        root,
        node,
        { ...env, REACH_DATA: dataDir },
        logDir,
      ),
      { mode: 0o600 },
    );
    fs.chmodSync(file, 0o600);
    run(["bootstrap", domain, file]);
  } catch (e) {
    fs.rmSync(file, { force: true });
    if (previous) fs.writeFileSync(stateFile, previous, { mode: 0o600 });
    else fs.rmSync(stateFile, { force: true });
    throw e;
  }
  (deps.print || console.log)(
    `Reach installed. Starts at sign-in and restarts after exit.\nPrivate link: ${origin}\nLogs: ${logDir}\nRun ./reach status, ${preferences ? "then open the link on your phone and run ./reach approve." : "then ./reach pair to connect your phone."}\nSleep prevention: ${stayAwakeMode(resolved.stayAwake)} (system and display). macOS locking and FileVault still apply.\nNote: the service runs without a Terminal window, so it has no Screen Recording or Accessibility (no live screen, no control) and can't approve new phones. Use ./reach restart for that.`,
  );
  return { origin, node, dataDir, logDir, options: resolved };
}
