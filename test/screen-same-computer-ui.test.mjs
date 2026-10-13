import test from 'node:test';
import assert from 'node:assert/strict';
import { startDom } from './dom/harness.mjs';
import { sameComputer } from '../server/platform.mjs';

// Oct 11: a first Windows user opened Reach's link on the PC itself, and
// Screen showed the PC watching itself. A browser on the computer is told so
// first, and the screen streams only if asked.
test('a browser on the computer itself is told so before any stream; Show anyway streams', async () => {
  const device = {
    id: 'pc', name: 'PC', platform: 'win32', arch: 'x64', release: '10.0', roots: [],
    memory: { total: 1, free: 1 }, uptime: 1, network: { connected: true, peers: [] },
    capabilities: { files: true, terminal: true, apps: true, screen: true, codex: false },
    sameComputer: true,
  };
  const dom = await startDom({ mobile: true, fakes: {
    'src/useRemoteScreen.ts': 'test/dom/fakes/remote-screen.mjs',
    'src/useDesktopInput.ts': 'test/dom/fakes/desktop-input.mjs',
    'src/DesktopSurface.tsx': 'test/dom/fakes/desktop-surface.mjs',
  }, routes: {
    '/api/device': () => device,
    '/api/terminals': () => ({ sessions: [] }),
    '/api/codex': () => ({ sessions: [] }),
    '/api/activity': () => ({ activities: [] }),
    '/api/sessions': () => ({ sessions: [], errors: {} }),
    '/api/sessions/health': () => ({ agents: [] }),
    '/api/screen/displays': () => ({ displays: [] }),
    '/api/screen/control': init => ({ enabled: JSON.parse(init.body || '{}').enabled }),
  }});
  // The page's own copy of the pretend computer (loaded as the page loads it).
  const { computer } = await dom.load('/test/dom/fakes/computer.mjs');
  computer.reset();
  const originalSocket = globalThis.WebSocket;
  globalThis.WebSocket = class { close() {} send() {} };
  let view;
  try {
    localStorage.setItem('reach.devices', JSON.stringify([{ id: 'pc', name: 'PC', url: 'https://reach.test', token: 'fixture', platform: 'win32' }]));
    localStorage.setItem('reach.active', 'pc');
    sessionStorage.setItem('reach.place', JSON.stringify({ peer: 'pc', page: 'screen' }));
    const { default: App } = await dom.load('/src/App.tsx');
    view = await dom.render(dom.React.createElement(App));
    await dom.waitFor(() => dom.document.body.textContent.includes("You're on this computer"));
    assert.match(dom.document.body.textContent, /Open Reach on your phone or another computer to see this screen/);
    assert.equal(dom.document.querySelector('[aria-label="Screen session viewer"]'), null);
    assert.equal(computer.stream, null, 'nothing streams before it is asked');
    [...dom.document.querySelectorAll('button')].find((b) => b.textContent === 'Show anyway').click();
    await dom.waitFor(() => dom.document.querySelector('[aria-label="Screen session viewer"]'));
    assert.ok(computer.stream, 'streams once asked');
    assert.deepEqual(dom.errors, []);
  } finally { await view?.unmount(); globalThis.WebSocket = originalSocket; await dom.close(); }
});

test('the computer itself is recognized by its own Tailscale address, or the loopback with no proxy', () => {
  const req = (forwarded, remoteAddress = '127.0.0.1') => ({
    headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
    socket: { remoteAddress },
  });
  const own = ['100.64.0.10', 'fd7a:115c:a1e0::a'];
  assert.equal(sameComputer(req('100.64.0.10'), own), true, 'through Tailscale Serve, from itself');
  assert.equal(sameComputer(req('100.64.0.11'), own), false, 'through Tailscale Serve, from a phone');
  assert.equal(sameComputer(req('100.64.0.10, 10.0.0.2'), own), true, 'the first forwarded address');
  assert.equal(sameComputer(req('', '127.0.0.1'), own), true, '--local, on this computer');
  assert.equal(sameComputer(req('', '192.168.1.20'), own), false, '--local, from the network');
  assert.equal(sameComputer(req('100.64.0.10'), undefined), false, 'own addresses unknown');
});
