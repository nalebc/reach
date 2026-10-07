import { fail, isPlainRecord } from './core.mjs';

// Owner controls stay outside the browser agent route allowlist. An agent name
// is a label; only the server-created invitation ID identifies a session.
export function browserAgentRoutes(app, { auth, approvals, appAccess, coordinator, endClient, onStopped = () => {}, workspaceRecords = () => [] }) {
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
    const copies = workspaceRecords();
    const clients = auth.list().filter(eligible);
    for (const copy of copies) if (!clients.some(client => client.id === copy.clientId)) clients.push({
      id: copy.clientId || `workspace-${copy.id}`, name: copy.name, kind: 'agent', status: 'revoked',
      createdAt: copy.createdAt, expiresAt: copy.expiresAt || copy.createdAt,
      policy: copy.session?.policy || { invite: true, browser: true, roots: copy.roots, screen: 'off' },
      scopes: copy.session?.scopes || [], browserWorkspaceId: copy.id,
    });
    const agents = clients.map(client => {
      const work = operations.filter(item => item.clientId === client.id);
      const current = work.find(item => item.state === 'running') || work[0];
      const workspace = copies.find(copy => copy.id === client.browserWorkspaceId);
      return {
        id: client.id, name: client.name, kind: 'agent',
        createdAt: client.createdAt, expiresAt: client.expiresAt,
        status: client.status === 'revoked' ? 'revoked' : client.expiresAt <= at || (client.status === 'accepted' && client.browserTransport === 'funnel' && !(client.browserIdleExpiresAt > at)) ? 'expired' : client.status,
        scopes: client.scopes, policy: client.policy, browserTransport: client.browserTransport,
        folders: client.agentRoots || client.policy?.roots || [],
        activity: current ? { state: current.stopping ? 'stopping' : current.state, folder: current.folder, kind: current.kind, queuedAt: current.queuedAt, startedAt: current.startedAt } : { state: 'idle' },
        pendingApprovals: pending.filter(item => item.clientId === client.id).length,
        ...(workspace ? { workspace } : {}),
      };
    });
    owner(req);
    res.json({ agents, at });
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
