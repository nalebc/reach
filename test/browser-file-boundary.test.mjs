import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { browserFileOperation, fileBoundaryProfile } from '../server/browser-file-boundary.mjs';
const native = process.platform === 'darwin' && process.env.REACH_TEST_FILE_BOUNDARY === '1';
function fixture(t) {
 const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'reach-file-boundary-')));
 const root = path.join(temp, 'shared'), outside = path.join(temp, 'outside'), cache = path.join(temp, 'cache');
 for (const dir of [root, outside, cache]) fs.mkdirSync(dir);
 fs.writeFileSync(path.join(root, 'safe.txt'), 'shared text');
 fs.writeFileSync(path.join(outside, 'secret.txt'), 'never shared');
 t.after(() => fs.rmSync(temp, {recursive:true,force:true}));
 const run = (op, relative = '', extra = {}, authorize = () => true) => browserFileOperation({op,root,path:relative,...extra}, authorize, {config:{dataDir:cache}});
 return {temp,root,outside,cache,run};
}
test('file helper receives only bounded trusted operations and protected names', async t => {
 const f=fixture(t); let observed;
 const run=async request=>{observed=request;return {items:[],truncated:false};};
 await browserFileOperation({op:'list',root:f.root,path:'',privateNames:[],sandbox:'allow all'},()=>true,{config:{dataDir:f.cache},run});
 assert.ok(observed.privateNames.includes('.ssh'));assert.match(observed.sandbox,/deny default/);assert.doesNotMatch(observed.sandbox,/allow all/);
 for(const request of [{op:'spawn',root:f.root,path:''},{op:'read',root:f.root,path:'../outside/secret.txt'},{op:'read',root:f.root,path:'/etc/passwd'},{op:'cp',root:f.root,path:'safe.txt',to:'../outside/copy'}])await assert.rejects(browserFileOperation(request,()=>true,{run}),{status:400});
 const readonly=fileBoundaryProfile(f.root,[]);assert.doesNotMatch(readonly,/allow file-write/);assert.match(readonly,/deny process-fork process-exec file-link/);
});
test('sandbox profile generation terminates at the host filesystem root', async()=>{
 // A Windows drive root is its own parent, just as / is on POSIX. Keep the
 // process bounded so a regression reports a failure instead of hanging CI.
 const moduleURL=new URL('../server/browser-file-boundary.mjs',import.meta.url).href;
 const source=`import {fileBoundaryProfile} from ${JSON.stringify(moduleURL)}; process.stdout.write(fileBoundaryProfile(process.cwd(),[]));`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',source],{timeout:5000,maxBuffer:65536});
 assert.match(stdout,/deny default/);assert.match(stdout,/allow file-read-metadata/);
});
test('native descriptor operations reject parent symlinks, hard links, private names and private trees',{skip:!native},async t=>{
 const f=fixture(t);
 fs.symlinkSync(f.outside,path.join(f.root,'escape'));
 fs.linkSync(path.join(f.outside,'secret.txt'),path.join(f.root,'hardlink'));
 fs.mkdirSync(path.join(f.root,'.SSH'));fs.writeFileSync(path.join(f.root,'.SSH','secret'),'private');
 fs.mkdirSync(path.join(f.root,'protected'));fs.writeFileSync(path.join(f.root,'protected','secret'),'private');
 assert.equal((await f.run('read','safe.txt')).data.toString(),'shared text');
 for(const request of [['read','escape/secret.txt'],['list','escape'],['read','hardlink'],['touch','escape/new'],['mkdir','escape/new'],['rm','escape/secret.txt'],['cp','safe.txt',{to:'escape/new'}],['read','.SSH/secret'],['read','protected/secret',{privatePaths:[path.join(f.root,'protected')]}]])await assert.rejects(f.run(...request));
 const listing=await f.run('list','',{privatePaths:[path.join(f.root,'protected')]});assert.deepEqual(listing.items.map(x=>x.name),['safe.txt']);
 assert.equal(fs.readFileSync(path.join(f.outside,'secret.txt'),'utf8'),'never shared');assert.deepEqual(fs.readdirSync(f.outside),['secret.txt']);
});
test('racing parent swaps never disclose or change files outside the shared folder',{skip:!native},async t=>{
 const f=fixture(t), active=path.join(f.root,'active'), held=path.join(f.root,'held');
 fs.mkdirSync(active);fs.writeFileSync(path.join(active,'secret.txt'),'shared fixture');
 fs.writeFileSync(path.join(f.outside,'outside-only'),'outside listing marker');
 await f.run('stat'); // Compile before starting the attacker.
 const attacker=spawn(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';const[a,b,out]=process.argv.slice(1);process.stdout.write('ready');for(;;){try{fs.renameSync(a,b);fs.symlinkSync(out,a);fs.unlinkSync(a);fs.renameSync(b,a)}catch{try{if(fs.lstatSync(a).isSymbolicLink())fs.unlinkSync(a)}catch{};try{fs.renameSync(b,a)}catch{}}}`,active,held,f.outside],{stdio:['ignore','pipe','pipe']});
 await once(attacker.stdout,'data');
 try {
   for(let n=0;n<12;n++) {
     for(const [op,relative,extra]of[['read','active/secret.txt',{}],['list','active',{}],['mkdir',`active/new-${n}`,{}],['cp','safe.txt',{to:`active/copy-${n}`}],['touch',`active/touch-${n}`,{}]]) {
       try { const result=await f.run(op,relative,extra);if(op==='read')assert.equal(result.data.toString(),'shared fixture');if(op==='list')assert.ok(!result.items.some(x=>x.name==='outside-only')); }
       catch(error){assert.ok([400,403,409].includes(error.status),String(error));}
     }
   }
 } finally { attacker.kill('SIGKILL');await once(attacker,'close'); }
 assert.deepEqual(fs.readdirSync(f.outside).sort(),['outside-only','secret.txt']);assert.equal(fs.readFileSync(path.join(f.outside,'secret.txt'),'utf8'),'never shared');
});
test('authorization must still be valid after the helper completes',async t=>{
 const f=fixture(t);let allowed=true;
 await assert.rejects(browserFileOperation({op:'read',root:f.root,path:'safe.txt'},()=>{if(!allowed)throw Object.assign(Error('revoked'),{status:403});return true;},{config:{dataDir:f.cache},run:async()=>{allowed=false;return{data:Buffer.from('hidden').toString('base64'),stat:{}};}}),/revoked/);
});

test('kernel sandbox denies writes through a previously opened directory moved outside the share',{skip:!native},async t=>{
 const f=fixture(t), inside=path.join(f.root,'inside');fs.mkdirSync(inside);
 const source=fs.readFileSync(new URL('../scripts/native/browser-files.swift',import.meta.url),'utf8').split('@main struct BrowserFiles {')[0];
 const harness=source+`
@main struct MovedDirectoryTest { static func main() throws {
  let input = try JSONSerialization.jsonObject(with: Data(CommandLine.arguments[1].utf8)) as! [String: Any]
  let boundary = try Boundary(input), dir = try boundary.directory(["inside"])
  try confine(input)
  FileHandle.standardOutput.write(Data("ready".utf8))
  _ = FileHandle.standardInput.readData(ofLength: 1)
  let mkdirResult = mkdirat(dir.value, "escaped", mode_t(0o700))
  let writeResult = openat(dir.value, "escaped-file", O_WRONLY | O_CREAT | O_EXCL, mode_t(0o600))
  if writeResult >= 0 { Darwin.close(writeResult) }
  FileHandle.standardOutput.write(Data(" \\(mkdirResult) \\(writeResult)".utf8))
} }
`;
 const sourceFile=path.join(f.temp,'boundary-harness.swift'),binary=path.join(f.temp,'boundary-harness');fs.writeFileSync(sourceFile,harness);
 await promisify(execFile)('/usr/bin/xcrun',['swiftc','-parse-as-library','-O',sourceFile,'-o',binary],{timeout:120000});
 const stat=fs.statSync(f.root,{bigint:true}), request={root:f.root,rootDev:String(stat.dev),rootIno:String(stat.ino),sandbox:fileBoundaryProfile(f.root,[],true)};
 const child=spawn(binary,[JSON.stringify(request)],{stdio:['pipe','pipe','pipe']});let output='';child.stdout.on('data',chunk=>{output+=chunk;});
 await once(child.stdout,'data');fs.renameSync(inside,path.join(f.outside,'moved'));child.stdin.end('x');
 const [code]=await once(child,'close');assert.equal(code,0);assert.equal(output,'ready -1 -1');assert.deepEqual(fs.readdirSync(path.join(f.outside,'moved')),[]);
});
test('agent roots exclude homes, executable installations and their ancestors',async t=>{
 const {validateBrowserRoot}=await import('../server/browser-private-paths.mjs');const f=fixture(t);
 const home=path.join(f.temp,'user'),runtime=path.join(home,'.runtime','bin','node');fs.mkdirSync(path.join(home,'Desktop'),{recursive:true});
 for(const root of ['/',path.parse(f.root).root,...(process.platform==='win32'?['Z:\\','\\\\server\\share\\']:[]),home,f.temp,'/Applications','/Applications/Test.app','/Library','/System','/usr','/bin','/sbin','/opt','/private/etc','/etc',path.join(home,'Applications'),path.join(home,'.runtime')])assert.throws(()=>validateBrowserRoot(root,{home,runtime}),{status:403},root);
 assert.equal(validateBrowserRoot(path.join(home,'Desktop'),{home,runtime}),path.join(home,'Desktop'));
 assert.equal(validateBrowserRoot(f.root,{home,runtime}),f.root);
});
test('file operations have global and per-session concurrency bounds without a queue',async t=>{
 const f=fixture(t), releases=[];let started=0;
 const run=async()=>{started++;await new Promise(resolve=>releases.push(resolve));return{items:[],truncated:false};};
 const operation=id=>browserFileOperation({op:'list',root:f.root,path:''},()=>id?{id}:undefined,{config:{dataDir:f.cache},run});
 const first=operation('one'),second=operation('one');
 await assert.rejects(operation('one'),{status:429});assert.equal(started,2);
 const third=operation('two'),fourth=operation('two');
 await assert.rejects(operation('three'),{status:429});await assert.rejects(operation(),{status:429});assert.equal(started,4);
 releases.splice(0).forEach(resolve=>resolve());await Promise.all([first,second,third,fourth]);
 const anonymous=[operation(),operation(),operation(),operation()];
 await assert.rejects(operation(),{status:429});assert.equal(started,8);
 releases.splice(0).forEach(resolve=>resolve());await Promise.all(anonymous);
});
test('failed or revoked operations release their slots and cannot change client identity',async t=>{
 const f=fixture(t), request={op:'list',root:f.root,path:''},options={config:{dataDir:f.cache}};
 for(let n=0;n<5;n++)await assert.rejects(browserFileOperation(request,()=>({id:'failure'}),{...options,run:async()=>{throw Error('helper failure');}}),/helper failure/);
 for(let n=0;n<5;n++){
  let current='revoked';
  await assert.rejects(browserFileOperation(request,()=>({id:current}),{...options,run:async(_request,check)=>{current='another';check();}}),{status:403});
 }
 assert.deepEqual(await browserFileOperation(request,()=>({id:'failure'}),{...options,run:async()=>({items:[],truncated:false})}),{items:[],truncated:false});
});

// This intentionally uses the real path (no injected runner) on unsupported hosts.
test('non-macOS protected file access fails closed without reading or changing files', {skip:process.platform==='darwin'}, async t=>{
 const f=fixture(t);
 for(const [op,relative,extra] of [['stat','',{}],['list','',{}],['read','safe.txt',{}],['mkdir','new',{}],['touch','new',{}],['write','safe.txt',{data:Buffer.from('changed').toString('base64')}],['cp','safe.txt',{to:'copy.txt'}],['rm','safe.txt',{}]]) {
  await assert.rejects(f.run(op,relative,extra), error=>error.status===503 && /Protected agent file access is unavailable/.test(error.message));
 }
 assert.deepEqual(fs.readdirSync(f.root),['safe.txt']);
 assert.equal(fs.readFileSync(path.join(f.root,'safe.txt'),'utf8'),'shared text');
});
