import { DevicePresence, presenceConnection } from "./presence.mjs";
import {
  createIdentityResolver,
  listenPrivateIngress,
  trustedRequest,
  ownerIdentity,
} from "./tailscale-auth.mjs";
import { approvalStore } from "./device-approval.mjs";
import {
  DesktopSessions,
  desktopPreparation,
  connectionRoute,
} from "./desktop-session.mjs";
import { createAppShortcuts } from "./app-shortcuts.mjs";
import express from "express";
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileRootName } from "./file-roots.mjs";
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
  validOrigin,
  validLeafName,
  hash,
  AGENT_SCOPES,
} from "./core.mjs";
import crypto from "node:crypto";
import { computerIdentity } from "./computer-identity.mjs";
import { readAgentPolicy, within } from "./agent-policy.mjs";
import { Terminals } from "./terminal.mjs";
import { DesktopTerminals } from "./desktop-terminals.mjs";
import { ScreenControl } from "./screen.mjs";
import { RemoteScreenHub } from "./remote-screen.mjs";
import { desktopDisplays } from "./desktop-native.mjs";
import { desktopConnection } from "./desktop-connection.mjs";
import { ScreenBroadcast, createScreenSource } from "./screen-stream.mjs";
import { Jobs } from "./jobs.mjs";
import { Codex } from "./codex.mjs";
import { createToolDetector, deviceCapabilities } from "./capabilities.mjs";
import {
  apps,
  launchApp,
  tailscaleInfo,
  screenCapture,
  screenInput,
  availableMemory,
} from "./platform.mjs";

export async function createReach(overrides = {}) {
  const instance = crypto.randomUUID();
  let transportAvailable = true;
  const config = getConfig(overrides);
  config.roots = config.roots.map((p) => fs.realpathSync(p));
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
    terminals = new Terminals(),
    codex = new Codex(config),
    jobs = new Jobs(config),
    app = express(),
    server = http.createServer(app);
  const detectTools = createToolDetector(overrides.toolDetection);
  const resolveIdentity = createIdentityResolver(overrides.tailscaleIdentity);
  const approvals = config.tailscaleOwner
    ? approvalStore(config.dataDir)
    : null;
  let privateServer;
  const approvalCleanup = approvals
    ? setInterval(() => approvals.list(), 30000)
    : null;
  approvalCleanup?.unref();
  const verify = (req, token) => auth.verify(token, req.reachIdentity);
  // Refresh long-running requests/sockets; cached CLI lookups are shared by node.
  const trackIdentity = (req, end) => {
    if (!config.tailscaleOwner) return () => {};
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        req.reachIdentity = await resolveIdentity(req);
        if (!req.reachIdentity) end();
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
  const desktopTerminals = new DesktopTerminals(overrides.desktopTerminals);
  const screenStreams = new ScreenBroadcast(
    overrides.screenStreamFactory || (() => createScreenSource(config)),
  );
  const remoteScreens = new RemoteScreenHub(
    config,
    overrides.remoteScreenFactory,
  );
  const inputConnections = new Map();
  const closeInput = (clientId) => {
    for (const [id, ws] of inputConnections)
      if (!clientId || id === clientId) ws.endControl?.();
  };
  const desktopIdentityCleanup = new Map();
  const desktopSessions = new DesktopSessions(config, {
    create: overrides.desktopSessionFactory,
    onEnd: (clientId) => {
      desktopIdentityCleanup.get(clientId)?.();
      desktopIdentityCleanup.delete(clientId);
      screenControl.revoke(clientId);
      closeInput(clientId);
    },
    controls: (clientId) =>
      screenControl.lease?.clientId === clientId &&
      screenControl.lease.expiresAt > Date.now(),
  });
  let captureInFlight;
  let inputInFlight = false;
  const events = [];
  const record = (kind, title) => {
    events.unshift({ id: id(), kind, title, at: new Date().toISOString() });
    events.length = Math.min(events.length, 100);
  };
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
  app.use((req, res, next) => {
    if (req.headers["tailscale-funnel-request"] !== undefined)
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
        "Authorization, Content-Type",
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
  app.use("/api/screen/desktop/clipboard", express.json({ limit: "3mb" }));
  app.use(express.json({ limit: "256kb" }));
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
    }),
  );
  app.use("/api", (req, res, next) => {
    if (config.tailscaleOwner && (!trustedRequest(req) || !req.reachIdentity))
      return res.status(403).json({
        error:
          "Connect through this computer's private Tailscale link. Localhost cannot authenticate a Tailscale device.",
      });
    const cleanup = trackIdentity(req, () => res.destroy());
    res.once("close", cleanup);
    res.once("finish", cleanup);
    next();
  });
  app.post("/api/auth/requests", (req, res) => {
    if (!approvals)
      throw fail(
        404,
        "Run ./reach configure on the computer to enable device approval.",
      );
    res
      .status(202)
      .json(
        approvals.request(
          req.reachIdentity,
          req.body.name,
          config.tailscaleOwner,
        ),
      );
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
  app.post("/api/guest/redeem", (req, res) =>
    res.json({
      ...auth.redeemGuest(req.body.invitation),
      device: {
        id: device.id,
        computerId: device.computerId,
        name: config.name,
        platform: process.platform,
      },
    }),
  );
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
    const scope = {
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
    }[route];
    const allowed = (identity) =>
      identity &&
      (route === "device" ||
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
      },
      capabilities: deviceCapabilities({
        platform: process.platform,
        scopes: req.client.scopes,
        screen: config.screen,
        codexInstalled: tools?.codex.installed,
      }),
      ...(tools && { tools }),
      host: loadJson(hostFile, null),
    });
  });
  app.delete("/api/device/access", (req, res) => {
    auth.revoke(req.client.id);
    res.type("json").send(JSON.stringify({ ok: true }));
  });
  app.get("/api/settings", (req, res) => res.json(settings));
  app.post("/api/settings", (req, res) => {
    if (typeof req.body.screen !== "boolean")
      throw fail(400, "Send screen as true or false.");
    settings.screen = config.screen = req.body.screen;
    if (!config.screen) {
      desktopSessions.revoke();
      screenControl.clear();
      screenStreams.stop();
      remoteScreens.stop();
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
  app.post("/api/guests", (req, res) => {
    const grant = auth.inviteGuest(req.body);
    record(
      "guest",
      `Invited ${req.body.name} until ${new Date(grant.expiresAt).toISOString()}`,
    );
    const url = new URL(
      "/guest",
      config.publicOrigin || `http://${req.headers.host}`,
    );
    url.hash = new URLSearchParams({ invite: grant.invitation }).toString();
    res.status(201).json({ ...grant, url: url.toString() });
  });
  app.get("/api/clients", (req, res) =>
    res.json({ current: req.client.id, clients: auth.list() }),
  );
  app.delete("/api/clients/:id", (req, res) => {
    auth.revoke(req.params.id);
    presence.removeClient(req.params.id);
    desktopSessions.revoke(req.params.id);
    screenControl.revoke(req.params.id);
    closeInput(req.params.id);
    for (const ws of wss.clients)
      if (ws.clientId === req.params.id) ws.close(4001, "Access revoked");
    res.type("json").send(JSON.stringify({ ok: true }));
  });
  const resolve = (root, p, client) => {
    const target = safePath(client?.agentRoots || config.roots, root, p);
    if (
      [config.dataDir, ...(config.privatePaths || [])].some((privatePath) => {
        const absolute = fs.existsSync(privatePath)
          ? fs.realpathSync(privatePath)
          : path.resolve(privatePath);
        return target === absolute || target.startsWith(absolute + path.sep);
      })
    )
      throw fail(403, "Reach’s private companion data is not shared.");
    return target;
  };
  app.get("/api/files", async (req, res) => {
    const dir = resolve(req.query.root, req.query.path || "", req.client);
    const info = await fsp.stat(dir);
    if (!info.isDirectory()) throw fail(400, "Choose a folder.");
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const showHidden = req.query.hidden === "1";
    const items = (
      await Promise.all(
        entries
          .filter((e) => showHidden || !e.name.startsWith("."))
          .slice(0, 2000)
          .map(async (e) => {
            try {
              const full = resolve(
                req.query.root,
                path.join(String(req.query.path || ""), e.name),
                req.client,
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
          a.name.localeCompare(b.name),
      );
    res.json({
      items,
      path: req.query.path || "",
      truncated: entries.length > 2000,
    });
  });
  app.get("/api/files/content", async (req, res) => {
    const file = resolve(req.query.root, req.query.path || "", req.client);
    const s = await fsp.stat(file);
    if (!s.isFile()) throw fail(400, "Choose a file.");
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Disposition, Content-Length",
    );
    res.download(file, path.basename(file));
  });
  app.get("/api/files/text", async (req, res) => {
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
      fs.copyFileSync(req.file.path, target, fs.constants.COPYFILE_EXCL);
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
    res.json(await desktopTerminals.list(authorizeDesktopTerminal(req))),
  );
  app.post("/api/terminals/desktop", async (req, res) => {
    const result = await desktopTerminals.create(
      req.body.provider,
      authorizeDesktopTerminal(req),
    );
    record("terminal", "Opened a Mac terminal");
    res.json(result);
  });
  app.get("/api/terminals/desktop/:id", async (req, res) =>
    res.json(
      await desktopTerminals.action(
        req.params.id,
        "read",
        null,
        authorizeDesktopTerminal(req),
      ),
    ),
  );
  app.post("/api/terminals/desktop/:id/:action", async (req, res) => {
    if (!["send", "focus", "close"].includes(req.params.action))
      throw fail(400, "Unknown terminal action.");
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
  app.post("/api/terminals", (req, res) => {
    const cwd = resolve(req.body.root, req.body.path || "", req.client);
    if (!fs.statSync(cwd).isDirectory()) throw fail(400, "Choose a folder.");
    const terminal = terminals.create({
      cwd,
      name: req.body.name,
      clientId: req.client.id,
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
    const result = await appShortcuts.run(req.body.id, () =>
      shortcutOwner(req, res),
    );
    record("app", result.name);
    res.json(result);
  });
  app.get("/api/apps", async (req, res) => res.json(await apps()));
  app.post("/api/apps/launch", async (req, res) => {
    const result = await launchApp(req.body.id);
    record("app", `Opened ${result.name}`);
    res.json(result);
  });
  const desktopOwner = (req) => {
    req.reauthorize();
    if (!config.screen || !req.client.scopes.includes("admin"))
      throw fail(403, "Enable screen viewing as an owner first.");
  };
  app.get("/api/screen/prepare", async (req, res) => {
    desktopOwner(req);
    res.json(await desktopPreparation(config));
  });
  app.post("/api/screen/desktop", async (req, res) => {
    desktopOwner(req);
    const token = req.headers.authorization?.replace(/^Bearer /, "");
    const authorize = () => {
      const client = verify(req, token);
      if (
        !transportAvailable ||
        !config.screen ||
        !client?.scopes.includes("screen") ||
        !client.scopes.includes("admin")
      )
        throw fail(403, "Desktop access was revoked or disconnected.");
      return client;
    };
    const session = await desktopSessions.open(req.client, req.body, authorize);
    desktopIdentityCleanup.set(
      req.client.id,
      trackIdentity(req, () => desktopSessions.revoke(req.client.id)),
    );
    res.json(session);
  });
  app.delete("/api/screen/desktop/:id", (req, res) => {
    desktopOwner(req);
    desktopSessions.get(req.params.id, req.client);
    desktopSessions.end(req.params.id);
    res.json({ ok: true });
  });
  app.get("/api/screen/desktop/:id/quality", async (req, res) => {
    desktopOwner(req);
    desktopSessions.get(req.params.id, req.client);
    const route = await connectionRoute(req);
    req.reauthorize();
    res.json({ route });
  });
  app.post("/api/screen/desktop/clipboard", async (req, res) => {
    desktopOwner(req);
    const session = desktopSessions.get(req.body.session, req.client);
    screenControl.check(req.client);
    if (!session.options.clipboard)
      throw fail(403, "Clipboard sync is off for this session.");
    const socket = inputConnections.get(req.client.id);
    if (!socket?.clipboard || !session.sockets.has(socket))
      throw fail(409, "Connect desktop controls first.");
    let action;
    if (req.body.operation === "read") {
      if (
        req.body.revision !== undefined &&
        !Number.isSafeInteger(req.body.revision)
      )
        throw fail(400, "Invalid clipboard revision.");
      action = { type: "clipboard-get", revision: req.body.revision };
    } else if (req.body.operation === "write") {
      if (
        typeof req.body.text === "string" &&
        Buffer.byteLength(req.body.text) <= 16384 &&
        !req.body.text.includes("\0")
      )
        action = { type: "clipboard-set", text: req.body.text };
      else if (
        typeof req.body.data === "string" &&
        req.body.data.length <= 2796204 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(req.body.data) &&
        Buffer.from(req.body.data, "base64")
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        action = { type: "clipboard-set", data: req.body.data };
      else throw fail(400, "Clipboard must be text or PNG under 2 MiB.");
    } else throw fail(400, "Invalid clipboard operation.");
    if (Date.now() - (session.clipboardAt || 0) < 250)
      throw fail(429, "Wait for the previous clipboard sync.");
    session.clipboardAt = Date.now();
    const result = await socket.clipboard(action);
    req.reauthorize();
    screenControl.check(req.client);
    res.json(result);
  });
  app.get("/api/screen/displays", async (req, res) => {
    if (!config.screen) throw fail(403, "Turn on screen viewing first.");
    const displays = await (overrides.desktopDisplays || desktopDisplays)(
      config,
    );
    res.json({
      displays,
      video: process.platform === "darwin",
      input: req.client.scopes.includes("admin"),
    });
  });
  app.post("/api/screen/control", (req, res) => {
    if (!config.screen && req.body.enabled)
      throw fail(403, "Turn on screen viewing first.");
    const lease = screenControl.acquire(req.client, req.body.enabled);
    if (!req.body.enabled) closeInput(req.client.id);
    res.json(lease);
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
  app.post("/api/chats/:id/approvals/:requestId", (req, res) => {
    if (!req.client.scopes.includes("admin"))
      throw fail(403, "Only a paired person can answer Codex approvals.");
    codex.respond(req.params.id, req.params.requestId, req.body);
    res.json({ ok: true });
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "This action does not exist." }),
  );
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  app.use(express.static(dist, { index: "index.html" }));
  app.use((req, res) => res.sendFile(path.join(dist, "index.html")));
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
  const upgrade = (req, socket, head) => {
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
        sessions: desktopSessions,
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
          if (Date.now() >= client.expiresAt) ws.close(4001, "Access expired");
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
        if (!client.scopes.includes("screen") || !config.screen) {
          reject("Screen access was turned off, expired or revoked.");
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
            if (!client.scopes.includes("screen"))
              throw fail(403, "Screen access is not granted.");
            if (!config.screen)
              throw fail(403, "Turn on screen viewing first.");
            credential = message.token;
            ws.clientId = client.id;
            expires(client);
            clearTimeout(deadline);
            modern = message.protocol === 2;
            if (message.desktopSession) {
              const session = desktopSessions.attach(
                message.desktopSession,
                client,
                ws,
              );
              message.display = session.display;
              message.quality = "desktop";
              message.width = session.options.width;
              message.format = "h264";
            }
            if (modern) {
              void (async () =>
                remoteScreens.add(
                  ws,
                  authorized,
                  message,
                  message.desktopSession
                    ? await connectionRoute(req)
                    : "Unknown",
                ))().catch((e) => reject(e.message, e.status || 503));
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
            if (message.type !== "ack")
              throw fail(400, "Unsupported screen message.");
            if (modern)
              remoteScreens.ack(ws, message.id, message.keyframe === true);
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
  return {
    app,
    server,
    config,
    auth,
    terminals,
    codex,
    jobs,
    instance,
    async listenPrivate(socketPath) {
      if (!config.tailscaleOwner)
        throw Error("Configure Tailscale identity first.");
      privateServer = await listenPrivateIngress({
        socketPath,
        app,
        upgrade,
        resolveIdentity,
      });
    },
    setTransportAvailable(value) {
      if (transportAvailable === value) return;
      transportAvailable = value;
      if (!value) {
        desktopSessions.revoke();
        screenControl.clear();
        closeInput();
        // Disconnect access without killing terminals, chats or jobs.
        for (const ws of wss.clients) ws.terminate();
      }
    },
    async close() {
      clearInterval(approvalCleanup);
      desktopSessions.close();
      screenStreams.stop("Reach is shutting down.");
      remoteScreens.stop("Reach is shutting down.", true);
      closeInput();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      terminals.dispose();
      codex.dispose();
      jobs.dispose();
      await Promise.all([
        new Promise((r) => server.close(r)),
        privateServer ? new Promise((r) => privateServer.close(r)) : undefined,
      ]);
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
