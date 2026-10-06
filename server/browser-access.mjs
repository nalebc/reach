import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fail, hash, isPlainRecord, validateBrowserInvitation } from "./core.mjs";
import { fileRootName } from "./file-roots.mjs";
import { validBrowserTerminalId } from "./agent-policy.mjs";
import { validateBrowserRequest } from "./browser-approvals.mjs";
import { terminalLocation } from "./restricted-terminal.mjs";

// An explicit route allowlist is part of the credential, independent of UI.
// New Reach APIs do not automatically become available to browser agents.
export function browserRouteAllowed(client, method, route) {
  if (!client?.policy?.browser) return false;
  if (method === "DELETE" && route === "/device/access") return true;
  if (route === "/browser/requests" && ["GET", "HEAD", "POST"].includes(method))
    return client.scopes.includes("browser:request");
  if (method === "DELETE" && /^\/browser\/requests\/[^/]+$/.test(route))
    return client.scopes.includes("browser:request");
  if (method === "POST" && route === "/browser/scroll")
    return client.scopes.includes("browser:scroll");
  if (!["GET", "HEAD"].includes(method)) return false;
  if (route === "/device") return true;
  if (
    route === "/browser" ||
    route === "/browser/screen" ||
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
    capture,
    viewCapture = capture,
    scroll,
    screenAvailable,
    record,
    approvals,
    snapshots,
    prepareFunnel,
  },
) {
  const owner = (req) => {
    const client = req.reauthorize();
    if (client.kind !== "device" || !client.scopes.includes("admin"))
      throw fail(403, "Only the computer's owner can invite a browser agent.");
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
    res.json({
      terminals: await terminalOptions(() => owner(req)),
      screenAvailable: screenAvailable(),
    });
  });
  app.post("/api/agents/browser-invitations", async (req, res) => {
    owner(req);
    const input = validateBrowserInvitation(req.body);
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
    const grant = auth.inviteBrowser(input);
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
  });
  app.get("/api/browser", async (req, res) => {
    const client = browser(req);
    const selected = await terminalOptions(
      () => browser(req),
      client.policy.terminalIds,
    );
    res.json({
      name: config.name,
      expiresAt: client.expiresAt,
      roots: client.agentRoots.map((p, index) => ({
        index,
        name: fileRootName(p),
        path: p,
      })),
      terminals: selected,
      screen: client.policy.screen,
      commandRequests: client.policy.commandRequests === true,
      ...(client.policy.restrictedTerminal ? { restrictedTerminal: true } : {}),
    });
  });
  // The assistant proposes; only a separate owner credential may decide.
  // Screen requests retain the exact screenshot the owner reviews. Neither
  // the body of the approval nor a client-side UI can replace the action.
  app.post("/api/browser/requests", async (req, res) => {
    let client = browser(req);
    const input = req.body || {};
    validateBrowserRequest(client, input);
    let frame;
    if (input.type === "terminal") {
      // Validate the folder before prompting the owner. Execution rechecks it.
      const location = terminalLocation(input);
      const cwd = resolve(input.root, location.cwd, client);
      if (!(await fs.stat(cwd)).isDirectory()) throw fail(400, "Choose a working folder.");
      const target = resolve(input.root, location.relative, browser(req));
      if (location.spec.name === "cd" && !(await fs.stat(target)).isDirectory())
        throw fail(400, "Choose a folder, not a file.");
    }
    if (!["command", "terminal"].includes(input.type)) {
      if (client.policy.screen !== "ask" || !screenAvailable())
        throw fail(403, "This invitation cannot request screen control.");
      frame = await capture(() => {
        client = browser(req);
        if (client.policy.screen !== "ask" || !screenAvailable())
          throw fail(403, "Screen control requests are no longer allowed.");
      });
      if (frame.length > 8 * 1024 * 1024)
        throw fail(413, "This screen snapshot is too large to review.");
    }
    const request = approvals.request(browser(req), input);
    if (frame) snapshots.set(request.id, { frame, hash: hash(frame) });
    res.status(201).json(request);
  });
  app.get("/api/browser/requests", (req, res) =>
    res.json(approvals.listClient(browser(req))),
  );
  app.delete("/api/browser/requests/:id", (req, res) => {
    const result = approvals.cancel(browser(req), req.params.id);
    snapshots.delete(req.params.id);
    res.json(result);
  });
  app.get("/api/agents/browser-requests", (req, res) => {
    owner(req);
    res.json(approvals.listOwner());
  });
  app.get("/api/agents/browser-requests/:id/screen", (req, res) => {
    owner(req);
    const request = approvals.getOwner(req.params.id);
    const image = snapshots.get(request.id);
    if (request.status !== "pending" || !image)
      throw fail(404, "That screen request has ended.");
    res.type("image/jpeg").send(image.frame);
  });
  app.post("/api/agents/browser-requests/:id", async (req, res) => {
    owner(req);
    const body = req.body || {};
    if (!isPlainRecord(body))
      throw fail(400, "Approve the exact action shown, without replacements.");
    if (Object.keys(body).some((key) => key !== "decision"))
      throw fail(400, "Approve the exact action shown, without replacements.");
    const result = await approvals.decide(req.client, req.params.id, req.body?.decision, () => {
      owner(req);
      return req.client;
    });
    snapshots.delete(req.params.id);
    res.json(result);
  });
  app.get("/api/browser/terminals/:id", async (req, res) => {
    const authorize = () => {
      if (!browser(req).policy.terminalIds.includes(req.params.id))
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
        let dir;
        try {
          dir = await resolveAsync(root, relative, current);
        } catch {
          continue;
        }
        let entries;
        try {
          entries = await fs.opendir(dir);
        } catch {
          continue;
        }
        for await (const entry of entries) {
          if (++seen > 5000 || Date.now() > deadline || items.length >= 100) {
            truncated = true;
            break search;
          }
          // Do not follow directory links, hidden locations or special files.
          if (
            entry.name.startsWith(".") ||
            entry.isSymbolicLink() ||
            (!entry.isDirectory() && !entry.isFile())
          )
            continue;
          const relativePath = path.join(relative, entry.name);
          try {
            await resolveAsync(root, relativePath, browser(req));
          } catch (e) {
            if (e.status === 401) throw e;
            continue;
          }
          if (entry.isDirectory()) pending.push(relativePath);
          if (entry.name.toLocaleLowerCase().includes(needle)) {
            items.push({
              name: entry.name,
              path: relativePath.split(path.sep).join("/"),
              type: entry.isDirectory() ? "directory" : "file",
            });
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
  const screen = (req, needsScroll = false) => {
    const client = browser(req);
    if (
      !screenAvailable() ||
      client.policy.screen === "off" ||
      (needsScroll && !client.scopes.includes("browser:scroll"))
    )
      throw fail(403, "This invitation does not allow that screen action.");
    return client;
  };
  app.get("/api/browser/screen", async (req, res) => {
    screen(req);
    const frame = await viewCapture(() => screen(req));
    screen(req);
    res.type("image/jpeg").send(frame);
  });
  app.post("/api/browser/scroll", async (req, res) => {
    screen(req, true);
    const body = req.body || {};
    const amount = body.amount ?? 3;
    if (
      !["up", "down"].includes(body.direction) ||
      !Number.isInteger(amount) ||
      amount < 1 ||
      amount > 5 ||
      Object.keys(body).some((k) => !["direction", "amount"].includes(k))
    )
      throw fail(400, "Choose up or down and 1 to 5 scroll steps.");
    const delta = body.direction === "up" ? amount : -amount;
    await scroll({ type: "scroll", delta }, () => screen(req, true));
    record("agent", `${req.client.name} scrolled the screen`);
    res.json({ ok: true });
  });
}
