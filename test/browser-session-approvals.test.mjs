import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserApprovals} from '../server/browser-approvals.mjs';
function fixture(){
 let time=1000,runs=0;const owner={id:'phone',kind:'device',scopes:['admin']};
 const client={id:'invite-one',name:'Muse',kind:'agent',expiresAt:100000,scopes:['browser:read','browser:request'],agentRoots:['/shared/Desktop','/shared/Other'],policy:{browser:true,restrictedTerminal:true,terminalApproval:true,scriptApproval:true,screen:'ask'}};
 const clients=new Map([[client.id,client]]),notifications=[];
 const create=()=>createBrowserApprovals({verifyClient:id=>clients.get(id),verifyOwner:id=>id===owner.id?owner:null,now:()=>time,notify:x=>notifications.push(x),execute:async(a,check)=>{check();runs++;return a.type==='terminal-script'?{output:'ok',exitCode:0}:'ok';}});
 const queue=create(),input={type:'terminal-change',command:'touch notes.txt',root:0,reason:'Run this command'};
 const approve=async(decision='approve-session',value=input)=>queue.decide(owner,queue.request(client,value).id,decision,()=>owner);
 return {queue,client,clients,owner,input,approve,create,notifications,get runs(){return runs},advance:n=>time+=n};
}
test('session approval matches the exact command and folder, logs its mode and never grants all commands',async()=>{
 const f=fixture();await f.approve();
 for(let i=0;i<12;i++){const r=await f.queue.runRemembered(f.client,f.input,()=>f.client);assert.equal(r.status,'executed');assert.equal(r.approval,'session');}
 assert.equal(f.runs,13);assert.equal(f.notifications.length,1);
 for(const change of [{command:'touch other.txt'},{root:1},{cwd:'subfolder'}])assert.equal(await f.queue.runRemembered(f.client,{...f.input,...change},()=>f.client),null);
 assert.throws(()=>f.queue.request(f.client,{...f.input,approval:'session'}),{status:400});
});
test('same agent name on a fresh invitation never inherits a previous session approval',async()=>{
 const f=fixture();await f.approve();const next={...f.client,id:'invite-two',policy:{...f.client.policy}};f.clients.set(next.id,next);
 assert.equal(await f.queue.runRemembered(next,f.input,()=>next),null);
 assert.equal(f.queue.request(next,f.input).status,'pending');
 await assert.rejects(f.queue.decide(next,f.queue.request(f.client,{...f.input,command:'touch new.txt'}).id,'approve-session',()=>next),{status:403});
 assert.equal(f.runs,1);
});
test('expiry blocks execution and approval; restart, pause, revoke and grant changes forget prior permissions',async()=>{
 for(const mode of ['expire','pause','revoke','grant','owner','restart']){
  const f=fixture();await f.approve();
  if(mode==='expire') {f.advance(100001);await assert.rejects(f.queue.runRemembered(f.client,f.input,()=>f.client),{status:403});}
  else if(mode==='restart')assert.equal(await f.create().runRemembered(f.client,f.input,()=>f.client),null);
  else{if(mode==='pause')f.queue.cancelPending();if(mode==='revoke')f.queue.cancelClient(f.client.id);if(mode==='grant')f.client.expiresAt+=1000;if(mode==='owner')f.owner.scopes=[];assert.equal(await f.queue.runRemembered(f.client,f.input,()=>f.client),null);}
  assert.equal(f.runs,1,mode);
 }
});
test('Approve once and Deny do not remember permission; screen and batches cannot be remembered',async()=>{
 for(const decision of ['approve','deny']){const f=fixture();await f.approve(decision);assert.equal(await f.queue.runRemembered(f.client,f.input,()=>f.client),null);}
 const f=fixture();await assert.rejects(f.approve('approve-session',{type:'key',key:'enter',reason:'Enter'}),{status:400});
 await assert.rejects(f.approve('approve-session',{type:'batch',actions:[{type:'key',key:'enter'}],reason:'Enter'}),{status:400});
 assert.equal(f.runs,0);
});
test('script session approval keeps the exact script invocation',async()=>{
 const f=fixture(),input={...f.input,type:'terminal-script',command:'node report.js'};await f.approve('approve-session',input);
 assert.equal((await f.queue.runRemembered(f.client,input,()=>f.client)).status,'executed');
 assert.equal(await f.queue.runRemembered(f.client,{...input,command:'node other.js'},()=>f.client),null);
});
