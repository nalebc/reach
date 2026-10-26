import {
  readPreferences,
  readHttpsPort,
  rememberHttpsPort,
  assertSocketSupport,
  assertOwnerAccount,
  preferencesFile,
  keyedSupportProblem,
} from "./configure.mjs";
import {
  keyRedactor,
  keyedTarget,
  newIngressKey,
  serveSocketPath,
} from "../server/tailscale-auth.mjs";
import { createTailscaledPeerCheck } from "../server/tailscaled-peer.mjs";
import { ensurePrivateFolders } from "../server/windows-private-folder.mjs";
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
import { registerWindowsBuildDirectory, windowsBinary } from "../server/desktop-native.mjs";
import { computerWord } from "../server/computer-word.mjs";
import { createReach } from "../server/index.mjs";
import { sweepScreenHelpers } from "../server/screen-stream.mjs";
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
  foreignIngressRoute,
  readKeyedState,
} from "./tailscale.mjs";
import { command, packaged, stateDir } from "./home.mjs";
import { watchStopRequest, windowsBootTime } from "./instances.mjs";
import { pageOpener } from "./tailscale-connect.mjs";
import { publicStartHandler } from "../server/public-start.mjs";
import { setStartInfo } from "../server/delivery.mjs";
import { startOrigin } from "./public-link.mjs";
import { EphemeralFunnel } from "./ephemeral-funnel.mjs";
import { ForegroundServe, createLock } from "./foreground-serve.mjs";
import { ForegroundFunnel } from "./foreground-funnel.mjs";
import { checkBrowserLink } from "./browser-link.mjs";

// Windows' keyed route: its check took Tailscale's own connections for
// another program's, or didn't answer in time again and again.
const UNRECOGNISED =
  "Reach couldn't confirm that its private route's connections come from Tailscale's own service on this PC.";
const UNANSWERED = "Reach's check of Tailscale's connections kept failing to answer on this PC.";
const HOUR = 3600000;

export async function launch(options, root) {
  let privateFolders;
  try {
    return await launchRun(options, root, folders => { privateFolders = folders; });
  } finally {
    // This also covers preparation failures before createReach exists. On a
    // normal stop, launchRun has already closed the server and all helpers.
    await privateFolders?.dispose?.().catch(error => console.warn(`Reach: couldn't remove its private helper folder (${error.code || error.message}).`));
  }
}

async function launchRun(options, root, ownPrivateFolders) {
  // Reach's window carries its name on Windows too: the window agents'
  // presets know as Reach's (docs/WINDOWS_AGENT_PARITY.md, Decisions).
  if (process.platform === "win32" && process.stdout.isTTY) process.title = "Reach";
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
  // Windows' native preflight atomically creates missing protected roots.
  // A path-based recursive mkdir here could follow an unchecked junction.
  if (process.platform !== "win32") fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // An error nothing caught: said, kept, and Reach exits so ./reach (or the
  // background service) starts it again (server/crash-guard.mjs).
  // Set by ./reach for this run only, not handed on to terminals and agents.
  const supervised = !!options.service || process.env.REACH_SUPERVISED === "1";
  delete process.env.REACH_SUPERVISED;
  // Windows' keyed route: its key is taken out of a crash's words too, once
  // there is one.
  let crashRedact = (text) => text;
  const removeCrashGuard = installCrashGuard({ dataDir, supervised, redact: (text) => crashRedact(text) });
  const httpsPort = options.httpsPort || readHttpsPort(root) || 8443;
  const routeFile = path.join(privateDir, "serve-owner.json");
  const funnelFile = path.join(privateDir, "funnel-owner.json");
  const statusFile = path.join(privateDir, "host-status.json");
  let preferences = !options.local ? readPreferences(root) : null;
  // Windows has no Unix socket: a keyed loopback route only Tailscale's own
  // process may use (docs/parity/D-public-door.md).
  const keyedDoor = !!preferences && process.platform === "win32";
  const browserRequired = !!preferences;
  // What an earlier start noted about that route (below): Tailscale's own
  // connections taken for another program's (pairing codes for a day, or
  // until Tailscale changes), or its check not answering in time twice
  // within an hour (pairing codes for an hour). Then it's tried again.
  const unrecognisedFile = path.join(privateDir, "sign-in-unrecognised.json");
  const noted = () => (keyedDoor ? loadJson(unrecognisedFile, null) : null);
  const unrecognised = (state) => {
    const seen = noted();
    if (!seen) return "";
    const age = Date.now() - Number(seen.at);
    const version = String(state?.status?.Version || "");
    if (seen.tailscale === version && age >= 0) {
      if (seen.kind === "other" && age < 24 * HOUR) return UNRECOGNISED;
      if (seen.kind === "late" && age < HOUR) return seen.count >= 2 ? UNANSWERED : "";
    }
    fs.rmSync(unrecognisedFile, { force: true });
    return "";
  };
  // The check's answers for this start: yes, or "another program's".
  const peerAnswers = { yes: 0, other: 0 };
  const socketPath = preferences && !keyedDoor ? serveSocketPath(root) : null;
  let peerCheck = null,
    windowsSandboxHelper = null,
    windowsDesktopHelper = null,
    windowsGuestScreenHelper = null,
    windowsHelpersOff = "",
    ingressKey = "",
    keyedState = null,
    signInOff = "";
  // Reach's folders on Windows, private to your account on every start, as
  // 0700 keeps them on a Mac (docs/WINDOWS_AGENT_PARITY.md, Decisions:
  // "Reach's folders"), whether or not browser sign-in is set up: Windows
  // ignores 0700. Its keyed route's peer check is built there too. The
  // helpers that act for agents are built only in that folder, once it's
  // confirmed private, on first use from this process's private new stage:
  // the sandbox around
  // their commands and files (scripts/native/sandbox.cs) and the agent desktop
  // (scripts/native/agent-desktop.cs), so neither owner-token helper can be
  // swapped by another user of the PC. An unsafe state folder stops startup
  // before authentication state or listeners can exist. A later optional
  // helper build failure refuses that feature. `privateFolders` is a code-only option
  // (tests), never read from argv.
  let folders = null;
  if (process.platform === "win32") {
    const nativeDir = path.join(privateDir, "native");
    folders = await (options.privateFolders || ensurePrivateFolders)({
      protect: [...new Set([privateDir, dataDir])],
      check: [root],
      nativeDir,
      helpers: keyedDoor ? ["tailscaled-peer"] : [],
    });
    if (folders.ok) {
      ownPrivateFolders({ dispose: async () => {
        await peerCheck?.close();
        await folders.dispose?.();
      } });
      folders.activate?.();
      windowsSandboxHelper = options.windowsSandboxHelper || folders.helper("sandbox");
      windowsDesktopHelper = options.windowsDesktopHelper || folders.helper("agent-desktop");
      // Guests' live screen: Windows' video helper with the agent desktop's
      // window rules built in, there too, as it hides what agents never see
      // (server/windows-guest-screen.mjs).
      windowsGuestScreenHelper = options.windowsGuestScreenHelper || folders.helper("screen-video");
    } else {
      windowsHelpersOff = `${folders.problem || "Reach couldn't check who can use its folders on this PC"}, so agents can't use this PC's screen, files or commands yet.${folders.advice ? ` ${folders.advice}` : ""}`;
      // Owner desktop/process helpers must not fall through to historical
      // cached executables after a folder refusal either.
      const unregister = registerWindowsBuildDirectory({ roots: [privateDir, dataDir, nativeDir], refusal: windowsHelpersOff });
      ownPrivateFolders({ dispose: async () => { unregister(); } });
      // Pairing creates a plaintext current code. Continuing with the same
      // refused state and clearing its Tailscale owner would expose an auth
      // fallback through files whose privacy has not been established.
      // Do not let the crash reporter create files there on this refusal.
      removeCrashGuard();
      throw Object.assign(Error(folders.reason || folders.problem || "Reach couldn't check who can use its folders on this PC."), { code: "EPRIVATEFOLDERS", status: 503 });
    }
  }
  if (preferences) {
    const status = await tailscaleJson(["status", "--json"]);
    assertOwnerAccount(status, preferences);
    if (!keyedDoor) await assertSocketSupport();
    else {
      // Its folders private first (above: Windows ignores 0700), then
      // Tailscale's own needs, then its check that a connection is
      // Tailscale's. Anything missing: pairing codes, with the reason.
      // `peerCheck` is a code-only option (tests), never read from argv.
      if (folders.ok) {
        keyedState = await readKeyedState().catch(() => ({ status }));
        const hooks = {
          // Its helper stopped, timed out or wouldn't start again: said
          // once per reason, so a refusal that follows has its cause.
          onProblem: (reason) => {
            const said = {
              stopped: "Reach's Tailscale check stopped; it starts again in a moment.",
              timeout: "Reach's Tailscale check didn't answer in time; it starts again in a moment.",
              garbled: "Reach's Tailscale check gave an answer Reach couldn't read; it starts again in a moment.",
            }[reason] || String(reason);
            console.warn(`Reach: ${said}`);
            try {
              log?.write(`Reach: ${said}`);
            } catch {}
          },
          onAnswer: (answer) => {
            if (answer?.ok) peerAnswers.yes++;
            else if (answer?.value === "o") peerAnswers.other++;
          },
        };
        // A test's stand-in check is given the same hooks.
        peerCheck =
          typeof options.peerCheck === "function"
            ? options.peerCheck(hooks)
            : options.peerCheck || createTailscaledPeerCheck({ helper: folders.helper("tailscaled-peer"), ...hooks });
      }
      const problem =
        folders.reason ||
        keyedSupportProblem(keyedState) ||
        unrecognised(keyedState) ||
        (await peerCheck.ready()).reason ||
        "";
      if (problem) {
        signInOff = problem;
        console.log(`Reach: browser sign-in is off on this PC for now: ${problem} Phones join with a pairing code and need the Tailscale app.`);
        await peerCheck?.close();
        peerCheck = null;
        preferences = null;
      } else ingressKey = newIngressKey();
    }
  }
  // Everything Reach says or keeps about Tailscale, without the route's key.
  const redact = ingressKey ? keyRedactor(ingressKey) : (text) => text;
  if (ingressKey) crashRedact = redact;
  if (options.service && !options.port)
    throw Error("A service needs its saved local port.");
  const privateOrigin = options.local
    ? ""
    : await prepareTailscale(
        httpsPort,
        // Reach's own route from an earlier run is reused, or replaced when
        // its target changed; anybody else's route is left on its own port.
        (config, origin) => recordedRouteOwned(routeFile, config, origin),
      );
  // The one address (https://<computer>.ts.net): Reach for your devices, the
  // start page for the internet. Its page may call Reach here too.
  // On Windows only with its keyed route, so no Funnel route is made otherwise.
  const publicStart = (socketPath || ingressKey) && privateOrigin ? startOrigin(privateOrigin) : "";
  const reach = await createReach({
    dataDir,
    port: options.port,
    // Setup's step 3 (scripts/setup.mjs phoneStep): said once the first phone
    // is in, so a first run visibly ends with it.
    ...(options.phoneStep && {
      onFirstDevice: () =>
        console.log(`\n  ✔ 3. Your phone  —  approved. Finish browser connection setup in Reach to use this same link with the phone app on or off.\n`),
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
    // Set up for browser sign-in, on pairing codes for now: why, for the
    // phone's answers about invite links.
    ...(signInOff && { signInOff }),
    // Windows: the helpers that act for agents, built in the folder confirmed
    // private this launch (server/windows-sandbox.mjs, server/agent-desktop.mjs).
    // Absent them, agents' screen, files and commands refuse with the reason.
    ...(windowsSandboxHelper ? { windowsSandboxHelper } : {}),
    ...(windowsDesktopHelper ? { windowsDesktopHelper } : {}),
    ...(windowsGuestScreenHelper ? { windowsGuestScreenHelper } : {}),
    ...(windowsHelpersOff ? { windowsHelpersOff } : {}),
    privatePaths: [privateDir, ...(folders?.privatePaths || [])],
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
  // A screen helper an earlier Reach left capturing (killed mid-stream) ends
  // now, not when someone notices the Mac's screen-sharing mark (Oct 12).
  sweepScreenHelpers({ dataDir: reach.config.dataDir });
  let input,
    stopped = false,
    stopPromise;
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  let log, monitor, approvalMonitor, recovery, power, stopWatch;
  let publicLink, publicMonitor, linkMonitor, foreground;
  // Windows' keyed route: its port, and its watch on Tailscale's settings.
  let ingressPort = 0,
    keyedMonitor;
  let startUrl = "";
  let phoneLinkShown = false;
  let refreshBrowserLink;
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
  // Windows' keyed route: tailscaled drops a session a moment after its
  // command ends. Until neither session leads to the keyed port, its
  // listener stays, so nobody who takes the port next gets a request.
  const routesGone = async (port, until) => {
    while (Date.now() < until) {
      try {
        if (!foreignIngressRoute(await tailscaleJson(["serve", "status", "--json"], { redact }), port, "")) return;
      } catch {}
      await delay(100);
    }
    const line = "Reach: Tailscale still listed Reach's private route; closing anyway.";
    console.warn(line);
    log?.write(line);
  };
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    const stopStartedAt = Date.now();
    // Whatever still holds on (a stuck helper, a socket nobody closed), Reach
    // is gone within seconds of being asked to stop.
    const deadline = setTimeout(() => {
      console.error("Reach: shutdown took too long; exiting now.");
      forgetStatus();
      // Asked to start again (the keyed route, above): still so.
      process.exit(process.exitCode || 1);
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
      clearInterval(keyedMonitor);
      // Windows' route ends before Reach's listener does.
      await foreground?.stop();
      // At most 1.5 s, and never past 4 s into stopping: the 5 s deadline holds.
      if (ingressPort) await routesGone(ingressPort, Math.min(Date.now() + 1500, stopStartedAt + 4000));
      power?.stop();
      await reach.close();
      await peerCheck?.close();
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
    // The start page, and its Face ID sign-in (its only requests that
    // reach Reach itself).
    const publicApp = startPage
      ? (req, res) => reach.publicAgent(req, res) || reach.publicFaceId(req, res) || startPage(req, res)
      : undefined;
    if (socketPath) {
      await reach.listenPrivate(socketPath, { publicApp });
      // Older Reach's separate start-page socket, if one was left behind.
      const old = path.join(path.dirname(socketPath), "p");
      try {
        const stat = fs.lstatSync(old);
        if (stat.isSocket() && stat.uid === process.getuid()) fs.rmSync(old);
      } catch {}
    }
    // Windows with browser sign-in: the keyed route. Closed while another
    // Tailscale route leads to its port, or Tailscale's settings no longer
    // allow it; a refusal said at most once a minute (never the key, nor
    // the path it was asked for).
    let foreignRoute = false,
      routeProblem = "";
    let selfIps = keyedState?.status?.Self?.TailscaleIPs || [];
    const refusals = { key: 0, peer: 0, route: 0, settings: 0 };
    let refusedSaidAt = 0;
    const noteRefusal = (kind) => {
      refusals[kind]++;
      if (Date.now() - refusedSaidAt < 60000) return;
      refusedSaidAt = Date.now();
      const why = {
        peer: "not from Tailscale's own process",
        key: "without its key",
        route: "another route leads to it",
        settings: "Tailscale's settings on this PC don't allow it now",
      }[kind];
      const line = `Reach: refused a connection to its private route (${why}).`;
      console.warn(line);
      log?.write(line);
    };
    if (ingressKey)
      ingressPort = await reach.listenKeyed({
        key: ingressKey,
        peerCheck,
        publicApp,
        refuse: () => (foreignRoute ? "route" : routeProblem ? "settings" : ""),
        onRefused: noteRefusal,
        selfIps: () => selfIps,
      });
    const serveTarget = socketPath ? `unix:${socketPath}` : ingressKey ? keyedTarget(ingressPort, ingressKey) : localUrl;
    // How the route is named in what Reach says or keeps: never with its key.
    const routeLabel = ingressKey ? `http://127.0.0.1:${ingressPort}/r-…` : serveTarget;
    atomicJson(path.join(dataDir, "agent-host.json"), {
      roots: reach.config.roots,
      agentPolicyFile: reach.config.agentPolicyFile,
      publicOrigin: privateOrigin || localUrl,
    });
    atomicJson(statusFile, {
      pid: process.pid,
      // When it started (Windows' status says it; there's no ps to ask).
      startedAt: Date.now(),
      // Which boot (Windows reuses process ids): a status file from before a
      // restart of the PC names no Reach.
      ...(process.platform === "win32" && { boot: windowsBootTime() }),
      // Whether it has a window of its own (`status` says so: Windows has no
      // terminal name to read, as ps gives on a Mac).
      ...(process.platform === "win32" && { window: !!process.stdout.isTTY }),
      instance: reach.instance,
      localUrl,
      origin: privateOrigin || localUrl,
      name: reach.config.name,
      dataDir: reach.config.dataDir,
      service: !!options.service,
      tailscaleApproval: !!preferences,
      // Started for browser sign-in, back on pairing codes: why (`status`).
      ...(process.platform === "win32" && signInOff && { signInOff }),
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
        reach.setPrivateTransportAvailable(value);
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
      // With browser sign-in, it and the public route change Tailscale's
      // serve config one at a time, and everything Tailscale says about them
      // loses the route's key first.
      const serveLock = ingressKey ? createLock() : null;
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
          ...(ingressKey && { redact, lock: serveLock, inspect: () => tailscaleJson(["serve", "status", "--json"], { redact }) }),
        });
      const startTunnel = async () => {
        if (stopped) return;
        try {
          if (foreground) {
            if (await foreground.start()) log.write(`Reach: private route held while Reach runs: ${origin} -> ${routeLabel}`);
            return;
          }
          const created = await ensurePersistentRoute({ file: routeFile, origin, target: serveTarget });
          if (created) log.write(`Reach: private route set: ${origin} -> ${routeLabel}`);
        } catch (error) {
          if (ingressKey && error instanceof Error) error.message = redact(error.message);
          setupHint(error.message);
          throw error;
        }
      };
      // Another Tailscale route to the keyed port (a TCP forward, a proxy):
      // a path from Tailscale's own process without the key. Closed until
      // it's gone; said once.
      const noteForeign = (config) => {
        const was = foreignRoute;
        foreignRoute = foreignIngressRoute(config, ingressPort, serveTarget);
        // A keyed-ingress security problem affects both routes, unlike an
        // interrupted Serve on the separate private port.
        reach.setTransportAvailable(!foreignRoute && !routeProblem);
        if (!foreignRoute || was) return;
        privateUp(false);
        const line = "Reach: Another Tailscale route leads to Reach's private port; Reach refuses it until it's removed (tailscale serve status).";
        console.log(line);
        log.write(line);
      };
      recovery = new PrivateLinkRecovery({
        origin,
        target: serveTarget,
        owns: foreground
          ? (config, address, target) => foreground.owns(config, address, target)
          : (config, address, target) => recordedRouteMatches(routeFile, config, address, target),
        inspect: async () => {
          const config = await tailscaleJson(["serve", "status", "--json"], { redact });
          if (ingressKey) noteForeign(config);
          return config;
        },
        restart: startTunnel,
        available: (value) => privateUp(value && !foreignRoute && !routeProblem),
        report: (message) => {
          const said = redact(message);
          console.log(`Reach: ${said}`);
          log.write(`Reach: ${said}`);
          setupHint(said);
        },
      });
      // Tailscale's own settings for the keyed route, read again every 15 s:
      // its adapter gone (userspace networking) or an older version closes
      // it until they're back. One failed read says nothing; two do.
      if (ingressKey) {
        const say = (line) => {
          console.log(`Reach: ${line}`);
          log.write(`Reach: ${line}`);
        };
        const setRouteProblem = (problem) => {
          if (problem === routeProblem) return;
          routeProblem = problem;
          reach.setTransportAvailable(!foreignRoute && !routeProblem);
          if (problem) {
            privateUp(false);
            say(`Browser sign-in paused on this PC: ${problem} It resumes by itself once that changes.`);
          } else {
            say("Browser sign-in restored on this PC.");
            void recovery?.check();
          }
        };
        let misses = 0;
        keyedMonitor = setInterval(async () => {
          let state = null;
          try {
            state = await readKeyedState({ redact });
            misses = 0;
          } catch {
            misses++;
          }
          if (stopped) return;
          if (state) {
            // The last ones Tailscale gave: a status without them doesn't
            // unmark this PC's own requests.
            const ips = state.status?.Self?.TailscaleIPs;
            if (Array.isArray(ips) && ips.length) selfIps = ips;
            setRouteProblem(keyedSupportProblem(state));
          } else if (misses >= 2) setRouteProblem("Reach couldn't read Tailscale's settings on this PC.");
        }, options.keyedEveryMs || 15000);
        keyedMonitor.unref();
      }
      reach.setPrivateTransportAvailable(false);
      await startTunnel();
      recovery.nextRestart = Date.now() + 15000;
      // `healthWaitMs`: a code-only option (tests), never read from argv.
      const deadline = Date.now() + (options.healthWaitMs || 90000);
      let healthy = false;
      while (!stopped && Date.now() < deadline) {
        await recovery.check();
        try {
          const config = await tailscaleJson(["serve", "status", "--json"], { redact });
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
      // Windows' keyed route answered nothing it was asked, its check
      // refusing Tailscale's connections. Taken for another program's with
      // none let through: noted for a day, and Reach starts again at once
      // with pairing codes. Not answered in time (a hiccup): Reach starts
      // again and tries the route once more; twice within an hour, noted,
      // and pairing codes for that hour. The crash code: started again by
      // the window it runs in (supervise.mjs) or its service.
      if (!healthy && ingressKey && refusals.peer > 0) {
        const tailscale = String(keyedState?.status?.Version || "");
        const other = peerAnswers.other > 0 && peerAnswers.yes === 0;
        const prior = noted();
        const count = !other && prior?.kind === "late" && prior.tailscale === tailscale && Date.now() - prior.at >= 0 && Date.now() - prior.at < HOUR ? (prior.count || 1) + 1 : 1;
        atomicJson(unrecognisedFile, { kind: other ? "other" : "late", count, tailscale, at: Date.now() });
        process.exitCode = 70;
        throw Object.assign(
          Error(other ? `${UNRECOGNISED} It stays closed; Reach starts again with pairing codes.` : count >= 2 ? `${UNANSWERED} Reach starts again with pairing codes for an hour.` : "Reach's check of Tailscale's connections didn't answer in time; Reach starts again and tries once more."),
          { relaunch: true },
        );
      }
      // It answered: an earlier start's note is done with.
      if (healthy && ingressKey) fs.rmSync(unrecognisedFile, { force: true });
      if (!healthy)
        throw Error(
          "The private phone link could not connect. Check Tailscale and HTTPS setup, then rerun Reach. No public tunnel was opened.",
        );
      rememberHttpsPort(root, Number(new URL(privateOrigin).port || 443));
      monitor = setInterval(() => void recovery.check(), 5000);
      monitor.unref();
      if (publicStart && !stopped) {
        // Funnel not allowed for this computer yet: Tailscale's answer
        // carries the page that allows it, printed and opened like setup's.
        const report = (message) => {
          const said = redact(message);
          console.log(`Reach: ${said}`);
          log.write(`Reach: ${said}`);
          setupHint(said);
        };
        const changed = (open) => {
            if (open) routes.public.since = Date.now();
            routes.public.open = open;
            noteRoutes();
            if (!phoneLinkShown || stopped) return;
            if (!open) {
              // Keep the bookmark stable through a temporary public outage.
              // Recovery updates availability, never the owner's URL.
              return;
            } else if (browserRequired) {
              void refreshBrowserLink?.();
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
          };
        // Public access, answered only while an invitation/admission/session
        // is alive. A Mac: a background Funnel route held on while Reach
        // runs, a janitor process holding a five-second lease on it. Windows
        // with browser sign-in: a foreground Funnel session, gone with Reach,
        // as its private route is (the route's key never stays in Tailscale).
        publicLink = ingressKey
          ? new ForegroundFunnel({
              origin: publicStart,
              target: serveTarget,
              window: reach.funnelWindow,
              log,
              redact,
              lock: serveLock,
              report,
              changed,
            })
          : new EphemeralFunnel({
              origin: publicStart,
              target: serveTarget,
              file: funnelFile,
              window: reach.funnelWindow,
              log,
              report,
              changed,
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
      if (phoneNeedsApp) console.log(`${phoneAppFirst({ account: phoneAccount, why: signInOff })}\n`);
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
    const showPrivate = () => {
      if (!preferences) return showCode(true);
      console.log(`\n  Private link: ${privateOrigin}\n  Your phone's Tailscale app must be on this computer's Tailscale network.\n`);
      qr.generate(privateOrigin, { small: true });
      console.log(`  Tap Connect, then approve the code here.\n`);
    };
    if (preferences) {
      // The one address once Reach holds it (port 443): with the Tailscale
      // app it's Reach itself; without the app, the fixed start page.
      // Wait for bootstrap readiness on every host before showing its QR.
      startUrl = !browserRequired && publicLink?.live ? publicStart : "";
      // Someone at this terminal, reading the QR: a phone without the
      // Tailscale app may sign in from its browser for the next minutes.
      // Not a window Reach opened by itself (a restart from the phone, at
      // sign-in: REACH_OPENED_BY, scripts/login-start.mjs).
      // The request to pair starts now even if Funnel still needs enabling.
      // It expires normally and approval on the private link closes it too.
      if (attended) openPairingWindow(dataDir);
      if (browserRequired) {
        let checking = null, lastReason = "";
        refreshBrowserLink = () => checking ??= (async () => {
          if (stopped || startUrl) return;
          const result = publicLink?.live
            ? await (options.browserCheck || checkBrowserLink)(publicStart, reach.instance)
            : { ready: false, reason: publicLink?.lastError || "Waiting for Tailscale to enable this computer's public browser link." };
          if (stopped) return;
          const current = loadJson(statusFile, null);
          if (current?.instance === reach.instance)
            atomicJson(statusFile, { ...current, browserLink: result });
          if (!result.ready) {
            if (result.reason !== lastReason) console.log(`Reach: ${result.reason}\n  Waiting before showing the phone QR. Keep this terminal open.`);
            lastReason = result.reason;
            return;
          }
          startUrl = publicStart;
          noteLink(startUrl);
          if (phoneLinkShown) {
            console.log(`\nReach: browser connection is ready.\n  Open on your phone: ${startUrl}\n`);
            if (!options.service) qr.generate(startUrl, { small: true });
            const pairing = loadJson(pairingWindowFile(dataDir), null);
            console.log(phoneLinkText({ oneAddress: true, attended: pairing?.until > Date.now() }));
          }
        })().catch(error => console.warn(`Reach: checking the browser link: ${error.message}`)).finally(() => { checking = null; });
        await refreshBrowserLink();
        publicMonitor = setInterval(() => void refreshBrowserLink(), 5000);
        publicMonitor.unref();
      }
      // Linked computers share one link: the one where Reach started first.
      const link = startUrl
        ? reach.fleet?.homeLink({ start: startUrl, since: setupSince() }) ||
          startUrl
        : origin;
      if (startUrl) noteLink(link);
      if (browserRequired && !startUrl) {
        noteLink(publicStart);
        console.log(`\n${heading()}\n  Preparing your permanent phone link: ${publicStart}\n  No phone app is needed. Keep this link when the connection returns.\n  Tailscale account: ${preferences.owner.login}\n`);
      }
      else console.log(
        `\n${heading()}\n  Open on your phone: ${link}\n  Tailscale account: ${preferences.owner.login}\n`,
      );
      if (!options.service && (!browserRequired || startUrl)) qr.generate(link, { small: true });
      if (!browserRequired || startUrl) console.log(
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
    else if (browserRequired) console.log(`\nReach: the phone browser connection could not be prepared.\n  ${signInOff || "Run Reach setup to configure browser sign-in."}\n  A private QR would require the phone app, so none is shown.\n`);
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
    if (browserRequired && !options.service)
      console.log("  Already using the Tailscale app on this computer's network? Type private for its private QR. Your permanent phone QR appears automatically when ready.");
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
        } else if (!options.local && line.trim().toLowerCase() === "private") showPrivate();
        else if (!preferences && !browserRequired) showCode(true);
        else if (!preferences) console.log("Reach: waiting for browser setup. Type private only if your phone is already connected to this Tailscale network.");
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
    // The same three modes on a Mac (caffeinate) and a Windows PC (its own
    // helper, built on first use: scripts/native/stay-awake.cs).
    if (process.platform === "darwin" || process.platform === "win32") {
      const mode = stayAwakeMode(options.stayAwake);
      console.log(
        mode === "off"
          ? `Reach: sleep prevention is off. Screen sharing can stop when this ${computerWord()} sleeps. Use --stay-awake-always to enable it.`
          : `Reach: keeping system and display awake ${mode === "ac" ? "while plugged in" : "while Reach runs, including on battery"}. Manual locking, lid closure and managed lock policies still apply.`,
      );
      power = keepAwake({
        mode,
        helper: () => windowsBinary(reach.config, "stay-awake"),
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
