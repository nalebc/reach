import { browserIdleEnded, fail, isPlainRecord } from './core.mjs';

// Owner controls stay outside the browser agent route allowlist. An agent name
// is a label; only the server-created invitation ID identifies a session.
export function browserAgentRoutes(app, { auth, approvals, appAccess, coordinator, endClient, endSession = () => {}, onStopped = () => {}, desktop = null, actions = null, pauses = null }) {
  const owner = (req) => {
    const client = req.reauthorize();
    if (client.kind !== 'device' || !client.scopes?.includes('admin'))
      throw fail(403, 'Only the computer owner can manage agent sessions.');
    return client;
  };
  const eligible = client => client?.kind === 'agent' && client.policy?.browser === true;
  app.get('/api/browser/agents', (req, res) => {
    owner(req);
    const at = Date.now(), operations = coordinator.listOwner();
    const pending = [...approvals.listOwner(), ...appAccess.listOwner()].filter(item => item.status === 'pending');
    const clients = auth.list().filter(eligible);
    // What preset agents are doing on the Mac right now, and who holds it.
    const desktopActivity = desktop?.activity?.() || { holder: null, agents: {} };
    const agents = clients.map(client => {
      const work = operations.filter(item => item.clientId === client.id);
      const current = work.find(item => item.state === 'running') || work[0];
      return {
        id: client.id, name: client.name, kind: 'agent',
        createdAt: client.createdAt, expiresAt: client.expiresAt,
        status: client.status === 'revoked' ? 'revoked' : client.expiresAt <= at || (client.status === 'accepted' && browserIdleEnded(client, at)) ? 'expired' : client.status,
        ...(client.policy?.standing ? { standing: true } : {}),
        ...(client.relink ? { relink: true } : {}),
        ...(client.needsInvitation ? { needsInvitation: true } : {}),
        scopes: client.scopes, policy: client.policy, browserTransport: client.browserTransport,
        folders: client.agentRoots || client.policy?.roots || [],
        activity: current ? { state: current.stopping ? 'stopping' : current.state, folder: current.folder, kind: current.kind, queuedAt: current.queuedAt, startedAt: current.startedAt } : { state: 'idle' },
        pendingApprovals: pending.filter(item => item.clientId === client.id).length,
        ...(client.policy?.preset ? { preset: client.policy.preset } : {}),
        ...(desktopActivity.agents[client.id] ? { using: desktopActivity.agents[client.id] } : {}),
        holdsMac: desktopActivity.holder?.clientId === client.id,
        ...(pauses?.has(client.id) ? { paused: true } : {}),
      };
    });
    owner(req);
    res.json({ agents, at });
  });
  // What one agent did on the Mac, newest first (server/agent-actions.mjs):
  // ?clientId=…&before=<ms>&limit=<n>.
  app.get('/api/agents/actions', (req, res) => {
    owner(req);
    if (!actions) throw fail(503, 'The agent action log is unavailable.');
    const { clientId, before, limit } = req.query;
    if (Object.keys(req.query).some((key) => !['clientId', 'before', 'limit'].includes(key))) throw fail(400, 'Choose an agent, a time to read back from, and how many.');
    res.json(actions.list({ ...(clientId !== undefined ? { clientId } : {}), ...(before !== undefined ? { before: Number(before) } : {}), ...(limit !== undefined ? { limit: Number(limit) } : {}) }));
  });
  // Pause one preset agent: it keeps looking, its actions wait until resumed.
  // Kept in Reach's own store (agent-pauses.mjs), on every computer: the Mac's
  // desktop service, where there is one, only lets go of what the agent holds.
  app.post('/api/browser/agents/pause', (req, res) => {
    owner(req);
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some(key => !['clientId', 'paused'].includes(key)) ||
        typeof body.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.clientId) || typeof body.paused !== 'boolean')
      throw fail(400, 'Choose one agent session to pause or resume.');
    const client = auth.list().find(entry => entry.id === body.clientId);
    if (!client || !eligible(client) || client.policy?.preset === undefined || client.expiresAt <= Date.now()) throw fail(404, 'That agent session has ended.');
    if (!pauses) throw fail(503, 'Pausing agents is unavailable on this computer.');
    owner(req);
    const paused = pauses.set(client.id, body.paused);
    res.json({ clientId: client.id, paused });
  });
  // Reopen an agent's link for a new browser: the browser it used is
  // disconnected and the same link works once more, for 15 minutes.
  app.post('/api/browser/agents/reopen', (req, res) => {
    owner(req);
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some(key => key !== 'clientId') ||
        typeof body.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.clientId))
      throw fail(400, 'Choose one agent to reopen its link.');
    const client = auth.list().find(entry => entry.id === body.clientId);
    if (!client || !eligible(client)) throw fail(404, "This agent's link can't be reopened. Make a new invite.");
    owner(req);
    const reopened = auth.reopenBrowserInvitation(client.id);
    endSession(client.id);
    res.json(reopened);
  });
  app.post('/api/browser/agents/stop', (req, res) => {
    owner(req);
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some(key => key !== 'clientIds') ||
        !Array.isArray(body.clientIds) || !body.clientIds.length || body.clientIds.length > 100 ||
        body.clientIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
        new Set(body.clientIds).size !== body.clientIds.length)
      throw fail(400, 'Choose between 1 and 100 distinct agent sessions to stop.');
    // Validate the entire owner-selected snapshot before changing anything.
    // Never expand "all" from a later list: a new invitation is independent.
    const clients = new Map(auth.list().map(client => [client.id, client]));
    for (const id of body.clientIds)
      if (clients.has(id) && !eligible(clients.get(id))) throw fail(403, 'Only browser agent sessions can be stopped here.');
    owner(req);
    const stopped = [], missing = [];
    for (const id of body.clientIds) {
      if (!clients.has(id)) { missing.push(id); continue; }
      endClient(id);
      onStopped(clients.get(id));
      stopped.push(id);
    }
    res.json({ stopped, missing });
  });
  // Clear ended agents from the list. Only ones the Mac itself reads as
  // ended go; nothing live is touched (no session to end, no screen stopped).
  app.post('/api/browser/agents/clear', (req, res) => {
    owner(req);
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some(key => key !== 'clientIds') ||
        !Array.isArray(body.clientIds) || !body.clientIds.length || body.clientIds.length > 500 ||
        body.clientIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) ||
        new Set(body.clientIds).size !== body.clientIds.length)
      throw fail(400, 'Choose between 1 and 500 distinct ended agents to clear.');
    const at = Date.now();
    const ended = client => client.status === 'revoked' || client.expiresAt <= at ||
      (client.status === 'accepted' && browserIdleEnded(client, at)) ||
      (!!client.status && !['invited', 'pending', 'approved', 'accepted'].includes(client.status));
    const clients = new Map(auth.list().map(client => [client.id, client]));
    owner(req);
    const cleared = [], kept = [];
    for (const id of body.clientIds) {
      const client = clients.get(id);
      if (!client) continue;
      if (!eligible(client) || !ended(client)) { kept.push(id); continue; }
      auth.revoke(id);
      cleared.push(id);
    }
    res.json({ cleared, kept });
  });
}
