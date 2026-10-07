import {
  readPreferences,
  assertSocketSupport,
  preferencesFile,
} from "./configure.mjs";
import { serveSocketPath } from "../server/tailscale-auth.mjs";
import {
  describeApproval,
  decideApproval,
  safeLabel,
} from "./approve-device.mjs";
import { approvalStore } from "../server/device-approval.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import qr from "qrcode-terminal";
import { banner } from "./brand-mascot.mjs";
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
import { publicStartHandler } from "../server/public-start.mjs";
import { startOrigin } from "./public-link.mjs";
import { EphemeralFunnel } from "./ephemeral-funnel.mjs";

export async function launch(options, root) {
  // When Reach was first set up here (its settings file), for the one link.
  const setupSince = () => {
    try {
      const stat = fs.statSync(preferencesFile(root));
      return Math.round(stat.birthtimeMs || stat.mtimeMs);
    } catch {
      return 0;
    }
  };
  const privateDir = stateDir(root);
  const dataDir = process.env.REACH_DATA || path.join(privateDir, "quick");
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const httpsPort = options.httpsPort || 8443;
  const routeFile = path.join(privateDir, "serve-owner.json");
  const funnelFile = path.join(privateDir, "funnel-owner.json");
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
  // The one address (https://<computer>.ts.net): Reach for your devices, the
  // start page for the internet. Its page may call Reach here too.
  const publicStart = socketPath && privateOrigin ? startOrigin(privateOrigin) : "";
  const reach = await createReach({
    dataDir,
    port: options.port,
    publicOrigin: privateOrigin,
    ...(publicStart
      ? {
          allowedOrigins: [
            ...(process.env.REACH_ALLOWED_ORIGINS || "").split(",").filter(Boolean),
            publicStart,
          ],
        }
      : {}),
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
  let publicLink, publicMonitor, linkMonitor;
  let startUrl = "";
  const forgetStatus = () => {
    if (loadJson(statusFile, null)?.instance === reach.instance)
      fs.rmSync(statusFile, { force: true });
  };
  // The link for your phone, once the one address is up (./reach status).
  const noteLink = (link) => {
    const current = loadJson(statusFile, null);
    if (current?.instance === reach.instance && current.link !== link)
      atomicJson(statusFile, { ...current, link });
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
      clearInterval(publicMonitor);
      clearInterval(linkMonitor);
      await publicLink?.stop();
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
    // Both your devices and the internet (Funnel) come in on Reach's private
    // listener at the one address; it hands the internet's requests, and only
    // those, to the start page.
    if (socketPath) {
      const startPage = publicStart
        ? publicStartHandler({
            dist: path.join(root, "dist"),
            tailnetDir: path.join(root, "tailnet", "dist"),
            privateOrigin,
            home: publicStart,
            name: reach.config.name,
            instance: reach.instance,
            since: setupSince(),
            faceId: reach.faceIdAvailable,
          })
        : null;
      await reach.listenPrivate(socketPath, {
        // The start page, and its Face ID sign-in (its only requests that
        // reach Reach itself).
        publicApp: startPage
          ? (req, res) => reach.publicAgent(req, res) || reach.publicFaceId(req, res) || startPage(req, res)
          : undefined,
      });
      // Older Reach's separate start-page socket, if one was left behind.
      const old = path.join(path.dirname(socketPath), "p");
      try {
        const stat = fs.lstatSync(old);
        if (stat.isSocket() && stat.uid === process.getuid()) fs.rmSync(old);
      } catch {}
    }
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
      const setupOpened = new Set();
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
          if (setup && !setupOpened.has(setup[0])) {
            setupOpened.add(setup[0]);
            console.log(`Reach: finish Tailscale setup: ${setup[0]}`);
            // Usually "turn on HTTPS for your tailnet": one click in the browser.
            if (process.stdout.isTTY && process.platform === "darwin")
              spawn("open", [setup[0]], { stdio: "ignore" }).on("error", () => {});
          }
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
      if (publicStart && !stopped) {
        // Public access exists only while an invitation/admission/session is
        // alive. The worker owns a foreground route and a five-second lease.
        publicLink = new EphemeralFunnel({
          origin: publicStart,
          target: serveTarget,
          file: funnelFile,
          window: reach.funnelWindow,
          log,
          report: (message) => console.log(`Reach: ${message}`),
        });
        await publicLink.start();
        reach.setFunnelController(() => publicLink.ensure());
      }
    }
    if (stopped) return;
    // The mascot greets once, in a terminal someone is watching; fresh
    // pairing codes and the background service's log get the name alone.
    const heading = (plain = false) =>
      plain || options.service
        ? `  REACH · ${reach.config.name}`
        : banner(`REACH · ${reach.config.name}`);
    const showCode = (renew = false) => {
      const pairing = renew
        ? {
            code: crypto.randomInt(10000000, 100000000).toString(),
            expiresAt: Date.now() + 600000,
          }
        : reach.auth.pairing;
      atomicJson(path.join(reach.config.dataDir, "pairing.json"), pairing);
      console.log(
        `\n${heading(renew)}\n\n  ${options.local ? "Open on this computer" : "Open on your phone"}: ${origin}\n  Pairing code: ${pairing.code.slice(0, 4)} ${pairing.code.slice(4)}\n`,
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
      // Linked computers share one link: the one where Reach started first.
      const link = startUrl
        ? reach.fleet?.homeLink({ start: startUrl, since: setupSince() }) ||
          startUrl
        : origin;
      if (startUrl) noteLink(link);
      console.log(
        `\n${heading()}\n  Open on your phone: ${link}\n  Tailscale account: ${preferences.owner.login}\n`,
      );
      if (!options.service) qr.generate(link, { small: true });
      if (startUrl && link !== startUrl)
        console.log(`  This computer's own link works too: ${startUrl}`);
      console.log(
        startUrl
          ? "  The same link every time, with the Tailscale app on or off (without it, you sign in to Tailscale in the browser; nothing to install).\n  Approve new devices here, or run ./reach approve in another terminal."
          : "  The QR contains only your private address. Connect Tailscale on your phone, then tap Connect.\n  Approve new devices here, or run ./reach approve in another terminal.",
      );
      if (!options.service) {
        const seen = new Set();
        approvalMonitor = setInterval(() => {
          const linked = reach.fleet?.links().length > 0;
          for (const request of approvalStore(dataDir).list()) {
            if (seen.has(request.id)) continue;
            if (request.approvedBy) {
              seen.add(request.id);
              console.log(
                `\n${safeLabel(request.name)} joined: already approved on ${safeLabel(request.approvedBy)}.`,
              );
              continue;
            }
            if (request.status !== "pending") continue;
            // Give linked computers a moment to say they approved it already.
            if (linked && Date.now() - (request.expiresAt - 300000) < 4000)
              continue;
            seen.add(request.id);
            console.log(
              `\nNew device request:\n${describeApproval(request)}\nMatch the code on your phone; type it here to approve (or deny <code>).`,
            );
          }
        }, 1000);
        approvalMonitor.unref();
        if (reach.fleet) {
          // Other Reach computers on your account: offer to link them, once each.
          const offered = new Set();
          const offerLinks = async () => {
            try {
              for (const c of await reach.fleet.discover())
                if (!c.linked && !offered.has(c.nodeId)) {
                  offered.add(c.nodeId);
                  console.log(
                    `\nReach is also running on ${safeLabel(c.name)} (your Tailscale account).\nType "link ${c.short}" to link them: devices you approve on one work on both, and your phone sees both. Do the same in Reach on ${safeLabel(c.name)}.`,
                  );
                }
            } catch {}
          };
          void offerLinks();
          linkMonitor = setInterval(offerLinks, 60000);
          linkMonitor.unref();
          const linkedNames = reach.fleet.links().map((l) => safeLabel(l.name));
          if (linkedNames.length)
            console.log(`  Linked computers: ${linkedNames.join(", ")}`);
        }
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
    if (reach.paused)
      console.log(
        "  Paused: your phone can't see or use this computer until you resume.",
      );
    if (!options.local && !preferences)
      console.log(
        "  Private Tailscale link · Connect Tailscale on your phone first.\n  Reach pairing is also required. No public internet tunnel is enabled.",
      );
    if (!options.service) {
      console.log(
        preferences
          ? "  Type a device request code to approve, or pause. Ctrl+C stops Reach.\n"
          : "  Press Enter for a new pairing code. Type pause to pause. Ctrl+C stops sharing and Reach.\n",
      );
      input = readline.createInterface({
        input: process.stdin,
        terminal: false,
      });
      input.on("line", (line) => {
        if (stopped) return;
        // Pause gives this computer back to whoever is at it; resume lends
        // it to the phone again (also in the Mac's menu bar).
        if (/^(pause|resume)$/i.test(line.trim())) {
          const pause = line.trim().toLowerCase() === "pause";
          reach.setPaused(pause).then(
            () =>
              console.log(
                pause
                  ? "Reach paused. Your phone can't see or use this computer. Type resume to continue."
                  : "Reach resumed.",
              ),
            (e) => console.log(e.message),
          );
        } else if (!preferences) showCode(true);
        else if (/^(un)?link\b/i.test(line.trim()) && reach.fleet) {
          const [command, name = ""] = line.trim().split(/\s+/);
          if (command.toLowerCase() === "unlink")
            try {
              reach.fleet.unlink(name.toLowerCase());
              console.log(`Unlinked ${name}.`);
            } catch (e) {
              console.log(e.message);
            }
          else
            reach.fleet.link(name).then(
              (c) =>
                console.log(
                  `Linked ${safeLabel(c.name)}. Once it links back, devices approved on either computer work on both.`,
                ),
              (e) => console.log(e.message),
            );
        } else if (line.trim()) {
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
