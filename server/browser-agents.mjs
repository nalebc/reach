import { fail, isPlainRecord } from './core.mjs';

// Owner controls stay outside the browser agent route allowlist. An agent name
// is a label; only the server-created invitation ID identifies a session.
export function browserAgentRoutes(app, { auth, approvals, appAccess, coordinator, endClient, onStopped = () => {}, desktop = null }) {
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
        status: client.status === 'revoked' ? 'revoked' : client.expiresAt <= at || (client.status === 'accepted' && client.browserTransport === 'funnel' && !(client.browserIdleExpiresAt > at)) ? 'expired' : client.status,
        scopes: client.scopes, policy: client.policy, browserTransport: client.browserTransport,
        folders: client.agentRoots || client.policy?.roots || [],
        activity: current ? { state: current.stopping ? 'stopping' : current.state, folder: current.folder, kind: current.kind, queuedAt: current.queuedAt, startedAt: current.startedAt } : { state: 'idle' },
        pendingApprovals: pending.filter(item => item.clientId === client.id).length,
        ...(client.policy?.preset ? { preset: client.policy.preset } : {}),
        ...(desktopActivity.agents[client.id] ? { using: desktopActivity.agents[client.id] } : {}),
        holdsMac: desktopActivity.holder?.clientId === client.id,
        ...(desktopActivity.paused?.includes(client.id) ? { paused: true } : {}),
      };
    });
    owner(req);
    res.json({ agents, at });
  });
  // Pause one preset agent: it keeps looking, its actions wait until resumed.
  app.post('/api/browser/agents/pause', (req, res) => {
    owner(req);
    const body = req.body;
    if (!isPlainRecord(body) || Object.keys(body).some(key => !['clientId', 'paused'].includes(key)) ||
        typeof body.clientId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.clientId) || typeof body.paused !== 'boolean')
      throw fail(400, 'Choose one agent session to pause or resume.');
    const client = auth.list().find(entry => entry.id === body.clientId);
    if (!client || !eligible(client) || client.policy?.preset === undefined || client.expiresAt <= Date.now()) throw fail(404, 'That agent session has ended.');
    if (!desktop?.setPaused) throw fail(503, 'Pausing agents is unavailable on this computer.');
    owner(req);
    const paused = desktop.setPaused(client.id, body.paused);
    res.json({ clientId: client.id, paused });
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
      onStopped(id);
      stopped.push(id);
    }
    res.json({ stopped, missing });
  });
}
