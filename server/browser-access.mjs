import { validateBrowserScript } from "./browser-scripts.mjs";
import { validateBrowserRoot } from "./browser-private-paths.mjs";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fail, hasReviewControls, isPlainRecord, validateBrowserInvitation } from "./core.mjs";
import { fileRootName } from "./file-roots.mjs";
import { validBrowserTerminalId } from "./agent-policy.mjs";
import { validateBrowserRequest, browserRequestActions } from "./browser-approvals.mjs";
import { parseTerminalCommand, terminalLocation } from "./restricted-terminal.mjs";
import { parseBrowserMutation, validateBrowserMutation } from "./browser-mutations.mjs";
import { browserCommandRecords, saveBrowserCommandRecords } from "./browser-command-records.mjs";
import { hostGuardedPreset, presetAccess, presetAppsFromCatalog, presetRouteAllowed } from "./agent-presets.mjs";
import { protectedAppReason, terminalLikeApp } from "./agent-guard.mjs";

// An explicit route allowlist is part of the credential, independent of UI.
// New Reach APIs do not automatically become available to browser agents.
export function browserRouteAllowed(client, method, route) {
  if (!client?.policy?.browser) return false;
  // Preset invitations have their own complete allowlist (agent-presets.mjs).
  if (client.policy.preset !== undefined) return presetRouteAllowed(client, method, route);
  if (method === "DELETE" && route === "/device/access") return true;
  if (client.policy.screen === "apps" && client.scopes.includes("browser:read")) {
    if (["GET", "HEAD"].includes(method) && ["/browser/apps", "/browser/apps/windows", "/browser/apps/screen"].includes(route)) return true;
    if (method === "POST" && client.scopes.includes("browser:request") && route === "/browser/apps/requests") return true;
  }
  // Retired desktop routes must not bypass selected-app capture/input guards,
  // including for credentials issued before app access was introduced.
  if (["/browser/screen", "/browser/scroll"].includes(route)) return false;
  if (route === "/browser/requests" && ["GET", "HEAD", "POST"].includes(method))
    return client.scopes.includes("browser:request");
  if (method === "DELETE" && /^\/browser\/requests\/[^/]+$/.test(route))
    return client.scopes.includes("browser:request");
  if ((method === "POST" && route === "/browser/terminal") || (["GET", "HEAD"].includes(method) && route === "/browser/terminal/history"))
    return client.scopes.includes("browser:request") && client.policy.restrictedTerminal === true;
  if (!["GET", "HEAD"].includes(method)) return false;
  if (route === "/device") return true;
  if (
    route === "/browser" ||
    /^\/browser\/terminals\/[^/]+$/.test(route)
  )
    return client.scopes.includes("browser:read");
  return (
    client.scopes.includes("files:read") &&
    [
      "/browser/files/search",
      "/files",
      "/files/text",
      "/files/content",
      "/files/document-text",
      "/files/icons",
    ].includes(route)
  );
}

export function browserAccessRoutes(
  app,
  {
    auth,
    config,
    terminals,
    desktopTerminals,
    resolve,
    resolveAsync,
    browserFiles,
    screenAvailable,
    record,
    approvals,
    commandLog,
    snapshots,
    prepareFunnel,
    appAccess, appAccessAvailable = false, hostGuard,
    // Screen, input, app list and shell for preset invitations
    // (server/agent-desktop.mjs, server/agent-shell.mjs); null where this Mac
    // can't offer them.
    desktop = null, shell = null,
  },
) {
  const owner = (req) => {
    const client = req.reauthorize();
    if (client.kind !== "device" || !client.scopes.includes("admin"))
      throw fail(403, "Only the computer's owner can invite a browser agent.");
    return client;
  };
  const browser = (req) => {
    const client = req.reauthorize();
    if (!client.policy?.browser || !client.scopes.includes("browser:read"))
      throw fail(403, "This action needs a browser invitation.");
    return client;
  };
  const terminalOptions = async (authorize, selected) => {
    authorize();
    const options = terminals
      .list()
      .map((t) => ({ id: `reach:${t.id}`, name: t.name }));
    if (
      desktopTerminals.platform === "darwin" &&
      (!selected || selected.some((id) => id.startsWith("desktop:")))
    ) {
      const result = await desktopTerminals.list(authorize);
      // iTerm2 gives each pane a unique session ID. Apple Terminal identifies
      // tabs by tty, which can be reused after a tab closes; that must never
      // silently give a browser invitation access to a different terminal.
      options.push(
        ...result.sessions
          .filter((t) => t.provider === "iterm2")
          .map((t) => ({ id: `desktop:${t.id}`, name: t.name })),
      );
    }
    authorize();
    return selected ? options.filter((t) => selected.includes(t.id)) : options;
  };
  app.get("/api/agents/browser-options", async (req, res) => {
    owner(req);
    let apps = [], appAccessError;
    if (appAccessAvailable) {
      try { apps = (await appAccess.options(() => owner(req))).map(({id,name,protected:protectedApp,reason}) => ({id,name,protected:!!protectedApp,reason})); }
      catch (error) { appAccessError = error.status ? error.message : "Protected app sharing is unavailable. Check macOS permissions."; }
    }
    owner(req);
    // The app picker for the Apps preset and the hidden-apps list: every app
    // on this Mac, the always-protected ones marked, and the ones that run
    // commands (terminals, IDEs) flagged so the owner knows what they share.
    let presetApps = [], presetAppsError;
    if (desktop?.available?.()) {
      try {
        presetApps = (await desktop.catalog(() => owner(req))).map((app) => {
          const reason = protectedAppReason(app);
          return { id: app.id, name: app.name, bundleId: app.bundleId || "", running: app.running === true,
            protected: !!reason, ...(reason ? { reason } : {}), ...(terminalLikeApp(app) ? { runsCommands: true } : {}) };
        });
      } catch (error) { presetAppsError = error.status ? error.message : "The app list is unavailable right now."; }
    }
    owner(req);
    res.json({terminals:await terminalOptions(() => owner(req)),screenAvailable:screenAvailable(),appAccessAvailable:appAccessAvailable && !appAccessError,controlAvailable:false,apps,...(appAccessError ? {appAccessError}: {}),
      desktopAvailable: !!desktop?.available?.(), presetApps, ...(presetAppsError ? { presetAppsError } : {})});
  });
  // The link the agent opens, once the credential exists. Funnel links are
  // prepared after issuing; a failure takes the credential back.
  const issued = async (req, res, grant, input) => {
    let url;
    if (input.transport === "funnel") {
      try {
        if (!prepareFunnel) throw fail(503, "Temporary browser access is not available.");
        const origin = await prepareFunnel();
        owner(req);
        // The invite may have expired while Tailscale was starting.
        if (grant.joinBy <= Date.now()) throw fail(410, "This invitation has expired. Create a new one.");
        url = `${origin}/agent-browser#invite=${grant.invitation}`;
      } catch (error) {
        auth.revoke(grant.clientId);
        throw error;
      }
    }
    record("agent", `Invited ${input.name} through a browser`);
    res.status(201).json({ ...grant, ...(url ? { url, transport: "funnel" } : {}) });
  };
  // A preset invitation: folders checked the way the preset needs (Files
  // stays out of Home and system folders; Full control and Read only may see
  // any shared folder), apps matched to this Mac's catalog, and the host guard
  // reserved when the agent will touch the Mac.
  const createPresetInvitation = async (req, res, input) => {
    for (const folder of input.folders) {
      const chosen = resolve(folder.root, folder.path || "", { policy: { browser: true } });
      if (input.preset === "files") validateBrowserRoot(chosen);
    }
    if (["full", "apps", "readonly"].includes(input.preset) && !desktop?.available?.())
      throw fail(503, "Screen access for agents needs this Mac's Screen Recording and Accessibility permissions.");
    if (input.terminalIds.length) {
      const available = await terminalOptions(() => owner(req), input.terminalIds);
      if (input.terminalIds.some((id) => !available.some((t) => t.id === id)))
        throw fail(400, "A selected terminal is no longer available. Choose again.");
    }
    if (input.apps.length || input.hidden.length) {
      const catalog = await desktop.catalog(() => owner(req));
      input.apps = presetAppsFromCatalog(catalog, input.apps);
      input.hidden = presetAppsFromCatalog(catalog, input.hidden, { allowProtected: true });
    }
    owner(req);
    let reservation;
    if (hostGuardedPreset({ browser: true, preset: input.preset })) {
      if (!hostGuard) throw fail(503, "Taking the Mac is unavailable on this computer.");
      reservation = await hostGuard.beginInvitation(req, req.reauthorize());
    }
    let grant;
    try {
      owner(req);
      grant = auth.inviteBrowser(input, reservation?.approver);
    } finally { reservation?.(); }
    await issued(req, res, grant, input);
  };
  app.post("/api/agents/browser-invitations", async (req, res) => {
    owner(req);
    const input = validateBrowserInvitation(req.body);
    if (input.preset) return createPresetInvitation(req, res, input);
    if (Array.isArray(input.folders)) {
      for (const folder of input.folders) validateBrowserRoot(resolve(folder.root, folder.path || "", { policy: { browser: true } }));
    }
    if (input.screen && !["off", "apps"].includes(input.screen))
      throw fail(400, "Desktop sharing for agents has been retired. Choose Selected apps or turn screen access off.");
    if (input.screen && input.screen !== "off" && !screenAvailable())
      throw fail(403, "Turn on screen viewing in Reach before sharing it.");
    if (
      !Array.isArray(input.terminalIds ?? []) ||
      (input.terminalIds?.length || 0) > 20 ||
      input.terminalIds?.some((id) => !validBrowserTerminalId(id))
    )
      throw fail(400, "Choose up to 20 terminals.");
    // Validate the selection before issuing any credential. An arbitrary ID
    // must not turn into permission to a terminal that appears later.
    if (input.terminalIds?.length) {
      const available = await terminalOptions(
        () => owner(req),
        input.terminalIds,
      );
      if (input.terminalIds.some((id) => !available.some((t) => t.id === id)))
        throw fail(
          400,
          "A selected terminal is no longer available. Choose again.",
        );
    }
    owner(req);
    let reservation;
    if (input.screen === "apps") {
      if (!appAccessAvailable || !appAccess || !hostGuard) throw fail(503, "App sharing is unavailable on this computer.");
      reservation = await hostGuard.beginInvitation(req, req.reauthorize());
    }
    let grant;
    try {
      if (input.screen === "apps") input.appAccess = await appAccess.validateChoices(input.appAccess, () => owner(req));
      owner(req);
      grant = auth.inviteBrowser(input, reservation?.approver);
    } catch (error) {
      if (grant) auth.revoke(grant.clientId);
      throw error;
    } finally { reservation?.(); }
    await issued(req, res, grant, input);
  });
  app.get("/api/browser", async (req, res) => {
    const client = browser(req);
    const selected = await terminalOptions(
      () => browser(req),
      client.policy.terminalIds || [],
    );
    if (client.policy.preset !== undefined) {
      return res.json({
        name: config.name,
        expiresAt: client.expiresAt,
        roots: client.agentRoots.map((p, index) => ({ index, name: fileRootName(p), path: p })),
        terminals: selected,
        ...presetAccess(client),
      });
    }
    res.json({
      name: config.name,
      expiresAt: client.expiresAt,
      roots: client.agentRoots.map((p, index) => ({
        index,
        name: fileRootName(p),
        path: p,
      })),
      terminals: selected,
      screen: client.policy.screen === "apps" ? "apps" : "off",
      ...(!["off", "apps"].includes(client.policy.screen) ? {
        screenNotice: "Desktop sharing for agents has been retired. Ask the owner for a new invitation using Selected apps.",
      } : {}),
      commandRequests: client.policy.commandRequests === true,
      ...(client.policy.restrictedTerminal ? { restrictedTerminal: true } : {}),
      ...(client.policy.terminalApproval ? { terminalApproval: true } : {}),
      ...(client.policy.scriptApproval ? { scriptApproval: true } : {}),
    });
  });
  app.get("/api/agents/browser-app-access/:clientId", async (req, res) => {
    owner(req);res.json(await appAccess.ownerAccess(req.params.clientId, () => owner(req)));
  });
  app.post("/api/agents/browser-app-access/:clientId", async (req, res) => {
    owner(req);res.json(await appAccess.restrict(req.params.clientId, req.body, () => owner(req)));
  });
  const appClient = (req) => {
    const client = browser(req);
    if (!appAccessAvailable || !appAccess || client.policy.screen !== "apps" || !screenAvailable()) throw fail(403, "This invitation does not share apps.");
    return client;
  };
  app.get("/api/browser/apps", async (req, res) => res.json(await appAccess.list(appClient(req), () => appClient(req))));
  app.get("/api/browser/apps/windows", async (req, res) => {
    if (typeof req.query.appId !== "string" || Object.keys(req.query).some((key) => key !== "appId")) throw fail(400, "Choose one shared app.");
    res.json(await appAccess.windows(appClient(req), req.query.appId, () => appClient(req)));
  });
  app.get("/api/browser/apps/screen", async (req, res) => {
    if (typeof req.query.target !== "string" || Object.keys(req.query).some((key) => key !== "target")) throw fail(400, "Choose one shared window.");
    res.type("image/jpeg").send(await appAccess.capture(appClient(req), req.query.target, () => appClient(req)));
  });
  app.post("/api/browser/apps/input", async (req, res) => {
    const body = req.body;
    if (!isPlainRecord(body) || typeof body.target !== "string" || Object.keys(body).some((key) => !["target", "action"].includes(key))) throw fail(400, "Send an action to one shared window.");
    res.json(await appAccess.input(appClient(req), body.target, body.action, () => appClient(req)));
  });
  app.post("/api/browser/apps/requests", async (req, res) => res.status(201).json(await appAccess.request(appClient(req), req.body, () => appClient(req))));
  const saveCommand = async (item) => {
    if (!browserCommandRecords(item).length) return;
    if (!commandLog) throw fail(503, "Command logging is unavailable. Nothing can run.");
    await saveBrowserCommandRecords(commandLog, item);
  };
  app.post("/api/browser/terminal", async (req, res) => {
    const client = browser(req);
    if (!client.policy.restrictedTerminal || !client.scopes.includes("browser:request"))
      throw fail(403, "Terminal commands are not shared with this session.");
    if (!commandLog) throw fail(503, "Command logging is unavailable. Nothing can run.");
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some((k) => !["command", "root", "cwd"].includes(k)))
      throw fail(400, "Submit one command and its working folder.");
    if (typeof body.command !== "string" || !body.command.trim() || body.command.length > 4000 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(body.command))
      throw fail(400, "Enter a command without hidden controls, up to 4,000 characters.");
    if (!Number.isSafeInteger(body.root) || body.root < 0 || !client.agentRoots?.[body.root])
      throw fail(403, "Choose one of this session's shared folders.");
    let folder = client.agentRoots[body.root];
    const failedAttempt = async (error, type = "terminal-change") => {
      const item = { id: crypto.randomUUID(), clientId: client.id, name: client.name,
        action: { type, command: body.command, root: body.root, ...(typeof body.cwd === "string" ? { cwd: body.cwd.slice(0, 4096) } : {}) },
        reason: "Run the command entered in the shared terminal.", status: "failed", createdAt: Date.now(), expiresAt: client.expiresAt, folder,
        error: error?.status && error.status < 500 ? String(error.message).slice(0, 300) : "The command could not be prepared. Check its paths and shared folder." };
      await saveCommand(item);
      return res.json(item);
    };
    try {
      const location = terminalLocation({ ...body, command: "pwd" });
      folder = resolve(body.root, location.cwd, client);
      if (!(await fs.stat(folder)).isDirectory()) throw fail(400, "Choose a working folder.");
    } catch (error) { return failedAttempt(error); }
    let safe = false;
    try { parseTerminalCommand(body.command); safe = true; } catch { /* Every other command must stop for approval. */ }
    let supportedChange = false;
    if (!safe) { try { parseBrowserMutation(body.command); supportedChange = true; } catch { /* Unknown commands never become a shell. */ } }
    const input = { ...body, type: safe ? "terminal" : supportedChange ? "terminal-change" : "terminal-script", reason: "Run the command entered in the shared terminal." };
    if (!safe && (supportedChange ? client.policy.terminalApproval !== true : client.policy.scriptApproval !== true)) {
      const blocked = { id: crypto.randomUUID(), clientId: client.id, name: client.name, action: { type: "terminal-change", command: body.command, root: body.root, ...(body.cwd !== undefined ? { cwd: body.cwd } : {}) }, reason: input.reason,
        status: "blocked", createdAt: Date.now(), expiresAt: client.expiresAt, folder,
        error: !supportedChange ? "This invitation does not allow script requests. The owner can enable Commands with approval in Edit access." : "This invite allows read-only commands. File changes need a new invite with File changes with approval enabled." };
      await saveCommand(blocked);
      return res.status(200).json(blocked);
    }
    if (safe) {
      let item;
      try { item = await approvals.runReadOnly(browser(req), input, () => browser(req)); }
      catch (error) { return failedAttempt(error, "terminal"); }
      await approvals.flushChanges();
      await saveCommand(item);
      return res.json(item);
    }
    try { if (input.type === "terminal-script") validateBrowserScript(input, () => browser(req), { resolve, config }); else validateBrowserMutation(input, () => browser(req), { resolve }); }
    catch (error) { return failedAttempt(error, input.type); }
    const remembered = await approvals.runRemembered(browser(req), input, () => browser(req));
    if (remembered) { await saveCommand(remembered); return res.json(remembered); }
    const item = approvals.request(browser(req), input);
    try { await approvals.flushChanges(); await saveCommand(item); }
    catch (error) { approvals.cancel(browser(req), item.id); throw error; }
    res.status(202).json(item);
  });
  app.get("/api/browser/terminal/history", async (req, res) => {
    const client = browser(req);
    if (!client.policy.restrictedTerminal || !commandLog) throw fail(403, "Terminal history is not shared.");
    // Update durable outcomes for expiry, cancellation, or revocation before listing.
    for (const item of approvals.listClient(client)) if (!["pending", "executing"].includes(item.status)) await saveCommand(item);
    await approvals.flushChanges();
    const history = await commandLog.history({ clientId: client.id, limit: 100 });
    browser(req);
    res.json(history);
  });
  app.get("/api/agents/browser-terminal-history", async (req, res) => {
    owner(req);
    approvals.listOwner(); // Sweep expired requests before showing their durable outcome.
    await approvals.flushChanges();
    const history = commandLog ? await commandLog.history({ limit: 100 }) : [];
    owner(req);
    res.json(history);
  });
  // The assistant proposes; only a separate owner credential may decide.
  // Only scoped terminal/manual requests use this queue. App capture and input
  // stay behind the separate selected-app enforcement path.
  app.post("/api/browser/requests", async (req, res) => {
    const client = browser(req);
    const input = req.body || {};
    const { action } = validateBrowserRequest(client, input);
    const actions = browserRequestActions(action);
    for (const step of actions.filter((step) => ["terminal", "terminal-change", "terminal-script"].includes(step.type))) {
      if (step.type === "terminal-script") validateBrowserScript(step, () => browser(req), { resolve, config });
      if (step.type === "terminal-change") validateBrowserMutation(step, () => browser(req), { resolve });
      // Validate the folder before prompting the owner. Execution rechecks it.
      const location = terminalLocation(["terminal-change", "terminal-script"].includes(step.type) ? { ...step, command: "pwd" } : step);
      const cwd = resolve(step.root, location.cwd, browser(req));
      if (!(await fs.stat(cwd)).isDirectory()) throw fail(400, "Choose a working folder.");
      const target = resolve(step.root, location.relative, browser(req));
      if (location.spec.name === "cd" && !(await fs.stat(target)).isDirectory())
        throw fail(400, "Choose a folder, not a file.");
    }
    if (actions.some((step) => !["command", "terminal", "terminal-change", "terminal-script"].includes(step.type)))
      throw fail(403, "Desktop control for agents has been retired. Ask the owner for a new invitation using Selected apps.");
    if (["terminal-change", "terminal-script"].includes(action.type)) {
      const remembered = await approvals.runRemembered(browser(req), input, () => browser(req));
      if (remembered) { await saveCommand(remembered); return res.json(remembered); }
    }
    const request = approvals.request(browser(req), input);
    await approvals.flushChanges();
    if (browserCommandRecords(request).length) {
      try { await saveCommand(request); } catch (error) { approvals.cancel(browser(req), request.id); throw error; }
    }
    res.status(201).json(request);
  });
  app.get("/api/browser/requests", (req, res) => {
    const client = browser(req);
    res.json([...approvals.listClient(client), ...(client.policy.screen === "apps" ? appAccess.listClient(client) : [])]);
  });
  app.delete("/api/browser/requests/:id", async (req, res) => {
    if (appAccess?.has(req.params.id)) return res.json(appAccess.cancel(browser(req), req.params.id));
    const result = approvals.cancel(browser(req), req.params.id);
    snapshots.delete(req.params.id);
    await approvals.flushChanges();
    await saveCommand(result);
    res.json(result);
  });
  app.get("/api/agents/browser-requests", (req, res) => {
    owner(req);
    res.json([...approvals.listOwner(), ...(appAccess?.listOwner() || [])]);
  });
  app.get("/api/agents/browser-requests/:id/screen", (req, res) => {
    owner(req);
    const request = approvals.getOwner(req.params.id);
    const image = snapshots.get(request.id);
    if (!["pending", "executing"].includes(request.status) || !image)
      throw fail(404, "That screen request has ended.");
    res.type("image/jpeg").send(image.frame);
  });
  app.post("/api/agents/browser-requests/:id", async (req, res) => {
    owner(req);
    const body = req.body || {};
    if (!isPlainRecord(body))
      throw fail(400, "Approve the exact action shown, without replacements.");
    if (Object.keys(body).some((key) => !["decision", "reviewedBatch", "reviewedTerminalChange", "reviewedScript"].includes(key)))
      throw fail(400, "Approve the exact action shown, without replacements.");
    if (appAccess?.has(req.params.id)) {
      if (Object.keys(body).some((key) => key !== "decision")) throw fail(400, "Allow the exact app access shown or deny it.");
      return res.json(await appAccess.decide(req.params.id, body.decision, () => owner(req)));
    }
    const reviewed = approvals.getOwner(req.params.id);
    const approving = ["approve", "approve-session"].includes(body.decision);
    if (body.decision === "approve-session" && !["terminal-change", "terminal-script"].includes(reviewed.action.type)) throw fail(400, "Only an exact terminal command can be approved for this session.");
    if (Object.hasOwn(body, "reviewedScript") && !(reviewed.action.type === "terminal-script" && approving)) throw fail(400, "Review this request in the current Reach app.");
    if (reviewed.action.type === "terminal-script" && approving) {
      if (body.reviewedScript !== true || Object.hasOwn(body, "reviewedBatch") || Object.hasOwn(body, "reviewedTerminalChange")) throw fail(400, "Review this exact script and folder before approving once.");
    } else if (reviewed.action.type === "batch" && approving) {
      // Older owner pages only know how to display one action. They must
      // refresh before approving a sequence they cannot render in full.
      if (body.reviewedBatch !== true || Object.hasOwn(body, "reviewedTerminalChange"))
        throw fail(400, "Refresh Reach and review every action before approving this batch.");
    } else if (reviewed.action.type === "terminal-change" && approving) {
      if (body.reviewedTerminalChange !== true || Object.hasOwn(body, "reviewedBatch")) throw fail(400, "Review this exact command in the current Reach app before running it.");
    } else if (Object.hasOwn(body, "reviewedBatch") || Object.hasOwn(body, "reviewedTerminalChange")) {
      throw fail(400, "Review this request in the current Reach app.");
    }
    const result = await approvals.decide(req.client, req.params.id, req.body?.decision, () => {
      owner(req);
      return req.client;
    });
    snapshots.delete(req.params.id);
    await approvals.flushChanges();
    await saveCommand(result);
    res.json(result);
  });
  app.get("/api/browser/terminals/:id", async (req, res) => {
    const authorize = () => {
      if (!(browser(req).policy.terminalIds || []).includes(req.params.id))
        throw fail(403, "This terminal was not shared with this invitation.");
    };
    authorize();
    const selected = await terminalOptions(authorize, [req.params.id]);
    const meta = selected.find((t) => t.id === req.params.id);
    if (!meta) throw fail(404, "This terminal is no longer available.");
    const id = req.params.id.slice(req.params.id.indexOf(":") + 1);
    const output = req.params.id.startsWith("reach:")
      ? terminals.get(id).buffer
      : (await desktopTerminals.action(id, "read", null, authorize)).text;
    authorize();
    record("agent", `${req.client.name} read shared terminal output`);
    res.json({
      ...meta,
      output: stripVTControlCharacters(String(output || "").slice(-256000)),
    });
  });
  const searching = new Set();
  app.get("/api/browser/files/search", async (req, res) => {
    const client = browser(req);
    const query = req.query.q;
    if (typeof query !== "string" || !query.trim() || query.length > 160)
      throw fail(400, "Enter a file name, up to 160 characters.");
    if (searching.has(client.id) || searching.size >= 8)
      throw fail(429, "A file search is already running. Try again shortly.");
    const root = req.query.root ?? 0;
    resolve(root, "", client);
    searching.add(client.id);
    try {
      const needle = query.trim().toLocaleLowerCase();
      const pending = [""];
      const items = [];
      const deadline = Date.now() + 2000;
      let seen = 0,
        truncated = false;
      search: while (pending.length) {
        const relative = pending.pop();
        const current = browser(req);
        let entries;
        try {
          if (!browserFiles) throw fail(503, "Protected file access is unavailable.");
          entries = await browserFiles("list", root, relative, () => browser(req), { maxEntries: 2000 });
        } catch (error) {
          if (error.status === 401 || error.status === 503 || !relative) throw error;
          continue;
        }
        truncated ||= entries.truncated;
        for (const entry of entries.items) {
          if (++seen > 5000 || Date.now() > deadline || items.length >= 100) {
            truncated = true;
            break search;
          }
          if (entry.name.startsWith(".")) continue;
          if (entry.type === "directory") pending.push(entry.path);
          if (entry.name.toLocaleLowerCase().includes(needle)) {
            items.push({ name: entry.name, path: entry.path, type: entry.type });
          }
        }
      }
      browser(req);
      record("agent", `${req.client.name} searched shared files`);
      res.json({ items, truncated });
    } finally {
      searching.delete(client.id);
    }
  });
  const retiredScreen = (req) => {
    browser(req);
    throw fail(403, "Desktop sharing for agents has been retired. Ask the owner for a new invitation using Selected apps.");
  };
  app.get("/api/browser/screen", retiredScreen);
  app.post("/api/browser/scroll", retiredScreen);

  // Preset agents: the Mac itself. Each call re-reads the live invitation; the
  // native checker decides each event against its exact target.
  const presetClient = (req, scope) => {
    const client = browser(req);
    if (client.policy.preset === undefined || !client.scopes.includes(scope)) throw fail(403, "This invitation does not include that.");
    return client;
  };
  const needDesktop = () => { if (!desktop) throw fail(503, "Screen access for agents is unavailable on this computer."); };
  // Refusals carry their kind (busy, paused, retry, blocked) so an agent knows
  // whether to wait or to stop.
  const answer = async (res, work) => {
    try { res.json(await work()); }
    catch (error) {
      if (!error?.status || error.status >= 500 || !error.kind) throw error;
      res.status(error.status).json({ error: error.message, kind: error.kind, ...(error.holder ? { holder: error.holder } : {}), ...(error.retryInMs ? { retryInMs: error.retryInMs } : {}) });
    }
  };
  app.get("/api/browser/desktop/screen", async (req, res) => {
    const client = presetClient(req, "browser:screen");
    needDesktop();
    if (Object.keys(req.query).some((key) => key !== "maxWidth")) throw fail(400, "Choose only the image width.");
    const shot = await desktop.screenshot(client, () => presetClient(req, "browser:screen"), { maxWidth: Number(req.query.maxWidth) || 1440 });
    res.set("Cache-Control", "no-store");
    res.set("X-Reach-Screen", JSON.stringify({ width: shot.width, height: shot.height, hidden: shot.hidden }));
    res.type("image/jpeg").send(shot.jpeg);
  });
  app.get("/api/browser/desktop/front", async (req, res) => {
    const client = presetClient(req, "browser:screen");
    needDesktop();
    res.json(await desktop.front(client, () => presetClient(req, "browser:screen")));
  });
  app.post("/api/browser/desktop/input", async (req, res) => {
    const client = presetClient(req, "browser:control");
    needDesktop();
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some((key) => key !== "action")) throw fail(400, "Send one action.");
    await answer(res, () => desktop.act(client, body.action, () => presetClient(req, "browser:control")));
  });
  app.get("/api/browser/desktop/apps", async (req, res) => {
    const client = presetClient(req, "browser:open");
    needDesktop();
    const catalog = await desktop.catalog(() => presetClient(req, "browser:open"));
    const latest = presetClient(req, "browser:open");
    const hidden = latest.policy.hidden || [];
    const apps = latest.policy.preset === "apps"
      ? latest.policy.apps.map((app) => ({ id: app.id, name: app.name, bundleId: app.bundleId, running: catalog.some((entry) => entry.id === app.id && entry.running) }))
      : catalog.filter((app) => !protectedAppReason(app) && !hidden.some((entry) => entry.id === app.id || (entry.bundleId && entry.bundleId === app.bundleId)))
        .map((app) => ({ id: app.id, name: app.name, bundleId: app.bundleId, running: app.running, ...(terminalLikeApp(app) ? { runsCommands: true } : {}) }));
    res.json({ apps });
  });
  app.post("/api/browser/desktop/open", async (req, res) => {
    const client = presetClient(req, "browser:open");
    needDesktop();
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some((key) => key !== "app")) throw fail(400, "Choose one app by its path.");
    await answer(res, () => desktop.open(client, body.app, () => presetClient(req, "browser:open")));
  });
  // The shell (Full control): one command, as the owner, checked against the
  // deny list and logged. Not confined: Full control is full control.
  app.post("/api/browser/shell", async (req, res) => {
    const client = presetClient(req, "browser:shell");
    if (!shell) throw fail(503, "Commands for agents are unavailable on this computer.");
    const item = await shell.run(client, req.body, { resolve, authorize: () => presetClient(req, "browser:shell") });
    record("agent", `${client.name} ${item.status === "blocked" ? "was refused a command" : "ran a command"}`);
    res.status(item.status === "blocked" ? 200 : 200).json(item);
  });
  app.get("/api/browser/shell/history", async (req, res) => {
    const client = presetClient(req, "browser:shell");
    if (!shell) throw fail(503, "Commands for agents are unavailable on this computer.");
    res.json(await shell.history(client));
  });
  // File changes: Files with editing goes through the sandboxed helper in its
  // chosen folders; Full control writes directly, inside what Reach shares and
  // never into private files.
  const MAX_CONTENT = 1048576;
  app.post("/api/browser/files/change", async (req, res) => {
    const client = presetClient(req, "browser:write");
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some((key) => !["op", "root", "path", "to", "content"].includes(key)) ||
        !["write", "mkdir", "rm", "cp"].includes(body.op) || !Number.isSafeInteger(body.root) || body.root < 0 ||
        typeof body.path !== "string" || !body.path || body.path.length > 4096 || hasReviewControls(body.path) ||
        (body.op === "cp") !== (typeof body.to === "string") || (body.to !== undefined && (!body.to || body.to.length > 4096 || hasReviewControls(body.to))) ||
        (body.op === "write") !== (typeof body.content === "string") || (body.content !== undefined && Buffer.byteLength(body.content) > MAX_CONTENT))
      throw fail(400, "Send one change: write (with content up to 1 MiB), mkdir, rm, or cp (with to), with a path inside a shared folder.");
    if (!client.agentRoots?.[body.root]) throw fail(403, "Choose one of this session's shared folders.");
    const relative = (value) => {
      if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..") || /[\u0000\\:]/.test(value)) throw fail(403, "Stay inside the shared folder.");
      return value;
    };
    relative(body.path); if (body.to !== undefined) relative(body.to);
    if (client.policy.preset === "files") {
      if (!browserFiles) throw fail(503, "Protected file access is unavailable.");
      const result = await browserFiles(body.op, body.root, body.path, () => presetClient(req, "browser:write"),
        { ...(body.to !== undefined ? { to: body.to } : {}), ...(body.op === "write" ? { data: Buffer.from(body.content, "utf8").toString("base64") } : {}) });
      record("agent", `${client.name} changed a file (${body.op})`);
      return res.json({ ok: true, ...(result?.stat ? { stat: result.stat } : {}) });
    }
    // Full control: direct, with the same no-symlink and size rules.
    const target = resolve(body.root, body.path, client, { allowMissing: true });
    const existing = await fs.lstat(target).catch(() => null);
    if (existing?.isSymbolicLink()) throw fail(403, "Links are not changed through Reach.");
    if (body.op === "mkdir") { if (existing) throw fail(409, "That name already exists."); await fs.mkdir(target, { mode: 0o755 }); }
    else if (body.op === "rm") {
      if (!existing?.isFile()) throw fail(404, "Choose an existing file to remove.");
      if (existing.size > MAX_CONTENT) throw fail(403, "Choose a file no larger than 1 MiB.");
      await fs.unlink(target);
    } else if (body.op === "write") {
      if (existing && !existing.isFile()) throw fail(409, "That path is not a file.");
      const handle = await fs.open(target, "w", 0o644);
      try { await handle.writeFile(body.content, "utf8"); } finally { await handle.close(); }
    } else {
      const destination = resolve(body.root, body.to, client, { allowMissing: true });
      if (!existing?.isFile()) throw fail(404, "Choose an existing file to copy.");
      if (existing.size > 25 * 1048576) throw fail(403, "Choose a file no larger than 25 MiB.");
      const there = await fs.lstat(destination).catch(() => null);
      if (there?.isSymbolicLink() || there?.isDirectory()) throw fail(409, "Choose a file name for the copy.");
      await fs.copyFile(target, destination);
    }
    record("agent", `${client.name} changed a file (${body.op})`);
    presetClient(req, "browser:write");
    res.json({ ok: true });
  });
}
