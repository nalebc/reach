import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBrowserScript, validateBrowserScript, parseBrowserScript, scriptProfile } from '../server/browser-scripts.mjs';
import { runBrowserMutation } from '../server/browser-mutations.mjs';
import { createBrowserOperationCoordinator } from '../server/browser-operation-coordinator.mjs';
const enabled = process.platform === 'darwin' && process.env.REACH_TEST_SCRIPT_SANDBOX === '1';
function fixture(t) {
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'reach-script-test-')), root=fs.realpathSync(base), shared=path.join(root,'shared'); fs.mkdirSync(shared); fs.writeFileSync(path.join(root,'outside.txt'),'private');
 const client={id:path.basename(root),kind:'agent',policy:{browser:true,restrictedTerminal:true,scriptApproval:true},agentRoots:[shared]};
 const resolve=(index,p='')=>{assert.equal(index,0);const full=fs.realpathSync(path.resolve(shared,p));if(full!==shared&&!full.startsWith(shared+'/'))throw Error('outside');return full;};
 const coordinator=createBrowserOperationCoordinator();
 t.after(()=>{coordinator.close();fs.rmSync(root,{recursive:true,force:true});});
 return {root,shared,client,resolve,coordinator,run:(command,options={})=>runBrowserScript({type:'terminal-script',command,root:0},()=>client,{resolve,coordinator,...options})};
}
test('one command parser preserves arguments and rejects shell chaining',()=>{
 assert.deepEqual(parseBrowserScript(`node -e 'console.log("ok")'`),['node','-e','console.log("ok")']);
 for(const s of ['echo a; rm x','echo a | sh','$(id)','node "oops','A=1 node x','node\nx'])assert.throws(()=>parseBrowserScript(s));
});
test('profile denies helpers, network and host IPC',()=>{const p=scriptProfile('/tmp/example',['/tmp/example/private']);assert.match(p,/deny default/);assert.match(p,/deny process-fork/);assert.doesNotMatch(p,/allow network/);});
test('a session queues approved scripts and releases its slot afterwards', {skip:!enabled}, async t=>{
 const f=fixture(t); f.client.id='bounded-script-session';
 const first=f.run(`node -e 'setTimeout(()=>console.log("done"),200)'`);
 const second=f.run('node -e "console.log(1)"');
 assert.equal(f.coordinator.listOwner().filter(operation=>operation.state==='waiting').length,1);
 assert.equal((await first).exitCode,0);
 assert.equal((await second).output.trim(),'1');
 assert.equal((await f.run('node -e "console.log(2)"')).exitCode,0);
});
test('a direct file mutation waits for another agent script holding the same folder', {skip:!enabled}, async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.shared,'target'),'existing');
 const script=f.run(`node -e 'setTimeout(()=>require("fs").writeFileSync("finished","yes"),120)'`);
 const other={...f.client,id:'file-agent',policy:{...f.client.policy,terminalApproval:true}};
 let entered=false;
 const mutation=runBrowserMutation({type:'terminal-change',command:'touch target',root:0},()=>other,{resolve:f.resolve,coordinator:f.coordinator,
  run:async()=>{entered=true;assert.equal(fs.readFileSync(path.join(f.shared,'finished'),'utf8'),'yes');return {ok:true};}});
 assert.equal(entered,false);
 assert.equal(f.coordinator.listOwner().find(operation=>operation.clientId==='file-agent').state,'waiting');
 assert.equal((await script).exitCode,0);assert.match(await mutation,/Touched file/);assert.equal(entered,true);
});
test('a script waits for another agent direct file mutation holding an overlapping grant', {skip:!enabled}, async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.shared,'target'),'existing');
 const nested=path.join(f.shared,'nested');fs.mkdirSync(nested);
 let release,entered;const holding=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
 t.after(()=>release());
 const other={...f.client,id:'file-agent',policy:{...f.client.policy,terminalApproval:true}};
 const mutation=runBrowserMutation({type:'terminal-change',command:'touch target',root:0},()=>other,{resolve:f.resolve,coordinator:f.coordinator,
  run:async()=>{entered();await holding;return {ok:true};}});
 await started;
 const client={...f.client,id:'script-agent',agentRoots:[nested]};
 const script=runBrowserScript({type:'terminal-script',command:'node -e "console.log(7)"',root:0},()=>client,
  {resolve:(_index,p='')=>fs.realpathSync(path.join(nested,p)),coordinator:f.coordinator});
 assert.equal(f.coordinator.listOwner().find(operation=>operation.clientId==='script-agent').state,'waiting');
 release();await mutation;assert.equal((await script).output.trim(),'7');
});
test('protected management commands cannot be approved, including symlink aliases', {skip:process.platform!=='darwin'}, t=>{
 const f=fixture(t);
 const check=command=>validateBrowserScript({type:'terminal-script',command,root:0},()=>f.client,{resolve:f.resolve});
 for(const command of ['tailscale up','tailscaled','reach invite','reach-agent','/Applications/Tailscale.app/Contents/MacOS/Tailscale status','./TAILSCALE status'])
  assert.throws(()=>check(command),/Reach and Tailscale management commands are protected/);
 fs.writeFileSync(path.join(f.shared,'tailscale'),'');
 fs.symlinkSync('tailscale',path.join(f.shared,'renamed'));
 assert.throws(()=>check('./renamed up'),/protected/);
});
test('kernel sandbox permits scripts and denies outside reads/writes, symlinks, network and helpers',{skip:!enabled},async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.shared,'script.js'),`const fs=require('fs');fs.writeFileSync('made.txt','ok');console.log(fs.readFileSync('made.txt','utf8'));`);
 let r=await f.run('node script.js');assert.equal(r.exitCode,0,r.output);assert.match(r.output,/ok/);
 fs.symlinkSync('../outside.txt',path.join(f.shared,'link.txt'));
 for(const code of [`require("fs").readFileSync(${JSON.stringify(path.join(f.root,'outside.txt'))})`,`require("fs").writeFileSync(${JSON.stringify(path.join(f.root,'escape.txt'))},"bad")`,`require("fs").readFileSync("link.txt")`,`require("fs").linkSync(${JSON.stringify(path.join(f.root,'outside.txt'))},"new-link")`,`require("child_process").execFileSync("/usr/bin/touch",["helper.txt"])`]){r=await f.run(`node -e '${code}'`);assert.notEqual(r.exitCode,0,r.output);}
 assert.equal(fs.existsSync(path.join(f.root,'escape.txt')),false);assert.equal(fs.existsSync(path.join(f.shared,'helper.txt')),false);
 r=await f.run(`node -e 'const s=require("net").connect(4317,"127.0.0.1");s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(9));'`);assert.equal(r.exitCode,9,r.output);
 r=await f.run(`/bin/sh -c 'printf safe > shell.txt'`);assert.equal(r.exitCode,0,r.output);assert.equal(fs.readFileSync(path.join(f.shared,'shell.txt'),'utf8'),'safe');
});
test('private paths, environment, hardlinks and revocation remain enforced',{skip:!enabled},async t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.shared,'.reach'));fs.writeFileSync(path.join(f.shared,'.reach','secret'),'private');
 let r=await f.run(`node -e 'console.log(require("fs").readFileSync(".reach/secret","utf8"))'`);assert.notEqual(r.exitCode,0,r.output);
 r=await f.run(`node -e 'console.log(process.env.REACH_TEST_SECRET || "clean")'`);assert.equal(r.output.trim(),'clean');
 // Existing hard links do not stop unrelated commands, but cannot expose outside data.
 fs.linkSync(path.join(f.root,'outside.txt'),path.join(f.shared,'hardlink'));
 r=await f.run('/bin/ls');assert.equal(r.exitCode,0,r.output);assert.match(r.output,/hardlink/);
 r=await f.run('/bin/cat hardlink');assert.notEqual(r.exitCode,0,r.output);assert.ok(!r.output.includes('private'));
 r=await f.run(`node -e 'require("fs").writeFileSync("hardlink","changed")'`);assert.notEqual(r.exitCode,0,r.output);
 r=await f.run(`node -e 'require("fs").appendFileSync("hardlink","more")'`);assert.notEqual(r.exitCode,0,r.output);
 assert.equal(fs.readFileSync(path.join(f.root,'outside.txt'),'utf8'),'private','the file outside is unchanged');
 fs.unlinkSync(path.join(f.shared,'hardlink'));
 let allowed=true;setTimeout(()=>allowed=false,200);await assert.rejects(runBrowserScript({type:'terminal-script',command:`node -e 'setInterval(()=>{},100)'`,root:0},()=>{if(!allowed)throw Error('revoked');return f.client},{resolve:f.resolve}),/revoked/);
 await assert.rejects(f.run('sudo true'),/Administrator/);
});
test('protected descendants cannot be moved outside their exclusion and hardlinks cannot be created',{skip:!enabled},async t=>{
 const f=fixture(t), parent=path.join(f.shared,'parent'), secret=path.join(parent,'protected');
 fs.mkdirSync(parent);fs.writeFileSync(secret,'private fixture');
 let r=await f.run(`node -e 'require("fs").renameSync("parent","moved")'`,{privatePaths:[secret]});
 assert.notEqual(r.exitCode,0,r.output);assert.equal(fs.readFileSync(secret,'utf8'),'private fixture');assert.equal(fs.existsSync(path.join(f.shared,'moved')),false);
 fs.writeFileSync(path.join(f.shared,'normal'),'normal');r=await f.run(`node -e 'require("fs").linkSync("normal","alias")'`);assert.notEqual(r.exitCode,0,r.output);assert.equal(fs.existsSync(path.join(f.shared,'alias')),false);
 for(const name of ['.SSH','.config','.gnupg','.claude']) {
  const folder=path.join(f.shared,name);fs.mkdirSync(folder);fs.writeFileSync(path.join(folder,'secret'),'fixture');
  r=await f.run(`node -e 'require("fs").readFileSync("${name}/secret")'`);assert.notEqual(r.exitCode,0,name+': '+r.output);
 }
});
test('script runtime and protection ancestors receive explicit write denial',()=>{
 const profile=scriptProfile('/tmp/share',['/tmp/share/parent/private'],['/tmp/share/runtime/node']);
 assert.match(profile,/deny file-write\* \(literal "\/tmp\/share\/runtime\/node"\)/);
 assert.match(profile,/deny file-write-unlink file-write-mode[^\n]*"\/tmp\/share\/parent"/);
 assert.match(profile,/deny file-write-unlink file-write-mode[^\n]*"\/tmp\/share\/runtime"/);
 assert.doesNotMatch(profile,/allow file-read\* file-map-executable[^\n]*subpath "\/tmp\/share\/runtime"/);
});
test('scripts cannot select Reach implementation as a shared execution root',{skip:process.platform!=='darwin'},t=>{
 const f=fixture(t), application=fs.realpathSync(new URL('../',import.meta.url));
 f.client.agentRoots=[application];
 assert.throws(()=>validateBrowserScript({type:'terminal-script',command:'node -e 1',root:0},()=>f.client,{resolve:()=>application}),/private application data/);
});

// "ls ~/Documents" went to the owner for approval though it could only fail
// (the sandbox holds): a path out of the shared folder is refused up front,
// "~" read as the owner's home.
test('path arguments outside the shared folder are refused before approval, ~ included',{skip:process.platform!=='darwin'},t=>{
 const f=fixture(t);
 fs.mkdirSync(path.join(f.shared,'src'));
 const check=(command)=>validateBrowserScript({type:'terminal-script',command,root:0},()=>f.client,{resolve:f.resolve});
 for(const command of ['ls ~/Documents','ls ~','ls ~root','ls ..','ls ../outside.txt','ls src/../..','cat /etc/hosts',`ls ${path.join(f.root,'outside.txt')}`,'grep -r x --include=../x ..','node --require=/tmp/x.js app.js'])
  assert.throws(()=>check(command),/Stay inside the selected shared folder/,command);
 for(const command of ['ls','ls .','ls src','ls ./src','ls src/..',`ls ${path.join(f.shared,'src')}`,'grep -n hello src','node -e "console.log(1/2)"'])
  assert.doesNotThrow(()=>check(command),command);
});

test('many hard links in one folder guard that folder against reads and writes',()=>{
 const p=scriptProfile('/tmp/share',[],[],{writes:['(literal "/tmp/share/a")'],special:['(literal "/tmp/share/pipe")']});
 assert.match(p,/\(deny file-read\* file-write\* \(literal "\/tmp\/share\/a"\)\)/);
 assert.match(p,/\(deny file-read\* file-write\* \(literal "\/tmp\/share\/pipe"\)\)/);
});
