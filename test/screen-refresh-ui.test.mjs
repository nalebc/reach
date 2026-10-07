import test from 'node:test';
import assert from 'node:assert/strict';
import { startDom, settle } from './dom/harness.mjs';

// The status endpoint and the live video are independent connections. A
// temporary failure of the former must not destroy a healthy screen session.
test('status refresh failures preserve the screen and fullscreen; revoked access still closes it', async () => {
  const device = {
    id: 'mac', name: 'Mac', platform: 'darwin', arch: 'arm64', release: '25.0', roots: [],
    memory: { total: 1, free: 1 }, uptime: 1, network: { connected: true, peers: [] },
    capabilities: { files: true, terminal: true, apps: true, screen: true, codex: false },
  };
  let failure = 0;
  const dom = await startDom({ mobile: true, fakes: {
    'src/useRemoteScreen.ts': 'test/dom/fakes/remote-screen.mjs',
    'src/useDesktopInput.ts': 'test/dom/fakes/desktop-input.mjs',
    'src/DesktopSurface.tsx': 'test/dom/fakes/desktop-surface.mjs',
  }, routes: {
    '/api/device': () => failure ? Response.json({ error: failure === 403 ? 'Access revoked' : 'Temporary status failure' }, { status: failure }) : device,
    '/api/terminals': () => ({ sessions: [] }),
    '/api/codex': () => ({ sessions: [] }),
    '/api/activity': () => ({ activities: [] }),
    '/api/sessions': () => ({ sessions: [], errors: {} }),
    '/api/sessions/health': () => ({ agents: [] }),
    '/api/screen/displays': () => ({ displays: [] }),
    '/api/screen/control': init => ({ enabled: JSON.parse(init.body || '{}').enabled }),
  }});
  const originalSocket = globalThis.WebSocket;
  // Presence is irrelevant here; no test connection may leave this harness.
  globalThis.WebSocket = class { close() {} send() {} };
  let view;
  try {
    localStorage.setItem('reach.devices', JSON.stringify([{ id: 'mac', name: 'Mac', url: 'https://reach.test', token: 'fixture', platform: 'darwin' }]));
    localStorage.setItem('reach.active', 'mac');
    sessionStorage.setItem('reach.place', JSON.stringify({ peer: 'mac', page: 'screen' }));
    const { default: App } = await dom.load('/src/App.tsx');
    view = await dom.render(dom.React.createElement(App));
    const screen = await dom.waitFor(() => dom.document.querySelector('[aria-label="Screen session viewer"]'));
    screen.querySelector('[aria-label="Enter fullscreen"]').click();
    await dom.waitFor(() => screen.classList.contains('screen-immersive'));
    failure = 503;
    dom.document.querySelector('[title="Refresh connection"]').click();
    await dom.waitFor(() => dom.document.querySelector('.topbar-status')?.textContent.includes('Reconnecting'));
    assert.equal(dom.document.querySelector('[aria-label="Screen session viewer"]'), screen);
    assert.ok(screen.classList.contains('screen-immersive'));
    failure = 0;
    dom.document.querySelector('[title="Refresh connection"]').click();
    await dom.waitFor(() => dom.document.querySelector('.topbar-status')?.textContent.includes('Computer connected'));
    assert.equal(dom.document.querySelector('[aria-label="Screen session viewer"]'), screen);
    failure = 403;
    dom.document.querySelector('[title="Refresh connection"]').click();
    await dom.waitFor(() => !dom.document.querySelector('[aria-label="Screen session viewer"]'));
    assert.match(dom.document.body.textContent, /Access revoked/);
    assert.deepEqual(dom.errors, []);
  } finally { await view?.unmount(); globalThis.WebSocket = originalSocket; await dom.close(); }
});
