import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { atomicJson } from "../server/core.mjs";
import { cscCandidates } from "../server/desktop-native.mjs";
import { pairRunningHost } from "../scripts/pairing.mjs";

const folder = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-atomic-json-"));
  t.after(() => fs.rmSync(dir, {recursive:true,force:true,maxRetries:5,retryDelay:100}));
  return dir;
};
const contents = value => JSON.stringify(value, null, 2);
const sourceFile = "test/fixtures/windows/atomic-json-hold.cs";
function modelWindows(t) {
  const original = Object.getOwnPropertyDescriptor(process,"platform");
  Object.defineProperty(process,"platform",{...original,value:"win32"});
  t.after(() => Object.defineProperty(process,"platform",original));
}

// Portable error injection models Windows' transient rename refusal. The
// native fixture below separately proves the actual NTFS failure and recovery.
test("modeled Windows atomic JSON retries only the same prepared replacement", t => {
  const dir = folder(t), file = path.join(dir,"state.json"), old = {value:"old"};
  let serializations=0;
  const next={get value(){serializations++;return "next";},complete:[1,2,3]}, expected=contents({value:"next",complete:[1,2,3]});
  fs.writeFileSync(file,contents(old)); modelWindows(t);
  const rename = fs.renameSync, attempts = [];
  t.mock.method(fs,"renameSync",(from,to) => {
    attempts.push({from,to,bytes:fs.readFileSync(from,"utf8")});
    if(attempts.length<=2) throw Object.assign(Error("modeled sharing refusal"),{code:"EPERM"});
    return rename(from,to);
  });
  atomicJson(file,next);
  assert.equal(attempts.length,3);
  assert.equal(serializations,1,"serialize the state only once");
  assert.equal(new Set(attempts.map(a=>a.from)).size,1,"one prepared write, never a new pair/action");
  assert.ok(attempts.every(a=>a.to===file && a.bytes===expected));
  assert.equal(fs.readFileSync(file,"utf8"),expected);
  assert.deepEqual(fs.readdirSync(dir),["state.json"]);
});

test("atomic JSON never cleans a preexisting temporary name it did not create",t=>{
  const dir=folder(t),file=path.join(dir,"state.json"),temporary=`${file}.collision.tmp`;
  fs.writeFileSync(file,contents({old:true}));fs.writeFileSync(temporary,"unrelated existing bytes");
  t.mock.method(crypto,"randomUUID",()=>"collision");
  assert.throws(()=>atomicJson(file,{new:true}),{code:"EEXIST"});
  assert.equal(fs.readFileSync(temporary,"utf8"),"unrelated existing bytes");
  assert.equal(fs.readFileSync(file,"utf8"),contents({old:true}));
});

test("atomic JSON cleans its created temporary file after a write failure without touching the destination",t=>{
  const dir=folder(t),file=path.join(dir,"state.json"),old=contents({old:true});fs.writeFileSync(file,old);
  const failure=Object.assign(Error("modeled write failure"),{code:"EIO"});
  const write=fs.writeFileSync;
  t.mock.method(fs,"writeFileSync",(target,...args)=>{if(typeof target==="number")throw failure;return write(target,...args);});
  assert.throws(()=>atomicJson(file,{new:true}),error=>error===failure);
  assert.equal(fs.readFileSync(file,"utf8"),old);assert.deepEqual(fs.readdirSync(dir),["state.json"]);
});

test("atomic JSON preserves the original error and records a separate temporary-cleanup refusal",t=>{
  const dir=folder(t),file=path.join(dir,"state.json"),old=contents({old:true});fs.writeFileSync(file,old);
  const failure=Object.assign(Error("modeled rename failure"),{code:"EIO"}),cleanup=Object.assign(Error("modeled cleanup refusal"),{code:"EACCES"});
  t.mock.method(fs,"renameSync",()=>{throw failure;});t.mock.method(fs,"unlinkSync",()=>{throw cleanup;});
  assert.throws(()=>atomicJson(file,{new:true}),error=>error===failure && error.cleanupError===cleanup);
  assert.equal(fs.readFileSync(file,"utf8"),old);
});

for(const code of ["EPERM","EACCES","EBUSY","EIO"]) test(`modeled Windows atomic JSON propagates persistent ${code} and cleans only its own temporary output`,t => {
  const dir = folder(t), file = path.join(dir,"state.json"), unrelated = path.join(dir,"state.json.other.tmp"), old = contents({value:"old"});
  fs.writeFileSync(file,old); fs.writeFileSync(unrelated,"another writer's output"); modelWindows(t);
  const failure = Object.assign(Error("modeled persistent refusal"),{code}); let attempts = 0;
  t.mock.method(fs,"renameSync",()=>{attempts++;throw failure;});
  const unlink = fs.unlinkSync; const removed = [];
  t.mock.method(fs,"unlinkSync",target=>{removed.push(target);return unlink(target);});
  const started = Date.now();
  assert.throws(()=>atomicJson(file,{value:"new"}),error=>error===failure,"preserve the original failure");
  assert.ok(Date.now()-started<2000,"the retry path is bounded");
  assert.equal(fs.readFileSync(file,"utf8"),old);
  assert.deepEqual(fs.readdirSync(dir).sort(),["state.json","state.json.other.tmp"]);
  assert.ok(!removed.includes(file) && !removed.includes(unrelated),"no target unlink or unrelated cleanup");
  if(code==="EIO") assert.equal(attempts,1,"unrelated errors are not retried");
  else assert.ok(attempts>1 && attempts<=8,"sharing/access retries have a fixed small bound");
});

test("modeled Windows pair command opens its window once while preserving its code and checked public QR",async t => {
  const root=folder(t), state=path.join(root,".reach"), dataDir=path.join(state,"quick");
  fs.mkdirSync(dataDir,{recursive:true});
  fs.writeFileSync(path.join(state,"host-status.json"),contents({localUrl:"http://127.0.0.1:4317",origin:"https://pc.example.ts.net:8443",link:"https://pc.example.ts.net",dataDir,instance:"fixture-instance",tailscaleApproval:true,name:"Fixture"}));
  const previous=process.env.REACH_HOME;process.env.REACH_HOME=state;
  t.after(()=>{if(previous===undefined)delete process.env.REACH_HOME;else process.env.REACH_HOME=previous;});
  modelWindows(t);
  const rename=fs.renameSync, targets=[];t.mock.method(fs,"renameSync",(from,to)=>{targets.push(to);return rename(from,to);});
  const qrs=[],printed=[];let health=0,browser=0;
  const pairing=await pairRunningHost(root,{env:{REACH_DATA:dataDir},fetchHost:async url=>{
    health++;assert.equal(url,"http://127.0.0.1:4317/api/health");return {ok:true,json:async()=>({product:"Reach",instance:"fixture-instance"})};
  },browserCheck:async (url,instance)=>{browser++;assert.equal(url,"https://pc.example.ts.net");assert.equal(instance,"fixture-instance");return {ready:true};},print:s=>printed.push(s),qr:{generate:url=>qrs.push(url)}});
  assert.equal(targets.filter(target=>target===path.join(dataDir,"pairing-window.json")).length,1,"one pairing window write per command");
  assert.equal(targets.filter(target=>target===path.join(dataDir,"pairing.json")).length,1,"one code, never a replay");
  assert.equal(health,1);assert.equal(browser,1);assert.equal(qrs.length,1);
  const qr=new URL(qrs[0]);assert.equal(qr.origin,"https://pc.example.ts.net");assert.equal(new URLSearchParams(qr.hash.slice(1)).get("pair"),pairing.code);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir,"pairing.json"))).code,pairing.code);
  assert.ok(printed[0].includes("One use."));
});

const native = process.platform === "win32" && process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true"
  && process.env.RUNNER_ENVIRONMENT === "github-hosted";

test("actual Windows NTFS atomic JSON survives a transient held destination and preserves a persistently held one", {
  skip:native ? false : "disposable GitHub-hosted Windows runner only",timeout:120000,
},async t => {
  const dir = folder(t), binary = path.join(dir,"hold.exe"), compiler = cscCandidates().find(file=>fs.existsSync(file));
  assert.ok(compiler,"the Windows Framework compiler is present");
  const report = {schema:1,head:process.env.GITHUB_SHA || null,node:process.version,arch:process.arch,release:os.release(),actualWindows:true,physicalDevice:false,
    instrumentation:"Wrapper calls real fs.renameSync and preserves every actual return/error; only actual failure releases a separate native holder. No filesystem error is injected.",
    productionSha256:crypto.createHash("sha256").update(fs.readFileSync("server/core.mjs")).digest("hex"),
    fixtureSha256:crypto.createHash("sha256").update(fs.readFileSync(sourceFile)).digest("hex"),cases:[]};
  t.after(()=>{fs.mkdirSync("reports",{recursive:true});fs.writeFileSync("reports/windows-atomic-json.json",JSON.stringify(report,null,2));});
  await promisify(execFile)(compiler,["/nologo","/noconfig","/target:exe","/platform:anycpu",`/out:${binary}`,path.resolve(sourceFile)],{timeout:60000,windowsHide:true});
  for(const releaseOnError of [true,false]) await t.test(releaseOnError?"release after actual refusal":"held through retry budget",async sub => {
    const caseDir = fs.mkdtempSync(path.join(dir,"case-")), file = path.join(caseDir,"pairing-window.json"), release = path.join(caseDir,"release-barrier");
    const old = contents({until:1000}), next = {until:2000,complete:["one","two"]}; fs.writeFileSync(file,old);
    const item = {mode:releaseOnError?"transient":"persistent",filesystem:"NTFS",attempts:[],observedErrors:[]}; report.cases.push(item);
    const child = spawn(binary,[file,release],{stdio:["ignore","pipe","pipe"],windowsHide:true});
    let output = "", errorOutput = "";
    child.stdout.on("data",chunk=>output+=chunk); child.stderr.on("data",chunk=>errorOutput+=chunk);
    const exited = once(child,"close");
    sub.after(async()=>{
      fs.writeFileSync(release,"release");
      const timer=setTimeout(()=>child.kill("SIGKILL"),2000);
      try {
        const [code,signal]=await exited;item.holderExit={code,signal};
        assert.equal(code,0,errorOutput);assert.equal(signal,null,"the native holder closes normally");
      } finally {clearTimeout(timer);}
    });
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error(`native holder not ready: ${output} ${errorOutput}`)),10000);
      const data=()=>{if(output.includes("held NTFS")){clearTimeout(timer);child.stdout.off("data",data);resolve();}};
      child.stdout.on("data",data);
      child.once("error",e=>{clearTimeout(timer);reject(e);});
      child.once("close",()=>{clearTimeout(timer);reject(Error(`native holder exited before ready: ${output} ${errorOutput}`));});
      data();
    });
    item.holderReady=true;
    const rename = fs.renameSync;
    sub.mock.method(fs,"renameSync",(from,to)=>{
      if(to!==file) return rename(from,to);
      item.attempts.push({from,to,temporaryBytes:fs.readFileSync(from,"utf8")});
      try {return rename(from,to);}
      catch(error) {
        item.observedErrors.push(error.code);
        item.oldBytesAfterRefusal = fs.readFileSync(file,"utf8");
        if(releaseOnError) fs.writeFileSync(release,"release");
        throw error;
      }
    });
    const started=Date.now(); let failure;
    try {atomicJson(file,next);} catch(error){failure=error;}
    item.elapsedMs=Date.now()-started;item.failure=failure?{code:failure.code}:null;
    item.finalBytes=fs.readFileSync(file,"utf8");item.remaining=fs.readdirSync(caseDir);
    assert.ok(item.observedErrors.length>=1,"the real held NTFS destination must reject at least one actual rename");
    assert.ok(item.observedErrors.every(code=>["EPERM","EACCES","EBUSY"].includes(code)),JSON.stringify(item.observedErrors));
    assert.equal(item.oldBytesAfterRefusal,old,"no partial JSON or target deletion after actual failure");
    assert.equal(new Set(item.attempts.map(a=>a.from)).size,1);
    assert.ok(item.attempts.every(a=>a.temporaryBytes===contents(next)),"the prepared JSON never changes between attempts");
    if(releaseOnError) {
      assert.equal(failure,undefined,`actual transient rename failed: ${failure?.code}`);
      assert.equal(item.finalBytes,contents(next));
    } else {
      assert.ok(failure,"a persistently held destination still fails");
      assert.ok(item.elapsedMs<2000,"the failure stays bounded");
      assert.equal(item.finalBytes,old);
    }
    assert.ok(!item.remaining.some(name=>name.startsWith("pairing-window.json.")&&name.endsWith(".tmp")),"only this writer's temporary output is cleaned");
    item.passed=true;
  });
});
