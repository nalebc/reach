import {
  readPreferences,
  assertSocketSupport,
  assertOwnerAccount,
  preferencesFile,
  accountApproval,
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
  recordedRouteOwned,
} from "./persistent-serve.mjs";
import { keepAwake, stayAwakeMode } from "./stay-awake.mjs";
import { createReach } from "../server/index.mjs";
import { installCrashGuard } from "../server/crash-guard.mjs";
import { atomicJson, loadJson, openPairingWindow, pairingWindowFile } from "../server/core.mjs";
import { publicNameState } from "../server/public-dns.mjs";
import { phoneAppFirst, phoneLinkText, UNPUBLISHED } from "./phone-link.mjs";
import {
  prepareTailscale,
  tailscaleCli,
  tailscaleJson,
  ownsServeRoute,
  tailscaleVersions,
} from "./tailscale.mjs";
import { command, packaged, stateDir } from "./home.mjs";
import { watchStopRequest } from "./instances.mjs";
import { pageOpener } from "./tailscale-connect.mjs";
import { publicStartHandler } from "../server/public-start.mjs";
import { setStartInfo } from "../server/delivery.mjs";
import { startOrigin } from "./public-link.mjs";
import { EphemeralFunnel } from "./ephemeral-funnel.mjs";
import { ForegroundServe } from "./foreground-serve.mjs";

export async function launch(options, root) {
  // Started for you (a restart from the phone, at sign-in): read once, and
  // not handed on to the terminals and agents Reach starts.
  const openedForYou = !!process.env.REACH_OPENED_BY;
  delete process.env.REACH_OPENED_BY;
  const attended = !options.service && !!process.stdout.isTTY && !openedForYou;
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
  // An error nothing caught: said, kept, and Reach exits so ./reach (or the
  // background service) starts it again (server/crash-guard.mjs).
  // Set by ./reach for this run only, not handed on to terminals and agents.
  const supervised = !!options.service || process.env.REACH_SUPERVISED === "1";
  delete process.env.REACH_SUPERVISED;
  installCrashGuard({ dataDir, supervised });
  const httpsPort = options.httpsPort || 8443;
  const routeFile = path.join(privateDir, "serve-owner.json");
  const funnelFile = path.join(privateDir, "funnel-owner.json");
  const statusFile = path.join(privateDir, "host-status.json");
  const preferences =
    !options.local && accountApproval() ? readPreferences(root) : null;
  const socketPath = preferences ? serveSocketPath(root) : null;
  if (preferences) {
    assertOwnerAccount(await tailscaleJson(["status", "--json"]), preferences);
    await assertSocketSupport();
  }
  if (options.service && !options.port)
    throw Error("A service needs its saved local port.");
  const privateOrigin = options.local
    ? ""
    : await prepareTailscale(
        httpsPort,
        // Reach's own route from an earlier run is reused, or replaced when
        // its target changed; anybody else's on the port refuses to start.
        (config, origin) => recordedRouteOwned(routeFile, config, origin),
      );
  // The one address (https://<computer>.ts.net): Reach for your devices, the
  // start page for the internet. Its page may call Reach here too.
  // Never on Windows (no socket there), so no Funnel route is made there.
  const publicStart = socketPath && privateOrigin ? startOrigin(privateOrigin) : "";
  const reach = await createReach({
    dataDir,
    port: options.port,
    // Setup's step 3 (scripts/setup.mjs phoneStep): said once the first phone
    // is in, so a first run visibly ends with it.
    ...(options.phoneStep && {
      onFirstDevice: () =>
        console.log(`\n  ✔ 3. Your phone  —  connected. Setup is done; change anything later with ${command} setup.\n`),
    }),
    // A source checkout: interface edits reach phones without a restart.
    liveInterface: !packaged,
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
    // Logs kept beside Reach's data, trimmed while it runs (server/tidy.mjs).
    tidy: { logFiles: [path.join(privateDir, "setup.log")], logDirs: [path.join(privateDir, "logs")] },
    // Policies live with Reach's state, never inside an installed package.
    ...(options.agentPolicyFile
      ? { agentPolicyFile: options.agentPolicyFile, agentPolicyRequired: true }
      : process.env.REACH_AGENT_POLICY
        ? {}
        : { agentPolicyFile: path.join(privateDir, "agent-policy.json") }),
    ...(options.folders.length ? { roots: options.folders } : {}),
  });
  let input,
    stopped = false,
    stopPromise;
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  let log, monitor, approvalMonitor, recovery, power, stopWatch;
  let publicLink, publicMonitor, linkMonitor, foreground;
  let startUrl = "";
  let phoneLinkShown = false;
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
      stopWatch?.();
      input?.close();
      clearInterval(monitor);
      clearInterval(approvalMonitor);
      clearInterval(publicMonitor);
      clearInterval(linkMonitor);
      await publicLink?.stop();
      recovery?.stop();
      // Windows' route ends before Reach's listener does.
      await foreground?.stop();
      power?.stop();
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
  // Its Terminal window closed: stopped as asked, not an unexpected end.
  process.on("SIGHUP", onSignal);
  try {
    await new Promise((resolve, reject) => {
      reach.server.once("error", reject);
      reach.server.listen(reach.config.port, "127.0.0.1", resolve);
    });
    const localUrl = `http://127.0.0.1:${reach.server.address().port}`;
    // Both your devices and the internet (Funnel) come in on Reach's private
    // listener at the one address; it hands the internet's requests, and only
    // those, to the start page.
    // Your other computers find this one by asking it who it is, over the
    // tailnet (server/fleet.mjs); the public start page answers only Funnel.
    if (privateOrigin)
      setStartInfo(() => ({ product: "Reach", origin: privateOrigin, name: reach.config.name, instance: reach.instance, since: setupSince() }));
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
      // When it started (Windows' status says it; there's no ps to ask).
      startedAt: Date.now(),
      instance: reach.instance,
      localUrl,
      origin: privateOrigin || localUrl,
      name: reach.config.name,
      dataDir: reach.config.dataDir,
      service: !!options.service,
      tailscaleApproval: !!preferences,
    });
    // Windows: `stop` asks through a file, as there are no signals to ask with.
    if (process.platform === "win32")
      stopWatch = watchStopRequest(privateDir, { stop: () => void stop() });
    let origin = localUrl;
    if (privateOrigin) {
      origin = privateOrigin;
      console.log("Reach: connecting through your private Tailscale network…");
      // Every line in tailscale.log carries its time: route changes are rare
      // and worth dating when something was flaky.
      const rawLog = fs.createWriteStream(path.join(dataDir, "tailscale.log"), {
        flags: "a",
        mode: 0o600,
      });
      // A full disk or a removed folder ends this log, never Reach (it used
      // to have no error listener: one failed write stopped Reach).
      let logBroken = false;
      rawLog.on("error", (error) => {
        if (!logBroken) console.warn(`Reach: tailscale.log can't be written (${error.code || error.message}); its lines are skipped.`);
        logBroken = true;
      });
      log = {
        write: (chunk) => {
          if (logBroken) return;
          const stamp = new Date().toISOString();
          const lines = String(chunk).split("\n").filter((line) => line.trim());
          if (lines.length) rawLog.write(lines.map((line) => `${stamp} ${line}`).join("\n") + "\n");
        },
        end: () => rawLog.end(),
      };
      // The routes as the phone's status shows them (./reach status).
      const routes = { private: { up: false, since: 0, interruptions: 0 }, public: { open: false, since: 0 } };
      const noteRoutes = () => {
        const current = loadJson(statusFile, null);
        if (current?.instance === reach.instance) atomicJson(statusFile, { ...current, routes });
      };
      const privateUp = (value) => {
        reach.setTransportAvailable(value);
        if (routes.private.up === value) return;
        if (value) routes.private.since = Date.now();
        else routes.private.interruptions++;
        routes.private.up = value;
        noteRoutes();
      };
      try {
        const versions = await tailscaleVersions();
        if (versions.mismatch) {
          const warning = `Tailscale's command line (${versions.client}) and its daemon (${versions.daemon}) are different versions. Update Tailscale so they match; mismatched versions drop connections.`;
          console.log(`Reach: ${warning}`);
          log.write(`Reach: ${warning}`);
        }
      } catch {}
      // Tailscale sometimes answers with a page to visit (usually: turn on
      // HTTPS for the tailnet). Say so once, and open it from a Terminal.
      const setupOpened = new Set();
      const setupHint = (message) => {
        const setup = String(message).match(/https:\/\/(?:login|console)\.tailscale\.com\/[^\s"']+/);
        if (!setup || setupOpened.has(setup[0])) return;
        setupOpened.add(setup[0]);
        console.log(`Reach: finish Tailscale setup: ${setup[0]}`);
        if (process.stdout.isTTY && ["darwin", "win32"].includes(process.platform)) {
          const [file, args] = pageOpener(process.platform, setup[0]);
          spawn(file, args, { stdio: "ignore", windowsHide: true }).on("error", () => {});
        }
      };
      // The private route is Tailscale daemon state (a background Serve), in
      // every mode: it survives dropped sessions, sleeps and Reach restarts,
      // and an unchanged route is reused without a blink.
      // Except on Windows, where it leads to a local port any user there could
      // take once Reach is gone: held only while Reach runs (foreground-serve.mjs).
      if (process.platform === "win32")
        foreground = new ForegroundServe({
          file: routeFile,
          origin,
          target: serveTarget,
          output: (text) => {
            log.write(text);
            setupHint(text);
          },
          exited: (why) => {
            log.write(`Reach: tailscale serve ended (${why}); reconnecting.`);
            void recovery?.check();
          },
        });
      const startTunnel = async () => {
        if (stopped) return;
        try {
          if (foreground) {
            if (await foreground.start()) log.write(`Reach: private route held while Reach runs: ${origin} -> ${serveTarget}`);
            return;
          }
          const created = await ensurePersistentRoute({ file: routeFile, origin, target: serveTarget });
          if (created) log.write(`Reach: private route set: ${origin} -> ${serveTarget}`);
        } catch (error) {
          setupHint(error.message);
          throw error;
        }
      };
      recovery = new PrivateLinkRecovery({
        origin,
        target: serveTarget,
        owns: foreground
          ? (config, address, target) => foreground.owns(config, address, target)
          : (config, address, target) => recordedRouteMatches(routeFile, config, address, target),
        inspect: () => tailscaleJson(["serve", "status", "--json"]),
        restart: startTunnel,
        available: privateUp,
        report: (message) => { console.log(`Reach: ${message}`); log.write(`Reach: ${message}`); setupHint(message); },
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
        // Public access: a background Funnel route held on while Reach runs,
        // answered only while an invitation/admission/session is alive; a
        // janitor process holds a five-second lease on it.
        publicLink = new EphemeralFunnel({
          origin: publicStart,
          target: serveTarget,
          file: funnelFile,
          window: reach.funnelWindow,
          log,
          // Funnel not allowed for this computer yet: Tailscale's answer
          // carries the page that allows it, printed and opened like setup's.
          report: (message) => { console.log(`Reach: ${message}`); log.write(`Reach: ${message}`); setupHint(message); },
          changed: (open) => {
            if (open) routes.public.since = Date.now();
            routes.public.open = open;
            noteRoutes();
            if (!phoneLinkShown || stopped) return;
            if (!open) {
              startUrl = "";
              noteLink(privateOrigin);
            } else if (!startUrl) {
              // A new tailnet can enable Funnel only after Reach has shown
              // its private link. Update `status`/`pair` and the waiting
              // phone now, without asking for a restart. Reuse the original
              // window: approval or expiry must not be undone by recovery.
              startUrl = publicStart;
              const pairing = loadJson(pairingWindowFile(dataDir), null);
              const remaining = Number.isFinite(pairing?.until) ? pairing.until - Date.now() : 0;
              const link = reach.fleet?.homeLink({ start: publicStart, since: setupSince() }) || publicStart;
              noteLink(link);
              console.log(`\nReach: browser sign-in is now available.\n  Open on your phone: ${link}\n`);
              if (!options.service) qr.generate(link, { small: true });
              console.log(phoneLinkText({ oneAddress: true, attended: remaining > 0, minutes: remaining > 0 ? Math.ceil(remaining / 60000) : 15, ownLink: link !== publicStart ? publicStart : "" }));
              void publicNameState(new URL(publicStart).hostname).then(state => {
                if (state === "missing" && !stopped) console.log(UNPUBLISHED);
              });
            }
          },
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
    // Pairing codes over the private address: the phone needs the Tailscale
    // app, signed in to this computer's account (named when Tailscale says).
    const phoneNeedsApp = !options.local && !preferences;
    let phoneAccount = "";
    if (phoneNeedsApp)
      try {
        const status = await tailscaleJson(["status", "--json"]);
        phoneAccount = status?.User?.[status?.Self?.UserID]?.LoginName || "";
      } catch {}
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
      if (phoneNeedsApp) console.log(`${phoneAppFirst({ account: phoneAccount })}\n`);
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
      // The one address once Reach holds it (port 443): with the Tailscale
      // app it's Reach itself; without the app, the start page, while a
      // pairing window is open. Otherwise the private address.
      startUrl = publicLink?.live ? publicStart : "";
      // Someone at this terminal, reading the QR: a phone without the
      // Tailscale app may sign in from its browser for the next minutes.
      // Not a window Reach opened by itself (a restart from the phone, at
      // sign-in: REACH_OPENED_BY, scripts/login-start.mjs).
      // The request to pair starts now even if Funnel still needs enabling.
      // It expires normally and approval on the private link closes it too.
      if (attended) openPairingWindow(dataDir);
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
      console.log(
        phoneLinkText({
          oneAddress: !!startUrl,
          attended,
          ownLink: startUrl && link !== startUrl ? startUrl : "",
          publicProblem: publicStart && !startUrl ? publicLink?.lastError || "the public link is off." : "",
        }),
      );
      phoneLinkShown = true;
      if (startUrl)
        void publicNameState(new URL(startUrl).hostname).then((state) => {
          if (state === "missing" && !stopped) console.log(UNPUBLISHED);
        });
      if (!options.service) {
        const seen = new Set();
        let unreadable = false;
        approvalMonitor = setInterval(() => {
          const linked = reach.fleet?.links().length > 0;
          // Its folder unreadable for a moment (permissions, a full disk):
          // said once, tried again next second, never Reach's end.
          let requests;
          try {
            requests = approvalStore(dataDir).list();
            unreadable = false;
          } catch (error) {
            if (!unreadable) console.warn(`Reach: device requests can't be read right now (${error.code || error.message}).`);
            unreadable = true;
            return;
          }
          for (const request of requests) {
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
        `Reach is ready · ${origin}\nRun ${command} pair for a fresh pairing code and QR.`,
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
    if (phoneNeedsApp)
      console.log(
        "  Private Tailscale link: only your Tailscale devices open it, and Reach pairing is also required. No public internet tunnel is enabled.",
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
