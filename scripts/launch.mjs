import { readPreferences, assertSocketSupport } from "./configure.mjs";
import { serveSocketPath } from "../server/tailscale-auth.mjs";
import {
  pendingApprovals,
  describeApproval,
  decideApproval,
} from "./approve-device.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import qr from "qrcode-terminal";
import { PrivateLinkRecovery } from "./private-link-recovery.mjs";
import {
  ensurePersistentRoute,
  recordedRouteMatches,
} from "./persistent-serve.mjs";
import { keepAwake, stayAwakeMode } from "./stay-awake.mjs";
import { createReach } from "../server/index.mjs";
import { atomicJson, loadJson } from "../server/core.mjs";
import {
  prepareTailscale,
  tailscaleCli,
  tailscaleJson,
  ownsServeRoute,
  checkUnused,
} from "./tailscale.mjs";
import { stateDir } from "./home.mjs";

export async function launch(options, root) {
  const privateDir = stateDir(root);
  const dataDir = process.env.REACH_DATA || path.join(privateDir, "quick");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const httpsPort = options.httpsPort || 8443;
  const routeFile = path.join(privateDir, "serve-owner.json");
  const statusFile = path.join(privateDir, "host-status.json");
  const preferences =
    !options.local && process.platform !== "win32"
      ? readPreferences(root)
      : null;
  const socketPath = preferences ? serveSocketPath(root) : null;
  if (preferences) await assertSocketSupport();
  if (options.service && !options.port)
    throw Error("A service needs its saved local port.");
  const privateOrigin = options.local
    ? ""
    : await prepareTailscale(
        httpsPort,
        options.service
          ? (config, origin) =>
              recordedRouteMatches(
                routeFile,
                config,
                origin,
                socketPath
                  ? `unix:${socketPath}`
                  : `http://127.0.0.1:${options.port}`,
              )
          : undefined,
      );
  const reach = await createReach({
    dataDir,
    port: options.port,
    publicOrigin: privateOrigin,
    tailscaleOwner: preferences?.owner,
    privatePaths: [privateDir],
    // Policies live with Reach's state, never inside an installed package.
    ...(options.agentPolicyFile
      ? { agentPolicyFile: options.agentPolicyFile, agentPolicyRequired: true }
      : process.env.REACH_AGENT_POLICY
        ? {}
        : { agentPolicyFile: path.join(privateDir, "agent-policy.json") }),
    ...(options.folders.length ? { roots: options.folders } : {}),
  });
  let tunnel,
    input,
    stopped = false,
    stopPromise;
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  let log, monitor, approvalMonitor, recovery, power;
  const forgetStatus = () => {
    if (loadJson(statusFile, null)?.instance === reach.instance)
      fs.rmSync(statusFile, { force: true });
  };
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    // Whatever still holds on (a stuck helper, a socket nobody closed), Reach
    // is gone within seconds of being asked to stop.
    const deadline = setTimeout(() => {
      console.error("Reach: shutdown took too long; exiting now.");
      forgetStatus();
      process.exit(1);
    }, 5000);
    deadline.unref();
    stopPromise = (async () => {
      input?.close();
      clearInterval(monitor);
      clearInterval(approvalMonitor);
      recovery?.stop();
      power?.stop();
      if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) {
        const exited = new Promise((resolve) => tunnel.once("close", resolve));
        tunnel.kill();
        const timer = setTimeout(() => tunnel.kill("SIGKILL"), 3000);
        timer.unref();
        await exited;
        clearTimeout(timer);
      }
      await reach.close();
      forgetStatus();
      log?.end();
      finish();
    })();
    return stopPromise;
  };
  let interrupted = false;
  const onSignal = (signal) => {
    // A second Ctrl+C quits at once.
    if (interrupted) {
      forgetStatus();
      process.exit(signal === "SIGTERM" ? 143 : 130);
    }
    interrupted = true;
    void stop();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await new Promise((resolve, reject) => {
      reach.server.once("error", reject);
      reach.server.listen(reach.config.port, "127.0.0.1", resolve);
    });
    const localUrl = `http://127.0.0.1:${reach.server.address().port}`;
    if (socketPath) await reach.listenPrivate(socketPath);
    const serveTarget = socketPath ? `unix:${socketPath}` : localUrl;
    atomicJson(path.join(dataDir, "agent-host.json"), {
      roots: reach.config.roots,
      agentPolicyFile: reach.config.agentPolicyFile,
      publicOrigin: privateOrigin || localUrl,
    });
    atomicJson(statusFile, {
      pid: process.pid,
      instance: reach.instance,
      localUrl,
      origin: privateOrigin || localUrl,
      name: reach.config.name,
      dataDir: reach.config.dataDir,
      service: !!options.service,
      tailscaleApproval: !!preferences,
    });
    let origin = localUrl;
    if (privateOrigin) {
      origin = privateOrigin;
      console.log("Reach: connecting through your private Tailscale network…");
      log = fs.createWriteStream(path.join(dataDir, "tailscale.log"), {
        flags: "a",
        mode: 0o600,
      });
      if (!options.service) await checkUnused(httpsPort);
      const startTunnel = async () => {
        if (stopped) return;
        if (options.service) {
          await ensurePersistentRoute({
            file: routeFile,
            origin,
            target: serveTarget,
          });
          return;
        }
        if (tunnel && tunnel.exitCode === null && tunnel.signalCode === null) {
          const old = tunnel;
          const closed = new Promise((resolve) => old.once("close", resolve));
          old.kill();
          const timer = setTimeout(() => old.kill("SIGKILL"), 3000);
          timer.unref();
          await closed;
          clearTimeout(timer);
        }
        if (stopped) return;
        // Check again immediately before mutation, including after an awaited stop.
        await checkUnused(httpsPort);
        if (stopped) return;
        tunnel = spawn(
          tailscaleCli(),
          ["serve", `--https=${httpsPort}`, serveTarget],
          {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );
        const current = tunnel;
        const consume = (chunk) => {
          log.write(chunk);
          const setup = chunk
            .toString()
            .match(/https:\/\/(?:login|console)\.tailscale\.com\/[^\s]+/);
          if (setup) console.log(`Reach: finish Tailscale setup: ${setup[0]}`);
        };
        tunnel.stdout.on("data", consume);
        tunnel.stderr.on("data", consume);
        const interrupted = () => {
          if (stopped || current !== tunnel) return;
          recovery?.unavailable(
            "Tailscale connection interrupted. Reconnecting automatically.",
          );
        };
        tunnel.once("error", interrupted);
        tunnel.once("exit", interrupted);
      };
      recovery = new PrivateLinkRecovery({
        origin,
        target: serveTarget,
        owns: options.service
          ? (config, address, target) =>
              recordedRouteMatches(routeFile, config, address, target)
          : ownsServeRoute,
        inspect: () => tailscaleJson(["serve", "status", "--json"]),
        restart: startTunnel,
        available: (value) => reach.setTransportAvailable(value),
        report: (message) => console.log(`Reach: ${message}`),
      });
      reach.setTransportAvailable(false);
      await startTunnel();
      recovery.nextRestart = Date.now() + 15000;
      const deadline = Date.now() + 90000;
      let healthy = false;
      while (!stopped && Date.now() < deadline) {
        await recovery.check();
        try {
          const config = await tailscaleJson(["serve", "status", "--json"]);
          if (ownsServeRoute(config, origin, serveTarget)) {
            const response = await fetch(`${origin}/api/health`, {
              signal: AbortSignal.timeout(4000),
              redirect: "error",
            });
            const health = response.ok && (await response.json());
            healthy =
              health?.product === "Reach" && health.instance === reach.instance;
          }
        } catch {}
        if (healthy) break;
        await delay(1000);
      }
      if (stopped) return;
      if (!healthy)
        throw Error(
          "The private phone link could not connect. Check Tailscale and HTTPS setup, then rerun Reach. No public tunnel was opened.",
        );
      monitor = setInterval(() => void recovery.check(), 5000);
      monitor.unref();
    }
    if (stopped) return;
    const showCode = (renew = false) => {
      const pairing = renew
        ? {
            code: crypto.randomInt(10000000, 100000000).toString(),
            expiresAt: Date.now() + 600000,
          }
        : reach.auth.pairing;
      atomicJson(path.join(reach.config.dataDir, "pairing.json"), pairing);
      console.log(
        `\n  REACH · ${reach.config.name}\n\n  ${options.local ? "Open on this computer" : "Open on your phone"}: ${origin}\n  Pairing code: ${pairing.code.slice(0, 4)} ${pairing.code.slice(4)}\n`,
      );
      if (!options.local && process.stdout.isTTY) {
        const fragment = new URLSearchParams({
          pair: pairing.code,
          name: reach.config.name,
        });
        qr.generate(`${origin}/#${fragment}`, { small: true });
        console.log("  Scan with your phone camera, then tap Connect.");
      }
      console.log("  Code works once and expires in 10 minutes.");
    };
    if (preferences) {
      console.log(
        `\n  REACH · ${reach.config.name}\n  Open on your phone: ${origin}\n  Tailscale account: ${preferences.owner.login}\n`,
      );
      if (!options.service) qr.generate(origin, { small: true });
      console.log(
        "  The QR contains only your private address. Connect Tailscale on your phone, then tap Connect.\n  Approve new devices here, or run ./reach approve in another terminal.",
      );
      if (!options.service) {
        const seen = new Set();
        approvalMonitor = setInterval(() => {
          for (const request of pendingApprovals(dataDir))
            if (!seen.has(request.id)) {
              seen.add(request.id);
              console.log(
                `\nNew device request:\n${describeApproval(request)}\nMatch the code on your phone; type it here to approve (or deny <code>).`,
              );
            }
        }, 2000);
        approvalMonitor.unref();
      }
    } else if (options.service)
      console.log(
        `Reach is ready · ${origin}\nRun ./reach pair for a fresh pairing code and QR.`,
      );
    else showCode();
    if (fs.existsSync(reach.config.agentPolicyFile))
      console.log(`  Agent permissions: ${reach.config.agentPolicyFile}`);
    console.log(
      `  Shared: ${reach.config.roots.join(", ")}${options.service ? "" : "\n  Keep this terminal open."}`,
    );
    if (!options.local && !preferences)
      console.log(
        "  Private Tailscale link · Connect Tailscale on your phone first.\n  Reach pairing is also required. No public internet tunnel is enabled.",
      );
    if (!options.service) {
      console.log(
        preferences
          ? "  Type a device request code to approve. Ctrl+C stops Reach.\n"
          : "  Press Enter for a new pairing code. Ctrl+C stops sharing and Reach.\n",
      );
      input = readline.createInterface({
        input: process.stdin,
        terminal: false,
      });
      input.on("line", (line) => {
        if (stopped) return;
        if (!preferences) showCode(true);
        else if (line.trim()) {
          try {
            console.log(decideApproval(dataDir, line.trim()));
          } catch (e) {
            console.log(e.message);
          }
        }
      });
    }
    if (process.platform === "darwin") {
      const mode = stayAwakeMode(options.stayAwake);
      console.log(
        mode === "off"
          ? "Reach: sleep prevention is off. Screen sharing can stop when this Mac sleeps. Use --stay-awake-always to enable it."
          : `Reach: keeping system and display awake ${mode === "ac" ? "while plugged in" : "while Reach runs, including on battery"}. Manual locking, lid closure and managed lock policies still apply.`,
      );
      power = keepAwake({
        mode,
        changed: (awake) => {
          const current = loadJson(statusFile, null);
          if (current?.instance === reach.instance)
            atomicJson(statusFile, { ...current, awake });
        },
      });
    }
    await done;
  } finally {
    await stop();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}
