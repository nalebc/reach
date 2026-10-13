import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createVoice} from '../server/agent-sessions/voice.mjs';
import {createReach} from '../server/index.mjs';
import {ALL_SCOPES} from '../server/core.mjs';
const marker='SYNTHETIC_PRIVATE_TRANSCRIPTION_DIAGNOSTIC_42';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const bytes=Buffer.from('RIFF\0\0\0\0WAVEsynthetic fixture bytes','latin1');

test('voice diagnostics never echo helper stderr, exception messages or local paths',async()=>{
 for(const error of [Object.assign(Error(marker),{stderr:marker}),Object.assign(Error(marker),{stderr:marker,killed:true})]){
  const voice=createVoice({platform:'darwin',binary:async()=>'/inert/helper',exec:async()=>{throw error;}});
  const result=await voice.transcribe('/inert/recording');
  assert.equal(JSON.stringify(result).includes(marker),false);
  assert.match(result.problem,error.killed?/too long/:/couldn't transcribe/);
 }
 const okay=createVoice({platform:'darwin',binary:async()=>'/inert/helper',exec:async()=>({stdout:JSON.stringify({text:marker})})});
 assert.deepEqual(await okay.transcribe('/inert/recording'),{text:marker},'actual requested transcription text remains available');
});

test('revocation during voice helper preparation prevents native dispatch',async()=>{
 const entered=deferred(),finish=deferred();let active=true,runs=0;
 const voice=createVoice({platform:'darwin',binary:async()=>{entered.resolve();await finish.promise;return '/inert/helper';},exec:async()=>{runs++;return {stdout:'{"text":"fixture"}'};}});
 const result=voice.transcribe('/inert/recording',{authorize:()=>{if(!active)throw Object.assign(Error('Access revoked'),{status:401});}});
 await entered.promise;active=false;finish.resolve();
 await assert.rejects(result,e=>e.status===401);assert.equal(runs,0);
});

test('voice instances share a cap before preparation and release it on success, failure and revocation',async()=>{
 const prepared=deferred(),finished=deferred();let builds=0,runs=0;
 const make=()=>createVoice({platform:'darwin',binary:async()=>{builds++;await prepared.promise;return '/inert/helper';},exec:async()=>{runs++;await finished.promise;return {stdout:'{"text":"fixture"}'};}});
 const first=make().transcribe('/inert/one'),second=make().transcribe('/inert/two');
 const third=make().transcribe('/inert/three').then(value=>({value}),error=>({error}));
 try {
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(builds,2,'one shared budget applies across instances before helper preparation');
  assert.equal((await third).error?.status,429);assert.equal(runs,0);
 } finally {
  prepared.resolve();finished.resolve();await Promise.allSettled([first,second,third]);
 }
 assert.equal(runs,2);
 for(const failure of ['prepare','native','revoked']) {
  let allowed=true;
  const voice=createVoice({platform:'darwin',binary:async()=>{if(failure==='prepare')throw Error('prepare failed');if(failure==='revoked')allowed=false;return '/inert/helper';},exec:async()=>{throw Error('native failed');}});
  const result=voice.transcribe('/inert/memo',{authorize:()=>{if(!allowed)throw Object.assign(Error('revoked'),{status:401});}});
  if(failure==='revoked')await assert.rejects(result,error=>error.status===401);else assert.ok((await result).problem);
 }
 assert.deepEqual(await make().transcribe('/inert/again'),{text:'fixture'},'every completion path releases its reservation');
});

async function fixture(t,transcribe){
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'reach-voice-boundary-'))),dataDir=path.join(root,'private');
 const reach=await createReach({roots:[root],dataDir,screen:false,agentDesktop:null,
  desktopTerminals:{platform:'linux',run:async()=>assert.fail('No terminal input')},
  browserCapture:async()=>assert.fail('No screen capture'),browserInput:async()=>assert.fail('No input'),
  voiceFactory:()=>({transcribe})});
 t.after(async()=>{await reach.close();await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 await new Promise(r=>reach.server.listen(0,'127.0.0.1',r));
 const owner=reach.auth.issue('Synthetic owner',ALL_SCOPES,'device');
 const upload=async(content=bytes,token=owner.token)=>{
  const data=new FormData();data.set('file',new Blob([content],{type:'audio/wav'}),'memo.wav');
  const res=await fetch(`http://127.0.0.1:${reach.server.address().port}/api/sessions/voice`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:data});
  return {status:res.status,body:await res.json()};
 };
 return {reach,owner,upload,files:path.join(dataDir,'agent-files')};
}
for(const kind of ['fallback','text'])test(`voice ${kind} completion after revocation cannot publish text or register an attachment`,async t=>{
 const entered=deferred(),finish=deferred();let captured;
 const f=await fixture(t,async(file,options)=>{captured={file,options};entered.resolve();await finish.promise;return kind==='fallback'?{problem:'Synthetic unavailable'}:{text:'Synthetic private transcription'};});
 const pending=f.upload();await entered.promise;
 assert.ok(await fs.stat(captured.file));f.reach.auth.revoke(f.owner.clientId);finish.resolve();
 const result=await pending;
 assert.equal(result.status,401,JSON.stringify(result.body));
 assert.equal(result.body.text,undefined);assert.equal(result.body.file,undefined);
 assert.deepEqual(await fs.readdir(f.files),[],'the exact request temporary file is cleaned, with no registered directory');
});

test('authorized voice results preserve requested text or exact recording fallback, and reject invalid audio',async t=>{
 let mode='text',calls=0;
 const f=await fixture(t,async(_file,{authorize})=>{calls++;authorize();return mode==='text'?{text:'Synthetic transcript'}:{problem:'Voice is unavailable on this computer.'};});
 assert.deepEqual(await f.upload(),{status:200,body:{text:'Synthetic transcript'}});
 assert.deepEqual(await fs.readdir(f.files),[]);
 mode='fallback';const fallback=await f.upload();assert.equal(fallback.status,200);
 assert.match(fallback.body.file.name,/^voice-memo-.*\.wav$/);
 assert.deepEqual(await fs.readFile(path.join(f.files,fallback.body.file.id)),bytes);
 const saved=await fs.readdir(f.files);assert.equal(saved.length,1);
 assert.equal((await f.upload(Buffer.from('not audio'))).status,400);
 assert.deepEqual(await fs.readdir(f.files),saved);assert.equal(calls,2);
 const limited=f.reach.auth.issue('Synthetic service',ALL_SCOPES,'service');
 assert.equal((await f.upload(bytes,limited.token)).status,403);assert.equal(calls,2);
});
