import path from 'node:path';
import { createReach } from '../../server/index.mjs';
import { ALL_SCOPES } from '../../server/core.mjs';

// Actual ephemeral HTTP/auth routes, injected workflow and provider adapters.
// Does not launch/restart the owner's Reach or expose any live app data.
export async function outcomeHttp(t, h) {
  const reach = await createReach({ roots: [h.dir], dataDir: path.join(h.dir, 'http-state'), workflows: h.workflows,
    openClaw: { overview: async () => ({ connected: false }), close() {} },
    agentSessions: { list: async () => ({ sessions: [], errors: {} }), health: async () => [], models: async () => ({ models: [], modes: [] }) } });
  t.after(() => reach.close());
  await new Promise((resolve, reject) => { reach.server.once('error', reject); reach.server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${reach.server.address().port}`, owner = reach.auth.issue('Owner', ALL_SCOPES);
  const prefix = `/api/sessions/workflows/${h.w.id}`;
  const call = async (suffix, body, token = owner.token) => {
    const response = await fetch(url + prefix + suffix, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { reach, url, owner, prefix, call,
    async prepare() { const o = h.get(); return call('/outcome/prepare', h.command('http-prepare-checks', { contractRevision: o.contractRevision, contractDigest: o.contractDigest, planDigest: o.planDigest })); },
    runBody() { const o = h.get(); return h.command('http-run-approved-plan', { contractRevision: o.contractRevision, contractDigest: o.contractDigest, planDigest: o.planDigest, preparedDigest: o.preparation.preparedDigest }); },
  };
}
