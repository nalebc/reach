import test from 'node:test';
import assert from 'node:assert/strict';
import { protectBrowserApp, protectedBrowserAppReason, isolatedBrowserReason } from '../server/browser-protected-apps.mjs';
import { createBrowserAppAccess } from '../server/browser-app-access.mjs';

const identity = 'a'.repeat(64);
const protectedApps = [
  { id: '/Applications/Innocent.app', name: 'Innocent', bundleId: 'io.tailscale.ipn.macos' },
  { id: '/Applications/Innocent.app', name: 'Innocent', bundleId: 'COM.TAILSCALE.IPN.MACSYS' },
  { id: '/Applications/Innocent.app', name: 'Innocent', bundleId: 'com.reach.companion' },
  { id: '/Applications/Tailscale.app', name: 'Other', bundleId: 'com.example.App' },
  { id: '/Applications/Reach.app', name: 'Other', bundleId: 'com.example.App' },
  { id: '/Applications/Innocent.app', name: 'Tailscale', bundleId: 'com.example.App' },
  { id: '/Applications/Innocent.app', name: 'Ｒｅａｃｈ', bundleId: 'com.example.App' },
];

function fixture(app, grant = true) {
  const calls = [], clock = 100000;
  const row = { ...app, identity, protected: false };
  const client = { id: 'muse-invite', kind: 'agent', name: 'Muse', expiresAt: clock + 600000,
    scopes: ['browser:read', 'browser:request'], policy: { browser: true, screen: 'apps',
      appAccess: grant ? [{ id: row.id, identity, mode: 'control' }] : [] } };
  const native = {
    async catalog() { return { apps: [{ ...row }] }; },
    async windows() { calls.push('windows'); return { windows: [] }; },
    async capture() { calls.push('capture'); return { jpeg: 'ZmFrZQ==' }; },
    async input() { calls.push('input'); return { done: true }; },
  };
  const manager = createBrowserAppAccess({ native, verifyClient: id => id === client.id ? client : null,
    screenAvailable: () => true, now: () => clock });
  return { row, client, calls, manager, authorize: () => {} };
}

test('Reach and Tailscale remain protected when renamed or the catalog flag is false', () => {
  for (const app of protectedApps) {
    const input = { ...app, protected: false, reason: 'Share me' };
    const result = protectBrowserApp(input);
    assert.equal(result.protected, true);
    assert.match(result.reason, /always protected/);
    assert.equal(input.protected, false);
  }
  const safari = { id: '/System/Applications/Notes.app', name: 'Notes', bundleId: 'com.apple.Notes', protected: false };
  assert.equal(protectedBrowserAppReason(safari), null);
  assert.deepEqual(protectBrowserApp(safari), safari);
  assert.equal(protectBrowserApp({ ...safari, protected: true }).protected, true);
});

test('stored grants cannot share protected apps or produce window targets', async () => {
  for (const app of protectedApps) {
    const f = fixture(app);
    const options = await f.manager.options(f.authorize);
    assert.equal(options[0].protected, true);
    const list = await f.manager.list(f.client, f.authorize);
    assert.equal(list.apps[0].mode, 'hidden');
    assert.equal(list.apps[0].protected, true);
    await assert.rejects(f.manager.windows(f.client, app.id, f.authorize), { status: 403 });
    await assert.rejects(f.manager.capture(f.client, 'forged-window', f.authorize), { status: 409 });
    await assert.rejects(f.manager.input(f.client, 'forged-window', { type: 'click', x: .5, y: .5 }, f.authorize), { status: 403 });
    assert.deepEqual(f.calls, []);
  }
});

test('owner initial choices and agent access requests cannot override protected apps', async () => {
  for (const app of protectedApps) {
    const f = fixture(app, false);
    for (const mode of ['view', 'control']) {
      await assert.rejects(f.manager.validateChoices([{ id: app.id, mode }], f.authorize), { status: 403 });
      await assert.rejects(f.manager.request(f.client, { appId: app.id, mode }, f.authorize), { status: 403 });
    }
    assert.deepEqual(f.manager.listOwner(), []);
    assert.deepEqual(f.calls, []);
  }
});

test('owner approval rechecks protected identity even for an already pending request', async () => {
  const f = fixture({ id: '/Applications/Innocent.app', name: 'Innocent', bundleId: 'com.example.App' }, false);
  const request = await f.manager.request(f.client, { appId: f.row.id, mode: 'view' }, f.authorize);
  // Even a catalog with an incorrectly unchanged signing fingerprint cannot
  // turn a Reach/Tailscale app into an owner-approvable app.
  f.row.bundleId = 'io.tailscale.ipn.macos';
  await assert.rejects(f.manager.decide(request.id, 'approve', f.authorize), { status: 409 });
  const list = await f.manager.list(f.client, f.authorize);
  assert.equal(list.apps[0].protected, true);
  assert.equal(list.apps[0].mode, 'hidden');
  assert.deepEqual(f.calls, []);
});

test('unmanaged browsers cannot use renamed identity, stored grants, or owner approval to bypass isolation',async()=>{
 const browsers=[
  {id:'/Applications/Renamed.app',name:'Renamed',bundleId:'com.apple.Safari'},
  {id:'/Applications/Renamed.app',name:'Renamed',bundleId:'com.google.Chrome.canary'},
  {id:'/Applications/Renamed.app',name:'Renamed',bundleId:'org.mozilla.firefox'},
  {id:'/Applications/Google Chrome.app',name:'Renamed',bundleId:'com.example.Other'},
  {id:'/Applications/Renamed.app',name:'Ｓａｆａｒｉ',bundleId:'com.example.Other'},
 ];
 for(const app of browsers){
  const f=fixture(app);
  assert.equal(protectedBrowserAppReason(app),isolatedBrowserReason);
  const row=(await f.manager.list(f.client,f.authorize)).apps[0];
  assert.equal(row.protected,true);assert.equal(row.mode,'hidden');assert.equal(row.reason,isolatedBrowserReason);
  await assert.rejects(f.manager.validateChoices([{id:app.id,mode:'control'}],f.authorize),{status:403});
  await assert.rejects(f.manager.request(f.client,{appId:app.id,mode:'control'},f.authorize),{status:403});
  await assert.rejects(f.manager.windows(f.client,app.id,f.authorize),{status:403});
  assert.deepEqual(f.calls,[]);
 }
});
