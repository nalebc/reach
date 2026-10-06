import test from "node:test";
import { approveAgentClaim } from "./helpers/agent-admission.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES, atomicJson } from "../server/core.mjs";

// All capture and input are injected. These tests must never send a real
// keyboard/mouse event, run a command, or capture the developer's desktop.
async function start(t, hooks = {}) {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "reach-browser-approvals-")),
  );
  const state = path.join(dir, "private");
  const inputs = [];
  let frame = Buffer.from("fixture-jpeg-original");
  let captures = 0;
  const reach = await createReach({
    roots: [dir],
    dataDir: state,
    screen: true,
    browserScreenSupported: true,
    agentSessions: { macDialogs: () => hooks.macDialogs?.() || [], close() {} },
    desktopTerminals: {
      platform: "linux",
      run: async () => assert.fail("Native terminal access is forbidden"),
    },
    browserCapture: async () => {
      captures++;
      if (hooks.capture) await hooks.capture();
      return Buffer.from(frame);
    },
    browserInput: async (_config, payload, authorize) => {
      if (hooks.input) await hooks.input();
      authorize();
      inputs.push(payload);
      if (hooks.afterInput) await hooks.afterInput(inputs.length);
      return { ok: true };
    },
  });
  const owner = reach.auth.issue("Owner", ALL_SCOPES);
  t.after(async () => {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    reach.server.once("error", reject);
    reach.server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const request = (route, { token = owner.token, method = "GET", body } = {}) =>
    fetch(url + route, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const call = async (route, options) => {
    const response = await request(route, options);
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  };
  const invite = (extra = {}) =>
    call("/api/agents/browser-invitations", {
      method: "POST",
      body: {
        name: "Muse",
        ttlSeconds: 600,
        folders: [],
        terminalIds: [],
        screen: "ask",
        ...extra,
      },
    });
  const join = async (extra = {}) => {
    const invitation = await invite(extra);
    assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
    const joined = await approveAgentClaim(call, await call("/api/invitations/redeem", {
      token: "",
      method: "POST",
      body: { invitation: invitation.body.invitation },
    }));
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const as = (route, options = {}) =>
      call(route, { token: joined.body.token, ...options });
    const submit = async (body) => {
      const result = await as("/api/browser/requests", {
        method: "POST",
        body,
      });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.status, "pending");
      assert.equal(typeof result.body.id, "string");
      return result.body;
    };
    return { ...joined.body, as, submit };
  };
  const decide = (id, decision, extra = {}) =>
    call(`/api/agents/browser-requests/${id}`, {
      method: "POST",
      body: { decision, ...(decision === "approve" ? { reviewedBatch: true } : {}) },
      ...extra,
    });
  const changeClient = (id, changes) => {
    const file = path.join(state, "clients.json");
    const clients = JSON.parse(fs.readFileSync(file, "utf8"));
    Object.assign(
      clients.find((client) => client.id === id),
      changes,
    );
    atomicJson(file, clients);
  };
  return {
    dir,
    reach,
    owner,
    inputs,
    request,
    call,
    invite,
    join,
    decide,
    changeClient,
    captures: () => captures,
    setFrame: (value) => {
      frame = Buffer.from(value);
    },
  };
}

const batch = (actions = [{ type: 'text', text: 'Reviewed title' }, { type: 'key', key: 'enter' }]) => ({ type: 'batch', actions, reason: 'Enter this title and confirm' });

test('one HTTP owner decision runs the whole exact sequence, while changed initial screens refuse every step', async (t) => {
  const f = await start(t);
  const bot = await f.join(); const stale = await bot.submit(batch());
  f.setFrame('changed');
  const refused = await f.decide(stale.id, 'approve');
  assert.equal(refused.body.status, 'failed'); assert.equal(refused.body.completedCount, 0);
  assert.deepEqual(f.inputs, []);
  const fresh = await bot.submit(batch());
  const result = await f.decide(fresh.id, 'approve');
  assert.equal(result.body.status, 'executed', JSON.stringify(result));
  assert.deepEqual(f.inputs, batch().actions); assert.equal(result.body.completedCount, 2);
  assert.equal((await f.decide(fresh.id, 'approve')).status, 409);
  const next = await bot.submit(batch()); assert.equal(next.status, 'pending');
  assert.equal(f.inputs.length, 2);
});

test('bot cannot approve its batch, replace approved actions, mint invites or use direct input', async (t) => {
  const f = await start(t); const bot = await f.join(); const r = await bot.submit(batch());
  assert.equal((await f.decide(r.id, 'approve', { token: bot.token })).status, 403);
  assert.equal((await f.call(`/api/agents/browser-requests/${r.id}`, {method:'POST',body:{decision:'approve'}})).status, 400, 'old owner UI cannot approve a hidden sequence');
  assert.equal((await f.decide(r.id, 'approve', { body: { decision: 'approve', actions: [{ type: 'key', key: 'enter' }] } })).status, 400);
  for (const route of ['/api/agents/browser-invitations', '/api/agents/invitations', '/api/screen/input', '/api/jobs']) {
    const denied = await bot.as(route, { method: 'POST', body: { command: 'sudo whoami' } });
    assert.equal(denied.status, 403, route);
  }
  assert.deepEqual(f.inputs, []);
});

test('global screen lock covers the entire batch and owner stop prevents remaining actions', async (t) => {
  let release, arrived; const entered = new Promise((r) => { arrived = r; });
  const f = await start(t, { afterInput: async (count) => { if (count === 1) { arrived(); await new Promise((r) => { release = r; }); } } });
  const bot = await f.join(); const scrolling = await f.join({ screen: 'scroll' });
  const r = await bot.submit(batch()); const approving = f.decide(r.id, 'approve'); await entered;
  const pending = await f.call('/api/agents/browser-requests');
  assert.equal(pending.body[0].status, 'executing');
  assert.equal((await scrolling.as('/api/browser/scroll', { method: 'POST', body: { direction: 'down', amount: 1 } })).status, 409);
  assert.equal((await f.decide(r.id, 'deny')).body.status, 'cancelled');
  release(); const result = await approving;
  assert.equal(result.body.status, 'cancelled'); assert.equal(result.body.completedCount, 1);
  assert.deepEqual(result.body.steps.map((s) => s.status), ['executed', 'skipped']);
  assert.equal(f.inputs.length, 1);
});

test('agent revocation, pause and cancellation between actions stop the exact remaining sequence', async (t) => {
  for (const operation of ['revoke', 'pause', 'cancel']) {
    await t.test(operation, async (t) => {
      let bot, r;
      const f = await start(t, { afterInput: async (count) => {
        if (count !== 1) return;
        if (operation === 'revoke') f.reach.auth.revoke(bot.clientId);
        else if (operation === 'pause') await f.reach.setPaused(true);
        else assert.equal((await bot.as(`/api/browser/requests/${r.id}`, { method: 'DELETE' })).body.status, 'cancelled');
      } });
      bot = await f.join(); r = await bot.submit(batch());
      const result = await f.decide(r.id, 'approve');
      assert.equal(result.body.completedCount, 1, JSON.stringify(result));
      assert.ok(['revoked', 'cancelled'].includes(result.body.status));
      assert.equal(f.inputs.length, 1);
      assert.equal(result.body.steps[1].status, 'skipped');
    });
  }
});

test('later native failure reports partial delivery and never replays successful inputs', async (t) => {
  let attempts = 0;
  const f = await start(t, { input: async () => { if (++attempts === 2) throw new Error('private native output'); } });
  const bot = await f.join(); const r = await bot.submit(batch([...batch().actions, { type: 'key', key: 'tab' }]));
  const result = await f.decide(r.id, 'approve');
  assert.equal(result.body.status, 'failed'); assert.equal(result.body.completedCount, 1);
  assert.equal(result.body.attemptedCount, 2);
  assert.deepEqual(result.body.steps.map((s) => s.status), ['executed', 'failed', 'skipped']);
  assert.equal((await f.decide(r.id, 'approve')).status, 409); assert.equal(attempts, 2);
  assert.ok(!JSON.stringify(result.body).includes('private native'));
});

test('restricted terminal batch validates every target before review and keeps cwd explicit per step', async (t) => {
  const f = await start(t); fs.mkdirSync(path.join(f.dir, 'shared'));
  fs.mkdirSync(path.join(f.dir, 'shared/sub')); fs.writeFileSync(path.join(f.dir, 'shared/sub/note.txt'), 'scoped output');
  const bot = await f.join({ folders: [{ root: 0, path: 'shared' }], screen: 'off', restrictedTerminal: true });
  const actions = [{ type: 'terminal', root: 0, command: 'cd sub' }, { type: 'terminal', root: 0, cwd: 'sub', command: 'cat note.txt' }];
  const r = await bot.submit(batch(actions));
  assert.equal(r.steps[1].folder, path.join(f.dir, 'shared/sub')); assert.equal(f.captures(), 0);
  const result = await f.decide(r.id, 'approve');
  assert.equal(result.body.status, 'executed', JSON.stringify(result));
  assert.equal(result.body.steps[0].directory, 'sub'); assert.equal(result.body.steps[1].output, 'scoped output');
  const invalid = await bot.as('/api/browser/requests', { method: 'POST', body: batch([actions[0], { type: 'terminal', root: 0, command: 'cat ../../private/clients.json' }]) });
  assert.ok([400, 403].includes(invalid.status));
  assert.deepEqual((await f.call('/api/agents/browser-requests')).body, []);
  assert.deepEqual(f.inputs, []);
});


test('a Mac security dialog appearing between actions blocks the next input', async (t) => {
  let dialog = false;
  const f = await start(t, { macDialogs: () => dialog ? [{ id: 'fixture-security-dialog' }] : [],
    afterInput: async (count) => { if (count === 1) dialog = true; } });
  const bot = await f.join(); const r = await bot.submit(batch());
  const result = await f.decide(r.id, 'approve');
  assert.equal(result.body.status, 'failed');
  assert.equal(result.body.completedCount, 1);
  assert.equal(f.inputs.length, 1);
  assert.match(result.body.error, /only its owner can answer/);
  assert.equal(result.body.steps[1].status, 'skipped');
});
