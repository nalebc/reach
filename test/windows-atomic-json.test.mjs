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
  const dir = folder(t), file = path.join(dir,"state.json"), old = {value:"old"}, next = {value:"next",complete:[1,2,3]};
  fs.writeFileSync(file,contents(old)); modelWindows(t);
  const rename = fs.renameSync, attempts = [];
  t.mock.method(fs,"renameSync",(from,to) => {
    attempts.push({from,to,bytes:fs.readFileSync(from,"utf8")});
    if(attempts.length<=2) throw Object.assign(Error("modeled sharing refusal"),{code:"EPERM"});
    return rename(from,to);
  });
  atomicJson(file,next);
  assert.equal(attempts.length,3);
  assert.equal(new Set(attempts.map(a=>a.from)).size,1,"one prepared write, never a new pair/action");
  assert.ok(attempts.every(a=>a.to===file && a.bytes===contents(next)));
  assert.equal(fs.readFileSync(file,"utf8"),contents(next));
  assert.deepEqual(fs.readdirSync(dir),["state.json"]);
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

const native = process.platform === "win32" && process.env.CI === "true" && process.env.GITHUB_ACTIONS === "true"
  && process.env.RUNNER_ENVIRONMENT === "github-hosted";

test("actual Windows NTFS atomic JSON survives a transient held destination and preserves a persistently held one", {
  skip:native ? false : "disposable GitHub-hosted Windows runner only",timeout:120000,
},async t => {
  const dir = folder(t), binary = path.join(dir,"hold.exe"), compiler = cscCandidates().find(file=>fs.existsSync(file));
  assert.ok(compiler,"the Windows Framework compiler is present");
  const report = {schema:1,head:process.env.GITHUB_SHA || null,node:process.version,actualWindows:true,physicalDevice:false,
    instrumentation:"Wrapper calls real fs.renameSync and preserves every actual return/error; only actual failure releases a separate native holder. No filesystem error is injected.",
    productionSha256:crypto.createHash("sha256").update(fs.readFileSync("server/core.mjs")).digest("hex"),cases:[]};
  t.after(()=>{fs.mkdirSync("reports",{recursive:true});fs.writeFileSync("reports/windows-atomic-json.json",JSON.stringify(report,null,2));});
  await promisify(execFile)(compiler,["/nologo","/noconfig","/target:exe","/platform:anycpu",`/reference:${path.join(path.dirname(compiler),"System.dll")}`,`/out:${binary}`,path.resolve(sourceFile)],{timeout:60000,windowsHide:true});
  for(const releaseOnError of [true,false]) await t.test(releaseOnError?"release after actual refusal":"held through retry budget",async sub => {
    const caseDir = fs.mkdtempSync(path.join(dir,"case-")), file = path.join(caseDir,"pairing-window.json"), release = path.join(caseDir,"release-barrier");
    const old = contents({until:1000}), next = {until:2000,complete:["one","two"]}; fs.writeFileSync(file,old);
    const child = spawn(binary,[file,release],{stdio:["ignore","pipe","pipe"],windowsHide:true});
    let output = "", errorOutput = "";
    child.stdout.on("data",chunk=>output+=chunk); child.stderr.on("data",chunk=>errorOutput+=chunk);
    const exited = once(child,"close");
    sub.after(async()=>{
      fs.writeFileSync(release,"release");
      const timer=setTimeout(()=>child.kill("SIGKILL"),2000);
      try {await exited;}finally{clearTimeout(timer);}
    });
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error(`native holder not ready: ${output} ${errorOutput}`)),10000);
      const data=()=>{if(output.includes("held NTFS")){clearTimeout(timer);child.stdout.off("data",data);resolve();}};
      child.stdout.on("data",data);
      child.once("error",e=>{clearTimeout(timer);reject(e);});
      child.once("close",()=>{clearTimeout(timer);reject(Error(`native holder exited before ready: ${output} ${errorOutput}`));});
      data();
    });
    const item = {mode:releaseOnError?"transient":"persistent",filesystem:"NTFS",attempts:[],observedErrors:[]}; report.cases.push(item);
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
