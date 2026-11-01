import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { syntheticAppRepair, outcomeTuple } from './helpers/synthetic-app-repair.mjs';
import { outcomeHttp } from './helpers/outcome-http.mjs';
import { findChrome, launchChrome, openTab } from './helpers/headless-chrome.mjs';

// Real Chrome + real owner HTTP routes + actual fixture check subprocesses.
// Provider turns/review/isolation are simulated. The test-only same-origin
// proxy does not certify private transport, cross-port CORS or device behavior.
// No screenshots: only synthetic DOM values are inspected.
test('phone browser repairs a synthetic app, inspects current evidence and recovers an exact acceptance after a lost response', { skip: !findChrome() }, async t => {
  const h = syntheticAppRepair(t, { repair: true }), api = await outcomeHttp(t, h);
  const assets = path.join(h.dir, 'browser'); fs.mkdirSync(assets);
  await build({ stdin: { resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'tsx', contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import WorkflowOutcome from './src/WorkflowOutcome';
import './src/styles.css';
import './src/workflows.css';
const root = createRoot(document.getElementById('root'));
const peer = { id: 'fixture', name: 'Computer', url: location.origin, token: ${JSON.stringify(api.owner.token)}, platform: 'darwin' };
let workflow, refresh = 0;
function render() { root.render(<div className="workflow-sheet"><WorkflowOutcome peer={peer} workflow={workflow} refresh={++refresh} onChanged={w => { workflow = w; render(); }}/></div>); }
window.refreshOutcome = async () => { workflow = await fetch(${JSON.stringify(api.prefix)}, { headers: { Authorization: 'Bearer ' + peer.token } }).then(r => r.json()); render(); };
window.refreshOutcome();
` }, bundle: true, outdir: assets, entryNames: 'entry', format: 'esm', jsx: 'automatic', external: ['/fonts.css'], loader: { '.svg': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const mutations = [], lookups = []; let loseAccept = false;
  const server = http.createServer(async (req, res) => {
    try {
      const route = new URL(req.url, 'http://fixture.test').pathname;
      if (route.startsWith('/api/')) {
        const parts = []; for await (const part of req) parts.push(part);
        const body = Buffer.concat(parts).toString('utf8');
        if (req.method === 'POST') mutations.push({ route, body: JSON.parse(body) });
        if (route.includes('/outcome/operations/')) lookups.push(route);
        const response = await fetch(api.url + req.url, { method: req.method, headers: { Authorization: req.headers.authorization || '', 'Content-Type': 'application/json' }, ...(body ? { body } : {}) });
        const data = await response.text();
        if (route.endsWith('/outcome/accept') && loseAccept && response.status === 200) {
          // The acceptance is durable, but its response body is lost/clipped.
          // Deliver headers to avoid browser-specific automatic HTTP retries.
          loseAccept = false; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{'); return;
        }
        res.writeHead(response.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(data); return;
      }
      if (route === '/favicon.ico') { res.writeHead(204).end(); return; }
      if (route === '/fonts.css') { res.writeHead(200, { 'Content-Type': 'text/css' }).end(''); return; }
      if (route === '/') { res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/entry.css"><div id="root"></div><script type="module" src="/entry.js"></script>'); return; }
      let file;
      if (['/entry.js', '/entry.css'].includes(route)) file = path.join(assets, route.slice(1));
      // Only fixed synthetic assets; never map a request to a host path.
      const fixtureFile = route.replace(/^\/(baseline|candidate)\//, '');
      if (['index.html', 'src/app.mjs', 'src/total.mjs'].includes(fixtureFile)) {
        const directory = route.startsWith('/baseline/') ? h.build : h.candidates.get(h.get().resultDigest)?.directory;
        if (directory) file = path.join(directory, fixtureFile);
      }
      if (!file) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': file.endsWith('.css') ? 'text/css' : file.endsWith('.html') ? 'text/html' : 'text/javascript', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(file));
    } catch { res.writeHead(500).end('Synthetic fixture request failed'); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await launchChrome(t), tab = await openTab(browser), app = await openTab(browser);
  const wait = async (page, expression) => {
    const deadline = Date.now() + 10000;
    while (!(await page.evaluate(expression))) { if (Date.now() > deadline) assert.fail(`Synthetic browser timed out: ${expression}`); await new Promise(r => setTimeout(r, 20)); }
  };
  const button = text => `[...document.querySelectorAll('button')].find(b => b.textContent.includes(${JSON.stringify(text)}))`;
  const touch = async expression => {
    await tab.send('Page.bringToFront');
    const point = await tab.evaluate(`(() => { const e = ${expression}; e.scrollIntoView({block:'center'}); const r = e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await app.navigate(origin + '/baseline/index.html');
  await wait(app, "document.querySelector('output')?.textContent === '-1'");
  await tab.navigate(origin);
  await wait(tab, `!!${button('Prepare checks')}`);
  await touch(button('Prepare checks'));
  await wait(tab, `!!${button('Run approved outcome plan')}`);
  assert.equal(await tab.evaluate("document.body.textContent.includes('TEST ONLY')"), true);
  assert.equal(h.calls.filter(c => c.startsWith('start-')).length, 0);
  await touch(button('Run approved outcome plan'));
  await wait(tab, `!${button('Run approved outcome plan')}`);
  assert.equal(h.workflows.get(h.w.id).state, 'running');
  await h.pump(); await h.finishBuild({ fixed: false });
  assert.equal(h.get().execution.repairsUsed, 1);
  await h.finishBuild(); await h.finishReview();
  await tab.evaluate('window.refreshOutcome()');
  await wait(tab, `!!${button('Accept result revision 2')}`);
  if (await tab.evaluate(`!!${button('Review current revision')}`)) await touch(button('Review current revision'));
  await wait(tab, `!(${button('Accept result')}).disabled`);
  await app.navigate(origin + '/candidate/index.html');
  await wait(app, "document.querySelector('output')?.textContent === '5'");
  const ready = h.get(), original = outcomeTuple(ready);
  assert.equal(ready.acceptance.status, 'not_accepted');
  // A concurrent owner edit lands while the phone still displays older evidence.
  const observation = await api.call('/outcome/observations', h.command('browser-concurrent-observation', { ...original, criterionId: 'appearance', passed: true, note: 'Synthetic total 5 is visible.' }));
  assert.equal(observation.status, 200);
  await touch(button('Accept result'));
  await wait(tab, "document.body.textContent.includes('Review the current revision before trying again.')");
  assert.equal(h.get().acceptance.status, 'not_accepted');
  assert.equal(await tab.evaluate(`(${button('Accept result')}).disabled`), true);
  assert.equal(mutations.filter(m => m.route.endsWith('/outcome/accept')).length, 1);
  await touch(button('Review current revision'));
  await wait(tab, `!(${button('Accept result')}).disabled`);
  loseAccept = true;
  // Two immediate activations exercise the synchronous in-flight guard. The
  // server commits once, then the browser loses that response and reconciles it.
  await tab.evaluate(`(${button('Accept result')}).click(); (${button('Accept result')}).click()`);
  await wait(tab, "document.body.textContent.includes('Accepted revision 2')");
  assert.equal(h.get().acceptance.status, 'accepted');
  const sent = mutations.filter(m => m.route.endsWith('/outcome/accept'));
  assert.equal(sent.length, 2, 'one stale attempt, one recovered acceptance');
  assert.deepEqual(outcomeTuple(sent[0].body), original);
  assert.deepEqual(outcomeTuple(sent[1].body), outcomeTuple(observation.body.outcome));
  assert.equal(h.get().acceptance.decision.requestId, sent[1].body.requestId);
  assert.ok(lookups.some(route => route.endsWith('/' + sent[1].body.requestId)), 'the UI reconciles the durable operation after the unreadable response');
  assert.deepEqual(h.executed.map(v => v.receipt.exitCode), [1, 1, 0]);
  assert.equal(h.calls.filter(c => c.startsWith('start-')).length, 3);
  const expectedConflict = `Failed to load resource: the server responded with a status of 409 (Conflict) ${origin}${api.prefix}/outcome/accept`;
  assert.deepEqual(tab.problems, [expectedConflict], 'only the deliberate stale-decision conflict is logged');
  assert.deepEqual(app.problems, []);
  await browser.close();
});
