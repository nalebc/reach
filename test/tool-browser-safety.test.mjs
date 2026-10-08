import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nativeToolProcess, createToolBrowserDriver } from '../server/tool-browser-driver.mjs';
import { createAgentDesktop } from '../server/agent-desktop.mjs';
import { ScreenControl } from '../server/screen.mjs';
const marker='SYNTHETIC_PRIVATE_CONTENT_42';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const safe=error=>{assert.ok(error instanceof Error);assert.equal(JSON.stringify({message:error.message,code:error.code}).includes(marker),false);return true;};

test('browser process never forwards stderr or spawn paths and preserves fixed setup guidance', async()=>{
 await assert.rejects(nativeToolProcess(process.execPath,['-e',`process.stderr.write('${marker}');process.exit(1)`],''),e=>safe(e)&&e.code==='browser_changed');
 await assert.rejects(nativeToolProcess(`/no-such-${marker}`,[],''),e=>safe(e)&&e.code==='unavailable');
 await assert.rejects(nativeToolProcess(process.execPath,['-e',`process.stderr.write('Apple Events not authorized ${marker}');process.exit(1)`],''),e=>safe(e)&&e.code==='setup_required'&&e.status===503&&/Automation settings/.test(e.message));
});
test('browser JSON errors and rejected adapters expose only fixed code/message pairs',async()=>{
 for(const code of ['missing','protected',marker]){
  const driver=createToolBrowserDriver({platform:'darwin',process:async()=>JSON.stringify({error:marker,code,uncertain:true})});
  await assert.rejects(driver.transport('Chrome',{op:'info'}),e=>safe(e)&&e.code===(code===marker?'unsupported':code)&&e.uncertain===true);
 }
 const driver=createToolBrowserDriver({platform:'darwin',process:async()=>{throw Object.assign(Error(marker),{code:marker});}});
 await assert.rejects(driver.transport('Chrome',{op:'info'}),e=>safe(e)&&e.code==='uncertain'&&e.uncertain===true);
 const success={url:'https://example.com/',document:'fixture',text:'Requested content stays available'};
 const okay=createToolBrowserDriver({platform:'darwin',process:async()=>JSON.stringify(success)});
 assert.deepEqual(await okay.transport('Chrome',{op:'info'}),success);
});
test('download status failures never forward page fetch exception text',async()=>{
 const driver=createToolBrowserDriver({platform:'darwin',process:async()=>JSON.stringify({state:'failed',failure:marker,length:0})});
 await assert.rejects(driver.page('Chrome',{url:'https://example.com/'},{op:'download_status'}),e=>safe(e)&&e.code==='download_failed');
});
test('already aborted browser process never publishes a caller supplied abort reason',async()=>{
 const stop=new AbortController();stop.abort(Error(marker));
 await assert.rejects(nativeToolProcess(process.execPath,['-e','process.exit(99)'],'',{signal:stop.signal}),e=>safe(e)&&e.code==='cancelled');
});
test('timeout waits for actual inert child exit after TERM is ignored',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'reach-tool-lifecycle-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const pidfile=path.join(dir,'pid');
 const program=`require('node:fs').writeFileSync(${JSON.stringify(pidfile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
 const start=Date.now();
 await assert.rejects(nativeToolProcess(process.execPath,['-e',program],'',{timeoutMs:1000}),e=>e.code==='uncertain'&&e.uncertain===true);
 if(process.platform!=='win32') assert.ok(Date.now()-start>=1250,'POSIX force-kill grace must finish before the promise rejects');
 const pid=Number(fs.readFileSync(pidfile,'utf8'));
 assert.throws(()=>process.kill(pid,0),e=>e.code==='ESRCH');
});
function world({verifiedExit=true}={}){
 const control=new ScreenControl(), ended=deferred(), started=deferred(), work=deferred();
 const client={id:'synthetic-agent',kind:'agent',name:'Synthetic agent',status:'accepted',expiresAt:Date.now()+600000,policy:{browser:true,preset:'full',roots:[]},scopes:['browser:control','browser:open','browser:screen']};
 const helper={stopped:false,...(verifiedExit?{terminated:ended.promise}:{}),stop(){this.stopped=true;},async send(_request,before){before?.();if(this.stopped)throw Error('Stopped guard helper');return {ok:true};}};
 const desktop=createAgentDesktop({screen:true},{available:()=>true,verifyClient:()=>client,phoneControls:()=>!!control.holder()||control.inputStopping(),spawnHelper:async()=>helper});
 control.onAcquire=()=>{const barrier=desktop.yieldForOwner();if(barrier)control.retireInput(barrier);};
 const run=desktop.withBrowser(client,'/Applications/Google Chrome.app',()=>client,async guard=>{started.resolve();await work.promise;await guard();return {applied:true};}).catch(e=>e);
 return {control,ended,started,work,run,helper,desktop,close(){desktop.close();control.clear();ended.resolve();work.resolve();}};
}
for(const failure of [false,true])test(`phone takeover waits for entire separate browser operation (${failure?'failure':'success'})`,async t=>{
 const w=world();t.after(()=>w.close());await w.started.promise;
 w.control.acquire({id:'owner',kind:'device',scopes:['admin']},true);
 assert.equal(w.helper.stopped,true);assert.equal(w.control.inputStopping(),true);
 let phoneReady=false;const ready=w.control.waitForInputStop().then(()=>{phoneReady=true;});
 w.ended.resolve();await new Promise(r=>setImmediate(r));
 assert.equal(phoneReady,false,'guard helper exit must not release a separate browser command');
 assert.equal(w.desktop.automationBusy(),true);
 if(failure)w.work.reject(Error('Synthetic driver failure'));else w.work.resolve();
 const outcome=await w.run;assert.ok(outcome instanceof Error,'no later action can run after takeover');
 await ready;assert.equal(phoneReady,true);assert.equal(w.control.inputStopping(),false);
});
test('unverified guard-helper exit keeps phone retirement fail closed even when browser work ends',async t=>{
 const w=world({verifiedExit:false});t.after(()=>w.close());await w.started.promise;
 w.control.acquire({id:'owner',kind:'device',scopes:['admin']},true);
 w.work.resolve();await w.run;
 await assert.rejects(w.control.waitForInputStop(),/termination could not be verified/);
 assert.equal(w.control.inputStopping(),true);
});

test('separate browser failure cannot release phone input before guard helper actually exits',async t=>{
 const w=world();t.after(()=>w.close());await w.started.promise;
 w.control.acquire({id:'owner',kind:'device',scopes:['admin']},true);
 let ready=false;const stopped=w.control.waitForInputStop().then(()=>{ready=true;});
 w.work.reject(Error('Synthetic browser transport failure'));
 await new Promise(r=>setImmediate(r));
 assert.equal(ready,false);assert.equal(w.control.inputStopping(),true);
 w.ended.resolve();await w.run;await stopped;
 assert.equal(ready,true);assert.equal(w.control.inputStopping(),false);
});
