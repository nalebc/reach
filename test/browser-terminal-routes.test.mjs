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
        screen: "off",
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


const command = (bot, command, extra = {}) => bot.as('/api/browser/terminal', {method:'POST',body:{command,root:0,cwd:'',...extra}});
const approveChange = (f,id) => f.call(`/api/agents/browser-requests/${id}`, {method:'POST',body:{decision:'approve',reviewedTerminalChange:true}});
function desktop(f) {
  fs.mkdirSync(path.join(f.dir,'Desktop'));
  fs.writeFileSync(path.join(f.dir,'Desktop/notes.txt'),'Only Desktop data');
  fs.writeFileSync(path.join(f.dir,'outside.txt'),'DO NOT READ OUTSIDE');
}
test('Desktop terminal read commands run immediately, log outcomes and cannot escape or invoke a shell',async t=>{
  const f=await start(t); desktop(f);
  const bot=await f.join({folders:[{root:0,path:'Desktop'}],restrictedTerminal:true,screen:'off'});
  const access=await bot.as('/api/browser'); assert.equal(access.body.screen,'off'); assert.equal(access.body.restrictedTerminal,true);
  const read=await command(bot,'cat notes.txt');assert.equal(read.body.status,'executed',JSON.stringify(read.body));assert.equal(read.body.output,'Only Desktop data');
  assert.equal((await f.call('/api/agents/browser-requests')).body.length,0);
  for(const cmd of ['cat ../outside.txt','cat /etc/passwd','sh -c pwd','sudo ls','ls; cat ../outside.txt','cp notes.txt ../escaped.txt','touch changed.txt']) {
    const result=await command(bot,cmd);assert.equal(result.body.status,'blocked',cmd+JSON.stringify(result.body));assert.ok(!JSON.stringify(result.body).includes('DO NOT READ OUTSIDE'));
  }
  assert.equal((await command(bot,'cd ..')).body.status,'failed');
  assert.equal((await command(bot,'pwd',{root:1})).status,403);
  assert.equal((await command(bot,'pwd',{cwd:'..'})).body.status,'failed');
  assert.equal(fs.existsSync(path.join(f.dir,'Desktop/changed.txt')),false);
  const history=await bot.as('/api/browser/terminal/history');assert.equal(history.status,200);assert.ok(history.body.some(r=>r.id===read.body.id&&r.status==='executed'));
  const other=await f.join({folders:[{root:0,path:'Desktop'}],restrictedTerminal:true,screen:'off'});
  assert.deepEqual((await other.as('/api/browser/terminal/history')).body,[]);
  assert.equal((await bot.as('/api/agents/browser-terminal-history')).status,403);
});
test('supported Desktop changes wait for exact owner approval and never enlarge directory scope',async t=>{
  const f=await start(t); desktop(f);
  const bot=await f.join({folders:[{root:0,path:'Desktop'}],restrictedTerminal:true,terminalApproval:true,screen:'off'});
  const missing=await command(bot,'mkdir missing/new');assert.equal(missing.body.status,'failed');assert.ok((await bot.as('/api/browser/terminal/history')).body.some(r=>r.id===missing.body.id));
  const made=await command(bot,'touch draft.txt');assert.equal(made.status,202,JSON.stringify(made.body));assert.equal(made.body.status,'pending');
  assert.equal(fs.existsSync(path.join(f.dir,'Desktop/draft.txt')),false);
  assert.equal((await bot.as(`/api/agents/browser-requests/${made.body.id}`,{method:'POST',body:{decision:'approve',reviewedTerminalChange:true}})).status,403);
  assert.equal((await f.call(`/api/agents/browser-requests/${made.body.id}`,{method:'POST',body:{decision:'approve'}})).status,400);
  const done=await approveChange(f,made.body.id);assert.equal(done.body.status,'executed',JSON.stringify(done.body));assert.equal(fs.existsSync(path.join(f.dir,'Desktop/draft.txt')),true);
  assert.equal((await approveChange(f,made.body.id)).status,409);
  for(const cmd of ['touch ../escaped.txt','rm ../outside.txt','cp notes.txt /tmp/escape','python -c "print(1)"','sudo rm notes.txt'])assert.equal((await command(bot,cmd)).body.status,'blocked',cmd);
  assert.equal(fs.readFileSync(path.join(f.dir,'outside.txt'),'utf8'),'DO NOT READ OUTSIDE');
  assert.equal((await bot.as('/api/browser/terminal/history')).body.find(r=>r.id===made.body.id).status,'executed');
  assert.ok((await f.call('/api/agents/browser-terminal-history')).body.some(r=>r.id===made.body.id));
  const noDirect=await bot.as('/api/browser/requests',{method:'POST',body:{type:'terminal-change',command:'sh -c pwd',root:0,reason:'escape'}});assert.equal(noDirect.status,400);
});
test('terminal change denial and revocation prevent dispatch and log denial',async t=>{
  const f=await start(t);desktop(f);const bot=await f.join({folders:[{root:0,path:'Desktop'}],restrictedTerminal:true,terminalApproval:true,screen:'off'});
  const denied=await command(bot,'rm notes.txt');assert.equal((await f.call(`/api/agents/browser-requests/${denied.body.id}`,{method:'POST',body:{decision:'deny'}})).body.status,'denied');
  assert.equal((await bot.as('/api/browser/terminal/history')).body.find(r=>r.id===denied.body.id).status,'denied');
  const revoked=await command(bot,'rm notes.txt');f.changeClient(bot.clientId,{expiresAt:Date.now()-1});assert.equal((await approveChange(f,revoked.body.id)).status,409);
  assert.equal(fs.readFileSync(path.join(f.dir,'Desktop/notes.txt'),'utf8'),'Only Desktop data');
  assert.equal((await f.call('/api/agents/browser-terminal-history')).body.find(r=>r.id===revoked.body.id).status,'revoked');
});

test('automatic reads do not consume approval capacity and denied terminal batches are durable',async t=>{
  const f=await start(t); desktop(f);
  const bot=await f.join({folders:[{root:0,path:'Desktop'}],restrictedTerminal:true,terminalApproval:true,screen:'off'});
  for(let i=0;i<12;i++) assert.equal((await command(bot,'pwd')).body.status,'executed');
  const change=await command(bot,'touch approved.txt');assert.equal(change.status,202,JSON.stringify(change.body));
  const sequence=await bot.submit({type:'batch',actions:[{type:'terminal',root:0,command:'pwd'},{type:'terminal',root:0,command:'ls'}],reason:'Read folder'});
  await f.call(`/api/agents/browser-requests/${sequence.id}`,{method:'POST',body:{decision:'deny'}});
  const history=(await f.call('/api/agents/browser-terminal-history')).body;
  assert.equal(history.find(r=>r.id===sequence.id+':0').status,'denied');
  assert.equal(history.find(r=>r.id===sequence.id+':1').status,'denied');
});

test('script runs only once after explicit owner review, with immutable command and folder', {skip:process.env.REACH_TEST_SCRIPT_SANDBOX!=='1'}, async t=>{
 const f=await start(t);desktop(f);
 const bot=await f.join({folders:[{root:0,path:'Desktop'}],restrictedTerminal:true,terminalApproval:true,scriptApproval:true,screen:'off'});
 fs.writeFileSync(path.join(f.dir,'Desktop/script.js'),`require('fs').appendFileSync('count.txt','x');console.log('done');`);
 const pending=await command(bot,'node script.js');assert.equal(pending.status,202,JSON.stringify(pending.body));assert.equal(pending.body.action.type,'terminal-script');assert.equal(fs.existsSync(path.join(f.dir,'Desktop/count.txt')),false);
 const route=`/api/agents/browser-requests/${pending.body.id}`;
 assert.equal((await bot.as(route,{method:'POST',body:{decision:'approve',reviewedScript:true}})).status,403);
 for(const body of [{decision:'approve'},{decision:'approve',reviewedTerminalChange:true},{decision:'approve',reviewedScript:true,command:'evil'}]) assert.equal((await f.call(route,{method:'POST',body})).status,400);
 const done=await f.call(route,{method:'POST',body:{decision:'approve',reviewedScript:true}});assert.equal(done.body.status,'executed',JSON.stringify(done.body));assert.equal(done.body.exitCode,0);assert.match(done.body.output,/done/);assert.equal(fs.readFileSync(path.join(f.dir,'Desktop/count.txt'),'utf8'),'x');
 assert.equal((await f.call(route,{method:'POST',body:{decision:'approve',reviewedScript:true}})).status,409);
 const history=(await bot.as('/api/browser/terminal/history')).body.find(x=>x.id===pending.body.id);assert.equal(history.status,'executed');assert.equal(history.exitCode,0);
 const denied=await command(bot,'node script.js');await f.call(`/api/agents/browser-requests/${denied.body.id}`,{method:'POST',body:{decision:'deny'}});assert.equal(fs.readFileSync(path.join(f.dir,'Desktop/count.txt'),'utf8'),'x');
 const failed=await command(bot,`node -e 'process.exit(7)'`);const result=await f.call(`/api/agents/browser-requests/${failed.body.id}`,{method:'POST',body:{decision:'approve',reviewedScript:true}});assert.equal(result.body.status,'failed');assert.equal(result.body.exitCode,7);
 assert.equal(f.captures(),0);assert.equal(f.inputs.length,0);
});

test('owner may remember one exact command for this invitation only; same-name new invitations start pending',async t=>{
 const f=await start(t);desktop(f);const grant={name:'Muse',folders:[{root:0,path:'Desktop'}],restrictedTerminal:true,terminalApproval:true,screen:'off'};
 const bot=await f.join(grant);const first=await command(bot,'touch session.txt');const route=`/api/agents/browser-requests/${first.body.id}`;
 assert.equal((await bot.as(route,{method:'POST',body:{decision:'approve-session',reviewedTerminalChange:true}})).status,403);
 assert.equal((await f.call(route,{method:'POST',body:{decision:'approve-session'}})).status,400);
 assert.equal((await f.call(route,{method:'POST',body:{decision:'approve-session',reviewedTerminalChange:true}})).body.status,'executed');
 const repeated=await command(bot,'touch session.txt');assert.equal(repeated.body.status,'executed',JSON.stringify(repeated.body));assert.equal(repeated.body.approval,'session');
 assert.equal((await bot.as('/api/browser/terminal/history')).body.find(r=>r.id===repeated.body.id).approval,'session');
 const next=await f.join(grant);const nextRequest=await command(next,'touch session.txt');assert.notEqual(nextRequest.body.clientId,first.body.clientId);assert.equal(nextRequest.body.status,'pending');assert.equal((await command(bot,'touch other.txt')).body.status,'pending');
});
