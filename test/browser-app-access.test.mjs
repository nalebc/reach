import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserAppAccess } from '../server/browser-app-access.mjs';
import { validAppAccess } from '../server/browser-app-policy.mjs';
import { browserRouteAllowed } from '../server/browser-access.mjs';

function fixture({persistRestriction, notify} = {}) {
  let clock=100000;const identity='a'.repeat(64), clients=new Map(), calls=[];
  const base={kind:'agent',name:'Muse',expiresAt:clock+600000,scopes:['device','browser:read','browser:request'],policy:{invite:true,browser:true,screen:'apps',roots:[],terminalIds:[],appAccess:[{id:'/System/Applications/Notes.app',mode:'control',identity}]}};
  const make=(id='one')=>{const c={...structuredClone(base),id};clients.set(id,c);return c;};const client=make();
  const apps=[{id:'/System/Applications/Notes.app',name:'Notes',identity,protected:false},{id:'/Applications/Notes.app',name:'Notes',identity:'b'.repeat(64),protected:false},{id:'/System/Applications/Utilities/Terminal.app',name:'Terminal',identity:'c'.repeat(64),protected:true}];
  let allowed=true, onCapture, onInput;
  const native={
    async catalog(check){check();return {apps:structuredClone(apps)};},
    async windows(id,check,expected){check();assert.equal(expected,apps.find(a=>a.id===id).identity);return {windows:[{id:1,pid:123,instance:'instance',width:900,height:600,title:'Window'}]};},
    async capture(target,check,signal){await onCapture?.({target,check,signal});check();if(apps.find(a=>a.id===target.appId)?.identity!==target.identity)throw Object.assign(Error('signature changed'),{status:403});calls.push(['capture',target.appId]);return {jpeg:Buffer.from('jpeg-fixture').toString('base64')};},
    async input(target,action,check,signal){await onInput?.({target,action,check,signal});check();calls.push(['input',target.appId,action]);return {done:true};},
  };
  const manager=createBrowserAppAccess({native,verifyClient:id=>clients.get(id),screenAvailable:()=>allowed,persistRestriction,notify,now:()=>clock});
  const check=()=>{if(!clients.has(client.id))throw Object.assign(Error('revoked'),{status:403});};
  return {manager,client,clients,make,apps,calls,check,advance:(ms)=>clock+=ms,pause:()=>allowed=false,setCapture:f=>onCapture=f,setInput:f=>onInput=f};
}

test('explicit app grants expose only approved window targets, with stable opaque tokens',async()=>{
 const f=fixture();const listed=await f.manager.list(f.client,f.check);
 assert.equal(listed.apps[0].mode,'view');assert.equal(listed.apps[1].mode,'hidden');
 assert.equal(listed.apps[0].identity,undefined);
 await assert.rejects(f.manager.windows(f.client,f.apps[1].id,f.check),{status:403});
 const a=await f.manager.windows(f.client,f.apps[0].id,f.check), b=await f.manager.windows(f.client,f.apps[0].id,f.check);
 assert.equal(a.windows[0].id,b.windows[0].id);assert.notEqual(a.windows[0].id,1);assert.equal(a.windows[0].pid,undefined);
 await f.manager.capture(f.client,a.windows[0].id,f.check);
 await assert.rejects(f.manager.input(f.client,a.windows[0].id,{type:'click',x:.5,y:.5},f.check),{status:403});
 assert.equal(f.calls.length,1);
 await assert.rejects(f.manager.input(f.client,a.windows[0].id,{type:'key',key:'cmd+space'},f.check),{status:403});
 await assert.rejects(f.manager.input(f.client,a.windows[0].id,{type:'click',x:1.1,y:.5},f.check),{status:403});
 await assert.rejects(f.manager.input(f.client,a.windows[0].id,{type:'text',text:'hello\n'},f.check),{status:403});
});

test('view-only cannot receive input, even via forged target or legacy screen paths',async()=>{
 const f=fixture();f.client.policy.appAccess[0].mode='view';
 const {windows}=await f.manager.windows(f.client,f.apps[0].id,f.check);
 await f.manager.capture(f.client,windows[0].id,f.check);
 await assert.rejects(f.manager.input(f.client,windows[0].id,{type:'text',text:'hi'},f.check),{status:403});
 await assert.rejects(f.manager.capture(f.client,'123',f.check),{status:409});
 for(const [m,r] of [['GET','/browser/screen'],['POST','/browser/scroll'],['POST','/agents/browser-requests/foo'],['POST','/apps/open']])assert.equal(browserRouteAllowed(f.client,m,r),false);
 assert.equal(browserRouteAllowed(f.client,'POST','/browser/apps/input'),false);
});

test('additional access needs owner callback and cannot include protected apps',async()=>{
 const f=fixture();await assert.rejects(f.manager.request(f.client,{appId:f.apps[2].id,mode:'control'},f.check),{status:403});
 const r=await f.manager.request(f.client,{appId:f.apps[1].id,mode:'view'},f.check);
 assert.equal(r.action.appName,'Notes');assert.equal(r.status,'pending');assert.equal(r.sessionExpiresAt,f.client.expiresAt);
 assert.equal((await f.manager.request(f.client,{appId:f.apps[1].id,mode:'view'},f.check)).id,r.id);
 await assert.rejects(f.manager.decide(r.id,'approve',()=>{throw Object.assign(Error('not owner'),{status:403});}),{status:403});
 assert.equal((await f.manager.list(f.client,f.check)).apps[1].mode,'hidden');
 await f.manager.decide(r.id,'approve',()=>{});
 assert.equal((await f.manager.list(f.client,f.check)).apps[1].mode,'view');
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
 const f=fixture();const r=await f.manager.request(f.client,{appId:f.apps[1].id,mode:'view'},f.check);
 f.apps[1].identity='d'.repeat(64);await assert.rejects(f.manager.decide(r.id,'approve',()=>{}),{status:409});
 f.apps[1].identity='b'.repeat(64);await f.manager.decide(r.id,'approve',()=>{});f.manager.clear();
 assert.equal((await f.manager.list(f.client,f.check)).apps[1].mode,'hidden');
});

test('app policy rejects wildcards, duplicates, traversal and unrecognized modes',()=>{
 for(const value of [null,[{id:'*',mode:'control'}],[{id:'/a/../b.app',mode:'view'}],[{id:'/a.app',mode:'admin'}],[{id:'/a.app',mode:'view',pid:1}],[{id:'/a.app',mode:'view'},{id:'/a.app',mode:'control'}]])assert.equal(validAppAccess(value),false);
 assert.equal(validAppAccess([{id:'/System/Applications/Notes.app',mode:'view'}]),true);
});

const deferred = () => {
 let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};
};

test('stopping one app session aborts only its captures, targets and pending requests',async()=>{
 const f=fixture(),other=f.make('two'),started=deferred();
 const first=await f.manager.windows(f.client,f.apps[0].id,f.check),second=await f.manager.windows(other,f.apps[0].id,()=>{});
 const ownRequest=await f.manager.request(f.client,{appId:f.apps[1].id,mode:'view'},f.check);
 const otherRequest=await f.manager.request(other,{appId:f.apps[1].id,mode:'view'},()=>{});
 f.setCapture(({signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(Object.assign(Error('revoked'),{status:403})),{once:true});started.resolve();}));
 const capture=f.manager.capture(f.client,first.windows[0].id,f.check),rejected=assert.rejects(capture,{status:403});
 await started.promise;f.clients.delete(f.client.id);f.manager.cancelClient(f.client.id);await rejected;
 assert.ok(!f.manager.listOwner().some(r=>r.id===ownRequest.id));
 assert.equal(f.manager.listOwner().find(r=>r.id===otherRequest.id).status,'pending');
 f.setCapture(null);await f.manager.capture(other,second.windows[0].id,()=>{});
 assert.deepEqual(f.calls,[['capture',f.apps[0].id]]);
});

test('revocation aborts native capture immediately and expires window tokens during native work',async()=>{
 const f=fixture(), started=deferred();
 const {windows}=await f.manager.windows(f.client,f.apps[0].id,f.check);
 f.setCapture(({signal})=>new Promise((resolve,reject)=>{
  signal.addEventListener('abort',()=>reject(Object.assign(Error('revoked'),{status:403})),{once:true});started.resolve();
 }));
 const pending=f.manager.capture(f.client,windows[0].id,f.check);
 const rejection=assert.rejects(pending,{status:403});
 await started.promise;f.manager.clear();await rejection;
 assert.deepEqual(f.calls,[]);
 const fresh=await f.manager.windows(f.client,f.apps[0].id,f.check);
 f.setCapture(()=>f.advance(60001));
 await assert.rejects(f.manager.capture(f.client,fresh.windows[0].id,f.check),{status:403});
 assert.deepEqual(f.calls,[]);
});

test('changing app permissions aborts existing work before persistence and blocks concurrent access',async()=>{
 const persistence=deferred(), persistenceStarted=deferred(), inputStarted=deferred();
 const f=fixture({persistRestriction:async()=>{persistenceStarted.resolve();await persistence.promise;f.client.policy.appAccess=[];}});
 const {windows}=await f.manager.windows(f.client,f.apps[0].id,f.check);
 f.setCapture(({signal})=>new Promise((resolve,reject)=>{
  signal.addEventListener('abort',()=>reject(Object.assign(Error('restricted'),{status:403})),{once:true});inputStarted.resolve();
 }));
 const running=f.manager.capture(f.client,windows[0].id,f.check);
 const rejection=assert.rejects(running,{status:403});await inputStarted.promise;
 const changing=f.manager.restrict(f.client.id,{appId:f.apps[0].id,mode:'hidden'},f.check);
 await rejection;await persistenceStarted.promise;
 await assert.rejects(f.manager.windows(f.client,f.apps[0].id,f.check),{status:409});
 await assert.rejects(f.manager.capture(f.client,windows[0].id,f.check),{status:409});
 persistence.resolve();await changing;
 assert.equal((await f.manager.list(f.client,f.check)).apps[0].mode,'hidden');
 assert.deepEqual(f.calls,[]);
});

test('old control grants, concurrent invites and new requests cannot re-enable host input',async()=>{
 const f=fixture(),other=f.make('two');
 const a=await f.manager.windows(f.client,f.apps[0].id,f.check),b=await f.manager.windows(other,f.apps[0].id,()=>{});
 assert.equal((await f.manager.list(f.client,f.check)).apps[0].mode,'view');
 assert.equal((await f.manager.list(f.client,f.check)).controlAvailable,false);
 for(const [client,id,check] of [[f.client,a.windows[0].id,f.check],[other,b.windows[0].id,()=>{}]]){
  await assert.rejects(f.manager.input(client,id,{type:'text',text:'blocked'},check),{status:403});
  await assert.rejects(f.manager.request(client,{appId:f.apps[0].id,mode:'control'},check),{status:403});
 }
 await assert.rejects(f.manager.validateChoices([{id:f.apps[0].id,mode:'control'}],f.check),{status:403});
 assert.deepEqual(f.calls,[]);
});

test('non-finite invitation deadlines fail closed',async()=>{
 for(const expiresAt of [undefined,NaN,Infinity]){
  const f=fixture();f.client.expiresAt=expiresAt;
  await assert.rejects(f.manager.list(f.client,f.check),{status:403});
 }
});

test('invalid permission reduction does not retire other app targets or consume pending approvals',async()=>{
 const f=fixture();
 const {windows}=await f.manager.windows(f.client,f.apps[0].id,f.check);
 const request=await f.manager.request(f.client,{appId:f.apps[0].id,mode:'view'},f.check);
 await assert.rejects(f.manager.restrict(f.client.id,{appId:f.apps[1].id,mode:'view'},f.check),{status:403});
 await f.manager.capture(f.client,windows[0].id,f.check);
 assert.equal(f.manager.listOwner().find(item=>item.id===request.id).status,'pending');
});


test('app access notification opens its pending request without sharing the private reason', async () => {
 const sent=[]; const f=fixture({notify:async message=>sent.push(message)});
 const request=await f.manager.request(f.client,{appId:f.apps[1].id,mode:'view',reason:'private document 123456'},f.check);
 assert.equal(sent.length,1);
 assert.equal(sent[0].title,'Notes · Access request');
 assert.equal(new URL(sent[0].url,'https://reach.test').searchParams.get('needs'),`browser:${request.id}`);
 assert.doesNotMatch(JSON.stringify(sent[0]),/123456/);
});
