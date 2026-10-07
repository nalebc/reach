import { browserAgentRoutes } from "./browser-agents.mjs";
import { createBrowserOperationCoordinator } from "./browser-operation-coordinator.mjs";
import { createBrowserHostGuard } from "./browser-host-guard.mjs";
import { createBrowserAppAccess } from "./browser-app-access.mjs";
import { BrowserAppNative } from "./browser-app-native.mjs";
import { runBrowserScript } from "./browser-scripts.mjs";
import { browserPrivatePaths, isBrowserPrivatePath, validateBrowserRoot } from "./browser-private-paths.mjs";
import { browserFileOperation } from "./browser-file-boundary.mjs";
import { DevicePresence, presenceConnection } from "./presence.mjs";
import {
  createIdentityResolver,
  listenPrivateIngress,
  trustedRequest,
  serveRequestHost,
  ownerIdentity,
} from "./tailscale-auth.mjs";
import { approvalStore } from "./device-approval.mjs";
import { createPasskeys } from "./passkeys.mjs";
import { createFaceJoin } from "./face-join.mjs";
import { createFleet } from "./fleet.mjs";
import { createGuestKeys, guestPolicy } from "./guest-keys.mjs";
import { tailscaleJson } from "../scripts/tailscale.mjs";
import {
  AGENTS,
  agentCommand,
  createAppShortcuts,
} from "./app-shortcuts.mjs";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileRootName } from "./file-roots.mjs";
import { DOCUMENT_TEXT, readDocumentText } from "./document-text.mjs";
import { isIconType, readFileIcons } from "./file-icons.mjs";
import { compressJson, serveBuild } from "./delivery.mjs";
import { createUploads } from "./uploads.mjs";
import { createLinks } from "./links.mjs";
import { ensurePtyHelper } from "./pty-helper.mjs";
import { createAppIconCache } from "./app-icons.mjs";
import { fileURLToPath } from "node:url";
import multer from "multer";
import { WebSocketServer, WebSocket } from "ws";
import {
  getConfig,
  createAuth,
  fail,
  id,
  loadJson,
  atomicJson,
  safePath,
  safePathAsync,
  validOrigin,
  validLeafName,
  hash,
  ALL_SCOPES,
  AGENT_SCOPES,
  GUEST_BLOCKED_ROUTES,
} from "./core.mjs";
import crypto from "node:crypto";
import { computerIdentity } from "./computer-identity.mjs";
import { applyAgentPolicy, readAgentPolicy, within } from "./agent-policy.mjs";
import { presetAppsFromCatalog } from "./agent-presets.mjs";
import { createAgentDesktop, reachAddresses } from "./agent-desktop.mjs";
import { createAgentShell } from "./agent-shell.mjs";
import { Terminals } from "./terminal.mjs";
import { installPlan } from "./agent-install.mjs";
import { DesktopTerminals } from "./desktop-terminals.mjs";
import {
  MacTerminalWatch,
  terminalWatchHelper,
} from "./mac-terminal-watch.mjs";
import { ScreenControl, pausedMessage } from "./screen.mjs";
import { RemoteScreenHub } from "./remote-screen.mjs";
import {
  AppThreads,
  AppScreenHub,
  AppDisplaysHelper,
  appScreenSource,
} from "./app-threads.mjs";
import { AgentApps } from "./agent-apps.mjs";
import { AgentInputHelper } from "./agent-input.mjs";
import { createPush } from "./push.mjs";
import { createNotifications, readAttention } from "./notifications.mjs";
import { createNotificationActions, notificationPush, admissionNotification, pushLine } from "./notification-items.mjs";
import { idleSeconds } from "./agent-sessions/claude-import.mjs";
import { DesktopInput, desktopDisplays } from "./desktop-native.mjs";
import { desktopConnection } from "./desktop-connection.mjs";
import { ScreenBroadcast, createScreenSource } from "./screen-stream.mjs";
import { watchInterface } from "./live-interface.mjs";
import { restartRequests } from "./restart-requests.mjs";
import { startInTerminal } from "../scripts/stop.mjs";
import { BrowserScreenSnapshots } from "./browser-screen.mjs";
import { Jobs } from "./jobs.mjs";
import { Codex } from "./codex.mjs";
import { createAgentSessions } from "./agent-sessions/index.mjs";
import { createOpenClaw, openClawRoutes } from "./openclaw.mjs";
import { createDoneWatch } from "./agent-sessions/done-watch.mjs";
import { agentName } from "./agent-sessions/move.mjs";
import { createAgentFonts } from "./agent-sessions/fonts.mjs";
import { createAgentImages } from "./agent-sessions/images.mjs";
import { CODEX_MODES } from "./agent-sessions/codex.mjs";
import { createToolDetector, deviceCapabilities } from "./capabilities.mjs";
import { browserAccessRoutes, browserRouteAllowed } from "./browser-access.mjs";
import { createFunnelAgentGateway } from "./funnel-agent.mjs";
import { createBrowserApprovals, browserRequestActions } from "./browser-approvals.mjs";
import { runTerminalCommand } from "./restricted-terminal.mjs";
import { runBrowserMutation } from "./browser-mutations.mjs";
import { createBrowserCommandLog } from "./browser-command-log.mjs";
import { saveBrowserCommandRecords } from "./browser-command-records.mjs";
import {
  apps,
  launchApp,
  tailscaleInfo,
  screenCapture,
  screenInput,
  availableMemory,
} from "./platform.mjs";

export async function createReach(overrides = {}) {
  const ptyWarning = ensurePtyHelper();
  if (ptyWarning) console.warn(`Reach: ${ptyWarning}`);
  const instance = crypto.randomUUID();
  let transportAvailable = true;
  const funnelRequests = new WeakMap();
  const browserResponses = new Map();
  let browserResponseCount = 0;
  let prepareFunnel;
  let publicAgent = () => false;
  const config = getConfig(overrides);
  config.roots = config.roots.map((p) => fs.realpathSync.native(p));
  if (config.agentPolicyRequired || fs.existsSync(config.agentPolicyFile))
    readAgentPolicy(config.agentPolicyFile);
  config.privatePaths = [
    ...(config.privatePaths || []),
    config.agentPolicyFile,
  ];
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  // Settings changed from a paired phone persist; REACH_SCREEN only sets the default.
  const settingsFile = path.join(config.dataDir, "settings.json");
  const settings = { screen: config.screen, ...loadJson(settingsFile, {}) };
  config.screen = settings.screen === true;
  // Written by the Mac app, which owns the macOS privacy permissions.
  const hostFile = path.join(config.dataDir, "host.json");
  const deviceFile = path.join(config.dataDir, "device.json");
  const device = loadJson(deviceFile, { id: id() });
  device.computerId =
    (await computerIdentity()) || device.computerId || device.id;
  atomicJson(deviceFile, device);
  const auth = createAuth(config),
    terminals = overrides.terminals || new Terminals(),
    codex = new Codex(config),
    jobs = new Jobs(config),
    app = express(),
    server = http.createServer(app);
  const browserHostGuard = createBrowserHostGuard({ clients: () => auth.list(), ...overrides.browserHostGuard });
  const detectTools = createToolDetector(overrides.toolDetection);
  const resolveIdentity = createIdentityResolver(overrides.tailscaleIdentity);
  const approvals = config.tailscaleOwner
    ? approvalStore(config.dataDir)
    : null;
  // Face ID instead of typing a new browser's code here: on this computer's
  // own Tailscale name, from its private link or its start page only.
  const passkeyHost = config.publicOrigin?.startsWith("https://")
    ? new URL(config.publicOrigin).hostname
    : "";
  const passkeys =
    approvals && passkeyHost
      ? createPasskeys({
          dataDir: config.dataDir,
          rpId: passkeyHost,
          origins: [
            new URL(config.publicOrigin).origin,
            `https://${passkeyHost}`,
          ],
          ...overrides.passkeys,
        })
      : null;
  let privateServer;
  const approvalCleanup = approvals
    ? setInterval(() => approvals.list(), 30000)
    : null;
  approvalCleanup?.unref();
  // Your other Reach computers: linked in their terminals, they share
  // device approvals, and their pages may call this one (server/fleet.mjs).
  const fleet =
    config.tailscaleOwner && config.publicOrigin
      ? createFleet({
          dataDir: config.dataDir,
          owner: config.tailscaleOwner,
          selfOrigin: config.publicOrigin,
          isApprovedHere: ({ userId, nodeId }) =>
            auth
              .list()
              .some(
                (c) =>
                  c.kind === "device" &&
                  c.tailscale?.userId === userId &&
                  c.tailscale?.nodeId === nodeId &&
                  c.expiresAt > Date.now(),
              ),
          ...overrides.fleet,
        })
      : null;
  const baseOrigins = [...(config.allowedOrigins || [])];
  const syncOrigins = () => {
    config.allowedOrigins = [
      ...new Set([...baseOrigins, ...(fleet?.origins() || [])]),
    ];
  };
  syncOrigins();
  fleet?.onChange(syncOrigins);
  // Links made from another terminal (./reach link) apply within 30 s.
  const originSync = fleet ? setInterval(syncOrigins, 30000) : null;
  originSync?.unref();
  // One-time Tailscale keys in invitations (server/guest-keys.mjs), and
  // removing guests' devices once their invitation ends.
  const guestKeys = config.tailscaleOwner
    ? createGuestKeys({
        dataDir: config.dataDir,
        self: device.id,
        log: (message) => console.log(`Reach: ${message}`),
        ...overrides.guestKeys,
      })
    : null;
  // Face ID sign-in for a new browser of yours, without the Tailscale app or
  // login (server/face-join.mjs): a passkey here and invite keys set up.
  const faceJoin =
    passkeys && guestKeys
      ? createFaceJoin({
          passkeys,
          guestKeys,
          log: (message) => console.log(`Reach: ${message}`),
          ...overrides.faceJoin,
        })
      : null;
  // The devices of your Face ID browsers whose access here is still on.
  const faceDevices = () =>
    new Set(
      auth
        .list()
        .filter(
          (c) =>
            c.kind === "device" &&
            c.tailscale?.faceJoin &&
            (c.expiresAt || Date.parse(c.createdAt) + 30 * 86400000) >
              Date.now(),
        )
        .map((c) => c.tailscale.nodeId),
    );
  const tidyFace = () =>
    guestKeys
      .reconcileFace(faceDevices())
      .catch((e) => console.log(`Reach: ${e.message}`));
  const tidyGuests = () =>
    guestKeys?.configured() &&
    Promise.all([
      guestKeys.reconcile().catch((e) => console.log(`Reach: ${e.message}`)),
      tidyFace(),
    ]);
  const guestTimers = [
    setTimeout(tidyGuests, 20000),
    setInterval(tidyGuests, 5 * 60000),
  ];
  for (const timer of guestTimers) timer.unref();
  const verify = (req, token) => {
    const context = funnelRequests.get(req);
    const client = context
      ? context.token === token && !paused && transportAvailable &&
        auth.verifyFunnel(token, context.keyThumbprint)
      : auth.verify(token, req.reachIdentity);
    if (!browserHostGuard.allows(req, client)) return null;
    return client?.policy?.browser && req.headers.upgrade?.toLowerCase() === "websocket"
      ? null : client;
  };
  // Refresh long-running requests/sockets; cached CLI lookups are shared by node.
  const trackIdentity = (req, end) => {
    if (!config.tailscaleOwner || funnelRequests.has(req)) return () => {};
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        req.reachIdentity = await resolveIdentity(req);
        if (!req.reachIdentity) end();
        if (browserHostGuard.isActive()) {
          await browserHostGuard.refresh();
          browserHostGuard.assertRequest(req, verify(req, req.headers.authorization?.replace(/^Bearer /, "")));
        }
      } catch {
        req.reachIdentity = null;
        end();
      } finally {
        busy = false;
      }
    }, 2000);
    timer.unref();
    return () => clearInterval(timer);
  };
  const presence = new DevicePresence();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
  });
  // Every Codex and Claude Code session on this computer (Chat tab).
  const openClaw = overrides.openClaw || createOpenClaw({ dataDir: config.dataDir });
  // Chats move to and from OpenClaw too (agent-sessions/move.mjs).
  const agentSessions =
    overrides.agentSessions ||
    createAgentSessions({
      dataDir: config.dataDir,
      openClaw,
      // A terminal's menu answered in its tab (read and typed into through
      // Reach's Mac terminals, made just below).
      terminals: {
        list: (...a) => desktopTerminals.list(...a),
        action: (...a) => desktopTerminals.action(...a),
      },
    });
  // Find sessions as soon as Reach runs, not when the Chat tab opens. Tests
  // (node --test) never reach for the real agents.
  if (!overrides.agentSessions && !process.env.NODE_TEST_CONTEXT)
    server.once("listening", () => agentSessions.warm?.());
  // The Claude app's typefaces, for Claude's chats on the phone (fonts.mjs).
  const agentFonts = overrides.agentFonts || createAgentFonts();
  const appShortcuts = createAppShortcuts({
    dataDir: config.dataDir,
    // Terminal shortcuts open a Mac terminal window and run one command.
    macTerminal: (command, authorize) =>
      desktopTerminals.create("terminal", authorize, command),
    resolveFolder: (root, folder) => {
      const dir = resolve(root, folder);
      if (!fs.statSync(dir).isDirectory()) throw fail(400, "Choose a folder.");
      return dir;
    },
    ...overrides.appShortcuts,
  });
  const screenControl = new ScreenControl();
  // While macOS shows one of its own dialogs, only the owner's own devices
  // click or type on the screen (ScreenControl.ownerOnly).
  screenControl.dialogUp = () => (agentSessions.macDialogs?.() || []).length > 0;
  const desktopTerminals = new DesktopTerminals(overrides.desktopTerminals);
  // The Mac's Terminal windows, told by events while a phone is connected;
  // changes reach phones at once through their live connection.
  const presenceNudges = new Set();
  const macTerminalWatch = new MacTerminalWatch({
    terminals: desktopTerminals,
    start: overrides.terminalWatch || terminalWatchHelper(config),
    onChange: () => {
      for (const nudge of presenceNudges) nudge();
    },
    ...overrides.macTerminalWatch,
  });
  const screenStreams = new ScreenBroadcast(
    overrides.screenStreamFactory || (() => createScreenSource(config)),
  );
  const remoteScreens = new RemoteScreenHub(
    config,
    overrides.remoteScreenFactory,
  );
  // Apps on your phone: each runs on its own hidden display on the Mac.
  const appThreads = new AppThreads({
    file: path.join(config.dataDir, "app-threads.json"),
    listApps: overrides.appList || apps,
    startHelper:
      overrides.appDisplays ||
      ((handlers) => AppDisplaysHelper.start(config, handlers)),
    ...(overrides.appPlatform && { platform: overrides.appPlatform }),
    onChange: (thread, reason) => {
      if (reason === "region")
        appScreens.end(thread.id, "Fitting the app to your screen…", true);
      else if (
        ["closed", "released", "removed", "failed", "quit"].includes(reason)
      )
        appScreens.end(
          thread.id,
          reason === "closed"
            ? `${thread.name}'s window was closed on the Mac.`
            : reason === "quit"
              ? `${thread.name} quit.`
              : `${thread.name} went back to the Mac.`,
          false,
        );
      if (reason === "opened") record("app", `${thread.name} on phone`);
    },
  });
  // Messages from the phone waiting for their Claude app chat: listed in
  // Reach's menu bar item, where a click opens the chat.
  if (agentSessions.onOutbox && agentSessions.waitingOnMac) {
    let listed = "[]";
    const showWaiting = () => {
      const chats = agentSessions.waitingOnMac();
      const next = JSON.stringify(chats);
      if (next === listed) return;
      listed = next;
      appThreads.waiting(chats);
    };
    agentSessions.onOutbox(showWaiting);
    showWaiting();
  }
  const appScreens = new AppScreenHub(
    appThreads,
    overrides.appScreenFactory || ((options) => appScreenSource(config, options)),
  );
  // Notifications on your phones (server/push.mjs), only for what needs you,
  // and only to your own devices: never guests or agents.
  const push = createPush({
    dataDir: config.dataDir,
    subject: () =>
      config.publicOrigin?.startsWith("https://")
        ? `https://${new URL(config.publicOrigin).hostname}`
        : "https://localhost",
    ...overrides.push,
  });
  const ownDevices = () =>
    auth
      .list()
      .filter(
        (c) =>
          c.kind === "device" &&
          c.scopes?.includes("admin") &&
          Date.now() < (c.expiresAt || Infinity),
      )
      .map((c) => c.id);
  const notify = (message) => {
    const url = new URL(message.url || "/?notifications=1", "https://reach.invalid");
    url.searchParams.set("computer", device.computerId || device.id);
    return push.notify(ownDevices(), { ...message, url: url.pathname + url.search }).catch(() => ({ sent: 0 }));
  };
  // "Your chat is done", once, unless a phone has that chat open
  // (agent-sessions/done-watch.mjs). A phone with a chat open asks for its
  // live state every few seconds; that's how "open" is known here.
  const chatOpenAt = new Map();
  const doneWatch = createDoneWatch({
    list: () => agentSessions.list(),
    notify,
    watching: (agent, id) => Date.now() - (chatOpenAt.get(`${agent}:${id}`) || 0) < 15000,
    // The last thing the agent said (the list's preview can be your prompt).
    reply: async (agent, id) => {
      const read = agentSessions.read(agent, id, { limit: 30 });
      const { items = [] } = await Promise.race([read, new Promise((_, no) => setTimeout(no, 3000).unref?.())]);
      return items.findLast((item) => item.role === "assistant" && item.text?.trim())?.text || "";
    },
  });
  // On every change of the chat list (its timer is only the slow fallback).
  agentSessions.onListChange?.(() => void doneWatch.look());
  // Tag in: agents use apps on their own hidden displays and hand them to
  // you on the phone (server/agent-apps.mjs).
  const agentApps = new AgentApps({
    threads: appThreads,
    control: screenControl,
    file: path.join(config.dataDir, "agent-apps.json"),
    paused: () => paused,
    idle: overrides.agentIdle || (() => idleSeconds()),
    capture:
      overrides.appScreenFactory ||
      ((options) => appScreenSource(config, options)),
    createInput: (display) =>
      (overrides.agentInputFactory || DesktopInput.create)(config, display),
    // In-app actions, in parallel with you (scripts/native/agent-input.swift).
    targeted:
      overrides.agentTargeted !== undefined
        ? overrides.agentTargeted
        : appThreads.platform === "darwin" && !overrides.appDisplays
          ? () => AgentInputHelper.start(config)
          : null,
    // Which display a phone controls: the agent waits only for its own app.
    controlDisplay: (clientId) => inputConnections.get(clientId)?.reachDisplay,
    onChange: (reason, handoff) => {
      for (const nudge of presenceNudges) nudge();
      if (reason === "handoff")
        notify({
          title: `${pushLine(handoff.app, 70)} · Your turn`,
          category: "handoffs",
          // Reach's words, never the agent's: an invited agent could write anything.
          body: `${pushLine(handoff.agent, 60)} handed over control. Continue in the live app.`,
          icon: /claude/i.test(handoff.agent) ? "claude" : /codex/i.test(handoff.agent) ? "codex" : "agent",
          actions: [{ action: "open", title: "Open app" }],
          tag: `handoff-${handoff.id.slice(0, 8)}`,
          // One tap: the app itself (src/deep-link.ts).
          ...(handoff.threadId && { url: `/?page=apps&threadId=${encodeURIComponent(handoff.threadId)}` }),
        });
    },
  });
  // An agent whose access ended leaves: its apps go back to the Mac.
  const agentDrives = (clientId) => {
    const c = auth.list().find((x) => x.id === clientId);
    if (
      !c ||
      Date.now() >= (c.expiresAt || Date.parse(c.createdAt) + 30 * 86400000)
    )
      return false;
    return !!applyAgentPolicy(c, config)?.scopes.includes("apps:drive");
  };
  const agentSweep = setInterval(
    () => void agentApps.sweep(agentDrives).catch(() => {}),
    30000,
  );
  agentSweep.unref();
  const inputConnections = new Map();
  const closeInput = (clientId, message) => {
    for (const [id, ws] of inputConnections)
      if (!clientId || id === clientId) ws.endControl?.(message);
  };
  // Pause: the person at the computer gets it back. Streams end, nobody
  // controls it, and apps on the phone come back to its own screens (none
  // closed). Terminals, agents and files keep running out of sight. Resume
  // puts the apps back on the phone; screens reconnect by themselves.
  let paused = settings.paused === true;
  screenControl.paused = appThreads.paused = paused;
  const PAUSED = pausedMessage();
  const notPaused = () => {
    if (paused) throw fail(423, PAUSED);
  };
  let pausing = Promise.resolve();
  // One at a time, in order; one that fails doesn't stop the next.
  const setPaused = (value) =>
    (pausing = pausing.catch(() => {}).then(async () => {
      if (value === paused) return { paused };
      paused = screenControl.paused = appThreads.paused = value;
      settings.paused = value;
      atomicJson(settingsFile, settings);
      if (value) {
        browserApprovals.cancelPending();
        browserAppAccess.clear();
        browserSnapshots.clear();
        screenControl.clear();
        // The phone takes control back on Resume when it hears why.
        closeInput(undefined, PAUSED);
        // Retryable: a phone that doesn't know about pausing reconnects by
        // itself once the computer resumes.
        screenStreams.stop(PAUSED);
        browserScreenSnapshots.stop(PAUSED);
        remoteScreens.stop(PAUSED, true);
        appScreens.stop(PAUSED, true);
      }
      for (const nudge of presenceNudges) nudge();
      // The menu bar's helper hears it before resuming apps (it refuses to
      // lend windows while it thinks Reach is paused), after holding them.
      const menu = () =>
        appThreads.resident && appThreads.showMenu().catch(() => {});
      if (!value) await menu();
      try {
        await (value ? appThreads.hold() : appThreads.resumeAll());
      } catch (e) {
        console.warn(`Reach: ${value ? "pause" : "resume"}: ${e.message}`);
      }
      if (value) await menu();
      record("settings", value ? "Paused" : "Resumed");
      for (const nudge of presenceNudges) nudge();
      return { paused };
    }));
  appThreads.onMenu = (value) =>
    void setPaused(value).catch((e) =>
      console.warn(`Reach: ${e.message}`),
    );
  // The app in front on the Mac, from the menu bar's helper: a message
  // waiting because you're in the Claude app goes in once you leave it.
  appThreads.onFrontmost = (bundle) => agentSessions.frontmost?.(bundle);
  appThreads.onLaunched = (bundle) => agentSessions.launched?.(bundle);
  // Reach's item in the Mac's menu bar, with Pause and Resume. Tests never
  // start the real helper.
  if (
    overrides.menuBar ||
    (process.platform === "darwin" &&
      !overrides.appDisplays &&
      !process.env.NODE_TEST_CONTEXT)
  )
    server.once("listening", () =>
      appThreads
        .showMenu()
        .catch(
          (e) =>
            appThreads.stopping ||
            console.warn(`Reach: menu bar item: ${e.message}`),
        ),
    );
  let captureInFlight;
  let inputInFlight = false;
  const events = [];
  const record = (kind, title) => {
    events.unshift({ id: id(), kind, title, at: new Date().toISOString() });
    events.length = Math.min(events.length, 100);
  };
  const browserScreenAvailable = () => config.screen &&
    (overrides.browserScreenSupported ?? ["darwin", "win32"].includes(process.platform));
  const browserAppAvailable = (overrides.browserAppSupported ?? (overrides.browserScreenSupported === undefined && process.platform === "darwin"));
  const browserAppAccess = createBrowserAppAccess({
    native: overrides.browserAppNative || new BrowserAppNative(config),
    verifyClient: (id) => auth.list().find((client) => client.id === id),
    screenAvailable: () => browserScreenAvailable() && !paused && transportAvailable,
    persistRestriction: (id, appId, mode) => auth.restrictBrowserApp(id, appId, mode),
    notify, record,
  });
  // Screen, input and the app list for preset agents (server/agent-desktop.mjs).
  // Tests inject a stand-in; null means this Mac can't offer them, and the
  // screen presets refuse to be created.
  const agentDesktop = overrides.agentDesktop !== undefined ? overrides.agentDesktop : (process.platform === "darwin" ? createAgentDesktop(config, {
    available: () => browserScreenAvailable() && !paused && transportAvailable,
    hosts: () => reachAddresses(config), titles: () => ["reach"], protectedPaths: () => browserPaths(),
    verifyClient: (id) => auth.list().find((client) => client.id === id),
    phoneControls: () => !!screenControl.holder(), paused: () => paused, record,
  }) : null);
  const browserCapture = async (authorize, fresh = false) => {
    notPaused();
    authorize();
    // Approval verification needs a capture made after the owner approved,
    // rather than an in-flight frame from an earlier viewer.
    const frame = fresh
      ? await (overrides.browserCapture || screenCapture)(config)
      : await (captureInFlight ||= (overrides.browserCapture || screenCapture)(config).finally(() => {
          captureInFlight = null;
        }));
    notPaused();
    authorize();
    return frame;
  };
  // Viewing reuses a short-lived native capture session and sends a JPEG
  // bounded to 1600 pixels wide. Approval evidence and execution checks keep
  // using browserCapture's independent, full-resolution fresh captures.
  const browserScreenSnapshots = new BrowserScreenSnapshots(
    overrides.browserScreenFactory || (() => createScreenSource(config)),
    { fallback: () => (overrides.browserCapture || screenCapture)(config) },
  );
  const browserViewCapture = async (authorize) => {
    // Existing fixture captures must never start native capture in tests.
    if (overrides.browserCapture && !overrides.browserScreenFactory)
      return browserCapture(authorize);
    return browserScreenSnapshots.capture(() => {
      notPaused();
      if (!browserScreenAvailable()) throw fail(403, "Screen access was turned off.");
      return authorize();
    });
  };
  const browserSnapshots = new Map();
  const browserInputCheck = (authorize) => {
    authorize();
    notPaused();
    // A previously queued approval must never reach the unrestricted desktop
    // input path. Selected-app input has its own native, window-bound guard.
    throw fail(403, "Whole-desktop agent control is no longer available. Ask the owner for a new Selected apps invitation.");
  };
  const browserCommandLog = await createBrowserCommandLog({ dir: path.join(config.dataDir, "browser-commands") });
  // The shell for Full control agents (server/agent-shell.mjs): logged with
  // the other agent commands.
  const agentShell = createAgentShell({ commandLog: browserCommandLog, hosts: () => reachAddresses(config), protectedPaths: () => browserPaths(),
    protectedPids: () => [process.pid, process.ppid], record, ...(overrides.agentShellRun ? { run: overrides.agentShellRun } : {}) });
  const invalidateSharedWrites = ({ clientId, root }) => browserApprovals.invalidateSharedWrites(clientId, root);
  const browserOperations = createBrowserOperationCoordinator({
    onWrite: invalidateSharedWrites,
    onWriteFinished: invalidateSharedWrites,
  });
  const browserPaths = () => browserPrivatePaths(config);
  const browserApprovals = createBrowserApprovals({
    verifyOwner: (id) => {
      const client = auth.list().find((entry) => entry.id === id);
      if (!client || client.kind !== "device" || !client.scopes?.includes("admin") ||
          (client.expiresAt || Date.parse(client.createdAt) + 30 * 86400000) <= Date.now()) return null;
      return client;
    },
    onChange: (item) => saveBrowserCommandRecords(browserCommandLog, item),
    verifyClient: (clientId) => {
      const client = auth.list().find((c) => c.id === clientId);
      if (!client || client.status !== "accepted" || client.expiresAt <= Date.now()) return null;
      return applyAgentPolicy(client, config);
    },
    notify,
    record,
    execute: async (action, authorize, request, progress) => {
      if (action.type === "terminal-script") { authorize(); return runBrowserScript(action, () => { notPaused(); return authorize(); }, { resolve, config, privatePaths: browserPaths(), coordinator: browserOperations }); }
      const actions = browserRequestActions(action);
      const batch = action.type === "batch";
      if (actions.every((step) => ["terminal", "terminal-change"].includes(step.type))) {
        let output;
        for (const [index, step] of actions.entries()) {
          const check = () => { notPaused(); return authorize(); };
          check();
          if (batch) await progress(index, "executing");
          output = step.type === "terminal-change"
            ? await runBrowserMutation(step, check, { resolve, config, privatePaths: browserPaths(), coordinator: browserOperations })
            : await runTerminalCommand(step, check, resolve, { config, privatePaths: browserPaths() });
          if (batch) await progress(index, "executed", output);
        }
        return output;
      }
      // Legacy commands remain a human handoff. Never route them to a PTY.
      if (action.type === "command") throw fail(403, "Commands must be handled by you on the computer.");
      browserInputCheck(authorize);
      if (inputInFlight) throw fail(409, "Wait for the previous screen action to finish.");
      inputInFlight = true;
      try {
        const original = browserSnapshots.get(request.id);
        if (!original) throw fail(409, "That screen snapshot has expired. Ask for a new request.");
        const frame = await browserCapture(() => browserInputCheck(authorize), true);
        if (hash(frame) !== original.hash)
          throw fail(409, "The screen changed. Nothing was done. Ask for a new request.");
        const checkedAt = Date.now();
        // A batch approves this immutable sequence, not a lasting control
        // grant. Only its initial screen can match the owner's review: the
        // listed inputs may change the screen. Never pretend later frames
        // were owner-reviewed, and never accept replacements from the bot.
        for (const [index, step] of actions.entries()) {
          const check = () => {
            browserInputCheck(authorize);
            if (index === 0 && Date.now() - checkedAt > 1000)
              throw fail(409, "The screen check is too old. Nothing was done. Ask for a new request.");
          };
          check();
          if (batch) await progress(index, "executing");
          const payload = step.type === "scroll"
            ? { type: "scroll", delta: (step.direction === "up" ? 1 : -1) * step.amount }
            : step;
          await (overrides.browserInput || screenInput)(config, payload, check);
          if (batch) await progress(index, "executed");
        }
      } finally {
        inputInFlight = false;
        browserSnapshots.delete(request.id);
      }
    },
  });
  const snapshotSweep = setInterval(() => {
    const pending = new Set(browserApprovals.listOwner().map((r) => r.id));
    for (const id of browserSnapshots.keys()) if (!pending.has(id)) browserSnapshots.delete(id);
  }, 5000);
  snapshotSweep.unref();
  let network = { connected: false, peers: [] };
  let networkAt = 0;
  const getNetwork = async () => {
    if (Date.now() - networkAt > 15000) {
      networkAt = Date.now();
      network = await tailscaleInfo();
    }
    return network;
  };
  const validHost = (req) => {
    const authority = req.headers.host;
    if (!authority || !/^[a-zA-Z0-9.:[\]-]+$/.test(authority)) return false;
    try {
      const host = new URL(`http://${authority}`).hostname;
      const configured = config.publicOrigin
        ? new URL(config.publicOrigin).hostname
        : "";
      return ["localhost", "127.0.0.1", "[::1]", configured]
        .filter(Boolean)
        .includes(host);
    } catch {
      return false;
    }
  };
  const acceptedOrigin = (req) =>
    validOrigin(req.headers.origin, [
      config.publicOrigin,
      `http://127.0.0.1:${server.address()?.port}`,
      `http://localhost:${server.address()?.port}`,
      ...(config.allowedOrigins || []),
    ]);
  const mayAccess = (client, resource) =>
    (client.scopes.includes("admin") || resource.clientId === client.id) &&
    (!client.agentRoots ||
      !resource.cwd ||
      client.agentRoots.some((root) => within(root, resource.cwd)));
  const requireOwner = (client, resource) => {
    if (!mayAccess(client, resource))
      throw fail(403, "This session belongs to another client.");
    if (
      client.agentRoots &&
      resource.cwd &&
      !client.agentRoots.some((root) => within(root, resource.cwd))
    )
      throw fail(
        403,
        "This session's folder is no longer allowed by the agent policy.",
      );
    return resource;
  };
  app.disable("x-powered-by");
  // A tailnet device may open the same invitation address. The same signed
  // gateway contract applies there too, before the ordinary private API.
  app.use((req, res, next) => publicAgent(req, res) || next());
  app.use((req, res, next) => {
    if (req.headers["tailscale-funnel-request"] !== undefined && !funnelRequests.has(req))
      return res
        .status(403)
        .json({ error: "Public Funnel access is disabled." });
    if (!validHost(req))
      return res.status(403).json({ error: "Unrecognized host." });
    const origin = req.headers.origin;
    if (!acceptedOrigin(req))
      return res
        .status(403)
        .json({ error: "This browser origin is not authorized." });
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Authorization, Content-Type, Range, If-Range",
      );
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, OPTIONS",
      );
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    if (req.path.startsWith("/api")) res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  const parseJSON = express.json({ limit: "256kb" });
  app.use((req, res, next) => funnelRequests.has(req) ? next() : parseJSON(req, res, next));
  app.use("/api", compressJson());
  app.use((req, res, next) => {
    if (!transportAvailable)
      return res.status(503).json({
        error:
          "Private connection is recovering. Reach will reconnect automatically.",
      });
    next();
  });
  app.get("/api/health", (req, res) =>
    res.json({ product: "Reach", version: "0.1.0", instance }),
  );
  app.get("/api/auth/method", (req, res) =>
    res.json({
      method: config.tailscaleOwner ? "tailscale" : "pairing",
      eligible: config.tailscaleOwner
        ? ownerIdentity(req.reachIdentity, config.tailscaleOwner)
        : false,
      ...(ownerIdentity(req.reachIdentity, config.tailscaleOwner)
        ? { login: req.reachIdentity.login }
        : {}),
      // A browser that signed in with Face ID here before: it signs in the
      // same way again (src/ConnectForm.tsx), never with a request.
      ...(faceJoin?.available() && faceJoin.ownDevice(req.reachIdentity)
        ? { faceJoin: true }
        : {}),
    }),
  );
  app.use("/api", (req, res, next) => {
    if (config.tailscaleOwner && !funnelRequests.has(req) && (!trustedRequest(req) || !req.reachIdentity))
      return res.status(403).json({
        error:
          "Connect through this computer's private Tailscale link. Localhost cannot authenticate a Tailscale device.",
      });
    const cleanup = trackIdentity(req, () => res.destroy());
    res.once("close", cleanup);
    res.once("finish", cleanup);
    next();
  });
  app.use("/api", async (req, res, next) => {
    if (browserHostGuard.isActive()) {
      await browserHostGuard.refresh();
      const token = req.headers.authorization?.replace(/^Bearer /, "");
      const context = funnelRequests.get(req);
      const client = context ? context.token === token && auth.verifyFunnel(token, context.keyThumbprint) : auth.verify(token, req.reachIdentity);
      if (!auth.isBrowserAppAdmission(req)) browserHostGuard.assertRequest(req, client);
    }
    next();
  });
  // Browser credentials cannot use public admission routes to request another
  // identity or grant. Apply their allowlist before those handlers, too.
  app.use("/api", (req, res, next) => {
    const client = verify(req, req.headers.authorization?.replace(/^Bearer /, ""));
    if (client?.policy?.browser && !browserRouteAllowed(client, req.method, req.path))
      return res.status(403).json({ error: "This browser invitation cannot grant or request other access." });
    next();
  });
  app.post("/api/auth/requests", (req, res) => {
    if (!approvals)
      throw fail(
        404,
        "Run ./reach configure on the computer to enable device approval.",
      );
    const created = approvals.request(
      req.reachIdentity,
      req.body.name,
      config.tailscaleOwner,
    );
    // Another browser on a device you approved already (it shares that
    // device's Tailscale connection): the same device, approved.
    const known = auth
      .list()
      .some(
        (c) =>
          c.kind === "device" &&
          c.tailscale?.userId === req.reachIdentity.userId &&
          c.tailscale?.nodeId === req.reachIdentity.nodeId &&
          c.expiresAt > Date.now(),
      );
    if (known)
      try {
        approvals.decide(created.id, "approve", "this same device");
      } catch {}
    // Already approved on a linked computer: approve here too.
    else
      void fleet?.approvedElsewhere(req.reachIdentity).then((from) => {
        if (!from) return;
        try {
          approvals.decide(created.id, "approve", from);
        } catch {}
      });
    res
      .status(202)
      .json({ ...created, ...(passkeys?.has() ? { passkey: true } : {}) });
  });
  app.post("/api/auth/requests/:id", (req, res) => {
    if (!approvals) throw fail(404, "Device approval is not configured.");
    const result = approvals.poll(
      req.params.id,
      req.body?.secret,
      req.reachIdentity,
      config.tailscaleOwner,
      auth,
    );
    res.json({
      ...result,
      ...(result.token
        ? {
            device: {
              ...device,
              name: config.name,
              platform: process.platform,
            },
          }
        : {}),
    });
  });
  // Face ID for a request of yours, from the browser that made it (its secret,
  // on the same Tailscale device), with a passkey added from a device this
  // computer approved before. It approves the request; the poll above then
  // issues the credential exactly as approving here does.
  const passkeyRequest = (req) => {
    if (!passkeys) throw fail(404, "Face ID isn't available on this computer.");
    approvals.pending(
      req.params.id,
      req.body?.secret,
      req.reachIdentity,
      config.tailscaleOwner,
    );
    return `${req.params.id}:${req.reachIdentity.nodeId}`;
  };
  app.post("/api/auth/requests/:id/passkey/options", (req, res) => {
    const binding = passkeyRequest(req);
    res.json(passkeys.assertionOptions(binding));
  });
  app.post("/api/auth/requests/:id/passkey", (req, res) => {
    const binding = passkeyRequest(req);
    const used = passkeys.verifyAssertion(binding, req.body?.credential);
    try {
      approvals.decide(req.params.id, "approve", "your phone, with Face ID");
    } catch {
      // Decided at the same moment (the code typed at the computer): the
      // browser's usual poll reports what was decided.
    }
    record(
      "security",
      `A new browser was approved with Face ID (${used.label})`,
    );
    res.json({ approved: true });
  });
  // Adding, listing and removing Face ID: only from your own approved device.
  const ownDevice = (req) => {
    const client = verify(
      req,
      req.headers.authorization?.replace(/^Bearer /, ""),
    );
    if (
      !passkeys ||
      !client ||
      client.kind !== "device" ||
      !client.scopes.includes("admin") ||
      !ownerIdentity(req.reachIdentity, config.tailscaleOwner)
    )
      throw fail(403, "Only your own approved devices can manage Face ID.");
    return client;
  };
  app.get("/api/auth/passkeys", (req, res) => {
    ownDevice(req);
    res.json({ passkeys: passkeys.list() });
  });
  app.post("/api/auth/passkeys/options", (req, res) => {
    const client = ownDevice(req);
    res.json(
      passkeys.registrationOptions(
        client.id,
        req.reachIdentity.login || config.tailscaleOwner.login,
      ),
    );
  });
  app.post("/api/auth/passkeys", (req, res) => {
    const client = ownDevice(req);
    const added = passkeys.register(
      client.id,
      req.body?.credential,
      req.body?.label,
    );
    record("security", `Face ID added (${added.label})`);
    res.status(201).json(added);
  });
  app.delete("/api/auth/passkeys/:id", (req, res) => {
    ownDevice(req);
    passkeys.remove(req.params.id);
    // Also end the browsers that this passkey admitted. Old Face ID devices
    // without provenance are revoked conservatively during this migration.
    for (const client of auth.list())
      if (client.tailscale?.faceJoin &&
          (!client.tailscale.passkeyId || client.tailscale.passkeyId === req.params.id))
        endClient(client.id);
    if (guestKeys?.configured()) void tidyFace();
    record("security", "Face ID removed");
    res.json({ ok: true });
  });
  // Face ID sign-in, second half (server/face-join.mjs): the browser that
  // joined with this computer's one-time key shows its ticket from that
  // tagged device, and becomes one of your devices here, bound to it. The
  // only place such a credential is made (server/core.mjs, faceJoined).
  app.post("/api/auth/face-join", (req, res) => {
    if (!faceJoin)
      throw fail(404, "Face ID sign-in isn't available on this computer.");
    const identity = req.reachIdentity;
    const admission = faceJoin.redeem(identity, req.body?.ticket);
    const asked = req.body?.name;
    const name =
      typeof asked === "string" && asked.trim() && !/[\x00-\x1f\x7f]/.test(asked)
        ? asked.trim().slice(0, 80)
        : "Browser";
    const issued = auth.issue(name, ALL_SCOPES, "device", {
      tailscale: {
        userId: "",
        nodeId: identity.nodeId,
        tagged: true,
        faceJoin: true,
        passkeyId: admission.passkeyId,
      },
      nodeName: identity.nodeName,
    });
    record("security", `${name}: a new browser signed in with Face ID`);
    res.json({
      status: "approved",
      token: issued.token,
      device: { ...device, name: config.name, platform: process.platform },
    });
  });
  // An invitation (a guest's or an agent's), used once.
  const invitationDevice = () => ({
    id: device.id,
    computerId: device.computerId,
    name: config.name,
    platform: process.platform,
  });
  app.post(["/api/guest/redeem", "/api/invitations/redeem"], (req, res) => {
    const joined = auth.redeemGuest(req.body.invitation, req.reachIdentity);
    if (joined.status === "pending") {
      record("agent", "An invited agent is waiting for connection approval");
      notify({ category: "access", ...notificationPush(admissionNotification(auth.listAgentAdmissions().find((item) => item.requestId === joined.requestId) || { requestId: joined.requestId })), tag: `agent-admission-${joined.requestId}` });
      for (const nudge of presenceNudges) nudge();
    }
    res.status(joined.status === "pending" ? 202 : 200).json({
      ...joined,
      device: invitationDevice(),
    });
  });
  // A waiting receipt can only collect its own decision. It is not a Reach
  // credential and cannot read files, terminals, screens, or other requests.
  app.post("/api/invitations/claims/:requestId/status", (req, res) => {
    if (Object.keys(req.body || {}).some((key) => key !== "secret"))
      throw fail(400, "Send only this connection's receipt secret.");
    const result = auth.pollAgentAdmission(req.params.requestId, req.body?.secret, req.reachIdentity);
    res.json({ ...result, device: invitationDevice() });
  });
  app.post("/api/pair", (req, res) =>
    res.json({
      ...auth.pair(
        req.body.code,
        req.body.name,
        req.reachIdentity?.nodeId || req.socket.remoteAddress,
        req.reachIdentity,
      ),
      device: {
        id: device.id,
        computerId: device.computerId,
        name: config.name,
        platform: process.platform,
      },
    }),
  );
  const accessRequests = new Map();
  const requestAttempts = new Map();
  const pendingRequests = () => {
    const now = Date.now();
    for (const [key, r] of accessRequests)
      if (r.expiresAt < now) accessRequests.delete(key);
    return [...accessRequests.values()];
  };
  app.post("/api/agents/requests", (req, res) => {
    if (fs.existsSync(config.agentPolicyFile))
      throw fail(
        403,
        "This Mac uses agent profiles. Ask its owner for a scoped CLI credential.",
      );
    const address = req.socket.remoteAddress;
    const now = Date.now();
    const recent = (requestAttempts.get(address) || []).filter(
      (t) => t > now - 60000,
    );
    if (recent.length >= 5)
      throw fail(429, "Too many access requests. Try again in one minute.");
    requestAttempts.set(address, [...recent, now]);
    if (pendingRequests().length >= 20)
      throw fail(429, "Too many pending requests. Review them in Reach first.");
    const name = String(req.body.name || "")
      .trim()
      .slice(0, 80);
    const scopes = req.body.scopes;
    if (!name) throw fail(400, "Give this agent a name.");
    if (
      !Array.isArray(scopes) ||
      !scopes.length ||
      scopes.some((s) => !AGENT_SCOPES.includes(s))
    )
      throw fail(400, `Choose scopes from: ${AGENT_SCOPES.join(", ")}.`);
    const secret = crypto.randomBytes(24).toString("base64url");
    const request = {
      id: id(),
      name,
      scopes: [...new Set(scopes)],
      secretHash: hash(secret),
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: now + 10 * 60000,
    };
    accessRequests.set(request.id, request);
    record("agent", `${name} asked for access`);
    notify({ category: "access", title: `${pushLine(name, 48)} · Access request`, body: "Review the requested permissions before allowing access.", icon: "agent", tag: `agent-request-${request.id}`, url: `/?page=overview&needs=${encodeURIComponent(`device:${request.id}`)}`, actions: [{ action: "open", title: "Review access" }] });
    res.status(202).json({
      id: request.id,
      secret,
      expiresAt: new Date(request.expiresAt).toISOString(),
    });
  });
  app.get("/api/agents/requests/:id/status", (req, res) => {
    pendingRequests();
    const r = accessRequests.get(req.params.id);
    if (
      !r ||
      r.secretHash !== hash(String(req.headers["x-request-secret"] || ""))
    )
      throw fail(404, "This request expired or does not exist.");
    if (r.status === "approved") {
      // The token is delivered exactly once.
      accessRequests.delete(r.id);
      return res.json({ status: "approved", token: r.token, scopes: r.scopes });
    }
    if (r.status === "denied") accessRequests.delete(r.id);
    res.json({ status: r.status });
  });
  // Would this computer let the asking device in by itself (approved here
  // already, or on a linked computer)? A phone joining your linked computers
  // asks first, so it never leaves a request waiting in a terminal.
  app.get("/api/auth/vouched", async (req, res) => {
    const id = req.reachIdentity;
    if (!ownerIdentity(id, config.tailscaleOwner))
      return res.json({ approved: false });
    const here = auth
      .list()
      .some(
        (c) =>
          c.kind === "device" &&
          c.tailscale?.userId === id.userId &&
          c.tailscale?.nodeId === id.nodeId &&
          c.expiresAt > Date.now(),
      );
    res.json({ approved: here || !!(await fleet?.approvedElsewhere(id)) });
  });
  // Asked by linked computers, identified by Tailscale alone.
  app.post("/api/fleet/approved", (req, res) => {
    if (!fleet) throw fail(404, "This action does not exist.");
    res.json(fleet.approvedQuery(req.reachIdentity, req.body));
  });
  // A linked computer revoked one of your devices: revoke it here too.
  app.post("/api/fleet/revoked", (req, res) => {
    if (!fleet) throw fail(404, "This action does not exist.");
    const { userId, nodeId } = fleet.revokedQuery(req.reachIdentity, req.body);
    const ended = auth
      .list()
      .filter(
        (c) =>
          c.kind === "device" &&
          c.tailscale?.userId === userId &&
          c.tailscale?.nodeId === nodeId,
      );
    for (const c of ended) endClient(c.id);
    res.json({ revoked: ended.length });
  });
  // The owner's other Reach computers, for the phone's computer switcher.
  app.get("/api/fleet/computers", async (req, res, next) => {
    const client = verify(
      req,
      req.headers.authorization?.replace(/^Bearer /, ""),
    );
    if (!client)
      return res.status(401).json({ error: "Access expired or was revoked." });
    // Your computers: you only, never an invited guest.
    if (!client.scopes.includes("admin") || client.kind === "guest")
      return res
        .status(403)
        .json({ error: "This credential does not grant admin access." });
    try {
      res.json({
        computers: fleet ? await fleet.discover() : [],
        self: config.name,
      });
    } catch (error) {
      next(error);
    }
  });
  app.use("/api", (req, res, next) => {
    const client = verify(
      req,
      req.headers.authorization?.replace(/^Bearer /, ""),
    );
    if (!client)
      return res.status(401).json({
        error:
          "Access expired or was revoked. Ask the laptop owner for a new invitation, or pair your own device again.",
      });
    const route = req.path.split("/")[1].toLowerCase();
    const scope = ["/browser/agents", "/browser/agents/stop", "/browser/agents/pause", "/browser/agents/reopen"].includes(req.path) ? "admin" : {
      files: "files",
      terminals: "terminal",
      apps: "apps",
      screen: "screen",
      chats: "codex",
      codex: "codex",
      clients: "admin",
      guests: "admin",
      jobs: "exec",
      activity: "admin",
      settings: "admin",
      agents: "admin",
      // Transcripts of every AI session: the owner only.
      sessions: "admin",
      // An agent's own apps on hidden displays; what it hands you.
      drive: "apps:drive",
      handoffs: "admin",
      // Notifications on this device's browser.
      push: "admin",
      notifications: "admin",
      browser: "browser:read",
    }[route];
    // An invitation that may watch chosen apps' windows reaches only those
    // routes: the app list and the app windows themselves (no quit, no typing).
    // (The path is read here: later checks run after Express restores /api.)
    const subpath = req.path;
    const appWindows = (identity) =>
      identity.scopes?.includes("apps:open") &&
      ((route === "screen" &&
        /^\/screen\/apps(\/[^/]+(\/activate)?)?$/.test(subpath) &&
        ["GET", "POST", "PATCH", "DELETE"].includes(req.method)) ||
        (route === "apps" &&
          ((req.method === "GET" && subpath === "/apps") ||
            (req.method === "POST" && subpath === "/apps/icons"))));
    const allowed = (identity) =>
      identity?.policy?.browser
        ? browserRouteAllowed(identity, req.method, subpath)
        : identity &&
      !(
        identity.kind === "guest" && GUEST_BLOCKED_ROUTES.includes(route)
      ) &&
      // Every AI session and the Mac's own dialogs: the owner's own devices
      // only. A list of who may, not of who may not: no other credential,
      // whatever it grants (or a kind added later), ever reaches them.
      (!["sessions", "push", "notifications"].includes(route) || identity.kind === "device") &&
      (route === "device" ||
        appWindows(identity) ||
        (scope &&
          (identity.scopes?.includes(scope) ||
            (route === "files" &&
              identity.scopes?.includes(
                ["GET", "HEAD"].includes(req.method)
                  ? "files:read"
                  : "files:write",
              )))));
    if (!allowed(client))
      return res.status(403).json({
        error: scope
          ? `This credential does not grant ${scope} access.`
          : "This action is not available.",
      });
    req.client = client;
    const credential = req.headers.authorization?.replace(/^Bearer /, "");
    req.reauthorize = () => {
      const current = verify(req, credential);
      if (!allowed(current) || res.destroyed)
        throw fail(401, "Access expired or was revoked.");
      req.client = current;
      return current;
    };
    if (client.policy?.browser && (req.path.startsWith("/files") ||
        req.path.startsWith("/browser/files/") || req.path === "/browser/apps/screen")) {
      const active = browserResponses.get(client.id) || 0;
      if (browserResponseCount >= 8 || active >= 2)
        return res.status(429).json({ error: "Finish the current file or image requests before starting another." });
      browserResponses.set(client.id, active + 1); browserResponseCount++;
      let released = false;
      const limit = setTimeout(() => { res.destroy(); req.destroy(); }, 30000);
      limit.unref();
      const release = () => {
        if (released) return;
        released = true; clearTimeout(limit); browserResponseCount--;
        const remaining = (browserResponses.get(client.id) || 1) - 1;
        if (remaining) browserResponses.set(client.id, remaining); else browserResponses.delete(client.id);
      };
      res.once("finish", release); res.once("close", release);
    }
    // Abort in-flight HTTP bodies and downloads, not only subsequent requests.
    const disconnect = () => {
      res.destroy();
      req.destroy();
    };
    const deadline = setTimeout(
      () => {
        if (!allowed(verify(req, credential))) disconnect();
      },
      Math.min(2147483647, Math.max(0, client.expiresAt - Date.now())),
    );
    const check = setInterval(() => {
      if (!allowed(verify(req, credential))) disconnect();
    }, 1000);
    deadline.unref();
    check.unref();
    const cleanup = () => {
      clearTimeout(deadline);
      clearInterval(check);
    };
    res.once("close", cleanup);
    res.once("finish", cleanup);
    const json = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode < 400 && !allowed(verify(req, credential)))
        res.status(401);
      if (res.statusCode === 401)
        return json({
          error: "Access expired or was revoked.",
        });
      return json(body);
    };
    next();
  });
  app.get("/api/device", async (req, res) => {
    const tools = req.client.scopes.includes("codex")
      ? await detectTools()
      : undefined;
    res.json({
      ...device,
      name: config.name,
      platform: process.platform,
      release: os.release(),
      arch: os.arch(),
      roots: (req.client.agentRoots || config.roots).map((p, index) => ({
        id: index,
        name: fileRootName(p),
        path: p,
      })),
      memory: { total: os.totalmem(), free: await availableMemory() },
      uptime: os.uptime(),
      network: ["agent", "guest"].includes(req.client.kind)
        ? { connected: !!config.publicOrigin, peers: [] }
        : await getNetwork(),
      access: {
        kind: req.client.kind,
        scopes: req.client.scopes,
        expiresAt: req.client.expiresAt,
        profile: req.client.policy?.profile,
        ...(req.client.policy?.browser && { browser: true }),
      },
      capabilities: deviceCapabilities({
        platform: process.platform,
        scopes: req.client.scopes,
        screen: config.screen,
        codexInstalled: tools?.codex.installed,
      }),
      ...(tools && { tools }),
      host: loadJson(hostFile, null),
      ...(paused && { paused: true }),
    });
  });
  app.delete("/api/device/access", (req, res) => {
    auth.revoke(req.client.id);
    browserApprovals.cancelClient(req.client.id);
    browserAppAccess.cancelClient(req.client.id);
    browserOperations.cancelClient(req.client.id);
    browserScreenSnapshots.stop();
    res.type("json").send(JSON.stringify({ ok: true }));
  });
  app.get("/api/settings", (req, res) => res.json(settings));
  app.post("/api/settings/pause", async (req, res) => {
    if (typeof req.body.paused !== "boolean")
      throw fail(400, "Send paused as true or false.");
    res.json(await setPaused(req.body.paused));
  });
  app.post("/api/settings", (req, res) => {
    if (typeof req.body.screen !== "boolean")
      throw fail(400, "Send screen as true or false.");
    settings.screen = config.screen = req.body.screen;
    if (!config.screen) {
      browserApprovals.cancelPending();
        browserAppAccess.clear();
      browserSnapshots.clear();
      screenControl.clear();
      screenStreams.stop();
      browserScreenSnapshots.stop();
      remoteScreens.stop();
      appScreens.stop();
      void appThreads.closeAll();
      closeInput();
    }
    atomicJson(settingsFile, settings);
    record(
      "settings",
      `Screen access turned ${settings.screen ? "on" : "off"}`,
    );
    res.json(settings);
  });
  app.get("/api/agents/requests", (req, res) =>
    res.json(
      pendingRequests()
        .filter((r) => r.status === "pending")
        .map(({ secretHash, token, ...r }) => r),
    ),
  );
  app.post("/api/agents/requests/:id", (req, res) => {
    const r = pendingRequests().find(
      (x) => x.id === req.params.id && x.status === "pending",
    );
    if (!r) throw fail(404, "This request expired or was already answered.");
    if (!["approve", "deny"].includes(req.body.decision))
      throw fail(400, "Choose approve or deny.");
    if (req.body.decision === "approve") {
      r.token = auth.issue(r.name, r.scopes, "agent").token;
      r.status = "approved";
      record("agent", `Authorized ${r.name}`);
    } else {
      r.status = "denied";
      record("agent", `Denied ${r.name}`);
    }
    res.json({ status: r.status });
  });
  app.get("/api/activity", (req, res) => res.json(events));
  // Invite keys: whether they're set up here, and the policy lines for this
  // tailnet (this computer and the linked ones, on Reach's port).
  const readStatus =
    overrides.tailscaleStatus || (() => tailscaleJson(["status", "--json"]));
  app.get("/api/guests/keys", async (req, res) => {
    let policy = null;
    try {
      const st = await readStatus();
      const peers = Object.values(st?.Peer || {});
      const v4 = (n) => n?.TailscaleIPs?.find((ip) => ip.includes("."));
      const addresses = [
        v4(st?.Self),
        ...(fleet?.links() || []).map((l) =>
          v4(peers.find((p) => p.ID === l.nodeId)),
        ),
      ].filter(Boolean);
      if (addresses.length)
        policy = guestPolicy({
          addresses,
          port: Number(new URL(config.publicOrigin).port || 443),
        });
    } catch {}
    res.json({ configured: !!guestKeys?.configured(), policy });
  });
  // One-time setup from your phone: the credential is checked with Tailscale
  // and kept on this computer only; it's never sent back.
  app.post("/api/guests/keys", async (req, res) => {
    if (!guestKeys)
      throw fail(404, "Invite links need Tailscale device approval here.");
    // The easy way: one access token (used once, never kept). Reach adds its
    // rules to the tailnet policy and makes its own limited key.
    if (req.body?.accessToken) {
      const st = await readStatus();
      const peers = Object.values(st?.Peer || {});
      const v4 = (n) => n?.TailscaleIPs?.find((ip) => ip.includes("."));
      const result = await guestKeys.setupFromAccessToken({
        accessToken: req.body.accessToken,
        addresses: [
          v4(st?.Self),
          ...(fleet?.links() || []).map((l) =>
            v4(peers.find((p) => p.ID === l.nodeId)),
          ),
        ].filter(Boolean),
        port: Number(new URL(config.publicOrigin).port || 443),
      });
      return res.json({
        configured: true,
        added: result.added,
        allowAll: result.allowAll.length > 0,
      });
    }
    await guestKeys.setup({
      clientId: req.body?.clientId,
      clientSecret: req.body?.clientSecret,
    });
    res.json({ configured: true });
  });
  // An invite key for one invitation, whichever computers it covers: made by
  // the computer holding the OAuth client. `clientIds`: its invitations here
  // (revoking one of them ends the key and the guest's device).
  app.post("/api/guests/key", async (req, res) => {
    if (!guestKeys?.configured())
      throw fail(
        409,
        "Set up invite keys first: run ./reach invites on this computer.",
      );
    const ttl = req.body?.ttlSeconds;
    if (!Number.isInteger(ttl) || ttl < 60 || ttl > 90 * 86400)
      throw fail(400, "Choose a duration from 1 minute to 90 days.");
    // An agent's key only needs to live until it joins.
    const keySeconds = req.body?.keySeconds;
    if (
      keySeconds !== undefined &&
      (!Number.isInteger(keySeconds) || keySeconds < 60 || keySeconds > ttl)
    )
      throw fail(400, "Invalid key lifetime.");
    const guests = new Set(
      auth
        .list()
        .filter((c) => c.kind === "guest" || c.policy?.invite)
        .map((c) => c.id),
    );
    const key = await guestKeys.createInvite({
      ttlSeconds: ttl,
      keySeconds,
      clientIds: (Array.isArray(req.body.clientIds) ? req.body.clientIds : [])
        .filter((id) => typeof id === "string" && guests.has(id))
        .slice(0, 10),
    });
    res.status(201).json({ key: key.key, hostname: key.hostname });
  });
  // Invite an agent: its folders and access, one-time join (see inviteAgent).
  const admissionOwner = (req) => {
    const client = req.reauthorize();
    if (client.kind !== "device" || !client.scopes.includes("admin"))
      throw fail(403, "Only an owner device can approve an invited agent's connection.");
    return client;
  };
  app.get("/api/agents/admissions", (req, res) => {
    admissionOwner(req);
    res.json(auth.listAgentAdmissions());
  });
  app.post("/api/agents/admissions/:requestId", (req, res) => {
    admissionOwner(req);
    if (Object.keys(req.body || {}).some((key) => key !== "decision"))
      throw fail(400, "Approve or deny the exact connection shown.");
    const result = auth.decideAgentAdmission(req.params.requestId, req.body?.decision);
    record("agent", req.body.decision === "approve"
      ? "Approved an invited agent's connection" : "Denied an invited agent's connection");
    for (const nudge of presenceNudges) nudge();
    res.json(result);
  });
  app.post("/api/agents/invitations", (req, res) => {
    if (req.client.kind === "guest")
      throw fail(403, "Only the computer's owner can invite agents.");
    const grant = auth.inviteAgent(req.body || {});
    record("agent", `Invited agent ${req.body.name}`);
    res.status(201).json(grant);
  });
  app.post("/api/guests", async (req, res) => {
    const grant = auth.inviteGuest(req.body);
    // With an invite key, the guest needs no Tailscale account or app.
    let key;
    if (req.body.key === true) {
      try {
        if (!guestKeys?.configured())
          throw fail(
            409,
            "Set up invite keys first: run ./reach invites on this computer.",
          );
        key = await guestKeys.createInvite({
          ttlSeconds: req.body.ttlSeconds,
          clientIds: [grant.clientId],
        });
      } catch (error) {
        auth.revoke(grant.clientId);
        throw error;
      }
    }
    record(
      "guest",
      `Invited ${req.body.name} until ${new Date(grant.expiresAt).toISOString()}`,
    );
    const url = new URL(
      "/guest",
      config.publicOrigin || `http://${req.headers.host}`,
    );
    url.hash = new URLSearchParams({ invite: grant.invitation }).toString();
    res.status(201).json({
      ...grant,
      url: url.toString(),
      ...(key ? { key: key.key, hostname: key.hostname } : {}),
    });
  });
  // Change what someone you invited may use, without a new link (core.mjs,
  // changeAccess). Every request checks the new access; what they lose ends
  // at once: screen control comes back to you, and their open screens and
  // terminals start over under the new access.
  app.post("/api/guests/:id/access", async (req, res) => {
    const id = req.params.id;
    const existing = auth.list().find((client) => client.id === id);
    if (existing?.policy?.browser && req.body?.screen && req.body.screen !== "off" &&
        req.body.screen !== existing.policy.screen && !browserScreenAvailable())
      throw fail(403, "Turn on screen viewing in Reach before sharing it.");
    if (existing?.policy?.browser && Array.isArray(req.body?.terminalIds)) {
      const selected = req.body.terminalIds;
      const available = terminals.list().map((terminal) => `reach:${terminal.id}`);
      if (selected.some((id) => typeof id === "string" && id.startsWith("desktop:")) && desktopTerminals.platform === "darwin") {
        const result = await desktopTerminals.list(() => req.reauthorize());
        available.push(...result.sessions.filter((t) => t.provider === "iterm2").map((t) => `desktop:${t.id}`));
      }
      if (selected.some((id) => !available.includes(id)))
        throw fail(400, "A selected terminal is no longer available. Choose again.");
    }
    req.reauthorize();
    const previousClient = auth.list().find((entry) => entry.id === id);
    if (req.body?.screen === "apps" || previousClient?.policy?.screen === "apps")
      throw fail(409, "Use app requests to grant additional apps. End this invitation and create a new one to change its base access.");
    // A preset agent: the screen presets need this Mac's screen helpers, and
    // chosen or hidden apps are matched to the Mac's catalog first.
    if (previousClient?.policy?.preset !== undefined && req.body && typeof req.body === "object") {
      const preset = req.body.preset ?? previousClient.policy.preset;
      if (["full", "apps", "readonly"].includes(preset) && !agentDesktop?.available?.())
        throw fail(503, "Screen access for agents needs this Mac's Screen Recording and Accessibility permissions.");
      const chosen = Array.isArray(req.body.apps) && req.body.apps.length, hidden = Array.isArray(req.body.hidden) && req.body.hidden.length;
      if (chosen || hidden) {
        if (!agentDesktop) throw fail(503, "The app list is unavailable on this computer.");
        const catalog = await agentDesktop.catalog(() => req.reauthorize());
        if (chosen) req.body.apps = presetAppsFromCatalog(catalog, req.body.apps);
        if (hidden) req.body.hidden = presetAppsFromCatalog(catalog, req.body.hidden, { allowProtected: true });
      }
      req.reauthorize();
    }
    const { client, before, after } = auth.changeAccess(id, req.body || {});
    agentDesktop?.cancelClient?.(id);
    browserApprovals.cancelClient(id);
    browserAppAccess.cancelClient(id);
    browserOperations.cancelClient(id);
    const lost = before.scopes.filter((s) => !after.scopes.includes(s));
    const narrower =
      lost.length > 0 ||
      before.roots.some((r) => !after.roots.includes(r)) ||
      (after.scopes.includes("apps:open") &&
        Array.isArray(after.apps) &&
        (!before.apps || before.apps.some((a) => !after.apps.includes(a))));
    if (lost.includes("screen") || lost.includes("screen:control")) {
      screenControl.revoke(id);
      closeInput(id);
    }
    if (narrower)
      for (const ws of wss.clients)
        if (ws.clientId === id && ws.reachChannel) // not presence
          ws.close(4002, "Access changed");
    // Commands they were running stop too, when running commands, or the
    // folder one runs in, is taken away.
    for (const job of jobs.list())
      if (
        job.clientId === id &&
        job.status === "running" &&
        (lost.includes("exec") ||
          !after.roots.some((root) => within(root, job.cwd)))
      )
        jobs.cancel(job.id);
    // Their phone's live connection carries the change at once.
    for (const nudge of presenceNudges) nudge();
    record("guest", `Changed ${client.name}’s access`);
    res.json(client);
  });
  app.get("/api/clients", (req, res) =>
    res.json({ current: req.client.id, clients: auth.list() }),
  );
  // Ends a credential now: requests, sockets, screen control.
  // A session's work ends; its credential stays (Reopen link) or goes (revoke).
  const endSession = (id) => {
    browserApprovals.cancelClient(id);
    browserAppAccess.cancelClient(id);
    browserOperations.cancelClient(id);
    agentDesktop?.cancelClient(id);
    browserScreenSnapshots.stop();
    presence.removeClient(id);
    screenControl.revoke(id);
    closeInput(id);
    // An agent leaves: its apps go back to the Mac.
    void agentApps.release(id).catch(() => {});
    // A revoked phone gets no more notifications.
    push.forgetClient(id);
    for (const ws of wss.clients)
      if (ws.clientId === id) ws.close(4001, "Access revoked");
  };
  const endClient = (id) => {
    auth.revoke(id);
    endSession(id);
  };
  browserAgentRoutes(app, {
    auth, approvals: browserApprovals, appAccess: browserAppAccess, coordinator: browserOperations, endClient, endSession, desktop: agentDesktop,
    onStopped: (id) => {
      void guestKeys?.revokeClient(id).catch((e) => console.log(`Reach: ${e.message}`));
      record("agent", "Stopped a browser agent session");
    },
  });
  app.delete("/api/clients/:id", (req, res) => {
    const client = auth.list().find((c) => c.id === req.params.id);
    endClient(req.params.id);
    // A guest who came with an invite key leaves your tailnet too, and so
    // does a browser that signed in with Face ID.
    void guestKeys
      ?.revokeClient(req.params.id)
      .catch((e) => console.log(`Reach: ${e.message}`));
    if (client?.tailscale?.faceJoin && guestKeys?.configured())
      void tidyFace();
    // Revoke once: your linked computers drop that device too.
    if (client?.kind === "device" && client.tailscale)
      void fleet?.revokeElsewhere(client.tailscale);
    res.type("json").send(JSON.stringify({ ok: true }));
  });
  // Same order as localeCompare, without building a collator per comparison.
  const names = new Intl.Collator();
  const privateRoots = () =>
    [config.dataDir, ...(config.privatePaths || [])].map((privatePath) =>
      fs.existsSync(privatePath)
        ? fs.realpathSync.native(privatePath)
        : path.resolve(privatePath),
    );
  const notPrivate = (target, privates = privateRoots()) => {
    if (
      privates.some(
        (absolute) =>
          target === absolute || target.startsWith(absolute + path.sep),
      )
    )
      throw fail(403, "Reach’s private companion data is not shared.");
    return target;
  };
  const resolve = (root, p, client, { allowMissing = false } = {}) => {
    const check = target => {
      notPrivate(target);
      if (client?.policy?.browser && isBrowserPrivatePath(target, browserPaths()))
        throw fail(403, "Reach, system credentials, and browser profiles are not shared with agents.");
      return target;
    };
    if (!allowMissing) return check(safePath(client?.agentRoots || config.roots, root, p));
    // Mutation destinations need the same root/private-data rules before the
    // final leaf exists. Resolve the parent, then authorize the complete path.
    if (typeof p !== "string" || !p || path.isAbsolute(p) || p.split(/[\\/]/).includes("..") || /[\0\\:]/.test(p))
      throw fail(403, "Stay inside the selected shared folder.");
    const parent = safePath(client?.agentRoots || config.roots, root, path.dirname(p));
    const target = check(path.join(parent, path.basename(p)));
    if (fs.existsSync(target)) return check(safePath(client?.agentRoots || config.roots, root, p));
    return target;
  };
  // Listings check thousands of entries: same rules, without blocking.
  const resolveAsync = async (root, p, client, privates) => {
    const target = notPrivate(await safePathAsync(client?.agentRoots || config.roots, root, p), privates);
    if (client?.policy?.browser && isBrowserPrivatePath(target, browserPaths()))
      throw fail(403, "Reach, system credentials, and browser profiles are not shared with agents.");
    return target;
  };
  const browserFiles = async (operation, rootIndex, relative, authorize, limits = {}) => {
    const client = authorize(), index = Number(rootIndex);
    if (!client?.policy?.browser || !Number.isSafeInteger(index) || index < 0 ||
        !client.agentRoots?.[index] || typeof relative !== "string")
      throw fail(400, "Choose a shared folder.");
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
      throw fail(403, "Stay inside the selected shared folder.");
    const root = client.agentRoots[index];
    if (validateBrowserRoot(root) !== root)
      throw fail(403, "The shared folder changed. Create a new invitation.");
    const scope = JSON.stringify([client.id, client.expiresAt, client.policy, client.agentRoots]);
    const check = () => {
      notPaused();
      const current = authorize();
      if (scope !== JSON.stringify([current.id, current.expiresAt, current.policy, current.agentRoots]))
        throw fail(403, "File access changed. Refresh the shared folder.");
      return current;
    };
    // Keep the original root and relative path; resolving a symbolic link here
    // would conceal it from the helper's descriptor-relative traversal.
    return browserFileOperation({ op: operation, root, path: relative,
      ...limits, privatePaths: browserPaths() }, check, { config });
  };
  browserAccessRoutes(app, {
    auth, config, terminals, desktopTerminals, resolve, resolveAsync, record, browserFiles,
    appAccess: browserAppAccess, appAccessAvailable: browserAppAvailable, hostGuard: browserHostGuard,
    desktop: agentDesktop, shell: agentShell,
    prepareFunnel: async () => {
      if (!prepareFunnel || paused || !transportAvailable)
        throw fail(503, "Temporary browser access is not available. Start Reach with its Tailscale connection and try again.");
      await prepareFunnel();
      return new URL(config.publicOrigin).origin.replace(/:\d+$/, "");
    },
    approvals: browserApprovals, commandLog: browserCommandLog, snapshots: browserSnapshots,
    screenAvailable: browserScreenAvailable,
    capture: browserCapture,
    viewCapture: browserViewCapture,
    scroll: async (payload, authorize) => {
      const check = () => browserInputCheck(authorize);
      check();
      if (inputInFlight) throw fail(409, "Wait for the previous screen action to finish.");
      inputInFlight = true;
      try { await (overrides.browserInput || screenInput)(config, payload, check); }
      finally { inputInFlight = false; }
    },
  });
  app.get("/api/files", async (req, res) => {
    if (req.client.policy?.browser) {
      const result = await browserFiles("list", req.query.root, req.query.path || "", req.reauthorize);
      const items = result.items.filter(e => req.query.hidden === "1" || !e.name.startsWith("."))
        .sort((a, b) => (a.type === b.type ? 0 : a.type === "directory" ? -1 : 1) || names.compare(a.name, b.name));
      req.reauthorize();
      return res.json({ items, path: req.query.path || "", truncated: result.truncated });
    }
    const dir = resolve(req.query.root, req.query.path || "", req.client);
    const info = await fsp.stat(dir);
    if (!info.isDirectory()) throw fail(400, "Choose a folder.");
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const showHidden = req.query.hidden === "1";
    const privates = privateRoots();
    const items = (
      await Promise.all(
        entries
          .filter((e) => showHidden || !e.name.startsWith("."))
          .slice(0, 2000)
          .map(async (e) => {
            try {
              const full = await resolveAsync(
                req.query.root,
                path.join(String(req.query.path || ""), e.name),
                req.client,
                privates,
              );
              const s = await fsp.stat(full);
              return {
                name: e.name,
                type: s.isDirectory() ? "directory" : "file",
                size: s.size,
                modified: s.mtime.toISOString(),
                path: path
                  .join(String(req.query.path || ""), e.name)
                  .split(path.sep)
                  .join("/"),
              };
            } catch {
              return null;
            }
          }),
      )
    )
      .filter(Boolean)
      .sort(
        (a, b) =>
          (a.type === b.type ? 0 : a.type === "directory" ? -1 : 1) ||
          names.compare(a.name, b.name),
      );
    res.json({
      items,
      path: req.query.path || "",
      truncated: entries.length > 2000,
    });
  });
  app.get("/api/files/content", async (req, res) => {
    if (req.client.policy?.browser) {
      const result = await browserFiles("read", req.query.root, req.query.path || "", req.reauthorize, { maxBytes: 25 * 1024 * 1024 });
      req.reauthorize();
      res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length");
      return res.attachment(path.basename(String(req.query.path))).type("application/octet-stream").send(result.data);
    }
    const file = resolve(req.query.root, req.query.path || "", req.client);
    const s = await fsp.stat(file);
    if (!s.isFile()) throw fail(400, "Choose a file.");
    const current = req.reauthorize();
    if (resolve(req.query.root, req.query.path || "", current) !== file)
      throw fail(403, "This file is no longer shared.");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Disposition, Content-Length, Content-Range, Accept-Ranges, ETag",
    );
    res.download(file, path.basename(file));
  });
  // A short-lived link to one file, for the browser's own download manager.
  app.get("/api/files/download-link", async (req, res) => {
    const file = resolve(req.query.root, req.query.path || "", req.client);
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw fail(400, "Choose a file.");
    const token = links.issue({
      digest: req.client.hash,
      root: req.query.root,
      path: req.query.path || "",
      mtimeMs: stat.mtimeMs,
    });
    res.json({ url: `/download/${token}`, expiresIn: 600 });
  });
  app.get("/api/files/text", async (req, res) => {
    if (req.client.policy?.browser) {
      const { data } = await browserFiles("read", req.query.root, req.query.path || "", req.reauthorize);
      if (data.includes(0)) throw fail(415, "Download this file to open it in a compatible app.");
      req.reauthorize();
      return res.json({ text: data.toString("utf8"), sha256: hash(data) });
    }
    const file = resolve(req.query.root, req.query.path || "", req.client);
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw fail(400, "Choose a file.");
    if (stat.size > 1024 * 1024)
      throw fail(
        413,
        "This file is too large to preview. Download it instead.",
      );
    const data = await fsp.readFile(file);
    if (data.includes(0))
      throw fail(415, "Download this file to open it in a compatible app.");
    res.json({ text: data.toString("utf8"), sha256: hash(data) });
  });
  // A Word/RTF/OpenDocument file's text. No sha256: it can't be written back.
  const documentText = overrides.documentText || readDocumentText;
  app.get("/api/files/document-text", async (req, res) => {
    // Native document converters receive rich untrusted files and may open
    // referenced resources. Agents can download bounded bytes to their own VM.
    if (req.client.policy?.browser) throw fail(415, "Download this document to read it in your own agent environment.");
    const file = resolve(req.query.root, req.query.path || "", req.client);
    if (!DOCUMENT_TEXT.test(file))
      throw fail(415, "Download this file to open it.");
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw fail(400, "Choose a file.");
    if (stat.size > 25 * 1024 * 1024)
      throw fail(
        413,
        "This document is too large to preview. Download it instead.",
      );
    res.json({ text: await documentText(file) });
  });
  // The platform's own icon for each file type, e.g. ?types=folder,pdf,docx.
  const fileIcon = createAppIconCache(overrides.fileIcons || readFileIcons);
  app.get("/api/files/icons", async (req, res) => {
    const types = [
      ...new Set(
        String(req.query.types || "")
          .split(",")
          .filter(Boolean),
      ),
    ];
    if (!types.length || types.length > 64 || !types.every(isIconType))
      throw fail(400, "Ask for up to 64 file types.");
    const found = await Promise.all(types.map(fileIcon));
    res
      .set("Cache-Control", "no-store")
      .json({ icons: Object.fromEntries(types.map((t, i) => [t, found[i]])) });
  });
  app.put("/api/files/text", (req, res) => {
    if (
      typeof req.body.text !== "string" ||
      Buffer.byteLength(req.body.text) > 128 * 1024 ||
      req.body.text.includes("\0") ||
      !/^[a-f0-9]{64}$/.test(req.body.sha256 || "")
    )
      throw fail(
        400,
        "Send text up to 128 KiB and the sha256 from the last read.",
      );
    const file = resolve(req.query.root, req.query.path || "", req.client);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw fail(400, "Choose a text file up to 1 MiB.");
    const previous = fs.readFileSync(file);
    if (previous.includes(0))
      throw fail(415, "Binary files cannot be edited as text.");
    if (hash(previous) !== req.body.sha256)
      throw fail(409, "This file changed. Read it again before writing.");
    const temporary = path.join(path.dirname(file), `.reach-edit-${id()}`);
    try {
      fs.writeFileSync(temporary, req.body.text, {
        flag: "wx",
        mode: stat.mode & 0o777,
      });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    record("file", `Updated ${path.basename(file)}`);
    res.json({ ok: true, sha256: hash(req.body.text) });
  });
  const uploads = path.join(config.dataDir, "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  const resumable = createUploads({
    dir: path.join(config.dataDir, "uploads-resumable"),
    ...(config.maxUploadBytes && { maxBytes: config.maxUploadBytes }),
    ...(overrides.freeSpace && { freeSpace: overrides.freeSpace }),
  });
  const links = createLinks();
  const upload = multer({
    dest: uploads,
    // Browsers send file names as UTF-8; multer's default (latin1) garbles
    // names like "Résumé.pdf" or emoji.
    defParamCharset: "utf8",
    limits: {
      fileSize: 100 * 1024 * 1024,
      files: 1,
      fields: 0,
      parts: 2,
      headerPairs: 32,
    },
  });
  app.post("/api/files/upload", upload.single("file"), async (req, res) => {
    if (!req.file) throw fail(400, "Choose a file to upload.");
    try {
      req.reauthorize();
      const dir = resolve(req.query.root, req.query.path || "", req.client);
      const name = req.file.originalname;
      if (!validLeafName(name))
        throw fail(
          400,
          "Choose a filename without special characters, reserved device names, or leading/trailing dots.",
        );
      const target = path.join(dir, name);
      // Async (and a copy-on-write clone where the disk supports it), so a
      // large upload never pauses the screen stream or terminals.
      await fsp.copyFile(
        req.file.path,
        target,
        fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
      );
      record("file", `Uploaded ${name}`);
      res.json({ name });
    } catch (e) {
      if (e.code === "EEXIST")
        throw fail(
          409,
          "A file with that name already exists. Rename it before uploading.",
        );
      throw e;
    } finally {
      await fsp.unlink(req.file.path).catch(() => {});
    }
  });
  // Resumable uploads (server/uploads.mjs): create, send chunks at offsets,
  // ask where to resume, complete. The one-request route above stays for
  // older apps and computers.
  const uploadFolder = (req, root, folder) => {
    const dir = resolve(root, folder || "", req.client);
    if (!fs.statSync(dir).isDirectory()) throw fail(400, "Choose a folder.");
    return dir;
  };
  const withOffset = (res, e) => {
    if (e.offset === undefined) throw e;
    res.status(e.status).json({ error: e.message, offset: e.offset });
  };
  app.post("/api/files/uploads", async (req, res) => {
    const { root, path: folder = "", name, size } = req.body || {};
    if (!validLeafName(name))
      throw fail(
        400,
        "Choose a filename without special characters, reserved device names, or leading/trailing dots.",
      );
    const dir = uploadFolder(req, root, folder);
    res.json(
      await resumable.create(req.client, {
        folder: dir,
        name,
        size,
        root,
        path: folder,
      }),
    );
  });
  app.get("/api/files/uploads/:id", (req, res) =>
    res.json(resumable.status(req.params.id, req.client)),
  );
  app.put("/api/files/uploads/:id", async (req, res) => {
    // Chunks are raw bytes; one that was parsed as JSON lost its contents.
    if (req.body !== undefined && Object.keys(req.body || {}).length)
      throw fail(415, "Send chunks as application/octet-stream.");
    const offset = Number(req.query.offset);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw fail(400, "Send the chunk's offset.");
    try {
      res.json(await resumable.write(req.params.id, req.client, offset, req));
    } catch (e) {
      // Don't keep reading an oversized body after answering.
      if (e.status === 413) res.setHeader("Connection", "close");
      withOffset(res, e);
    }
  });
  app.post("/api/files/uploads/:id/complete", async (req, res) => {
    resumable.status(req.params.id, req.client);
    const { root, path: folder } = resumable.get(req.params.id);
    try {
      const result = await resumable.complete(
        req.params.id,
        req.client,
        uploadFolder(req, root, folder),
      );
      record("file", `Uploaded ${result.name}`);
      res.json(result);
    } catch (e) {
      withOffset(res, e);
    }
  });
  app.delete("/api/files/uploads/:id", async (req, res) =>
    res.json(await resumable.cancel(req.params.id, req.client)),
  );
  app.post("/api/files/folder", async (req, res) => {
    const dir = resolve(req.body.root, req.body.path || "", req.client);
    const name = req.body.name;
    if (!validLeafName(name))
      throw fail(
        400,
        "Choose a folder name without special characters, reserved device names, or leading/trailing dots.",
      );
    await fsp.mkdir(path.join(dir, name));
    record("file", `Created folder ${name}`);
    res.json({ ok: true });
  });
  app.get("/api/jobs", (req, res) =>
    res.json(jobs.list().filter((j) => mayAccess(req.client, j))),
  );
  const ownJob = (req) => {
    const j = jobs.get(req.params.id);
    requireOwner(req.client, j);
    return j;
  };
  app.post("/api/jobs", (req, res) => {
    const cwd = resolve(req.body.root, req.body.path || "", req.client);
    if (!fs.statSync(cwd).isDirectory()) throw fail(400, "Choose a folder.");
    const timeoutMs =
      req.body.timeoutMs ?? Math.min(60000, req.client.maxJobMs || 3600000);
    if (req.client.maxJobMs && timeoutMs > req.client.maxJobMs)
      throw fail(403, "Job duration exceeds this agent profile limit.");
    const j = jobs.start({ ...req.body, cwd, timeoutMs }, req.client.id);
    record("job", "Agent ran a command");
    res.status(202).json(j);
  });
  app.get("/api/jobs/:id", (req, res) => res.json(ownJob(req)));
  app.delete("/api/jobs/:id", (req, res) => {
    ownJob(req);
    res.json(jobs.cancel(req.params.id));
  });
  // Existing desktop tabs belong to the person, never to a scoped agent.
  const authorizeDesktopTerminal = (req) => () => {
    const client = verify(
      req,
      req.headers.authorization?.replace(/^Bearer /, ""),
    );
    if (
      !client ||
      !client.scopes.includes("admin") ||
      !client.scopes.includes("terminal")
    )
      throw fail(
        403,
        "Only a paired person can access existing Mac terminals.",
      );
  };
  app.get("/api/terminals/desktop", async (req, res) =>
    res.json(
      macTerminalWatch.ready
        ? macTerminalWatch.list(authorizeDesktopTerminal(req))
        : await desktopTerminals.list(authorizeDesktopTerminal(req)),
    ),
  );
  app.post("/api/terminals/desktop", async (req, res) => {
    notPaused();
    const result = await desktopTerminals.create(
      req.body.provider,
      authorizeDesktopTerminal(req),
    );
    record("terminal", "Opened a Mac terminal");
    res.json(result);
  });
  // Every Mac tab's last line, answered when one changes (Home).
  app.get("/api/terminals/desktop/activity", async (req, res) => {
    if (!macTerminalWatch.ready)
      throw fail(409, "Mac terminals aren't being watched right now.");
    const after = Number(req.query.after);
    const left = new AbortController();
    res.once("close", () => left.abort());
    const result = await macTerminalWatch.peekAll(
      Number.isSafeInteger(after) ? after : -1,
      authorizeDesktopTerminal(req),
      left.signal,
    );
    if (!left.signal.aborted) res.json(result);
  });
  app.get("/api/terminals/desktop/:id", async (req, res) => {
    // `?after=<version>`: answered when the tab prints something new.
    if (req.query.after !== undefined && macTerminalWatch.ready) {
      const after = Number(req.query.after);
      const left = new AbortController();
      res.once("close", () => left.abort());
      const result = await macTerminalWatch.text(
        req.params.id,
        Number.isSafeInteger(after) ? after : -1,
        authorizeDesktopTerminal(req),
        left.signal,
      );
      if (!left.signal.aborted) res.json(result);
      return;
    }
    res.json(
      await desktopTerminals.action(
        req.params.id,
        "read",
        { scrollback: true },
        authorizeDesktopTerminal(req),
      ),
    );
  });
  app.post("/api/terminals/desktop/:id/:action", async (req, res) => {
    if (!["send", "focus", "close"].includes(req.params.action))
      throw fail(400, "Unknown terminal action.");
    // Typing into a tab doesn't touch the screen; bringing one forward or
    // closing it does.
    if (req.params.action !== "send") notPaused();
    const result = await desktopTerminals.action(
      req.params.id,
      req.params.action,
      req.body,
      authorizeDesktopTerminal(req),
    );
    // Never log command text or terminal contents.
    if (req.params.action !== "focus")
      record(
        "terminal",
        req.params.action === "close"
          ? "Closed a Mac terminal"
          : "Sent text to a Mac terminal",
      );
    res.json(result);
  });
  app.get("/api/terminals", (req, res) =>
    res.json(terminals.list().filter((s) => mayAccess(req.client, s))),
  );
  // Which agents (Codex, Claude Code) a new terminal can start; cached briefly.
  const locateAgent = overrides.agentCommand || agentCommand;
  let agentsFound = null;
  const installedAgents = () => {
    if (!agentsFound || Date.now() - agentsFound.at > 300000)
      agentsFound = {
        at: Date.now(),
        list: Promise.all(
          Object.keys(AGENTS).map(async (name) =>
            (await locateAgent(name)) ? name : null,
          ),
        ).then((names) => names.filter(Boolean)),
      };
    return agentsFound.list;
  };
  app.get("/api/terminals/agents", async (req, res) =>
    res.json({ agents: await installedAgents() }),
  );
  // Polls cost a few bytes when nothing changed: the phone sends the version
  // it already has and gets { unchanged } back instead of the same data.
  const versioned = (req, res, payload) => {
    const version = crypto
      .createHash("sha1")
      .update(JSON.stringify(payload))
      .digest("base64url")
      .slice(0, 16);
    res.json(
      req.query.known === version
        ? { unchanged: true, version }
        : { ...payload, version },
    );
  };
  openClawRoutes(app, openClaw);
  // Installing Claude Code or Codex from the phone (agent-install.mjs): its
  // maker's command first, to show; confirmed, run in a Reach terminal that
  // ends with it. The owner's own devices only (as every session route).
  app.post("/api/sessions/agent-install/:agent", async (req, res) => {
    const plan = await installPlan(req.params.agent);
    if (req.body?.confirm !== true) return res.json(plan);
    const terminal = terminals.create({
      cwd: os.homedir(),
      name: `Install ${plan.name}`,
      clientId: req.client.id,
      // A failed download fails the install too (curl … | bash).
      command: `set -o pipefail; ${plan.command}; exit`,
    });
    record("terminal", `Installing ${plan.name}`);
    res.json({ ...plan, terminal });
  });
  app.get("/api/sessions", async (req, res) =>
    versioned(req, res, await agentSessions.list({ fresh: req.query.fresh === "1" })),
  );
  app.get("/api/sessions/health", async (req, res) =>
    res.json({ agents: await agentSessions.health({ fresh: req.query.fresh === "1" }) }),
  );
  // The Claude app's own typefaces from the app on this Mac (none without
  // it), ahead of the session routes below that would take /fonts/<name>.
  app.get("/api/sessions/fonts", (req, res) => res.json(agentFonts.list()));
  // A Mac prompt's own page in System Settings, opened on the Mac (owner only,
  // as all /api/sessions routes; only fixed System Settings pages).
  // The Mac's own dialogs are answered by its owner only: never a guest
  // (whatever the invitation) or an agent, on top of the sessions scope.
  const macOwner = (req) => {
    if (req.client?.kind !== "device")
      throw fail(403, "Only the Mac's owner can answer its dialogs, on their own devices.");
  };
  app.post("/api/sessions/mac-prompts/:id/press", async (req, res) => {
    macOwner(req);
    const pressed = await agentSessions.pressMacPrompt(req.params.id, req.body?.button);
    record("session", "Answered a Mac dialog from the phone");
    res.json(pressed);
  });
  // The password goes straight to the Mac's password dialog; never stored or
  // logged (not even in activity: only that it was answered).
  app.post("/api/sessions/mac-prompts/:id/password", async (req, res) => {
    macOwner(req);
    const done = await agentSessions.typeMacPassword(req.params.id, req.body?.password);
    record("session", "Typed the Mac's password from the phone");
    res.json(done);
  });
  app.post("/api/sessions/mac-prompts/:id/setting", async (req, res) => {
    macOwner(req);
    const opened = await agentSessions.openMacSetting(req.params.id);
    record("session", `Opened ${opened.opened} settings on the Mac`);
    res.json(opened);
  });
  app.get("/api/sessions/fonts/:family", (req, res) => {
    const file = agentFonts.file(req.params.family);
    if (!file) throw fail(404, "That font isn't on this computer.");
    res
      .set({
        "Content-Type": "font/woff2",
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      })
      .sendFile(file);
  });
  app.get("/api/sessions/:agent/:id", async (req, res) => {
    const before =
      typeof req.query.before === "string" ? req.query.before : null;
    const page = await agentSessions.read(req.params.agent, req.params.id, {
      limit: Number(req.query.limit) || 200,
      before,
      cursor: before,
    });
    if (before) res.json(page);
    else versioned(req, res, page);
  });
  // A picture sent in a session, as its transcript holds it (never changes).
  app.get("/api/sessions/:agent/:id/images/:item/:n", async (req, res) => {
    const image = await agentSessions.image(
      req.params.agent,
      req.params.id,
      req.params.item,
      Number(req.params.n),
    );
    res
      .set({
        "Content-Type": image.type,
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      })
      .send(image.data);
  });
  app.post("/api/sessions/:agent/:id/open", async (req, res) => {
    notPaused();
    const result = await agentSessions.openInApp(
      req.params.agent,
      req.params.id,
    );
    record(
      "session",
      `Opened a ${agentName(req.params.agent)} session on the Mac`,
    );
    res.json(result);
  });
  // Replying, approving and starting sessions, as in the agents' own apps.
  const agentLabel = agentName;
  const agentImages = createAgentImages({
    dir: path.join(config.dataDir, "agent-images"),
  });
  const imageUpload = multer({
    dest: path.join(config.dataDir, "agent-images"),
    limits: {
      fileSize: 25 * 1024 * 1024,
      files: 1,
      fields: 0,
      parts: 2,
      headerPairs: 32,
    },
  });
  // Model ids as the agents list them, e.g. "gpt-6-astra", "claude-fable-5-1[1m]".
  const MODEL = /^[A-Za-z0-9._:[\]-]{1,64}$/;
  const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
  // Permission modes a reply may switch to, in each agent's own terms.
  const REPLY_MODES = {
    codex: ["auto", "guardian-approvals", "full-access", "read-only"],
    claude: ["default", "auto", "manual", "acceptEdits", "plan", "bypassPermissions", "dontAsk"],
  };
  const turnOptions = (body, agent) => {
    if (body.model !== undefined && body.model !== null && !MODEL.test(body.model))
      throw fail(400, "Unknown model.");
    if (body.effort !== undefined && body.effort !== null && !EFFORTS.includes(body.effort))
      throw fail(400, "Unknown thinking level.");
    if (agent && body.mode !== undefined && body.mode !== null && !REPLY_MODES[agent]?.includes(body.mode))
      throw fail(400, "Unknown permission mode.");
    // Codex's speed (a service tier id from its model list, e.g. "default").
    if (body.speed !== undefined && body.speed !== null && (typeof body.speed !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(body.speed)))
      throw fail(400, "Unknown speed.");
    return {
      text: typeof body.text === "string" ? body.text : "",
      images: agentImages.paths(body.images),
      model: body.model || undefined,
      effort: body.effort || undefined,
      ...(body.speed ? { speed: body.speed } : {}),
      ...(agent && body.mode ? { mode: body.mode } : {}),
    };
  };
  // A folder for a new session: an existing directory in the owner's home.
  const sessionFolder = (value) => {
    if (typeof value !== "string" || !path.isAbsolute(value))
      throw fail(400, "Choose a folder.");
    let real;
    try {
      real = fs.realpathSync.native(value);
    } catch {
      throw fail(400, "That folder doesn't exist on your Mac.");
    }
    const home = fs.realpathSync.native(os.homedir());
    if (
      !fs.statSync(real).isDirectory() ||
      !(real === home || real.startsWith(home + path.sep)) ||
      real === config.dataDir ||
      real.startsWith(config.dataDir + path.sep)
    )
      throw fail(400, "Choose a folder in your home folder.");
    return real;
  };
  // Slash commands the agent offers after "/" in its composer.
  // With a chat's id: that chat's (its folder's skills and commands).
  app.get("/api/sessions/commands", async (req, res) =>
    res.json({
      commands: await agentSessions.commands(
        ["claude", "gemini"].includes(req.query.agent) ? req.query.agent : "codex",
        typeof req.query.id === "string" && /^[\w-]{1,80}$/.test(req.query.id) ? { id: req.query.id } : {},
      ),
    }),
  );
  // One of Codex's own commands from "/", run in the chat (status, compact,
  // review, …); only those its menu offers.
  app.post("/api/sessions/:agent/:id/commands", async (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name : "";
    const result = await agentSessions.runCommand(req.params.agent, req.params.id, name, req.body?.args);
    record("session", `Ran /${name.slice(0, 40)} in ${agentLabel(req.params.agent)}`);
    res.json(result);
  });
  // The agents' real logos from the apps on this Mac, sent once per version.
  // Only fixed brand icons; no paths, credentials or workspace content.
  app.get("/notification-icons/:name.png", async (req, res) => {
    if (!["codex", "claude", "gemini", "openclaw", "agent", "mac"].includes(req.params.name))
      return res.sendStatus(404);
    const { logos = {} } = await agentSessions.logos().catch(() => ({}));
    const icon = logos[req.params.name === "mac" ? "macos" : req.params.name];
    if (typeof icon === "string" && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(icon))
      return res.set("Cache-Control", "public, max-age=86400").type("png").send(Buffer.from(icon.split(",")[1], "base64"));
    res.redirect(302, "/notification-icons/agent.svg");
  });
  app.get("/api/sessions/logos", async (req, res) => {
    const { version, logos } = await agentSessions.logos();
    res.json(
      req.query.known === version
        ? { unchanged: true, version }
        : { version, logos },
    );
  });
  app.get("/api/sessions/models", async (req, res) =>
    res.json(
      await agentSessions.models(
        ["claude", "gemini"].includes(req.query.agent) ? req.query.agent : "codex",
      ),
    ),
  );
  // Signing an agent in on the Mac from the phone: Reach relays the link and
  // the code; the sign-in itself is the agent's own, on the Mac.
  const signInAgent = (value) => {
    if (value !== "claude" && value !== "codex")
      throw fail(404, "Unknown agent.");
    return value;
  };
  app.get("/api/sessions/sign-in", (req, res) =>
    res.json(agentSessions.signIn.view(signInAgent(req.query.agent))),
  );
  app.post("/api/sessions/sign-in", async (req, res) => {
    const agent = signInAgent(req.body?.agent);
    const result = await agentSessions.signIn.start(agent);
    record("session", `Started signing ${agentLabel(agent)} in on the Mac`);
    res.json(result);
  });
  app.post("/api/sessions/sign-in/code", (req, res) =>
    res.json(
      agentSessions.signIn.submit(
        signInAgent(req.body?.agent),
        req.body?.code,
      ),
    ),
  );
  app.delete("/api/sessions/sign-in", (req, res) =>
    res.json(agentSessions.signIn.cancel(signInAgent(req.query.agent))),
  );
  // Spends one of the account's rate-limit resets, only when asked from the phone.
  app.post("/api/sessions/usage/reset", async (req, res) => {
    const result = await agentSessions.resetUsage(req.body?.agent);
    record("session", "Used a Codex rate-limit reset from the phone");
    res.json(result);
  });
  app.post(
    "/api/sessions/images",
    imageUpload.single("file"),
    async (req, res) => {
      if (!req.file) throw fail(400, "Choose an image.");
      res.json({ id: await agentImages.add(req.file.path) });
    },
  );
  app.post("/api/sessions", async (req, res) => {
    const body = req.body || {};
    const agent = String(body.agent || "");
    // Each agent's own permission modes: the Codex app's menu (sent exactly
    // as the app sends it) or Claude Code's --permission-mode choices.
    const modes =
      agent === "codex"
        ? CODEX_MODES
        : Object.fromEntries(
            ["auto", "manual", "acceptEdits", "plan", "bypassPermissions", "dontAsk"].map(
              (mode) => [mode, { mode }],
            ),
          );
    if (body.mode !== undefined && !Object.hasOwn(modes, body.mode))
      throw fail(400, "Unknown permission mode.");
    const result = await agentSessions.start(agent, {
      ...turnOptions(body),
      cwd: sessionFolder(body.cwd),
      ...(body.mode ? modes[body.mode] : {}),
      // Codex: remembered for the chat's next messages (chat-modes.mjs).
      ...(agent === "codex" && body.mode ? { modeName: body.mode } : {}),
      name: typeof body.name === "string" ? body.name.slice(0, 120) : undefined,
    });
    record("session", `Started a ${agentLabel(agent)} session from Reach`);
    res.json(result);
  });
  app.post("/api/sessions/:agent/:id/messages", async (req, res) => {
    const result = await agentSessions.send(
      req.params.agent,
      req.params.id,
      {
        ...turnOptions(req.body || {}, req.params.agent),
        // A Codex skill picked from "/", by name (its path is Codex's own).
        ...(req.params.agent === "codex" && typeof req.body?.skill === "string" && /^[\w:.-]{1,120}$/.test(req.body.skill)
          ? { skill: req.body.skill }
          : {}),
        owner: req.client.id,
      },
    );
    record("session", `Sent a message to ${agentLabel(req.params.agent)}`);
    res.json(result);
  });
  // A permission card the Claude app or the Codex app shows, as it shows it:
  // read when the phone opens it (that chat is brought up in its app).
  app.get("/api/sessions/:agent/:id/card", async (req, res) => {
    res.set("Cache-Control", "no-store").json(await agentSessions.card(req.params.agent, req.params.id));
  });
  app.post("/api/sessions/:agent/:id/prompts/:prompt", async (req, res) => {
    const result = await agentSessions.respond(
      req.params.agent,
      req.params.id,
      req.params.prompt,
      req.body || {},
    );
    record("session", `Answered ${agentLabel(req.params.agent)} on the phone`);
    res.json(result);
  });
  // Archive (or bring back) a chat in its own app, as its app's Archive
  // does: it changes the owner's app, so it's the owner's call.
  app.post("/api/sessions/:agent/:id/archive", async (req, res) => {
    macOwner(req);
    const archived = req.body?.archived !== false;
    const done = await agentSessions.archive(req.params.agent, req.params.id, { archived });
    record("session", `${archived ? "Archived" : "Unarchived"} a ${agentLabel(req.params.agent)} chat`);
    res.json(done);
  });
  app.post("/api/sessions/:agent/:id/stop", async (req, res) =>
    res.json(await agentSessions.stop(req.params.agent, req.params.id)),
  );
  // Continue a chat with the other agent, as if forked in the same app
  // (agent-sessions/move.mjs); the new chat's address comes back.
  app.post("/api/sessions/:agent/:id/move", async (req, res) => {
    const moved = await agentSessions.move(req.params.agent, req.params.id, { to: req.body?.to });
    record("session", `Continued a chat in ${agentName(moved.agent)}`);
    res.json(moved);
  });
  app.post("/api/sessions/:agent/:id/draft", async (req, res) => {
    macOwner(req);
    const text = req.body?.text;
    if (typeof text !== "string" || text.length > 32000 || text.includes("\0"))
      throw fail(400, "Invalid draft.");
    res.json(await agentSessions.draft(req.params.agent, req.params.id, { text, owner: req.client.id }));
  });
  // A permission mode picked on the phone, picked in the Claude app too: the
  // owner's call (it changes what Claude may do without asking). Never Bypass.
  app.post("/api/sessions/:agent/:id/model", async (req, res) => {
    macOwner(req);
    const { model, effort } = req.body || {};
    if (typeof model !== "string" || !model.trim() || model.length > 200 || /[\x00-\x1f]/.test(model) ||
        (effort != null && (typeof effort !== "string" || !effort.trim() || effort.length > 80 || /[\x00-\x1f]/.test(effort))))
      throw fail(400, "Choose a model and thinking level.");
    res.json(await agentSessions.model(req.params.agent, req.params.id, { model, effort }));
  });
  app.post("/api/sessions/:agent/:id/mode", async (req, res) => {
    macOwner(req);
    const mode = req.body?.mode;
    // Claude: never Bypass. Codex: its own menu's choices, as when sending.
    const allowed = req.params.agent === "codex" ? ["auto", "guardian-approvals", "full-access", "read-only", "custom"] : ["manual", "default", "acceptEdits", "plan", "auto"];
    if (!allowed.includes(mode)) throw fail(400, "Reach can't pick that mode.");
    res.json(await agentSessions.mode(req.params.agent, req.params.id, { mode }));
  });
  // Send now can switch the Claude app's window on the Mac: the owner's call.
  app.post("/api/sessions/:agent/:id/queue/:message/now", async (req, res) => {
    macOwner(req);
    res.json(await agentSessions.sendQueuedNow(req.params.agent, req.params.id, req.params.message));
  });
  app.post("/api/sessions/:agent/:id/queue/order", async (req, res) =>
    res.json(await agentSessions.reorderQueued(req.params.agent, req.params.id, req.body?.order)),
  );
  app.post("/api/sessions/:agent/:id/queue/:message/cancel", async (req, res) =>
    res.json(await agentSessions.cancelQueued(req.params.agent, req.params.id, req.params.message)),
  );
  // Messages whose chat was deleted, and one sent to another chat instead.
  app.get("/api/sessions/stranded", (req, res) => res.json({ messages: agentSessions.stranded?.() || [] }));
  app.post("/api/sessions/stranded/:message/send", async (req, res) => {
    const to = { agent: String(req.body?.agent || ""), id: String(req.body?.id || "") };
    res.json(await agentSessions.sendStranded(req.params.message, to, req.client.id));
  });
  // Long poll: answers when the session changes (streamed text, prompts,
  // status) or after 25 seconds.
  app.get("/api/sessions/:agent/:id/live", async (req, res) => {
    chatOpenAt.set(`${req.params.agent}:${req.params.id}`, Date.now());
    if (chatOpenAt.size > 500) chatOpenAt.delete(chatOpenAt.keys().next().value);
    const since = Number(req.query.since);
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    if (Number.isFinite(since)) {
      await agentSessions.changes(
        req.params.agent,
        req.params.id,
        since,
        25000,
        gone.signal,
      );
      // Streaming: let a burst of text arrive together. Anything else (a
      // message in, a reply written, Working on or off) goes at once.
      if (agentSessions.view(req.params.agent, req.params.id).streaming)
        await new Promise((resolve) => setTimeout(resolve, 40));
    }
    if (!res.writableEnded && !gone.signal.aborted)
      res.json(agentSessions.view(req.params.agent, req.params.id));
  });
  app.post("/api/terminals", async (req, res) => {
    const run = req.body.run;
    if (run !== undefined && !Object.hasOwn(AGENTS, run))
      throw fail(400, "Choose Codex or Claude Code.");
    const cwd = resolve(req.body.root, req.body.path || "", req.client);
    if (!fs.statSync(cwd).isDirectory()) throw fail(400, "Choose a folder.");
    const command = run ? await locateAgent(run) : "";
    if (run && !command)
      throw fail(404, `${AGENTS[run]} isn't installed on this computer.`);
    const terminal = terminals.create({
      cwd,
      name: req.body.name || (run ? AGENTS[run] : undefined),
      clientId: req.client.id,
      command,
    });
    record("terminal", `Started ${terminal.name}`);
    res.json(terminal);
  });
  app.delete("/api/terminals/:id", (req, res) => {
    requireOwner(req.client, terminals.get(req.params.id));
    terminals.close(req.params.id);
    res.json({ ok: true });
  });
  const shortcutOwner = (req, res) => {
    const client = verify(
      req,
      req.headers.authorization?.replace(/^Bearer /, ""),
    );
    if (
      res.destroyed ||
      !client?.scopes.includes("admin") ||
      !client.scopes.includes("apps")
    )
      throw fail(403, "Shortcuts require a paired owner with app access.");
  };
  app.get("/api/apps/shortcuts", async (req, res) => {
    shortcutOwner(req, res);
    const result = await appShortcuts.list();
    shortcutOwner(req, res);
    res.json(result);
  });
  app.get("/api/apps/shortcuts/custom", async (req, res) => {
    shortcutOwner(req, res);
    const result = await appShortcuts.customList();
    shortcutOwner(req, res);
    res.json(result);
  });
  app.get("/api/apps/shortcuts/icon", async (req, res) => {
    shortcutOwner(req, res);
    const result = await appShortcuts.icon(req.query.appId);
    shortcutOwner(req, res);
    res.set("Cache-Control", "no-store").json(result);
  });
  app.post("/api/apps/shortcuts/custom", async (req, res) => {
    shortcutOwner(req, res);
    res.json(await appShortcuts.save(req.body, () => shortcutOwner(req, res)));
  });
  app.delete("/api/apps/shortcuts/custom/:id", (req, res) => {
    res.json(appShortcuts.remove(req.params.id, () => shortcutOwner(req, res)));
  });
  app.post("/api/apps/shortcuts", async (req, res) => {
    shortcutOwner(req, res);
    notPaused();
    const result = await appShortcuts.run(req.body.id, () =>
      shortcutOwner(req, res),
    );
    record("app", result.name);
    res.json(result);
  });
  app.get("/api/apps", async (req, res) => {
    const list = await apps();
    res.json(
      req.client.scopes.includes("admin") || !req.client.guestApps
        ? list
        : list.filter((a) => req.client.guestApps.includes(a.id)),
    );
  });
  // Logos for a screenful of installed apps at once; the phone keeps them.
  app.post("/api/apps/icons", async (req, res) => {
    shortcutOwner(req, res);
    const result = await appShortcuts.icons(req.body?.ids);
    shortcutOwner(req, res);
    res.set("Cache-Control", "no-store").json(result);
  });
  app.post("/api/apps/launch", async (req, res) => {
    notPaused();
    const result = await launchApp(req.body.id);
    record("app", `Opened ${result.name}`);
    res.json(result);
  });
  app.get("/api/screen/displays", async (req, res) => {
    if (!config.screen) throw fail(403, "Turn on screen viewing first.");
    const displays = await (overrides.desktopDisplays || desktopDisplays)(
      config,
    );
    res.json({
      displays: displays.filter((d) => !appThreads.ownsDisplay(d.id)),
      video: process.platform === "darwin",
      input:
        req.client.scopes.includes("admin") ||
        req.client.scopes.includes("screen:control"),
    });
  });
  // Apps on your phone. You, or someone you invited to watch these apps.
  const appAllowed = (client, appId) =>
    client.scopes.includes("admin") ||
    (client.scopes.includes("apps:open") &&
      (!client.guestApps || client.guestApps.includes(appId)));
  const appOwner = (req, appId) => {
    const client = req.client;
    if (
      !client.scopes.includes("admin") &&
      !(client.scopes.includes("apps:open") &&
        (appId === undefined || appAllowed(client, appId)))
    )
      throw fail(403, "Only a paired person can open apps on their phone.");
    if (!config.screen) throw fail(403, "Turn on screen viewing first.");
  };
  const threadApp = (id) => appThreads.get(id)?.appId ?? "";
  app.get("/api/screen/apps", (req, res) => {
    appOwner(req);
    res.set("Cache-Control", "no-store").json(
      appThreads
        .list()
        .filter((t) => appAllowed(req.client, t.appId))
        // An agent's app says whose it is.
        .map((t) => {
          const agent = agentApps.agentOf(t.id);
          return agent ? { ...t, agent } : t;
        }),
    );
  });
  // Guests watch apps you've opened on your phone; only you (or someone
  // with full access) open, resize or close them: opening can move an app's
  // window off your screen.
  const appManager = (req) => {
    if (!req.client.scopes.includes("admin"))
      throw fail(
        403,
        "Only the computer's owner can open or close apps. Ask them to open it; you can watch it then.",
      );
  };
  app.post("/api/screen/apps", async (req, res) => {
    appOwner(req, String(req.body?.appId ?? ""));
    notPaused();
    if (!req.client.scopes.includes("admin")) {
      const open = appThreads
        .list()
        .find((t) => t.appId === req.body?.appId && t.state === "running");
      if (!open) appManager(req);
      return res.json(open);
    }
    const thread = await appThreads.open(req.body?.appId, req.body);
    appOwner(req);
    res.json(thread);
  });
  app.patch("/api/screen/apps/:id", async (req, res) => {
    appOwner(req, threadApp(req.params.id));
    appManager(req);
    notPaused();
    res.json(await appThreads.rotate(req.params.id, req.body));
  });
  app.post("/api/screen/apps/:id/activate", async (req, res) => {
    appOwner(req, threadApp(req.params.id));
    notPaused();
    res.json(await appThreads.activate(req.params.id));
  });
  app.delete("/api/screen/apps/:id", async (req, res) => {
    appOwner(req, threadApp(req.params.id));
    appManager(req);
    notPaused();
    res.json(await appThreads.close(req.params.id));
  });
  // Quitting an app, and typing into it, stay with people who control.
  const appControl = (req) => {
    if (
      !req.client.scopes.includes("admin") &&
      !req.client.scopes.includes("screen:control")
    )
      throw fail(403, "This invitation can watch apps, not control them.");
  };
  app.post("/api/screen/apps/:id/quit", async (req, res) => {
    appOwner(req, threadApp(req.params.id));
    if (!req.client.scopes.includes("admin"))
      throw fail(403, "Only a paired person can quit apps.");
    notPaused();
    res.json(await appThreads.quit(req.params.id, req.body?.confirm === true));
  });
  app.get("/api/screen/apps/:id/fields", async (req, res) => {
    appOwner(req, threadApp(req.params.id));
    appControl(req);
    notPaused();
    res.set("Cache-Control", "no-store").json(await appThreads.fields(req.params.id));
  });
  // Tag in, for agents with apps:drive: open an app on its own hidden
  // display, look at it, act in it, hand it to the person, wait, close.
  const driveOnMac = () => {
    if (appThreads.platform !== "darwin")
      throw fail(501, "Agents can use apps on a Mac for now.");
    if (!config.screen)
      throw fail(403, "Screen viewing is off on this computer.");
  };
  app.get("/api/drive/apps", async (req, res) => {
    driveOnMac();
    const installed = await (overrides.appList || apps)();
    res.set("Cache-Control", "no-store").json({
      open: agentApps.list(req.client),
      installed: installed.map(({ id, name }) => ({ id, name })),
    });
  });
  // Not now (someone at the Mac, the person has it): try again later.
  const orWait = async (res, work) => {
    try {
      return await work();
    } catch (e) {
      if (!e.waiting) throw e;
      res.status(e.status || 409).json({ waiting: true, error: e.message });
    }
  };
  app.post("/api/drive/apps", async (req, res) => {
    driveOnMac();
    await orWait(res, async () =>
      res.status(201).json(await agentApps.open(req.client, req.body?.appId)),
    );
  });
  app.get("/api/drive/apps/:id", async (req, res) => {
    driveOnMac();
    res.set("Cache-Control", "no-store").json(
      await agentApps.see(req.client, req.params.id),
    );
  });
  app.post("/api/drive/apps/:id/actions", async (req, res) => {
    driveOnMac();
    await orWait(res, async () =>
      res.json(await agentApps.act(req.client, req.params.id, req.body)),
    );
  });
  app.post("/api/drive/apps/:id/handoff", (req, res) => {
    driveOnMac();
    const handoff = agentApps.handOff(req.client, req.params.id, req.body?.reason);
    record("app", `${req.client.name || "An agent"} handed you ${handoff.app}`);
    res.status(201).json(handoff);
  });
  app.get("/api/drive/handoffs/:id", async (req, res) => {
    res.set("Cache-Control", "no-store").json(
      await agentApps.wait(req.client, req.params.id, Number(req.query.wait) * 1000),
    );
  });
  app.delete("/api/drive/apps/:id", async (req, res) => {
    res.json(await agentApps.close(req.client, req.params.id));
  });
  // The phone: what agents handed you, and handing it back.
  app.get("/api/handoffs", (req, res) => {
    res.set("Cache-Control", "no-store").json(agentApps.pending());
  });
  const readNotificationState = () => readAttention({
    agentSessions, openClaw,
    handoffs: () => agentApps.pending(),
    browserRequests: () => browserApprovals.listOwner(),
    admissions: () => auth.listAgentAdmissions(),
    accessRequests: pendingRequests,
    restartRequests: () => restarts.list(),
    terminalCount: () => terminals.list().length,
  });
  const answerNotification = createNotificationActions({
    read: readNotificationState,
    run: async (binding, action, authorize) => {
      const owner = authorize();
      if (binding.type === "chat")
        return agentSessions.respond(binding.agent, binding.session, binding.prompt, binding.choices[action]);
      if (binding.type === "restart") return restarts.decide(binding.id, action);
      if (action !== "deny") throw fail(400, "Open this request to review it.");
      if (binding.type === "browser") return browserApprovals.decide(owner, binding.id, "deny", authorize);
      if (binding.type === "admission") return auth.decideAgentAdmission(binding.id, "deny");
      if (binding.type === "access") {
        const request = pendingRequests().find((r) => r.id === binding.id && r.status === "pending");
        if (!request) throw fail(409, "This request was already answered.");
        request.status = "denied";
        return { status: "denied" };
      }
      throw fail(400, "Open this request to respond.");
    },
  });
  const notifications = createNotifications({
    read: readNotificationState,
    notify,
    enabled: () => ownDevices().some((id) => push.subscribed(id)),
    file: path.join(config.dataDir, "notification-seen.json"),
    ...(overrides.notifications || {}),
  });
  // An agent's `reach restart` in a checkout waits for you (Needs you).
  const restarts = restartRequests({
    dataDir: config.dataDir,
    restart:
      overrides.restartReach ||
      (() =>
        startInTerminal(fileURLToPath(new URL("../", import.meta.url)), {
          state: config.dataDir,
          args: "restart --yes",
        })),
    // Asked or answered: the list re-reads and phones hear of it at once.
    onChange: () => {
      void notifications.refresh({ fresh: true }).catch(() => {});
      for (const nudge of presenceNudges) nudge();
    },
  });
  server.once("listening", () => notifications.start());
  // What notifications read changed (an agent's chats, or anything a device
  // hears of on its live connection): they look then, not on a beat.
  agentSessions.onListChange?.(() => notifications.wake?.());
  presenceNudges.add(() => notifications.wake?.());
  openClaw.onApprovalsChange?.(() => notifications.wake?.());
  app.get("/api/notifications", async (req, res) => {
    res.set("Cache-Control", "no-store").json(await notifications.refresh());
  });
  app.post("/api/notifications/:id/actions", async (req, res) => {
    const result = await answerNotification(req.params.id, req.body, () => {
      const owner = req.reauthorize();
      if (owner.kind !== "device" || !owner.scopes.includes("admin"))
        throw fail(403, "Only the owner can answer notifications.");
      return owner;
    });
    record("notification", "Answered a request from a notification");
    for (const nudge of presenceNudges) nudge();
    res.set("Cache-Control", "no-store").json(result);
  });
  // Notifications: this browser's subscription (server/push.mjs).
  app.get("/api/push", (req, res) => {
    res.set("Cache-Control", "no-store").json({
      key: push.key(),
      preferences: push.preferences(req.client.id, req.query.endpoint),
      subscribed: push.subscribed(
        req.client.id,
        typeof req.query.endpoint === "string" ? req.query.endpoint : undefined,
      ),
    });
  });
  app.post("/api/push", (req, res) => {
    res.json(push.subscribe(req.client.id, req.body?.subscription));
  });
  app.patch("/api/push", (req, res) => {
    res.json({ preferences: push.updatePreferences(req.client.id, req.body?.endpoint, req.body?.preferences, req.body?.pauseMinutes) });
  });
  app.delete("/api/push", (req, res) => {
    res.json(push.unsubscribe(req.client.id, req.body?.endpoint));
  });
  const pushTests = new Map();
  app.post("/api/push/test", async (req, res) => {
    const endpoint = req.body?.endpoint;
    if (typeof endpoint !== "string" || !push.subscribed(req.client.id, endpoint))
      throw fail(409, "Enable notifications on this device first.");
    const now = Date.now();
    for (const [id, at] of pushTests) if (now - at >= 15000) pushTests.delete(id);
    if (pushTests.has(req.client.id)) throw fail(429, "Wait a few seconds before sending another test.");
    pushTests.set(req.client.id, now);
    const result = await push.notify([req.client.id], {
      title: "Notifications enabled", body: "This device can receive replies, approval requests and computer alerts. Choose which ones in notification settings.", tag: "reach-test", url: "/?notifications=1",
    }, { endpoint, test: true });
    if (!result.sent) throw fail(502, "The notification service didn't accept the test. Try enabling notifications again.");
    res.json({ sent: true });
  });
  app.post("/api/handoffs/:id", (req, res) => {
    res.json(
      agentApps.handBack(req.params.id, {
        note: req.body?.note,
        stop: req.body?.stop === true,
      }),
    );
  });
  app.post("/api/screen/control", (req, res) => {
    if (!config.screen && req.body.enabled)
      throw fail(403, "Turn on screen viewing first.");
    let lease;
    try {
      lease = screenControl.acquire(req.client, req.body.enabled, {
        takeover: req.body.takeover === true,
      });
    } catch (e) {
      // Someone else controls: say who, so the phone can watch (or offer
      // Take over) instead of fighting for it.
      if (!e.holder) throw e;
      return res
        .status(409)
        .json({ error: e.message, holder: e.holder, canTakeOver: e.canTakeOver });
    }
    if (!req.body.enabled) closeInput(req.client.id);
    for (const nudge of presenceNudges) nudge();
    const { taken, ...grant } = lease;
    if (taken) {
      const message = `${req.client.name || "Someone"} took over control.`;
      closeInput(taken, message);
      console.log(`Reach: ${req.client.name || "a device"} took over screen control.`);
    }
    res.json(grant);
  });
  app.post("/api/screen/input", async (req, res) => {
    if (!config.screen) throw fail(403, "Screen viewing is off.");
    screenControl.check(req.client);
    if (inputConnections.has(req.client.id))
      throw fail(409, "Use the active desktop input channel.");
    if (inputInFlight)
      throw fail(409, "Wait for the previous screen action to finish.");
    inputInFlight = true;
    try {
      res.json(
        await screenInput(config, req.body, () => {
          if (
            res.destroyed ||
            !config.screen ||
            !verify(req, req.headers.authorization?.replace(/^Bearer /, ""))
          )
            throw fail(403, "Screen access was turned off or revoked.");
          screenControl.check(req.client);
        }),
      );
    } finally {
      inputInFlight = false;
    }
  });
  app.get("/api/screen", async (req, res) => {
    if (!config.screen)
      throw fail(403, "Screen viewing is off. Turn it on in Reach first.");
    notPaused();
    // Share simultaneous captures instead of spawning a process per viewer.
    if (!captureInFlight)
      captureInFlight = screenCapture(config).finally(() => {
        captureInFlight = null;
      });
    const frame = await captureInFlight;
    if (
      !config.screen ||
      !verify(req, req.headers.authorization?.replace(/^Bearer /, ""))
    )
      throw fail(403, "Screen access was turned off or revoked.");
    res.type("image/jpeg").send(frame);
  });
  app.get("/api/chats", (req, res) =>
    res.json(codex.list().filter((c) => mayAccess(req.client, c))),
  );
  app.use("/api/chats/:id", (req, res, next) => {
    requireOwner(req.client, codex.get(req.params.id));
    next();
  });
  app.get("/api/codex/status", async (req, res) => {
    try {
      res.json(await codex.status());
    } catch (e) {
      res.json({ available: false, signedIn: false, error: e.message });
    }
  });
  app.post("/api/chats", async (req, res) => {
    const cwd = resolve(req.body.root, req.body.path || "", req.client);
    if (!fs.statSync(cwd).isDirectory()) throw fail(400, "Choose a folder.");
    const chat = await codex.create(cwd, req.body.name, req.client.id);
    record("chat", `Started ${chat.name}`);
    res.json(chat);
  });
  app.get("/api/chats/:id", (req, res) => res.json(codex.get(req.params.id)));
  app.post("/api/chats/:id/messages", async (req, res) =>
    res.json(await codex.message(req.params.id, req.body.text)),
  );
  app.post("/api/chats/:id/stop", async (req, res) => {
    await codex.stop(req.params.id);
    res.json({ ok: true });
  });
  app.post("/api/chats/:id/approvals/:requestId", async (req, res) => {
    if (req.client.kind !== "device" || !req.client.scopes.includes("admin"))
      throw fail(403, "Only a paired person can answer Codex approvals.");
    await codex.respond(req.params.id, req.params.requestId, req.body);
    res.json({ ok: true });
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "This action does not exist." }),
  );
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  // Which phone interface this Reach serves: an open page on an older one
  // reloads itself when it's idle (src/build-reload.ts).
  const builtNow = () => {
    try {
      return crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(dist, "index.html")))
        .digest("base64url")
        .slice(0, 12);
    } catch {
      return ""; /* no build (development): nothing to compare */
    }
  };
  let build = builtNow();
  // A checkout rebuilds its interface as it's edited; phones follow without
  // a restart (server/live-interface.mjs).
  const stopInterfaceWatch = overrides.liveInterface
    ? watchInterface({
        root: fileURLToPath(new URL("../", import.meta.url)),
        onBuilt: () => {
          build = builtNow() || build;
        },
      })
    : () => {};
  app.get("/download/:token", async (req, res) => {
    const link = links.find(req.params.token);
    if (!link)
      throw fail(410, "This download link expired. Start the download again.");
    // Every check the credential would get on /api, including its device.
    if (browserHostGuard.isActive()) await browserHostGuard.refresh();
    const check = () => {
      const current = auth.verifyDigest(link.digest, req.reachIdentity);
      if (!current || current.policy?.browser || paused || !transportAvailable)
        throw fail(403, "This download link is no longer valid.");
      browserHostGuard.assertRequest(req, current);
      return current;
    };
    const client = check();
    const file = resolve(link.root, link.path, client);
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.mtimeMs !== link.mtimeMs)
      throw fail(410, "This file changed. Start the download again.");
    check();
    const stop = () => { res.destroy(); req.destroy(); };
    const identityCleanup = trackIdentity(req, stop);
    const timer = setInterval(() => { try { check(); } catch { stop(); } }, 100);
    timer.unref();
    const cleanup = () => { clearInterval(timer); identityCleanup(); };
    res.once("close", cleanup); res.once("finish", cleanup);
    res.setHeader("Cache-Control", "no-store");
    res.download(file, path.basename(file));
  });
  serveBuild(app, express, dist);
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res
      .status(
        error.status ||
          {
            LIMIT_FILE_SIZE: 413,
            EEXIST: 409,
            EACCES: 403,
            EPERM: 403,
            ENOENT: 404,
          }[error.code] ||
          500,
      )
      .json({
        error:
          error.code === "LIMIT_FILE_SIZE"
            ? "Files can be up to 100 MB."
            : error.status
              ? error.message
              : error.code === "EACCES" || error.code === "EPERM"
                ? "Your computer has not granted access to this location."
                : error.code === "EEXIST"
                  ? "That name is already in use."
                  : "Could not complete this action. Check the companion console.",
      });
    if (!error.status && !req.aborted) console.error(error.message);
  });
  const upgrade = async (req, socket, head) => {
    if (browserHostGuard.isActive()) {
      try { await browserHostGuard.refresh(); browserHostGuard.assertRequest(req); } catch { socket.destroy(); return; }
    }
    if (config.tailscaleOwner && (!trustedRequest(req) || !req.reachIdentity))
      return socket.destroy();
    if (!transportAvailable) {
      socket.destroy();
      return;
    }
    if (wss.clients.size >= 64) {
      socket.destroy();
      return;
    }
    if (
      ![
        "/ws/terminal",
        "/ws/screen",
        "/ws/screen-input",
        "/ws/presence",
      ].includes(req.url) ||
      req.headers["tailscale-funnel-request"] !== undefined ||
      !validHost(req) ||
      !acceptedOrigin(req)
    ) {
      socket.destroy();
      return;
    }
    socket.setNoDelay(true);
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit("connection", ws, req),
    );
  };
  server.on("upgrade", upgrade);
  wss.on("connection", (ws, req) => {
    const cleanupIdentity = trackIdentity(req, () => ws.terminate());
    ws.once("close", cleanupIdentity);
    if (req.url === "/ws/presence") {
      presenceConnection(ws, {
        verify: (token) => verify(req, token),
        presence,
        subscribe: (send) => {
          presenceNudges.add(send);
          // The chat list's revision is news too, while a device listens.
          const offList = agentSessions.onListChange?.(() => send()) || (() => {});
          return () => {
            presenceNudges.delete(send);
            offList();
          };
        },
        changes: (client) => {
          const scopes = client.scopes || [];
          // People who may see the Mac's own terminals keep them watched.
          const macTerminals =
            desktopTerminals.platform === "darwin" &&
            scopes.includes("admin") &&
            scopes.includes("terminal");
          if (macTerminals && !ws.reachMacTerminals) {
            ws.reachMacTerminals = true;
            macTerminalWatch.retain();
            ws.once("close", () => macTerminalWatch.release());
          }
          const digest = (value) =>
            crypto
              .createHash("sha256")
              .update(JSON.stringify(value))
              .digest("base64url")
              .slice(0, 12);
          // Only lists this client could read anyway.
          return {
            ...(build && { build }),
            ...(paused && { paused: true }),
            ...(scopes.includes("admin") &&
              restarts.list()[0] && { restart: restarts.list()[0].id }),
            ...(scopes.includes("terminal") && {
              terminals: digest(
                terminals.list().filter((s) => mayAccess(client, s)),
              ),
            }),
            ...(scopes.includes("codex") && {
              chats: digest(codex.list().filter((c) => mayAccess(client, c))),
            }),
            // The apps on phones, as this device may see them: a guest's list
            // used to go stale (an app you gave back stayed "on your phone"
            // for them, its view stuck on "Opening…").
            ...(scopes.includes("screen") &&
              (scopes.includes("admin") || scopes.includes("apps:open")) && {
                apps: digest(
                  appThreads.list().filter((t) => appAllowed(client, t.appId)),
                ),
              }),
            // Who controls the screen: a watching phone tries again the
            // moment it's free, without polling.
            ...(scopes.includes("screen") && {
              control: digest(screenControl.holder()?.clientId ?? ""),
            }),
            ...(macTerminals &&
              macTerminalWatch.version && {
                macTerminals: macTerminalWatch.version,
              }),
            // What agents hand you: the owner's, never a guest's.
            ...(scopes.includes("admin") &&
              client.kind !== "guest" && {
                handoffs: digest(agentApps.pending().map((h) => h.id)),
                browserRequests: digest(browserApprovals.listOwner().map((r) => r.id)),
                ...(client.kind === "device" && {
                  agentAdmissions: digest(auth.listAgentAdmissions().map((r) => r.requestId)),
                }),
              }),
            // The chat list (every agent's chats): the owner's devices read it
            // when this changes, instead of asking every few seconds.
            ...(scopes.includes("admin") &&
              client.kind !== "guest" &&
              agentSessions.listRevision && { sessions: String(agentSessions.listRevision()) }),
            ...(scopes.includes("admin") && {
              activity: digest(events[0]?.id ?? ""), // newest first
              requests: digest(
                pendingRequests()
                  .filter((r) => r.status === "pending")
                  .map((r) => r.id),
              ),
            }),
            // What someone you invited may use: when you change it, their
            // phone reloads it at once (src/App.tsx), no new link.
            ...(["guest", "agent"].includes(client.kind) && {
              access: digest([
                scopes,
                client.agentRoots || [],
                client.guestApps || [],
              ]),
            }),
          };
        },
        activity: (clientId) => {
          if (
            screenControl.lease?.clientId === clientId &&
            screenControl.lease.expiresAt > Date.now()
          )
            return "controlling";
          const sockets = [...wss.clients].filter(
            (s) => s.clientId === clientId && s.readyState === WebSocket.OPEN,
          );
          if (sockets.some((s) => s.reachChannel === "/ws/screen"))
            return "viewing";
          if (sockets.some((s) => s.reachChannel === "/ws/terminal"))
            return "terminal";
          return "connected";
        },
      });
      return;
    }
    ws.reachChannel = req.url;
    if (req.url === "/ws/screen-input") {
      desktopConnection(ws, {
        config,
        auth: { verify: (token) => verify(req, token) },
        control: screenControl,
        create: overrides.desktopInputFactory,
        register: (id, socket) => {
          if (inputConnections.has(id))
            throw fail(409, "This device already has a control connection.");
          inputConnections.set(id, socket);
        },
        unregister: (id, socket) => {
          if (inputConnections.get(id) === socket) {
            inputConnections.delete(id);
            return true;
          }
          return false;
        },
      });
      return;
    }
    let accessDeadline;
    const expires = (client) => {
      accessDeadline = setTimeout(
        () => {
          const current = auth.list().find((entry) => entry.id === client.id);
          if (!current || Date.now() >= current.expiresAt) ws.close(4001, "Access expired");
          else expires(current);
        },
        Math.min(2147483647, Math.max(0, client.expiresAt - Date.now())),
      );
      accessDeadline.unref();
    };
    ws.once("close", () => clearTimeout(accessDeadline));
    if (req.url === "/ws/screen") {
      let credential,
        modern = false;
      const reject = (message, status = 403) => {
        screenStreams.remove(ws);
        remoteScreens.remove(ws);
        appScreens.remove(ws);
        if (ws.readyState === WebSocket.OPEN) {
          const retryable = ![400, 401, 403, 404].includes(status);
          ws.send(
            JSON.stringify({
              type: "error",
              error: message,
              status,
              retryable,
            }),
          );
          ws.close(
            status === 401 ? 4001 : retryable ? 1012 : 4003,
            "Screen access ended",
          );
        }
      };
      const authorized = () => {
        const client = credential && verify(req, credential);
        if (!client) {
          reject("Screen access expired or was revoked.", 401);
          return false;
        }
        const appWindowOk =
          ws.appThread !== undefined &&
          appAllowed(client, threadApp(ws.appThread));
        if (
          (!client.scopes.includes("screen") && !appWindowOk) ||
          !config.screen
        ) {
          reject("Screen access was turned off, expired or revoked.");
          return false;
        }
        // Also a stream that was still starting when Reach paused.
        if (paused) {
          reject(PAUSED, 423);
          return false;
        }
        return true;
      };
      const deadline = setTimeout(() => ws.terminate(), 5000);
      const expiryCheck = setInterval(() => {
        if (credential) authorized();
      }, 1000);
      expiryCheck.unref();
      ws.on("message", (buffer, binary) => {
        try {
          if (binary) throw fail(400, "Send a screen protocol message.");
          const message = JSON.parse(buffer.toString());
          if (!credential) {
            if (message.type !== "auth" || typeof message.token !== "string")
              throw fail(401, "Authenticate first.");
            const client = verify(req, message.token);
            if (!client) throw fail(401, "Pair this device again.");
            // A whole display needs screen access; one app's window needs
            // that app (an invitation can be limited to chosen apps).
            const appWindow =
              message.protocol === 2 && typeof message.thread === "string";
            if (
              !client.scopes.includes("screen") &&
              !(appWindow && client.scopes.includes("apps:open"))
            )
              throw fail(403, "Screen access is not granted.");
            if (!config.screen)
              throw fail(403, "Turn on screen viewing first.");
            notPaused();
            credential = message.token;
            ws.clientId = client.id;
            if (appWindow) ws.appThread = message.thread;
            expires(client);
            clearTimeout(deadline);
            modern = message.protocol === 2;
            if (modern) {
              // An app on the phone streams only its own window.
              const hub =
                typeof message.thread === "string"
                  ? (appOwner({ client }, threadApp(message.thread)),
                    appScreens)
                  : remoteScreens;
              void (async () => hub.add(ws, authorized, message))().catch(
                (e) => reject(e.message, e.status || 503),
              );
            } else {
              screenStreams.add(ws, authorized);
              ws.send(
                JSON.stringify({
                  type: "ready",
                  fps: 15,
                  format: "image/jpeg",
                }),
              );
            }
          } else {
            if (!authorized()) return;
            // Why the phone's video changed (decoder trouble): for the log.
            if (message.type === "diagnostic") {
              const now = Date.now();
              if (
                typeof message.text === "string" &&
                (now - (ws.reachDiagnosticAt || 0) > 5000 ||
                  // The line that says the video just got worse always shows.
                  message.text.startsWith("switching to still images"))
              ) {
                ws.reachDiagnosticAt = now;
                console.warn(
                  `Reach: phone video: ${message.text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300)}`,
                );
              }
              return;
            }
            if (message.type !== "ack")
              throw fail(400, "Unsupported screen message.");
            if (modern)
              (appScreens.owns(ws) ? appScreens : remoteScreens).ack(
                ws,
                message.id,
                message.keyframe === true,
              );
            else screenStreams.ack(ws);
          }
        } catch (e) {
          reject(e.message, e.status || 400);
        }
      });
      ws.on("close", () => {
        clearTimeout(deadline);
        clearInterval(expiryCheck);
        screenStreams.remove(ws);
        remoteScreens.remove(ws);
        appScreens.remove(ws);
        if (!inputConnections.has(ws.clientId))
          screenControl.revoke(ws.clientId);
      });
      ws.on("error", () => {});
      return;
    }

    let session, listener, credential;
    const stillAuthorized = () => {
      if (!credential) return true;
      const client = verify(req, credential);
      if (
        client?.scopes.includes("terminal") &&
        (!client.agentRoots ||
          !session ||
          client.agentRoots.some((root) => within(root, session.cwd)))
      )
        return true;
      ws.close(4001, "Access revoked or expired");
      return false;
    };
    const expiryCheck = setInterval(stillAuthorized, 1000);
    expiryCheck.unref();
    const deadline = setTimeout(() => ws.terminate(), 5000);
    const send = (data) => {
      if (ws.readyState === WebSocket.OPEN && stillAuthorized()) {
        if (ws.bufferedAmount > 2 * 1024 * 1024) {
          ws.close(4008, "Reconnect to catch up");
          return;
        }
        ws.send(JSON.stringify(data));
      }
    };
    ws.on("message", (buffer) => {
      try {
        if (!stillAuthorized()) return;
        const msg = JSON.parse(buffer.toString());
        if (!session) {
          if (msg.type !== "auth") throw fail(401, "Authenticate first.");
          const client = verify(req, msg.token);
          if (!client) throw fail(401, "Pair this device again.");
          if (!client.scopes?.includes("terminal"))
            throw fail(403, "Terminal access is not granted.");
          ws.clientId = client.id;
          expires(client);
          credential = msg.token;
          session = requireOwner(client, terminals.get(msg.sessionId));
          clearTimeout(deadline);
          listener = send;
          session.listeners.add(listener);
          send({
            type: "snapshot",
            data: session.buffer,
            status: session.status,
            heartbeat: true,
          });
        } else if (msg.type === "ping") {
          send({ type: "pong" });
        } else if (
          msg.type === "input" &&
          typeof msg.data === "string" &&
          msg.data.length <= 32768 &&
          session.status === "running"
        )
          session.proc.write(msg.data);
        else if (
          msg.type === "resize" &&
          Number.isInteger(msg.cols) &&
          Number.isInteger(msg.rows) &&
          msg.cols >= 10 &&
          msg.cols <= 400 &&
          msg.rows >= 2 &&
          msg.rows <= 200 &&
          session.status === "running"
        )
          session.proc.resize(msg.cols, msg.rows);
      } catch (e) {
        send({ type: "error", error: e.message });
        ws.close(4001, "Invalid request");
      }
    });
    ws.on("close", () => {
      clearTimeout(deadline);
      clearInterval(expiryCheck);
      session?.listeners.delete(listener);
    });
    ws.on("error", () => {});
  });
  // The internet's only requests to Reach itself: Face ID sign-in, from the
  // start page through Funnel (server/tailscale-auth.mjs hands them here).
  // Exactly two paths, POST, a small JSON body, rate limited; anything else
  // from the internet is the start page's fixed files, or nothing.
  const FACE_PATHS = ["/faceid/options", "/faceid/join"];
  const faceAsks = new Map(); // source address -> { count, reset }
  const publicFaceId = (req, res) => {
    const route = (req.url || "").split("?")[0];
    if (!FACE_PATHS.includes(route)) return false;
    const reply = (status, value) => {
      if (res.headersSent || res.destroyed) return;
      const body = JSON.stringify(value);
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(body);
    };
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      res.end();
      return true;
    }
    if (!validHost(req)) {
      reply(421, { error: "Unrecognized host." });
      return true;
    }
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) {
      reply(415, { error: "Send JSON." });
      return true;
    }
    // Per address (Tailscale gives the visitor's own), on top of the
    // computer-wide limits in server/face-join.mjs and server/passkeys.mjs.
    const now = Date.now();
    for (const [source, state] of faceAsks)
      if (state.reset <= now) faceAsks.delete(source);
    const from = String(req.headers["x-forwarded-for"] || "");
    const seen = faceAsks.get(from);
    if (!seen && faceAsks.size >= 1000) {
      reply(429, { error: "Too many tries. Wait a minute." });
      return true;
    }
    const state = seen && seen.reset > now ? seen : { count: 0, reset: now + 60000 };
    faceAsks.set(from, state);
    if (++state.count > 20) {
      reply(429, { error: "Too many tries. Wait a minute." });
      return true;
    }
    const chunks = [];
    // Bound slow request bodies independently of the server's keepalive.
    const deadline = setTimeout(() => {
      reply(408, { error: "Sign-in request timed out." });
      req.destroy();
    }, 10000);
    deadline.unref();
    req.once("end", () => clearTimeout(deadline));
    req.once("close", () => clearTimeout(deadline));
    let size = 0;
    req.on("error", () => {});
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 8192) {
        reply(413, { error: "Too large." });
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", async () => {
      if (res.headersSent) return;
      try {
        if (!faceJoin)
          throw fail(404, "Face ID sign-in isn't set up on this computer.");
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        reply(
          200,
          route === "/faceid/options"
            ? faceJoin.options()
            : await faceJoin.join({ id: body?.id, credential: body?.credential }),
        );
      } catch (error) {
        reply(error.status || 400, {
          error: error.status ? error.message : "That request isn't readable.",
        });
      }
    });
    return true;
  };
  publicAgent = config.publicOrigin?.startsWith("https://")
    ? createFunnelAgentGateway({
        auth,
        origin: new URL(config.publicOrigin).origin.replace(/:\d+$/, ""),
        requestHost: serveRequestHost,
        available: () => !paused && transportAvailable && auth.funnelWindow().open,
        device: invitationDevice,
        claimed: (joined) => {
          record("agent", "An invited browser agent is waiting for connection approval");
          notify({ category: "access", ...notificationPush(admissionNotification(auth.listAgentAdmissions().find((item) => item.requestId === joined.requestId) || { requestId: joined.requestId })), tag: `agent-admission-${joined.requestId}` });
          for (const nudge of presenceNudges) nudge();
        },
        dispatch: (req, res, context) => {
          // Only the signature-verifying gateway can mark a request. Neither a
          // header nor a public token can manufacture a private Tailscale identity.
          funnelRequests.set(req, context);
          req.method = context.method;
          req.url = context.path;
          req.originalUrl = context.path; // Verified inner route, not the outer gateway path.
          req.body = context.body || {};
          req.headers.authorization = `Bearer ${context.token}`;
          delete req._parsedUrl;
          delete req._parsedOriginalUrl;
          app(req, res);
        },
      })
    : () => false;
  return {
    app,
    server,
    config,
    auth,
    fleet,
    // For the start page at the one address (scripts/launch.mjs).
    publicFaceId,
    publicAgent,
    funnelWindow: () => paused || !transportAvailable
      ? { open: false, until: 0, reason: null } : auth.funnelWindow(),
    setFunnelController(controller) { prepareFunnel = controller; },
    faceIdAvailable: () => !!faceJoin?.available(),
    approvals,
    guestKeys,
    terminals,
    codex,
    jobs,
    instance,
    // Pause or resume from the computer itself (its terminal).
    setPaused,
    get paused() {
      return paused;
    },
    // `publicApp`: what the internet gets at this same address (the start page).
    async listenPrivate(socketPath, { publicApp } = {}) {
      if (!config.tailscaleOwner)
        throw Error("Configure Tailscale identity first.");
      privateServer = await listenPrivateIngress({
        socketPath,
        app,
        upgrade,
        resolveIdentity,
        publicApp,
      });
    },
    setTransportAvailable(value) {
      if (transportAvailable === value) return;
      transportAvailable = value;
      if (!value) {
        screenControl.clear();
        closeInput();
        // Disconnect access without killing terminals, chats or jobs.
        for (const ws of wss.clients) ws.terminate();
      }
    },
    async close() {
      stopInterfaceWatch();
      restarts.close();
      notifications.close();
      clearInterval(snapshotSweep);
      browserOperations.close();
      browserApprovals.close();
      browserAppAccess.close();
      await browserApprovals.flushChanges();
      agentDesktop?.close?.();
      await browserCommandLog.close();
      browserSnapshots.clear();
      clearInterval(approvalCleanup);
      for (const timer of guestTimers) clearTimeout(timer);
      clearInterval(originSync);
      screenStreams.stop("Reach is shutting down.");
      browserScreenSnapshots.stop("Reach is shutting down.");
      remoteScreens.stop("Reach is shutting down.", true);
      appScreens.stop("Reach is shutting down.", true);
      // Requests still running (a phone's download, a long poll) get a
      // moment to finish, then their connections are cut: quitting never
      // waits on a phone.
      const servers = [server, privateServer].filter(Boolean);
      const closed = Promise.all(
        servers.map((s) => new Promise((r) => s.close(r))),
      );
      const cutoff = setTimeout(() => {
        for (const s of servers) s.closeAllConnections();
      }, 1000);
      clearInterval(agentSweep);
      agentApps.shutdown();
      const apps = appThreads.shutdown();
      macTerminalWatch.end();
      closeInput();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      agentSessions.close?.();
      openClaw.close?.();
      doneWatch.stop();
      const terminalExit = terminals.dispose();
      codex.dispose();
      jobs.dispose();
      await Promise.all([apps, closed, terminalExit]);
      clearTimeout(cutoff);
    },
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const network = await tailscaleInfo();
  const reach = await createReach({
    publicOrigin:
      process.env.REACH_ORIGIN ||
      (network.hostname ? `https://${network.hostname}:8443` : ""),
  });
  // Reach's Terminal window carries its name, so the agents' checker always
  // recognises it.
  if (process.stdout.isTTY && process.platform === "darwin") process.stdout.write("\u001b]0;Reach\u0007");
  reach.server.listen(reach.config.port, reach.config.host, () => {
    console.log(
      `\n  Reach is ready · http://localhost:${reach.config.port}\n  Pairing code: ${reach.auth.pairing.code.slice(0, 4)} ${reach.auth.pairing.code.slice(4)} (one use, expires in 10 minutes)\n  Shared folders: ${reach.config.roots.join(", ")}\n  Run npm run share to connect through Tailscale.\n`,
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      await reach.close();
      process.exit(0);
    });
}
