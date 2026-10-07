import { fail, isPlainRecord } from './core.mjs';

export function browserWorkspaceRoutes(app, { manager, auth, coordinator, endClient, onStopped = () => {} }) {
  const owner = req => {
    const client = req.reauthorize();
    if (client.kind !== 'device' || !client.scopes?.includes('admin')) throw fail(403, 'Only the owner can review and apply private working copies.');
    return client;
  };
  const stop = async (id, req) => {
    owner(req);
    const record = manager().getOwner(id);
    const client = record.clientId && auth.list().find(value => value.id === record.clientId);
    if (client) {
      if (client.kind !== 'agent' || client.policy?.browser !== true || client.browserWorkspaceId !== id)
        throw fail(403, 'This working copy no longer matches its invitation.');
      endClient(client.id); onStopped(client.id);
    }
    const until = Date.now() + 12000;
    while (coordinator.listOwner().some(value => value.clientId === record.clientId)) {
      owner(req);
      if (Date.now() >= until) throw fail(409, 'The agent is stopping. Wait for its command to finish, then review again.');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    owner(req);
    return record;
  };
  app.post('/api/agents/workspaces/:id/review', async (req, res) => {
    owner(req);
    if (req.body && (!isPlainRecord(req.body) || Object.keys(req.body).length)) throw fail(400, 'Review this working copy without changing its contents.');
    await stop(req.params.id, req);
    const result = await manager().review(req.params.id, () => owner(req));
    owner(req); res.json(result);
  });
  app.post('/api/agents/workspaces/:id/apply', async (req, res) => {
    owner(req);
    if (!isPlainRecord(req.body) || Object.keys(req.body).some(key => key !== 'reviewId') || typeof req.body.reviewId !== 'string') throw fail(400, 'Choose the exact review to apply.');
    const result = await manager().apply(req.params.id, req.body.reviewId, () => owner(req));
    owner(req); res.json(result);
  });
  app.delete('/api/agents/workspaces/:id', async (req, res) => {
    await stop(req.params.id, req);
    const result = await manager().discard(req.params.id, () => owner(req));
    owner(req); res.json(result);
  });
}
