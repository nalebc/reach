import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBrowserScript, parseBrowserScript, scriptProfile } from '../server/browser-scripts.mjs';
const enabled = process.platform === 'darwin' && process.env.REACH_TEST_SCRIPT_SANDBOX === '1';
function fixture(t) {
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'reach-script-test-')), root=fs.realpathSync(base), shared=path.join(root,'shared'); fs.mkdirSync(shared); fs.writeFileSync(path.join(root,'outside.txt'),'private');
 const client={kind:'agent',policy:{browser:true,restrictedTerminal:true,scriptApproval:true},agentRoots:[shared]};
 const resolve=(index,p='')=>{assert.equal(index,0);const full=fs.realpathSync(path.resolve(shared,p));if(full!==shared&&!full.startsWith(shared+'/'))throw Error('outside');return full;};
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,shared,client,resolve,run:(command,options={})=>runBrowserScript({type:'terminal-script',command,root:0},()=>client,{resolve,...options})};
}
test('one command parser preserves arguments and rejects shell chaining',()=>{
 assert.deepEqual(parseBrowserScript(`node -e 'console.log("ok")'`),['node','-e','console.log("ok")']);
 for(const s of ['echo a; rm x','echo a | sh','$(id)','node "oops','A=1 node x','node\nx'])assert.throws(()=>parseBrowserScript(s));
});
test('profile denies helpers, network and host IPC',()=>{const p=scriptProfile('/tmp/example',['/tmp/example/private']);assert.match(p,/deny default/);assert.match(p,/deny process-fork/);assert.doesNotMatch(p,/allow network/);});
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
 fs.linkSync(path.join(f.root,'outside.txt'),path.join(f.shared,'hardlink'));await assert.rejects(f.run('node script.js'),/hard links/);fs.unlinkSync(path.join(f.shared,'hardlink'));
 let allowed=true;setTimeout(()=>allowed=false,200);await assert.rejects(runBrowserScript({type:'terminal-script',command:`node -e 'setInterval(()=>{},100)'`,root:0},()=>{if(!allowed)throw Error('revoked');return f.client},{resolve:f.resolve}),/revoked/);
 await assert.rejects(f.run('sudo true'),/Administrator/);
});
