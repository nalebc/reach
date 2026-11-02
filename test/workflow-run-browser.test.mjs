import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { findChrome, launchChrome, openTab } from './helpers/headless-chrome.mjs';
import { scriptString } from './helpers/script-string.mjs';

// Browser layout, touch and keyboard with synthetic run records only. Does not
// start Reach, capture the host screen, or exercise real agents or phones.
const binary = findChrome();
const repo = fileURLToPath(new URL('..', import.meta.url));
test('ordinary workflow run: phone layouts, touch result inspection, keyboard task opening and progress refresh', { skip: !binary }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-workflow-run-ui-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await build({ stdin: { resolveDir: repo, loader: 'tsx', contents: `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorkflowSheet } from './src/Workflows';
import './src/styles.css';
import './src/agent-session.css';
import './src/chat-home.css';
import './src/chat-workspace.css';
import { workflowRunFixture, workflowTaskResultFixture } from './test/helpers/workflow-run-fixture.mjs';
const root = createRoot(document.getElementById('root'));
let workflow = workflowRunFixture(), generation = 0;
window.fetch = async (input, init = {}) => {
 const url = new URL(typeof input === 'string' ? input : input.url, location.href);
 let data;
 if (url.pathname.endsWith('/outcome-capabilities')) data = { executionAvailable: false, reason: 'Synthetic runner unavailable.' };
 else if (url.pathname.endsWith('/result')) {
   const task = url.pathname.includes('/build/') ? 'build' : 'review';
   data = workflowTaskResultFixture(task, Number(url.searchParams.get('attempt') || (task === 'build' ? 1 : 2)));
 } else data = { ...workflow, version: String(workflow.updatedAt) };
 return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
};
window.showRun = state => {
 workflow = workflowRunFixture(state);
 root.render(<WorkflowSheet key={++generation} peer={{ id: 'computer', name: 'Computer', url: location.origin, token: 'fixture', platform: 'darwin' }} id={workflow.id} initial={workflow} logos={{}} onClose={() => window.runClosed = true} onOpenChat={chat => window.openedChat = chat.id}/>);
};
window.finishRun = () => { workflow = workflowRunFixture('done'); workflow.updatedAt++; };
window.showRun('done');
` }, bundle: true, outdir: dir, entryNames: 'entry', format: 'esm', jsx: 'automatic', external: ['/fonts.css'], loader: { '.svg': 'dataurl' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });
  const server = http.createServer((req, res) => {
    if (req.url === '/favicon.ico') return res.writeHead(204).end();
    if (req.url === '/fonts.css') return res.writeHead(200, { 'Content-Type': 'text/css' }).end('');
    if (req.url === '/') return res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/entry.css"><div id="root"></div><script type="module" src="/entry.js"></script>');
    if (!['/entry.js', '/entry.css'].includes(req.url)) return res.writeHead(404).end();
    res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
    res.end(fs.readFileSync(path.join(dir, req.url.slice(1))));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const browser = await launchChrome(t, { binary });
  const tab = await openTab(browser);
  const wait = async expression => {
    const end = Date.now() + 10000;
    while (!(await tab.evaluate(expression))) {
      if (Date.now() > end) assert.fail(`Timed out waiting for synthetic workflow UI: ${expression}`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const findButton = text => `[...document.querySelectorAll('button')].find(b => b.textContent.includes(${scriptString(text)}) || b.getAttribute('aria-label')?.includes(${scriptString(text)}))`;
  await tab.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await wait(`document.body.textContent.includes('final paragraph is retained')`);
  for (const width of [320, 390, 768]) {
    await tab.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await tab.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const layout = await tab.evaluate(`(() => { const sheet = document.querySelector('.workflow-sheet'); return { viewport: innerWidth, page: document.documentElement.scrollWidth, sheet: sheet.getBoundingClientRect().width, content: sheet.scrollWidth }; })()`);
    assert.ok(layout.page <= layout.viewport + 1, `page fits ${width}px`);
    assert.ok(layout.content <= layout.sheet + 1, `run content fits ${width}px`);
  }
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await tab.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const point = await tab.evaluate(`(() => { const b = document.querySelector('button[aria-label^="Task 1:"]'); b.scrollIntoView({ block: 'center' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, radiusX: 1, radiusY: 1, force: 1 }] });
  await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await wait(`document.querySelector('.wf-item.open button.wf-item-main')?.getAttribute('aria-label').startsWith('Task 1:') && document.body.textContent.includes('src/total.mjs')`);
  await tab.evaluate(`document.querySelector('button[aria-label^="Task 2:"]').focus()`);
  await tab.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' });
  await tab.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await wait(`document.querySelector('.wf-item.open button.wf-item-main')?.getAttribute('aria-label').startsWith('Task 2:')`);
  assert.equal(await tab.evaluate('window.workflowInjected === true'), false);
  await tab.evaluate(`window.showRun('running')`);
  await wait(`document.body.textContent.includes('Workflow running') && document.body.textContent.includes('1 of 3 tasks finished')`);
  await tab.evaluate(`window.finishRun(); ${findButton('Refresh workflow')}.click()`);
  await wait(`document.body.textContent.includes('Run completed') && document.body.textContent.includes('3 of 3 tasks finished')`);
  assert.deepEqual(tab.problems, []);
});
