import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserAppAccess } from '../server/browser-app-access.mjs';
import { validAppAccess } from '../server/browser-app-policy.mjs';
import { browserRouteAllowed } from '../server/browser-access.mjs';

function fixture() {
  let clock=100000;const identity='a'.repeat(64), clients=new Map(), calls=[];
  const base={kind:'agent',name:'Muse',expiresAt:clock+600000,scopes:['device','browser:read','browser:request'],policy:{invite:true,browser:true,screen:'apps',roots:[],terminalIds:[],appAccess:[{id:'/Applications/Safari.app',mode:'control',identity}]}};
  const make=(id='one')=>{const c={...structuredClone(base),id};clients.set(id,c);return c;};const client=make();
  const apps=[{id:'/Applications/Safari.app',name:'Safari',identity,protected:false},{id:'/Applications/Notes.app',name:'Notes',identity:'b'.repeat(64),protected:false},{id:'/System/Applications/Utilities/Terminal.app',name:'Terminal',identity:'c'.repeat(64),protected:true}];
  let allowed=true, onCapture, onInput;
  const native={
    async catalog(check){check();return {apps:structuredClone(apps)};},
    async windows(id,check,expected){check();assert.equal(expected,apps.find(a=>a.id===id).identity);return {windows:[{id:1,pid:123,instance:'instance',width:900,height:600,title:'Window'}]};},
    async capture(target,check){await onCapture?.();check();if(apps.find(a=>a.id===target.appId)?.identity!==target.identity)throw Object.assign(Error('signature changed'),{status:403});calls.push(['capture',target.appId]);return {jpeg:Buffer.from('jpeg-fixture').toString('base64')};},
    async input(target,action,check){await onInput?.();check();calls.push(['input',target.appId,action]);return {done:true};},
  };
  const manager=createBrowserAppAccess({native,verifyClient:id=>clients.get(id),screenAvailable:()=>allowed,now:()=>clock});
  const check=()=>{if(!clients.has(client.id))throw Object.assign(Error('revoked'),{status:403});};
  return {manager,client,clients,make,apps,calls,check,advance:(ms)=>clock+=ms,pause:()=>allowed=false,setCapture:f=>onCapture=f,setInput:f=>onInput=f};
}

test('explicit app grants expose only approved window targets, with stable opaque tokens',async()=>{
 const f=fixture();const listed=await f.manager.list(f.client,f.check);
 assert.equal(listed.apps[0].mode,'control');assert.equal(listed.apps[1].mode,'hidden');
 assert.equal(listed.apps[0].identity,undefined);
 await assert.rejects(f.manager.windows(f.client,f.apps[1].id,f.check),{status:403});
 const a=await f.manager.windows(f.client,f.apps[0].id,f.check), b=await f.manager.windows(f.client,f.apps[0].id,f.check);
 assert.equal(a.windows[0].id,b.windows[0].id);assert.notEqual(a.windows[0].id,1);assert.equal(a.windows[0].pid,undefined);
 await f.manager.capture(f.client,a.windows[0].id,f.check);
 await f.manager.input(f.client,a.windows[0].id,{type:'click',x:.5,y:.5},f.check);
 assert.equal(f.calls.length,2);
 await assert.rejects(f.manager.input(f.client,a.windows[0].id,{type:'key',key:'cmd+space'},f.check),{status:400});
 await assert.rejects(f.manager.input(f.client,a.windows[0].id,{type:'click',x:1.1,y:.5},f.check),{status:400});
 await assert.rejects(f.manager.input(f.client,a.windows[0].id,{type:'text',text:'hello\n'},f.check),{status:400});
});

test('view-only cannot receive input, even via forged target or legacy screen paths',async()=>{
 const f=fixture();f.client.policy.appAccess[0].mode='view';
 const {windows}=await f.manager.windows(f.client,f.apps[0].id,f.check);
 await f.manager.capture(f.client,windows[0].id,f.check);
 await assert.rejects(f.manager.input(f.client,windows[0].id,{type:'text',text:'hi'},f.check),{status:403});
 await assert.rejects(f.manager.capture(f.client,'123',f.check),{status:409});
 for(const [m,r] of [['GET','/browser/screen'],['POST','/browser/scroll'],['POST','/agents/browser-requests/foo'],['POST','/apps/open']])assert.equal(browserRouteAllowed(f.client,m,r),false);
 assert.equal(browserRouteAllowed(f.client,'POST','/browser/apps/input'),true);
});

test('additional access needs owner callback and cannot include protected apps',async()=>{
 const f=fixture();await assert.rejects(f.manager.request(f.client,{appId:f.apps[2].id,mode:'control'},f.check),{status:403});
 const r=await f.manager.request(f.client,{appId:f.apps[1].id,mode:'control'},f.check);
 assert.equal(r.action.appName,'Notes');assert.equal(r.status,'pending');assert.equal(r.sessionExpiresAt,f.client.expiresAt);
 assert.equal((await f.manager.request(f.client,{appId:f.apps[1].id,mode:'control'},f.check)).id,r.id);
 await assert.rejects(f.manager.decide(r.id,'approve',()=>{throw Object.assign(Error('not owner'),{status:403});}),{status:403});
 assert.equal((await f.manager.list(f.client,f.check)).apps[1].mode,'hidden');
 await f.manager.decide(r.id,'approve',()=>{});
 assert.equal((await f.manager.list(f.client,f.check)).apps[1].mode,'control');
 await assert.rejects(f.manager.decide(r.id,'approve',()=>{}),{status:409});
 const other=f.make('two');assert.equal((await f.manager.list(other,()=>{})).apps[1].mode,'hidden');
});

test('grants and window tokens cannot transfer between invites; expiry revokes all access',async()=>{
 const f=fixture(),other=f.make('two');const {windows}=await f.manager.windows(f.client,f.apps[0].id,f.check);
 await assert.rejects(f.manager.capture(other,windows[0].id,()=>{}),{status:409});
 const r=await f.manager.request(f.client,{appId:f.apps[1].id,mode:'view'},f.check);
 f.advance(600001);
 await assert.rejects(f.manager.decide(r.id,'approve',()=>{}),{status:409});
 await assert.rejects(f.manager.capture(f.client,windows[0].id,f.check),{status:403});
});

test('policy changes, signature replacement, pause and revoke fail closed mid-operation',async()=>{
 for(const kind of ['revoke','pause','policy']){
  const f=fixture();const {windows}=await f.manager.windows(f.client,f.apps[0].id,f.check);
  f.setCapture(()=>{if(kind==='revoke')f.clients.delete(f.client.id);else if(kind==='pause')f.pause();else f.clients.set(f.client.id,{...f.client,policy:{...f.client.policy,appAccess:[]}});});
  await assert.rejects(f.manager.capture(f.client,windows[0].id,f.check),{status:403});assert.equal(f.calls.length,0);
 }
 const f=fixture();const {windows}=await f.manager.windows(f.client,f.apps[0].id,f.check);
 f.apps[0].identity='d'.repeat(64);
 await assert.rejects(f.manager.capture(f.client,windows[0].id,f.check),{status:403});
 f.advance(10001);assert.equal((await f.manager.list(f.client,f.check)).apps[0].mode,'hidden');
});

test('pending grant cannot change app identity; reset forgets extra grants',async()=>{
 const f=fixture();const r=await f.manager.request(f.client,{appId:f.apps[1].id,mode:'control'},f.check);
 f.apps[1].identity='d'.repeat(64);await assert.rejects(f.manager.decide(r.id,'approve',()=>{}),{status:409});
 f.apps[1].identity='b'.repeat(64);await f.manager.decide(r.id,'approve',()=>{});f.manager.clear();
 assert.equal((await f.manager.list(f.client,f.check)).apps[1].mode,'hidden');
});

test('app policy rejects wildcards, duplicates, traversal and unrecognized modes',()=>{
 for(const value of [null,[{id:'*',mode:'control'}],[{id:'/a/../b.app',mode:'view'}],[{id:'/a.app',mode:'admin'}],[{id:'/a.app',mode:'view',pid:1}],[{id:'/a.app',mode:'view'},{id:'/a.app',mode:'control'}]])assert.equal(validAppAccess(value),false);
 assert.equal(validAppAccess([{id:'/Applications/Safari.app',mode:'view'}]),true);
});
