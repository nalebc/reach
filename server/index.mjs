import { browserAgentRoutes } from "./browser-agents.mjs";
import { createBrowserOperationCoordinator } from "./browser-operation-coordinator.mjs";
import { createBrowserHostGuard, personOnHostMessage, personWaitingMessage } from "./browser-host-guard.mjs";
import { createBrowserAppAccess } from "./browser-app-access.mjs";
import { BrowserAppNative } from "./browser-app-native.mjs";
import { runBrowserScript } from "./browser-scripts.mjs";
import { agentShellSandbox, browserPrivatePaths, isBrowserPrivatePath, validateBrowserRoot } from "./browser-private-paths.mjs";
import { browserFileOperation } from "./browser-file-boundary.mjs";
import { DevicePresence, presenceConnection } from "./presence.mjs";
import {
  createIdentityResolver,
  listenPrivateIngress,
  listenKeyedIngress,
  thisComputerRequest,
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
import { rateLimit, MemoryStore } from "express-rate-limit";
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileRootName, hiddenByOs, refreshDriveRoots } from "./file-roots.mjs";
import { openConfined, readUpTo } from "./confined-file.mjs";
import { DOCUMENT_TEXT, readDocumentText } from "./document-text.mjs";
import { archiveBase, extractArchive } from "./archives.mjs";
import { isIconType, readFileIcons } from "./file-icons.mjs";
import { compressJson, serveBuild } from "./delivery.mjs";
import { createUploads } from "./uploads.mjs";
import { createLinks } from "./links.mjs";
import { ensurePtyHelper } from "./pty-helper.mjs";
import { createAppIconCache, useAppIconFolder } from "./app-icons.mjs";
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
  sameHash,
  isPlainRecord,
  ALL_SCOPES,
  AGENT_SCOPES,
  GUEST_BLOCKED_ROUTES,
} from "./core.mjs";
import crypto from "node:crypto";
import { computerIdentity } from "./computer-identity.mjs";
import { applyAgentPolicy, readAgentPolicy, within } from "./agent-policy.mjs";
import { presetAppsFromCatalog } from "./agent-presets.mjs";
import { createAgentDesktop, reachAddresses } from "./agent-desktop.mjs";
import { createAgentPauses } from "./agent-pauses.mjs";
import { createMacShortcuts } from "./mac-shortcuts.mjs";
import { createAgentActions } from "./agent-actions.mjs";
import { createAgentTimings } from "./agent-timings.mjs";
import { markRunning, markStopped, previousRun, restartReason } from "./crash-guard.mjs";
import { startTidying } from "./tidy.mjs";
import { createDesktopAutomation } from "./desktop-automation.mjs";
import { createAgentShortcuts, agentShortcutRoutes } from "./agent-shortcuts.mjs";
import { createAgentTools, agentToolRoutes } from "./agent-tools.mjs";
import { createAgentServices, agentServiceRoutes } from "./agent-services.mjs";
import { createPermissionRequests, macAccess, permissionRoutes } from "./permission-requests.mjs";
import { createServiceConnectors } from "./service-connectors.mjs";
import { createAgentShell } from "./agent-shell.mjs";
import { Terminals } from "./terminal.mjs";
import { installLock, installPlan, installTerminalCommand } from "./agent-install.mjs";
import { createAgentUpdates } from "./agent-updates.mjs";
import { agentSource, codexServiceSource, createKeepInSync, openClawSource } from "./keep-in-sync.mjs";
import { DesktopTerminals } from "./desktop-terminals.mjs";
import { createWindowsTray } from "./windows-tray.mjs";
import {
  MacTerminalWatch,
  terminalWatchHelper,
} from "./mac-terminal-watch.mjs";
import { ScreenControl, OwnerHold, actsAsOwner, pausedMessage } from "./screen.mjs";
import { RemoteScreenHub, screenTrouble, privateViewRefused, PRIVATE_VIEW_UNAVAILABLE } from "./remote-screen.mjs";
import { SoundHub, soundPreparer } from "./screen-sound.mjs";
import { computerWord } from "./computer-word.mjs";
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
import { createOpenClawWatch } from "./openclaw-watch.mjs";
import { createNotificationActions, notificationPush, admissionNotification, pushLine, chatEventTitle } from "./notification-items.mjs";
import { idleSeconds } from "./agent-sessions/claude-import.mjs";
import { DesktopInput, desktopBinary, desktopDisplays, windowsBinary } from "./desktop-native.mjs";
import { prepareOwners } from "./windows-owners.mjs";
import { desktopConnection } from "./desktop-connection.mjs";
import { ScreenBroadcast, createScreenSource, hostAppName, sweepScreenHelpers } from "./screen-stream.mjs";
import { watchInterface } from "./live-interface.mjs";
import { restartRequests } from "./restart-requests.mjs";
import { askUpdate, createReachUpdates, mountReachUpdates } from "./reach-updates.mjs";
import { createAgentRuntimes, fromBrowserPage, updateNotice } from "./agent-runtimes.mjs";
import { agentGuide } from "./agent-guide.mjs";
import { agentAskSocket } from "./agent-sessions/agent-asks.mjs";
import { keepRuntime } from "./runtime-archive.mjs";
import { startInConsole, startInTerminal, startInWindow } from "../scripts/stop.mjs";
import { command } from "../scripts/home.mjs";
import { BrowserScreenSnapshots } from "./browser-screen.mjs";
import { Jobs } from "./jobs.mjs";
import { createWindowsSandbox, windowsJobSandbox, windowsShellRunner, createWindowsGrantLedger, windowsRevoker } from "./windows-sandbox.mjs";
import { Codex } from "./codex.mjs";
import { createAgentSessions } from "./agent-sessions/index.mjs";
import { SWITCHABLE_MODES } from "./agent-sessions/claude-host.mjs";
import { createOpenClaw, openClawRoutes } from "./openclaw.mjs";
import { createDoneWatch } from "./agent-sessions/done-watch.mjs";
import { createUsageWatch } from "./agent-sessions/usage-watch.mjs";
import { createTurnWatch, usageLimited } from "./agent-sessions/turn-watch.mjs";
import { createRelays } from "./agent-sessions/relays.mjs";
import { createTeams } from "./agent-sessions/teams.mjs";
import { createWorkflows, readyForTasks } from "./agent-sessions/workflows.mjs";
import { createTeamBridge, teamPipe } from "./agent-sessions/team-bridge.mjs";
import { MAX_MENTIONS, mentionBlock, withMentions } from "./agent-sessions/chat-context.mjs";
import { createJournal, turnEvent } from "./agent-sessions/journal.mjs";
import { createOverlaps } from "./agent-sessions/overlaps.mjs";
import { createSearch } from "./agent-sessions/search.mjs";
import { agentName } from "./agent-sessions/move.mjs";
import { createAgentFonts } from "./agent-sessions/fonts.mjs";
import { createAgentImages, createAgentFiles, imageSize, imageTokens } from "./agent-sessions/images.mjs";
import { createImageRepeats, repeatNote } from "./agent-sessions/image-repeats.mjs";
import { createSavings } from "./savings.mjs";
import { audioKind, createVoice, memoName, readHead } from "./agent-sessions/voice.mjs";
import { codexStartMode, isCodexMode } from "./agent-sessions/codex.mjs";
import { createToolDetector, deviceCapabilities } from "./capabilities.mjs";
import { browserAccessRoutes, browserRouteAllowed } from "./browser-access.mjs";
import { publicNameState } from "./public-dns.mjs";
import { createFunnelAgentGateway } from "./funnel-agent.mjs";
import { createHostedMcp } from "./hosted-mcp.mjs";
import { createToolSetup } from "./tool-setup.mjs";
import { createBrowserExtensionBridge } from "./browser-extension.mjs";
import { registerExtensionHost } from "./browser-extension-host.mjs";
import { createBrowserApprovals, browserRequestActions } from "./browser-approvals.mjs";
import { runTerminalCommand } from "./restricted-terminal.mjs";
import { runBrowserMutation } from "./browser-mutations.mjs";
import { createBrowserCommandLog } from "./browser-command-log.mjs";
import { saveBrowserCommandRecords } from "./browser-command-records.mjs";
import {
  apps,
  launchApp,
  sameComputer,
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
  // The computer Reach serves (tests run a Windows one anywhere).
  const hostPlatform = overrides.platform || process.platform;
  const config = getConfig(overrides);
  config.roots = config.roots.map((p) => fs.realpathSync.native(p));
  if (config.agentPolicyRequired || fs.existsSync(config.agentPolicyFile))
    readAgentPolicy(config.agentPolicyFile);
  config.privatePaths = [
    ...(config.privatePaths || []),
    config.agentPolicyFile,
  ];
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  // Windows builds its app-icon helper here (app-icons.mjs).
  useAppIconFolder(config.dataDir);
  // Settings changed from a paired phone persist; REACH_SCREEN only sets the default.
  const settingsFile = path.join(config.dataDir, "settings.json");
  // What each agent did on this Mac, for the owner (server/agent-actions.mjs).
  const agentActions = overrides.agentActions || createAgentActions({ file: path.join(config.dataDir, "agent-actions.jsonl") });
  const logAction = (client, entry) => { try { agentActions.add(client, entry); } catch { /* the log never stops an action */ } };
  // Reach's time and the agent's for each call, beside that log.
  const agentTimings = overrides.agentTimings || createAgentTimings({ file: path.join(config.dataDir, "agent-timings.jsonl") });
  const settings = { screen: config.screen, ...loadJson(settingsFile, {}) };
  config.screen = settings.screen === true;
  // Written by the Mac app, which owns the macOS privacy permissions.
  const hostFile = path.join(config.dataDir, "host.json");
  const deviceFile = path.join(config.dataDir, "device.json");
  const device = loadJson(deviceFile, { id: id() });
  device.computerId =
    (await computerIdentity()) || device.computerId || device.id;
  atomicJson(deviceFile, device);
  // Your first phone gets the whole computer, screen included: viewing comes
  // on with it, unless you've switched it yourself (Oct 10: "my phone gets
  // full control"). Control still takes macOS's own permissions.
  const auth = createAuth(config, {
    firstDevice: () => {
      overrides.onFirstDevice?.();
      if (settings.screenChosen || config.screen) return;
      settings.screen = config.screen = true;
      atomicJson(settingsFile, settings);
      console.log("Reach: screen viewing is on for your first phone (Settings → Screen viewing turns it off).");
    },
  }),
    terminals = overrides.terminals || new Terminals(),
    codex = new Codex(config),
    jobs = new Jobs(config),
    app = express(),
    server = http.createServer(app);
  // Agents and people invited before mascots draw theirs now, once.
  try {
    auth.dressMascots();
  } catch {
    /* an unreadable access store stays locked (503) as before */
  }
  const browserHostGuard = createBrowserHostGuard({ clients: () => auth.list(), ...overrides.browserHostGuard });
  // Any process on this Mac can claim one of your devices' Tailscale
  // identities on Reach's private socket, so an identity alone never approves
  // a device: your approval, Face ID, or a ticket a linked computer issued to
  // that device's own credential does (connections audit, Oct 10).
  const agentsActive = () => browserHostGuard.isActive();
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
  // Face ID on your phone confirms each agent connection you allow
  // (Settings → Agents): this computer's setting, in force only while a
  // passkey is set up here. Your own devices turn it on; never a guest's or
  // an agent's credential, which the settings and agents routes refuse.
  const faceIdForAgents = () =>
    settings.faceIdForAgents === true && !!passkeys?.has();
  // Who turns it on or off and asks for its Face ID challenges: your own
  // approved device on your Tailscale account, as for managing Face ID
  // itself (ownDevice below). Not a Face ID-joined browser, nor any other
  // kind of credential, whatever its scopes.
  const faceIdOwner = (req) => {
    const client = req.reauthorize();
    if (
      client.kind !== "device" ||
      !client.scopes.includes("admin") ||
      (config.tailscaleOwner && !ownerIdentity(req.reachIdentity, config.tailscaleOwner))
    )
      throw fail(403, "Only your own devices use Face ID for agents.");
    return client;
  };
  const settingBinding = (client) => `setting:faceIdForAgents:${client.id}`;
  // A Face ID answer checked on a signed-in route (the setting, an agent's
  // approval): refused, its 401 is marked so its reason ("for an earlier
  // attempt", "took too long"…) reaches the phone, not the routes' usual
  // "Access expired or was revoked.".
  const faceIdAnswer = (check) => {
    try {
      return check();
    } catch (e) {
      if (e?.status === 401) e.passkey = true;
      throw e;
    }
  };
  let privateServer, privateSocket;
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
  // Invite keys need phones approved by your Tailscale account: not before
  // this computer is set up, nor while a PC set up for it is on pairing codes
  // (scripts/launch.mjs signInOff). Said the same way wherever it's asked.
  const noInviteKeys = config.signInOff
    ? `Invite links are off on this ${computerWord(hostPlatform)} for now: ${config.signInOff}`
    : `Invite links need this computer set up with your Tailscale account: run ${command} configure on it.`;
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
  // Invited guests and agents that still have access here, and the node
  // each signed in with (an invitation's device goes once none does).
  const invitedClients = () =>
    auth.list().filter((c) => c.kind === "guest" || c.policy?.invite);
  const tidyGuests = () =>
    guestKeys?.configured() &&
    Promise.all([
      Promise.resolve()
        .then(() => {
          const invited = invitedClients();
          guestKeys.noteDevices(invited.map((c) => ({ clientId: c.id, nodeId: c.tailscale?.nodeId })));
          return guestKeys.reconcile({
            liveClients: new Set(invited.filter((c) => c.expiresAt > Date.now() && !["denied", "expired"].includes(c.status)).map((c) => c.id)),
          });
        })
        .catch((e) => console.log(`Reach: ${e.message}`)),
      tidyFace(),
    ]);
  // An agent's replaced credential used again: a copy of it is in use
  // somewhere. Its access has ended (core.mjs); everything it had open ends,
  // its device leaves, and you hear why.
  auth.onCredentialReuse((client) => {
    endSession(client.id);
    void releaseGuest(client);
    record("security", `${client.name || "An agent"}'s access ended: a copy of its credential was used`);
    notify({ category: "access", title: `${client.name || "An agent"}'s access ended`, body: "Its credential was used from two places, so a copy exists. Invite it again if this was expected.", tag: `agent-reuse-${client.id}` });
  });
  // Whatever way an invited client's access ends, its device leaves your
  // tailnet: by the node it signed in with, read before it was revoked.
  const releaseGuest = (client) =>
    client && guestKeys
      ?.revokeClient(client.id, client.tailscale?.nodeId ? [client.tailscale.nodeId] : [])
      .catch((e) => console.log(`Reach: ${e.message}`));
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
    if (client?.kind === "guest" && client.macEntry?.status === "waiting") return null;
    if (!browserHostGuard.allows(req, client)) return null;
    if (client && req.headers.upgrade?.toLowerCase() === "websocket") {
      if (client.policy?.browser) return null;
      // A live connection sends its credential in a message: kept, so the
      // host guard's 2-second check (trackIdentity) knows whose it is.
      req.reachCredential = token;
    }
    return client;
  };
  // Why `verify` refused a sound credential for a moment, if that's what
  // happened: Tailscale's word on the phone (whois) or on this Mac (the host
  // guard, while an agent has app access) hasn't come in time. An open
  // connection (a live screen, a terminal) ends as retryable then, not as
  // revoked: the phone reconnects, and is checked afresh (a device that was
  // removed is refused there). Before, a busy Mac or a network change stopped
  // the phone on "Screen access expired or was revoked" (Oct 7).
  const transientDenial = (req, token) => {
    if (!config.tailscaleOwner || funnelRequests.has(req)) return "";
    if (!(req.reachIdentity?.validUntil > Date.now()))
      return "Checking this phone's connection. Reconnecting…";
    if (
      browserHostGuard.isActive() &&
      !browserHostGuard.fresh() &&
      auth.verify(token, req.reachIdentity)
    )
      return `Checking this ${computerWord(process.platform)}'s connection. Reconnecting…`;
    return "";
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
          const token = req.headers.authorization?.replace(/^Bearer /, "") || req.reachCredential;
          // A live connection not signed in yet is checked when it is.
          if (token || !req.headers.upgrade) browserHostGuard.assertRequest(req, verify(req, token));
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
  // When each invited person and agent last used their access, in memory (a
  // restart forgets it): the owner's list says who is active and who is idle.
  const lastUse = new Map();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 65536,
    perMessageDeflate: false,
  });
  // How often a terminal's connection is asked if it's still there, and when
  // a refusal at the 64-connection limit was last said (reliability audit,
  // Oct 10).
  const terminalPingMs = overrides.terminalPingMs || 30000;
  let refusedFullAt = 0;
  const screenControl = new ScreenControl();
  // You using the Mac through Reach's screen holds agents off it, looks
  // included, until 2 minutes after your last input (server/screen.mjs).
  // Never part of blocked() below: chats' Claude app messages don't wait on it.
  const ownerHold = overrides.ownerHold || new OwnerHold();
  let agentDesktop = null, inputInFlight = false;
  const desktopAutomation = (overrides.desktopAutomationFactory || createDesktopAutomation)({
    // Why chats' Claude app work waits, named on the waiting message.
    blocked: () => {
      if (paused) return "Reach is paused";
      if (!transportAvailable) return "Reach's connection is down";
      if (screenControl.holder() || screenControl.inputStopping() || inputInFlight)
        return screenControl.holder()?.person ? `${screenControl.holder().name || "someone"} is controlling the Mac` : "you're controlling the Mac from your phone";
      const agent = agentDesktop ? agentDesktop.automationBusy?.() : false;
      return agent === false ? false : typeof agent === "string" ? agent : "an agent is using the Mac";
    },
  });
  screenControl.onAcquire = () => {
    for (const stopped of [desktopAutomation.interrupt(), agentDesktop?.yieldForOwner?.()])
      if (stopped) screenControl.retireInput(stopped);
  };
  // Every Codex and Claude Code session on this computer (Chat tab).
  const openClaw = overrides.openClaw || createOpenClaw({ dataDir: config.dataDir });
  // Chats move to and from OpenClaw too (agent-sessions/move.mjs).
  // Team chats (agent-sessions/teams.mjs, made below): their leads stay
  // Reach's and keep their tools on every launch and resume.
  let teams = null;
  const agentSessions =
    overrides.agentSessions ||
    (overrides.agentSessionsFactory || createAgentSessions)({
      dataDir: config.dataDir,
      openClaw,
      desktopAutomation,
      keepOut: (agent, id) => !!teams?.inTeam(agent, id),
      teamExtras: (agent, id) => teams?.leadExtras(agent, id) || null,
    });
  // Find sessions as soon as Reach runs, not when the Chat tab opens. Tests
  // (node --test) never reach for the real agents.
  if (!overrides.agentSessions && !process.env.NODE_TEST_CONTEXT)
    server.once("listening", () => agentSessions.warm?.());
  // The helper agents' file requests go through on a Mac, compiled once per
  // version of its source: at start, not inside an agent's first request,
  // which has 30 seconds (a cold Intel Mac compiles it for longer).
  // Stopped when Reach stops, as its other start-time builds are.
  const warming = new AbortController();
  if (process.platform === "darwin" && !process.env.NODE_TEST_CONTEXT)
    server.once("listening", () => void desktopBinary(config, "browser-files", { signal: warming.signal }).catch(() => {}));
  // A Windows PC's terminals helper too, so the phone's first look at the
  // PC's own terminals doesn't wait for csc (windows-terminals.mjs).
  if (process.platform === "win32" && !process.env.NODE_TEST_CONTEXT)
    server.once("listening", () => void windowsBinary(config, "windows-terminals", { signal: warming.signal }).catch(() => {}));
  // The Claude app's typefaces, for Claude's chats on the phone (fonts.mjs).
  const agentFonts = overrides.agentFonts || createAgentFonts();
  const appShortcuts = createAppShortcuts({
    dataDir: config.dataDir,
    // Terminal shortcuts open a Mac terminal window and run one command.
    macTerminal: (command, authorize) =>
      desktopTerminals.create("terminal", authorize, command),
    // On a Windows PC: Windows Terminal, else a console window, in the folder.
    windowsTerminal: ({ cwd, command }, authorize) =>
      desktopTerminals.create("windows-terminal", authorize, command, { cwd }),
    resolveFolder: (root, folder) => {
      const dir = resolve(root, folder);
      if (!fs.statSync(dir).isDirectory()) throw fail(400, "Choose a folder.");
      return dir;
    },
    ...overrides.appShortcuts,
  });
  // System-dialog input needs an owner device or explicit Full-person
  // consent (ScreenControl.ownerOnly).
  screenControl.dialogUp = () => (agentSessions.macDialogs?.() || []).length > 0;
  const desktopTerminals = new DesktopTerminals({ dataDir: config.dataDir, ...overrides.desktopTerminals });
  // The computer's own terminal windows (a Mac's Terminal and iTerm2, a
  // Windows PC's Windows Terminal and consoles), told by events while a
  // phone is connected; changes reach phones at once through their live
  // connection.
  const presenceNudges = new Set();
  const macTerminalWatch = new MacTerminalWatch({
    terminals: desktopTerminals,
    start: overrides.terminalWatch || terminalWatchHelper(config, { platform: desktopTerminals.platform }),
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
  // The computer's sound, for the phones listening beside its live screen
  // (server/screen-sound.mjs): one capture for all of them.
  const screenSound = new SoundHub(
    overrides.soundFactory ||
      soundPreparer(config, { platform: overrides.platform || process.platform, desktopBinary, windowsBinary }),
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
  // Reach's menu bar item, where a click opens the chat (on Windows, its
  // icon in the notification area: windowsTray below).
  let windowsTray = null;
  let waitingChats = [];
  if (agentSessions.onOutbox && agentSessions.waitingOnMac) {
    let listed = "[]";
    const showWaiting = () => {
      const chats = agentSessions.waitingOnMac();
      const next = JSON.stringify(chats);
      if (next === listed) return;
      listed = next;
      waitingChats = chats;
      appThreads.waiting(chats);
      windowsTray?.update({ waiting: chats });
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
      return items.findLast((item) => item.role === "assistant" && item.kind === "text" && item.text?.trim())?.text || "";
    },
  });
  // On every change of the chat list (its timer is only the slow fallback).
  agentSessions.onListChange?.(() => void doneWatch.look());
  // "Notify me when it's back", for an agent out of usage (usage-watch.mjs).
  const usageWatch = createUsageWatch({
    health: () => agentSessions.health({ fresh: true }),
    notify,
    file: process.env.NODE_TEST_CONTEXT ? null : path.join(config.dataDir, "usage-watch.json"),
    ...overrides.usageWatch,
  });
  usageWatch.start();
  // A turn's end, confirmed by reading the chat (agent-sessions/turn-watch.mjs).
  // One that stopped on a used-up limit says so on your phone, with the way
  // on: the chat offers to continue in another agent. It shares the chat's
  // "finished" tag, so it takes that notification's place.
  // What every agent did while you were away (agent-sessions/journal.mjs).
  const journal =
    overrides.journal ||
    createJournal({ file: process.env.NODE_TEST_CONTEXT ? null : path.join(config.dataDir, "agent-journal.json") });
  const turnWatch = createTurnWatch({
    list: () => agentSessions.list(),
    read: (agent, id) =>
      Promise.race([
        agentSessions.read(agent, id, { limit: 60 }),
        new Promise((_, no) => setTimeout(() => no(new Error("timeout")), 5000).unref?.()),
      ]),
    onEnded: ({ session: s, outcome }) => {
      journal.add(turnEvent({ session: s, outcome }));
      if (outcome.kind !== "error" || !usageLimited(s.agent, outcome.item)) return;
      const app = agentName(s.agent);
      return notify({
        category: "done",
        title: chatEventTitle(s.title, s.agent, "Out of usage"),
        body: `${app} stopped: it's out of usage. Open the chat to continue it with another agent.`,
        icon: s.agent,
        actions: [{ action: "open", title: "Open conversation" }],
        tag: `done-${s.agent}-${String(s.id).slice(0, 12)}`,
        url: `/?page=sessions&agent=${encodeURIComponent(s.agent)}&id=${encodeURIComponent(s.id)}`,
      });
    },
  });
  agentSessions.onListChange?.(() => void turnWatch.look());
  // Relays and second opinions (agent-sessions/relays.mjs): what one agent
  // did goes on to another, as set up from the phone. When a step sends, the
  // phone that set it up must still be one of your approved devices, and
  // Reach not paused; a new chat's folder is checked as one started here.
  const relays =
    overrides.relays ||
    createRelays({
      sessions: agentSessions,
      openClaw,
      file: process.env.NODE_TEST_CONTEXT && !overrides.relayFile ? null : overrides.relayFile || path.join(config.dataDir, "agent-relays.json"),
      authorized: (owner) =>
        paused ? "Reach is paused." : ownDevices().includes(owner) ? "" : "The phone that set this up no longer has access.",
      folder: (cwd) => sessionFolder(cwd),
      modes: async (agent) => ((await agentSessions.models(agent))?.modes || []).map((m) => m.id),
      notify: ({ relay, title, body }) => {
        const to = relay.chain.at(-1);
        journal.add({
          kind: relay.state === "stopped" ? "relay-stopped" : "relayed",
          agent: to?.agent || "",
          chat: to?.id || "",
          title: String(to?.title || relay.chain[0]?.title || "").slice(0, 200),
          text: pushLine(body, 200),
          at: Date.now(),
        });
        return notify({
          category: "done",
          title: pushLine(title, 90),
          body: pushLine(body, 180),
          icon: to?.agent || "agent",
          actions: [{ action: "open", title: "Open conversation" }],
          tag: `relay-${relay.id.slice(0, 8)}`,
          ...(to && { url: `/?page=sessions&agent=${encodeURIComponent(to.agent)}&id=${encodeURIComponent(to.id)}` }),
        });
      },
    });
  agentSessions.onListChange?.(() => void relays.check());
  // Team chats: a lead hands work to helpers through its tools, which reach
  // Reach on a private socket with the team's own key (team-bridge.mjs); a
  // named pipe of its own on Windows.
  const teamSocket = overrides.teamSocket || (process.platform === "win32" ? teamPipe(config.dataDir) : path.join(config.dataDir, "team.sock"));
  teams =
    overrides.teams ||
    createTeams({
      sessions: agentSessions,
      relays,
      file: process.env.NODE_TEST_CONTEXT && !overrides.teamFile ? null : overrides.teamFile || path.join(config.dataDir, "agent-teams.json"),
      keysDir: path.join(config.dataDir, "teams"),
      socketPath: teamSocket,
      script: fileURLToPath(new URL("../scripts/team-mcp.mjs", import.meta.url)),
      authorized: (owner) =>
        paused ? "Reach is paused." : ownDevices().includes(owner) ? "" : "The phone that started this team no longer has access.",
      folder: (cwd) => sessionFolder(cwd),
      modes: async (agent) => ((await agentSessions.models(agent))?.modes || []).map((m) => m.id),
      ready: () => teamBridgeOpen,
    });
  let teamBridgeOpen = false;
  const teamBridge = createTeamBridge({ socketPath: teamSocket, call: (token, tool, args) => teams.call(token, tool, args) });
  if (!process.env.NODE_TEST_CONTEXT || overrides.teamSocket)
    void teamBridge
      .listen()
      // Windows: a lead's bridge checks Reach's pipe with the owners helper
      // (scripts/team-mcp.mjs); Team is offered once it's built.
      .then((open) => (process.platform === "win32" ? prepareOwners(config.dataDir).then(() => open) : open))
      .then((open) => (teamBridgeOpen = open))
      .catch(() => {});
  teams.onChange?.(() => {
    for (const nudge of presenceNudges) nudge();
  });
  // Phones hear of a relay's progress as they hear of the chat list's.
  relays.onChange?.(() => {
    for (const nudge of presenceNudges) nudge();
  });
  // Workflows (agent-sessions/workflows.mjs): a plan of tasks for a folder,
  // run in order. Each task starts as a relay's step does, and only while the
  // phone that ran it still may; a pause or the end tells your phone.
  const workflows =
    overrides.workflows ||
    createWorkflows({
      sessions: agentSessions,
      openClaw,
      relays,
      availableAgents: async () => {
        const [health, claw] = await Promise.allSettled([agentSessions.health(), openClaw.overview()]);
        const ready = health.status === "fulfilled" ? readyForTasks(health.value) : [];
        if (claw.status === "fulfilled" && claw.value.connected) ready.push("openclaw");
        return ready;
      },
      models: async (agent) => (await agentSessions.models(agent)).models || [],
      file: process.env.NODE_TEST_CONTEXT && !overrides.workflowFile ? null : overrides.workflowFile || path.join(config.dataDir, "agent-workflows.json"),
      authorized: (owner) =>
        paused ? "Reach is paused." : ownDevices().includes(owner) ? "" : "The phone that ran this workflow no longer has access.",
      folder: (cwd) => sessionFolder(cwd),
      modes: async (agent) => ((await agentSessions.models(agent))?.modes || []).map((m) => m.id),
      notify: ({ workflow, title, body }) => {
        const task = workflow.tasks.find((t) => t.state === "stopped" || t.state === "uncertain") || workflow.tasks.findLast((t) => t.chat);
        // The phone is told first; noting it for the away report can't stop that.
        const sent = notify({
          category: "done",
          title: pushLine(title, 90),
          body: pushLine(body, 180),
          icon: task?.agent || "agent",
          actions: [{ action: "open", title: "Open conversation" }],
          tag: `workflow-${workflow.id.slice(0, 8)}`,
          ...(task?.chat && { url: `/?page=sessions&agent=${encodeURIComponent(task.chat.agent)}&id=${encodeURIComponent(task.chat.id)}` }),
        });
        try {
          journal.add({
            kind: workflow.state === "done" ? "workflow-done" : "workflow-paused",
            agent: task?.agent || "",
            chat: task?.chat?.id || "",
            title: String(workflow.title || "").slice(0, 200),
            text: pushLine(body, 200),
            at: Date.now(),
          });
        } catch {
          /* told already */
        }
        return sent;
      },
    });
  agentSessions.onListChange?.(() => void workflows.sync());
  workflows.onChange?.(() => {
    for (const nudge of presenceNudges) nudge();
  });
  // Tag in: agents use apps on their own hidden displays and hand them to
  // you on the phone (server/agent-apps.mjs).
  const agentApps = new AgentApps({
    actions: logAction,
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
  // Started paused: the Mac dialog watcher stays off too.
  if (paused) agentSessions.pauseMacPrompts?.(true);
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
      if (!value) auth.restartQuietClock();
      settings.paused = value;
      atomicJson(settingsFile, settings);
      windowsTray?.update({ paused: value });
      if (value) {
        desktopAutomation.interrupt();
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
        screenSound.stop(PAUSED, true);
        // Nothing on a paused Mac captures its screen (Oct 12: the Mac's
        // screen-sharing mark stayed on, so Netflix wouldn't play): the
        // dialog watcher stops, and a screen helper an earlier Reach left
        // running is ended.
        (overrides.sweepScreenHelpers || sweepScreenHelpers)({ dataDir: config.dataDir });
      }
      agentSessions.pauseMacPrompts?.(value);
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
  // Reach's icon in the Windows notification area, with Pause and Resume, as
  // a Mac has its menu bar item (windows-tray.mjs). Tests never start the
  // real helper.
  if (overrides.windowsTray || (process.platform === "win32" && !process.env.NODE_TEST_CONTEXT))
    server.once("listening", () => {
      windowsTray = (overrides.windowsTray || createWindowsTray)({
        dataDir: config.dataDir,
        onMenu: (value) => appThreads.onMenu(value),
      });
      windowsTray.update({ paused, waiting: waitingChats });
    });
  // The app in front on the Mac, from the menu bar's helper: a message
  // waiting because you're in the Claude app goes in once you leave it.
  appThreads.onFrontmost = (bundle) => {
    desktopAutomation.noteForeground(bundle);
    agentSessions.frontmost?.(bundle);
  };
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
    ownerUsing: () => ownerHold.active(), platform: overrides.platform || process.platform,
  });
  // The owner's pause of one agent ("it can look, not touch"), on every
  // computer: it used to live in the Mac-only desktop service below, so off a
  // Mac pausing an agent did nothing. One store, kept across restarts; the
  // desktop service, where there is one, acts on it.
  const agentPauses = overrides.agentPauses || createAgentPauses({ file: path.join(config.dataDir, "agent-pauses.json") });
  // Screen, input and the app list for preset agents (server/agent-desktop.mjs):
  // a Mac's Swift helper, or a Windows PC's C# one, built in the folder Reach
  // confirmed private this start (scripts/launch.mjs); without that folder it
  // says why, and the screen presets refuse with that reason. Tests inject a
  // stand-in; null means this computer can't offer them.
  agentDesktop = overrides.agentDesktop !== undefined ? overrides.agentDesktop : (["darwin", "win32"].includes(process.platform) || overrides.agentDesktopFactory ? (overrides.agentDesktopFactory || createAgentDesktop)(config, {
    ...(process.platform === "win32" ? { windowsHelper: overrides.windowsDesktopHelper || null, helpersOff: overrides.windowsHelpersOff || "" } : {}),
    available: () => browserScreenAvailable() && !paused && transportAvailable,
    hosts: () => reachAddresses(config), titles: () => ["reach"], protectedPaths: () => browserPaths(),
    verifyClient: (id) => auth.list().find((client) => client.id === id),
    // Who controls (their name), or true while the last one's input stops.
    phoneControls: () => {
      const held = screenControl.holder();
      return held?.person ? held.name || "Someone" : !!held || screenControl.inputStopping();
    },
    ownerUsing: () => ownerHold.active(),
    // A chat waiting on an agent gets the next turn (the agent's input waits a
    // moment), and the agent looks again after a chat drove the Mac.
    automationControls: () => desktopAutomation.active() || desktopAutomation.wanted?.() === true,
    screenChangedAt: () => desktopAutomation.changedAt?.() ?? 0, paused: () => paused, record, actions: logAction,
    pauses: agentPauses,
  }) : null);
  // Agents that can see or use this Mac (Full control, Apps, Read-only).
  const screenAgentIds = () => auth.list()
    .filter((client) => client.kind === "agent" && client.policy?.browser === true && client.policy?.preset !== undefined && client.expiresAt > Date.now())
    .map((client) => client.id);
  // Agents that look at the screen at all: these presets, and those shown
  // only chosen app windows.
  // Only an agent that joined counts: an invitation nobody opened (or one
  // that lapsed, or waits for your approval) can't touch the screen, so it
  // doesn't put up "Agents wait" (an unused Always invite did, Oct 13).
  const screenAgentsPresent = () => auth.list().some((client) => client.kind === "agent" &&
    client.policy?.browser === true && (client.policy.preset !== undefined || client.policy.screen === "apps") && client.expiresAt > Date.now() &&
    (client.status === undefined || client.status === "accepted"));
  // Your input went through Reach's screen (a tap, a key, a scroll): agents
  // wait. Input on one of Reach's hidden app displays doesn't touch the
  // screen agents use, so it doesn't hold them. The phones hear at once.
  const ownerUsed = (client, display) => {
    if (display && display !== "primary" && appThreads.ownsDisplay(display)) return;
    if (ownerHold.note(client)) for (const nudge of presenceNudges) nudge();
  };
  // The owner pauses (or resumes) one agent: the desktop, where there is one,
  // lets go of what the agent holds first, then the pause is kept. A pause
  // that can't be saved still holds now (507, agent-pauses.mjs).
  const pauseAgent = (id, value) => {
    if (value) agentDesktop?.letGo?.(id);
    return agentPauses.set(id, value);
  };
  const agentPaused = (id) => agentPauses.has(id);
  // Every such agent paused at once, and the owner told why: who was paused
  // is unknown (the saved pauses unreadable) or Reach ended unexpectedly.
  const pauseScreenAgents = (why) => {
    let added = [];
    try {
      const ids = screenAgentIds();
      for (const id of ids) agentDesktop?.letGo?.(id);
      added = agentPauses.add(ids);
    } catch (error) {
      console.warn(`Reach: ${error.message}`);
    }
    if (added.length) {
      record("agent", `Paused ${added.length === 1 ? "an agent" : `${added.length} agents`}: ${why}`);
      notify({ category: "access", title: added.length === 1 ? "An agent is paused" : `${added.length} agents are paused`, body: `${why} Resume them in Agents when you're ready.`, icon: "agent", tag: "agents-paused-restart" });
    }
    return added;
  };
  agentPauses.prune((id) => auth.list().some((client) => client.id === id));
  if (agentPauses.unreadable) pauseScreenAgents("Reach couldn't read which agents you had paused, so it paused them all.");
  // Logs capped, old command histories cleared, files sent from the phone
  // cleared when the disk runs low, at start and every 6 hours
  // (server/tidy.mjs). Tests opt in.
  const tidying = overrides.tidy !== false && (overrides.tidy || !process.env.NODE_TEST_CONTEXT)
    ? startTidying({ dataDir: config.dataDir, ...(typeof overrides.tidy === "object" ? overrides.tidy : {}) })
    : null;
  // The last Reach here ended without being asked to (crash-guard.mjs): what
  // it left in memory is gone, so agents that can use this Mac wait for the
  // owner, who hears why.
  const runMarker = overrides.runMarker ?? !process.env.NODE_TEST_CONTEXT;
  const lastRun = overrides.previousRun !== undefined ? overrides.previousRun : runMarker ? previousRun(config.dataDir) : null;
  if (runMarker) markRunning(config.dataDir);
  if (lastRun?.unclean) {
    const why = restartReason(lastRun);
    console.warn(`Reach: ${why.replace(/^Reach /, "")}`);
    if (!pauseScreenAgents(why).length)
      notify({ category: "computer", title: "Reach started again", body: why, tag: "reach-restarted" });
  }
  const agentShortcuts = createAgentShortcuts({ dataDir: config.dataDir, desktop: agentDesktop, record, actions: logAction });
  // Saved tools on this Mac: where macOS Automation and the browser's own
  // setting stand, macOS's prompt on request, the settings page opened.
  // Shown to the owner only once a tool needed it (routes below).
  // On a Windows PC, saved tools reach Chrome and Edge through Reach's
  // extension (docs/parity/G-browser-tools.md): its native host's pipe, here;
  // a browser asking to connect waits for the owner's tap in Agents → Browser tools.
  const browserExtension = overrides.browserExtension !== undefined ? overrides.browserExtension
    : process.platform === "win32" ? createBrowserExtensionBridge({
      dataDir: config.dataDir,
      onPairingRequest: (browser) => {
        record("agent", `${browser}'s Reach extension asks to connect`);
        notify({ category: "access", title: `${browser}'s Reach extension asks to connect`, body: "Allow it once: Agents → Browser tools → Allow.", icon: "agent", tag: `tool-setup-${browser}`, actions: [{ action: "open", title: "Allow" }] });
      },
    }) : null;
  if (browserExtension && !overrides.browserExtension)
    browserExtension.start().catch((error) => console.warn(`Reach: the browser extension's pipe couldn't open: ${String(error?.message || error).slice(0, 200)}`));
  const toolSetup = createToolSetup({ config, extension: browserExtension,
    register: () => registerExtensionHost({ dataDir: config.dataDir, pipe: browserExtension.pipe }), ...overrides.toolSetup });
  // The host registered at start, so an extension added from the store connects at once.
  if (browserExtension && process.platform === "win32" && !process.env.NODE_TEST_CONTEXT)
    server.once("listening", () => void toolSetup.prepare?.().catch(() => {}));
  const agentTools = createAgentTools(config, { desktop: agentDesktop, record, actions: logAction, hosts: () => reachAddresses(config), extension: browserExtension,
    // Batches record the round trips they spared (savings.mjs, "tab-batch").
    savings: { record: (entry) => savings.record(entry) },
    // The owner hears once that an agent's tool needs a browser; one tap in
    // Agents → Browser tools allows it.
    onSetupRequired: (browser, agentName) => {
      if (!toolSetup.needed(browser)) return;
      record("agent", `${agentName}'s tool needs ${browser} allowed`);
      notify({ category: "access", title: `${pushLine(agentName, 48)}'s tool needs ${browser}`, body: "Allow it once: Agents → Browser tools → Allow.", icon: "agent", tag: `tool-setup-${browser}`, actions: [{ action: "open", title: "Allow" }] });
    },
    ...(overrides.browserToolOptions || {}) });
  // An agent's ask for a Mac permission it lacks: the owner's one tap on the
  // phone (permission-requests.mjs).
  const permissionRequests = createPermissionRequests({ toolSetup, access: macAccess(config), notify, record, platform: process.platform, ...overrides.permissionRequests });
  const agentServices = createAgentServices({ record, notify,
    connectors: createServiceConnectors(agentTools),
    verifyClient: (id) => {
      const client = auth.list().find((entry) => entry.id === id);
      return client ? applyAgentPolicy(client, config) : null;
    },
    available: () => !paused && transportAvailable,
    paused: agentPaused,
    ...(overrides.serviceOptions || {}),
  });
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
  // A history that can't be opened (a link, loose permissions) turns agent
  // commands off and says why; it never stops Reach from starting (it did:
  // reliability audit, Oct 10).
  const browserCommandLog = await createBrowserCommandLog({ dir: path.join(config.dataDir, "browser-commands") }).catch((error) => {
    const why = `Agent commands are off: their history can't be kept (${error.message})`;
    console.error(`Reach: ${why}`);
    const off = async () => { throw fail(503, `${why}.`); };
    return { append: off, history: off, close: async () => {} };
  });
  // What the sandbox around agents' commands and jobs denies. On a Mac it's the
  // sandbox-exec deny list (agentShellSandbox); on Windows the AppContainer
  // descriptor (server/windows-sandbox.mjs), which the hash-verified helper runs
  // the job inside — the deny set mirrors the Mac's (findings 1, 5). null on any
  // other platform. Reach's sockets wherever they are: the private one Tailscale
  // uses, and the permission-prompt one in the temp folder when the data
  // folder's path is too long for a socket (an agent could post prompts to you).
  const jobSandbox = (client) => overrides.jobSandbox !== undefined ? overrides.jobSandbox
    : process.platform === "darwin" ? agentShellSandbox(config, { sockets: [...(privateSocket ? [path.dirname(privateSocket)] : []), agentAskSocket(config.dataDir)] })
    : process.platform === "win32" ? windowsJobSandbox(config, client, { sockets: privateSocket ? [path.dirname(privateSocket)] : [] })
    : null;
  // The Windows command sandbox: it builds the helper once in the private folder
  // D confirmed this launch (overrides.windowsSandboxHelper) and runs the launch
  // self-test at start (§2.2). Absent that folder, or where policy blocks it,
  // the jobs POST refuses with the reason. null off Windows.
  const windowsSandbox = process.platform === "win32"
    ? createWindowsSandbox({ helper: overrides.windowsSandboxHelper || null, off: overrides.windowsHelpersOff || "" })
    : null;
  // The grants ledger and its revoke walk (§4.6): a changed or revoked session
  // loses its capability on the next launch with no walk; this reclaims the
  // on-disk ACEs. null off Windows and when the sandbox isn't prepared.
  const windowsGrants = windowsSandbox && overrides.windowsSandboxHelper
    ? createWindowsGrantLedger({ dir: config.dataDir, revoke: windowsRevoker(windowsSandbox) })
    : null;
  // The shell for Full control agents (server/agent-shell.mjs): logged with
  // the other agent commands. On Windows its production runner is injected here
  // (not through the test override): a Job Object on the owner's token, no
  // AppContainer, which ignores the Mac env createAgentShell passes (§3.2).
  const agentShell = createAgentShell({ commandLog: browserCommandLog, actions: logAction,
    record, ...(overrides.agentShellRun ? { run: overrides.agentShellRun }
      : process.platform === "win32" ? { run: windowsShellRunner(windowsSandbox) } : {}) });
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
      if (action.type === "terminal-script") { authorize(); return runBrowserScript(action, () => { notPaused(); return authorize(); }, { resolve, config, privatePaths: browserPaths(), coordinator: browserOperations, windowsSandbox }); }
      const actions = browserRequestActions(action);
      const batch = action.type === "batch";
      if (actions.every((step) => ["terminal", "terminal-change"].includes(step.type))) {
        let output;
        for (const [index, step] of actions.entries()) {
          const check = () => { notPaused(); return authorize(); };
          check();
          if (batch) await progress(index, "executing");
          // On Windows each file step goes through the sandbox's Files broker
          // (browser-file-boundary.mjs), as the Mac's goes through its helper.
          output = step.type === "terminal-change"
            ? await runBrowserMutation(step, check, { resolve, config, privatePaths: browserPaths(), coordinator: browserOperations, windowsSandbox })
            : await runTerminalCommand(step, check, resolve, { config, privatePaths: browserPaths(), windowsSandbox });
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
  // A hosted agent's tool call (hosted-mcp.mjs), carried to the inner routes
  // as a request of Reach's own to its loopback port: the context the MCP
  // endpoint verified stands as the request's identity, as the gateway's
  // does. The id is one-time and the request must come from this machine.
  const hostedContexts = new Map();
  const hostedDispatch = (context, { timeout = 35000 } = {}) => new Promise((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address !== "object") return reject(Object.assign(Error("Reach isn't serving its routes yet."), { status: 503 }));
    const id = crypto.randomUUID();
    for (const [key, entry] of hostedContexts) if (entry.until < Date.now()) hostedContexts.delete(key);
    hostedContexts.set(id, { context, until: Date.now() + 60_000 });
    const req = http.request({ host: "127.0.0.1", port: address.port, method: context.method, path: context.path,
      headers: { host: new URL(config.publicOrigin).host, "x-reach-hosted": id, accept: "application/json, image/jpeg, image/png" }, timeout }, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) return req.destroy(Object.assign(Error("The response exceeds 8 MiB."), { status: 502 }));
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(Object.assign(Error("The request took too long."), { status: 504 })));
    req.once("error", (error) => { hostedContexts.delete(id); reject(error); });
    req.end();
  });
  app.use((req, res, next) => {
    const id = req.headers["x-reach-hosted"];
    if (typeof id !== "string") return next();
    const entry = hostedContexts.get(id);
    hostedContexts.delete(id);
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket?.remoteAddress);
    if (!entry || !local || entry.until < Date.now()) { res.statusCode = 403; return res.end(); }
    delete req.headers["x-reach-hosted"];
    funnelRequests.set(req, entry.context);
    req.reachIdentity = null;
    for (const name of Object.keys(req.headers)) if (name.startsWith("tailscale-user-")) delete req.headers[name];
    req.body = entry.context.body || {};
    req.headers.authorization = `Bearer ${entry.context.token}`;
    next();
  });
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
        "GET, POST, PUT, PATCH, DELETE, OPTIONS",
      );
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    // Reached by its Tailscale name, it's only ever HTTPS: browsers keep it so.
    if (/\.ts\.net(:\d+)?$/i.test(req.headers.host || ""))
      res.setHeader("Strict-Transport-Security", "max-age=31536000");
    // The page talks to this computer and your others on the tailnet
    // (*.ts.net) only: a script that got in can't send a credential anywhere
    // else (connections audit, Oct 10). This computer's own loopback only
    // when the page itself was opened there (local mode).
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || "");
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self' https://*.ts.net wss://*.ts.net${local ? " http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*" : ""}; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
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
      // How this computer's Reach is run, for the phone's hints: reach,
      // ./reach, or .\reach.cmd on Windows (scripts/home.mjs).
      command,
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
  // A person who came in while an agent had Full control or Apps waits for
  // your Allow (auth.allowPerson): you hear who, once, with their device.
  const personWaiting = (person) => {
    const name = person.name || "Someone";
    const device = person.macEntry?.nodeName ? ` on ${person.macEntry.nodeName}` : "";
    record("guest", `${name} is waiting to come in${device}`);
    notify({ category: "access", title: `${name} wants to come in`, body: `An agent is using this Mac, so you allow each new person once${device ? ` (${person.macEntry.nodeName})` : ""}.`, icon: "agent", tag: `person-waiting-${person.id}` });
    for (const nudge of presenceNudges) nudge();
  };
  const redeemRoutes = ["/api/guest/redeem", "/api/invitations/redeem"];
  app.use("/api", async (req, res, next) => {
    const route = (req.originalUrl || req.url || "").split("?", 1)[0];
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const context = funnelRequests.get(req);
    const verified = () => context ? context.token === token && auth.verifyFunnel(token, context.keyThumbprint) : auth.verify(token, req.reachIdentity);
    // A person waiting for your Allow reads that, whatever else is going on.
    if (token && !context) {
      let client = verified();
      if (client?.kind === "guest" && agentsActive()) {
        await browserHostGuard.refresh();
        if (browserHostGuard.needsPersonApproval(req, client)) {
          const waiting = auth.holdPerson(client.id, req.reachIdentity);
          if (waiting) personWaiting(waiting);
          client = verified();
        }
      }
      if (client?.kind === "guest" && client.macEntry?.status === "waiting") {
        // Leave, while waiting: their access ends, and your card with it.
        if (req.method === "DELETE" && route === "/api/device/access") {
          endClient(client.id);
          void releaseGuest(client);
          for (const nudge of presenceNudges) nudge();
          return res.json({ ok: true });
        }
        throw Object.assign(fail(403, personWaitingMessage), { waiting: true });
      }
    }
    if (agentsActive()) {
      await browserHostGuard.refresh();
      const client = verified();
      if (!auth.isBrowserAppAdmission(req) && !browserHostGuard.allows(req, client)) {
        // A person opening their invitation comes in beside the agent, and
        // waits for your Allow (the redeem route holds them). Not on this
        // Mac itself: the agent drives it.
        const invited = req.method === "POST" && redeemRoutes.includes(route)
          ? auth.unopenedInvitation(req.body?.invitation) : null;
        if (invited?.kind === "guest") {
          if (browserHostGuard.onHost(req)) throw fail(403, personOnHostMessage);
          return next();
        }
        browserHostGuard.assertRequest(req, client);
      }
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
  app.post("/api/auth/requests", async (req, res) => {
    if (!approvals)
      throw fail(
        404,
        `Run ${command} configure on the computer to enable device approval.`,
      );
    // A ticket from a linked computer (src/fleet-join.ts): approved at once
    // when that computer issued it to this very device, refused otherwise, so
    // a phone joining your computers never leaves a request waiting. Without
    // one, you approve (or Face ID): an identity alone never does.
    const ticket = req.body?.ticket;
    const from =
      ticket === undefined
        ? null
        : await fleet?.ticketApproval(req.reachIdentity, ticket);
    if (ticket !== undefined && !from)
      throw fail(403, "Your other computer didn't vouch for this device.");
    // From this computer itself (its own Tailscale address, as tailscaled
    // says): anyone signed in to it could have asked as you. Its prompt says
    // so, on a Mac as on Windows, and only the code typed there approves it:
    // Face ID on the phone would skip the warning (docs/parity/D-public-door.md
    // §0.8, D1).
    const fromHere = thisComputerRequest(req) || sameComputer(req, await ownTailscaleIps());
    const created = approvals.request(
      req.reachIdentity,
      req.body?.name,
      config.tailscaleOwner,
      fromHere ? { thisComputer: true } : undefined,
    );
    // A linked computer's ticket vouches for a device, not for whoever is
    // signed in here: from this computer itself, only the code typed here.
    if (from && !fromHere)
      try {
        approvals.decide(created.id, "approve", from);
      } catch {}
    res
      .status(202)
      .json({ ...created, ...(passkeys?.has() && !fromHere ? { passkey: true } : {}) });
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
    const pending = approvals.pending(
      req.params.id,
      req.body?.secret,
      req.reachIdentity,
      config.tailscaleOwner,
    );
    if (pending.thisComputer)
      throw fail(403, `This request came from this ${computerWord(hostPlatform)} itself: type its code in Reach on the ${computerWord(hostPlatform)} instead.`);
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
  // A refused add says why, in Reach's terminal and in the security record,
  // never with anything of the answer itself: the owner's adds were refused
  // for days with nothing said on the Mac (Oct 13). The same reason again
  // within 10 s is said once.
  let refusedAdd = { line: "", at: 0 };
  const notAdded = (e) => {
    const line = `Face ID not added: ${e?.status ? e.message : `Reach couldn't check it (${e?.name || "an error"} on this computer).`}`;
    if (line !== refusedAdd.line || Date.now() - refusedAdd.at > 10000) {
      console.log(`Reach: ${line}`);
      record("security", line);
    }
    refusedAdd = { line, at: Date.now() };
  };
  app.post("/api/auth/passkeys/options", (req, res) => {
    try {
      const client = ownDevice(req);
      res.json(
        passkeys.registrationOptions(
          client.id,
          req.reachIdentity.login || config.tailscaleOwner.login,
        ),
      );
    } catch (e) {
      notAdded(e);
      throw e;
    }
  });
  app.post("/api/auth/passkeys", (req, res) => {
    let added;
    try {
      const client = ownDevice(req);
      added = passkeys.register(
        client.id,
        req.body?.credential,
        req.body?.label,
      );
    } catch (e) {
      notAdded(e);
      throw e;
    }
    // The terminal line stays fixed; the phone's own words (its label) go
    // only to the activity record, one line.
    console.log("Reach: Face ID added.");
    record("security", `Face ID added (${String(added.label).replace(/[\r\n]+/g, " ")})`);
    res.status(201).json(added);
  });
  app.delete("/api/auth/passkeys/:id", (req, res) => {
    ownDevice(req);
    // The last passkey stays while Face ID confirms agent approvals: turn
    // that off first (with Face ID), so a credential alone never lifts it.
    if (faceIdForAgents() && !passkeys.list().some((p) => p.id !== req.params.id))
      throw fail(409, "Face ID confirms agent approvals. Turn that off in Settings → Agents first, then remove this Face ID.");
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
    const joined = auth.redeemGuest(req.body?.invitation, req.reachIdentity, { hold: agentsActive() });
    if (joined.waiting) personWaiting(auth.list().find((client) => client.id === joined.clientId) || { id: joined.clientId });
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
        req.body?.code,
        req.body?.name,
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
        `This ${computerWord(process.platform)} uses agent profiles. Ask its owner for a scoped CLI credential.`,
      );
    // Only the verified private transport can assign a device identity.
    // Ordinary callers may supply forwarding headers, so never use them
    // to select a fresh request budget.
    const address =
      req.reachIdentity?.nodeId ||
      req.socket.remoteAddress ||
      "unknown";
    const now = Date.now();
    for (const [key, times] of requestAttempts) {
      const live = times.filter((t) => t > now - 60000);
      if (live.length) requestAttempts.set(key, live);
      else requestAttempts.delete(key);
    }
    const recent = requestAttempts.get(address) || [];
    if (recent.length >= 5)
      throw fail(429, "Too many access requests. Try again in one minute.");
    requestAttempts.set(address, [...recent, now]);
    if (pendingRequests().length >= 20)
      throw fail(429, "Too many pending requests. Review them in Reach first.");
    const name = String(req.body?.name || "")
      .trim()
      .slice(0, 80);
    const scopes = req.body?.scopes;
    if (!name) throw fail(400, "Give this agent a name.");
    if (
      !Array.isArray(scopes) ||
      !scopes.length ||
      scopes.some((s) => !AGENT_SCOPES.includes(s))
    )
      throw fail(400, `Choose scopes from: ${AGENT_SCOPES.join(", ")}.`);
    const secret = crypto.randomBytes(24).toString("base64url");
    // The device that asked: only it collects the answer, and what you
    // approve works from it alone (security audit L1).
    const asker = req.reachIdentity?.nodeId
      ? { nodeId: req.reachIdentity.nodeId, userId: req.reachIdentity.userId || "", ...(req.reachIdentity.tagged ? { tagged: true } : {}) }
      : null;
    const request = {
      id: id(),
      name,
      scopes: [...new Set(scopes)],
      secretHash: hash(secret),
      status: "pending",
      createdAt: new Date(now).toISOString(),
      expiresAt: now + 10 * 60000,
      ...(asker ? { asker, ...(req.reachIdentity.nodeName ? { nodeName: String(req.reachIdentity.nodeName).slice(0, 160) } : {}) } : {}),
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
      !sameHash(r.secretHash, hash(String(req.headers["x-request-secret"] || ""))) ||
      (r.asker && (req.reachIdentity?.nodeId !== r.asker.nodeId || (req.reachIdentity.userId || "") !== r.asker.userId))
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
  // Asked by linked computers: redeem a ticket this computer issued.
  app.post("/api/fleet/tickets/redeem", (req, res) => {
    if (!fleet) throw fail(404, "This action does not exist.");
    res.json(fleet.redeemTicket(req.reachIdentity, req.body?.ticket));
  });
  // Asked back by linked computers: did this one revoke that device?
  app.post("/api/fleet/revoked/check", (req, res) => {
    if (!fleet) throw fail(404, "This action does not exist.");
    res.json(fleet.revokedCheck(req.reachIdentity, req.body));
  });
  // A linked computer revoked one of your devices: revoke it here too.
  app.post("/api/fleet/revoked", async (req, res) => {
    if (!fleet) throw fail(404, "This action does not exist.");
    const { userId, nodeId } = await fleet.confirmRevoked(req.reachIdentity, req.body);
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
  // A one-use ticket a linked computer redeems here to let this same device
  // in (server/fleet.mjs): only your own approved devices get one.
  app.post("/api/fleet/tickets", (req, res) => {
    if (!fleet) throw fail(404, "This action does not exist.");
    const client = verify(
      req,
      req.headers.authorization?.replace(/^Bearer /, ""),
    );
    if (!client)
      return res.status(401).json({ error: "Access expired or was revoked." });
    const binding = client.tailscale;
    if (
      client.kind !== "device" ||
      !client.scopes.includes("admin") ||
      !binding?.nodeId ||
      binding.userId !== config.tailscaleOwner.userId
    )
      throw fail(403, "Only your own approved devices can join your other computers.");
    res.json({ ticket: fleet.issueTicket(binding) });
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
    const scope = ["/browser/agents", "/browser/agents/stop", "/browser/agents/pause", "/browser/agents/reopen", "/browser/agents/clear"].includes(req.path) ? "admin" : {
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
      // Reach's own updates (reach-updates.mjs).
      reach: "admin",
      browser: "browser:read",
    }[route];
    // An invitation that may watch chosen apps' windows reaches only those
    // routes: the app list and the app windows themselves (no quit, no typing).
    // (The path is read here: later checks run after Express restores /api.)
    // Authorization and response guards belong to this exact request stage.
    // Named MCP dispatch re-enters routing with another method/path; an outer
    // response guard must keep checking the original dispatch grant.
    const subpath = req.path, requestMethod = req.method;
    const appWindows = (identity) =>
      identity.scopes?.includes("apps:open") &&
      ((route === "screen" &&
        /^\/screen\/apps(\/[^/]+(\/activate)?)?$/.test(subpath) &&
        ["GET", "POST", "PATCH", "DELETE"].includes(requestMethod)) ||
        (route === "apps" &&
          ((requestMethod === "GET" && subpath === "/apps") ||
            (requestMethod === "POST" && subpath === "/apps/icons"))));
    const allowed = (identity) =>
      identity?.policy?.browser
        ? browserRouteAllowed(identity, requestMethod, subpath)
        : identity &&
      !(
        identity.kind === "guest" && GUEST_BLOCKED_ROUTES.includes(route)
      ) &&
      // Every AI session and the Mac's own dialogs: the owner's own devices
      // only. A list of who may, not of who may not: no other credential,
      // whatever it grants (or a kind added later), ever reaches them.
      (!["sessions", "push", "notifications", "reach"].includes(route) || identity.kind === "device") &&
      (route === "device" ||
        appWindows(identity) ||
        (scope &&
          (identity.scopes?.includes(scope) ||
            (route === "files" &&
              identity.scopes?.includes(
                ["GET", "HEAD"].includes(requestMethod)
                  ? "files:read"
                  : "files:write",
              )))));
    if (!allowed(client))
      return res.status(403).json({
        error: scope
          ? `This credential does not grant ${scope} access.`
          : "This action is not available.",
      });
    // The owner's pause, for every route that acts on the Mac (the desktop
    // checks its own input): a paused agent looks but never runs or changes
    // anything, here and before each later step of a running call.
    const acts = client.policy?.preset !== undefined && requestMethod === "POST" &&
      ["/browser/shell", "/browser/files/change", "/browser/desktop/mac-shortcuts/run", "/browser/shortcuts/run",
        "/browser/tools/run", "/browser/tools/batch", "/browser/services/run"].includes(subpath);
    const ownerPaused = (identity) => acts && agentPaused(identity.id);
    const PAUSED_AGENT = "The owner paused this agent. It can look, not touch, until they resume it.";
    if (ownerPaused(client)) return res.status(409).json({ error: PAUSED_AGENT, kind: "paused" });
    req.client = client;
    // Its hourly key trade isn't use: an idle agent stays idle.
    if ((client.kind === "guest" || client.kind === "agent") && subpath !== "/device/rotate")
      lastUse.set(client.id, Date.now());
    // A route's scope can stay the same while its folders or app policy
    // change. Never finish an old request using data from the former grant.
    const grant = (identity) => JSON.stringify([identity?.scopes, identity?.agentRoots, identity?.guestApps, identity?.policy]);
    const initialGrant = grant(client);
    const stillAllowed = (identity) => allowed(identity) && grant(identity) === initialGrant;
    const credential = req.headers.authorization?.replace(/^Bearer /, "");
    const reauthorize = (allowFinishedResponse = false) => {
      const current = verify(req, credential);
      if (!stillAllowed(current) || (res.destroyed && !(allowFinishedResponse && res.writableFinished)))
        throw fail(401, "Access expired or was revoked.");
      if (ownerPaused(current)) throw Object.assign(fail(409, PAUSED_AGENT), { kind: "paused" });
      req.client = current;
      return current;
    };
    req.reauthorize = () => reauthorize();
    // Accepted background maintenance outlives a successfully sent response.
    // Keep checking the original credential and route access before each step;
    // a prematurely disconnected response never grants background access.
    req.reauthorizeJob = () => reauthorize(true);
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
    const untilExpiry = (client.expiresAt || Date.parse(client.createdAt) + 30 * 86400000) - Date.now();
    const deadline = setTimeout(
      () => {
        if (!stillAllowed(verify(req, credential))) disconnect();
      },
      Number.isFinite(untilExpiry) ? Math.min(2147483647, Math.max(0, untilExpiry)) : 2147483647,
    );
    const check = setInterval(() => {
      if (!stillAllowed(verify(req, credential))) disconnect();
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
      if (res.statusCode < 400 && !stillAllowed(verify(req, credential)))
        res.status(401);
      // A refused Face ID answer keeps its own reason while the credential
      // is still good (faceIdAnswer): said as "Access expired or was
      // revoked.", it read on the phone as its own access gone (Oct 13).
      if (
        res.statusCode === 401 &&
        !(body?.passkey === true && stillAllowed(verify(req, credential)))
      )
        return json({
          error: "Access expired or was revoked.",
        });
      return json(body);
    };
    next();
  });
  // How long each of an agent's calls takes here, and the agent between
  // them (agent-timings.mjs): no content, only kinds and times.
  app.use("/api", (req, res, next) => agentTimings.middleware(req, res, next));
  app.get("/api/device", async (req, res) => {
    agentRuntimes.note(req.client, req.query.runtime, { program: !fromBrowserPage(req) });
    const tools = req.client.scopes.includes("codex")
      ? await detectTools()
      : undefined;
    const people = !["agent", "guest"].includes(req.client.kind);
    const net = people ? await getNetwork() : { connected: !!config.publicOrigin, peers: [] };
    res.json({
      ...device,
      name: config.name,
      platform: process.platform,
      release: os.release(),
      arch: os.arch(),
      roots: (req.client.agentRoots ? req.client.agentRoots.map((path, id) => ({ id, path })) : refreshDriveRoots(config.roots, { platform: hostPlatform })).map(({ id, path: p }) => ({
        id,
        name: fileRootName(p),
        path: p,
      })),
      memory: { total: os.totalmem(), free: await availableMemory() },
      uptime: os.uptime(),
      network: net,
      // This browser runs on the computer itself (Oct 11: a Windows user
      // opened the link on the PC, and Screen showed the PC watching
      // itself). Only for the Screen page's notice: on Windows any local
      // program can write X-Forwarded-For, so it never decides access.
      ...(people && sameComputer(req, net.ips) && { sameComputer: true }),
      access: {
        kind: req.client.kind,
        scopes: req.client.scopes,
        expiresAt: req.client.expiresAt,
        profile: req.client.policy?.profile,
        ...(req.client.kind === "guest" && req.client.fullControlVersion === 1 ? { fullControlVersion: 1 } : {}),
        ...(req.client.policy?.browser && { browser: true }),
      },
      capabilities: deviceCapabilities({
        platform: overrides.platform || process.platform,
        owner: actsAsOwner(req.client),
        scopes: req.client.scopes,
        screen: config.screen,
        codexInstalled: tools?.codex.installed,
      }),
      ...(tools && { tools }),
      host: loadJson(hostFile, null),
      ...(paused && { paused: true }),
      // The runtime this computer serves agents: one on an older copy
      // fetches it below and offers the new tools (scripts/agent-remote.mjs).
      ...(req.client.kind === "agent" && agentRuntime() && { runtime: agentRuntime() }),
      // What it may do and the rules, for the agent itself (reach_device).
      ...(req.client.kind === "agent" && { guide: guideFor(req.client, { page: fromBrowserPage(req) }) }),
      // A copy too old to update itself: how to replace it, once.
      ...updateNotice({ client: req.client, req, served: servedRuntime(), host: (() => { try { return new URL(config.publicOrigin).hostname; } catch { return ""; } })() }),
    });
  });
  // That runtime itself, for an agent already admitted: its hash taken from
  // the very bytes sent, so the agent checks exactly what it would run.
  app.get("/api/device/runtime", (req, res) => {
    if (req.client.kind !== "agent") throw fail(403, "Only an agent updates its runtime here.");
    if (reachUpdates.busy()) throw fail(503, "Reach is updating. Try again once it has restarted.");
    let data;
    try { data = fs.readFileSync(overrides.agentRuntimeFile || fileURLToPath(new URL("../dist/agent.mjs", import.meta.url))); }
    catch { throw fail(404, "This computer has no agent runtime to send."); }
    res.setHeader("Cache-Control", "no-store");
    res.json({ sha256: crypto.createHash("sha256").update(data).digest("hex"), text: data.toString("utf8") });
  });
  // A browser that came in without the Tailscale app asks for its door key
  // here, over its private connection; its page keeps the key as a cookie for
  // the public link (core.mjs issueDoorKey; the door below).
  app.post("/api/device/door-key", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(auth.issueDoorKey(req.client.id));
  });
  // An agent on its own invited device trades its credential for a new one
  // (security audit M6; scripts/agent-remote.mjs).
  app.post("/api/device/rotate", (req, res) => {
    // Through the signed gateway (a public-link agent): with its key.
    const context = funnelRequests.get(req);
    res.json(context
      ? auth.rotateFunnelCredential(context.token, context.keyThumbprint)
      : auth.rotateCredential(req.headers.authorization?.replace(/^Bearer /, ""), req.reachIdentity));
  });
  // A guest or agent ends its own access (`agent.mjs leave`): everything it
  // had open ends, and an invited device leaves your tailnet.
  app.delete("/api/device/access", (req, res) => {
    const client = auth.list().find((c) => c.id === req.client.id);
    endClient(req.client.id);
    if (client?.kind !== "device") void releaseGuest(client);
    res.type("json").send(JSON.stringify({ ok: true }));
  });
  app.get("/api/settings", (req, res) => res.json(settings));
  app.post("/api/settings/pause", async (req, res) => {
    if (typeof req.body?.paused !== "boolean")
      throw fail(400, "Send paused as true or false.");
    res.json(await setPaused(req.body?.paused));
  });
  // The Face ID challenge for turning Face ID for agents off: this device's
  // own, used once (server/passkeys.mjs).
  app.post("/api/settings/passkey/options", (req, res) => {
    const client = faceIdOwner(req);
    if (!passkeys?.has()) throw fail(404, "Face ID isn't set up on this computer.");
    res.json(passkeys.assertionOptions(settingBinding(client)));
  });
  app.post("/api/settings", (req, res) => {
    const body = isPlainRecord(req.body) ? req.body : {};
    if ("faceIdForAgents" in body) {
      if (
        typeof body.faceIdForAgents !== "boolean" ||
        Object.keys(body).some((key) => !["faceIdForAgents", "credential"].includes(key)) ||
        (body.credential !== undefined && body.faceIdForAgents)
      )
        throw fail(400, "Send faceIdForAgents as true or false, on its own.");
      const client = faceIdOwner(req);
      if (body.faceIdForAgents && !passkeys?.has())
        throw fail(409, "Add Face ID in Settings first.");
      // Off takes Face ID while it's in force: the switch guards against a
      // phone in the wrong hands, so a tap on it can't be what lifts it.
      // Checked before anything changes; its challenge is this device's own.
      let faceId = null;
      if (body.credential !== undefined) {
        if (!passkeys?.has()) throw fail(404, "Face ID isn't set up on this computer.");
        faceId = faceIdAnswer(() => passkeys.verifyAssertion(settingBinding(client), body.credential));
      } else if (!body.faceIdForAgents && faceIdForAgents())
        throw fail(403, "Face ID turns this off. Use the phone that has it.");
      settings.faceIdForAgents = body.faceIdForAgents;
      atomicJson(settingsFile, settings);
      record(
        "settings",
        `Face ID for agent approvals turned ${body.faceIdForAgents ? "on" : `off${faceId ? ` with Face ID (${faceId.label})` : ""}`}`,
      );
      return res.json(settings);
    }
    if (typeof req.body?.screen !== "boolean")
      throw fail(400, "Send screen as true or false.");
    settings.screen = config.screen = req.body?.screen;
    // Yours from now on: a first phone never turns it back on.
    settings.screenChosen = true;
    if (!config.screen) {
      browserApprovals.cancelPending();
        browserAppAccess.clear();
      browserSnapshots.clear();
      screenControl.clear();
      screenStreams.stop();
      browserScreenSnapshots.stop();
      remoteScreens.stop();
      appScreens.stop();
      screenSound.stop("Screen viewing is off.");
      appThreads.closeAll()?.catch?.(() => {});
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
        .map(({ secretHash, token, asker, ...r }) => r),
    ),
  );
  app.post("/api/agents/requests/:id", (req, res) => {
    const r = pendingRequests().find(
      (x) => x.id === req.params.id && x.status === "pending",
    );
    if (!r) throw fail(404, "This request expired or was already answered.");
    if (!["approve", "deny"].includes(req.body?.decision))
      throw fail(400, "Choose approve or deny.");
    if (req.body?.decision === "approve") {
      r.token = auth.issue(r.name, r.scopes, "agent", r.asker ? { tailscale: r.asker } : {}).token;
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
  // This computer's own Tailscale addresses: the last ones Tailscale gave, so
  // a status read that fails doesn't forget them.
  let ownIpsSeen = [];
  const ownTailscaleIps = async () => {
    try {
      const ips = (await readStatus())?.Self?.TailscaleIPs;
      if (Array.isArray(ips) && ips.length) ownIpsSeen = ips;
    } catch {
      /* the last known ones */
    }
    return ownIpsSeen;
  };
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
    res.json({
      configured: !!guestKeys?.configured(),
      ...(guestKeys ? {} : { available: false, why: noInviteKeys }),
      policy,
    });
  });
  // One-time setup from your phone: the credential is checked with Tailscale
  // and kept on this computer only; it's never sent back.
  const invitationOwner = (req) => {
    const client = req.reauthorize();
    if (client.kind !== "device" || !client.scopes.includes("admin"))
      throw fail(403, "Only a paired owner device can create or set up invitations.");
    return client;
  };
  // The SHA-256 of the agent runtime the start page serves (dist/agent.mjs):
  // an agent's join command checks its download against it, so what replaces
  // its runtime is exactly what this computer serves (security audit M8).
  let runtimeHash = { at: 0, sha256: undefined };
  const agentRuntime = () => {
    // A Reach update on disk, not yet running: its runtime would call
    // routes this server doesn't have. Agents hear of it after the restart.
    if (reachUpdates.busy()) return undefined;
    return servedRuntime();
  };
  // The hash of what the start page hands out right now, whatever it is: an
  // invitation always pins it, so its download is checked (connections
  // audit, Oct 10).
  const servedRuntime = () => {
    const file = overrides.agentRuntimeFile || fileURLToPath(new URL("../dist/agent.mjs", import.meta.url));
    try {
      const at = fs.statSync(file).mtimeMs;
      if (runtimeHash.at !== at) {
        runtimeHash = { at, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") };
        // Kept by its hash too, for commands that name it (runtime-archive.mjs).
        try { keepRuntime(file); } catch { /* a read-only install: the build kept it */ }
      }
      return runtimeHash.sha256;
    } catch {
      return undefined;
    }
  };
  // The runtime each command-line agent says it runs (agent-runtimes.mjs).
  const agentRuntimes = createAgentRuntimes({ current: () => agentRuntime() });
  // What an agent is told about its own access when it connects and when it
  // asks (agent-guide.mjs): from the access it has now, its folders by name.
  // `page`: its browser page, which signs in with Sign in.
  function guideFor(client, { page = false } = {}) {
    const name = (folder) => { try { return fileRootName(folder); } catch { return path.basename(folder) || folder; } };
    return agentGuide(client, { word: computerWord(hostPlatform), folders: (client?.agentRoots || []).map(name), page });
  }
  // Where guests may go: Reach's port on your Reach computers.
  const guestReach = async () => {
    const st = await readStatus();
    const peers = Object.values(st?.Peer || {});
    const v4 = (n) => n?.TailscaleIPs?.find((ip) => ip.includes("."));
    return {
      addresses: [
        v4(st?.Self),
        ...(fleet?.links() || []).map((l) =>
          v4(peers.find((p) => p.ID === l.nodeId)),
        ),
      ].filter(Boolean),
      port: Number(new URL(config.publicOrigin).port || 443),
    };
  };
  app.post("/api/guests/keys", async (req, res) => {
    const authorize = () => invitationOwner(req);
    authorize();
    if (!guestKeys)
      throw fail(404, noInviteKeys);
    // The easy way: one access token (used once, never kept). Reach adds its
    // rules to the tailnet policy and makes its own limited key.
    if (req.body?.accessToken) {
      const result = await guestKeys.setupFromAccessToken({
        accessToken: req.body?.accessToken,
        authorize,
        narrowDefaultWildcard: req.body?.narrowDefaultWildcard === true,
        ...(await guestReach()),
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
      authorize,
    });
    res.json({ configured: true });
  });
  // An invite key for one invitation, whichever computers it covers: made by
  // the computer holding the OAuth client. `clientIds`: its invitations here
  // (revoking one of them ends the key and the guest's device).
  app.post("/api/guests/key", async (req, res) => {
    const authorize = () => invitationOwner(req);
    authorize();
    if (!guestKeys?.configured())
      throw fail(
        409,
        guestKeys
          ? `Set up invite keys first: run ${command} invites on this computer.`
          : noInviteKeys,
      );
    const invited = new Map(
      auth
        .list()
        .filter((c) => c.kind === "guest" || c.policy?.invite)
        .map((c) => [c.id, c]),
    );
    const guests = new Set(invited.keys());
    // The device lasts as long as its access here, never longer, whatever
    // the phone asks (Always included: its access's own end).
    const ids = (Array.isArray(req.body?.clientIds) ? req.body.clientIds : []).filter((id) => invited.has(id));
    const until = ids.length ? Math.max(...ids.map((id) => invited.get(id).expiresAt || 0)) : 0;
    let ttl = req.body?.ttlSeconds;
    if (ttl === undefined && until > Date.now()) ttl = Math.ceil((until - Date.now()) / 1000);
    else if (!Number.isInteger(ttl) || ttl < 60 || ttl > 90 * 86400)
      throw fail(400, "Choose a duration from 1 minute to 90 days.");
    if (until > Date.now()) ttl = Math.max(60, Math.min(ttl, Math.ceil((until - Date.now()) / 1000)));
    // An agent's key only needs to live until it joins.
    const keySeconds = req.body?.keySeconds;
    if (
      keySeconds !== undefined &&
      (!Number.isInteger(keySeconds) || keySeconds < 60 || keySeconds > ttl)
    )
      throw fail(400, "Invalid key lifetime.");
    await guestKeys.assertIsolated(await guestReach(), authorize);
    const key = await guestKeys.createInvite({
      ttlSeconds: ttl,
      keySeconds,
      authorize,
      clientIds: (Array.isArray(req.body?.clientIds) ? req.body?.clientIds : [])
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
  // Face ID on your phone for one waiting connection (Settings → Agents):
  // its challenge is for that request, from this device's credential, and
  // used once (server/passkeys.mjs). While Face ID confirms approvals,
  // Approve needs its answer; Deny never does.
  const admissionBinding = (req, client) => {
    if (!passkeys?.has()) throw fail(404, "Face ID isn't set up on this computer.");
    if (!auth.listAgentAdmissions().some((a) => a.requestId === req.params.requestId))
      throw fail(404, "This agent connection request was not found.");
    return `admission:${req.params.requestId}:${client.id}`;
  };
  app.post("/api/agents/admissions/:requestId/passkey/options", (req, res) => {
    const binding = admissionBinding(req, faceIdOwner(req));
    res.json(passkeys.assertionOptions(binding));
  });
  app.post("/api/agents/admissions/:requestId", (req, res) => {
    admissionOwner(req);
    const body = isPlainRecord(req.body) ? req.body : {};
    if (Object.keys(body).some((key) => !["decision", "credential"].includes(key)) ||
        (body.credential !== undefined && body.decision !== "approve"))
      throw fail(400, "Approve or deny the exact connection shown.");
    // Checked before anything is decided: a refused answer approves nothing.
    let faceId = null;
    if (body.credential !== undefined) {
      const binding = admissionBinding(req, faceIdOwner(req));
      faceId = faceIdAnswer(() => passkeys.verifyAssertion(binding, body.credential));
    }
    if (!faceId && body.decision === "approve" && faceIdForAgents())
      throw fail(403, "Face ID confirms agent approvals on this computer. Approve with Face ID on your phone, or turn it off in Settings → Agents.");
    const result = auth.decideAgentAdmission(req.params.requestId, body.decision);
    record("agent", body.decision === "approve"
      ? `Approved an invited agent's connection${faceId ? ` with Face ID (${faceId.label})` : ""}`
      : "Denied an invited agent's connection");
    // Declined on the tailnet: its device leaves at once. (A public-link
    // agent declined in another browser keeps its access and has no device.)
    if (result.status === "denied") {
      const client = auth.list().find((c) => c.id === result.clientId);
      if (client && client.browserTransport !== "funnel") void releaseGuest(client);
    }
    for (const nudge of presenceNudges) nudge();
    res.json(result);
  });
  // Your own devices only; the clicks that grant it are yours, on the Mac.
  const toolSetupOwner = (req) => {
    const client = req.reauthorize();
    if (client.kind !== "device" || !client.scopes.includes("admin"))
      throw fail(403, "Only your own devices set up saved tools.");
  };
  app.get("/api/agents/tool-setup", async (req, res) => {
    toolSetupOwner(req);
    res.json(await toolSetup.status());
  });
  app.post("/api/agents/tool-setup", async (req, res) => {
    toolSetupOwner(req);
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some((key) => !["browser", "action"].includes(key)) ||
        typeof body.browser !== "string" || !["enable", "ask", "settings"].includes(body.action))
      throw fail(400, "Choose a browser, and enable, ask or settings.");
    const result = await toolSetup[body.action](body.browser);
    record("agent", result.extension !== undefined
      ? { connected: `Allowed saved tools in ${result.id}`, added: `Opened ${result.id} for saved tools`, missing: `Opened Reach's extension's store page in ${result.id}`, asking: `Allowed saved tools in ${result.id}`, unpublished: `Reach's extension isn't in ${result.id}'s store yet` }[result.extension] || `Checked saved tools in ${result.id}`
      : { enable: `Allowed saved tools in ${result.id}: its switch flipped, macOS asked`, ask: `Asked macOS to let saved tools use ${result.id}`, settings: `Opened Automation settings for ${result.id}` }[body.action]);
    res.json(result);
  });
  app.post("/api/agents/invitations", (req, res) => {
    if (req.client.kind === "guest")
      throw fail(403, "Only the computer's owner can invite agents.");
    const grant = auth.inviteAgent(req.body || {});
    record("agent", `Invited agent ${req.body?.name}`);
    const runtime = servedRuntime();
    res.status(201).json({ ...grant, ...(runtime ? { runtime } : {}) });
  });
  app.post("/api/guests", async (req, res) => {
    const authorize = () => invitationOwner(req);
    authorize();
    const grant = auth.inviteGuest(req.body || {});
    // With an invite key, the guest needs no Tailscale account or app.
    let key;
    if (req.body?.key === true) {
      try {
        if (!guestKeys?.configured())
          throw fail(
            409,
            guestKeys
              ? `Set up invite keys first: run ${command} invites on this computer.`
              : noInviteKeys,
          );
        await guestKeys.assertIsolated(await guestReach(), authorize);
        key = await guestKeys.createInvite({
          ttlSeconds: req.body?.ttlSeconds,
          clientIds: [grant.clientId],
          authorize,
        });
      } catch (error) {
        auth.revoke(grant.clientId);
        throw error;
      }
    }
    record(
      "guest",
      `Invited ${req.body?.name} until ${new Date(grant.expiresAt).toISOString()}`,
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
  // Your Allow for a person who came in while an agent had the Mac (Deny is
  // removing their access, DELETE /api/clients/:id).
  app.post("/api/guests/:id/allow", (req, res) => {
    invitationOwner(req);
    const person = auth.allowPerson(req.params.id);
    record("guest", `Let ${person.name || "a person"} in`);
    for (const nudge of presenceNudges) nudge();
    res.json({ ok: true });
  });
  // Change what someone you invited may use, without a new link (core.mjs,
  // changeAccess). Every request checks the new access; what they lose ends
  // at once: screen control comes back to you, and their open screens and
  // terminals start over under the new access.
  app.post("/api/guests/:id/access", async (req, res) => {
    const id = req.params.id;
    const existing = auth.list().find((client) => client.id === id);
    if (existing?.policy?.browser && req.body?.screen && req.body?.screen !== "off" &&
        req.body?.screen !== existing.policy.screen && !browserScreenAvailable())
      throw fail(403, "Turn on screen viewing in Reach before sharing it.");
    if (existing?.policy?.browser && Array.isArray(req.body?.terminalIds)) {
      const selected = req.body?.terminalIds;
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
      const preset = req.body?.preset ?? previousClient.policy.preset;
      if (["full", "apps", "readonly"].includes(preset) && !agentDesktop?.available?.())
        throw fail(503, "Screen access for agents needs this Mac's Screen Recording and Accessibility permissions.");
      const chosen = Array.isArray(req.body?.apps) && req.body?.apps.length, hidden = Array.isArray(req.body?.hidden) && req.body?.hidden.length;
      if (chosen || hidden) {
        if (!agentDesktop) throw fail(503, "The app list is unavailable on this computer.");
        const catalog = await agentDesktop.catalog(() => req.reauthorize());
        if (chosen) req.body.apps = presetAppsFromCatalog(catalog, req.body?.apps);
        if (hidden) req.body.hidden = presetAppsFromCatalog(catalog, req.body?.hidden, { allowProtected: true });
      }
      req.reauthorize();
    }
    const { client, before, after } = auth.changeAccess(id, req.body || {});
    agentDesktop?.cancelClient?.(id);
    agentShortcuts.cancelClient(id);
    agentTools.cancelClient(id);
    agentServices.cancelClient(id);
    browserApprovals.cancelClient(id);
    browserAppAccess.cancelClient(id);
    browserOperations.cancelClient(id);
    const lost = before.scopes.filter((s) => !after.scopes.includes(s));
    const fullControlLost = before.fullControlVersion === 1 && after.fullControlVersion !== 1;
    const narrower =
      fullControlLost || lost.length > 0 ||
      before.roots.some((r) => !after.roots.includes(r)) ||
      (after.scopes.includes("apps:open") &&
        Array.isArray(after.apps) &&
        (!before.apps || before.apps.some((a) => !after.apps.includes(a))));
    if (fullControlLost || lost.includes("screen") || lost.includes("screen:control")) {
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
    res.json({
      current: req.client.id,
      // A command-line agent's runtime: current, updating, or one to update by hand.
      clients: auth.list().map((client) => {
        const runtime = client.kind === "agent" ? agentRuntimes.statusOf(client) : undefined;
        // Its update by hand fetches exactly this runtime, by its hash.
        const sha = runtime === "one-time" ? servedRuntime() : undefined;
        // When it last used its access (this run of Reach).
        const activeAt = lastUse.get(client.id);
        return runtime || activeAt
          ? { ...client, ...(runtime ? { runtime } : {}), ...(sha ? { runtimeSha256: sha } : {}), ...(activeAt ? { activeAt } : {}) }
          : client;
      }),
    }),
  );
  // Ends a credential now: requests, sockets, screen control.
  // A session's work ends; its credential stays (Reopen link) or goes (revoke).
  const endSession = (id) => {
    agentShortcuts.cancelClient(id);
    agentTools.cancelClient(id);
    agentServices.cancelClient(id);
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
    // Windows: kill this session's running jobs first, then reclaim its
    // capability ACEs on disk (§4.6). Off Windows windowsGrants is null.
    if (windowsGrants) {
      for (const job of jobs.list()) if (job.clientId === id && job.status === "running") jobs.cancel(job.id);
      void windowsGrants.revokeClient(id).catch(() => {});
    }
    for (const ws of wss.clients)
      if (ws.clientId === id) ws.close(4001, "Access revoked");
  };
  // Windows: a startup sweep reclaims grants whose client is gone or expired
  // (expiry fires no event), and an hourly sweep keeps up with expiries (§4.6).
  if (windowsGrants) {
    const sweep = () => void windowsGrants.sweep((id) => !!auth.list().find((c) => c.id === id)).catch(() => {});
    setTimeout(sweep, 5000).unref?.();
    setInterval(sweep, 3600000).unref?.();
  }
  const endClient = (id) => {
    auth.revoke(id);
    lastUse.delete(id);
    endSession(id);
  };
  browserAgentRoutes(app, {
    auth, approvals: browserApprovals, appAccess: browserAppAccess, coordinator: browserOperations, endClient, endSession, desktop: agentDesktop, actions: agentActions, timings: agentTimings,
    pauses: { has: agentPaused, set: pauseAgent },
    onStopped: (client) => {
      void releaseGuest(client);
      record("agent", "Stopped a browser agent session");
    },
  });
  app.delete("/api/clients/:id", (req, res) => {
    const client = auth.list().find((c) => c.id === req.params.id);
    endClient(req.params.id);
    // A guest who came with an invite key leaves your tailnet too, and so
    // does a browser that signed in with Face ID.
    void releaseGuest(client || { id: req.params.id });
    if (client?.tailscale?.faceJoin && guestKeys?.configured())
      void tidyFace();
    // Revoke once: your linked computers drop that device too.
    if (client?.kind === "device" && client.tailscale)
      void fleet?.revokeElsewhere(client.tailscale);
    res.type("json").send(JSON.stringify({ ok: true }));
  });
  // Invitations nobody joined, a day after their chance to join ended
  // (core.mjs, clearUnopened): removed for good the way removing one does,
  // any invite key or device they had with them, and a line in the security
  // record. Every 5 minutes with the guests' tidy, on every computer.
  const clearUnopened = (now = Date.now()) => {
    let cleared = [];
    try { cleared = auth.clearUnopened(now); } catch (e) { console.log(`Reach: ${e.message}`); }
    for (const client of cleared) {
      endClient(client.id);
      void releaseGuest(client);
      record("security", `Unopened invitation for ${client.name || (client.kind === "guest" ? "a person" : "an agent")} cleared`);
    }
    return cleared;
  };
  for (const timer of [setTimeout(clearUnopened, 20000), setInterval(clearUnopened, 5 * 60000)]) {
    timer.unref();
    guestTimers.push(timer);
  }
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
      if (client?.policy?.browser === true && client.policy.preset === "full") return target;
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
    const target = await safePathAsync(client?.agentRoots || config.roots, root, p);
    if (client?.policy?.browser === true && client.policy.preset === "full") return target;
    notPrivate(target, privates);
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
    if (validateBrowserRoot(root, { policy: client.policy }) !== root)
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
      ...limits, privatePaths: browserPaths() }, check, { config, windowsSandbox });
  };
  agentShortcutRoutes(app, { shortcuts: agentShortcuts });
  // The Mac's own Shortcuts an agent may run: the owner's list (server/mac-shortcuts.mjs).
  const macShortcuts = overrides.macShortcuts !== undefined ? overrides.macShortcuts
    : createMacShortcuts({ file: path.join(config.dataDir, "mac-shortcuts.json"), notify, record });
  const macShortcutOwner = (req) => {
    const client = req.reauthorize();
    if (client.kind !== "device" || !client.scopes.includes("admin")) throw fail(403, "Only the owner chooses which shortcuts agents may run.");
  };
  app.get("/api/agents/mac-shortcuts", async (req, res) => { macShortcutOwner(req); res.json(await macShortcuts.owner()); });
  app.post("/api/agents/mac-shortcuts", async (req, res) => {
    macShortcutOwner(req);
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["name", "allowed"].includes(key))) throw fail(400, "Name a shortcut and whether agents may run it.");
    res.json(await macShortcuts.allow(body.name, body.allowed));
  });
  agentToolRoutes(app, { tools: agentTools });
  agentServiceRoutes(app, agentServices);
  permissionRoutes(app, permissionRequests);
  browserAccessRoutes(app, {
    agentRuntime,
    guide: guideFor,
    servedRuntime,
    noteAgentRuntime: (client, value) => agentRuntimes.note(client, value),
    toolsStandingAllowed: () => !!guestKeys?.configured(),
    auth, config, terminals, desktopTerminals, resolve, resolveAsync, record, browserFiles,
    // Files needs the Mac's descriptor helper, or on Windows the sandbox's
    // owner-token broker (built only in the folder D confirmed private this
    // start). Without that folder, Files is refused with the reason.
    protectedFilesSupported: overrides.browserFilesSupported ?? (process.platform === "darwin" || (process.platform === "win32" && !!overrides.windowsSandboxHelper)),
    filesUnsupportedReason: () => process.platform === "win32"
      ? (overrides.windowsHelpersOff || "Agent file access isn't ready on this Windows PC yet. Your own files and terminals remain available.")
      : "Browser-agent file access requires macOS. Your own files and terminals remain available.",
    appAccess: browserAppAccess, appAccessAvailable: browserAppAvailable, hostGuard: browserHostGuard,
    desktop: agentDesktop, shell: agentShell, shortcuts: agentShortcuts, tools: agentTools, services: agentServices, macShortcuts, actions: logAction,
    // Screen text an agent didn't read again (savings.mjs, "screen-diff").
    savings: { record: (entry) => savings.record(entry) },
    prepareFunnel: async () => {
      // No public link without phones approved by your Tailscale account.
      if (!prepareFunnel && !config.tailscaleOwner)
        throw fail(503, noInviteKeys);
      if (!prepareFunnel || paused || !transportAvailable)
        throw fail(503, "Temporary browser access is not available. Start Reach with its Tailscale connection and try again.");
      await prepareFunnel();
      return new URL(config.publicOrigin).origin.replace(/:\d+$/, "");
    },
    publicName: overrides.publicName ?? (process.env.NODE_TEST_CONTEXT ? null : publicNameState),
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
    const shown = entries.filter((e) => showHidden || !hiddenByOs(e.name, dir));
    const items = (
      await Promise.all(
        shown
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
      truncated: shown.length > 2000,
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
    const sharedRoot = (current.agentRoots || config.roots)[Number(req.query.root ?? 0)];
    const realRoot = (() => { try { return fs.realpathSync(sharedRoot); } catch { return sharedRoot; } })();
    res.download(path.relative(realRoot, file), path.basename(file), { root: realRoot });
  });
  // A short-lived link to one file, for the browser's own download manager.
  app.get("/api/files/download-link", async (req, res) => {
    const file = resolve(req.query.root, req.query.path || "", req.client);
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw fail(400, "Choose a file.");
    const token = links.issue({
      digest: req.client.hash,
      file,
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
    // Opened once and proven to be the file checked (confined-file.mjs).
    const place = () => resolve(req.query.root, req.query.path || "", req.client);
    const { handle, size } = await openConfined(place(), fs.constants.O_RDONLY, place);
    let data;
    try {
      data = size > 1024 * 1024 ? null : await readUpTo(handle, 1024 * 1024);
    } finally {
      await handle.close();
    }
    if (!data)
      throw fail(
        413,
        "This file is too large to preview. Download it instead.",
      );
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
  // Read, compared and written through one handle, proven to be the file
  // checked (confined-file.mjs): a link or another file put in its place
  // meanwhile is never written. Written in place, so its links and
  // permissions stay as they were.
  const editText = async (file, place, body) => {
    const { handle, size } = await openConfined(file, fs.constants.O_RDWR, place);
    try {
      const previous = size > 1024 * 1024 ? null : await readUpTo(handle, 1024 * 1024);
      if (!previous) throw fail(400, "Choose a text file up to 1 MiB.");
      if (previous.includes(0))
        throw fail(415, "Binary files cannot be edited as text.");
      if (hash(previous) !== body.sha256)
        throw fail(409, "This file changed. Read it again before writing.");
      const text = Buffer.from(body.text, "utf8");
      await handle.truncate(0);
      await handle.write(text, 0, text.length, 0);
      await handle.sync();
    } finally {
      await handle.close();
    }
  };
  let editing = Promise.resolve();
  app.put("/api/files/text", async (req, res) => {
    if (
      typeof req.body?.text !== "string" ||
      Buffer.byteLength(req.body?.text) > 128 * 1024 ||
      req.body?.text.includes("\0") ||
      !/^[a-f0-9]{64}$/.test(req.body?.sha256 || "")
    )
      throw fail(
        400,
        "Send text up to 128 KiB and the sha256 from the last read.",
      );
    const place = () => resolve(req.query.root, req.query.path || "", req.client);
    const file = place();
    // One edit at a time, all files together: each reads, compares and
    // writes before the next reads, so two edits from the same read can't
    // both win (the rest get 409). None is refused for waiting.
    const turn = editing.then(() => editText(file, place, req.body));
    editing = turn.catch(() => {});
    await turn;
    record("file", `Updated ${path.basename(file)}`);
    res.json({ ok: true, sha256: hash(req.body?.text) });
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
    if (req.body !== undefined)
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
    // Asked again after the answer was lost: it already landed.
    const landed = resumable.done(req.params.id, req.client);
    if (landed) return res.json(landed);
    resumable.status(req.params.id, req.client);
    const { root, path: folder } = resumable.get(req.params.id);
    try {
      const result = await resumable.complete(
        req.params.id,
        req.client,
        uploadFolder(req, root, folder),
        () => req.reauthorize(),
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
    const dir = resolve(req.body?.root, req.body?.path || "", req.client);
    const name = req.body?.name;
    if (!validLeafName(name))
      throw fail(
        400,
        "Choose a folder name without special characters, reserved device names, or leading/trailing dots.",
      );
    await fsp.mkdir(path.join(dir, name));
    record("file", `Created folder ${name}`);
    res.json({ ok: true });
  });
  // Unzip with one tap, like the Files app: the contents land beside it.
  let archiveInFlight = false;
  app.post("/api/files/extract", async (req, res) => {
    const owner = () => {
      const client = req.reauthorize();
      if (!actsAsOwner(client) || !client.scopes.includes("admin") || client.policy?.browser ||
          !(client.scopes.includes("files") || ["files:read", "files:write"].every(scope => client.scopes.includes(scope))))
        throw fail(403, "Only a paired owner with file read and write access can open archives.");
      return client;
    };
    owner();
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
        Object.keys(req.body).some(key => !["root", "path"].includes(key)) ||
        !Number.isSafeInteger(req.body?.root) || req.body?.root < 0 || typeof req.body?.path !== "string" || !req.body?.path)
      throw fail(400, "Choose an archive in a shared folder.");
    const root = req.body?.root, relative = req.body?.path;
    const file = resolve(root, relative, owner());
    if (!archiveBase(path.basename(file))) throw fail(415, "Only ZIP, TAR and gzip-compressed TAR archives can be opened here.");
    if (archiveInFlight) throw fail(429, "Wait for the current archive to finish opening.");
    archiveInFlight = true;
    const controller = new AbortController();
    const disconnected = () => controller.abort(fail(409, "Extraction was cancelled."));
    res.once("close", disconnected);
    try {
      const name = await extractArchive(file, { stagingRoot: config.dataDir, signal: controller.signal, authorize: () => {
        notPaused();
        if (resolve(root, relative, owner()) !== file) throw fail(409, "The archive location changed. Try again.");
      } });
      owner();
      record("file", `Extracted ${path.basename(file)}`);
      const folder = path.posix.dirname(relative);
      res.json({ name, path: folder === "." ? name : `${folder}/${name}` });
    } finally {
      res.off("close", disconnected);
      archiveInFlight = false;
    }
  });
  app.get("/api/jobs", (req, res) =>
    res.json(jobs.list().filter((j) => mayAccess(req.client, j))),
  );
  const ownJob = (req) => {
    const j = jobs.get(req.params.id);
    requireOwner(req.client, j);
    return j;
  };
  // Each job starts a process: at most two a second per device or agent.
  const jobLimit = rateLimit({
    windowMs: 60_000, limit: 120, store: new MemoryStore(),
    keyGenerator: req => {
      if (!req.client?.id) throw fail(401, "Approve this device first.");
      return req.client.id;
    },
    standardHeaders: "draft-8", legacyHeaders: false,
    identifier: "jobs",
    message: { error: "Too many commands at once. Try again in a minute." },
  });
  app.post("/api/jobs", jobLimit, async (req, res) => {
    const cwd = resolve(req.body?.root, req.body?.path || "", req.client);
    if (!fs.statSync(cwd).isDirectory()) throw fail(400, "Choose a folder.");
    const timeoutMs =
      req.body?.timeoutMs ?? Math.min(60000, req.client.maxJobMs || 3600000);
    if (req.client.maxJobMs && timeoutMs > req.client.maxJobMs)
      throw fail(403, "Job duration exceeds this agent profile limit.");
    // Your own devices run as you; anyone else's job runs in the sandbox
    // Full control agents' commands do (win32: a refused grant throws here).
    const own = req.client.kind === "device" && req.client.scopes.includes("admin");
    const sandbox = own ? null : jobSandbox(req.client);
    // No sandbox on a platform without one (Linux): an agent's or invited
    // person's command would run as you, free to rewrite Reach's own files
    // and so its own access. It doesn't run, as without sandbox-exec on a
    // Mac (jobs.mjs). Oct 12: Windows and Linux had run them unsandboxed.
    if (!own && !sandbox)
      throw fail(503, `Commands from agents and invited people run only in a sandbox, which this ${computerWord(process.platform)} doesn't have yet. Your own devices can run commands.`);
    // Windows runs the sandboxed job through the helper: prove the OS lets the
    // helper run (§2.2) and hand jobs.start the hash-verified helper. Fails
    // closed with the reason (Smart App Control, application control, or its
    // private folder not ready); never falls back to an interpreter.
    let helper = null;
    if (!own && process.platform === "win32") {
      const ready = await windowsSandbox.ready();
      if (!ready.ok) throw fail(503, ready.reason);
      helper = ready.built;
    }
    const j = jobs.start({ ...req.body, cwd, timeoutMs }, req.client.id, { sandbox, helper });
    // Record the capability grant so a later revoke or sweep can reclaim its
    // on-disk ACEs (§4.6); the live token already loses access on the next launch.
    if (helper && sandbox?.grants?.length)
      windowsGrants?.record({ clientId: req.client.id, roots: sandbox.grants.map((g) => g.root), expiresAt: req.client.expiresAt });
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
        `Only a paired person can access existing ${computerWord(desktopTerminals.platform)} terminals.`,
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
      req.body?.provider,
      authorizeDesktopTerminal(req),
    );
    record("terminal", `Opened a ${computerWord(desktopTerminals.platform)} terminal`);
    res.json(result);
  });
  // Every Mac tab's last line, answered when one changes (Home).
  app.get("/api/terminals/desktop/activity", async (req, res) => {
    if (!macTerminalWatch.ready)
      throw fail(409, `${computerWord(desktopTerminals.platform)} terminals aren't being watched right now.`);
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
          ? `Closed a ${computerWord(desktopTerminals.platform)} terminal`
          : `Sent text to a ${computerWord(desktopTerminals.platform)} terminal`,
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
    if (!agentsFound || Date.now() - agentsFound.at > 300000) {
      const entry = {
        at: Date.now(),
        list: Promise.all(
          Object.keys(AGENTS).map(async (name) =>
            (await locateAgent(name)) ? name : null,
          ),
        ).then((names) => names.filter(Boolean)),
      };
      agentsFound = entry;
      // A failed lookup is not remembered.
      entry.list.catch(() => { if (agentsFound === entry) agentsFound = null; });
    }
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
  openClawRoutes(app, openClaw, {
    authorizeMaintenance: (req) => () => req.reauthorizeJob(),
    runMaintenance: overrides.openClawMaintenance,
    installRuntime: overrides.openClawRuntimeInstall,
    dataDir: config.dataDir,
    // Token optimizations OpenClaw reports usage for (openclaw-usage.mjs);
    // read when an event comes, after the ledger below exists.
    savings: { record: (entry) => savings.record(entry) },
    // What Reach doesn't set up itself (a model's key, a bot's token) opens
    // OpenClaw's own setup in a Reach terminal, typed into there.
    openSetup: (section, req) => {
      const current = req.reauthorize();
      notPaused();
      const terminal = terminals.create({
        cwd: os.homedir(),
        name: "OpenClaw setup",
        clientId: current.id,
        command: `openclaw configure --section ${section}`,
      });
      record("terminal", "Opened OpenClaw setup");
      return terminal;
    },
    // A fixed OpenClaw command (each feature keeps its own list; never the
    // phone's text) in a Reach terminal, e.g. `openclaw doctor`.
    openCommand: (command, name, req) => {
      const current = req.reauthorize();
      notPaused();
      if (!/^openclaw [a-z][a-z -]*$/.test(command)) throw Object.assign(new Error("Reach can't run that here."), { status: 400 });
      const terminal = terminals.create({
        cwd: os.homedir(),
        name,
        clientId: current.id,
        command,
      });
      record("terminal", `Opened ${name}`);
      return terminal;
    },
  });
  // Installing Claude Code or Codex from the phone (agent-install.mjs): its
  // maker's command first, to show; confirmed, run in a Reach terminal that
  // ends with it. The owner's own devices only (as every session route).
  // One install per app at a time (two phones confirming at once).
  const installs = installLock((id) => {
    try { return terminals.get(id)?.status !== "exited"; } catch { return false; }
  });
  // Plans probe installed binaries, and fresh status checks query publishers.
  // Authenticate first, then bound that work across all maintenance routes.
  // Device identity survives IP/header changes without grouping other phones.
  const maintenanceStore = new MemoryStore();
  const maintenanceLimit = rateLimit({
    windowMs: 60_000, limit: 30, store: maintenanceStore,
    keyGenerator: req => {
      if (!req.client?.id) throw fail(401, "Approve this device first.");
      return req.client.id;
    },
    standardHeaders: "draft-8", legacyHeaders: false,
    identifier: "agent-maintenance",
    message: { error: "Too many app installation or update requests. Try again in one minute." },
  });
  app.post("/api/sessions/agent-install/:agent", maintenanceLimit, async (req, res) => {
    const agent = String(req.params.agent);
    const confirm = req.body?.confirm === true;
    if (confirm && !installs.take(agent))
      throw Object.assign(new Error("That app is already installing. Wait for it to finish."), { status: 409 });
    let started = false;
    try {
      const { lead, ...plan } = await (overrides.agentInstallPlan || installPlan)(agent);
      const current = req.reauthorize();
      if (!confirm) return res.json(plan);
      notPaused();
      const terminal = terminals.create({
        cwd: os.homedir(),
        name: `Install ${plan.name}`,
        clientId: current.id,
        // A failed download fails the install too (curl … | bash).
        command: installTerminalCommand({ ...plan, lead }),
        // Windows: PowerShell's own text, whatever the owner's shell.
        powershell: true,
      });
      installs.started(agent, terminal.id);
      started = true;
      record("terminal", `Installing ${plan.name}`);
      res.json({ ...plan, terminal });
    } finally {
      if (confirm && !started) installs.release(agent);
    }
  });
  // Updating Claude Code or Codex (agent-updates.mjs): offered only when a
  // newer version is certain, as Install: its command shown, then run once
  // confirmed. A copy inside an app updates with the app.
  const agentUpdates = overrides.agentUpdates || createAgentUpdates();
  app.get("/api/sessions/agent-updates", maintenanceLimit, async (req, res) =>
    res.json({ agents: (await agentUpdates.list({ fresh: req.query.fresh === "1" })).map(({ file, ...rest }) => rest) }),
  );
  // The update confirmed: its fixed command in a Reach terminal (one per app
  // at a time), from this route or from Needs you (keep-in-sync.mjs).
  const startAgentUpdate = async (agent, authorize) => {
    if (!installs.take(agent))
      throw fail(409, "That app is already installing or updating. Wait for it to finish.");
    let started = false;
    try {
      const plan = await agentUpdates.plan(agent);
      const current = authorize();
      notPaused();
      const terminal = terminals.create({
        cwd: os.homedir(),
        name: `Update ${plan.name}`,
        clientId: current.id,
        command: installTerminalCommand(plan),
        powershell: true,
      });
      installs.started(agent, terminal.id);
      started = true;
      record("terminal", `Updating ${plan.name} to ${plan.to}`);
      return { ...plan, terminal };
    } finally {
      if (!started) installs.release(agent);
    }
  };
  app.post("/api/sessions/agent-update/:agent", maintenanceLimit, async (req, res) => {
    const agent = String(req.params.agent);
    if (req.body?.confirm === true) return res.json(await startAgentUpdate(agent, () => req.reauthorize()));
    const plan = await agentUpdates.plan(agent);
    req.reauthorize();
    res.json(plan);
  });
  // Keeping what Reach drives in sync (keep-in-sync.mjs): Claude Code and
  // Codex (their own updates, above), Codex's service (`codex app-server
  // daemon update`, run here), OpenClaw (its own update, on its page).
  // Checked soon after Reach starts and hourly; updated only on the
  // owner's tap, from Needs you or Settings, on their own devices.
  const keepInSync = overrides.keepInSync || createKeepInSync({
    dataDir: config.dataDir,
    record: (title) => record("update", title),
    onChange: () => notifications.wake?.(),
    terminalEnded: (id) => {
      try { const t = terminals.get(id); return !t || t.status === "exited"; } catch { return true; }
    },
    sources: [
      codexServiceSource({
        status: () => agentSessions.codexService?.(),
        models: () => agentSessions.models("codex"),
        update: () => agentSessions.updateCodexService(),
        working: () => agentSessions.codexWorking?.() || [],
      }),
      agentSource("claude", { updates: agentUpdates, update: (ctx) => startAgentUpdate("claude", ctx.authorize) }),
      agentSource("codex", { updates: agentUpdates, update: (ctx) => startAgentUpdate("codex", ctx.authorize) }),
      openClawSource({ tooOld: () => openClaw.tooOld?.() }),
    ],
  });
  if (!process.env.NODE_TEST_CONTEXT) keepInSync.watch();
  // Only the computer's owner, on their own admin device (never a guest or
  // an agent, whatever reaches the route).
  const syncOwner = (req) => {
    const client = req.reauthorize();
    if (client.kind !== "device" || !client.scopes?.includes("admin"))
      throw fail(403, "Only the computer's owner updates what Reach uses.");
    return client;
  };
  app.get("/api/sessions/keep-in-sync", maintenanceLimit, async (req, res) => {
    syncOwner(req);
    res.set("Cache-Control", "no-store").json({ items: req.query.fresh === "1" ? await keepInSync.refresh({ fresh: true }) : await keepInSync.look() });
  });
  app.post("/api/sessions/keep-in-sync/:id", maintenanceLimit, async (req, res) => {
    syncOwner(req);
    const id = String(req.params.id);
    const pair = typeof req.body?.pair === "string" ? req.body.pair : null;
    if (req.body?.action === "dismiss") {
      keepInSync.dismiss(id, pair);
      return res.json({ items: keepInSync.list() });
    }
    if (req.body?.action !== "update") throw fail(400, "Choose update or dismiss.");
    notPaused();
    try {
      const run = await keepInSync.start(id, { anyway: req.body?.anyway === true, pair }, { authorize: () => syncOwner(req) });
      res.json({ run, items: keepInSync.list() });
    } catch (error) {
      throw Object.assign(fail(error.status || 500, error.message), error.working ? { working: error.working } : {});
    }
  });
  app.get("/api/sessions", async (req, res) =>
    versioned(req, res, { ...(await agentSessions.list({ fresh: req.query.fresh === "1" })), relays: relays.list(), teams: teams.list(), workflows: workflows.list() }),
  );
  app.get("/api/sessions/health", async (req, res) =>
    res.json({
      agents: (await agentSessions.health({ fresh: req.query.fresh === "1" })).map((a) => ({
        ...a,
        ...(savings.totals(a.agent).tokens ? { savings: savings.totals(a.agent) } : {}),
        ...(usageWatch.has(a.agent) ? { notifyWhenBack: true } : {}),
      })),
      // No team bridge open on Windows (team-bridge.mjs: its pipe, or the
      // owners helper a lead's check needs): the phone doesn't offer a Team
      // that could only fail. (A Mac's that failed to open says "Restart
      // Reach" when a team starts, as before.)
      ...((overrides.platform || process.platform) === "win32" && !teamBridgeOpen && !overrides.teams ? { teams: false } : {}),
    }),
  );
  // Ask (or stop asking) for one notification when an agent's limit is back.
  app.post("/api/sessions/usage-watch", async (req, res) => {
    const agent = req.body?.agent;
    if (!["claude", "codex", "gemini"].includes(agent)) throw fail(400, "Choose an agent.");
    if (req.body?.on === false) {
      usageWatch.remove(agent);
      return res.json({ watching: false });
    }
    const current = (await agentSessions.health({ fresh: true })).find((h) => h.agent === agent);
    if (!current?.signedIn) throw fail(409, "Sign in to this agent first.");
    usageWatch.add(agent, { session: req.body?.session, resetsAt: current.resetsAt });
    // Already back on the Mac: the look sends it now.
    void usageWatch.look();
    res.json({ watching: true });
  });
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
  // The All page (docs/ACROSS_AGENTS.md): the files each chat changed lately
  // and the ones two chats changed at once; what happened since the phone
  // last looked; one search across every agent's conversations.
  const overlaps = overrides.overlaps || createOverlaps({ list: () => agentSessions.list(), read: (agent, id) => agentSessions.read(agent, id, { limit: 200 }) });
  const search = overrides.search || createSearch();
  app.get("/api/sessions/activity", async (req, res) => res.json(await overlaps.scan()));
  app.get("/api/sessions/journal", async (req, res) => {
    const since = Number(req.query.since);
    const { sessions = [] } = await agentSessions.list();
    res.json({
      events: journal.since(Number.isFinite(since) ? since : Date.now() - 24 * 60 * 60 * 1000),
      // Waiting on you right now, wherever it is.
      waiting: sessions
        .filter((s) => !s.archived && (s.status === "waiting" || s.prompts?.length))
        .map((s) => ({ agent: s.agent, id: s.id, title: s.title || "" })),
      now: Date.now(),
    });
  });
  app.get("/api/sessions/search", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "";
    const found = await search.search(q);
    const { sessions = [] } = await agentSessions.list();
    const named = new Map(sessions.map((s) => [`${s.agent}:${s.id}`, s]));
    res.json({
      partial: found.partial,
      results: found.results.map((r) => {
        const s = named.get(`${r.agent}:${r.id}`);
        return { ...r, title: s?.title || "", cwd: s?.cwd || "", listed: !!s && !s.archived };
      }),
    });
  });
  // Relays and second opinions: set up from the owner's own devices, and
  // cancelled while they wait (agent-sessions/relays.mjs).
  app.get("/api/sessions/relays", (req, res) => res.json({ relays: relays.list() }));
  app.post("/api/sessions/relays", async (req, res) => {
    macOwner(req);
    notPaused();
    const b = req.body || {};
    const result = await relays.start({
      owner: req.client.id,
      from: { agent: String(b.from?.agent || ""), id: String(b.from?.id || "") },
      steps: b.steps,
      trigger: b.trigger ?? "reply",
      priority: b.priority ?? null,
      now: b.now === true,
      item: typeof b.item === "string" && b.item.length <= 200 ? b.item : null,
      // From an OpenClaw chat (no folder of its own): where the work happens.
      ...(typeof b.cwd === "string" && b.cwd ? { cwd: b.cwd } : {}),
      // The answer back to the WhatsApp or Telegram chat that asked (relays.mjs).
      ...(b.postBack === true ? { postBack: true } : {}),
    });
    record("session", b.now === true ? "Started a second opinion or relay" : "Set up a relay for when a chat finishes");
    res.json(result);
  });
  app.post("/api/sessions/relays/:id/cancel", (req, res) => {
    macOwner(req);
    res.json(relays.cancel(req.params.id));
  });
  // Team chats: started, listed and stopped from the owner's own devices.
  // The lead starts as a new chat does (its folder, model and mode checked
  // the same way); its helpers are its to start (agent-sessions/teams.mjs).
  app.get("/api/sessions/teams", (req, res) => res.json({ teams: teams.list() }));
  app.post("/api/sessions/teams", async (req, res) => {
    macOwner(req);
    notPaused();
    const body = req.body || {};
    const lead = String(body.lead || "");
    const modeSettings =
      lead === "codex"
        ? codexStartMode(body.mode)
        : typeof body.mode === "string" && ["auto", "manual", "acceptEdits", "plan", "bypassPermissions", "dontAsk"].includes(body.mode) ? { mode: body.mode } : null;
    if (body.mode !== undefined && !modeSettings) throw fail(400, "Unknown permission mode.");
    const options = turnOptions(body);
    const result = await teams.create({
      owner: req.client.id,
      lead,
      helpers: Array.isArray(body.helpers) ? body.helpers.map(String).slice(0, 4) : [],
      cwd: body.cwd,
      text: options.text,
      start: {
        images: options.images,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.speed ? { speed: options.speed } : {}),
        ...(modeSettings || {}),
        ...(lead === "codex" && body.mode ? { modeName: body.mode } : {}),
      },
    });
    record("session", `Started a team led by ${agentLabel(lead)}`);
    res.json(result);
  });
  app.post("/api/sessions/teams/:id/stop", async (req, res) => {
    macOwner(req);
    res.json(await teams.stop(req.params.id));
  });
  // Workflows: written, planned, run and stopped from the owner's own devices
  // (agent-sessions/workflows.mjs). A planner starts as a reviewer does,
  // reading only; a task starts as a relay's step does.
  app.get("/api/sessions/workflows", (req, res) => res.json({ workflows: workflows.list() }));
  app.post("/api/sessions/workflows", (req, res) => {
    macOwner(req);
    const body = req.body || {};
    res.json(workflows.create({ owner: req.client.id, title: body.title, cwd: body.cwd, tasks: Array.isArray(body.tasks) ? body.tasks : [] }));
  });
  app.post("/api/sessions/workflows/plan", async (req, res) => {
    macOwner(req);
    notPaused();
    const body = req.body || {};
    const options = turnOptions(body);
    const result = await workflows.plan({
      owner: req.client.id,
      agent: String(body.agent || ""),
      cwd: body.cwd,
      text: options.text,
      start: {
        images: options.images,
        ...(options.model ? { model: options.model } : {}),
        ...(options.effort ? { effort: options.effort } : {}),
        ...(options.speed ? { speed: options.speed } : {}),
      },
    });
    record("session", `Asked ${agentLabel(String(body.agent || ""))} to plan a workflow`);
    res.json(result);
  });
  app.get("/api/sessions/workflows/:id", (req, res) => versioned(req, res, workflows.get(req.params.id)));
  app.post("/api/sessions/workflows/:id", (req, res) => {
    macOwner(req);
    const body = req.body || {};
    res.json(workflows.update(req.params.id, { title: body.title, cwd: body.cwd, tasks: body.tasks }));
  });
  app.post("/api/sessions/workflows/:id/run", async (req, res) => {
    macOwner(req);
    notPaused();
    await workflows.checkAvailable?.(req.params.id);
    const result = workflows.run(req.params.id, req.client.id);
    record("session", "Ran a workflow");
    res.json(result);
  });
  app.post("/api/sessions/workflows/:id/resume", (req, res) => {
    macOwner(req);
    notPaused();
    res.json(workflows.resume(req.params.id, req.client.id));
  });
  app.post("/api/sessions/workflows/:id/stop", async (req, res) => {
    macOwner(req);
    res.json(await workflows.stop(req.params.id));
  });
  app.post("/api/sessions/workflows/:id/proposal", (req, res) => {
    macOwner(req);
    res.json(workflows.useProposal(req.params.id));
  });
  app.post("/api/sessions/workflows/:id/again", (req, res) => {
    macOwner(req);
    res.json(workflows.again(req.params.id, req.client.id));
  });
  app.post("/api/sessions/workflows/:id/remove", (req, res) => {
    macOwner(req);
    res.json(workflows.remove(req.params.id));
  });
  app.post("/api/sessions/workflows/:id/tasks/:task/:action", async (req, res) => {
    macOwner(req);
    const { id, task, action } = req.params;
    if (action === "retry") {
      notPaused();
      return res.json(workflows.retry(id, task, req.client.id));
    }
    if (action === "skip") return res.json(workflows.skip(id, task, req.client.id));
    if (action === "done") return res.json(await workflows.done(id, task, req.client.id));
    throw fail(404, "Unknown action.");
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
  const agentFiles = createAgentFiles({ dir: path.join(config.dataDir, "agent-files") });
  const imageRepeats = createImageRepeats({ file: path.join(config.dataDir, "image-repeats.json") });
  const savings = createSavings({ file: path.join(config.dataDir, "savings.json") });
  // Pictures the chat already has go as a note, not again (image-repeats.mjs);
  // what that saved goes in the savings ledger once the chat took the message.
  const imageSaving = (agent, files) =>
    files.reduce((sum, file) => {
      try {
        return sum + imageTokens(imageSize(fs.readFileSync(file)), agent);
      } catch {
        return sum;
      }
    }, 0);
  const voice = (overrides.voiceFactory || createVoice)({ config });
  // Five minutes of the phone's 16 kHz WAV is under 10 MB.
  const voiceUpload = multer({
    dest: path.join(config.dataDir, "agent-files"),
    limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 0, parts: 2, headerPairs: 32 },
  });
  const fileUpload = multer({
    dest: path.join(config.dataDir, "agent-files"),
    limits: { fileSize: 200 * 1024 * 1024, files: 1, fields: 0, parts: 2, headerPairs: 32 },
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
  // A thinking level by its id: the agent checks it against the model (a
  // level a newer one adds works at once; it goes as an argument, never a shell).
  const EFFORT = /^[a-z][a-z0-9_-]{0,23}$/;
  // Permission modes a reply may switch to, in each agent's own terms: Codex's
  // own and its named profiles (as its menu lists them, codex.mjs); Claude
  // Code's by id (one it doesn't list runs as Manual, claude-host.mjs).
  const REPLY_MODES = {
    codex: isCodexMode,
    claude: (mode) => /^[A-Za-z][\w-]{0,40}$/.test(mode),
  };
  const withFiles = (text, files, agent) =>
    files.length ? [text.trim(), files.map((f) => (agent === "claude" ? `@${f}` : f)).join("\n")].filter(Boolean).join("\n\n") : text;
  const turnOptions = (body, agent) => {
    if (body.model !== undefined && body.model !== null && !MODEL.test(body.model))
      throw fail(400, "Unknown model.");
    if (body.effort !== undefined && body.effort !== null && !(typeof body.effort === "string" && EFFORT.test(body.effort)))
      throw fail(400, "Unknown thinking level.");
    if (agent && body.mode !== undefined && body.mode !== null && !(typeof body.mode === "string" && Object.hasOwn(REPLY_MODES, agent) && REPLY_MODES[agent](body.mode)))
      throw fail(400, "Unknown permission mode.");
    // Codex's speed (a service tier id from its model list, e.g. "default").
    if (body.speed !== undefined && body.speed !== null && (typeof body.speed !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(body.speed)))
      throw fail(400, "Unknown speed.");
    return {
      // Files attached go as their paths, as each agent's composer names a
      // file: @path for Claude Code, the path for Codex.
      text: withFiles(typeof body.text === "string" ? body.text : "", agentFiles.paths(body.files), agent || body.agent),
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
    const name = typeof req.body?.name === "string" ? req.body?.name : "";
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
  // Any file for a message (images go as images, above).
  app.post("/api/sessions/files", fileUpload.single("file"), async (req, res) => {
    if (!req.file) throw fail(400, "Choose a file.");
    res.json({ id: agentFiles.add(req.file.path, req.file.originalname), name: path.basename(req.file.originalname || "file") });
  });
  // A voice memo from the composer: its words to read over, or, when it
  // can't become words, the recording itself to attach.
  app.post("/api/sessions/voice", voiceUpload.single("file"), async (req, res) => {
    if (!req.file) throw fail(400, "Record a memo.");
    let retained = false;
    try {
      req.reauthorize();
      const kind = audioKind(readHead(req.file.path));
      if (!kind) throw fail(400, "That isn't a recording.");
      const heard = await voice.transcribe(req.file.path, { locale: req.query.locale, authorize: () => req.reauthorize() });
      req.reauthorize();
      if (heard.text) return res.json({ text: heard.text });
      const name = memoName(kind);
      const id = agentFiles.add(req.file.path, name);
      retained = true;
      res.json({ problem: heard.problem, file: { id, name } });
    } finally {
      // Only this request's temporary upload is removed. A successfully
      // registered fallback has already moved to its own attachment path.
      if (!retained) fs.rmSync(req.file.path, { force: true });
    }
  });
  // Files in a chat's folder, for "@" in its composer.
  app.get("/api/sessions/:agent/:id/files", async (req, res) =>
    res.json({ files: await agentSessions.findFiles(req.params.agent, req.params.id, typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "") }),
  );
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
    const modeSettings =
      agent === "codex"
        ? codexStartMode(body.mode)
        : typeof body.mode === "string" && ["auto", "manual", "acceptEdits", "plan", "bypassPermissions", "dontAsk"].includes(body.mode) ? { mode: body.mode } : null;
    if (body.mode !== undefined && !modeSettings)
      throw fail(400, "Unknown permission mode.");
    const result = await agentSessions.start(agent, {
      ...turnOptions(body),
      cwd: sessionFolder(body.cwd),
      ...(modeSettings || {}),
      // Codex: remembered for the chat's next messages (chat-modes.mjs).
      ...(agent === "codex" && body.mode ? { modeName: body.mode } : {}),
      name: typeof body.name === "string" ? body.name.slice(0, 120) : undefined,
    });
    if (typeof result?.threadId === "string" && Array.isArray(body.images)) imageRepeats.add(agent, result.threadId, body.images);
    record("session", `Started a ${agentLabel(agent)} session from Reach`);
    res.json(result);
  });
  // Chats mentioned with "@" (at most three, from any agent here): each one's
  // latest exchange goes ahead of the message (agent-sessions/chat-context.mjs).
  const mentioned = async (value, here) => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > MAX_MENTIONS) throw fail(400, `Mention up to ${MAX_MENTIONS} chats.`);
    const blocks = [];
    for (const chat of value) {
      const agent = String(chat?.agent || "");
      const id = String(chat?.id || "");
      if (!["codex", "claude", "gemini"].includes(agent) || !/^[\w-]{1,80}$/.test(id) || (agent === here.agent && id === here.id))
        throw fail(400, "Unknown chat.");
      const page = await agentSessions.read(agent, id, { limit: 200 });
      blocks.push(mentionBlock({ from: agentName(agent), title: page.session?.title || "", cwd: page.session?.cwd || "", items: page.items || [] }));
    }
    return blocks;
  };
  app.post("/api/sessions/:agent/:id/messages", async (req, res) => {
    const { agent, id } = req.params;
    const { fresh, repeated } = imageRepeats.split(agent, id, req.body?.images);
    const options = turnOptions({ ...(req.body || {}), images: fresh }, agent);
    const repeatFiles = agentImages.paths(repeated);
    const chats = await mentioned(req.body?.chats, req.params);
    if (chats.length) options.text = withMentions(options.text, chats);
    // Outermost, so every reader of the message strips it (message-text.mjs).
    const note = repeatFiles.length ? repeatNote(repeatFiles) : "";
    if (note) options.text = `${note}\n\n${options.text}`;
    const result = await agentSessions.send(
      req.params.agent,
      req.params.id,
      {
        ...options,
        // A Codex skill picked from "/", by name (its path is Codex's own).
        ...(req.params.agent === "codex" && typeof req.body?.skill === "string" && /^[\w:.-]{1,120}$/.test(req.body?.skill)
          ? { skill: req.body?.skill }
          : {}),
        // An answer to what Codex asked: into its running turn, not the queue.
        ...(req.params.agent === "codex" && req.body?.steer === true ? { steer: true } : {}),
        // Codex's plan mode for this turn and on (the Codex app's Plan toggle).
        ...(req.params.agent === "codex" && ["plan", "default"].includes(req.body?.collaboration) ? { collaboration: req.body?.collaboration } : {}),
        owner: req.client.id,
      },
    );
    // Only once the chat has it: a queued message can still fail or be
    // discarded, and its pictures then go again next time.
    if (!result?.queued) {
      imageRepeats.add(agent, id, Array.isArray(fresh) ? fresh : []);
      // Less the note itself (about a token per four characters).
      if (note) savings.record({ agent, kind: "image-repeat", tokens: imageSaving(agent, repeatFiles) - Math.ceil(note.length / 4), count: repeatFiles.length });
    }
    record("session", `Sent a message to ${agentLabel(req.params.agent)}`);
    res.json(result);
  });
  // A Codex app approval as the phone draws it, read through the Codex app's
  // IPC when the phone opens it (nothing is brought up or clicked).
  app.get("/api/sessions/:agent/:id/card", async (req, res) => {
    res.set("Cache-Control", "no-store").json(await agentSessions.card(req.params.agent, req.params.id));
  });
  // Claude Code's permissions and questions answered from the phone: Reach's
  // hook in Claude Code's settings, put there or taken out by the owner (it
  // changes how Claude Code asks on this Mac).
  app.get("/api/agents/claude/phone-answers", (req, res) => {
    res.set("Cache-Control", "no-store").json({ state: agentSessions.phoneAnswers?.state() || "unsupported" });
  });
  app.post("/api/agents/claude/phone-answers", (req, res) => {
    macOwner(req);
    if (!agentSessions.phoneAnswers) throw fail(501, "Not available here.");
    const result = req.body?.on === false ? agentSessions.phoneAnswers.disable() : agentSessions.phoneAnswers.enable();
    record("session", req.body?.on === false ? "Stopped answering Claude Code from the phone" : "Answers Claude Code from the phone");
    res.json(result);
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
  // (agent-sessions/move.mjs); the new chat's address comes back. resume:
  // the new agent is told to keep going too (one tap when out of usage).
  app.post("/api/sessions/:agent/:id/move", async (req, res) => {
    const resume = req.body?.resume === true;
    if (resume) notPaused();
    const moved = await agentSessions.move(req.params.agent, req.params.id, { to: req.body?.to, authorize: () => req.reauthorize(), resume, owner: req.client.id });
    record("session", `Continued a chat in ${agentName(moved.agent)}`);
    res.json(moved);
  });
  app.post("/api/sessions/:agent/:id/fork", async (req, res) => {
    macOwner(req);
    const forked = await agentSessions.fork(req.params.agent, req.params.id, {
      to: req.body?.to, through: req.body?.through ?? null, authorize: () => req.reauthorize(),
    });
    record("session", `Forked a chat in ${agentName(forked.agent)}`);
    res.json(forked);
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
    const { model, effort, speed } = req.body || {};
    // Claude's Effort page sends the level alone: the chat keeps its model.
    if ((model == null && (effort == null || req.params.agent !== "claude")) ||
        (model != null && (typeof model !== "string" || !model.trim() || model.length > 200 || /[\x00-\x1f]/.test(model))) ||
        (effort != null && (typeof effort !== "string" || !effort.trim() || effort.length > 80 || /[\x00-\x1f]/.test(effort))))
      throw fail(400, "Choose a model and thinking level.");
    // Codex's speed (its service tier), changed mid-chat as in the Codex app.
    if (speed != null && (req.params.agent !== "codex" || typeof speed !== "string" || !/^[A-Za-z0-9._-]{1,40}$/.test(speed)))
      throw fail(400, "Unknown speed.");
    res.json(await agentSessions.model(req.params.agent, req.params.id, { model, effort, ...(speed ? { speed } : {}) }));
  });
  app.post("/api/sessions/:agent/:id/mode", async (req, res) => {
    macOwner(req);
    const mode = req.body?.mode;
    // Claude: never Bypass. Codex: its own menu's choices, as when sending.
    const allowed = req.params.agent === "codex" ? isCodexMode(mode) : SWITCHABLE_MODES.includes(mode);
    if (!allowed) throw fail(400, "Reach can't pick that mode.");
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
  // Rewind to before a message (Claude Code's own rewind).
  app.post("/api/sessions/:agent/:id/rewind", async (req, res) => {
    const b = req.body || {};
    if (typeof b.messageId !== "string") throw fail(400, "Choose a message.");
    const result = await agentSessions.rewind(req.params.agent, req.params.id, {
      messageId: b.messageId,
      code: b.code === true,
      conversation: b.conversation === true,
      dryRun: b.dryRun === true,
      authorize: () => req.reauthorize(),
    });
    if (!b.dryRun) record("session", `Rewound a ${agentLabel(req.params.agent)} chat`);
    res.json(result);
  });
  // One sub-agent stopped, the chat going on.
  app.post("/api/sessions/:agent/:id/subagents/:task/stop", async (req, res) => {
    const result = await agentSessions.stopSubagent(req.params.agent, req.params.id, req.params.task);
    record("session", `Stopped a ${agentLabel(req.params.agent)} sub-agent`);
    res.json(result);
  });
  // A chat deleted, as in its app (Codex's delete; a Claude chat to the Trash).
  app.delete("/api/sessions/:agent/:id", async (req, res) => {
    macOwner(req);
    const result = await agentSessions.deleteChat(req.params.agent, req.params.id);
    record("session", `Deleted a ${agentLabel(req.params.agent)} chat`);
    res.json(result);
  });
  // A chat renamed, as in its app.
  app.post("/api/sessions/:agent/:id/rename", async (req, res) => {
    if (typeof req.body?.title !== "string") throw fail(400, "Name the chat.");
    const result = await agentSessions.rename(req.params.agent, req.params.id, req.body?.title);
    record("session", `Renamed a ${agentLabel(req.params.agent)} chat`);
    res.json(result);
  });
  // Answers to what Codex asked while it works, into that turn (as the Codex
  // app answers them), never queued as a message.
  app.post("/api/sessions/:agent/:id/questions/:item", async (req, res) => {
    const { turnId, answers } = req.body || {};
    const result = await agentSessions.answerQuestions(req.params.agent, req.params.id, { itemId: req.params.item, turnId, answers });
    record("session", `Answered ${agentLabel(req.params.agent)} on the phone`);
    res.json(result);
  });
  // Your last message edited and sent again (the Codex app's Edit).
  app.post("/api/sessions/:agent/:id/edit-last", async (req, res) => {
    const { turnId, text } = req.body || {};
    if (typeof turnId !== "string" || typeof text !== "string") throw fail(400, "Write the message.");
    const result = await agentSessions.editLast(req.params.agent, req.params.id, { turnId, text });
    record("session", `Edited the last message in ${agentLabel(req.params.agent)}`);
    res.json(result);
  });
  // A queued message's words changed where it waits (its pictures kept).
  app.post("/api/sessions/:agent/:id/queue/:message/edit", async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== "string" || text.length > 50000) throw fail(400, "Messages can be up to 50,000 characters.");
    res.json(await agentSessions.editQueued(req.params.agent, req.params.id, req.params.message, text));
  });
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
    const openKey = `${req.params.agent}:${req.params.id}`;
    chatOpenAt.delete(openKey);
    chatOpenAt.set(openKey, Date.now());
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
    const run = req.body?.run;
    if (run !== undefined && !Object.hasOwn(AGENTS, run))
      throw fail(400, "Choose Codex or Claude Code.");
    // A command from a chat's code block (its play button): typed into the
    // new shell as the person would type it, so it can do nothing their own
    // typing in a Reach terminal couldn't. Text only, one screenful at most.
    const input = req.body?.input;
    if (input !== undefined && (run !== undefined || typeof input !== "string" || !input.trim() ||
        input.length > 8000 || /[\0-\x08\x0b-\x1f\x7f]/.test(input)))
      throw fail(400, "That command can't be run here.");
    // A chat's folder, by its full path: it must be inside a shared folder,
    // then it meets the same checks as any other.
    let root = req.body?.root, relative = req.body?.path || "";
    // A chat with no folder of its own (OpenClaw, a Gemini chat Reach can't
    // place) runs it in the home folder, if that's shared.
    if (input !== undefined && req.body?.cwd === undefined && root === undefined)
      req.body.cwd = os.homedir();
    if (typeof req.body?.cwd === "string") {
      const roots = req.client?.agentRoots || config.roots;
      // Real paths on both sides (/tmp and /var are links on a Mac).
      const real = (p) => { try { return fs.realpathSync.native(p); } catch { return ""; } };
      const wanted = path.isAbsolute(req.body.cwd) ? real(req.body.cwd) : "";
      const at = wanted
        ? roots.findIndex((r) => {
            const rel = path.relative(real(r), wanted);
            return real(r) && rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
          })
        : -1;
      if (at < 0) throw fail(403, "This folder isn't one of your shared folders.");
      root = at;
      relative = path.relative(real(roots[at]), wanted);
    }
    const cwd = resolve(root, relative, req.client);
    if (!fs.statSync(cwd).isDirectory()) throw fail(400, "Choose a folder.");
    const command = run ? await locateAgent(run) : "";
    if (run && !command)
      throw fail(404, `${AGENTS[run]} isn't installed on this computer.`);
    const terminal = terminals.create({
      cwd,
      name: req.body?.name || (run ? AGENTS[run] : undefined),
      clientId: req.client.id,
      command,
      input: input?.trim(),
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
    const result = await appShortcuts.run(req.body?.id, () =>
      shortcutOwner(req, res),
    );
    record("app", result.name);
    res.json(result);
  });
  app.get("/api/apps", async (req, res) => {
    const list = await (overrides.appList || apps)();
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
    const result = await launchApp(req.body?.id);
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
  // A hidden app display, watched whole (/ws/screen with its display id):
  // only by someone who may use every app on it. One whose app can't be
  // told stays closed.
  const displayAppsAllowed = (client, display) => {
    if (!client) return false;
    if (client.scopes.includes("admin")) return true;
    // Every thread on it, running or not: list() hides an opening one's display.
    const owners = [...appThreads.threads.values()].filter(
      (t) => t.display && String(t.display) === String(display),
    );
    return owners.length > 0 && owners.every((t) => appAllowed(client, t.appId));
  };
  const threadAppOr404 = (id) => {
    const thread = appThreads.get(id);
    if (!thread) throw fail(404, "That app window closed.");
    return thread.appId ?? "";
  };
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
    appOwner(req, threadAppOr404(req.params.id));
    appManager(req);
    notPaused();
    res.json(await appThreads.rotate(req.params.id, req.body));
  });
  app.post("/api/screen/apps/:id/activate", async (req, res) => {
    appOwner(req, threadAppOr404(req.params.id));
    notPaused();
    res.json(await appThreads.activate(req.params.id));
  });
  app.delete("/api/screen/apps/:id", async (req, res) => {
    appOwner(req, threadAppOr404(req.params.id));
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
    appOwner(req, threadAppOr404(req.params.id));
    if (!req.client.scopes.includes("admin"))
      throw fail(403, "Only a paired person can quit apps.");
    notPaused();
    res.json(await appThreads.quit(req.params.id, req.body?.confirm === true));
  });
  app.get("/api/screen/apps/:id/fields", async (req, res) => {
    appOwner(req, threadAppOr404(req.params.id));
    appControl(req);
    notPaused();
    res.set("Cache-Control", "no-store").json(await appThreads.fields(req.params.id));
  });
  // Tag in, for agents with apps:drive: open an app on its own hidden
  // display, look at it, act in it, hand it to the person, wait, close.
  const driveOnMac = () => {
    // "Tag in" on a hidden per-app display needs an attestation-signed virtual
    // display driver on Windows (docs/WINDOWS_AGENT_PARITY.md difference table);
    // a PC's agents use apps on the real screen through the Apps preset instead.
    if (appThreads.platform !== "darwin")
      throw fail(501, process.platform === "win32"
        ? "Hidden per-app displays need a Mac. On a Windows PC, agents use apps on the real screen with the Apps preset."
        : "Agents can use apps on a Mac for now.");
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
  // OpenClaw's schedules and sub-agents finishing, failing or gone quiet.
  const openClawWatch = createOpenClawWatch({ client: openClaw });
  // Reach's own updates (reach-updates.mjs): offered on the phone once per
  // version, installed exactly as confirmed, then Reach starts again on it.
  const reachUpdates = overrides.reachUpdates || createReachUpdates({
    root: fileURLToPath(new URL("../", import.meta.url)),
    dataDir: config.dataDir,
    restart: overrides.restartReach || (process.platform === "darwin"
      ? () => startInTerminal(fileURLToPath(new URL("../", import.meta.url)), { state: config.dataDir, args: "restart --yes" })
      : null),
    // Windows can't replace a running Reach's files: the confirmed version's
    // update goes to a window of its own, which stops Reach, installs and
    // starts it again (scripts/bootstrap.mjs update).
    handoff: overrides.updateHandoff || (process.platform === "win32"
      ? (version) => {
          askUpdate(config.dataDir, version);
          startInConsole(fileURLToPath(new URL("../", import.meta.url)), { state: config.dataDir, args: "update" });
        }
      : null),
    record: (title) => record("update", title),
  });
  reachUpdates.listen?.(() => {
    void notifications.refresh({ fresh: true }).catch(() => {});
    for (const nudge of presenceNudges) nudge();
  });
  if (!process.env.NODE_TEST_CONTEXT) reachUpdates.watch();
  const readNotificationState = () => readAttention({
    agentSessions, openClaw,
    background: () => openClawWatch.items(),
    handoffs: () => agentApps.pending(),
    browserRequests: () => browserApprovals.listOwner(),
    serviceRequests: () => agentServices.inspect(),
    admissions: () => auth.listAgentAdmissions(),
    accessRequests: pendingRequests,
    restartRequests: () => restarts.list(),
    updateOffers: () => [reachUpdates.offer()].filter(Boolean),
    syncOffers: () => keepInSync.offers(),
    terminalCount: () => terminals.list().length,
  });
  const answerNotification = createNotificationActions({
    read: readNotificationState,
    run: async (binding, action, authorize) => {
      const owner = authorize();
      if (binding.type === "chat")
        return agentSessions.respond(binding.agent, binding.session, binding.prompt, binding.choices[action]);
      if (binding.type === "restart") return restarts.decide(binding.id, action);
      if (binding.type === "update") {
        if (action !== "update") return reachUpdates.dismiss(binding.version);
        notPaused();
        try { return reachUpdates.start(binding.version); }
        catch (error) { throw fail(error.status || 500, error.message); }
      }
      // A piece Reach drives, behind or too old (keep-in-sync.mjs).
      if (binding.type === "sync") {
        if (action === "deny") return keepInSync.dismiss(binding.id, binding.pair);
        notPaused();
        try { return await keepInSync.start(binding.id, { anyway: action === "update-anyway", pair: binding.pair }, { authorize }); }
        catch (error) { throw Object.assign(fail(error.status || 500, error.message), error.working ? { working: error.working } : {}); }
      }
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
        startInWindow(fileURLToPath(new URL("../", import.meta.url)), {
          state: config.dataDir,
          args: "restart --yes",
        })),
    // The Claude chats a restart would cut off mid-step.
    working: () => agentSessions.working?.() || [],
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
  openClawWatch.onChange(() => notifications.wake?.());
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
  mountReachUpdates(app, { updates: reachUpdates, notPaused, record: (title) => record("update", title), fail });
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
    if (!config.screen && req.body?.enabled)
      throw fail(403, "Turn on screen viewing first.");
    if (req.body?.enabled && privateViewRefused(!actsAsOwner(req.client), overrides.platform || process.platform))
      throw fail(403, PRIVATE_VIEW_UNAVAILABLE);
    let lease;
    try {
      lease = screenControl.acquire(req.client, req.body?.enabled, {
        takeover: req.body?.takeover === true,
      });
    } catch (e) {
      // Someone else controls: say who, so the phone can watch (or offer
      // Take over) instead of fighting for it.
      if (!e.holder) throw e;
      return res
        .status(409)
        .json({ error: e.message, holder: e.holder, canTakeOver: e.canTakeOver });
    }
    // Control off keeps the phone's connection parked a minute: Control
    // again resumes on it (server/desktop-connection.mjs).
    if (!req.body?.enabled)
      for (const [id, ws] of inputConnections)
        if (id === req.client.id) (ws.parkControl || ws.endControl)?.();
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
    if (privateViewRefused(!actsAsOwner(req.client), overrides.platform || process.platform))
      throw fail(403, PRIVATE_VIEW_UNAVAILABLE);
    screenControl.check(req.client);
    if (inputConnections.has(req.client.id))
      throw fail(409, "Use the active desktop input channel.");
    if (screenControl.inputStopping())
      throw fail(409, "Wait for the previous desktop input helper to stop.");
    if (inputInFlight)
      throw fail(409, "Wait for the previous screen action to finish.");
    inputInFlight = true;
    try {
      const done = await screenInput(config, req.body, () => {
        if (
          res.destroyed ||
          !config.screen ||
          !verify(req, req.headers.authorization?.replace(/^Bearer /, ""))
        )
          throw fail(403, "Screen access was turned off or revoked.");
        screenControl.check(req.client);
        if (screenControl.inputStopping())
          throw fail(409, "Wait for the previous desktop input helper to stop.");
      });
      ownerUsed(req.client);
      res.json(done);
    } finally {
      inputInFlight = false;
    }
  });
  // "Let them back": agents have the screen again now, not 2 minutes after
  // your last input. Yours and full-access people's only.
  app.post("/api/screen/agents-back", (req, res) => {
    if (!actsAsOwner(req.client))
      throw fail(403, "Only the owner can let agents back on the screen.");
    if (ownerHold.release()) for (const nudge of presenceNudges) nudge();
    res.json({ ok: true });
  });
  app.get("/api/screen", async (req, res) => {
    if (!config.screen)
      throw fail(403, "Screen viewing is off. Turn it on in Reach first.");
    // A whole, unfiltered picture: yours and full-access people's only.
    // Everyone else watches the live screen, without the private windows.
    if (!actsAsOwner(req.client))
      throw fail(403, `Open the live screen to watch this ${computerWord(process.platform)}.`);
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
    const cwd = resolve(req.body?.root, req.body?.path || "", req.client);
    if (!fs.statSync(cwd).isDirectory()) throw fail(400, "Choose a folder.");
    const chat = await codex.create(cwd, req.body?.name, req.client.id);
    record("chat", `Started ${chat.name}`);
    res.json(chat);
  });
  app.get("/api/chats/:id", (req, res) => res.json(codex.get(req.params.id)));
  app.post("/api/chats/:id/messages", async (req, res) =>
    res.json(await codex.message(req.params.id, req.body?.text)),
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
      if (!current || current.policy?.browser || paused || !transportAvailable ||
          !current.scopes.some(scope => scope === "files" || scope === "files:read") ||
          resolve(link.root, link.path, current) !== link.file)
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
    let checkedAt = 0;
    const timer = setInterval(() => {
      // The credential file is re-read at most once a second.
      if (Date.now() - checkedAt < 1000) return;
      try { check(); checkedAt = Date.now(); } catch { stop(); }
    }, 100);
    timer.unref();
    const cleanup = () => { clearInterval(timer); identityCleanup(); };
    res.once("close", cleanup); res.once("finish", cleanup);
    res.setHeader("Cache-Control", "no-store");
    const sharedRoot = (client.agentRoots || config.roots)[Number(link.root ?? 0)];
    const realRoot = (() => { try { return fs.realpathSync(sharedRoot); } catch { return sharedRoot; } })();
    res.download(path.relative(realRoot, file), path.basename(file), { root: realRoot });
  });
  serveBuild(app, express, dist, {
    // Its agent links' start page: the one address, without Reach's port.
    agentStart: () => (config.publicOrigin?.startsWith("https://") ? `https://${new URL(config.publicOrigin).hostname}` : ""),
    platform: hostPlatform,
  });
  // A folder the Mac itself keeps from Reach (Desktop, Documents, Downloads,
  // a disk: macOS's privacy settings, per app). "Your computer has not
  // granted access" read on the phone as Reach refusing its owner (Oct 7):
  // it names what to allow, and where.
  const privacyRefusal = () => {
    // Windows says EPERM for a file another program holds as well as for
    // its permissions and Controlled folder access (parity audit #39).
    if (process.platform === "win32")
      return "Windows didn't let Reach open this. Another program may have it open, or Windows Security (Controlled folder access) or its permissions keep it from Reach.";
    if (process.platform !== "darwin")
      return "Your computer has not granted access to this location.";
    let host = "";
    try {
      host = hostAppName();
    } catch {
      /* unknown: the generic wording */
    }
    return `macOS hasn't let Reach open this location. On your Mac, allow ${host || "the app running Reach, such as Terminal"} in System Settings → Privacy & Security → Files & Folders (or Full Disk Access), then try again.`;
  };
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
            // Not 423: Reach says "paused" and "in use in another browser" with it.
            EBUSY: 409,
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
                ? privacyRefusal()
                : error.code === "EEXIST"
                  ? "That name is already in use."
                  : error.code === "EBUSY"
                    ? "This file is open in another program. Close it there, then try again."
                    : "Could not complete this action. Check the companion console.",
        ...(error.canNarrowDefault === true ? { canNarrowDefault: true } : {}),
        // A refused Face ID answer: its reason stays (faceIdAnswer).
        ...(error.passkey === true ? { passkey: true } : {}),
        // A person waiting for the owner's Allow: their page waits too.
        ...(error.waiting === true ? { waiting: true } : {}),
        // An update that would stop working chats: how many (keep-in-sync.mjs).
        ...(Number.isInteger(error.working) && error.working > 0 ? { working: error.working } : {}),
        // An agent held off while you use the Mac: who, and when to look again.
        ...(error.kind === "paused" && Number.isFinite(error.retryInMs)
          ? { kind: "paused", holder: String(error.holder || ""), retryInMs: error.retryInMs }
          : {}),
      });
    if (!error.status && !req.aborted) console.error(error.message);
  });
  const WS_ROUTES = [
    "/ws/terminal",
    "/ws/screen",
    "/ws/screen-input",
    "/ws/screen-sound",
    "/ws/presence",
  ];
  // Live connections the host guard turned away, last logged when (per
  // route): a phone's live screen that never opens says why in Reach's log.
  const guardRefusals = new Map();
  const upgrade = async (req, socket, head) => {
    if (browserHostGuard.isActive()) {
      try {
        await browserHostGuard.refresh();
        // A person's device comes through; their credential is checked with
        // the guard when it arrives (verify).
        if (!browserHostGuard.allowsConnection(req)) browserHostGuard.assertRequest(req);
      } catch (e) {
        const route = WS_ROUTES.includes(req.url) ? req.url : "a live";
        const now = Date.now();
        if (now - (guardRefusals.get(route) || 0) > 10000) {
          guardRefusals.set(route, now);
          console.warn(
            `Reach: ${route} connection refused by the host guard: ${String(e?.message || e).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300)}`,
          );
        }
        socket.destroy();
        return;
      }
    }
    if (config.tailscaleOwner && (!trustedRequest(req) || !req.reachIdentity))
      return socket.destroy();
    if (!transportAvailable) {
      socket.destroy();
      return;
    }
    if (wss.clients.size >= 64) {
      // Said (once a minute, with the count per kind), so a live screen that
      // won't open has a named cause.
      const now = Date.now();
      if (now - refusedFullAt > 60000) {
        refusedFullAt = now;
        const kinds = {};
        for (const client of wss.clients) kinds[client.reachChannel || "presence"] = (kinds[client.reachChannel || "presence"] || 0) + 1;
        const route = String(req.url || "").split("?")[0].replace(/[^\w/-]/g, "").slice(0, 40) || "other";
        console.warn(`Reach: refused a live connection (${route}): 64 are open already (${Object.entries(kinds).map(([kind, n]) => `${kind} ${n}`).join(", ")}).`);
      }
      socket.destroy();
      return;
    }
    if (
      !WS_ROUTES.includes(req.url) ||
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
          // People who may see the computer's own terminals keep them
          // watched (a Mac's or a Windows PC's).
          const macTerminals =
            ["darwin", "win32"].includes(desktopTerminals.platform) &&
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
            // Who else is using the Mac right now (a person in control, or
            // an agent acting), by name: shown on the live screen, so people
            // and agents take turns knowingly.
            ...(scopes.includes("screen") && (() => {
              const held = screenControl.holder();
              const using = held && held.clientId !== client.id ? held.name || "Someone" : agentDesktop?.usingNow?.() || "";
              return using ? { using: String(using).slice(0, 80) } : {};
            })()),
            // Agents wait while you use the screen (server/screen.mjs
            // OwnerHold): one quiet pill with "Let them back", for you and
            // full-access people, only when an agent could look. A flag, not
            // a countdown, so it changes only when the hold starts or ends.
            ...(scopes.includes("screen") && actsAsOwner(client) &&
              ownerHold.active() && screenAgentsPresent() && { agentsWait: true }),
            ...(macTerminals &&
              macTerminalWatch.version && {
                macTerminals: macTerminalWatch.version,
              }),
            // What agents hand you: the owner's, never a guest's.
            ...(scopes.includes("admin") &&
              client.kind !== "guest" && {
                handoffs: digest(agentApps.pending().map((h) => h.id)),
                browserRequests: digest(browserApprovals.listOwner().map((r) => r.id)),
                serviceAccess: digest(agentServices.inspect().map((r) => [r.id, r.status])),
                ...(client.kind === "device" && {
                  agentAdmissions: digest(auth.listAgentAdmissions().map((r) => r.requestId)),
                }),
              }),
            // The chat list (every agent's chats): the owner's devices read it
            // when this changes, instead of asking every few seconds.
            ...(scopes.includes("admin") &&
              client.kind !== "guest" &&
              agentSessions.listRevision && {
                sessions: String(agentSessions.listRevision() + (relays.revision?.() ?? 0) + (teams.revision?.() ?? 0) + (workflows.revision?.() ?? 0)),
              }),
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
                client.fullControlVersion ?? null,
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
        auth: {
          verify: (token) => verify(req, token),
          interruption: (token) => transientDenial(req, token),
        },
        control: screenControl,
        create: overrides.desktopInputFactory,
        platform: overrides.platform || process.platform,
        // Each input that reached the Mac: agents wait while you use it.
        used: ownerUsed,
        // A phone app's hidden display: only for those that app is shared with.
        allowDisplay: (client, display) =>
          // The same rule as watching it: every app on it must be theirs.
          !appThreads.ownsDisplay(display) ||
          displayAppsAllowed(client, display),
        register: (id, socket) => {
          // One control connection per phone; one on its way out (closed
          // here to reconnect, or by the phone for the same reason) makes
          // room for the one taking its place.
          const current = inputConnections.get(id);
          // A parked one (control off) gives way to the new one.
          if (current && current.readyState === WebSocket.OPEN && !current.parked)
            // Retryable: a reconnect can arrive a moment before the stalled
            // connection it replaces is noticed here (3 s without a word).
            throw Object.assign(
              fail(409, "This device already has a control connection. Reconnecting…"),
              { retryable: true },
            );
          current?.endControl?.("Desktop control reconnecting…", true);
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
    const expiryOf = (c) => c.expiresAt || Date.parse(c.createdAt) + 30 * 86400000;
    const expires = (client) => {
      const left = expiryOf(client) - Date.now();
      if (!Number.isFinite(left)) return;
      accessDeadline = setTimeout(
        () => {
          const current = auth.list().find((entry) => entry.id === client.id);
          if (!current || Date.now() >= expiryOf(current)) ws.close(4001, "Access expired");
          else expires(current);
        },
        Math.min(2147483647, Math.max(0, left)),
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
          const interruption = transientDenial(req, credential);
          if (interruption) {
            console.warn(`Reach: screen stream reconnecting: ${interruption}`);
            reject(interruption, 503);
            return false;
          }
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
            // Every protocol, the old one too: guests' pictures can't be
            // filtered off a Mac yet (remote-screen.mjs).
            if (privateViewRefused(!actsAsOwner(client), overrides.platform || process.platform))
              throw fail(403, PRIVATE_VIEW_UNAVAILABLE);
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
              // An app's hidden display only for whoever may use that app.
              const mayViewDisplay = (id) =>
                !appThreads.ownsDisplay(id) ||
                displayAppsAllowed(verify(req, credential), id);
              // You and full-access people see the whole screen (Dock,
              // menu bar, every window); everyone else, without the
              // private windows (password managers, Reach, Tailscale…).
              const privateView = !actsAsOwner(client);
              void (async () =>
                hub.add(ws, authorized, message, {
                  mayViewDisplay,
                  privateView,
                }))().catch((e) => {
                // The computer's own trouble (no displays, helper refused)
                // shows in Reach's window too; a refusal for this viewer
                // doesn't. Retrying can't fix a permanent one (Windows
                // policy): the phone stops and says why.
                if (!e.status || e.status >= 500) screenTrouble(e.message);
                reject(e.message, e.permanent ? 403 : e.status || 503);
              });
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
        // No control connection and none expected back: control is over.
        if (
          !inputConnections.has(ws.clientId) &&
          !screenControl.reconnecting(ws.clientId)
        )
          screenControl.revoke(ws.clientId);
      });
      ws.on("error", () => {});
      return;
    }
    if (req.url === "/ws/screen-sound") {
      // The computer's sound beside its live screen: for you and people with
      // full access (never anyone else, agents included), while its screen may
      // be watched and Reach isn't paused, and never in a browser on the
      // computer itself, which would play it into what it captures.
      let credential;
      const reject = (message, status = 403) => {
        screenSound.remove(ws);
        if (ws.readyState === WebSocket.OPEN) {
          const retryable = ![400, 401, 403, 404].includes(status);
          ws.send(JSON.stringify({ type: "error", error: message, status, retryable }));
          ws.close(status === 401 ? 4001 : retryable ? 1012 : 4003, "Sound ended");
        }
      };
      const refusal = (client) => {
        if (!["darwin", "win32"].includes(overrides.platform || process.platform))
          return "Sound comes from a Mac or a Windows PC.";
        if (!client.scopes.includes("screen") || !actsAsOwner(client))
          return "Only the owner and people with full access hear this computer.";
        if (!config.screen) return "Turn on screen viewing first.";
        return "";
      };
      const authorized = () => {
        const client = credential && verify(req, credential);
        if (!client) {
          const interruption = transientDenial(req, credential);
          reject(interruption || "Sound access expired or was revoked.", interruption ? 503 : 401);
          return false;
        }
        const refused = refusal(client);
        if (refused) {
          reject(refused);
          return false;
        }
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
      let starting = false;
      ws.on("message", async (buffer, binary) => {
        try {
          if (binary) throw fail(400, "Send a sound protocol message.");
          const message = JSON.parse(buffer.toString());
          if (!credential) {
            if (starting) return;
            if (message.type !== "auth" || typeof message.token !== "string")
              throw fail(401, "Authenticate first.");
            const client = verify(req, message.token);
            if (!client) throw fail(401, "Pair this device again.");
            const refused = refusal(client);
            if (refused) throw fail(403, refused);
            notPaused();
            if (!Array.isArray(message.codecs) || !message.codecs.includes("adpcm"))
              throw fail(400, "This browser can't play the computer's sound.");
            starting = true;
            // The visitor's word for where it is: it can only refuse.
            if (sameComputer(req, await ownTailscaleIps()))
              throw fail(403, "Sound plays on your phone or another device, not on this computer itself.");
            if (ws.readyState !== WebSocket.OPEN) return;
            credential = message.token;
            ws.clientId = client.id;
            expires(client);
            clearTimeout(deadline);
            if (authorized()) screenSound.add(ws, authorized);
          } else {
            if (!authorized()) return;
            if (message.type !== "ack") throw fail(400, "Unsupported sound message.");
            screenSound.ack(ws, message.seq);
          }
        } catch (e) {
          reject(e.message, e.status || 400);
        }
      });
      ws.on("close", () => {
        clearTimeout(deadline);
        clearInterval(expiryCheck);
        screenSound.remove(ws);
      });
      ws.on("error", () => {});
      return;
    }

    let session, listener, credential;
    let authorizedAt = 0;
    const stillAuthorized = () => {
      if (!credential) return true;
      // The credential file is re-read at most once a second.
      if (Date.now() - authorizedAt < 1000) return true;
      const client = verify(req, credential);
      if (
        client?.scopes.includes("terminal") &&
        (!client.agentRoots ||
          !session ||
          client.agentRoots.some((root) => within(root, session.cwd)))
      ) {
        authorizedAt = Date.now();
        return true;
      }
      // The phone's terminal reconnects on any close but 4001 (Sessions.tsx).
      if (!client && transientDenial(req, credential))
        ws.close(1012, "Checking the connection");
      else ws.close(4001, "Access revoked or expired");
      return false;
    };
    const expiryCheck = setInterval(stillAuthorized, 1000);
    expiryCheck.unref();
    // A phone that left without closing (a network change) answers no ping:
    // its terminal connection ends within a minute instead of holding one of
    // the 64 places until TCP notices (reliability audit, Oct 10).
    let answered = true;
    ws.on("pong", () => { answered = true; });
    const liveness = setInterval(() => {
      if (!answered) return ws.terminate();
      answered = false;
      try { ws.ping(); } catch { /* closing */ }
    }, terminalPingMs);
    liveness.unref();
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
      clearInterval(liveness);
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
  // An agent asked to connect (a link opened, a hosted agent's OAuth): the
  // owner's Needs you.
  const agentClaimed = (joined) => {
      // The same browser reconnecting, or getting its waiting request
      // again: nothing new for the owner.
      if (joined.refreshed || joined.resumed) return;
      // Its approved link, opened in another browser: the browser it used
      // is disconnected, and the new one waits for you to match its code
      // (its approved browser can still take it back at once).
      if (joined.moving) {
        endSession(joined.clientId);
        const name = auth.list().find((c) => c.id === joined.clientId)?.name || "An agent";
        record("agent", `${name}'s link was opened in another browser; the previous one was disconnected until you answer`);
      } else record("agent", joined.hosted ? "A hosted agent is waiting for connection approval" : "An invited browser agent is waiting for connection approval");
      notify({ category: "access", ...notificationPush(admissionNotification(auth.listAgentAdmissions().find((item) => item.requestId === joined.requestId) || { requestId: joined.requestId })), tag: `agent-admission-${joined.requestId}` });
      for (const nudge of presenceNudges) nudge();
  };
  publicAgent = config.publicOrigin?.startsWith("https://")
    ? createFunnelAgentGateway({
        auth,
        origin: new URL(config.publicOrigin).origin.replace(/:\d+$/, ""),
        privateHost: new URL(config.publicOrigin).host,
        requestHost: serveRequestHost,
        // Whenever Reach runs: an agent whose access ended is told so (401,
        // 410) instead of finding nothing. Nothing opens without credentials:
        // with no window, no invitation, request or access is left to use.
        available: () => !paused && transportAvailable,
        onFlood: (count) => {
          record("security", `The public link had ${count} requests from strangers in a minute: strangers are refused for 5 minutes`);
          notify({ category: "access", title: "Your public link is under a flood", body: "Strangers are refused for 5 minutes; your agents are unaffected. An agent joining right now would wait.", icon: "agent", tag: "funnel-flood" });
        },
        device: invitationDevice,
        claimed: agentClaimed,
        dispatch: (req, res, context) => {
          // Only the signature-verifying gateway can mark a request. Neither a
          // header nor a public token can manufacture a private Tailscale identity.
          funnelRequests.set(req, context);
          // Over the tailnet (the same link from an agent on it), the device's
          // Tailscale identity must never reach the inner routes: it may be
          // the owner's own login. The signed browser key is the only identity.
          req.reachIdentity = null;
          for (const name of Object.keys(req.headers))
            if (name.startsWith("tailscale-user-")) delete req.headers[name];
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
  // Reach as an MCP server at a URL (hosted-mcp.mjs): for agents that live
  // in a service (claude.ai, ChatGPT, Muse, Grok) and connect through OAuth.
  // The same tools, derived from the same preset; the owner approves with
  // the same code. On both routes, like the gateway.
  const hostedMcp = config.publicOrigin?.startsWith("https://")
    ? createHostedMcp({
        auth,
        origin: new URL(config.publicOrigin).origin.replace(/:\d+$/, ""),
        privateOrigin: new URL(config.publicOrigin).origin,
        requestHost: serveRequestHost,
        available: () => !paused && transportAvailable,
        computerName: config.name,
        dataDir: config.dataDir,
        // Told at initialize: a hosted agent is a program, never its page.
        guide: (client) => guideFor(client),
        claimed: agentClaimed,
        dispatch: hostedDispatch,
        onFlood: (count) => {
          record("security", `Reach's MCP address had ${count} requests from strangers in a minute: strangers are refused for 5 minutes`);
          notify({ category: "access", title: "Your public link is under a flood", body: "Strangers are refused for 5 minutes; your agents are unaffected. An agent connecting right now would wait.", icon: "agent", tag: "funnel-flood" });
        },
      })
    : null;
  const gatewayAgent = publicAgent;
  publicAgent = hostedMcp ? (req, res) => gatewayAgent(req, res) || hostedMcp.handle(req, res) : gatewayAgent;
  // Keys Reach knows (agents with access, or ended lately): the door's
  // check before anything is parsed (core.mjs reads the store again only
  // when it changed).
  const knownKey = (value) => { try { return auth.funnelKeys().has(value); } catch { return false; } };
  const doorKeyKnown = (value) => { try { return auth.doorKeyKnown(value); } catch { return false; } };
  // The one cookie the door reads (its value checked before anything else).
  const doorCookie = (req) => {
    const header = req.headers.cookie;
    if (typeof header !== "string" || header.length > 4096) return null;
    const match = /(?:^|;\s*)reach-door=([A-Za-z0-9_-]{43})(?:;|$)/.exec(header);
    return match ? match[1] : null;
  };
  // What the internet gets at the one address (`publicApp`, the start page),
  // behind the public door: the same on a Mac's socket and Windows' keyed route.
  const publicDoor = (publicApp) => publicApp && ((req, res) => {
    // Paused or between Tailscale blips: come back later (an agent's page
    // keeps retrying).
    if (paused || !transportAvailable) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Unavailable.");
    }
    // The public door (Oct 10): open to everyone only while something
    // needs a stranger to come in (a pairing, an invitation waiting, an
    // agent's page). Otherwise a request is answered only when it names
    // a key Reach knows (an agent's own, or one that ended lately, so
    // it hears that it ended): the signed gateway and the agent runtime
    // download. Anything else gets 404 before a byte is parsed.
    const window = auth.funnelWindow();
    const key = req.headers["reach-key"];
    const known = typeof key === "string" && key.length <= 64 && knownKey(key);
    const forAgents = (req.method === "POST" && req.url === "/agent-gateway") ||
      (req.method === "GET" && (req.url === "/agent.mjs" || /^\/agent-runtimes\/[0-9a-f]{64}\.mjs$/.test(req.url || "")));
    // A hosted agent's bearer token, and the OAuth token and discovery
    // endpoints while a hosted agent has access (hosted-mcp.mjs).
    const hosted = hostedMcp?.admits(req) === true;
    // Someone who came in through the browser and still has access: their
    // page and its code, by their own door key (a cookie; core.mjs).
    const door = (req.method === "GET" || req.method === "HEAD") && doorKeyKnown(doorCookie(req));
    if ((window.open && !window.keyed) || (known && forAgents) || hosted || door) return publicApp(req, res);
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found.");
  });
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
    // The 5-minute sweep of invitations nobody joined, run now (tests).
    clearUnopened,
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
    // The public route stays on while Reach runs (scripts/ephemeral-funnel.mjs),
    // so the internet gets nothing at all unless an invitation or agent
    // session is live.
    async listenPrivate(socketPath, { publicApp } = {}) {
      if (!config.tailscaleOwner)
        throw Error("Configure Tailscale identity first.");
      privateSocket = socketPath;
      privateServer = await listenPrivateIngress({
        socketPath,
        app,
        upgrade,
        resolveIdentity,
        publicApp: publicDoor(publicApp),
      });
    },
    // Windows: the same, on a keyed loopback route only Tailscale's own
    // process may use (server/tailscale-auth.mjs listenKeyedIngress). Its port.
    async listenKeyed({ key, peerCheck, publicApp, refuse, onRefused, selfIps } = {}) {
      if (!config.tailscaleOwner)
        throw Error("Configure Tailscale identity first.");
      privateServer = await listenKeyedIngress({ key, peerCheck, refuse, onRefused, selfIps, app, upgrade, resolveIdentity, publicApp: publicDoor(publicApp) });
      return privateServer.address().port;
    },
    setTransportAvailable(value) {
      if (transportAvailable === value) return;
      transportAvailable = value;
      if (value) auth.restartQuietClock();
      if (!value) {
        desktopAutomation.interrupt();
        screenControl.clear();
        closeInput();
        // Disconnect access without killing terminals, chats or jobs.
        for (const ws of wss.clients) ws.terminate();
      }
    },
    async close() {
      warming.abort();
      maintenanceStore.shutdown();
      // Asked to stop: the next start isn't after an unexpected end, even if
      // what follows takes too long and the launcher exits anyway.
      if (runMarker) markStopped(config.dataDir);
      tidying?.stop();
      hostedMcp?.close();
      desktopAutomation.close();
      stopInterfaceWatch();
      restarts.close();
      windowsTray?.stop();
      reachUpdates.close?.();
      notifications.close();
      openClawWatch.close();
      clearInterval(snapshotSweep);
      usageWatch.stop?.();
      browserOperations.close();
      browserApprovals.close();
      browserAppAccess.close();
      await browserApprovals.flushChanges();
      agentDesktop?.close?.();
      agentShortcuts.close();
      agentTools.close();
      browserExtension?.close?.();
      agentServices.close();
      await browserCommandLog.close();
      browserSnapshots.clear();
      clearInterval(approvalCleanup);
      for (const timer of guestTimers) clearTimeout(timer);
      clearInterval(originSync);
      screenStreams.stop("Reach is shutting down.");
      browserScreenSnapshots.stop("Reach is shutting down.");
      remoteScreens.stop("Reach is shutting down.", true);
      appScreens.stop("Reach is shutting down.", true);
      screenSound.stop("Reach is shutting down.", true);
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
      turnWatch.stop();
      relays.stop?.();
      workflows.stopTimer?.();
      teamBridge.close();
      search.stop?.();
      journal.flush?.();
      const terminalExit = terminals.dispose();
      codex.dispose();
      const jobExit = jobs.dispose();
      await Promise.all([apps, closed, terminalExit, jobExit]);
      clearTimeout(cutoff);
      // The last agent timings still on their way to disk land before Reach
      // says it stopped (a test removing the data folder raced them).
      await agentTimings.flushed?.().catch(() => {});
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
  // On Windows its console window (or terminal tab) is titled Reach the same
  // way, and the agents' checker closes the window that carries the name.
  if (process.stdout.isTTY && process.platform === "win32") process.title = "Reach";
  reach.server.listen(reach.config.port, reach.config.host, () => {
    console.log(
      `\n  Reach is ready · http://localhost:${reach.config.port}\n  Pairing code: ${reach.auth.pairing.code.slice(0, 4)} ${reach.auth.pairing.code.slice(4)} (one use, expires in 10 minutes)\n  Shared folders: ${reach.config.roots.join(", ")}\n  Run npm run share to connect through Tailscale.\n`,
    );
  });
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, async () => {
      try {
        await reach.close();
      } catch (error) {
        console.error("Reach did not close cleanly:", error?.message || error);
      }
      process.exit(0);
    });
}
