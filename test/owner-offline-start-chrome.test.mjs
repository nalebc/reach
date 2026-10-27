import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import crypto from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { build } from 'esbuild';
import { findChrome, launchChrome, openTab, testCertificate } from './helpers/headless-chrome.mjs';

const binary = findChrome();
test('real Chrome keeps the permanent owner link usable before browser sign-in, after native HTTP is lost', {
  skip: !process.env.CI && !binary && 'Chrome is not installed', timeout: 60000,
}, async t => {
  assert.ok(binary, 'Chrome is required in CI');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-owner-offline-'));
  const host = 'owner.offline.ts.net', origin = `https://${host}`, dist = path.resolve('dist');
  const cert = await testCertificate(dir, host), app = express(), calls = [];
  // A generous limit: this fixture reads files per request (CodeQL js/missing-rate-limiting).
  app.use(rateLimit({ windowMs: 60_000, limit: 10_000, standardHeaders: false, legacyHeaders: false }));
  let browser, tab, offline = false, seed = true, workspace = false;
  const server = https.createServer(cert, (req, res) => {
    calls.push({ path: new URL(req.url, origin).pathname, method: req.method, bearer: !!req.headers.authorization });
    if (offline) return res.destroy();
    app(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const wasm = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const glue = Buffer.from(`
    globalThis.Go = class { importObject={}; run(){ return new Promise(()=>{}); } };
    globalThis.reachTailnet = options => {
      globalThis.fixtureNodeCount = (globalThis.fixtureNodeCount || 0) + 1;
      let events, state='NeedsLogin';
      globalThis.fixtureBrowserRequests=[];
      globalThis.fixtureCompleteSignIn=()=>{
        const hex=value=>Array.from(new TextEncoder().encode(typeof value==='string'?value:JSON.stringify(value)),b=>b.toString(16).padStart(2,'0')).join('');
        const saved={_machinekey:'privkey:'+ '1'.repeat(64),'_current-profile':'profile',_profiles:{fixture:{Key:'profile',NodeID:'browser'}},profile:{Config:{PrivateNodeKey:'privkey:'+ '2'.repeat(64),NodeID:'browser'}}};
        for(const [key,value] of Object.entries(saved)) options.stateStorage.setState(key,hex(value));
        state='Running';events.state(state);
      };
      return {start(cb){events=cb;cb.state(state);},status(){return {self:{state},peers:[]};},
        login(){events.authURL('https://login.tailscale.com/a/fixture');},wake(){},logout(){throw Error('Unexpected logout');},
        fetch(request){
          if(request.headers.some(value=>String(value).toLowerCase()==='authorization')) throw Error('Unapproved browser cannot send credentials');
          const path=new URL(request.url).pathname;
          globalThis.fixtureBrowserRequests.push({path,method:request.method});
          const body=path==='/api/auth/method'?{method:'tailscale',eligible:true}:path==='/api/auth/requests'?{id:'fixture',secret:'pending-secret',expiresAt:Date.now()+60000,verification:'TEST 123'}:{status:'pending'};
          const bytes=new TextEncoder().encode(JSON.stringify(body));let read=false;
          return {abort(){},response:Promise.resolve({status:200,statusText:'OK',headers:[],read:async()=>read?null:(read=true,bytes),cancel(){}})};
        },websocket(){throw Error('Unapproved browser cannot open work sockets');}};
    };
  `);
  const config = { product: 'Reach', origin, home: origin, instance: 'fixture', name: 'Fixture Mac',
    tailnet: { wasm: `reach-tailnet.${hash(wasm).slice(0, 12)}.wasm`, exec: `wasm_exec.${hash(glue).slice(0, 12)}.js` } };
  const bundle = (await build({ stdin: { contents: 'export { watchOwnerEnrollment } from "./src/owner-connection.ts";', resolveDir: process.cwd() },
    bundle: true, write: false, format: 'iife', globalName: 'Fixture', platform: 'browser' })).outputFiles[0].text;
  app.get('/fixture.js', (_req, res) => res.type('js').send(bundle));
  app.get('/reach-start.json', (_req, res) => res.json(config));
  app.post('/api/device/owner-connection', (_req, res) => res.json({ connection: '11111111-1111-4111-8111-111111111111' }));
  app.get('/tailnet/' + config.tailnet.wasm, (_req, res) => res.type('application/wasm').send(wasm));
  app.get('/tailnet/' + config.tailnet.exec, (_req, res) => res.type('js').send(glue));
  app.use((req, res, next) => {
    if (req.path === '/' && seed) return res.type('html').send('<!doctype html><title>Owner setup</title><script src="/fixture.js"></script>');
    if (req.path === '/' || req.path.startsWith('/files/')) return res.sendFile(path.join(dist, workspace ? 'index.html' : 'start.html'));
    next();
  });
  app.use(express.static(dist));
  app.use((_req, res) => res.sendStatus(404));
  browser = await launchChrome(t, { binary, spki: cert.spki,
    args: [`--host-resolver-rules=MAP ${host}:443 127.0.0.1:${server.address().port}`] });
  const version = await browser.send('Browser.getVersion');
  const fresh = async () => {
    if (tab) {
      const target = await tab.send('Target.getTargetInfo');
      await browser.send('Target.closeTarget', { targetId: target.targetInfo.targetId });
    }
    tab = await openTab(browser); await tab.send('Network.enable');
  };
  // Each expression is fixed test code; it's named on this side if it never holds.
  const wait = (expression, timeout = 15000) => tab.evaluate(`new Promise((resolve,reject)=>{const until=Date.now()+${timeout};const check=()=>{if(${expression})return resolve(true);if(Date.now()>until)return reject(Error('Missing state'));setTimeout(check,25)};check()})`)
    .catch(error => { throw Error(`${error.message}: ${expression}`); });
  // Values go to fixed page code as DevTools call arguments, never spliced in.
  const call = async (fn, ...args) => {
    const { result: page } = await tab.send('Runtime.evaluate', { expression: 'globalThis' });
    const { result, exceptionDetails } = await tab.send('Runtime.callFunctionOn', {
      objectId: page.objectId, functionDeclaration: fn, arguments: args.map(value => ({ value })), awaitPromise: true, returnByValue: true });
    if (exceptionDetails) throw Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };
  await fresh(); await tab.navigate(origin + '/');
  const peer = { id: 'fixture', computerId: 'computer', name: 'Mac', platform: process.platform, url: origin, token: 'FIXTURE-NATIVE-ONLY' };
  await call(`function (peer) {
    localStorage.setItem('reach.ways','1');localStorage.setItem('reach.devices',JSON.stringify([peer]));localStorage.setItem('reach.active','fixture');
    globalThis.setupStates=[];globalThis.stopSetup=Fixture.watchOwnerEnrollment(peer,s=>setupStates.push(s));
  }`, peer);
  await wait('setupStates.at(-1)?.state === "signin"');
  await wait('localStorage.getItem("reach.offline-shell.enabled") === "v1"');
  assert.equal(await tab.evaluate('localStorage.getItem("reach.browser.devices")'), null, 'cache readiness does not pretend browser approval is finished');
  const native = await tab.evaluate('localStorage.getItem("reach.devices")');
  const leaks = await tab.evaluate(`(async()=>{for(const name of await caches.keys()){if(!name.startsWith('reach-static-'))continue;const cache=await caches.open(name);for(const key of await cache.keys()){if((await (await cache.match(key)).text()).includes('FIXTURE-NATIVE-ONLY'))return true}}return false})()`);
  assert.equal(leaks, false);
  const posts = calls.filter(call => call.method !== 'GET').length;
  assert.equal(posts, 1, 'owner proof is registered before waiting for browser sign-in');
  await tab.send('Network.clearBrowserCache'); offline = true; seed = false;
  await fresh();
  const address = origin + '/files/example?view=1';
  const navigation = await tab.send('Page.navigate', { url: address });
  assert.equal(navigation.errorText, undefined, 'a genuine new document opens at the unchanged portless URL');
  const signIn = '[...document.querySelectorAll("a")].some(a=>a.href.startsWith("https://login.tailscale.com/"))';
  await wait(signIn);
  assert.equal(await tab.evaluate('location.href'), address);
  assert.equal(await tab.evaluate('localStorage.getItem("reach.devices")'), native);
  assert.equal(await tab.evaluate('localStorage.getItem("reach.offline-shell.enabled")'), 'v1', 'first-time sign-in retains its complete cached startup code');
  assert.equal(await tab.evaluate('localStorage.getItem("reach.browser.devices")'), null);
  assert.equal(calls.filter(call => call.method !== 'GET').length, posts, 'no invitation, command or other action is replayed');
  // Reproduce the reported failure with no snapshot, including cache eviction.
  await tab.evaluate('(async()=>{for(const name of await caches.keys())if(name.startsWith("reach-static-"))await caches.delete(name)})()');
  await fresh();
  const empty = await tab.send('Page.navigate', { url: address });
  assert.equal(empty.errorText, undefined);
  await wait('document.title === "Reconnecting to Reach"');
  assert.equal(await tab.evaluate('location.href'), address);
  assert.match(await tab.evaluate('document.body.textContent'), /retry automatically/);
  offline = false;
  // The retry replaces the document, so poll from outside its execution
  // context instead of losing a page-owned promise during navigation.
  let restored = false;
  for (const until = Date.now() + 18000; Date.now() < until;) {
    try { if (await tab.evaluate(signIn)) { restored = true; break; } }
    catch (error) { if (!/navigated|Cannot find context|Execution context was destroyed/.test(error.message)) throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(restored, 'automatic retry restores the sign-in screen');
  assert.equal(await tab.evaluate('location.href'), address, 'automatic GET retry opens the same link when native HTTP returns');
  // A cold workspace (including old private-port app shells) can have saved
  // native credentials but no live Device. It must still expose sign-in.
  workspace = true;
  const workspaceAddress = origin + '/'; // installed manifest's start_url
  await fresh();
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } });
  await tab.send('Page.navigate', { url: workspaceAddress });
  await wait('!!document.querySelector(".owner-connection-setup[open] a")');
  assert.match(await tab.evaluate('document.body.textContent'), /Connect securely in this browser/);
  assert.doesNotMatch(await tab.evaluate('document.body.textContent'), /Your computer is out of reach/);
  assert.equal(await tab.evaluate('!!document.querySelector(".fleet-mesh")'), false, 'connection setup is not buried under the disconnected fleet panel');
  assert.ok(await tab.evaluate('document.querySelector(".owner-connection-setup a").getBoundingClientRect().bottom < innerHeight'), 'sign-in is visible on a phone viewport');
  if (process.env.REACH_TEST_RECONNECT_SCREENSHOT) {
    const capture = await tab.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.REACH_TEST_RECONNECT_SCREENSHOT, Buffer.from(capture.data, 'base64'));
  }
  assert.equal(await tab.evaluate('location.href'), workspaceAddress);
  assert.equal(calls.filter(call => call.method !== 'GET').length, posts, 'a cold workspace resumes its saved proof without source access');
  // Legacy app-only clients also get the initial browser approval flow inside
  // this workspace, with no native bearer sent through the new browser node.
  await call(`function (peers) { localStorage.setItem('reach.devices', JSON.stringify(peers)); }`, [{ ...peer, token: 'FIXTURE-LEGACY-ONLY' }]);
  await fresh(); await tab.send('Page.navigate', { url: workspaceAddress });
  await wait('!!document.querySelector(".owner-connection-setup[open] a")');
  await tab.evaluate('fixtureCompleteSignIn()');
  await wait('fixtureBrowserRequests.some(request=>request.path==="/api/auth/requests")');
  await wait('document.body.textContent.includes("TEST 123")');
  assert.equal(await tab.evaluate('location.href'), workspaceAddress);
  assert.equal(await tab.evaluate('localStorage.getItem("reach.browser.devices")'), null, 'initial sign-in is not owner approval');
  assert.equal(await tab.evaluate('JSON.parse(localStorage.getItem("reach.devices"))[0].token'), 'FIXTURE-LEGACY-ONLY');
  assert.equal(await tab.evaluate('fixtureBrowserRequests.filter(request=>request.path==="/api/auth/requests").length'), 1, 'one normal approval request, no command replay');
  t.diagnostic(JSON.stringify({ chrome: version.product, host: process.platform,
    actual: 'Production startup bundle, service worker, CacheStorage, portless HTTPS, cold documents, real connection failures, automatic page recovery',
    modeled: 'Tailscale WASM/sign-in, native owner grant and VPN loss; no physical phone or Windows host' }));
});
