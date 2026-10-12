import { validateBrowserScript } from "./browser-scripts.mjs";
import { validateBrowserRoot } from "./browser-private-paths.mjs";
import { agentErrorDetails } from "./agent-transport.mjs";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fail, hasReviewControls, hostedConnector, isPlainRecord, validateBrowserInvitation } from "./core.mjs";
import { fileRootName } from "./file-roots.mjs";
import { validBrowserTerminalId } from "./agent-policy.mjs";
import { validateBrowserRequest, browserRequestActions } from "./browser-approvals.mjs";
import { parseTerminalCommand, terminalLocation } from "./restricted-terminal.mjs";
import { parseBrowserMutation, validateBrowserMutation } from "./browser-mutations.mjs";
import { browserCommandRecords, saveBrowserCommandRecords } from "./browser-command-records.mjs";
import { hostGuardedPreset, presetAccess, presetAppsFromCatalog, presetRouteAllowed } from "./agent-presets.mjs";
import { protectedAppReason, terminalLikeApp } from "./agent-guard.mjs";
import { browserToolRequest, savedToolName, SAVED_TOOLS_HINT, compactTools } from "./browser-tools.mjs";
import { toolsFor } from "../scripts/mcp-server.mjs";
import { fromBrowserPage, updateNotice } from "./agent-runtimes.mjs";
import { describeScreen, normalizeAction } from "./agent-desktop.mjs";
import { createObservations, observationOptions, waitOptions, waitForScreen } from "./desktop-observation.mjs";
import { actionWords } from "./agent-actions.mjs";
import { openConfined, readUpTo } from "./confined-file.mjs";

// An explicit route allowlist is part of the credential, independent of UI.
// New Reach APIs do not automatically become available to browser agents.
export function browserRouteAllowed(client, method, route) {
  if (!client?.policy?.browser) return false;
  // Preset invitations have their own complete allowlist (agent-presets.mjs).
  if (client.policy.preset !== undefined) return presetRouteAllowed(client, method, route);
  if (method === "DELETE" && route === "/device/access") return true;
  if (method === "POST" && route === "/device/rotate") return true;
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
  // Its tools as Reach lists them, and the request each call makes (below).
  if (method === "POST" && ["/browser/mcp/plan", "/browser/mcp/call"].includes(route)) return client.scopes.includes("browser:read");
  if (!["GET", "HEAD"].includes(method)) return false;
  if (route === "/device" || route === "/device/runtime") return true;
  if (["/browser/mcp/tools", "/browser/mcp/discover"].includes(route)) return client.scopes.includes("browser:read");
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
    protectedFilesSupported = process.platform === "darwin",
    screenAvailable,
    record,
    approvals,
    commandLog,
    snapshots,
    prepareFunnel,
    // Whether the internet can find the public name (server/public-dns.mjs).
    publicName = null,
    appAccess, appAccessAvailable = false, hostGuard,
    // Screen, input, app list and shell for preset invitations
    // (server/agent-desktop.mjs, server/agent-shell.mjs); null where this Mac
    // can't offer them.
    desktop = null, shell = null, shortcuts = null, tools = null, services = null,
    // The Mac's own Shortcuts the owner lets agents run (server/mac-shortcuts.mjs).
    macShortcuts = null,
    // The owner's log of what each agent did (server/agent-actions.mjs add).
    actions = () => {},
    // The SHA-256 of the agent runtime the start page serves, pinned in a
    // Tools agent's command (security audit M8).
    agentRuntime = () => undefined,
    // What the start page hands out right now: invitations pin it.
    servedRuntime = agentRuntime,
    // What runtime an agent says it runs (agent-runtimes.mjs).
    noteAgentRuntime = () => {},
    // Whether this computer makes invite keys: Always over Tools needs the
    // agent on its own invited device.
    toolsStandingAllowed = () => false,
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
  // A list that hangs (an app catalog or Terminal not answering) must not
  // hold the invite form: after a few seconds it counts as unavailable.
  const inTime = (promise, ms = 4000) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  app.get("/api/agents/browser-options", async (req, res) => {
    owner(req);
    let apps = [], appAccessError;
    if (appAccessAvailable) {
      try { apps = (await inTime(appAccess.options(() => owner(req)))).map(({id,name,protected:protectedApp,reason}) => ({id,name,protected:!!protectedApp,reason})); }
      catch (error) { appAccessError = error.status ? error.message : "Protected app sharing is unavailable. Check macOS permissions."; }
    }
    owner(req);
    // The app picker for the Apps preset and the hidden-apps list: every app
    // on this Mac, the always-protected ones marked, and the ones that run
    // commands (terminals, IDEs) flagged so the owner knows what they share.
    let presetApps = [], presetAppsError;
    if (desktop?.available?.()) {
      try {
        presetApps = (await inTime(desktop.catalog(() => owner(req)))).map((app) => {
          const reason = protectedAppReason(app);
          return { id: app.id, name: app.name, bundleId: app.bundleId || "", running: app.running === true,
            protected: !!reason, ...(reason ? { reason } : {}), ...(terminalLikeApp(app) ? { runsCommands: true } : {}) };
        });
      } catch (error) { presetAppsError = error.status ? error.message : "The app list is unavailable right now."; }
    }
    owner(req);
    const terminals = await inTime(terminalOptions(() => owner(req))).catch((error) => {
      if (error?.status) throw error;
      return [];
    });
    owner(req);
    res.json({terminals,screenAvailable:screenAvailable(),appAccessAvailable:appAccessAvailable && !appAccessError,controlAvailable:false,apps,...(appAccessError ? {appAccessError}: {}),
      desktopAvailable: !!desktop?.available?.(), protectedFilesSupported, presetApps, ...(presetAppsError ? { presetAppsError } : {}),
      // The longest a preset invitation may last over the public link; the
      // form offers a day only when the server allows it.
      maxFunnelSeconds: 86400,
      // Always: access until the owner ends it; the agent returns from the same browser.
      standingAllowed: true,
      // Always over Tools: only with invite keys (the agent's own device).
      toolsStandingAllowed: toolsStandingAllowed() === true});
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
        // A hosted agent gets the address of Reach's MCP endpoint; the
        // invitation itself stays here (hosted-mcp.mjs claims it).
        url = input.hosted ? `${origin}/mcp/${hostedConnector(grant.invitation)}` : `${origin}/agent-browser#invite=${grant.invitation}`;
      } catch (error) {
        auth.revoke(grant.clientId);
        throw error;
      }
    }
    // The link is issued either way; a name Tailscale hasn't published is
    // reported so the owner knows why the agent can't open it.
    const name = url && publicName ? await publicName(new URL(url).hostname).catch(() => "unknown") : null;
    record("agent", `Invited ${input.name} through a browser`);
    // Tools agents (over Tailscale or the public link) pin their runtime.
    const runtime = servedRuntime();
    const { invitation, ...issuedGrant } = grant;
    res.status(201).json({ ...(input.hosted ? issuedGrant : grant), ...(url ? { url, transport: "funnel" } : {}),
      // Its private address too, for a client on the owner's tailnet.
      ...(input.hosted ? { hosted: true, privateUrl: `${config.publicOrigin}/mcp/${hostedConnector(grant.invitation)}` } : {}),
      ...(name === "missing" ? { publicName: "missing" } : {}), ...(runtime && !input.hosted ? { runtime } : {}) });
  };
  // Validate the same effective roots used by file operations before issuing
  // access. Only Full/Read only may include the exact owner Home; their
  // defaults skip system/application roots instead of refusing.
  const createPresetInvitation = async (req, res, input) => {
    if (input.standing && input.transport !== "funnel" && toolsStandingAllowed() !== true)
      throw fail(409, "Always over Tools needs invite links set up on this computer, so the agent joins with its own key.");
    if (input.preset === "files" && !protectedFilesSupported)
      throw fail(503, "Browser-agent file access requires macOS. Your own files and terminals remain available.");
    const filePolicy = { browser: true, preset: input.preset };
    if (input.preset === "full") { input.folders = []; input.hidden = []; }
    const shareable = (folder) => {
      try { validateBrowserRoot(resolve(folder.root, folder.path || "", { policy: filePolicy }), { policy: filePolicy }); return true; }
      catch { return false; }
    };
    // Read only defaults to shared folders that pass root validation.
    if (!input.folders.length && input.preset === "readonly") {
      input.folders = config.roots.map((_, root) => ({ root, path: "" })).filter(shareable);
      if (!input.folders.length) validateBrowserRoot(config.roots[0] ?? "", { policy: filePolicy });
    }
    for (const folder of input.folders) {
      const chosen = resolve(folder.root, folder.path || "", { policy: filePolicy });
      validateBrowserRoot(chosen, { policy: filePolicy });
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
  // "New invite link" for someone who hasn't opened theirs (Agents & people):
  // a computer never keeps a link, so the owner's phone can't show it again
  // once its page closes. A fresh one replaces it (auth.renewInvitation), and
  // comes back in the form it was first made: a person's /guest link, a
  // browser agent's public link, or the secret a command or key goes with.
  app.post("/api/guests/:id/link", async (req, res) => {
    owner(req);
    const client = auth.list().find((c) => c.id === req.params.id);
    if (!client || !["guest", "agent"].includes(client.kind)) throw fail(404, "That invitation has ended.");
    // A hosted agent's address has no secret in it: the same one, again.
    let origin;
    if (client.browserTransport === "funnel") {
      if (!prepareFunnel) throw fail(503, "Temporary browser access is not available.");
      origin = await prepareFunnel();
      owner(req);
    }
    if (client.hosted)
      return res.json({ clientId: client.id, url: `${origin}/mcp`, hosted: true, expiresAt: client.expiresAt });
    const grant = auth.renewInvitation(client.id);
    record(client.kind === "guest" ? "guest" : "agent", `New invite link for ${client.name}`);
    const url =
      client.kind === "guest"
        ? `${config.publicOrigin || `http://${req.headers.host}`}/guest#invite=${grant.invitation}`
        : origin && client.policy?.browser
          ? `${origin}/agent-browser#invite=${grant.invitation}`
          : undefined;
    const name = origin && publicName ? await publicName(new URL(url || origin).hostname).catch(() => "unknown") : null;
    const runtime = client.kind === "agent" ? agentRuntime() : undefined;
    res.json({
      ...grant,
      ...(url ? { url } : {}),
      ...(origin ? { transport: "funnel" } : {}),
      ...(name === "missing" ? { publicName: "missing" } : {}),
      ...(runtime ? { runtime } : {}),
    });
  });
  // What a browser agent may use: /api/browser shows it, and the tools an
  // agent offers derive from it (scripts/mcp-server.mjs toolsFor), on the
  // agent's side or here (/api/browser/mcp below).
  const browserView = async (req, client) => {
    const selected = await terminalOptions(
      () => browser(req),
      client.policy.terminalIds || [],
    );
    // The runtime this computer serves agents (dist/agent.mjs): one on an
    // older copy fetches it (/api/device/runtime) and offers the new tools.
    const runtime = client.kind === "agent" ? agentRuntime() : undefined;
    if (client.policy.preset !== undefined) {
      return {
        name: config.name,
        expiresAt: client.expiresAt,
        ...(runtime ? { runtime } : {}),
        roots: client.agentRoots.map((p, index) => ({ index, name: fileRootName(p), path: p })),
        terminals: selected,
        ...presetAccess(client),
        ...(services ? { services: services.catalog(() => browser(req)) } : {}),
        ...(tools && ["full", "apps"].includes(client.policy.preset) ? { browserTools: await tools.catalog(() => browser(req)) } : {}),
        ...(shortcuts && ["full", "apps"].includes(client.policy.preset) ? {
          savedToolHint: SAVED_TOOLS_HINT,
          savedTools: shortcuts.list(() => browser(req)).shortcuts.map(item => ({ ...item, tool: savedToolName(item) })),
        } : {}),
      };
    }
    return {
      name: config.name,
      expiresAt: client.expiresAt,
      ...(runtime ? { runtime } : {}),
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
    };
  };
  // The runtime an agent says it runs (agent-runtimes.mjs). A program that
  // names none is a copy too old to update itself: told how, once replaced
  // it keeps up by itself.
  const publicHost = () => {
    try { return new URL(config.publicOrigin).hostname; } catch { return ""; }
  };
  const runtimeSaid = (req, client) => {
    noteAgentRuntime(client, req.query.runtime, { program: !fromBrowserPage(req) });
    return updateNotice({ client, req, served: servedRuntime(), host: publicHost() });
  };
  app.get("/api/browser", async (req, res) => {
    const client = browser(req);
    const notice = runtimeSaid(req, client);
    res.json({ ...(await browserView(req, client)), ...notice });
  });
  // Reach's own tools for this agent: the list it offers and, per call, the
  // request to make, from this computer's code, so an agent's copy offers
  // the tools Reach has now whatever its own version (scripts/mcp-server.mjs).
  // `list` names the list's version: a call that sees another one tells the
  // client to read the list again.
  const mcpTools = async (req, client) => {
    const view = await browserView(req, client);
    const offered = toolsFor(client.scopes, view);
    return { view, offered, list: crypto.createHash("sha256").update(JSON.stringify(offered)).digest("hex").slice(0, 16) };
  };
  app.get("/api/browser/mcp/tools", async (req, res) => {
    const client = browser(req);
    runtimeSaid(req, client);
    const { view, offered, list } = await mcpTools(req, client);
    res.json({ tools: req.query.profile === "compact" ? compactTools(offered) : offered, list, dispatch: true, ...(view.runtime ? { runtime: view.runtime } : {}) });
  });
  app.get("/api/browser/mcp/discover", async (req, res) => {
    const client = browser(req);
    if (Object.keys(req.query).some(key => !["query", "name"].includes(key)) || Object.values(req.query).some(value => typeof value !== "string" || value.length > 160)) throw fail(400, "Search by query or an exact tool name.");
    const { offered } = await mcpTools(req, client);
    // Match task words across the name, title and description: "read file"
    // must find reach_read_file even when its title is "Read a file". Rank
    // names ahead of incidental mentions in another tool's instructions.
    const normalize = value => value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    const query = normalize(req.query.query || ""), words = query.split(" ").filter(Boolean);
    const matches = req.query.name ? offered.filter(tool => tool.name === req.query.name) : offered
      .map(tool => {
        const label = normalize(`${tool.name} ${tool.title || ""}`);
        const text = label + " " + normalize(tool.description || "");
        return { tool, matches: words.every(word => text.includes(word)), score: words.filter(word => label.includes(word)).length + (query && label.includes(query) ? 2 : 0) };
      })
      .filter(item => item.matches).sort((a, b) => b.score - a.score).map(item => item.tool);
    res.json({ tools: matches.slice(0, 50).map(tool => req.query.name ? tool : ({ name: tool.name, title: tool.title, description: tool.description.split(". ")[0], annotations: tool.annotations })), more: matches.length > 50 });
  });
  // Execute a named tool in one network request. Re-enter the ordinary
  // middleware with the SAME request identity: no trusted headers, broader
  // credential, or alternate implementation of a tool's authorization.
  app.post("/api/browser/mcp/call", async (req, res) => {
    const client = browser(req);
    if (!isPlainRecord(req.body) || Object.keys(req.body).some(key => !["name", "arguments"].includes(key)) ||
        typeof req.body.name !== "string" || req.body.name.length > 128 ||
        (req.body.arguments !== undefined && !isPlainRecord(req.body.arguments))) throw fail(400, "Name one tool and its arguments.");
    runtimeSaid(req, client);
    const { view, offered, list } = await mcpTools(req, client);
    if (!offered.some(tool => tool.name === req.body.name)) throw fail(400, "This tool is not available to this agent.");
    let plan;
    try { plan = browserToolRequest(req.body.name, req.body.arguments || {}, view); }
    catch (error) { throw fail(400, String(error?.message || "These arguments don't fit this tool.").slice(0, 500)); }
    if (plan.route.split("?")[0] === "/api/browser/mcp/call") throw fail(400, "Nested tool dispatch is not allowed.");
    if (!browserRouteAllowed(browser(req), plan.method, plan.route.split("?")[0].slice(4))) throw fail(403, "This tool is no longer allowed.");
    const started = performance.now(), json = res.json, send = res.send;
    const restore = () => { res.json = json; res.send = send; };
    const envelope = result => ({ result, list, ...(view.runtime ? { runtime: view.runtime } : {}), dispatchMs: Math.round(performance.now() - started) });
    res.json = function(value) { restore(); return json.call(this, this.statusCode < 400 ? envelope(value) : value); };
    res.send = function(value) {
      if (plan.response === "image" && Buffer.isBuffer(value) && this.statusCode < 400) {
        const mimeType = String(this.getHeader("Content-Type") || "").split(";")[0];
        if (["image/jpeg", "image/png"].includes(mimeType)) {
          restore(); this.type("json");
          return json.call(this, envelope({ image: value.toString("base64"), mimeType }));
        }
      }
      return send.call(this, value);
    };
    req.method = plan.method; req.url = plan.route; req.originalUrl = plan.route;
    req.body = plan.body || {};
    delete req._parsedUrl; delete req._parsedOriginalUrl;
    app(req, res);
  });
  app.post("/api/browser/mcp/plan", async (req, res) => {
    const client = browser(req);
    if (!isPlainRecord(req.body) || Object.keys(req.body).some((key) => !["name", "arguments"].includes(key)) ||
        typeof req.body.name !== "string" || req.body.name.length > 128 ||
        (req.body.arguments !== undefined && !isPlainRecord(req.body.arguments)))
      throw fail(400, "Name one tool and its arguments.");
    runtimeSaid(req, client);
    const { view, offered, list } = await mcpTools(req, client);
    if (!offered.some((tool) => tool.name === req.body.name)) throw fail(400, "This tool is not available to this agent.");
    let plan;
    try { plan = browserToolRequest(req.body.name, req.body.arguments || {}, view); }
    catch (error) { throw fail(400, String(error?.message || "These arguments don't fit this tool.").slice(0, 500)); }
    res.json({ plan, list, ...(view.runtime ? { runtime: view.runtime } : {}) });
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
    try { const value = await work(); if (!res.headersSent) res.json(value); }
    catch (error) {
      const { status, ...details } = agentErrorDetails(error);
      if (res.headersSent || !status || !details.kind || (status >= 500 && !details.helperReason)) throw error;
      res.status(status).json(details);
    }
  };
  const observations = createObservations();
  const readOptions = body => body.observe === undefined ? {} : observationOptions(body.observe);
  const validateAfter = body => {
    if (body.observe !== undefined) observationOptions(body.observe);
    if (body.waitFor !== undefined) waitOptions(body.waitFor);
  };
  const observeAfter = async (req, result, body) => {
    if (!body.observe && !body.describe && !body.waitFor) return result;
    const client = presetClient(req, "browser:control"), options = readOptions(body);
    const authorize = () => presetClient(req, "browser:control");
    try {
      const read = () => desktop.elements(client, authorize, options);
      const waited = body.waitFor ? await waitForScreen({ read, authorize, wanted: body.waitFor,
        changed: desktop.waitForChange ? (revision, ms) => desktop.waitForChange(client, revision, ms, authorize) : null }) : null;
      const screen = waited?.screen || await read();
      const view = observations(authorize(), screen, options);
      return { ...result, ...(waited ? { found: waited.found, waitedMs: waited.waitedMs } : {}),
        screen: { snapshot: view.snapshot, app: view.app, title: view.title, displayId: view.displayId, truncated: view.truncated, outputTruncated: view.outputTruncated,
          text: view.text, ...(body.observe && typeof body.observe === "object" && body.observe.sinceSnapshot ? { delta: view.delta, reset: view.reset, removed: view.removed } : {}) } };
    } catch (error) {
      // Input already completed. Preserve its receipt so a failed read never
      // looks like permission to repeat an effect. Do not include old content.
      if (!Object.keys(result).length) throw error;
      const { status, ...details } = agentErrorDetails(error);
      return { ...result, screen: details, observationFailed: true };
    }
  };
  app.get("/api/browser/desktop/displays", async (req, res) => {
    const client = presetClient(req, "browser:screen"); needDesktop();
    await answer(res, () => desktop.displays(client, () => presetClient(req, "browser:screen")));
  });
  app.get("/api/browser/desktop/screen", async (req, res) => {
    const client = presetClient(req, "browser:screen");
    needDesktop();
    if (Object.keys(req.query).some((key) => !["maxWidth", "displayId"].includes(key))) throw fail(400, "Choose only the image width.");
    await answer(res, async () => {
      const shot = await desktop.screenshot(client, () => presetClient(req, "browser:screen"), { maxWidth: Number(req.query.maxWidth) || 2560, ...(req.query.displayId ? { displayId: observationOptions({ displayId: req.query.displayId }).displayId } : {}) });
      res.set("Cache-Control", "no-store");
      res.set("X-Reach-Screen", JSON.stringify({ width: shot.width, height: shot.height, hidden: shot.hidden }));
      res.type("image/jpeg").send(shot.jpeg);
    });
  });
  app.get("/api/browser/desktop/front", async (req, res) => {
    const client = presetClient(req, "browser:screen");
    needDesktop();
    await answer(res, () => desktop.front(client, () => presetClient(req, "browser:screen")));
  });
  app.get("/api/browser/desktop/elements", async (req, res) => {
    const client = presetClient(req, "browser:control");
    needDesktop();
    const options = observationOptions(req.query);
    await answer(res, async () => {
      const screen = await desktop.elements(client, () => presetClient(req, "browser:control"), options);
      const { text, ...view } = observations(presetClient(req, "browser:control"), screen, options);
      return view;
    });
  });
  // The front window as text, controls numbered inline (reach_describe_screen).
  app.get("/api/browser/desktop/describe", async (req, res) => {
    const client = presetClient(req, "browser:control");
    needDesktop();
    await answer(res, async () => {
      const options = observationOptions(req.query);
      const found = await desktop.elements(client, () => presetClient(req, "browser:control"), options);
      const view = observations(presetClient(req, "browser:control"), found, options);
      return { snapshot: view.snapshot, app: view.app, title: view.title, truncated: view.truncated, outputTruncated: view.outputTruncated,
        displayId: view.displayId, delta: view.delta, reset: view.reset, removed: view.removed, screenText: view.text };
    });
  });
  // One action, or several in order (actions), each checked on the Mac
  // exactly as when sent alone; a batch stops at the first one refused and
  // says why. With describe, the screen as text comes back in the same
  // answer: act and see in one round trip, no screenshot.
  const BATCH = { actions: 10, text: 2000, wait: 2000, waits: 6000, holds: 12000, ms: 20000 };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  app.post("/api/browser/desktop/input", async (req, res) => {
    const client = presetClient(req, "browser:control");
    needDesktop();
    const body = req.body;
    const keys = isPlainRecord(body) ? Object.keys(body) : [];
    if (!isPlainRecord(body) || keys.includes("action") === keys.includes("actions") ||
        keys.some((key) => !["action", "actions", "describe", "observe", "waitFor"].includes(key)) || (body.describe !== undefined && body.describe !== true))
      throw fail(400, "Send one action, or actions: a list of up to 10.");
    const authorize = () => presetClient(req, "browser:control");
    validateAfter(body);
    const act = (action) => (shortcuts || desktop).act(client, action, authorize);
    if (keys.includes("action") && !body.describe && !body.observe && !body.waitFor) return answer(res, () => act(body.action));
    const list = keys.includes("action") ? [body.action] : body.actions;
    if (!Array.isArray(list) || !list.length || list.length > BATCH.actions)
      throw fail(400, "Send one action, or actions: a list of up to 10.");
    let typed = 0, waited = 0, held = 0, conditionWaited = 0;
    for (const item of list) {
      if (isPlainRecord(item) && item.type === "wait_for") {
        const { type, displayId, ...condition } = item;
        waitOptions(condition);
        if (displayId !== undefined) observationOptions({ displayId });
        conditionWaited += condition.timeoutMs ?? 8000;
      } else if (isPlainRecord(item) && item.type === "wait") {
        if (Object.keys(item).some((key) => !["type", "ms"].includes(key)) || !Number.isInteger(item.ms) || item.ms < 50 || item.ms > BATCH.wait)
          throw fail(400, "A wait takes ms, from 50 to 2000.");
        waited += item.ms;
      } else {
        // Every action is checked before any runs: a bad one never leaves
        // half a batch done.
        const action = normalizeAction(item);
        held += (action.holdMs || 0) + (action.durationMs || 0);
        if (typeof item.text === "string") typed += item.text.length;
        if (Array.isArray(item.fields)) for (const field of item.fields) typed += String(field?.text || "").length;
      }
    }
    if (conditionWaited + waited > 15000) throw fail(400, "Wait at most 15 seconds for conditions in one batch.");
    if (waited > BATCH.waits) throw fail(400, "Wait at most 6 seconds in one batch.");
    if (held > BATCH.holds) throw fail(400, "Hold and drag for at most 12 seconds in one batch.");
    if (typed > BATCH.text) throw fail(400, "Type at most 2000 characters in one batch.");
    await answer(res, async () => {
      const started = Date.now(), results = [];
      let stopped = null;
      for (const [index, item] of list.entries()) {
        // A hold or slow drag that would end past the budget doesn't start.
        const lasts = item?.type === "wait" ? 0 : (item?.holdMs || 0) + (item?.durationMs || 0);
        if (Date.now() - started + lasts > BATCH.ms) {
          stopped = { index, error: "The rest didn't run in time. Describe the screen, then send what's left.", kind: "retry" };
          break;
        }
        if (item?.type === "wait_for") {
          const { type, displayId, ...condition } = item;
          try {
            const waited = await waitForScreen({ authorize,
              wanted: { ...condition, timeoutMs: Math.min(condition.timeoutMs ?? 8000, Math.max(0, BATCH.ms - (Date.now() - started))) },
              read: () => desktop.elements(client, authorize, { displayId }),
              changed: desktop.waitForChange ? (revision, ms) => desktop.waitForChange(client, revision, ms, authorize) : null });
            if (!waited.found) { stopped = { index, kind: "retry", error: "The expected screen did not appear. Later actions were not run." }; break; }
            results.push({ found: true, waitedMs: waited.waitedMs });
          } catch (error) {
            const { status, ...details } = agentErrorDetails(error);
            if (status === 401 || !results.length) throw error;
            stopped = { index, ...details }; break;
          }
          continue;
        }
        if (item?.type === "wait") {
          authorize();
          await pause(item.ms);
          results.push({ waited: item.ms });
          continue;
        }
        try {
          results.push(await act(item));
        } catch (error) {
          // A refusal (blocked, busy, paused, retry) stops the batch and is
          // said; access that ended, or a failure, ends the request.
          const { status, ...details } = agentErrorDetails(error);
          if (status === 401 || ((!status || !details.kind || status >= 500) && !results.length)) throw error;
          stopped = { index, ...details };
          break;
        }
      }
      const reply = { ok: !stopped, done: results.length, results, ...(stopped ? { stopped } : {}) };
      return observeAfter(req, reply, stopped ? { ...body, waitFor: undefined } : body);
    });
  });
  // The Mac waits for its own screen to show some text or a control (a page
  // loading, a dialog appearing), so an agent far away doesn't ask again and
  // again: a look every 400 ms, up to 15 s, then the screen as text either way.
  app.post("/api/browser/desktop/wait", async (req, res) => {
    const client = presetClient(req, "browser:control");
    needDesktop();
    const body = req.body;
    if (!isPlainRecord(body)) throw fail(400, "Give a wait condition.");
    const { observe, ...condition } = body;
    waitOptions(condition);
    if (observe !== undefined) observationOptions(observe);
    await answer(res, () => observeAfter(req, {}, { waitFor: condition, observe: observe ?? true }));
  });

  app.get("/api/browser/desktop/apps", async (req, res) => {
    const client = presetClient(req, "browser:open");
    needDesktop();
    await answer(res, async () => ({ apps: await permittedApps(client, () => presetClient(req, "browser:open")) }));
  });
  // The apps this session may open: chosen apps, or all installed apps for Full control.
  const permittedApps = async (client, authorize) => {
    const catalog = await desktop.catalog(authorize);
    const latest = authorize();
    return latest.policy.preset === "apps"
      ? latest.policy.apps.map((app) => ({ id: app.id, name: app.name, bundleId: app.bundleId, running: catalog.some((entry) => entry.id === app.id && entry.running) }))
      : catalog
        .map((app) => ({ id: app.id, name: app.name, bundleId: app.bundleId, running: app.running, ...(terminalLikeApp(app) ? { runsCommands: true } : {}) }));
  };
  // An app by its name ("Calculator") as well as its path: one of those.
  const appByName = async (client, name, authorize) => {
    const wanted = name.trim().toLowerCase().replace(/\.app$/, "");
    const apps = await permittedApps(client, authorize);
    const exact = apps.filter((app) => app.name.toLowerCase() === wanted);
    const matches = exact.length ? exact : apps.filter((app) => app.name.toLowerCase().startsWith(wanted));
    if (matches.length === 1) return matches[0].id;
    if (!matches.length) throw fail(404, `No app named "${name.slice(0, 80)}" that this session may open. reach_desktop_apps lists them.`);
    throw fail(409, `Several apps match "${name.slice(0, 80)}": ${matches.slice(0, 6).map((app) => app.name).join(", ")}. Use one's full name.`);
  };
  app.post("/api/browser/desktop/open", async (req, res) => {
    const client = presetClient(req, "browser:open");
    needDesktop();
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some((key) => !["app", "observe", "waitFor"].includes(key)) || typeof body.app !== "string" || !body.app.trim() || body.app.length > 4096)
      throw fail(400, "Choose one app by its name or path.");
    const authorize = () => presetClient(req, "browser:open");
    const target = body.app.startsWith("/") ? body.app : await appByName(client, body.app, authorize);
    validateAfter(body);
    await answer(res, async () => observeAfter(req, await (shortcuts || desktop).open(client, target, authorize), body));
  });
  // A website in the owner's own browser, with their sign-ins (reach_open_url).
  app.post("/api/browser/desktop/open-url", async (req, res) => {
    const client = presetClient(req, "browser:open");
    needDesktop();
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some((key) => !["url", "browser", "observe", "waitFor"].includes(key)) || typeof body.url !== "string")
      throw fail(400, "Give a web address, and optionally a browser.");
    const authorize = () => presetClient(req, "browser:open");
    if (body.browser !== undefined && (typeof body.browser !== "string" || !body.browser.trim()))
      throw fail(400, "Choose the browser by name or path.");
    const browser = body.browser === undefined ? undefined
      : typeof body.browser === "string" && body.browser.startsWith("/") ? body.browser
        : await appByName(client, String(body.browser || ""), authorize);
    validateAfter(body);
    await answer(res, async () => observeAfter(req, await desktop.openUrl(client, body.url, browser, authorize), body));
  });
  // Every window the agent may know of, and bringing one forward (reach_windows,
  // reach_focus_window): the right window or tab in one step, no guessing.
  app.get("/api/browser/desktop/windows", async (req, res) => {
    const client = presetClient(req, "browser:screen");
    needDesktop();
    await answer(res, () => desktop.windows(client, () => presetClient(req, "browser:screen")));
  });
  app.post("/api/browser/desktop/focus", async (req, res) => {
    const client = presetClient(req, "browser:open");
    needDesktop();
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some((key) => !["id", "title", "tab", "tabRef", "observe", "waitFor"].includes(key))) throw fail(400, "Choose a window by id, with its title, and a tab if you like.");
    validateAfter(body);
    await answer(res, async () => observeAfter(req, await desktop.focusWindow(client, body, () => presetClient(req, "browser:open")), body));
  });
  // The front app's menu bar as data (reach_menus); items are pressed with
  // reach_act {type: "menu", path}.
  app.get("/api/browser/desktop/menus", async (req, res) => {
    const client = presetClient(req, "browser:control");
    needDesktop();
    if (Object.keys(req.query).some((key) => key !== "menu") || (req.query.menu !== undefined && typeof req.query.menu !== "string")) throw fail(400, "Name one menu, or none.");
    await answer(res, () => desktop.menus(client, req.query.menu, () => presetClient(req, "browser:control")));
  });
  // Something in the front window by its words, scrolled into view, with the
  // screen as text around it (reach_find).
  app.post("/api/browser/desktop/find", async (req, res) => {
    const client = presetClient(req, "browser:control");
    needDesktop();
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some((key) => !["text", "name", "role"].includes(key)) || (body.text === undefined) === (body.name === undefined) || (body.role !== undefined && body.name === undefined))
      throw fail(400, "Find text, or a control by name (and role).");
    await answer(res, async () => {
      const found = await desktop.find(client, body, () => presetClient(req, "browser:control"));
      if (!found.found) return { found: false, app: found.app, title: found.title, truncated: found.truncated,
        screenText: `Not in this window: ${JSON.stringify(body.text ?? body.name)}.${found.truncated ? " The window was too large to read fully." : ""}` };
      const { items, texts, fields, ...rest } = found;
      const what = `[${rest.n ?? "?"}] ${rest.role}${rest.name !== undefined ? ` "${rest.name}"` : ` "${rest.text}"`}`;
      const where = rest.inView ? (rest.scrolled ? ", scrolled into view" : ", in view") : `, ${rest.direction} the visible part by about ${rest.distance} px: scroll that way, then find again`;
      const lead = `Found ${what}${rest.matches > 1 ? ` (${rest.matches} matches; the first)` : ""}${where}.\n\n`;
      return { ...rest, screenText: lead + describeScreen({ ...rest, items, texts }) };
    });
  });
  // The front window's whole text, 12000 characters a call (reach_read_page).
  // Read once, kept a minute for the following pages.
  const PAGE = 12000, pages = new Map(); // clientId -> { at, read }
  app.get("/api/browser/desktop/read", async (req, res) => {
    const client = presetClient(req, "browser:control");
    needDesktop();
    const offset = req.query.offset === undefined ? 0 : Number(req.query.offset);
    if (Object.keys(req.query).some((key) => key !== "offset") || !Number.isInteger(offset) || offset < 0 || offset > 60000) throw fail(400, "Give the offset the last page returned as nextOffset.");
    await answer(res, async () => {
      const kept = pages.get(client.id);
      const read = offset > 0 && kept && Date.now() - kept.at < 60000 ? kept.read : await desktop.readPage(client, () => presetClient(req, "browser:control"));
      pages.set(client.id, { at: Date.now(), read });
      if (pages.size > 64) pages.delete(pages.keys().next().value);
      const text = read.text.slice(offset, offset + PAGE), end = offset + text.length, more = end < read.text.length;
      return { app: read.app, title: read.title, url: read.url, offset, text, more, ...(more ? { nextOffset: end } : {}), total: read.text.length, truncated: read.truncated };
    });
  });
  // A file from a shared folder, in the app that owns it or shown in the Finder (reach_open_file).
  app.post("/api/browser/desktop/open-file", async (req, res) => {
    const client = presetClient(req, "browser:open");
    needDesktop();
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some((key) => !["root", "path", "reveal", "observe", "waitFor"].includes(key)) || typeof body.path !== "string" || !body.path.trim() ||
        (body.reveal !== undefined && body.reveal !== true)) throw fail(400, "Name the file inside a shared folder, and reveal: true to show it in the Finder.");
    if (!client.policy.roots?.length) throw fail(403, "This invitation shares no folders to open files from.");
    const target = resolve(body.root ?? 0, body.path, client);
    validateAfter(body);
    await answer(res, async () => observeAfter(req, await desktop.openFile(client, target, { reveal: body.reveal === true }, () => presetClient(req, "browser:open")), body));
  });
  // Full control sees every Mac Shortcut; other presets see the owner's allowed names.
  const needShortcuts = () => { if (!macShortcuts) throw fail(503, "Shortcuts for agents are unavailable on this computer."); };
  app.get("/api/browser/desktop/mac-shortcuts", async (req, res) => {
    const client = presetClient(req, "browser:open");
    needShortcuts();
    const result = await macShortcuts.agentList(client);
    presetClient(req, "browser:open");
    res.json(result);
  });
  app.post("/api/browser/desktop/mac-shortcuts/run", async (req, res) => {
    const client = presetClient(req, "browser:open");
    needShortcuts();
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some((key) => !["name", "input"].includes(key))) throw fail(400, "Name the shortcut, with text input if it takes any.");
    await answer(res, async () => {
      try {
        const result = await macShortcuts.run(client, body, () => presetClient(req, "browser:open"));
        actions(client, { kind: "mac-shortcut", text: actionWords("mac-shortcut", body), ok: result.ok, ...(result.ok ? {} : { reason: result.timedOut ? "Stopped after 60 seconds." : "The shortcut failed." }) });
        return result;
      } catch (error) {
        if (error?.kind === "blocked") actions(client, { kind: "mac-shortcut", text: actionWords("mac-shortcut", body), ok: false, reason: error.message });
        throw error;
      }
    });
  });
  // The shell (Full control): one command as the owner, logged and unsandboxed.
  app.post("/api/browser/shell", async (req, res) => {
    const client = presetClient(req, "browser:shell");
    if (!shell) throw fail(503, "Commands for agents are unavailable on this computer.");
    const item = await shell.run(client, req.body, { resolve, authorize: () => presetClient(req, "browser:shell") });
    record("agent", `${client.name} ${item.status === "blocked" ? "was refused a command" : "ran a command"}`);
    res.json(item);
  });
  app.get("/api/browser/shell/history", async (req, res) => {
    const client = presetClient(req, "browser:shell");
    if (!shell) throw fail(503, "Commands for agents are unavailable on this computer.");
    res.json(await shell.history(client));
  });
  // File changes: Files with editing goes through the sandboxed helper in its
  // chosen folders; Full control writes directly across its filesystem roots.
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
      actions(client, { kind: "file", text: actionWords("file", body) });
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
      // Opened once and proven to be the file checked before anything is
      // cut or written (confined-file.mjs): a link put in its place meanwhile
      // is never followed.
      const { handle } = await openConfined(target, constants.O_WRONLY | constants.O_CREAT, () => resolve(body.root, body.path, client));
      try {
        const data = Buffer.from(body.content, "utf8");
        await handle.truncate(0);
        await handle.write(data, 0, data.length, 0);
      } finally { await handle.close(); }
    } else {
      const destination = resolve(body.root, body.to, client, { allowMissing: true });
      if (!existing?.isFile()) throw fail(404, "Choose an existing file to copy.");
      if (existing.size > 25 * 1048576) throw fail(403, "Choose a file no larger than 25 MiB.");
      const there = await fs.lstat(destination).catch(() => null);
      if (there?.isSymbolicLink() || there?.isDirectory()) throw fail(409, "Choose a file name for the copy.");
      // Both ends opened once and proven, as a write is.
      const from = await openConfined(target, constants.O_RDONLY, () => resolve(body.root, body.path, client));
      try {
        const data = await readUpTo(from.handle, 25 * 1048576);
        if (!data) throw fail(403, "Choose a file no larger than 25 MiB.");
        const to = await openConfined(destination, constants.O_WRONLY | constants.O_CREAT, () => resolve(body.root, body.to, client), { mode: from.mode & 0o777 });
        try {
          await to.handle.truncate(0);
          await to.handle.write(data, 0, data.length, 0);
        } finally { await to.handle.close(); }
      } finally { await from.handle.close(); }
    }
    record("agent", `${client.name} changed a file (${body.op})`);
    actions(client, { kind: "file", text: actionWords("file", body) });
    presetClient(req, "browser:write");
    res.json({ ok: true });
  });
}
